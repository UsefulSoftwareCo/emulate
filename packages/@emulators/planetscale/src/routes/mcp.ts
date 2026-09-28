import type { AppEnv, Context, RouteContext } from "@emulators/core";
import { MCP_PATH } from "../constants.js";
import type {
  PlanetScaleBranch,
  PlanetScaleDatabase,
  PlanetScaleOAuthToken,
  PlanetScaleOrganization,
} from "../entities.js";
import { getPlanetScaleStore, type PlanetScaleStore } from "../store.js";

type Ctx = Context<AppEnv>;
type JsonRpcId = string | number | null;

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  params?: Record<string, unknown>;
}

const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const SERVER_INFO = { name: "planetscale", version: "1.0.0" };

const orgArg = { organization: { type: "string", description: "The organization name." } };
const dbArgs = { ...orgArg, database: { type: "string", description: "The database name." } };

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, unknown>; required: string[] };
  annotations: { readOnlyHint: true };
}

const tool = (name: string, description: string, properties: Record<string, unknown>): ToolDefinition => ({
  name,
  description,
  inputSchema: { type: "object", properties, required: Object.keys(properties) },
  annotations: { readOnlyHint: true },
});

// A read-only subset of the real server's tools, backed by seeded state.
export const TOOL_DEFINITIONS: ToolDefinition[] = [
  tool("planetscale_list_organizations", "List the organizations the authenticated user can access.", {}),
  tool("planetscale_get_organization", "Get one organization.", orgArg),
  tool("planetscale_list_databases", "List the databases in an organization.", orgArg),
  tool("planetscale_get_database", "Get one database.", dbArgs),
  tool("planetscale_list_branches", "List the branches of a database.", dbArgs),
];

const serializeOrganization = (org: PlanetScaleOrganization) => ({
  id: org.public_id,
  type: "Organization",
  name: org.name,
  plan: org.plan,
  created_at: org.created_at,
  updated_at: org.updated_at,
});

const serializeDatabase = (db: PlanetScaleDatabase) => ({
  id: db.public_id,
  type: "Database",
  name: db.name,
  kind: db.kind,
  state: db.state,
  region: { slug: db.region },
  default_branch: db.default_branch,
  html_url: `https://app.planetscale.com/${db.organization}/${db.name}`,
  created_at: db.created_at,
  updated_at: db.updated_at,
});

const serializeBranch = (branch: PlanetScaleBranch) => ({
  id: branch.public_id,
  type: "Branch",
  name: branch.name,
  production: branch.production,
  ready: true,
  parent_branch: branch.parent_branch,
  created_at: branch.created_at,
  updated_at: branch.updated_at,
});

class ToolError extends Error {}

function stringArg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.length === 0) throw new ToolError(`Missing required argument: ${key}`);
  return value;
}

function findOrganization(ps: PlanetScaleStore, args: Record<string, unknown>): PlanetScaleOrganization {
  const name = stringArg(args, "organization");
  const org = ps.organizations.findOneBy("name", name);
  if (!org) throw new ToolError(`Organization not found: ${name}`);
  return org;
}

function findDatabase(ps: PlanetScaleStore, args: Record<string, unknown>): PlanetScaleDatabase {
  const org = findOrganization(ps, args);
  const name = stringArg(args, "database");
  const db = ps.databases.findBy("organization", org.name).find((candidate) => candidate.name === name);
  if (!db) throw new ToolError(`Database not found: ${org.name}/${name}`);
  return db;
}

function callTool(ps: PlanetScaleStore, name: string, args: Record<string, unknown>): unknown {
  switch (name) {
    case "planetscale_list_organizations":
      return { data: ps.organizations.all().map(serializeOrganization) };
    case "planetscale_get_organization":
      return serializeOrganization(findOrganization(ps, args));
    case "planetscale_list_databases": {
      const org = findOrganization(ps, args);
      return { data: ps.databases.findBy("organization", org.name).map(serializeDatabase) };
    }
    case "planetscale_get_database":
      return serializeDatabase(findDatabase(ps, args));
    case "planetscale_list_branches": {
      const db = findDatabase(ps, args);
      return {
        data: ps.branches
          .findBy("database", db.name)
          .filter((branch) => branch.organization === db.organization)
          .map(serializeBranch),
      };
    }
    default:
      throw new ToolError(`Unknown tool: ${name}`);
  }
}

