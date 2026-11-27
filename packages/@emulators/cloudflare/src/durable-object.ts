import {
  createServer,
  type AppKeyResolver,
  type FaultRegistry,
  type FaultRegistrySnapshot,
  type LedgerEntry,
  type LedgerSnapshot,
  type RequestLedger,
  type Store,
  type StoreSnapshot,
  type TokenMap,
  type WebhookDispatcher,
  type WebhookDispatcherSnapshot,
  tokenEntry,
  tokenUser,
} from "@emulators/core";
import { ChunkedStorage, type DurableObjectStorage } from "./chunked-storage.js";
import { SERVICES, issueCloudflareCredential } from "./services.js";

// Minimal CF runtime types (avoid a hard dep on @cloudflare/workers-types here).
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
  externalId?: string;
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
  faults: FaultRegistry;
  webhooks: WebhookDispatcher;
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
// Every token the instance recognises, one record each, kept in step with the live token
// map after every request: what a service issues (OAuth access tokens, API keys, sessions)
// outlives an unload or a deploy, and a revocation stays revoked.
const MINTED_PREFIX = "minted:";
// Present once the records under MINTED_PREFIX are the whole token map. Instances saved
// before that recorded only control-plane tokens, so their seeded tokens are rebuilt from the seed.
const TOKENS_COMPLETE_KEY = "minted-complete";
// Webhook subscriptions held by the core dispatcher (GitHub's repository and org hooks):
// the id counters under WEBHOOKS_KEY, one value per subscription under the prefix.
const WEBHOOKS_KEY = "webhooks";
const WEBHOOK_SUB_PREFIX = "webhooks:sub:";
// The most recent saves that failed, newest last, shown at GET /_emulate/persistence.
const SAVE_FAILURES_KEY = "persist:failures";
const MAX_SAVE_FAILURES = 20;
// Armed faults and the next fault id. Cloudflare can replace an instance at any time, even
// between a test arming a fault and the request it targets, so faults persist with the store.
const FAULTS_KEY = "faults";

interface SnapshotCollectionMeta {
  autoId: number;
  indexFields: string[];
}
interface SnapshotMeta {
  collections: Record<string, SnapshotCollectionMeta>;
}
interface LedgerMeta {
  counter: number;
}
interface WebhookCounters {
  subscriptionIdCounter: number;
  deliveryIdCounter: number;
}
export interface SaveFailure {
  at: string;
  /** What was being saved: the request ("GET /user") or the step ("rebuild"). */
  during: string;
  error: string;
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
const ledgerIdNumber = (key: string): number =>
  Number(decodeKeyPart(key.slice(LEDGER_ENTRY_PREFIX.length)).replace(/^req_/, ""));
const webhookSubKey = (id: number): string => `${WEBHOOK_SUB_PREFIX}${id}`;
// One Durable Object instance == one stateful emulator instance. Its `store`
// lives in DO memory (single-threaded → the serialized-write consistency the
// in-process emulator already assumes). After every mutating request, the
// changed parts of the store and ledger are written to DO storage so the
// instance survives eviction. Auth is FAITHFUL by
// default (strict): only seeded or minted tokens work; everything else gets the
// real API's 401/403. Mint tokens at runtime via `POST /__token`.
export class EmulatorDurableObject {
  private live?: Live;
  // The JSON of every snapshot and ledger value last written to storage, by key.
  // `persist()` writes only the keys whose value changed and deletes only the
  // keys the state no longer has, so a request that changed nothing costs no
  // storage writes and the cost of a request does not grow with stored history.
  // Undefined until read from storage for the current live instance.
  private written?: Map<string, string>;
  // Keys of the ledger entries in storage. Entries never change once recorded, so a
  // save writes only new ones and deletes the ones the ledger has dropped.
  private writtenLedger?: Set<string>;
  private saveFailures: SaveFailure[] = [];
  // Set when a save that included the store failed: the next save includes it too.
  private storeUnsaved = false;
  // Storage key of each token, by token (a SHA-256, so computing it is async).
  private readonly tokenKeys = new Map<string, string>();

  // Values over the storage's 128 KiB limit are split into parts and reassembled.
  private readonly storage: ChunkedStorage;

