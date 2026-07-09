import type { Context, Hono } from "./http.js";
import type { AppEnv } from "./middleware/auth.js";
import type { Store } from "./store.js";
import type { WebhookDispatcher } from "./webhooks.js";
import type { RequestLedger } from "./ledger.js";
import type { ConnectionVars, EmulatorInstanceInfo, ResolvedConnection, ServiceManifest } from "./manifest.js";
import { coverageReport, enrichManifest, resolveConnections } from "./manifest.js";
import type { TokenMap } from "./middleware/auth.js";
import { escapeHtml, renderCardPage } from "./ui.js";
import type { FaultArmInput, FaultRegistry } from "./faults.js";

export interface CredentialRequest {
  type?: string;
  login?: string;
  name?: string;
  scopes?: string[];
  client_id?: string;
  client_secret?: string;
  redirect_uris?: string[];
  [key: string]: unknown;
}

export interface IssuedCredential {
  type: string;
  token?: string;
  login?: string;
  scopes?: string[];
  client_id?: string;
  client_secret?: string;
  redirect_uris?: string[];
  token_url?: string;
  authorization_url?: string;
  notes?: string;
  [key: string]: unknown;
}

export interface ControlPlaneOptions {
  manifest: ServiceManifest;
  instance: EmulatorInstanceInfo;
  store: Store;
  webhooks: WebhookDispatcher;
  ledger: RequestLedger;
  faults: FaultRegistry;
  tokenMap?: TokenMap;
  /** True when the host persists the ledger across eviction (e.g. a Durable Object). */
  ledgerPersistent?: boolean;
  /** Host suffix for the deployed form, e.g. "emulators.dev". */
  hostSuffix?: string;
  reset?: () => void | Promise<void>;
  seed?: (seed: unknown) => void | Promise<void>;
  issueCredential?: (request: CredentialRequest) => IssuedCredential | Promise<IssuedCredential>;
}

export const INSTANCE_NOTES =
  "Hosted deployments create instances lazily when the returned URL is first used. " +
  "The instance URL is a capability: anyone who has it can read and modify the instance, so save the returned URLs. " +
  "Never store real secrets in an emulator.";

// Instances are addressed by name alone, with no auth in front of the control
// plane, so the generated name is the only thing keeping one caller's state,
// ledger, and minted credentials away from everyone else. Always mix in 96 bits
// of crypto randomness; a caller-supplied name is a readable prefix, never the
// whole identity.
const INSTANCE_SUFFIX_BYTES = 12;
// Keep the full name a valid DNS label for the <service>.<instance>.<suffix> host form.
const INSTANCE_NAME_MAX = 63;

export function randomInstanceName(prefix?: string): string {
  const bytes = new Uint8Array(INSTANCE_SUFFIX_BYTES);
  crypto.getRandomValues(bytes);
  const suffix = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  const cleaned = slug(prefix ?? "");
  if (!cleaned) return suffix;
  return `${cleaned.slice(0, INSTANCE_NAME_MAX - suffix.length - 1)}-${suffix}`;
}

export interface InstanceCreation {
  service: string;
  instance: string;
  providerBaseUrl: string;
  controlBaseUrl: string;
  pathUrl: string;
  hostHint: string;
  notes: string;
}

/** The single, canonical shape for POST /_emulate/instances, shared by every host. */
export function buildInstanceCreation(args: {
  service: string;
  instance: string;
  providerBaseUrl: string;
  pathOrigin: string;
  hostSuffix: string;
}): InstanceCreation {
  return {
    service: args.service,
    instance: args.instance,
    providerBaseUrl: args.providerBaseUrl,
    controlBaseUrl: `${args.providerBaseUrl}/_emulate`,
    pathUrl: `${args.pathOrigin}/${args.service}/${args.instance}`,
    hostHint: `${args.service}.${args.instance}.${args.hostSuffix}`,
    notes: INSTANCE_NOTES,
  };
}