const rpcResult = (id: JsonRpcId, result: unknown) => ({ jsonrpc: "2.0", id, result });
const rpcError = (id: JsonRpcId, code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });

function handleMessage(ps: PlanetScaleStore, msg: JsonRpcRequest): unknown | null {
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
        const structured = callTool(ps, name, args);
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

function respond(c: Ctx, body: unknown, status: 200 | 401 = 200): Response {
  const wantsSse = (c.req.header("Accept") ?? "").includes("text/event-stream");
  if (!wantsSse || status !== 200) return c.json(body, status);
  return c.body(`event: message\ndata: ${JSON.stringify(body)}\n\n`, 200, {
    "Content-Type": "text/event-stream; charset=utf-8",
  });
}

function activeToken(ps: PlanetScaleStore, authorization: string | undefined): PlanetScaleOAuthToken | undefined {
  const match = /^Bearer\s+(.+)$/i.exec(authorization ?? "");
  if (!match) return undefined;
  const token = ps.oauthTokens.findOneBy("access_token", match[1].trim());
  if (!token || token.revoked || token.expires_at < Date.now()) return undefined;
  return token;
}

export function registerMcpRoutes(ctx: RouteContext): void {
  const { app, store, baseUrl } = ctx;
  const resourceMetadataUrl = `${baseUrl}/.well-known/oauth-protected-resource${MCP_PATH}`;

  // RFC 9728 metadata. The real document carries exactly these two fields.
  app.get(`/.well-known/oauth-protected-resource${MCP_PATH}`, (c) => {
    c.set("operationId", "planetscale.mcp.protectedResourceMetadata");
    return c.json({ resource: `${baseUrl}${MCP_PATH}`, authorization_servers: [baseUrl] });
  });

  const unauthorized = (c: Ctx, id: JsonRpcId) => {
    c.header("WWW-Authenticate", `Bearer resource_metadata="${resourceMetadataUrl}"`);
    return c.json({ error: { code: -32001, message: "unauthorized access" }, id, jsonrpc: "2.0" }, 401);
  };

  app.post(MCP_PATH, async (c) => {
    c.set("operationId", "planetscale.mcp");
    const ps = getPlanetScaleStore(store);
    let payload: unknown;
    try {
      payload = await c.req.json();
    } catch {
      payload = undefined;
    }
    const token = activeToken(ps, c.req.header("Authorization"));
    if (!token) {
      const id = payload && !Array.isArray(payload) ? ((payload as JsonRpcRequest).id ?? null) : null;
      return unauthorized(c, id);
    }
    c.set("authUser", { login: token.login, id: token.id, scopes: token.scope.split(" ") });
    if (payload === undefined) return respond(c, rpcError(null, -32700, "Parse error"));
    if (Array.isArray(payload)) {
      const responses = payload
        .map((msg) => handleMessage(ps, msg as JsonRpcRequest))
        .filter((response) => response !== null);
      return responses.length === 0 ? c.body(null, 202) : respond(c, responses);
    }
    const response = handleMessage(ps, payload as JsonRpcRequest);
    return response === null ? c.body(null, 202) : respond(c, response);
  });

  app.get(MCP_PATH, (c) => {
    c.set("operationId", "planetscale.mcp");
    const token = activeToken(getPlanetScaleStore(store), c.req.header("Authorization"));
    if (!token) return unauthorized(c, null);
    // Streamable HTTP lets a server decline the optional GET event stream.
    return c.json({ error: "method_not_allowed", message: "Use POST for JSON-RPC." }, 405);
  });
}
