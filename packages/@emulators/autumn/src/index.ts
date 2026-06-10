import type { Hono, Store, WebhookDispatcher, TokenMap, AppEnv, RouteContext, ServicePlugin } from "@emulators/core";

import { getAutumnStore, type AutumnStore } from "./store.js";
import { autumnApiRoutes } from "./routes/api.js";
import { manifest } from "./manifest.js";
import type { AutumnSubscription } from "./entities.js";

export { getAutumnStore, type AutumnStore } from "./store.js";
export * from "./entities.js";
export { manifest } from "./manifest.js";

export interface AutumnSeedConfig {
  customers?: Array<{
    id: string;
    name?: string;
    email?: string;
    subscriptions?: AutumnSubscription[];
  }>;
}

export function seedFromConfig(store: Store, _baseUrl: string, config: AutumnSeedConfig): void {
  const as = getAutumnStore(store);
  for (const customer of config.customers ?? []) {
    const existing = as.customers.findOneBy("customer_id", customer.id);
    if (existing) {
      as.customers.update(existing.id, {
        name: customer.name ?? existing.name,
        email: customer.email ?? existing.email,
        subscriptions: customer.subscriptions ?? existing.subscriptions,
      });
      continue;
    }
    as.customers.insert({
      customer_id: customer.id,
      name: customer.name ?? null,
      email: customer.email ?? null,
      subscriptions: customer.subscriptions ?? [],
    });
  }
}

export const autumnPlugin: ServicePlugin = {
  name: "autumn",
  register(
    app: Hono<AppEnv>,
    store: Store,
    webhooks: WebhookDispatcher,
    baseUrl: string,
    tokenMap?: TokenMap,
  ): void {
    const ctx: RouteContext = { app, store, webhooks, baseUrl, tokenMap };
    autumnApiRoutes(ctx);
  },
  seed(_store: Store, _baseUrl: string): void {
    // No default seed; customers are created on first get_or_create.
  },
};

export default autumnPlugin;
