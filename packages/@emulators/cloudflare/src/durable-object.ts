import {
  createServer,
  type AppKeyResolver,
  type LedgerEntry,
  type LedgerSnapshot,
  type RequestLedger,
  type Store,
  type StoreSnapshot,
  type TokenMap,
} from "@emulators/core";
import { SERVICES, issueCloudflareCredential } from "./services.js";

// Minimal CF runtime types (avoid a hard dep on @cloudflare/workers-types here).
interface DurableObjectStorage {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string | string[]): Promise<boolean | number>;
  list<T = unknown>(options?: { prefix?: string }): Promise<Map<string, T>>;
}
interface DurableObjectState {
  storage: DurableObjectStorage;
  blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T>;
}

export interface SeedConfig {
  tokens?: Record<string, { login: string; scopes?: string[] }>;
  // When true (the default), unknown/missing credentials are REJECTED faithfully
  // (the real API's 401/403), instead of falling back to an admin identity. Set
  // `false` for the old permissive behavior (any non-empty token → admin).
  strict?: boolean;
  [service: string]: unknown;
}
interface TokenEntry {
  token: string;
  login: string;
  id: number;
  scopes: string[];
}
interface PersistedState {
  seed?: SeedConfig;
  strict?: boolean;
  // Legacy fields from the original single-value state record. New writes store
  // these under split keys so an append-only ledger or credential list cannot
  // make credential minting rewrite a value over the DO storage cap.
  snapshot?: unknown;
  minted?: TokenEntry[];
  ledger?: LedgerSnapshot;
}
interface Live {
  app: { fetch: (request: Request) => Promise<Response> };
  store: Store;
  tokenMap: TokenMap;
  ledger: RequestLedger;
  service: string;
  instance: string;
  baseUrl: string;
  reset: () => Promise<void>;
}

const MUTATES = (method: string) => method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
const STATE_KEY = "state";
const SNAPSHOT_META_KEY = "snapshot:meta";
const SNAPSHOT_ITEM_PREFIX = "snapshot:item:";
const SNAPSHOT_DATA_PREFIX = "snapshot:data:";
const LEDGER_META_KEY = "ledger:meta";
const LEDGER_ENTRY_PREFIX = "ledger:entry:";
const MINTED_PREFIX = "minted:";

interface SnapshotCollectionMeta {
  autoId: number;
  indexFields: string[];
}
interface SnapshotMeta {
  collections: Record<string, SnapshotCollectionMeta>;
}
interface LedgerMeta {
  counter: number;
  ids: string[];
}

// Durable Object storage allows at most 128 concurrent operations (and at most
// 128 keys per delete call). Run storage fan-outs in bounded batches so a large
// ledger or snapshot cannot trip "too many concurrent storage operations".
const STORAGE_BATCH_SIZE = 64;
const inBatches = async <T, R>(items: readonly T[], run: (item: T) => Promise<R>): Promise<R[]> => {
  const results: R[] = [];
  for (let i = 0; i < items.length; i += STORAGE_BATCH_SIZE) {
    results.push(...(await Promise.all(items.slice(i, i + STORAGE_BATCH_SIZE).map(run))));
  }
  return results;
};

const encodeKeyPart = (value: string): string => encodeURIComponent(value);
const decodeKeyPart = (value: string): string => decodeURIComponent(value);
const snapshotItemKey = (collection: string, id: number): string =>
  `${SNAPSHOT_ITEM_PREFIX}${encodeKeyPart(collection)}:${id}`;
const snapshotItemPrefix = (collection: string): string => `${SNAPSHOT_ITEM_PREFIX}${encodeKeyPart(collection)}:`;
const snapshotDataKey = (key: string): string => `${SNAPSHOT_DATA_PREFIX}${encodeKeyPart(key)}`;
const ledgerEntryKey = (id: string): string => `${LEDGER_ENTRY_PREFIX}${encodeKeyPart(id)}`;

// One Durable Object instance == one stateful emulator instance. Its `store`
// lives in DO memory (single-threaded → the serialized-write consistency the
// in-process emulator already assumes), snapshotted to DO storage after every
// mutating request so the instance survives eviction. Auth is FAITHFUL by
// default (strict): only seeded or minted tokens work; everything else gets the
// real API's 401/403. Mint tokens at runtime via `POST /__token`.
export class EmulatorDurableObject {
  private live?: Live;

  constructor(
    private readonly state: DurableObjectState,
    _env: unknown,
  ) {}

  private async readPersistedState(): Promise<PersistedState> {
    return (await this.state.storage.get<PersistedState>(STATE_KEY)) ?? {};
  }

  private async writeStateMeta(persisted: Pick<PersistedState, "seed" | "strict">): Promise<void> {
    await this.state.storage.put(STATE_KEY, {
      ...(persisted.seed !== undefined && { seed: persisted.seed }),
      ...(persisted.strict !== undefined && { strict: persisted.strict }),
    });
  }