function connectionVars(
  manifest: ServiceManifest,
  instance: EmulatorInstanceInfo,
  overrides?: Partial<ConnectionVars>,
): ConnectionVars {
  return {
    baseUrl: instance.providerBaseUrl,
    providerBaseUrl: instance.providerBaseUrl,
    controlBaseUrl: instance.controlBaseUrl,
    service: manifest.id,
    instance: instance.instance,
    defaultAuthType: manifest.auth[0]?.type ?? "bearer-token",
    ...overrides,
  };
}

export function registerControlPlane(app: Hono<AppEnv>, options: ControlPlaneOptions): void {
  const { instance, store, webhooks, ledger, faults } = options;
  const manifest = enrichManifest(options.manifest, { ledgerPersistent: options.ledgerPersistent });
  const hostSuffix = options.hostSuffix ?? "emulators.dev";

  app.get("/_emulate", (c) => c.html(renderLandingPage(manifest, instance)));
  app.get("/_emulate/manifest", (c) =>
    c.json({
      manifest,
      instance,
      connections: resolveConnections(manifest.connections ?? [], connectionVars(manifest, instance)),
    }),
  );
  app.get("/_emulate/quickstart", (c) => c.text(renderQuickstart(manifest, instance)));
  app.get("/_emulate/specs", (c) => c.json({ specs: manifest.specs, surfaces: manifest.surfaces }));
  app.get("/_emulate/coverage", (c) => c.json(coverageReport(manifest)));
  app.get("/_emulate/connections", (c) => {
    const overrides: Partial<ConnectionVars> = {};
    const token = c.req.query("token");
    const clientId = c.req.query("client_id");
    const clientSecret = c.req.query("client_secret");
    if (token) overrides.token = token;
    if (clientId) overrides.clientId = clientId;
    if (clientSecret) overrides.clientSecret = clientSecret;
    return c.json({
      connections: resolveConnections(manifest.connections ?? [], connectionVars(manifest, instance, overrides)),
    });
  });
  app.get("/_emulate/openapi", (c) => redirectToSpec(c, manifest, instance, "openapi"));
  app.get("/_emulate/graphql", (c) => endpointForSurface(c, manifest, instance, "graphql"));
  app.get("/_emulate/mcp", (c) => endpointForSurface(c, manifest, instance, "mcp"));
  app.get("/_emulate/state", (c) => c.json(store.snapshot()));
  app.get("/_emulate/ledger", (c) => {
    const limitParam = c.req.query("limit");
    const limit = limitParam ? Number.parseInt(limitParam, 10) : undefined;
    return c.json({ entries: ledger.list(Number.isFinite(limit) ? limit : undefined) });
  });
  app.delete("/_emulate/ledger", (c) => {
    ledger.clear();
    return c.json({ ok: true });
  });
  app.get("/_emulate/faults", (c) => c.json({ faults: faults.list() }));
  app.post("/_emulate/faults", async (c) => {
    const body = (await c.req.json().catch(() => undefined)) as FaultArmInput | undefined;
    try {
      const fault = faults.arm(body as FaultArmInput);
      return c.json({ fault });
    } catch (err) {
      return c.json({ error: "invalid_fault", message: err instanceof Error ? err.message : "Invalid fault." }, 400);
    }
  });
  app.delete("/_emulate/faults", (c) => {
    faults.clear();
    return c.json({ ok: true });
  });
  app.delete("/_emulate/faults/:id", (c) => {
    const removed = faults.clear(c.req.param("id"));
    return c.json({ ok: true, removed });
  });
  app.get("/_emulate/logs", (c) => c.json({ webhooks: webhooks.getDeliveries(), requests: ledger.list(100) }));
  app.post("/_emulate/reset", async (c) => {
    if (options.reset) {
      await options.reset();
    } else {
      store.reset();
      webhooks.clear();
      ledger.clear();
    }
    faults.clear();
    return c.json({ ok: true });
  });
  app.post("/_emulate/seed", async (c) => {
    if (!options.seed) {
      return c.json({ error: "unsupported", message: "This emulator does not support runtime seeding." }, 501);
    }
    const body = await c.req.json().catch(() => undefined);
    try {
      await options.seed(body);
    } catch (err) {
      return c.json({ error: "invalid_seed", message: err instanceof Error ? err.message : "Seed failed." }, 400);
    }
    return c.json({ ok: true });
  });
  app.post("/_emulate/credentials", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as CredentialRequest;
    try {
      if (options.issueCredential) {
        const credential = await options.issueCredential(body);
        return c.json({ credential });
      }
      const credential = issueDefaultCredential(body, manifest, options.tokenMap);
      if (!credential) {
        return c.json({ error: "unsupported", message: "This emulator cannot create that credential type." }, 501);
      }
      return c.json({ credential });
    } catch (err) {
      return c.json(
        { error: "unsupported", message: err instanceof Error ? err.message : "Credential creation failed." },
        400,
      );
    }
  });
  app.post("/_emulate/instances", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { instance?: string; service?: string };
    const nextInstance = randomInstanceName(body.instance);
    const service = slug(body.service ?? manifest.id);
    const origin = new URL(instance.providerBaseUrl).origin;
    return c.json(
      buildInstanceCreation({
        service,
        instance: nextInstance,
        providerBaseUrl: `${origin}/${service}/${nextInstance}`,
        pathOrigin: origin,
        hostSuffix,
      }),
    );
  });
}

