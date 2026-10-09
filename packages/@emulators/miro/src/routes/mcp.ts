import type { AppEnv, Context, RouteContext } from "@emulators/core";
import { AUTHENTICATION_REQUIRED, SCOPES_SUPPORTED } from "../constants.js";
import type { MiroBoard, MiroOAuthToken } from "../entities.js";
import { getMiroStore, type MiroStore } from "../store.js";

type Ctx = Context<AppEnv>;
type JsonRpcId = string | number | null;

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  params?: Record<string, unknown>;
}

const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const SERVER_INFO = { name: "miro", version: "1.0.0" };

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, unknown>; required: string[] };
  annotations: { readOnlyHint: true };
}

// Two of the real read-only tools, by their published names
// (https://developers.miro.com/docs/miro-mcp-tools). Miro does not publish
// input schemas, so these are assumed and minimal.
export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: "board_search_boards",
    description: "Search and list the boards the current user can access.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", description: "Optional text matched against board names." } },
      required: [],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "canvas_search",
    description: "Find what is on a board: returns the items whose content matches the query, or every item.",
    inputSchema: {
      type: "object",
      properties: {
        board_id: { type: "string", description: "The board id, for example uXjVK1a2b3c=." },
        query: { type: "string", description: "Optional text matched against item content." },
      },
      required: ["board_id"],
    },
    annotations: { readOnlyHint: true },
  },
];

class ToolError extends Error {}

const matches = (text: string, query: unknown) =>
  typeof query !== "string" || query.length === 0 || text.toLowerCase().includes(query.toLowerCase());

const serializeBoard = (board: MiroBoard) => ({
  id: board.board_id,
  name: board.name,
  description: board.description,
  team: board.team,
  viewLink: `https://miro.com/app/board/${board.board_id}/`,
  itemCount: board.items.length,
});

function callTool(miro: MiroStore, name: string, args: Record<string, unknown>): unknown {
  switch (name) {
    case "board_search_boards":
      return {
        boards: miro.boards
          .all()
          .filter((b) => matches(b.name, args.query))
          .map(serializeBoard),
      };
    case "canvas_search": {
      const boardId = args.board_id;
      if (typeof boardId !== "string" || !boardId) throw new ToolError("Missing required argument: board_id");
      const board = miro.boards.findOneBy("board_id", boardId);
      if (!board) throw new ToolError(`Board not found: ${boardId}`);
      return { board: serializeBoard(board), items: board.items.filter((item) => matches(item.content, args.query)) };
    }
    default:
      throw new ToolError(`Unknown tool: ${name}`);
  }
}

const rpcResult = (id: JsonRpcId, result: unknown) => ({ jsonrpc: "2.0", id, result });
const rpcError = (id: JsonRpcId, code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });

function handleMessage(miro: MiroStore, msg: JsonRpcRequest): unknown | null {
  const id = msg.id ?? null;
  switch (msg.method) {
    case "initialize": {
      const requested = msg.params?.protocolVersion;
      const protocolVersion =
        typeof requested === "string" && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
          ? requested
          : SUPPORTED_PROTOCOL_VERSIONS[0];
      return rpcResult(id, {
        protocolVersion,
        serverInfo: SERVER_INFO,
        capabilities: { tools: { listChanged: false } },
      });
    }
    case "ping":
      return rpcResult(id, {});
    case "tools/list":
      return rpcResult(id, { tools: TOOL_DEFINITIONS });
    case "tools/call": {
      const name = typeof msg.params?.name === "string" ? msg.params.name : "";
      const args = (msg.params?.arguments ?? {}) as Record<string, unknown>;
      try {
        const structured = callTool(miro, name, args);
        return rpcResult(id, {
          content: [{ type: "text", text: JSON.stringify(structured, null, 2) }],
          structuredContent: structured,
          isError: false,
        });
      } catch (error) {
        if (error instanceof ToolError) {
          return rpcResult(id, { content: [{ type: "text", text: error.message }], isError: true });
        }
        throw error;
      }
    }
    default:
      if (typeof msg.method === "string" && msg.method.startsWith("notifications/")) return null;
      return rpcError(id, -32601, `Method not found: ${msg.method ?? "<none>"}`);
  }
}