  private async deleteKeys(keys: Iterable<string>): Promise<void> {
    const list = [...keys];
    if (list.length === 0) return;
    // storage.delete accepts at most 128 keys per call.
    for (let i = 0; i < list.length; i += STORAGE_BATCH_SIZE) {
      await this.state.storage.delete(list.slice(i, i + STORAGE_BATCH_SIZE));
    }
  }

  private async deletePrefix(prefix: string): Promise<void> {
    await this.deleteKeys((await this.state.storage.list({ prefix })).keys());
  }

  private async writeStoreSnapshot(snapshot: StoreSnapshot): Promise<void> {
    const meta: SnapshotMeta = { collections: {} };
    const expectedKeys = new Set<string>();
    const writes: Array<{ key: string; value: unknown }> = [];

    for (const [key, value] of Object.entries(snapshot.data)) {
      const storageKey = snapshotDataKey(key);
      expectedKeys.add(storageKey);
      writes.push({ key: storageKey, value });
    }

    for (const [name, collection] of Object.entries(snapshot.collections)) {
      meta.collections[name] = {
        autoId: collection.autoId,
        indexFields: collection.indexFields,
      };
      for (const item of collection.items) {
        const storageKey = snapshotItemKey(name, item.id);
        expectedKeys.add(storageKey);
        writes.push({ key: storageKey, value: item });
      }
    }

    await inBatches(writes, (write) => this.state.storage.put(write.key, write.value));
    await this.state.storage.put(SNAPSHOT_META_KEY, meta);

    const existingItems = await this.state.storage.list({ prefix: SNAPSHOT_ITEM_PREFIX });
    const existingData = await this.state.storage.list({ prefix: SNAPSHOT_DATA_PREFIX });
    await this.deleteKeys([...existingItems.keys(), ...existingData.keys()].filter((key) => !expectedKeys.has(key)));
  }