export function renderLandingPage(manifest: ServiceManifest, instance: EmulatorInstanceInfo): string {
  const surfaces = manifest.surfaces
    .map(
      (surface) =>
        `<tr><td>${escapeHtml(surface.title)}</td><td><span class="badge">${escapeHtml(surface.status)}</span></td><td><code>${escapeHtml(surface.basePath ?? "")}</code></td></tr>`,
    )
    .join("");
  const auth = manifest.auth
    .map((cap) => `<li><span class="badge">${escapeHtml(cap.status)}</span> ${escapeHtml(cap.title)}</li>`)
    .join("");
  const connections = resolveConnections(manifest.connections ?? [], connectionVars(manifest, instance));
  const instanceLabel = instance.instance ? ` · instance <code>${escapeHtml(instance.instance)}</code>` : "";

  return renderCardPage(
    `${manifest.name} Emulator`,
    escapeHtml(manifest.description),
    `
      <div class="s-card">
        <div class="section-heading">Base URLs${instanceLabel}</div>
        <p class="info-text">Provider: <code>${escapeHtml(instance.providerBaseUrl)}</code></p>
        <p class="info-text">Control: <code>${escapeHtml(instance.controlBaseUrl)}</code></p>
      </div>
      <div class="s-card">
        <div class="section-heading">Surfaces</div>
        <table class="inspector-table">
          <thead><tr><th>Surface</th><th>Status</th><th>Path</th></tr></thead>
          <tbody>${surfaces}</tbody>
        </table>
      </div>
      <div class="s-card">
        <div class="section-heading">Credentials</div>
        <ul class="perm-list">${auth}</ul>
      </div>
      ${renderConnectionsHtml(connections)}
      <div class="s-card">
        <div class="section-heading">Control API</div>
        <p class="info-text">${controlLinks()}</p>
      </div>
    `,
    manifest.id,
  );
}

function renderConnectionsHtml(connections: ResolvedConnection[]): string {
  if (connections.length === 0) return "";
  const blocks = connections
    .map(
      (c) =>
        `<div class="section-heading">${escapeHtml(c.title)}</div><pre class="code-block"><code>${escapeHtml(c.body)}</code></pre>`,
    )
    .join("");
  return `<div class="s-card"><div class="section-heading">Connect</div>${blocks}</div>`;
}

function controlLinks(): string {
  const routes = ["manifest", "quickstart", "specs", "coverage", "connections", "state", "ledger", "faults", "logs"];
  return routes.map((r) => `<a href="/_emulate/${r}">${r}</a>`).join(" | ");
}

