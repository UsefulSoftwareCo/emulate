import {
  buildInstanceCreation,
  randomInstanceName,
  renderCatalogPage,
  serviceHostControlPlane,
  servicesCatalog,
} from "@emulators/core";
import { EmulatorDurableObject } from "./durable-object.js";
import { SERVICES } from "./services.js";
import { SERVICE_ICONS } from "./icons.js";
import { consoleHtml } from "./console-html.js";

export { EmulatorDurableObject };

function serviceCatalogEntries() {
  return Object.entries(SERVICES).map(([id, entry]) => ({
    id,
    name: entry.manifest.name,
    description: entry.manifest.description,
  }));
}

// The catalog is a static registry, so inline it into the served SPA HTML: the
// console renders the grid on first paint, with no client fetch and no loading
// state. JSON `<` is escaped so a description can never break out of the script.
async function serveCatalogConsole(ctx: { origin: string; protocol: string; hostSuffix: string }): Promise<Response> {
  const json = (await servicesCatalog(serviceCatalogEntries(), ctx).text()).replace(/</g, "\\u003c");
  return html(
    consoleHtml.replace(
      '<div id="root"></div>',
      `<script>window.__EMULATE_SERVICES__=${json}</script><div id="root"></div>`,
    ),
  );
}

interface EmulatorNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(request: Request): Promise<Response> };
}
export interface Env {
  EMULATOR: EmulatorNamespace;
  EMULATE_HOST_SUFFIX?: string;
}

const DEFAULT_HOST_SUFFIX = "emulators.dev";
// The instance segment selects the MCP surface's auth/scope preset:
//  - oauth | bearer | query: how `/mcp` authenticates.
//  - scope-discovery: oauth, but the protected-resource metadata stays silent on
//    scopes so a discovering client must fall back to the authorization-server
//    metadata (RFC 8414) — the scenario that exercises MCP OAuth scope discovery.
const MCP_PRESETS = new Set(["oauth", "bearer", "query", "scope-discovery"]);

const html = (body: string): Response =>
  new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } });

// Browsers send Sec-Fetch-Mode: navigate on a top-level navigation. Agents and
// raw fetches (curl, server-side fetch) do not, so they get the server-rendered,
// no-JS response instead of the interactive SPA.
const isBrowserNavigation = (request: Request): boolean => request.headers.get("sec-fetch-mode") === "navigate";
const wantsJson = (request: Request): boolean => {
  const a = request.headers.get("accept") ?? "";
  return a.includes("application/json") && !a.includes("text/html");
};

async function forwardToDurableObject(
  env: Env,
  request: Request,
  opts: { service: string; instance: string; baseUrl: string; innerPath: string; search: string; mcpMode?: string },
): Promise<Response> {
  const origin = new URL(request.url).origin;
  const headers = new Headers(request.headers);
  headers.set("x-emulator-service", opts.service);
  headers.set("x-emulator-instance", opts.instance);
  headers.set("x-emulator-base-url", opts.baseUrl);
  if (opts.mcpMode) headers.set("x-emulator-mcp-mode", opts.mcpMode);
  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  const body = hasBody ? await request.arrayBuffer() : undefined;
  // Manual redirect: the emulator's OAuth callbacks return 302s (e.g. → the app's
  // redirect_uri). Without this, the Worker→DO stub.fetch FOLLOWS the redirect
  // internally and re-fetches the DO by the Location path, mangling it.
  const inner = new Request(`${origin}${opts.innerPath}${opts.search}`, {
    method: request.method,
    headers,
    body,
    redirect: "manual",
  });
  const id = env.EMULATOR.idFromName(`${opts.service}:${opts.instance}`);
  return env.EMULATOR.get(id).fetch(inner);
}