  private async readStoreSnapshot(legacySnapshot: unknown): Promise<StoreSnapshot | undefined> {
    const meta = await this.state.storage.get<SnapshotMeta>(SNAPSHOT_META_KEY);
    if (!meta) return legacySnapshot as StoreSnapshot | undefined;

    const collections: StoreSnapshot["collections"] = {};
    for (const [name, collectionMeta] of Object.entries(meta.collections)) {
      const itemEntries = await this.state.storage.list<StoreSnapshot["collections"][string]["items"][number]>({
        prefix: snapshotItemPrefix(name),
      });
      const items = [...itemEntries.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, item]) => item);
      collections[name] = {
        items,
        autoId: collectionMeta.autoId,
        indexFields: collectionMeta.indexFields,
      };
    }

    const data: StoreSnapshot["data"] = {};
    const dataEntries = await this.state.storage.list({ prefix: SNAPSHOT_DATA_PREFIX });
    for (const [storageKey, value] of dataEntries) {
      data[decodeKeyPart(storageKey.slice(SNAPSHOT_DATA_PREFIX.length))] = value;
    }

    return { collections, data };
  }

  private async clearStoreSnapshot(): Promise<void> {
    await this.deletePrefix(SNAPSHOT_ITEM_PREFIX);
    await this.deletePrefix(SNAPSHOT_DATA_PREFIX);
    await this.state.storage.delete(SNAPSHOT_META_KEY);
  }

  private async writeLedger(snapshot: LedgerSnapshot): Promise<void> {
    const ids = snapshot.entries.map((entry) => entry.id);
    const expectedKeys = new Set(ids.map(ledgerEntryKey));
    await inBatches(snapshot.entries, (entry) => this.state.storage.put(ledgerEntryKey(entry.id), entry));
    await this.state.storage.put(LEDGER_META_KEY, { counter: snapshot.counter, ids } satisfies LedgerMeta);

    const existing = await this.state.storage.list({ prefix: LEDGER_ENTRY_PREFIX });
    await this.deleteKeys([...existing.keys()].filter((key) => !expectedKeys.has(key)));
  }

  private async readLedger(legacyLedger: LedgerSnapshot | undefined): Promise<LedgerSnapshot | undefined> {
    const meta = await this.state.storage.get<LedgerMeta>(LEDGER_META_KEY);
    if (!meta) return legacyLedger;
    const entries = (
      await inBatches(meta.ids, (id) => this.state.storage.get<LedgerEntry>(ledgerEntryKey(id)))
    ).filter((entry): entry is LedgerEntry => entry != null);
    return { entries, counter: meta.counter };
  }

  private async clearLedger(): Promise<void> {
    await this.deletePrefix(LEDGER_ENTRY_PREFIX);
    await this.state.storage.delete(LEDGER_META_KEY);
  }

  private async mintedKey(token: string): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
    const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    return `${MINTED_PREFIX}${hex}`;
  }

  private async writeMinted(entry: TokenEntry): Promise<void> {
    await this.state.storage.put(await this.mintedKey(entry.token), entry);
  }

  private async readMinted(legacyMinted: TokenEntry[] | undefined): Promise<TokenEntry[]> {
    const byToken = new Map<string, TokenEntry>();
    for (const entry of legacyMinted ?? []) byToken.set(entry.token, entry);
    const stored = await this.state.storage.list<TokenEntry>({ prefix: MINTED_PREFIX });
    for (const entry of [...stored.values()].sort((a, b) => a.token.localeCompare(b.token))) {
      byToken.set(entry.token, entry);
    }
    return [...byToken.values()];
  }

  private async clearMinted(): Promise<void> {
    await this.deletePrefix(MINTED_PREFIX);
  }

  private async migrateLegacyState(persisted: PersistedState): Promise<void> {
    if (persisted.snapshot) {
      const hasSplitSnapshot = Boolean(await this.state.storage.get(SNAPSHOT_META_KEY));
      if (!hasSplitSnapshot) await this.writeStoreSnapshot(persisted.snapshot as StoreSnapshot);
    }
    if (persisted.ledger) {
      const hasSplitLedger = Boolean(await this.state.storage.get(LEDGER_META_KEY));
      if (!hasSplitLedger) await this.writeLedger(persisted.ledger);
    }
    await inBatches(persisted.minted ?? [], (entry) => this.writeMinted(entry));
    if (persisted.snapshot || persisted.ledger || persisted.minted) {
      await this.writeStateMeta(persisted);
    }
  }

  private buildTokens(
    seed: SeedConfig | undefined,
    strict: boolean,
    minted: TokenEntry[] | undefined,
  ): Record<string, { login: string; id: number; scopes?: string[] }> {
    const tokens: Record<string, { login: string; id: number; scopes?: string[] }> = {};
    if (seed?.tokens) {
      let id = 100;
      for (const [token, user] of Object.entries(seed.tokens)) {
        tokens[token] = { login: user.login, id: id++, scopes: user.scopes };
      }
    } else if (!strict) {
      // Permissive convenience token only — strict mode requires explicit creds.
      tokens["test_token_admin"] = { login: "admin", id: 2, scopes: ["repo", "user", "admin:org", "admin:repo_hook"] };
    }
    for (const m of minted ?? []) tokens[m.token] = { login: m.login, id: m.id, scopes: m.scopes };
    return tokens;
  }

  private seedInto(store: Store, service: string, baseUrl: string, seed?: SeedConfig): void {
    const entry = SERVICES[service];
    entry.plugin.seed?.(store, baseUrl);
    const svcCfg = seed?.[service] as Record<string, unknown> | undefined;
    if (svcCfg && entry.seedFromConfig) entry.seedFromConfig(store, baseUrl, svcCfg);
  }

  // Lazily build (or rebuild on base-url change) the emulator for this instance,
  // restoring a persisted snapshot if present, else seeding fresh.
  private async ensure(service: string, instance: string, baseUrl: string, preset?: string): Promise<Live> {
    if (this.live && this.live.service === service && this.live.baseUrl === baseUrl) return this.live;
    const entry = SERVICES[service];
    if (!entry) throw new Error(`unknown emulator service: ${service}`);

    const persisted = await this.readPersistedState();
    await this.migrateLegacyState(persisted);
    const strict = persisted.strict ?? true;
    const snapshot = await this.readStoreSnapshot(persisted.snapshot);
    const ledgerSnapshot = await this.readLedger(persisted.ledger);
    const minted = await this.readMinted(persisted.minted);
    const tokens = this.buildTokens(persisted.seed, strict, minted);

    // eslint-disable-next-line prefer-const
    let cachedResolver: AppKeyResolver | undefined;
    const appKeyResolver: AppKeyResolver | undefined = entry.createAppKeyResolver
      ? (appId) => cachedResolver!(appId)
      : undefined;
    // Strict = NO fallback identity → the plugins' existing auth guards reject
    // unknown/missing tokens with the real API's error. Permissive = admin fallback.
    const fallbackUser = strict
      ? undefined
      : entry.defaultFallback(persisted.seed?.[service] as Record<string, unknown> | undefined);

    let resetService = async () => {};
    const { app, store, tokenMap, webhooks, ledger } = createServer(entry.plugin, {
      baseUrl,
      tokens,
      appKeyResolver,
      fallbackUser,
      manifest: entry.manifest,
      instance,
      ledgerPersistent: true,
      reset: () => resetService(),
      seed: async (seed) => {
        if (seed && entry.seedFromConfig) {
          entry.seedFromConfig(store, baseUrl, seed as Record<string, unknown>);
          await this.persist();
        }
      },
      issueCredential: async (request) => {
        const credential = issueCloudflareCredential(service, entry, store, baseUrl, tokenMap as TokenMap, request);
        // Persist minted bearer/API-key tokens so credentials created via
        // /_emulate/credentials survive Durable Object eviction (rebuilds restore
        // tokens from split credential records), matching the legacy /__token endpoint.
        if (typeof credential.token === "string" && credential.token.length > 0) {
          await this.writeMinted({
            token: credential.token,
            login: credential.login ?? "admin",
            id: (tokenMap as TokenMap).get(credential.token)?.id ?? Date.now(),
            scopes: credential.scopes ?? [],
          });
        }
        await this.persist();
        return credential;
      },
    });
    cachedResolver = entry.createAppKeyResolver?.(store);

    if (snapshot) store.restore(snapshot);
    else this.seedInto(store, service, baseUrl, persisted.seed);
    ledger.restore(ledgerSnapshot);
    resetService = async () => {
      store.reset();
      webhooks.clear();
      ledger.clear();
      this.seedInto(store, service, baseUrl, persisted.seed);
      await this.persist();
    };

    // URL-selected preset (e.g. `/oauth|bearer|query/mcp`): pin the auth mode from
    // the URL — no seed call. Reapplied on every build (the mode lives in the store
    // snapshot; the demo bearer/query token lives only in the rebuilt tokenMap).
    if (preset && entry.applyPreset) {
      entry.applyPreset(store, baseUrl, preset);
      if (preset === "bearer" || preset === "query") {
        (tokenMap as TokenMap).set("demo-token", { login: "admin", id: 2, scopes: ["repo", "read:user"] });
      }
    }

    this.live = { app, store, tokenMap: tokenMap as TokenMap, ledger, service, instance, baseUrl, reset: resetService };
    return this.live;
  }

  private async persist(): Promise<void> {
    if (!this.live) return;
    const persisted = await this.readPersistedState();
    await this.writeStoreSnapshot(this.live.store.snapshot());
    // Persist the request ledger so inspection history survives Durable Object
    // eviction. Entries are split by id because the ledger is intentionally
    // durable, agent-readable history.
    await this.writeLedger(this.live.ledger.serialize());
    await this.writeStateMeta(persisted);
  }

  async fetch(request: Request): Promise<Response> {
    const service = request.headers.get("x-emulator-service") ?? "";
    const instance = request.headers.get("x-emulator-instance") ?? "default";
    const baseUrl = request.headers.get("x-emulator-base-url") ?? new URL(request.url).origin;
    const preset = request.headers.get("x-emulator-mcp-mode") ?? undefined;
    const path = new URL(request.url).pathname;

    // Unknown service → 404 (not a 500). Faithful, and it lets clients that probe
    // multiple candidate URLs (e.g. an MCP client's RFC 8414 metadata discovery)
    // fall through to the next candidate instead of aborting on a server error.
    if (!SERVICES[service]) {
      return Response.json({ error: "not_found", message: `unknown emulator service: ${service}` }, { status: 404 });
    }

    // Control plane.
    if (path === "/__seed" && request.method === "POST") {
      const raw = (await request.json().catch(() => ({}))) as SeedConfig;
      const { strict, ...seed } = raw;
      await this.clearStoreSnapshot();
      await this.clearLedger();
      await this.clearMinted();
      await this.writeStateMeta({ seed, strict: strict !== false });
      this.live = undefined;
      await this.ensure(service, instance, baseUrl);
      await this.persist();
      return Response.json({ ok: true, url: baseUrl, strict: strict !== false });
    }
    if (path === "/__reset" && request.method === "POST") {
      const live = await this.ensure(service, instance, baseUrl);
      await live.reset();
      return Response.json({ ok: true });
    }
    // Mint a credential: find-or-create the identity, return a working token.
    // This is the "token creation endpoint that acts as auth" for strict mode.
    if (path === "/__token" && request.method === "POST") {
      const { login, scopes } = (await request.json().catch(() => ({}))) as {
        login?: string;
        scopes?: string[];
      };
      if (!login) return Response.json({ error: "login is required" }, { status: 400 });
      const entry = SERVICES[service];
      const live = await this.ensure(service, instance, baseUrl);
      const id = entry.ensureUser ? entry.ensureUser(live.store, baseUrl, login) : 1;
      const token = `emu_${service}_${crypto.randomUUID().replace(/-/g, "")}`;
      const scopeList = scopes ?? [];
      live.tokenMap.set(token, { login, id, scopes: scopeList });
      await this.writeMinted({ token, login, id, scopes: scopeList });
      await this.persist();
      return Response.json({ token, login, scopes: scopeList });
    }

    const live = await this.ensure(service, instance, baseUrl, preset);
    const res = await live.app.fetch(request);
    if (MUTATES(request.method)) await this.persist();
    return res;
  }
}
