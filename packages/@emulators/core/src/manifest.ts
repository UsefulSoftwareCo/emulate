export type SpecKind = "openapi" | "graphql" | "mcp" | "google-discovery" | "oauth-metadata" | "manual";
export type SpecCoverage = "generated" | "hand-authored" | "partial" | "unsupported";

/**
 * Per-operation coverage. The vision asks for honest, operation-level coverage
 * boundaries (generated / hand-authored / partial / unsupported) instead of a
 * single label stamped across an entire spec. A plugin declares the operations
 * it actually implements; `GET /_emulate/coverage` reports them with a summary.
 */
export interface OperationCoverage {
  operationId: string;
  method?: string;
  path?: string;
  status: SpecCoverage;
  summary?: string;
}

export interface SpecManifest {
  kind: SpecKind;
  title: string;
  url?: string;
  coverage: SpecCoverage;
  operations?: OperationCoverage[];
  notes?: string;
}

export interface SurfaceManifest {
  id: string;
  kind: "rest" | "oauth" | "oidc" | "graphql" | "mcp" | "webhooks" | "ui" | "provider-specific";
  title: string;
  basePath?: string;
  status: "supported" | "partial" | "unsupported";
  notes?: string;
}

export interface AuthCapabilityManifest {
  id: string;
  title: string;
  type:
    | "api-key"
    | "bearer-token"
    | "oauth-client-credentials"
    | "oauth-authorization-code"
    | "oidc"
    | "jwt-app"
    | "dynamic-client-registration"
    | "webhook-secret"
    | "provider-specific";
  status: "supported" | "partial" | "unsupported";
  notes?: string;
}

export interface ScenarioManifest {
  id: string;
  title: string;
  description?: string;
}

/** A seedable area of the instance, surfaced so agents can discover the seed shape. */
export interface SeedFieldManifest {
  key: string;
  title: string;
  description?: string;
  example?: unknown;
}

export interface SeedSchemaManifest {
  description?: string;
  fields: SeedFieldManifest[];
  /** A full example seed body that can be POSTed to /_emulate/seed. */
  example?: unknown;
}

export interface StateCollectionManifest {
  name: string;
  title?: string;
  description?: string;
}

export interface StateModelManifest {
  description?: string;
  collections: StateCollectionManifest[];
}

export interface ResetBehaviorManifest {
  description: string;
  reseeds: boolean;
  clearsLedger: boolean;
  clearsWebhooks: boolean;
}

export type InspectorTabKind = "landing" | "ledger" | "state" | "logs" | "credentials" | "seed" | "spec" | "custom";

export interface InspectorTabManifest {
  id: string;
  title: string;
  kind: InspectorTabKind;
  description?: string;
}

/** Describes what the request ledger records and how durable it is. */
export interface LedgerCapabilitiesManifest {
  description?: string;
  recordsFields: string[];
  redactsSensitive: boolean;
  correlationId: boolean;
  webhookDeliveries: boolean;
  sideEffects: boolean;
  persistent: boolean;
  maxEntries?: number;
}

export type ConnectionKind = "sdk" | "cli" | "env" | "curl" | "config" | "mcp";

/**
 * A copyable connection snippet. The `template` uses {{placeholders}} that the
 * control plane resolves against the live instance ({{baseUrl}}, {{controlBaseUrl}},
 * {{service}}, {{instance}}, {{token}}, {{clientId}}, {{clientSecret}}). This is
 * how a human or agent copies ready-to-run SDK / CLI / app config without repo
 * context.
 */
export interface ConnectionSnippet {
  id: string;
  title: string;
  kind: ConnectionKind;
  language?: string;
  description?: string;
  template: string;
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
  stateModel?: StateModelManifest;
  resetBehavior?: ResetBehaviorManifest;
  inspectorTabs?: InspectorTabManifest[];
  ledger?: LedgerCapabilitiesManifest;
  connections?: ConnectionSnippet[];
  docsUrl?: string;
}

export interface EmulatorInstanceInfo {
  service: string;
  instance?: string;
  baseUrl: string;
  controlBaseUrl: string;
  providerBaseUrl: string;
}

/**
 * Reset, ledger capabilities, inspector tabs and base connection snippets are the
 * same for every emulator because they all run on the shared core control plane.
 * Defining them once here keeps per-plugin manifests focused on service-specific
 * surface, auth, seed, and SDK details, and guarantees the control plane never
 * lies about a capability it actually provides.
 */
export const CORE_RESET_BEHAVIOR: ResetBehaviorManifest = {
  description: "Resets the instance to its seeded baseline.",
  reseeds: true,
  clearsLedger: true,
  clearsWebhooks: true,
};

export function coreLedgerCapabilities(persistent: boolean): LedgerCapabilitiesManifest {
  return {
    description: "Recent provider requests with sensitive headers and fields redacted.",
    recordsFields: [
      "timestamp",
      "method",
      "host",
      "path",
      "route",
      "operationId",
      "correlationId",
      "identity",
      "request",
      "response",
      "summary",
      "sideEffects",
      "webhookDeliveries",
      "durationMs",
    ],
    redactsSensitive: true,
    correlationId: true,
    webhookDeliveries: true,
    sideEffects: true,
    persistent,
    maxEntries: 1000,
  };
}

