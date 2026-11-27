import type { Context, RouteContext, Store } from "@emulators/core";
import { recordSideEffect } from "@emulators/core";
import { callResult, decodeCursor, encodeCursor, findTool, toolCount, toolsSlice } from "./catalog.js";
import { MCP_PATH, protectedResourceMetadataUrl, resolveToken } from "./oauth.js";
import { getSettings, getZapierStore } from "./store.js";

/**
 * Zapier MCP's endpoint, Streamable HTTP only (Zapier documents no SSE
 * transport), serving both protocol eras on one URL:
 *   - modern, 2026-07-28: no handshake; every request carries its version in
 *     `_meta` and the MCP-Protocol-Version, Mcp-Method and Mcp-Name headers,
 *     which must agree with the body; `server/discover`; change notifications
 *     only on a `subscriptions/listen` stream;
 *   - legacy, 2025-06-18 and 2025-11-25: the `initialize` handshake, with no
 *     session minted (each request stands alone), and a GET stream for
 *     notifications when the emulator's list_changed switch is on.
 * The server keeps no state between requests beyond the stored instance
 * (accounts, tool lists, tokens): a sessionless client is the normal case.
 */
export const MODERN_VERSIONS = ["2026-07-28"];
export const LEGACY_VERSIONS = ["2025-11-25", "2025-06-18"];
export const SUPPORTED_VERSIONS = [...MODERN_VERSIONS, ...LEGACY_VERSIONS];
const SERVER_INFO = { name: "Zapier MCP (emulated)", version: "1.0.0" };
const KEEPALIVE_MS = 15000;

type Id = string | number | null;
interface Rpc {
  jsonrpc?: string;
  id?: Id;
  method?: string;
  params?: Record<string, unknown>;
}

const rpcResult = (id: Id, result: unknown) => ({ jsonrpc: "2.0", id, result });
const rpcError = (id: Id, code: number, message: string, data?: unknown) => ({
  jsonrpc: "2.0",
  id,
  error: { code, message, ...(data !== undefined ? { data } : {}) },
});

// ---------------------------------------------------------------------------
// Open notification streams, per instance and account (in memory: a stream is
// a live connection, and a hosted object stays loaded while one is open).

interface Sink {
  send(message: unknown): void;
}
const hubs = new WeakMap<Store, Map<string, Set<Sink>>>();
function hub(store: Store): Map<string, Set<Sink>> {
  let h = hubs.get(store);
  if (!h) hubs.set(store, (h = new Map()));
  return h;
}

/** Tell the account's open streams its list changed (only when the emulator switch is on). */
export function notifyListChanged(store: Store, email: string): number {
  if (!getSettings(store).list_changed) return 0;
  const sinks = hub(store).get(email);
  if (!sinks) return 0;
  for (const s of sinks) s.send({ jsonrpc: "2.0", method: "notifications/tools/list_changed", params: {} });
  return sinks.size;
}

function openStream(
  store: Store,
  email: string,
  first: unknown[],
  transform: (m: unknown) => unknown,
  end?: unknown,
): Response {
  const encoder = new TextEncoder();
  let sink: Sink | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const write = (m: unknown) =>
        controller.enqueue(encoder.encode(`event: message\ndata: ${JSON.stringify(m)}\n\n`));
      for (const m of first) write(m);
      if (end !== undefined) {
        write(end);
        controller.close();
        return;
      }
      sink = { send: (m) => write(transform(m)) };
      const set = hub(store).get(email) ?? new Set();
      set.add(sink);
      hub(store).set(email, set);
      timer = setInterval(() => controller.enqueue(encoder.encode(":\n\n")), KEEPALIVE_MS);
    },
    cancel() {
      if (timer) clearInterval(timer);
      if (sink) hub(store).get(email)?.delete(sink);
    },
  });
  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      "x-accel-buffering": "no",
    },
  });
}

// ---------------------------------------------------------------------------

function decodeHeader(v: string | undefined): string | undefined {
  if (v === undefined) return undefined;
  const m = /^=\?base64\?(.*)\?=$/.exec(v);
  return m ? Buffer.from(m[1]!, "base64").toString("utf8") : v;
}

