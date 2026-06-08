import type { AuthUser, Store, TokenMap } from "@emulators/core";

// How the `/mcp` endpoint authenticates a request.
//  - "oauth":  full MCP-OAuth (DCR + authorize + token) → access_token in tokenMap.
//  - "bearer": Authorization: Bearer <seeded-token>.
//  - "query":  ?token=<seeded-token> (or a configured query param name).
export type McpAuthMode = "oauth" | "bearer" | "query";

export interface McpAuthConfig {
  mode: McpAuthMode;
  queryParam: string;
}

const DATA_KEY = "mcp.authConfig";
const DEFAULT_QUERY_PARAM = "token";

export function setMcpAuthConfig(store: Store, raw: unknown): void {
  const cfg = (raw ?? {}) as { auth?: string; queryParam?: string };
  const mode: McpAuthMode = cfg.auth === "bearer" || cfg.auth === "query" ? cfg.auth : "oauth";
  store.setData<McpAuthConfig>(DATA_KEY, {
    mode,
    queryParam: typeof cfg.queryParam === "string" && cfg.queryParam.length > 0 ? cfg.queryParam : DEFAULT_QUERY_PARAM,
  });
}

export function getMcpAuthConfig(store: Store): McpAuthConfig {
  return store.getData<McpAuthConfig>(DATA_KEY) ?? { mode: "oauth", queryParam: DEFAULT_QUERY_PARAM };
}

export function extractBearer(authHeader: string | undefined): string | undefined {
  if (!authHeader) return undefined;
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  return token.length > 0 ? token : undefined;
}

// Resolve the request's token to a github-store identity using the shared
// tokenMap (seeded bearer tokens AND OAuth-issued access tokens both live there).
export function resolveAuthUser(tokenMap: TokenMap | undefined, token: string | undefined): AuthUser | undefined {
  if (!tokenMap || !token) return undefined;
  return tokenMap.get(token);
}
