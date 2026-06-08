import { EmulatorDurableObject } from "./durable-object.js";
import { consoleHtml } from "./console-html.js";

export { EmulatorDurableObject };

interface EmulatorNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(request: Request): Promise<Response> };
}
export interface Env {
  EMULATOR: EmulatorNamespace;
}

// Router: `/<service>/<instance>/<api-path>` → the DO named `<service>:<instance>`.
// The api-path is forwarded stripped (so the emulator's router matches plain
// `/repos/...`), while the public, prefixed base URL is passed via a header so
// the emulator builds correct absolute URLs in its responses. `/<svc>/<inst>`
// with no api-path hits the control plane (`/__seed`, `/__reset`) on the DO.
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const segments = url.pathname.replace(/^\/+/, "").split("/").filter((s) => s.length > 0);

    // Peel off a leading `.well-known/<type>` (RFC 8414 / RFC 9728 path-aware
    // metadata discovery: clients probe `/.well-known/<type>/<resource-path>`, the
    // well-known segment inserted at the ROOT with the resource's path appended).
    // What remains is the resource path, resolved the same as a normal request — so
    // the emulator's own `/.well-known/<type>` route answers with instance-prefixed
    // endpoints. Without this an MCP client's discovery 404s and falls back to
    // origin-root endpoints (hitting the console HTML).
    let wellKnownType: string | undefined;
    let resource = segments;
    if (segments[0] === ".well-known" && segments.length >= 2) {
      wellKnownType = segments[1];
      resource = segments.slice(2);
    }

    // `/<service>/<instance>/...`. When the instance segment is an MCP connection
    // type (`oauth`/`bearer`/`query`), it's a friendly preset that pins one shared
    // instance per type and selects the MCP auth mode by URL — so `/github/oauth/mcp`
    // is a zero-config OAuth MCP endpoint, no instance id and no seeding.
    const MCP_PRESETS = new Set(["oauth", "bearer", "query"]);
    const service = resource[0];
    const instance = resource[1];

    // `/` or a bare `/<service>` (no instance) → the human-facing console SPA
    // (HashRouter, so all in-app routes stay on path `/` server-side).
    if (!service || !instance) {
      return new Response(consoleHtml, { headers: { "content-type": "text/html; charset=utf-8" } });
    }

    const mcpMode = MCP_PRESETS.has(instance) ? instance : undefined;
    const baseUrl = `${url.origin}/${service}/${instance}`;
    const afterPrefix = resource.slice(2);
    const innerSegs = wellKnownType ? [".well-known", wellKnownType, ...afterPrefix] : afterPrefix;
    const innerPath = `/${innerSegs.join("/")}`;

    // Buffer the body so the forwarded request is self-contained: a live body
    // stream tied to the original request throws across the Worker→DO boundary
    // when a handler responds early without consuming it (e.g. the auth quirks).
    const headers = new Headers(request.headers);
    headers.set("x-emulator-service", service);
    headers.set("x-emulator-base-url", baseUrl);
    if (mcpMode) headers.set("x-emulator-mcp-mode", mcpMode);
    const hasBody = request.method !== "GET" && request.method !== "HEAD";
    const body = hasBody ? await request.arrayBuffer() : undefined;
    const inner = new Request(`${url.origin}${innerPath}${url.search}`, {
      method: request.method,
      headers,
      body,
      // Manual: the emulator's OAuth callbacks return 302s (e.g. → the app's
      // redirect_uri). Without this, the Worker→DO stub.fetch FOLLOWS the redirect
      // internally — and since it's a DO stub, the follow re-fetches the DO by the
      // Location's PATH, mangling it. Pass the 302 straight back to the browser.
      redirect: "manual",
    });

    const id = env.EMULATOR.idFromName(`${service}:${instance}`);
    return env.EMULATOR.get(id).fetch(inner);
  },
};
