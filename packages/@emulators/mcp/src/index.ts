import type { Context, Hono } from "@emulators/core";
import type { AppEnv, RouteContext, ServicePlugin, Store, TokenMap, WebhookDispatcher } from "@emulators/core";
import { githubPlugin, seedFromConfig as githubSeed, type GitHubSeedConfig } from "@emulators/github";
import { extractBearer, getMcpAuthConfig, resolveAuthUser, setMcpAuthConfig } from "./auth.js";
import { registerOAuthRoutes } from "./oauth.js";
import { handleMcpPost } from "./transport.js";

export { TOOL_DEFINITIONS } from "./tools.js";
export { setMcpAuthConfig } from "./auth.js";
export type { McpAuthMode } from "./auth.js";

// The DO routes the per-service config block (`seed["mcp"]`) here, so the GitHub
// fixture data (users/repos/issues) lives ALONGSIDE the `auth` selector in this
// object. The shared bearer/query `tokens` stay top-level on the seed (the DO's
// token map owns those).
export interface McpSeedConfig extends GitHubSeedConfig {
  auth?: "oauth" | "bearer" | "query";
  queryParam?: string;
}

// Seed the MCP service. The GitHub store (users/repos/issues) is seeded via the
// github seeder so the MCP tools share state with the REST github emulator; the
// `auth`/`queryParam` fields select the auth mode.
export function seedFromConfig(store: Store, baseUrl: string, config: McpSeedConfig): void {
  setMcpAuthConfig(store, { auth: config.auth, queryParam: config.queryParam });
  githubSeed(store, baseUrl, config);
}

function unauthorized(c: Context<AppEnv>, baseUrl: string): Response {
  c.header("WWW-Authenticate", `Bearer realm="OAuth", resource_metadata="${baseUrl}/.well-known/oauth-protected-resource"`);
  return c.json(
    {
      error: "unauthorized",
      message: "Authentication required.",
      documentation_url: `${baseUrl}/.well-known/oauth-protected-resource`,
    },
    401,
  );
}

export const mcpPlugin: ServicePlugin = {
  name: "mcp",
  register(app: Hono<AppEnv>, store: Store, webhooks: WebhookDispatcher, baseUrl: string, tokenMap?: TokenMap): void {
    const ctx: RouteContext = { app, store, webhooks, baseUrl, tokenMap };

    // OAuth discovery + DCR + authorize + token (always public, all auth modes).
    registerOAuthRoutes(ctx);

    const authenticate = (c: Context<AppEnv>) => {
      const cfg = getMcpAuthConfig(store);
      if (cfg.mode === "query") {
        const token = c.req.query(cfg.queryParam);
        return resolveAuthUser(tokenMap, token ?? undefined);
      }
      // bearer + oauth both authenticate via Authorization: Bearer <token>.
      return resolveAuthUser(tokenMap, extractBearer(c.req.header("Authorization")));
    };

    app.post("/mcp", async (c) => {
      const authUser = authenticate(c);
      if (!authUser) {
        const cfg = getMcpAuthConfig(store);
        // OAuth mode must advertise resource metadata so the client can discover
        // the authorization server and start the DCR/PKCE flow.
        if (cfg.mode === "oauth") return unauthorized(c, baseUrl);
        return c.json({ message: "Requires authentication", documentation_url: `${baseUrl}/mcp` }, 401);
      }
      return handleMcpPost(c, store, baseUrl, authUser);
    });

    // GET /mcp is used by some clients to probe; respond with the same 401/auth
    // semantics (no SSE stream is offered for server→client notifications here).
    app.get("/mcp", (c) => {
      const authUser = authenticate(c);
      if (!authUser) {
        const cfg = getMcpAuthConfig(store);
        if (cfg.mode === "oauth") return unauthorized(c, baseUrl);
        return c.json({ message: "Requires authentication", documentation_url: `${baseUrl}/mcp` }, 401);
      }
      // Streamable HTTP allows a 405 when the server opts out of GET SSE streams.
      return c.json({ error: "method_not_allowed", message: "Use POST for JSON-RPC." }, 405);
    });
  },
  seed(store: Store, baseUrl: string): void {
    // Default seed: github defaults + oauth mode.
    setMcpAuthConfig(store, {});
    githubPlugin.seed?.(store, baseUrl);
  },
};

export default mcpPlugin;