  constructor(state: DurableObjectState, _env: unknown) {
    this.storage = new ChunkedStorage(state.storage);
  }

  private async readPersistedState(): Promise<PersistedState> {
    return (await this.storage.get<PersistedState>(STATE_KEY)) ?? {};
  }

  private async writeStateMeta(persisted: Pick<PersistedState, "seed" | "strict">): Promise<void> {
    await this.storage.put(STATE_KEY, {
      ...(persisted.seed !== undefined && { seed: persisted.seed }),
      ...(persisted.strict !== undefined && { strict: persisted.strict }),
    });
  }

  private async deleteKeys(keys: Iterable<string>): Promise<void> {
    const list = [...keys];
    if (list.length === 0) return;
    // storage.delete accepts at most 128 keys per call.
    for (let i = 0; i < list.length; i += STORAGE_BATCH_SIZE) {
      await this.storage.delete(list.slice(i, i + STORAGE_BATCH_SIZE));
    }
  }

  private async deletePrefix(prefix: string): Promise<void> {
    await this.deleteKeys((await this.storage.list({ prefix })).keys());
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

    await inBatches(writes, (write) => this.storage.put(write.key, write.value));
    await this.storage.put(SNAPSHOT_META_KEY, meta);

    const existingItems = await this.storage.list({ prefix: SNAPSHOT_ITEM_PREFIX });
    const existingData = await this.storage.list({ prefix: SNAPSHOT_DATA_PREFIX });
    await this.deleteKeys([...existingItems.keys(), ...existingData.keys()].filter((key) => !expectedKeys.has(key)));
  }

