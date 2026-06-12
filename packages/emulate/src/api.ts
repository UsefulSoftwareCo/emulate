import { createServer, serve, EmulatorClient, type AppKeyResolver, type FetchLike } from "@emulators/core";
import { SERVICE_REGISTRY, issueServiceCredential } from "./registry.js";
export type { ServiceName } from "./registry.js";
export {
  EmulatorClient,
  EmulatorControlError,
  type ConnectionsQuery,
  type CoverageResponse,
  type CredentialRequest,
  type IssuedCredential,
  type LedgerEntry,
  type LedgerIdentity,
  type LedgerSideEffect,
  type LedgerWebhookDelivery,
  type LogsResponse,
  type ManifestResponse,
  type ServiceManifest,
  type SpecsResponse,
  type StoreSnapshot,
  type WebhookDelivery,
} from "@emulators/core";
import type { ServiceName } from "./registry.js";
import { resolveBaseUrl } from "./base-url.js";

export interface SeedConfig {
  tokens?: Record<string, { login: string; scopes?: string[] }>;
  [service: string]: unknown;
}

export interface EmulatorOptions {
  service: ServiceName;
  port?: number;
  seed?: SeedConfig;
  baseUrl?: string;
}

/**
 * A handle on a running emulator. Extends the typed /_emulate control-plane
 * client (credentials.mint, ledger.list/clear, seed, reset, manifest, ...)
 * with lifecycle for the locally spawned process.
 */
export interface Emulator extends EmulatorClient {
  url: string;
  close(): Promise<void>;
}

export interface ConnectOptions {
  /** Provider base URL of a running emulator (local or hosted). */
  baseUrl: string;
  /**
   * Expected service id; when given, the manifest is fetched on connect and a
   * mismatch (or unreachable control plane) throws instead of failing later.
   */
  service?: ServiceName;
  /** Override fetch (e.g. an in-process app.request) — mainly for tests. */
  fetch?: FetchLike;
}

/**
 * Attach to an already-running emulator — another local process or a hosted
 * instance like `https://resend.<name>.emulators.dev` — and get the same
 * typed control-plane client a locally spawned Emulator carries. Unlike
 * createEmulator, nothing is spawned and close() is not available; lifecycle
 * belongs to whoever started the instance.
 */
export async function connectEmulator(options: ConnectOptions): Promise<EmulatorClient> {
  const client = new EmulatorClient(options.baseUrl, { fetch: options.fetch });
  if (options.service) {
    const { manifest } = await client.manifest();
    if (manifest.id !== options.service) {
      throw new Error(
        `connectEmulator: ${options.baseUrl} is a "${manifest.id}" emulator, expected "${options.service}"`,
      );
    }
  }
  return client;
}

export async function createEmulator(options: EmulatorOptions): Promise<Emulator> {
  const { service, port = 4000, seed: seedConfig } = options;

  const entry = SERVICE_REGISTRY[service];
  if (!entry) {
    throw new Error(`Unknown service: ${service}`);
  }

  const loaded = await entry.load();

  const tokens: Record<string, { login: string; id: number; scopes?: string[] }> = {};
  if (seedConfig?.tokens) {
    let tokenId = 100;
    for (const [token, user] of Object.entries(seedConfig.tokens)) {
      tokens[token] = { login: user.login, id: tokenId++, scopes: user.scopes };
    }
  } else {
    tokens["test_token_admin"] = { login: "admin", id: 2, scopes: ["repo", "user", "admin:org", "admin:repo_hook"] };
  }

  const svcSeedConfig = seedConfig?.[service] as Record<string, unknown> | undefined;
  const seedBaseUrl =
    typeof svcSeedConfig?.baseUrl === "string" && svcSeedConfig.baseUrl.length > 0 ? svcSeedConfig.baseUrl : undefined;
  const baseUrl = resolveBaseUrl({ service, port, baseUrl: options.baseUrl, seedBaseUrl });

  // eslint-disable-next-line prefer-const -- reassigned after closure captures it
  let cachedResolver: AppKeyResolver | undefined;
  const appKeyResolver: AppKeyResolver | undefined = loaded.createAppKeyResolver
    ? (appId) => cachedResolver!(appId)
    : undefined;

  const fallbackUser = entry.defaultFallback(svcSeedConfig);

  let resetService = () => {};
  let applyRuntimeSeed = (_seed: unknown) => {};
  const { app, store, webhooks, ledger, tokenMap } = createServer(loaded.plugin, {
    port,
    baseUrl,
    tokens,
    appKeyResolver,
    fallbackUser,
    manifest: loaded.manifest,
    instance: service,
    reset: () => resetService(),
    seed: (seed) => applyRuntimeSeed(seed),
    issueCredential: (request) => issueServiceCredential(service, loaded, store, baseUrl, tokenMap, request, webhooks),
  });
  cachedResolver = loaded.createAppKeyResolver?.(store);

  const seed = () => {
    webhooks.clear();
    ledger.clear();
    loaded.plugin.seed?.(store, baseUrl);
    if (svcSeedConfig && loaded.seedFromConfig) {
      loaded.seedFromConfig(store, baseUrl, svcSeedConfig, webhooks);
    }
  };
  applyRuntimeSeed = (seed) => {
    if (seed && loaded.seedFromConfig) {
      loaded.seedFromConfig(store, baseUrl, seed, webhooks);
    }
  };
  resetService = () => {
    store.reset();
    seed();
  };
  seed();

  const httpServer = serve({ fetch: app.fetch, port });

  // Control-plane calls dispatch in-process (no network round-trip, and they
  // work even when the advertised baseUrl is a not-yet-reachable proxy URL).
  class LocalEmulator extends EmulatorClient implements Emulator {
    readonly url = baseUrl;
    override async reset(): Promise<void> {
      store.reset();
      seed();
    }
    close(): Promise<void> {
      return new Promise((resolve, reject) => {
        httpServer.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    }
  }
  return new LocalEmulator(baseUrl, { fetch: (input, init) => app.request(input, init) });
}