// Router:
// - `<service>.<suffix>`            -> the service-level control plane (no shared instance).
// - `<service>.<instance>.<suffix>` -> a named instance host (requires a 2-label cert).
// - `/<service>/<instance>/...`     -> the cert-safe path form (named instances, local dev).
// - apex / bare `/<service>`        -> the catalog (SPA for browsers, server-rendered for agents).
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const suffix = env.EMULATE_HOST_SUFFIX ?? DEFAULT_HOST_SUFFIX;
    const segments = url.pathname
      .replace(/^\/+/, "")
      .split("/")
      .filter((s) => s.length > 0);
    const hostRoute = parseHostRoute(url.hostname, suffix);
    const apexOrigin = hostRoute ? `${url.protocol}//${suffix}` : url.origin;

    // Official provider brand icons, served from any host (falls back to a
    // monogram client-side if missing).
    if (url.pathname.startsWith("/_emulate/icons/") && (request.method === "GET" || request.method === "HEAD")) {
      const id = url.pathname.slice("/_emulate/icons/".length).replace(/\.svg$/, "");
      const svg = SERVICE_ICONS[id];
      if (!svg) return new Response("not found", { status: 404 });
      return new Response(svg, {
        headers: { "content-type": "image/svg+xml; charset=utf-8", "cache-control": "public, max-age=86400" },
      });
    }

    // Machine-readable catalog of every service this host serves (any host).
    if (url.pathname === "/_emulate/services" && (request.method === "GET" || request.method === "HEAD")) {
      return servicesCatalog(serviceCatalogEntries(), {
        origin: apexOrigin,
        protocol: url.protocol,
        hostSuffix: suffix,
      });
    }

    // SERVICE HOST: <service>.<suffix> with no instance label. Control plane
    // only — there is deliberately NO shared default instance behind it. A
    // well-known host with world-readable state and a world-writable control
    // plane is exactly the polling target the unguessable instance names exist
    // to prevent, so provider traffic requires an instance of your own.
    if (hostRoute?.service && !hostRoute.instance) {
      const service = hostRoute.service;
      const entry = SERVICES[service];

      // Create a NAMED, isolated instance. Returned in the cert-safe path form
      // (a 2-label instance subdomain has no Universal SSL certificate). A
      // caller-supplied name only prefixes the generated one: the instance URL
      // is the sole access control, so it must never be guessable.
      if (url.pathname === "/_emulate/instances" && request.method === "POST") {
        const body = (await request.json().catch(() => ({}))) as { instance?: string };
        const instance = randomInstanceName(body.instance);
        return Response.json(
          buildInstanceCreation({
            service,
            instance,
            providerBaseUrl: `${apexOrigin}/${service}/${instance}`,
            pathOrigin: apexOrigin,
            hostSuffix: suffix,
          }),
        );
      }

      if (!entry) return html(consoleHtml);

      // Root: browsers get the interactive console; agents/raw fetches get the
      // server-rendered service landing (no JS) or the service-level manifest.
      if (url.pathname === "/" || url.pathname === "") {
        if (isBrowserNavigation(request)) return html(consoleHtml);
        const landing = serviceHostControlPlane(wantsJson(request) ? "/_emulate/manifest" : "/_emulate", "GET", {
          manifest: entry.manifest,
          service,
          origin: apexOrigin,
          protocol: url.protocol,
          hostSuffix: suffix,
          ledgerPersistent: true,
        });
        if (landing) return landing;
      }

      // Service-level control plane (manifest, quickstart, specs, coverage,
      // connections, openapi) — answerable without any instance.
      const controlPlane = serviceHostControlPlane(url.pathname, request.method, {
        manifest: entry.manifest,
        service,
        origin: apexOrigin,
        protocol: url.protocol,
        hostSuffix: suffix,
        ledgerPersistent: true,
      });
      if (controlPlane) return controlPlane;

      // Browsers exploring other paths still get the console SPA.
      if (isBrowserNavigation(request)) return html(consoleHtml);

      // Provider routes have no shared instance to serve: point the caller at
      // instance creation instead.
      return Response.json(
        {
          error: "instance_required",
          message: `${service}.${suffix} is a service host with no shared instance. Create one with POST ${url.protocol}//${service}.${suffix}/_emulate/instances and use the returned providerBaseUrl.`,
          createInstance: `${url.protocol}//${service}.${suffix}/_emulate/instances`,
        },
        { status: 404 },
      );
    }

    // NAMED INSTANCE HOST: <service>.<instance>.<suffix> (needs a 2-label cert).
    if (hostRoute?.service && hostRoute.instance) {
      return forwardToDurableObject(env, request, {
        service: hostRoute.service,
        instance: hostRoute.instance,
        baseUrl: url.origin,
        innerPath: url.pathname,
        search: url.search,
      });
    }

    // PATH FORM (apex/local): `/<service>/<instance>/...`. Peel a leading
    // `.well-known/<type>` (RFC 8414 / 9728 path-aware metadata discovery: clients
    // probe `/.well-known/<type>/<resource-path>`) so the resolved resource is
    // instance-prefixed and the emulator answers with instance-scoped endpoints.
    let wellKnownType: string | undefined;
    let resource = segments;
    if (segments[0] === ".well-known" && segments.length >= 2) {
      wellKnownType = segments[1];
      resource = segments.slice(2);
    }

    const service = resource[0];
    const instance = resource[1];

    // Apex root or bare `/<service>` → the catalog. Browser → SPA; agent → a
    // server-rendered list of emulators (readable without running JS).
    if (!service || !instance) {
      if (isBrowserNavigation(request))
        return serveCatalogConsole({ origin: apexOrigin, protocol: url.protocol, hostSuffix: suffix });
      if (wantsJson(request)) {
        return servicesCatalog(serviceCatalogEntries(), {
          origin: apexOrigin,
          protocol: url.protocol,
          hostSuffix: suffix,
        });
      }
      return html(
        renderCatalogPage(serviceCatalogEntries(), { origin: apexOrigin, protocol: url.protocol, hostSuffix: suffix }),
      );
    }

    // `/github/oauth/mcp` etc.: the instance segment is the MCP connection type.
    const mcpMode = MCP_PRESETS.has(instance) ? instance : undefined;
    const afterPrefix = resource.slice(2);
    const innerSegs = wellKnownType ? [".well-known", wellKnownType, ...afterPrefix] : afterPrefix;
    return forwardToDurableObject(env, request, {
      service,
      instance,
      baseUrl: `${url.origin}/${service}/${instance}`,
      innerPath: `/${innerSegs.join("/")}`,
      search: url.search,
      mcpMode,
    });
  },
};

export function parseHostRoute(
  hostname: string,
  suffix: string,
): { service: string; instance?: string; suffix: string } | null {
  const normalizedHost = hostname.toLowerCase();
  const normalizedSuffix = suffix.toLowerCase();
  if (!normalizedHost.endsWith(`.${normalizedSuffix}`)) return null;
  const prefix = normalizedHost.slice(0, -(normalizedSuffix.length + 1));
  const labels = prefix.split(".").filter(Boolean);
  if (labels.length === 1) return { service: labels[0], suffix: normalizedSuffix };
  if (labels.length < 2) return null;
  return { service: labels[0], instance: labels[1], suffix: normalizedSuffix };
}
