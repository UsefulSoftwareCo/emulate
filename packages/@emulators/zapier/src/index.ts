import type { CredentialRequest, IssuedCredential, RouteContext, ServicePlugin, Store } from "@emulators/core";
import { controlRoutes, upsertAccount, type AccountInput } from "./control.js";
import { mcpRoutes } from "./mcp.js";
import { oauthRoutes, regenerateConnectionToken } from "./oauth.js";
import { getZapierStore, setSettings, type ZapierSettings } from "./store.js";

export { getZapierStore, type ZapierStore } from "./store.js";
export { generatedTool, currentTools } from "./catalog.js";
export { SUPPORTED_VERSIONS, MODERN_VERSIONS, LEGACY_VERSIONS } from "./mcp.js";
export { manifest } from "./manifest.js";

export interface ZapierSeedConfig {
  /** Accounts, each with its own tool list (generated from a seed and/or explicit tools) and tool behaviours. */
  accounts?: AccountInput[];
  /** list_changed and rate_limit are emulator controls, not Zapier behaviour. */
  settings?: Partial<ZapierSettings>;
}

export function seedFromConfig(store: Store, _baseUrl: string, config: ZapierSeedConfig): void {
  (config.accounts ?? []).forEach((a, i) => upsertAccount(store, a, `accounts[${i}]`));
  if (config.settings) setSettings(store, config.settings);
}

/** POST /_emulate/credentials: a connection token for an account (created if missing). */
export function issueCredential(store: Store, _baseUrl: string, request: CredentialRequest): IssuedCredential {
  const type = request.type ?? "bearer-token";
  if (type !== "bearer-token" && type !== "api-key")
    throw new Error(`Credential type ${type} is not supported by zapier`);
  const email = (
    typeof request.login === "string" && request.login.includes("@") ? request.login : "user@example.com"
  ).toLowerCase();
  if (!getZapierStore(store).accounts.findOneBy("email", email)) upsertAccount(store, { email });
  const t = regenerateConnectionToken(store, email);
  return {
    type: "bearer-token",
    token: t.access_token,
    login: email,
    scopes: [],
    notes: "A Zapier MCP connection token: send Authorization: Bearer <token> to <base>/api/v1/connect.",
  };
}

export const zapierPlugin: ServicePlugin = {
  name: "zapier",
  register(app, store, webhooks, baseUrl, tokenMap, ledger): void {
    const ctx: RouteContext = { app, store, webhooks, baseUrl, tokenMap, ledger };
    controlRoutes(ctx);
    oauthRoutes(ctx);
    mcpRoutes(ctx);
  },
  seed(store, baseUrl): void {
    seedFromConfig(store, baseUrl, {
      accounts: [{ email: "user@example.com", name: "Example User", tools: { count: 25 } }],
    });
  },
};

export default zapierPlugin;
