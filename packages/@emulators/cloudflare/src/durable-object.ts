import {
  createServer,
  type AppKeyResolver,
  type LedgerSnapshot,
  type RequestLedger,
  type Store,
  type TokenMap,
} from "@emulators/core";
import { SERVICES, issueCloudflareCredential } from "./services.js";

// Minimal CF runtime types (avoid a hard dep on @cloudflare/workers-types here).
interface DurableObjectStorage {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
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

// Durable Object storage caps each value at 128 KiB. A hosted instance persists
// its whole state (store snapshot + request ledger + minted tokens) under one
// "state" key. The minted-token list grows with every credential mint and is
// never cleared, so on a long-lived shared instance it eventually pushes the
// blob past the cap — at which point the put throws and EVERY future mutating
// request (mints included) fails with a faithful-looking 400. Bound the list,
// and shed the oldest history on the way down if a write overflows anyway.
const MAX_MINTED = 500;
const VALUE_TOO_LARGE = /larger than \d+ bytes/i;

const capMinted = (minted: TokenEntry[]): TokenEntry[] =>
  minted.length > MAX_MINTED ? minted.slice(-MAX_MINTED) : minted;

// Drop a quarter of the oldest sheddable history — debug ledger first, then
// stale minted tokens — so an overflowing "state" blob converges under the cap.
// Returns false when there is nothing left to shed (the write genuinely can't fit).
const shedOldest = (persisted: PersistedState): boolean => {
  const ledger = persisted.ledger?.entries;
  if (ledger && ledger.length > 0) {
    ledger.splice(0, Math.max(1, Math.ceil(ledger.length / 4)));
    return true;
  }
  const minted = persisted.minted;
  if (minted && minted.length > 0) {
    minted.splice(0, Math.max(1, Math.ceil(minted.length / 4)));
    return true;
  }
  return false;
};

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

    const persisted = (await this.state.storage.get<PersistedState>("state")) ?? {};
    const strict = persisted.strict ?? true;
    const tokens = this.buildTokens(persisted.seed, strict, persisted.minted);

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
        // tokens from persisted.minted), matching the legacy /__token endpoint.
        if (typeof credential.token === "string" && credential.token.length > 0) {
          const persistedState = (await this.state.storage.get<PersistedState>("state")) ?? {};
          persistedState.minted = capMinted([
            ...(persistedState.minted ?? []),
            {
              token: credential.token,
              login: credential.login ?? "admin",
              id: (tokenMap as TokenMap).get(credential.token)?.id ?? Date.now(),
              scopes: credential.scopes ?? [],
            },
          ]);
          await this.writeState(persistedState);
        }
        await this.persist();
        return credential;
      },
    });
    cachedResolver = entry.createAppKeyResolver?.(store);

    if (persisted.snapshot) store.restore(persisted.snapshot as Parameters<Store["restore"]>[0]);
    else this.seedInto(store, service, baseUrl, persisted.seed);
    ledger.restore(persisted.ledger);
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
    const persisted = (await this.state.storage.get<PersistedState>("state")) ?? {};
    persisted.snapshot = this.live.store.snapshot();
    // Persist the request ledger alongside state so inspection history survives
    // Durable Object eviction (the vision treats the ledger as a first-class,
    // durable feature, not an in-memory debug afterthought).
    persisted.ledger = this.live.ledger.serialize();
    await this.writeState(persisted);
  }

  // Write the "state" value, shedding the oldest history and retrying if the
  // write overflows the Durable Object 128 KiB per-value cap. An oversized blob
  // must never turn a mint or a routine persist into a faithful-looking 400 —
  // the instance trims its own debug history instead of wedging.
  private async writeState(persisted: PersistedState): Promise<void> {
    for (;;) {
      try {
        await this.state.storage.put("state", persisted);
        return;
      } catch (err) {
        if (!(err instanceof Error) || !VALUE_TOO_LARGE.test(err.message) || !shedOldest(persisted)) {
          throw err;
        }
      }
    }
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
      await this.state.storage.put("state", { seed, strict: strict !== false, minted: [] });
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
      const persisted = (await this.state.storage.get<PersistedState>("state")) ?? {};
      persisted.minted = capMinted([...(persisted.minted ?? []), { token, login, id, scopes: scopeList }]);
      persisted.snapshot = live.store.snapshot();
      await this.writeState(persisted);
      return Response.json({ token, login, scopes: scopeList });
    }

    const live = await this.ensure(service, instance, baseUrl, preset);
    const res = await live.app.fetch(request);
    if (MUTATES(request.method)) await this.persist();
    return res;
  }
}
