// Typed client for the /_emulate control plane. One handle works against any
// emulator wherever it runs — a local createEmulator() process, another
// process on the same machine, or a hosted instance on emulators.dev — so
// consumers never hand-roll fetch calls or re-cast response shapes the server
// already types.
import type { CredentialRequest, IssuedCredential } from "./control-plane.js";
import type { LedgerEntry } from "./ledger.js";
import type {
  EmulatorInstanceInfo,
  OperationCoverage,
  ResolvedConnection,
  ServiceManifest,
  SpecCoverage,
  SpecKind,
  SpecManifest,
  SurfaceManifest,
} from "./manifest.js";
import type { StoreSnapshot } from "./store.js";
import type { WebhookDelivery } from "./webhooks.js";

export interface ManifestResponse {
  manifest: ServiceManifest;
  instance: EmulatorInstanceInfo;
  connections: ResolvedConnection[];
}

export interface SpecsResponse {
  specs: SpecManifest[];
  surfaces: SurfaceManifest[];
}

export interface CoverageResponse {
  operations: OperationCoverage[];
  summary: Record<SpecCoverage, number>;
  specs: Array<{ kind: SpecKind; title: string; coverage: SpecCoverage; operationCount: number }>;
}

export interface LogsResponse {
  webhooks: WebhookDelivery[];
  requests: LedgerEntry[];
}

export interface ConnectionsQuery {
  token?: string;
  clientId?: string;
  clientSecret?: string;
}

export class EmulatorControlError extends Error {
  constructor(
    readonly method: string,
    readonly url: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(`${method} ${url} -> ${status}${body ? `: ${body.slice(0, 300)}` : ""}`);
    this.name = "EmulatorControlError";
  }
}

/** fetch-compatible function, injectable for tests (e.g. a Hono app.request). */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class EmulatorClient {
  /** Provider base URL — what an SDK or app under test points at. */
  readonly baseUrl: string;
  readonly #fetch: FetchLike;

  constructor(baseUrl: string, options?: { fetch?: FetchLike }) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.#fetch = options?.fetch ?? ((input, init) => fetch(input, init));
  }

  /** The /_emulate/openapi URL — feed it to anything that ingests a spec. */
  get openapiUrl(): string {
    return `${this.baseUrl}/_emulate/openapi`;
  }

  async manifest(): Promise<ManifestResponse> {
    return this.#json("GET", "/_emulate/manifest");
  }

  async quickstart(): Promise<string> {
    return this.#text("GET", "/_emulate/quickstart");
  }

  async specs(): Promise<SpecsResponse> {
    return this.#json("GET", "/_emulate/specs");
  }

  async coverage(): Promise<CoverageResponse> {
    return this.#json("GET", "/_emulate/coverage");
  }

  async connections(query?: ConnectionsQuery): Promise<ResolvedConnection[]> {
    const params = new URLSearchParams();
    if (query?.token) params.set("token", query.token);
    if (query?.clientId) params.set("client_id", query.clientId);
    if (query?.clientSecret) params.set("client_secret", query.clientSecret);
    const qs = params.size > 0 ? `?${params}` : "";
    const body = await this.#json<{ connections: ResolvedConnection[] }>("GET", `/_emulate/connections${qs}`);
    return body.connections;
  }

  async state(): Promise<StoreSnapshot> {
    return this.#json("GET", "/_emulate/state");
  }

  async logs(): Promise<LogsResponse> {
    return this.#json("GET", "/_emulate/logs");
  }

  readonly ledger = {
    list: async (limit?: number): Promise<LedgerEntry[]> => {
      const qs = limit !== undefined ? `?limit=${limit}` : "";
      const body = await this.#json<{ entries: LedgerEntry[] }>("GET", `/_emulate/ledger${qs}`);
      return body.entries;
    },
    clear: async (): Promise<void> => {
      await this.#json("DELETE", "/_emulate/ledger");
    },
  };

  readonly credentials = {
    mint: async (request: CredentialRequest = {}): Promise<IssuedCredential> => {
      const body = await this.#json<{ credential: IssuedCredential }>("POST", "/_emulate/credentials", request);
      return body.credential;
    },
  };

  async seed(seed: unknown): Promise<void> {
    await this.#json("POST", "/_emulate/seed", seed);
  }

  async reset(): Promise<void> {
    await this.#json("POST", "/_emulate/reset", {});
  }

  async #request(method: string, path: string, body?: unknown): Promise<Response> {
    const url = `${this.baseUrl}${path}`;
    const response = await this.#fetch(url, {
      method,
      ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      throw new EmulatorControlError(method, url, response.status, await response.text());
    }
    return response;
  }

  async #json<T>(method: string, path: string, body?: unknown): Promise<T> {
    return (await this.#request(method, path, body)).json() as Promise<T>;
  }

  async #text(method: string, path: string, body?: unknown): Promise<string> {
    return (await this.#request(method, path, body)).text();
  }
}
