import type { Hono, Store, WebhookDispatcher, TokenMap, AppEnv, RouteContext, ServicePlugin } from "@emulators/core";

import { getWorkosStore, type WorkosStore } from "./store.js";
import { userManagementRoutes, ensureUserByEmail } from "./routes/user-management.js";
import { organizationRoutes } from "./routes/organizations.js";
import { apiKeyRoutes } from "./routes/api-keys.js";
import { vaultRoutes } from "./routes/vault.js";
import { oauthRoutes } from "./routes/oauth.js";
import { openapiRoutes } from "./routes/openapi.js";
import { workosId } from "./helpers.js";
import { manifest } from "./manifest.js";

export { getWorkosStore, type WorkosStore } from "./store.js";
export * from "./entities.js";
export { manifest } from "./manifest.js";

export interface WorkosSeedConfig {
  users?: Array<{ email: string; first_name?: string; last_name?: string }>;
  organizations?: Array<{ name: string; members?: string[] }>;
  /** OAuth-surface controls (emulate-only): set the default access-token TTL; null restores 3600. */
  oauth?: { default_access_token_ttl_seconds?: number | null };
}

export function seedFromConfig(store: Store, _baseUrl: string, config: WorkosSeedConfig): void {
  const ws = getWorkosStore(store);
  if (config.oauth !== undefined) {
    const ttl = config.oauth.default_access_token_ttl_seconds ?? null;
    const existing = ws.oauthSettings.all()[0];
    if (existing) ws.oauthSettings.update(existing.id, { default_access_token_ttl_seconds: ttl });
    else ws.oauthSettings.insert({ default_access_token_ttl_seconds: ttl });
  }
  for (const user of config.users ?? []) {
    const created = ensureUserByEmail(ws, user.email);
    if (user.first_name || user.last_name) {
      ws.users.update(created.id, {
        first_name: user.first_name ?? created.first_name,
        last_name: user.last_name ?? created.last_name,
      });
    }
  }
  for (const organization of config.organizations ?? []) {
    const org = ws.organizations.insert({
      workos_id: workosId("org"),
      name: organization.name,
      external_id: null,
    });
    for (const email of organization.members ?? []) {
      const member = ensureUserByEmail(ws, email);
      ws.memberships.insert({
        workos_id: workosId("om"),
        user_id: member.workos_id,
        organization_id: org.workos_id,
        status: "active",
        role_slug: "admin",
      });
    }
  }
}

export const workosPlugin: ServicePlugin = {
  name: "workos",
  register(app: Hono<AppEnv>, store: Store, webhooks: WebhookDispatcher, baseUrl: string, tokenMap?: TokenMap): void {
    const ctx: RouteContext = { app, store, webhooks, baseUrl, tokenMap };
    oauthRoutes(ctx);
    userManagementRoutes(ctx);
    organizationRoutes(ctx);
    apiKeyRoutes(ctx);
    vaultRoutes(ctx);
    openapiRoutes(ctx);
  },
  seed(_store: Store, _baseUrl: string): void {
    // No default seed — sign-in creates users on the fly.
  },
};

export default workosPlugin;