export function renderQuickstart(manifest: ServiceManifest, instance: EmulatorInstanceInfo): string {
  const connections = resolveConnections(manifest.connections ?? [], connectionVars(manifest, instance));
  const lines = [
    `# ${manifest.name} Emulator`,
    "",
    manifest.description,
    "",
    `Provider base URL: ${instance.providerBaseUrl}`,
    `Control base URL: ${instance.controlBaseUrl}`,
    "",
    "Supported surfaces:",
    ...manifest.surfaces.map((s) => `- ${s.title}: ${s.status}${s.basePath ? ` at ${s.basePath}` : ""}`),
    "",
    "Control endpoints:",
    `- ${instance.controlBaseUrl}/manifest`,
    `- ${instance.controlBaseUrl}/coverage`,
    `- ${instance.controlBaseUrl}/connections`,
    `- ${instance.controlBaseUrl}/state`,
    `- ${instance.controlBaseUrl}/ledger`,
    `- ${instance.controlBaseUrl}/faults`,
    `- POST ${instance.controlBaseUrl}/credentials`,
    `- POST ${instance.controlBaseUrl}/seed`,
    `- POST ${instance.controlBaseUrl}/reset`,
    "",
    "Fault injection:",
    "Arm a one-shot provider failure with a glob pathPattern, then inspect /ledger for faulted: true.",
    `curl -s -X POST ${instance.controlBaseUrl}/faults \\`,
    `  -H "content-type: application/json" \\`,
    `  -d '{"match":{"method":"GET","pathPattern":"/v1/*"},"response":{"status":503,"body":{"error":"temporary"}}}'`,
    "",
    "Connect:",
    ...connections.flatMap((c) => ["", `## ${c.title}`, c.body]),
  ];
  return lines.join("\n");
}

function issueDefaultCredential(
  request: CredentialRequest,
  manifest: ServiceManifest,
  tokenMap: TokenMap | undefined,
): IssuedCredential | null {
  const type = request.type ?? manifest.auth[0]?.type ?? "bearer-token";
  if (type !== "bearer-token" && type !== "api-key") return null;
  if (!tokenMap) return null;
  const token = typeof request.token === "string" && request.token ? request.token : `emu_${manifest.id}_${randomId()}`;
  const login = request.login ?? "admin";
  const scopes = Array.isArray(request.scopes) ? request.scopes.filter((s): s is string => typeof s === "string") : [];
  tokenMap.set(token, { login, id: Date.now(), scopes });
  return { type, token, login, scopes };
}

function redirectToSpec(c: Context<AppEnv>, manifest: ServiceManifest, instance: EmulatorInstanceInfo, kind: string) {
  const spec = manifest.specs.find((s) => s.kind === kind && s.url);
  if (spec?.url) return c.redirect(resolveUrl(instance.providerBaseUrl, spec.url));
  const advertised = manifest.specs.some((s) => s.kind === kind);
  if (kind === "openapi" && advertised) return c.redirect(`${instance.providerBaseUrl}/openapi.json`);
  return c.json({ error: "not_found", message: `No ${kind} spec is advertised for this emulator.` }, 404);
}

function endpointForSurface(
  c: Context<AppEnv>,
  manifest: ServiceManifest,
  instance: EmulatorInstanceInfo,
  kind: "graphql" | "mcp",
) {
  const surface = manifest.surfaces.find((s) => s.kind === kind && s.basePath);
  if (!surface?.basePath) {
    return c.json({ error: "not_found", message: `No ${kind} surface is advertised for this emulator.` }, 404);
  }
  return c.json({ endpoint: resolveUrl(instance.providerBaseUrl, surface.basePath), surface });
}

function resolveUrl(baseUrl: string, pathOrUrl: string): string {
  if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;
  return `${baseUrl}${pathOrUrl.startsWith("/") ? "" : "/"}${pathOrUrl}`;
}

function randomId(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}
