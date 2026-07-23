import type { Store } from "@emulators/core";

export interface McpOAuthConfig {
  issuerOverride?: string;
  resourceOverride?: string;
  tokenEndpointAuthMethods?: string[] | "omit";
  dcrAuthMethodOverride?: string;
  rejectClientNameContaining?: string;
}

const DATA_KEY = "mcp.oauthConfig";

export function setMcpOAuthConfig(store: Store, raw: unknown): void {
  const cfg = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const tokenEndpointAuthMethods = Array.isArray(cfg.tokenEndpointAuthMethods)
    ? cfg.tokenEndpointAuthMethods.filter((method): method is string => typeof method === "string")
    : cfg.tokenEndpointAuthMethods === "omit"
      ? "omit"
      : undefined;

  store.setData<McpOAuthConfig>(DATA_KEY, {
    issuerOverride: typeof cfg.issuerOverride === "string" ? cfg.issuerOverride : undefined,
    resourceOverride: typeof cfg.resourceOverride === "string" ? cfg.resourceOverride : undefined,
    tokenEndpointAuthMethods,
    dcrAuthMethodOverride: typeof cfg.dcrAuthMethodOverride === "string" ? cfg.dcrAuthMethodOverride : undefined,
    rejectClientNameContaining:
      typeof cfg.rejectClientNameContaining === "string" ? cfg.rejectClientNameContaining : undefined,
  });
}

export function getMcpOAuthConfig(store: Store): McpOAuthConfig {
  return store.getData<McpOAuthConfig>(DATA_KEY) ?? {};
}
