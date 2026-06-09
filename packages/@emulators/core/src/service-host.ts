import type { EmulatorInstanceInfo, ServiceManifest } from "./manifest.js";
import { coverageReport, enrichManifest, resolveConnections } from "./manifest.js";
import { escapeHtml, renderCardPage } from "./ui.js";
import { renderQuickstart, INSTANCE_NOTES } from "./control-plane.js";

export interface ServiceHostContext {
  manifest: ServiceManifest;
  service: string;
  /** Apex origin for the path form, e.g. https://emulators.dev. */
  origin: string;
  /** Request protocol including the colon, e.g. "https:". */
  protocol: string;
  /** Host suffix for the deployed form, e.g. "emulators.dev". */
  hostSuffix: string;
  /** Whether the deployed host persists the ledger across eviction. */
  ledgerPersistent?: boolean;
}

const SAMPLE_INSTANCE = "your-instance";

function sampleInstanceInfo(ctx: ServiceHostContext): EmulatorInstanceInfo {
  const providerBaseUrl = `${ctx.protocol}//${ctx.service}.${SAMPLE_INSTANCE}.${ctx.hostSuffix}`;
  return {
    service: ctx.service,
    instance: SAMPLE_INSTANCE,
    baseUrl: providerBaseUrl,
    providerBaseUrl,
    controlBaseUrl: `${providerBaseUrl}/_emulate`,
  };
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/**
 * Serve the service-level control plane on a bare service host (e.g.
 * github.emulators.dev) so a human or agent can read the manifest, quickstart,
 * specs, coverage, and connection snippets WITHOUT first creating an instance.
 * Returns null for paths this should not handle (so the caller can fall through
 * to the interactive console SPA).
 */
export function serviceHostControlPlane(path: string, method: string, ctx: ServiceHostContext): Response | null {
  if (!path.startsWith("/_emulate")) return null;
  if (method !== "GET" && method !== "HEAD") return null;

  const manifest = enrichManifest(ctx.manifest, { ledgerPersistent: ctx.ledgerPersistent });
  const sample = sampleInstanceInfo(ctx);
  const connections = resolveConnections(manifest.connections ?? [], {
    baseUrl: sample.providerBaseUrl,
    providerBaseUrl: sample.providerBaseUrl,
    controlBaseUrl: sample.controlBaseUrl,
    service: ctx.service,
    instance: SAMPLE_INSTANCE,
    defaultAuthType: manifest.auth[0]?.type ?? "bearer-token",
  });

  switch (path) {
    case "/_emulate":
      return new Response(renderServiceLanding(manifest, ctx, sample), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    case "/_emulate/manifest":
      return json({ manifest, instance: null, sampleInstance: sample, connections });
    case "/_emulate/quickstart":
      return new Response(renderServiceQuickstart(manifest, ctx, sample), {
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    case "/_emulate/specs":
      return json({ specs: manifest.specs, surfaces: manifest.surfaces });
    case "/_emulate/coverage":
      return json(coverageReport(manifest));
    case "/_emulate/connections":
      return json({ connections });
    case "/_emulate/openapi": {
      const spec = manifest.specs.find((s) => s.kind === "openapi");
      if (!spec) return json({ error: "not_found", message: "No OpenAPI spec is advertised for this emulator." }, 404);
      return json({
        openapi: `${sample.providerBaseUrl}${spec.url ?? "/openapi.json"}`,
        note: "Create an instance, then fetch this URL for the live spec.",
      });
    }
    default:
      return null;
  }
}

function renderServiceQuickstart(
  manifest: ServiceManifest,
  ctx: ServiceHostContext,
  sample: EmulatorInstanceInfo,
): string {
  const base = renderQuickstart(manifest, sample);
  const header = [
    `# ${manifest.name} Emulator (service host)`,
    "",
    "Create an instance:",
    `curl -s -X POST ${ctx.protocol}//${ctx.service}.${ctx.hostSuffix}/_emulate/instances -H 'content-type: application/json' -d '{"instance":"my-run"}'`,
    `# ${INSTANCE_NOTES}`,
    "",
    "Then use the returned providerBaseUrl / controlBaseUrl. Example below uses a sample instance.",
    "",
  ];
  return header.join("\n") + base;
}

function renderServiceLanding(
  manifest: ServiceManifest,
  ctx: ServiceHostContext,
  sample: EmulatorInstanceInfo,
): string {
  const surfaces = manifest.surfaces
    .map(
      (s) =>
        `<tr><td>${escapeHtml(s.title)}</td><td><span class="badge">${escapeHtml(s.status)}</span></td><td><code>${escapeHtml(s.basePath ?? "")}</code></td></tr>`,
    )
    .join("");
  const createCurl = `curl -s -X POST ${ctx.protocol}//${ctx.service}.${ctx.hostSuffix}/_emulate/instances \\
  -H "content-type: application/json" \\
  -d '{"instance":"my-run"}'`;

  return renderCardPage(
    `${manifest.name} Emulator`,
    escapeHtml(manifest.description),
    `
      <div class="s-card">
        <div class="section-heading">Create an instance</div>
        <p class="info-text">Each instance is isolated, stateful, and addressable at its own host.</p>
        <pre class="code-block"><code>${escapeHtml(createCurl)}</code></pre>
        <p class="info-text">${escapeHtml(INSTANCE_NOTES)}</p>
        <p class="info-text">Sample instance host: <code>${escapeHtml(sample.providerBaseUrl)}</code></p>
      </div>
      <div class="s-card">
        <div class="section-heading">Surfaces</div>
        <table class="inspector-table">
          <thead><tr><th>Surface</th><th>Status</th><th>Path</th></tr></thead>
          <tbody>${surfaces}</tbody>
        </table>
      </div>
      <div class="s-card">
        <div class="section-heading">Control API</div>
        <p class="info-text">
          <a href="/_emulate/manifest">manifest</a> | <a href="/_emulate/quickstart">quickstart</a> |
          <a href="/_emulate/specs">specs</a> | <a href="/_emulate/coverage">coverage</a> |
          <a href="/_emulate/connections">connections</a>
        </p>
      </div>
    `,
    manifest.id,
  );
}

export interface ServiceCatalogEntry {
  id: string;
  name: string;
  description: string;
}

/**
 * Server-rendered catalog landing for the apex host. Readable by an agent over a
 * raw fetch (no JS): it lists every emulator with its host and manifest URL. The
 * interactive console SPA is served instead only for browser navigations.
 */
export function renderCatalogPage(
  entries: ServiceCatalogEntry[],
  ctx: { origin: string; protocol: string; hostSuffix: string },
): string {
  const rows = entries
    .map((e) => {
      const host = `${ctx.protocol}//${e.id}.${ctx.hostSuffix}`;
      return `<a class="app-link" href="${escapeHtml(host)}">
        <img src="/_emulate/icons/${escapeHtml(e.id)}" alt="" width="24" height="24" style="object-fit:contain" />
        <span><span class="app-link-name">${escapeHtml(e.name)}</span><span class="app-link-scopes">${escapeHtml(host)}</span></span>
      </a>`;
    })
    .join("");
  return renderCardPage(
    "Emulate",
    "Stateful integration emulators for real developer APIs. Each emulator has its own host; open one or fetch its manifest.",
    `
      <div class="s-card">
        <div class="section-heading">Emulators</div>
        ${rows}
      </div>
      <div class="s-card">
        <div class="section-heading">For agents</div>
        <p class="info-text">Machine-readable catalog: <a href="/_emulate/services">/_emulate/services</a></p>
        <p class="info-text">Each service host serves <code>/_emulate/manifest</code>, <code>/_emulate/quickstart</code>, and <code>/_emulate/connections</code>, and the provider API directly against a default instance.</p>
      </div>
    `,
  );
}

/** A machine-readable index of the services a host serves, with both URL forms. */
export function servicesCatalog(
  entries: ServiceCatalogEntry[],
  ctx: { origin: string; protocol: string; hostSuffix: string },
): Response {
  const services = entries.map((e) => ({
    id: e.id,
    name: e.name,
    description: e.description,
    icon: `${ctx.origin}/_emulate/icons/${e.id}`,
    serviceHost: `${ctx.protocol}//${e.id}.${ctx.hostSuffix}`,
    instanceHostPattern: `${ctx.protocol}//${e.id}.<instance>.${ctx.hostSuffix}`,
    pathForm: `${ctx.origin}/${e.id}/<instance>`,
    manifest: `${ctx.protocol}//${e.id}.${ctx.hostSuffix}/_emulate/manifest`,
  }));
  return new Response(JSON.stringify({ services }), {
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
