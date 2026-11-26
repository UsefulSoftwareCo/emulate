import type { Server } from "node:http";
import {
  createServer,
  serve,
  EmulatorClient,
  type AppKeyResolver,
  type FetchHandler,
  type FetchLike,
  type LedgerEntry,
} from "@emulators/core";
import { SERVICE_REGISTRY, issueServiceCredential } from "./registry.js";
export type { ServiceName } from "./registry.js";
export {
  EmulatorClient,
  EmulatorControlError,
  type ArmedFault,
  type ConnectionsQuery,
  type CoverageResponse,
  type CredentialRequest,
  type FaultArmInput,
  type FaultMatch,
  type FaultResponse,
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
  /** Port to listen on. 0 picks a free port; `url` then reports the one bound. Default 4000. */
  port?: number;
  /**
   * Address to listen on, e.g. "127.0.0.1" or "::1". Default: all interfaces.
   * When given, the default `url` names this address instead of localhost.
   */
  hostname?: string;
  seed?: SeedConfig;
  baseUrl?: string;
  /**
   * Only seeded or minted tokens authenticate; an unknown or revoked token gets the
   * real API's unauthorized answer. Default false: an unknown token acts as the
   * service's default user, as before. The hosted surface's strict instances behave the same.
   */
  strict?: boolean;
}

/**
 * A handle on a running emulator. Extends the typed /_emulate control-plane
 * client (credentials.mint, ledger.list/clear, seed, reset, manifest, ...)
 * with lifecycle for the locally spawned process.
 */
export interface Emulator extends EmulatorClient {
  url: string;
  /** The port the emulator is listening on (the bound one when `port: 0` was asked for). */
  port: number;
  /**
   * Call listener with each provider request as the ledger records it, after
   * its handler has finished and its state changes are visible. Control-plane
   * (/_emulate) calls are not recorded. Returns a function that stops it.
   */
  onRequest(listener: (entry: LedgerEntry) => void): () => void;
  close(): Promise<void>;
}

/** Wait for a server whose listen() was already called to bind, and return its port. */
function listening(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.once("listening", () => {
      server.off("error", onError);
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error(`createEmulator: expected a TCP address, got ${String(address)}`));
      } else resolve(address.port);
    });
  });
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
  const { service, port: requestedPort = 4000, hostname, seed: seedConfig } = options;

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

  // Bind before building the app: the base URL (and everything seeded with
  // it) depends on the port actually bound when port 0 is requested. Requests
  // that arrive before setup finishes wait for the handler.
  let provide!: (handler: FetchHandler) => void;
  const handler = new Promise<FetchHandler>((resolve) => (provide = resolve));
  const httpServer = serve({ fetch: async (request) => (await handler)(request), port: requestedPort, hostname });
  const port = await listening(httpServer);
  try {
    return build(port);
  } catch (error) {
    httpServer.close();
    throw error;
  }

  function build(port: number): Emulator {
    const svcSeedConfig = seedConfig?.[service] as Record<string, unknown> | undefined;
    const seedBaseUrl =
      typeof svcSeedConfig?.baseUrl === "string" && svcSeedConfig.baseUrl.length > 0
        ? svcSeedConfig.baseUrl
        : undefined;
    const baseUrl = resolveBaseUrl({ service, port, hostname, baseUrl: options.baseUrl, seedBaseUrl });

    // eslint-disable-next-line prefer-const -- reassigned after closure captures it
    let cachedResolver: AppKeyResolver | undefined;
    const appKeyResolver: AppKeyResolver | undefined = loaded.createAppKeyResolver
      ? (appId) => cachedResolver!(appId)
      : undefined;

    const fallbackUser = options.strict === true ? undefined : entry.defaultFallback(svcSeedConfig);

    let resetService = () => {};
    let applyRuntimeSeed = (_seed: unknown) => {};
    const { app, store, webhooks, ledger, faults, tokenMap } = createServer(loaded.plugin, {
      port,
      baseUrl,
      tokens,
      appKeyResolver,
      fallbackUser,
      manifest: loaded.manifest,
      instance: service,
      reset: () => resetService(),
      seed: (seed) => applyRuntimeSeed(seed),
      issueCredential: (request) =>
        issueServiceCredential(service, loaded, store, baseUrl, tokenMap, request, webhooks),
    });
    cachedResolver = loaded.createAppKeyResolver?.(store);

    const seed = () => {
      webhooks.clear();
      ledger.clear();
      faults.clear();
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

    provide(app.fetch);

    // Control-plane calls dispatch in-process (no network round-trip, and they
    // work even when the advertised baseUrl is a not-yet-reachable proxy URL).
    class LocalEmulator extends EmulatorClient implements Emulator {
      readonly url = baseUrl;
      readonly port = port;
      onRequest(listener: (entry: LedgerEntry) => void): () => void {
        return ledger.subscribe(listener);
      }
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
}