function bearer(c: Context): string | null {
  const m = /^Bearer\s+(.+)$/i.exec(c.req.header("Authorization") ?? "");
  return m ? m[1]!.trim() : (c.req.query("token") ?? null);
}

function usage(store: Store, email: string, f: (u: { lists: number; calls: Record<string, number> }) => void): void {
  const all = store.getData<Record<string, { lists: number; calls: Record<string, number> }>>("zapier.usage") ?? {};
  const u = (all[email] ??= { lists: 0, calls: {} });
  f(u);
  store.setData("zapier.usage", all);
}

export function mcpRoutes({ app, store, baseUrl }: RouteContext): void {
  const zs = () => getZapierStore(store);
  const origin = new URL(baseUrl).origin;

  /** 401 with the resource metadata address, as Zapier answers. */
  const unauthorized = (c: Context) =>
    c.json(rpcError(null, -32001, "Unauthorized"), 401, {
      "WWW-Authenticate": `Bearer resource_metadata="${protectedResourceMetadataUrl(baseUrl)}"`,
    });

  function authenticate(c: Context): string | Response {
    const originHeader = c.req.header("Origin");
    if (originHeader && originHeader !== origin) return c.json(rpcError(null, -32600, "Forbidden origin"), 403);
    const value = bearer(c);
    const t = value ? resolveToken(store, value) : null;
    if (!t || !zs().accounts.findOneBy("email", t.email)) return unauthorized(c);
    const account = zs().accounts.findOneBy("email", t.email)!;
    c.set("authUser", { login: account.email, id: account.id, scopes: t.scope.split(" ") });
    return t.email;
  }

  /** The emulator's own per-account limit (not Zapier's): HTTP 429 with Retry-After. */
  function rateLimited(c: Context, email: string, id: Id): Response | null {
    const limit = getSettings(store).rate_limit;
    if (!limit) return null;
    const windows = zs().rateWindows;
    const now = Date.now();
    let w = windows.findOneBy("email", email);
    if (!w || w.reset_at_ms <= now || w.limit !== limit.requests) {
      if (w) windows.delete(w.id);
      w = windows.insert({ email, limit: limit.requests, used: 0, reset_at_ms: now + limit.window_seconds * 1000 });
    }
    if (w.used >= w.limit) {
      const retry = Math.max(1, Math.ceil((w.reset_at_ms - now) / 1000));
      return c.json(
        rpcError(id, -32000, "Rate limit exceeded (emulator control: Zapier documents no per-minute limit).", {
          retry_after_seconds: retry,
        }),
        429,
        { "Retry-After": String(retry) },
      );
    }
    windows.update(w.id, { used: w.used + 1 });
    return null;
  }

  function listTools(email: string, cursor: unknown): { result: Record<string, unknown> } | { error: unknown } {
    const spec = zs().toolSpecs.findOneBy("email", email);
    const version = spec?.version ?? 0;
    let offset = 0;
    if (cursor !== undefined && cursor !== null) {
      if (typeof cursor !== "string") return { error: { code: -32602, message: "Invalid cursor." } };
      const d = decodeCursor(store, email, version, cursor);
      if ("error" in d) return { error: { code: -32602, message: d.error } };
      offset = d.offset;
    }
    const total = toolCount(spec);
    const size = getSettings(store).page_size;
    const page = toolsSlice(spec, offset, size > 0 ? size : Number.MAX_SAFE_INTEGER);
    const next = size > 0 && offset + size < total ? encodeCursor(store, email, version, offset + size) : undefined;
    usage(store, email, (u) => (u.lists += 1));
    return {
      result: {
        tools: page,
        ...(next ? { nextCursor: next } : {}),
        _page: { offset, count: page.length, total },
      },
    };
  }

  async function callTool(
    email: string,
    params: Record<string, unknown>,
  ): Promise<{ result: unknown } | { error: unknown }> {
    const name = typeof params.name === "string" ? params.name : "";
    const spec = zs().toolSpecs.findOneBy("email", email);
    // Only the caller's own current list: another account's tool is unknown here.
    const tool = findTool(spec, name);
    if (!tool) return { error: { code: -32602, message: `Unknown tool: ${name}` } };
    const behavior = zs()
      .behaviors.findBy("email", email)
      .find((b) => b.tool === name);
    if (behavior?.delay_ms) await new Promise((r) => setTimeout(r, behavior.delay_ms));
    usage(store, email, (u) => (u.calls[name] = (u.calls[name] ?? 0) + 1));
    if (behavior?.fail === "protocol") return { error: { code: -32603, message: `Internal error running ${name}.` } };
    if (behavior?.fail === "tool") {
      return {
        result: {
          content: [{ type: "text", text: `${tool.title} failed: the app returned an error.` }],
          isError: true,
        },
      };
    }
    const args = (params.arguments && typeof params.arguments === "object" ? params.arguments : {}) as Record<
      string,
      unknown
    >;
    return { result: callResult(email, tool, args, behavior?.result_bytes ?? 0) };
  }

  app.post(MCP_PATH, async (c) => {
    const email = authenticate(c);
    if (email instanceof Response) return email;
    let msg: Rpc;
    try {
      msg = (await c.req.json()) as Rpc;
    } catch {
      return c.json(rpcError(null, -32700, "Parse error"), 400);
    }
    if (Array.isArray(msg)) return c.json(rpcError(null, -32600, "Batched requests are not supported."), 400);
    const id = msg.id ?? null;
    const method = typeof msg.method === "string" ? msg.method : "";
    const params = (msg.params ?? {}) as Record<string, unknown>;
    c.set("operationId", `zapier.mcp.${method || "unknown"}`);

    const limited = rateLimited(c, email, id);
    if (limited) return limited;

    const header = c.req.header("MCP-Protocol-Version");
    const meta = (params._meta ?? {}) as Record<string, unknown>;
    const bodyVersion = meta["io.modelcontextprotocol/protocolVersion"];
    const listChanged = getSettings(store).list_changed;

    // ---- legacy handshake era ----
    if (method === "initialize" || (header && LEGACY_VERSIONS.includes(header))) {
      if (msg.id === undefined) return c.body(null, 202); // notifications/initialized and others
      switch (method) {
        case "initialize": {
          const requested = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
          const version = LEGACY_VERSIONS.includes(requested) ? requested : LEGACY_VERSIONS[0]!;
          return c.json(
            rpcResult(id, {
              protocolVersion: version,
              capabilities: { tools: { listChanged } },
              serverInfo: SERVER_INFO,
            }),
          );
        }
        case "ping":
          return c.json(rpcResult(id, {}));
        case "tools/list": {
          const r = listTools(email, params.cursor);
          if ("error" in r) return c.json({ jsonrpc: "2.0", id, error: r.error });
          const { _page, ...result } = r.result as { _page: Record<string, number> };
          recordSideEffect(c, {
            type: "custom",
            collection: "zapier.tools",
            summary: `tools/list offset=${_page.offset} returned=${_page.count} total=${_page.total}`,
          });
          return c.json(rpcResult(id, result));
        }
        case "tools/call": {
          const r = await callTool(email, params);
          recordSideEffect(c, {
            type: "custom",
            collection: "zapier.tools",
            summary: `tools/call ${String(params.name)} -> ${"error" in r ? "error" : "result"}`,
          });
          return c.json("error" in r ? { jsonrpc: "2.0", id, error: r.error } : rpcResult(id, r.result));
        }
        default:
          return c.json(rpcError(id, -32601, `Method not found: ${method}`));
      }
    }

    // ---- modern era: version and headers must agree with the body ----
    if (!header) {
      return c.json(
        rpcError(id, -32022, "Unsupported protocol version", {
          supported: SUPPORTED_VERSIONS,
          requested: bodyVersion ?? "2025-03-26",
        }),
        400,
      );
    }
    if (!MODERN_VERSIONS.includes(header)) {
      return c.json(
        rpcError(id, -32022, "Unsupported protocol version", { supported: SUPPORTED_VERSIONS, requested: header }),
        400,
      );
    }
    if (bodyVersion !== header) {
      return c.json(
        rpcError(
          id,
          -32020,
          `Header mismatch: MCP-Protocol-Version '${header}' does not match body '${String(bodyVersion)}'`,
        ),
        400,
      );
    }
    if (c.req.header("Mcp-Method") !== method) {
      return c.json(
        rpcError(
          id,
          -32020,
          `Header mismatch: Mcp-Method header value '${c.req.header("Mcp-Method") ?? ""}' does not match body value '${method}'`,
        ),
        400,
      );
    }
    if (method === "tools/call" && decodeHeader(c.req.header("Mcp-Name")) !== params.name) {
      return c.json(
        rpcError(
          id,
          -32020,
          `Header mismatch: Mcp-Name header value '${c.req.header("Mcp-Name") ?? ""}' does not match body value '${String(params.name)}'`,
        ),
        400,
      );
    }
    if (typeof meta["io.modelcontextprotocol/clientCapabilities"] !== "object") {
      return c.json(
        rpcError(id, -32602, "Invalid params: _meta io.modelcontextprotocol/clientCapabilities is required."),
        400,
      );
    }
    if (msg.id === undefined) return c.body(null, 202);
    const modern = (result: Record<string, unknown>, cache = true) =>
      rpcResult(id, {
        resultType: "complete",
        ...result,
        ...(cache ? { ttlMs: 0, cacheScope: "private" } : {}),
        _meta: { "io.modelcontextprotocol/serverInfo": SERVER_INFO },
      });

    switch (method) {
      case "server/discover":
        return c.json(modern({ supportedVersions: SUPPORTED_VERSIONS, capabilities: { tools: { listChanged } } }));
      case "ping":
        return c.json(modern({}, false));
      case "tools/list": {
        const r = listTools(email, params.cursor);
        if ("error" in r) return c.json({ jsonrpc: "2.0", id, error: r.error });
        const { _page, ...result } = r.result as { _page: Record<string, number> };
        recordSideEffect(c, {
          type: "custom",
          collection: "zapier.tools",
          summary: `tools/list offset=${_page.offset} returned=${_page.count} total=${_page.total}`,
        });
        return c.json(modern(result));
      }
      case "tools/call": {
        const r = await callTool(email, params);
        recordSideEffect(c, {
          type: "custom",
          collection: "zapier.tools",
          summary: `tools/call ${String(params.name)} -> ${"error" in r ? "error" : "result"}`,
        });
        return c.json(
          "error" in r ? { jsonrpc: "2.0", id, error: r.error } : modern(r.result as Record<string, unknown>, false),
        );
      }
      case "subscriptions/listen": {
        const filter = (params.notifications ?? {}) as Record<string, unknown>;
        const honored = listChanged && filter.toolsListChanged === true;
        const subMeta = { "io.modelcontextprotocol/subscriptionId": id };
        const ack = {
          jsonrpc: "2.0",
          method: "notifications/subscriptions/acknowledged",
          params: { _meta: subMeta, notifications: honored ? { toolsListChanged: true } : {} },
        };
        // Nothing to deliver (Zapier announces no changes): acknowledge and end gracefully.
        const end = honored ? undefined : rpcResult(id, { resultType: "complete", _meta: subMeta });
        return openStream(
          store,
          email,
          [ack],
          (m) => {
            const n = m as { method: string; params?: Record<string, unknown> };
            return { ...n, params: { ...(n.params ?? {}), _meta: subMeta } };
          },
          end,
        );
      }
      default:
        return c.json(rpcError(id, -32601, `Method not found: ${method}`), 404);
    }
  });

  // Legacy-era standalone stream: only when the emulator's list_changed switch is on.
  app.get(MCP_PATH, (c) => {
    const email = authenticate(c);
    if (email instanceof Response) return email;
    c.set("operationId", "zapier.mcp.stream");
    if (!getSettings(store).list_changed || !(c.req.header("Accept") ?? "").includes("text/event-stream")) {
      return c.body(null, 405, { Allow: "POST" });
    }
    return openStream(store, email, [], (m) => m);
  });

  app.delete(MCP_PATH, (c) => c.body(null, 405, { Allow: "POST" }));
}
