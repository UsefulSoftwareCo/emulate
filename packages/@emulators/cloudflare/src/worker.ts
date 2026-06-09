import { buildInstanceCreation, renderCatalogPage, servicesCatalog } from "@emulators/core";
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

interface EmulatorNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(request: Request): Promise<Response> };
}
export interface Env {
  EMULATOR: EmulatorNamespace;
  EMULATE_HOST_SUFFIX?: string;
}

const DEFAULT_HOST_SUFFIX = "emulators.dev";
// The service host (e.g. github.emulators.dev) IS a usable, stateful instance.
// Named, isolated instances use the cert-safe path form emulators.dev/<svc>/<id>.
const DEFAULT_INSTANCE = "default";
const MCP_PRESETS = new Set(["oauth", "bearer", "query"]);

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
// - `<service>.<suffix>`            -> the service host == a default stateful instance.
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

    // SERVICE HOST: <service>.<suffix> with no instance label. The host itself is a
    // default, stateful instance, served same-origin over the valid 1-label cert.
    if (hostRoute?.service && !hostRoute.instance) {
      const service = hostRoute.service;
      const entry = SERVICES[service];

      // Create a NAMED, isolated instance. Returned in the cert-safe path form
      // (a 2-label instance subdomain has no Universal SSL certificate).
      if (url.pathname === "/_emulate/instances" && request.method === "POST") {
        const body = (await request.json().catch(() => ({}))) as { instance?: string };
        const instance = slug(body.instance ?? "") || `${service}-${randomId()}`;
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
      // server-rendered default-instance landing (no JS) or its JSON manifest.
      if (url.pathname === "/" || url.pathname === "") {
        if (isBrowserNavigation(request)) return html(consoleHtml);
        return forwardToDurableObject(env, request, {
          service,
          instance: DEFAULT_INSTANCE,
          baseUrl: `${url.protocol}//${service}.${suffix}`,
          innerPath: wantsJson(request) ? "/_emulate/manifest" : "/_emulate",
          search: "",
        });
      }

      // Everything else (provider API + /_emulate/*) → the default instance.
      return forwardToDurableObject(env, request, {
        service,
        instance: DEFAULT_INSTANCE,
        baseUrl: `${url.protocol}//${service}.${suffix}`,
        innerPath: url.pathname,
        search: url.search,
      });
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
      if (isBrowserNavigation(request)) return html(consoleHtml);
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

function randomId(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 8);
}

function slug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);
}