function respond(c: Ctx, body: unknown): Response {
  const wantsSse = (c.req.header("Accept") ?? "").includes("text/event-stream");
  if (!wantsSse) return c.json(body);
  return c.body(`event: message\ndata: ${JSON.stringify(body)}\n\n`, 200, {
    "Content-Type": "text/event-stream; charset=utf-8",
  });
}

function activeToken(miro: MiroStore, authorization: string | undefined): MiroOAuthToken | undefined {
  const match = /^Bearer\s+(.+)$/i.exec(authorization ?? "");
  if (!match) return undefined;
  const token = miro.oauthTokens.findOneBy("access_token", match[1].trim());
  if (!token || token.revoked || token.expires_at < Date.now()) return undefined;
  return token;
}

/**
 * The MCP server lives at the origin root (`POST https://mcp.miro.com/`), and
 * the resource identifier is the origin with a trailing slash. Miro's
 * authentication gateway answers every request without a valid bearer token
 * with the same 401, including unknown paths such as
 * `/.well-known/oauth-protected-resource/` and `/.well-known/jwks.json`.
 */
export function registerMcpRoutes(ctx: RouteContext): void {
  const { app, store, baseUrl } = ctx;
  const resourceMetadataUrl = `${baseUrl}/.well-known/oauth-protected-resource`;

  // RFC 9728 metadata, as served by the real host.
  app.get("/.well-known/oauth-protected-resource", (c) => {
    c.set("operationId", "miro.mcp.protectedResourceMetadata");
    c.header("Cache-Control", "public, max-age=3600");
    return c.json({
      resource: `${baseUrl}/`,
      authorization_servers: [`${baseUrl}/`],
      scopes_supported: SCOPES_SUPPORTED,
      bearer_methods_supported: ["header"],
    });
  });

  const authenticationRequired = (c: Ctx) => {
    c.header("WWW-Authenticate", `Bearer resource_metadata="${resourceMetadataUrl}"`);
    return c.json(AUTHENTICATION_REQUIRED, 401);
  };

  const authenticate = (c: Ctx): MiroOAuthToken | undefined => {
    const token = activeToken(getMiroStore(store), c.req.header("Authorization"));
    if (token) c.set("authUser", { login: token.email, id: token.id, scopes: token.scope.split(" ") });
    return token;
  };

  app.post("/", async (c) => {
    c.set("operationId", "miro.mcp");
    if (!authenticate(c)) return authenticationRequired(c);
    const miro = getMiroStore(store);
    let payload: unknown;
    try {
      payload = await c.req.json();
    } catch {
      return respond(c, rpcError(null, -32700, "Parse error"));
    }
    if (Array.isArray(payload)) {
      const responses = payload
        .map((msg) => handleMessage(miro, msg as JsonRpcRequest))
        .filter((response) => response !== null);
      return responses.length === 0 ? c.body(null, 202) : respond(c, responses);
    }
    const response = handleMessage(miro, payload as JsonRpcRequest);
    return response === null ? c.body(null, 202) : respond(c, response);
  });

  app.get("/", (c) => {
    c.set("operationId", "miro.mcp");
    if (!authenticate(c)) return authenticationRequired(c);
    // Streamable HTTP lets a server decline the optional GET event stream.
    return c.json({ error: "method_not_allowed", message: "Use POST for JSON-RPC." }, 405);
  });

  // Registered last so every route above, and the /_emulate control plane
  // registered before plugins, still match first.
  for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
    app.on(method, "*", (c) => {
      c.set("operationId", "miro.gateway");
      if (!authenticate(c)) return authenticationRequired(c);
      return c.json({ error: "Not Found" }, 404);
    });
  }
}