export function coreInspectorTabs(manifest: ServiceManifest): InspectorTabManifest[] {
  const tabs: InspectorTabManifest[] = [
    {
      id: "overview",
      title: "Overview",
      kind: "landing",
      description: "Service surfaces, base URLs, and connection snippets.",
    },
    {
      id: "ledger",
      title: "Ledger",
      kind: "ledger",
      description: "Recent provider requests recorded by the emulator.",
    },
    { id: "state", title: "State", kind: "state", description: "Current seeded and mutated instance state." },
    {
      id: "credentials",
      title: "Credentials",
      kind: "credentials",
      description: "Mint tokens, API keys, or OAuth clients.",
    },
  ];
  if (manifest.seedSchema || (manifest.scenarios && manifest.scenarios.length > 0)) {
    tabs.push({ id: "seed", title: "Seed", kind: "seed", description: "Seed state or load a scenario." });
  }
  if (manifest.specs.some((s) => s.kind === "openapi" || s.kind === "graphql")) {
    tabs.push({ id: "spec", title: "Spec", kind: "spec", description: "OpenAPI / GraphQL spec sources and coverage." });
  }
  if (manifest.surfaces.some((s) => s.kind === "webhooks")) {
    tabs.push({
      id: "logs",
      title: "Webhooks",
      kind: "logs",
      description: "Webhook deliveries dispatched by the emulator.",
    });
  }
  return tabs;
}

/** Connection snippets every emulator can offer (env + curl against the control plane). */
export function coreConnections(): ConnectionSnippet[] {
  return [
    {
      id: "base-url",
      title: "Base URL (env)",
      kind: "env",
      language: "bash",
      description: "Point your SDK or app at the emulator instead of the real provider.",
      template: "{{SERVICE_UPPER}}_BASE_URL={{baseUrl}}",
    },
    {
      id: "create-credential",
      title: "Create a credential",
      kind: "curl",
      language: "bash",
      description: "Mint a working credential for this instance.",
      template:
        'curl -s -X POST {{controlBaseUrl}}/credentials \\\n  -H "content-type: application/json" \\\n  -d \'{"type":"{{defaultAuthType}}"}\'',
    },
    {
      id: "inspect-ledger",
      title: "Inspect requests",
      kind: "curl",
      language: "bash",
      description: "Read the request ledger to validate how your app called the service.",
      template: "curl -s {{controlBaseUrl}}/ledger",
    },
  ];
}

/**
 * Merge the shared core capabilities into a plugin manifest so every served
 * manifest fully describes reset behavior, ledger capabilities, inspector tabs,
 * and at least the base connection snippets, without each plugin repeating them.
 */
export function enrichManifest(manifest: ServiceManifest, opts: { ledgerPersistent?: boolean } = {}): ServiceManifest {
  return {
    ...manifest,
    resetBehavior: manifest.resetBehavior ?? CORE_RESET_BEHAVIOR,
    ledger: manifest.ledger ?? coreLedgerCapabilities(opts.ledgerPersistent ?? false),
    inspectorTabs: manifest.inspectorTabs ?? coreInspectorTabs(manifest),
    connections: [...(manifest.connections ?? []), ...coreConnections()],
  };
}

export interface ConnectionVars {
  baseUrl: string;
  providerBaseUrl: string;
  controlBaseUrl: string;
  service: string;
  instance?: string;
  token?: string;
  clientId?: string;
  clientSecret?: string;
  defaultAuthType?: string;
}

export interface ResolvedConnection extends ConnectionSnippet {
  body: string;
}

/** Interpolate a connection snippet template against live instance values. */
export function resolveConnections(connections: ConnectionSnippet[], vars: ConnectionVars): ResolvedConnection[] {
  const map: Record<string, string> = {
    baseUrl: vars.baseUrl,
    providerBaseUrl: vars.providerBaseUrl,
    controlBaseUrl: vars.controlBaseUrl,
    service: vars.service,
    SERVICE_UPPER: vars.service.toUpperCase().replace(/[^A-Z0-9]+/g, "_"),
    instance: vars.instance ?? "default",
    token: vars.token ?? "<token>",
    clientId: vars.clientId ?? "<client_id>",
    clientSecret: vars.clientSecret ?? "<client_secret>",
    defaultAuthType: vars.defaultAuthType ?? "bearer-token",
  };
  return connections.map((snippet) => ({
    ...snippet,
    body: snippet.template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => map[key] ?? `{{${key}}}`),
  }));
}

/** A summary of declared per-operation coverage across a manifest's specs. */
export function coverageReport(manifest: ServiceManifest): {
  operations: OperationCoverage[];
  summary: Record<SpecCoverage, number>;
  specs: Array<{ kind: SpecKind; title: string; coverage: SpecCoverage; operationCount: number }>;
} {
  const operations: OperationCoverage[] = [];
  const summary: Record<SpecCoverage, number> = {
    generated: 0,
    "hand-authored": 0,
    partial: 0,
    unsupported: 0,
  };
  const specs = manifest.specs.map((spec) => {
    const ops = spec.operations ?? [];
    for (const op of ops) {
      operations.push(op);
      summary[op.status] += 1;
    }
    return { kind: spec.kind, title: spec.title, coverage: spec.coverage, operationCount: ops.length };
  });
  return { operations, summary, specs };
}

export function createDefaultManifest(service: string): ServiceManifest {
  return {
    id: service,
    name: service,
    description: `Stateful ${service} API emulator.`,
    surfaces: [{ id: "rest", kind: "rest", title: "REST API", status: "partial" }],
    auth: [{ id: "bearer", title: "Bearer token", type: "bearer-token", status: "partial" }],
    specs: [{ kind: "manual", title: "Hand-authored emulator behavior", coverage: "partial" }],
  };
}
