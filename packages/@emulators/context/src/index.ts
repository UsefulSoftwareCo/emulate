import type { Hono, Store, WebhookDispatcher, TokenMap, AppEnv, RouteContext, ServicePlugin } from "@emulators/core";

import { getContextStore, type ContextStore } from "./store.js";
import { brandRoutes } from "./routes/brand.js";
import { normalizeDomain } from "./helpers.js";
import type { ContextColor, ContextLogo } from "./entities.js";

export { getContextStore, type ContextStore } from "./store.js";
export * from "./entities.js";
export { manifest } from "./manifest.js";
export { domainFromEmail, isPersonalDomain, normalizeDomain } from "./helpers.js";

export interface ContextSeedBrand {
  domain: string;
  title?: string;
  description?: string;
  logos?: ContextLogo[];
  colors?: ContextColor[];
  /** Mark the profile as still enriching so the lookup answers `partial: true`. */
  partial?: boolean;
}

export interface ContextSeedConfig {
  brands?: ContextSeedBrand[];
}

export function seedFromConfig(store: Store, _baseUrl: string, config: ContextSeedConfig): void {
  const cs: ContextStore = getContextStore(store);
  for (const brand of config.brands ?? []) {
    const domain = normalizeDomain(brand.domain);
    const fields = {
      domain,
      title: brand.title ?? null,
      description: brand.description ?? null,
      logos: brand.logos ?? [],
      colors: brand.colors ?? [],
      partial: brand.partial ?? false,
    };
    const existing = cs.brands.findOneBy("domain", domain);
    if (existing) {
      cs.brands.update(existing.id, fields);
      continue;
    }
    cs.brands.insert(fields);
  }
}

export const contextPlugin: ServicePlugin = {
  name: "context",
  register(app: Hono<AppEnv>, store: Store, webhooks: WebhookDispatcher, baseUrl: string, tokenMap?: TokenMap): void {
    const ctx: RouteContext = { app, store, webhooks, baseUrl, tokenMap };
    brandRoutes(ctx);
  },
  seed(_store: Store, _baseUrl: string): void {
    // No default seed: an unseeded lookup must miss, which is what "we do not
    // recognize this company" means for the application under test.
  },
};

export default contextPlugin;
