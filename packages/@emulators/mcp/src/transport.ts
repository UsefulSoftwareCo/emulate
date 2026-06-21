import type { AuthUser, Context, Store } from "@emulators/core";
import { callTool, TOOL_DEFINITIONS, ToolError } from "./tools.js";

export const PROTOCOL_VERSION = "2025-06-18";
export const SERVER_NAME = "github-mcp (emulated)";
export const SERVER_VERSION = "0.6.0";

type JsonRpcId = string | number | null;

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  params?: Record<string, unknown>;
}

function rpcResult(id: JsonRpcId, result: unknown) {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id: JsonRpcId, code: number, message: string, data?: unknown) {
  return { jsonrpc: "2.0", id, error: { code, message, ...(data !== undefined ? { data } : {}) } };
}

// Dispatch a single JSON-RPC message. Returns the response object, or `null` for
// notifications (which get an empty 202/no body).
function handleMessage(store: Store, baseUrl: string, authUser: AuthUser, msg: JsonRpcRequest): unknown | null {
  const id = msg.id ?? null;
  const method = msg.method;

  switch (method) {
    case "initialize":
      return rpcResult(id, {
        protocolVersion: PROTOCOL_VERSION,
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        capabilities: { tools: { listChanged: false } },
      });

    case "notifications/initialized":
    case "notifications/cancelled":
      return null;

    case "ping":
      return rpcResult(id, {});

    case "tools/list":
      return rpcResult(id, { tools: TOOL_DEFINITIONS });

    case "tools/call": {
      const params = msg.params ?? {};
      const name = typeof params.name === "string" ? params.name : "";
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      try {
        const result = callTool(store, baseUrl, authUser, name, args);
        return rpcResult(id, {
          content: result.content ?? [{ type: "text", text: JSON.stringify(result.structured, null, 2) }],
          structuredContent: result.structured,
          isError: result.isError ?? false,
        });
      } catch (err) {
        if (err instanceof ToolError) {
          // Tool-level error: surface inside the result (isError), not a protocol error.
          return rpcResult(id, {
            content: [{ type: "text", text: err.message }],
            isError: true,
          });
        }
        throw err;
      }
    }

    default:
      if (id === null && typeof method === "string" && method.startsWith("notifications/")) return null;
      return rpcError(id, -32601, `Method not found: ${method ?? "<none>"}`);
  }
}

function sseResponse(body: unknown, c: Context): Response {
  const text = `event: message\ndata: ${JSON.stringify(body)}\n\n`;
  return c.body(text, 200, { "Content-Type": "text/event-stream; charset=utf-8" });
}

// Handle a streamable-HTTP `POST /mcp` request body (already authenticated).
export async function handleMcpPost(c: Context, store: Store, baseUrl: string, authUser: AuthUser): Promise<Response> {
  const accept = c.req.header("Accept") ?? "";
  const wantsSse = accept.includes("text/event-stream");

  let payload: unknown;
  try {
    payload = await c.req.json();
  } catch {
    const err = rpcError(null, -32700, "Parse error");
    return wantsSse ? sseResponse(err, c) : c.json(err, 200);
  }

  // Batch support: an array of messages.
  if (Array.isArray(payload)) {
    const responses = payload
      .map((m) => handleMessage(store, baseUrl, authUser, m as JsonRpcRequest))
      .filter((r): r is unknown => r !== null);
    if (responses.length === 0) return c.body(null, 202);
    return wantsSse ? sseResponse(responses, c) : c.json(responses, 200);
  }

  const response = handleMessage(store, baseUrl, authUser, payload as JsonRpcRequest);
  if (response === null) return c.body(null, 202);
  return wantsSse ? sseResponse(response, c) : c.json(response, 200);
}
