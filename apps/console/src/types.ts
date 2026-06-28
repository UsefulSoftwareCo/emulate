// Read-model of the service manifest the console fetches from /_emulate/manifest.
// Mirrors @emulators/core's ServiceManifest; kept local so the browser bundle
// stays decoupled from the server package.

export type SpecCoverage = "generated" | "hand-authored" | "partial" | "unsupported";

export interface OperationCoverage {
  operationId: string;
  method?: string;
  path?: string;
  status: SpecCoverage;
  summary?: string;
}

export interface SpecManifest {
  kind: string;
  title: string;
  url?: string;
  coverage: SpecCoverage;
  operations?: OperationCoverage[];
  notes?: string;
}

export interface SurfaceManifest {
  id: string;
  kind: string;
  title: string;
  basePath?: string;
  status: "supported" | "partial" | "unsupported";
  notes?: string;
}

export interface AuthCapabilityManifest {
  id: string;
  title: string;
  type: string;
  status: "supported" | "partial" | "unsupported";
  notes?: string;
}

export interface ScenarioManifest {
  id: string;
  title: string;
  description?: string;
}

export interface SeedFieldManifest {
  key: string;
  title: string;
  description?: string;
  example?: unknown;
}

export interface SeedSchemaManifest {
  description?: string;
  fields: SeedFieldManifest[];
  example?: unknown;
}

export interface InspectorTabManifest {
  id: string;
  title: string;
  kind: "landing" | "ledger" | "state" | "logs" | "credentials" | "seed" | "spec" | "custom";
  description?: string;
}

export interface ConnectionSnippet {
  id: string;
  title: string;
  kind: string;
  language?: string;
  description?: string;
  template: string;
}

export interface ResolvedConnection extends ConnectionSnippet {
  body: string;
}

export interface ServiceManifest {
  id: string;
  name: string;
  description: string;
  surfaces: SurfaceManifest[];
  auth: AuthCapabilityManifest[];
  specs: SpecManifest[];
  scenarios?: ScenarioManifest[];
  seedSchema?: SeedSchemaManifest;
  inspectorTabs?: InspectorTabManifest[];
  connections?: ConnectionSnippet[];
  docsUrl?: string;
}

export interface ManifestResponse {
  manifest: ServiceManifest;
  instance: { service: string; instance?: string; providerBaseUrl: string; controlBaseUrl: string } | null;
  connections: ResolvedConnection[];
}

export interface CatalogEntry {
  id: string;
  name: string;
  description: string;
  icon?: string;
  serviceHost: string;
  instanceHostPattern: string;
  pathForm: string;
  manifest: string;
}

declare global {
  interface Window {
    // Catalog inlined into the served HTML by the worker (static registry).
    __EMULATE_SERVICES__?: { services: CatalogEntry[] };
  }
}

export interface LedgerEntry {
  id: string;
  correlationId: string;
  timestamp: string;
  method: string;
  host: string;
  path: string;
  route?: string;
  operationId?: string;
  identity: { user?: { login: string }; app?: { name: string } };
  request: { headers: Record<string, string>; body?: unknown };
  response: { status: number; headers: Record<string, string>; body?: unknown };
  summary: string;
  sideEffects: Array<{ type: string; collection?: string; id?: string | number; summary?: string }>;
  webhookDeliveries: Array<{
    id: number;
    event: string;
    action?: string;
    status_code: number | null;
    success: boolean;
  }>;
  durationMs: number;
}

export interface CoverageReport {
  operations: OperationCoverage[];
  summary: Record<SpecCoverage, number>;
  specs: Array<{ kind: string; title: string; coverage: SpecCoverage; operationCount: number }>;
}