  private async readStoreSnapshot(legacySnapshot: unknown): Promise<StoreSnapshot | undefined> {
    const meta = await this.storage.get<SnapshotMeta>(SNAPSHOT_META_KEY);
    if (!meta) return legacySnapshot as StoreSnapshot | undefined;

    const collections: StoreSnapshot["collections"] = {};
    for (const [name, collectionMeta] of Object.entries(meta.collections)) {
      const itemEntries = await this.storage.list<StoreSnapshot["collections"][string]["items"][number]>({
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
    const dataEntries = await this.storage.list({ prefix: SNAPSHOT_DATA_PREFIX });
    for (const [storageKey, value] of dataEntries) {
      data[decodeKeyPart(storageKey.slice(SNAPSHOT_DATA_PREFIX.length))] = value;
    }

    return { collections, data };
  }

  private async clearStoreSnapshot(): Promise<void> {
    await this.deletePrefix(SNAPSHOT_ITEM_PREFIX);
    await this.deletePrefix(SNAPSHOT_DATA_PREFIX);
    await this.storage.delete(SNAPSHOT_META_KEY);
  }

  private async writeLedger(snapshot: LedgerSnapshot): Promise<void> {
    const expectedKeys = new Set(snapshot.entries.map((entry) => ledgerEntryKey(entry.id)));
    await inBatches(snapshot.entries, (entry) => this.storage.put(ledgerEntryKey(entry.id), entry));
    await this.storage.put(LEDGER_META_KEY, { counter: snapshot.counter } satisfies LedgerMeta);

    const existing = await this.storage.list({ prefix: LEDGER_ENTRY_PREFIX });
    await this.deleteKeys([...existing.keys()].filter((key) => !expectedKeys.has(key)));
  }

  private async readLedger(legacyLedger: LedgerSnapshot | undefined): Promise<LedgerSnapshot | undefined> {
    const meta = await this.storage.get<LedgerMeta>(LEDGER_META_KEY);
    if (!meta) return legacyLedger;
    const stored = await this.storage.list<LedgerEntry>({ prefix: LEDGER_ENTRY_PREFIX });
    const entries = [...stored.entries()]
      .sort(([a], [b]) => ledgerIdNumber(a) - ledgerIdNumber(b))
      .map(([, entry]) => entry);
    return { entries, counter: meta.counter };
  }

  private async clearLedger(): Promise<void> {
    await this.deletePrefix(LEDGER_ENTRY_PREFIX);
    await this.storage.delete(LEDGER_META_KEY);
  }

  private async mintedKey(token: string): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
    const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    return `${MINTED_PREFIX}${hex}`;
  }

  private async writeMinted(entry: TokenEntry): Promise<void> {
    await this.storage.put(await this.mintedKey(entry.token), entry);
  }

  private async readMinted(legacyMinted: TokenEntry[] | undefined): Promise<TokenEntry[]> {
    const byToken = new Map<string, TokenEntry>();
    for (const entry of legacyMinted ?? []) byToken.set(entry.token, entry);
    const stored = await this.storage.list<TokenEntry>({ prefix: MINTED_PREFIX });
    for (const entry of [...stored.values()].sort((a, b) => a.token.localeCompare(b.token))) {
      byToken.set(entry.token, entry);
    }
    return [...byToken.values()];
  }

  private async clearMinted(): Promise<void> {
    await this.deletePrefix(MINTED_PREFIX);
    await this.storage.delete(TOKENS_COMPLETE_KEY);
    this.tokenKeys.clear();
  }

  private async migrateLegacyState(persisted: PersistedState): Promise<void> {
    if (persisted.snapshot) {
      const hasSplitSnapshot = Boolean(await this.storage.get(SNAPSHOT_META_KEY));
      if (!hasSplitSnapshot) await this.writeStoreSnapshot(persisted.snapshot as StoreSnapshot);
    }
    if (persisted.ledger) {
      const hasSplitLedger = Boolean(await this.storage.get(LEDGER_META_KEY));
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
    complete: boolean,
  ): Record<string, { login: string; id: number; scopes?: string[]; externalId?: string }> {
    const tokens: Record<string, { login: string; id: number; scopes?: string[]; externalId?: string }> = {};
    if (complete) {
      // The stored records are the token map as it was, revocations included.
      for (const m of minted ?? []) tokens[m.token] = tokenUser(m);
      return tokens;
    }
    if (seed?.tokens) {
      let id = 100;
      for (const [token, user] of Object.entries(seed.tokens)) {
        tokens[token] = { login: user.login, id: id++, scopes: user.scopes };
      }
    } else if (!strict) {
      // Permissive convenience token only — strict mode requires explicit creds.
      tokens["test_token_admin"] = { login: "admin", id: 2, scopes: ["repo", "user", "admin:org", "admin:repo_hook"] };
    }
    for (const m of minted ?? []) tokens[m.token] = tokenUser(m);
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
    // The same instance reached under another base address (http and https, say) is rebuilt
    // for that address. Save everything first, so the rebuild starts from the state as it is.
    if (this.live) await this.save("rebuild for another base address");
    const entry = SERVICES[service];
    if (!entry) throw new Error(`unknown emulator service: ${service}`);

    this.written = undefined;
    const persisted = await this.readPersistedState();
    await this.migrateLegacyState(persisted);
    const strict = persisted.strict ?? true;
    const snapshot = await this.readStoreSnapshot(persisted.snapshot);
    const ledgerSnapshot = await this.readLedger(persisted.ledger);
    const faultSnapshot = await this.storage.get<FaultRegistrySnapshot>(FAULTS_KEY);
    const minted = await this.readMinted(persisted.minted);
    const complete = (await this.storage.get<boolean>(TOKENS_COMPLETE_KEY)) === true;
    const tokens = this.buildTokens(persisted.seed, strict, minted, complete);
    const webhookSnapshot = await this.readWebhooks();
    this.saveFailures = (await this.storage.get<SaveFailure[]>(SAVE_FAILURES_KEY)) ?? [];

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
    const { app, store, tokenMap, webhooks, ledger, faults } = createServer(entry.plugin, {
      baseUrl,
      tokens,
      appKeyResolver,
      fallbackUser,
      manifest: entry.manifest,
      instance,
      ledgerPersistent: true,
      reset: () => resetService(),
      onFaultConsumed: () => this.save("fault consumed"),
      seed: async (seed) => {
        if (seed && entry.seedFromConfig) {
          entry.seedFromConfig(store, baseUrl, seed as Record<string, unknown>);
          await this.save("POST /_emulate/seed");
        }
      },
      issueCredential: async (request) => {
        const credential = issueCloudflareCredential(service, entry, store, baseUrl, tokenMap as TokenMap, request);
        // A bearer or API-key credential is a token-map entry like any other, saved below.
        if (typeof credential.token === "string" && credential.token.length > 0 && !tokenMap.has(credential.token)) {
          tokenMap.set(credential.token, {
            login: credential.login ?? "admin",
            id: Date.now(),
            scopes: credential.scopes ?? [],
          });
        }
        await this.save("POST /_emulate/credentials");
        return credential;
      },
    });
    cachedResolver = entry.createAppKeyResolver?.(store);

    if (snapshot) store.restore(snapshot);
    else this.seedInto(store, service, baseUrl, persisted.seed);
    ledger.restore(ledgerSnapshot);
    faults.restore(faultSnapshot);
    webhooks.restore(webhookSnapshot);
    resetService = async () => {
      store.reset();
      webhooks.clear();
      ledger.clear();
      this.seedInto(store, service, baseUrl, persisted.seed);
      await entry.prepare?.(store);
      await this.save("reset");
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

    this.live = {
      app,
      store,
      tokenMap: tokenMap as TokenMap,
      ledger,
      faults,
      webhooks,
      service,
      instance,
      baseUrl,
      reset: resetService,
    };
    if (entry.prepare) {
      // Persist prepared state now: a read-only first request would not persist it,
      // and a rebuild must not replace state a client has already observed.
      await entry.prepare(store);
      await this.save("first build");
    }
    return this.live;
  }

  /**
   * Every value the live state needs in storage, by key. Without `withStore`, the
   * store snapshot is left out: it changes only on writes and is the costly part.
   */
  private persistedEntries(live: Live, withStore: boolean): Map<string, unknown> {
    const entries = new Map<string, unknown>();
    if (withStore) {
      const snapshot = live.store.snapshot();
      const meta: SnapshotMeta = { collections: {} };
      for (const [key, value] of Object.entries(snapshot.data)) entries.set(snapshotDataKey(key), value);
      for (const [name, collection] of Object.entries(snapshot.collections)) {
        meta.collections[name] = { autoId: collection.autoId, indexFields: collection.indexFields };
        for (const item of collection.items) entries.set(snapshotItemKey(name, item.id), item);
      }
      entries.set(SNAPSHOT_META_KEY, meta);
    }
    for (const [token, user] of live.tokenMap) entries.set(this.tokenKeys.get(token)!, tokenEntry(token, user));
    entries.set(TOKENS_COMPLETE_KEY, true);
    const webhooks = live.webhooks.serialize();
    for (const sub of webhooks.subscriptions) entries.set(webhookSubKey(sub.id), sub);
    entries.set(WEBHOOKS_KEY, {
      subscriptionIdCounter: webhooks.subscriptionIdCounter,
      deliveryIdCounter: webhooks.deliveryIdCounter,
    } satisfies WebhookCounters);
    entries.set(LEDGER_META_KEY, { counter: live.ledger.serialize().counter } satisfies LedgerMeta);
    entries.set(FAULTS_KEY, live.faults.serialize());
    return entries;
  }

  private async readWritten(): Promise<Map<string, string>> {
    const written = new Map<string, string>();
    for (const prefix of [SNAPSHOT_ITEM_PREFIX, SNAPSHOT_DATA_PREFIX, MINTED_PREFIX, WEBHOOK_SUB_PREFIX]) {
      for (const [key, value] of await this.storage.list({ prefix })) written.set(key, JSON.stringify(value));
    }
    for (const key of [SNAPSHOT_META_KEY, LEDGER_META_KEY, FAULTS_KEY, TOKENS_COMPLETE_KEY, WEBHOOKS_KEY]) {
      const value = await this.storage.get(key);
      if (value !== undefined) written.set(key, JSON.stringify(value));
    }
    return written;
  }

  /**
   * Bring storage in step with the live state. Called after every request: reads
   * too, since a read is recorded on the ledger and can issue or revoke a token.
   */
  private async persist(withStore = true): Promise<void> {
    const live = this.live;
    if (!live) return;
    const written = (this.written ??= await this.readWritten());
    const writtenLedger = (this.writtenLedger ??= new Set(
      (await this.storage.list({ prefix: LEDGER_ENTRY_PREFIX })).keys(),
    ));
    for (const token of live.tokenMap.keys()) {
      if (!this.tokenKeys.has(token)) this.tokenKeys.set(token, await this.mintedKey(token));
    }
    const puts: Array<{ key: string; value: unknown }> = [];
    const entries = this.persistedEntries(live, withStore);
    for (const [key, value] of entries) {
      const json = JSON.stringify(value);
      if (written.get(key) === json) continue;
      puts.push({ key, value });
      written.set(key, json);
    }
    const isStoreKey = (key: string) =>
      key === SNAPSHOT_META_KEY || key.startsWith(SNAPSHOT_ITEM_PREFIX) || key.startsWith(SNAPSHOT_DATA_PREFIX);
    const deletes = [...written.keys()].filter((key) => !entries.has(key) && (withStore || !isStoreKey(key)));
    for (const key of deletes) written.delete(key);

    const current = new Set<string>();
    for (const entry of live.ledger.serialize().entries) {
      const key = ledgerEntryKey(entry.id);
      current.add(key);
      if (!writtenLedger.has(key)) {
        puts.push({ key, value: entry });
        writtenLedger.add(key);
      }
    }
    for (const key of writtenLedger) {
      if (current.has(key)) continue;
      deletes.push(key);
      writtenLedger.delete(key);
    }

    if (puts.length === 0 && deletes.length === 0) return;
    try {
      await inBatches(puts, (put) => this.storage.put(put.key, put.value));
      await this.deleteKeys(deletes);
    } catch (error) {
      // Storage no longer matches the recorded values; read it again next time.
      this.written = undefined;
      this.writtenLedger = undefined;
      throw error;
    }
  }

  /**
   * Save, and never let a failed save change the answer: the emulated service's
   * response goes out either way, and the failure is kept for GET /_emulate/persistence.
   */
  private async save(during: string, withStore = true): Promise<void> {
    const includeStore = withStore || this.storeUnsaved;
    try {
      await this.persist(includeStore);
      this.storeUnsaved = false;
    } catch (error) {
      if (includeStore) this.storeUnsaved = true;
      const failure: SaveFailure = {
        at: new Date().toISOString(),
        during,
        error: error instanceof Error ? error.message : String(error),
      };
      this.saveFailures = [...this.saveFailures, failure].slice(-MAX_SAVE_FAILURES);
      await this.storage.put(SAVE_FAILURES_KEY, this.saveFailures).catch(() => undefined);
    }
  }

  private async readWebhooks(): Promise<WebhookDispatcherSnapshot | undefined> {
    const counters = await this.storage.get<WebhookCounters>(WEBHOOKS_KEY);
    if (!counters) return undefined;
    const subs = await this.storage.list<WebhookDispatcherSnapshot["subscriptions"][number]>({
      prefix: WEBHOOK_SUB_PREFIX,
    });
    return { ...counters, subscriptions: [...subs.values()].sort((a, b) => a.id - b.id) };
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
      await this.storage.delete(FAULTS_KEY);
      await this.storage.delete(WEBHOOKS_KEY);
      await this.deletePrefix(WEBHOOK_SUB_PREFIX);
      await this.writeStateMeta({ seed, strict: strict !== false });
      this.live = undefined;
      this.written = undefined;
      this.writtenLedger = undefined;
      await this.ensure(service, instance, baseUrl);
      await this.save(`${request.method} ${path}`);
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
      await this.save(`${request.method} ${path}`);
      return Response.json({ token, login, scopes: scopeList });
    }

    const live = await this.ensure(service, instance, baseUrl, preset);
    if (path === "/_emulate/persistence" && request.method === "GET") {
      return Response.json({ failures: [...this.saveFailures].reverse() });
    }
    const res = await live.app.fetch(request);
    // A plugin can ask for a save after a read that changed state (X counts GETs
    // against its rate limits and records them in the ledger). Others never do.
    const persistRequested = live.store.takePersistRequest();
    await this.save(`${request.method} ${path}`, MUTATES(request.method) || persistRequested);
    return res;
  }
}
