import type { Hono, Store, WebhookDispatcher, TokenMap, AppEnv, RouteContext, ServicePlugin } from "@emulators/core";

import { getAutumnStore, type AutumnStore } from "./store.js";
import { autumnApiRoutes } from "./routes/api.js";
import { checkoutRoutes } from "./routes/checkout.js";
import { portalRoutes } from "./routes/portal.js";
import { openapiRoutes } from "./routes/openapi.js";
import type { AutumnSubscription, AutumnPaymentMethod, AutumnPlan, AutumnPlanItem } from "./entities.js";

export { getAutumnStore, type AutumnStore } from "./store.js";
export * from "./entities.js";
export { manifest } from "./manifest.js";

export interface AutumnSeedPlan {
  id: string;
  name?: string;
  add_on?: boolean;
  auto_enable?: boolean;
  price?: { amount: number; interval: string } | null;
  free_trial?: { duration_length: number; duration_type: string; card_required: boolean } | null;
  items?: AutumnPlanItem[];
}

export interface AutumnSeedConfig {
  customers?: Array<{
    id: string;
    name?: string;
    email?: string;
    subscriptions?: AutumnSubscription[];
    /** The card already on file for this customer. `id` is optional; the
     *  emulator mints a Stripe-style one when it is omitted. */
    payment_method?: Omit<AutumnPaymentMethod, "id"> & { id?: string };
  }>;
  /** Plan catalog the emulator advertises via `plans.list` and attaches via
   *  `billing.attach`. In production these are synced from `autumn.config.ts`;
   *  the emulator has no such sync, so the application under test seeds them. */
  plans?: AutumnSeedPlan[];
}

function seedPlans(as: AutumnStore, plans: AutumnSeedPlan[]): void {
  plans.forEach((plan, index) => {
    const fields: Omit<AutumnPlan, "id" | "created_at" | "updated_at"> = {
      plan_id: plan.id,
      name: plan.name ?? plan.id,
      add_on: plan.add_on ?? false,
      auto_enable: plan.auto_enable ?? false,
      price: plan.price ?? null,
      free_trial: plan.free_trial ?? null,
      items: plan.items ?? [],
      order: index,
    };
    const existing = as.plans.findOneBy("plan_id", plan.id);
    if (existing) {
      as.plans.update(existing.id, fields);
    } else {
      as.plans.insert(fields);
    }
  });
}

function seedPaymentMethod(
  seed: (Omit<AutumnPaymentMethod, "id"> & { id?: string }) | undefined,
  index: number,
): AutumnPaymentMethod | undefined {
  if (!seed) return undefined;
  return { id: seed.id ?? `pm_emulate_seed_${index}`, type: "card", card: seed.card };
}

export function seedFromConfig(store: Store, _baseUrl: string, config: AutumnSeedConfig): void {
  const as = getAutumnStore(store);
  if (config.plans) seedPlans(as, config.plans);
  (config.customers ?? []).forEach((customer, index) => {
    const paymentMethod = seedPaymentMethod(customer.payment_method, index + 1);
    const existing = as.customers.findOneBy("customer_id", customer.id);
    if (existing) {
      as.customers.update(existing.id, {
        name: customer.name ?? existing.name,
        email: customer.email ?? existing.email,
        subscriptions: customer.subscriptions ?? existing.subscriptions,
        payment_method: paymentMethod ?? existing.payment_method,
      });
      return;
    }
    as.customers.insert({
      customer_id: customer.id,
      name: customer.name ?? null,
      email: customer.email ?? null,
      subscriptions: customer.subscriptions ?? [],
      payment_method: paymentMethod,
    });
  });
}

export const autumnPlugin: ServicePlugin = {
  name: "autumn",
  register(app: Hono<AppEnv>, store: Store, webhooks: WebhookDispatcher, baseUrl: string, tokenMap?: TokenMap): void {
    const ctx: RouteContext = { app, store, webhooks, baseUrl, tokenMap };
    autumnApiRoutes(ctx);
    checkoutRoutes(ctx);
    portalRoutes(ctx);
    openapiRoutes(ctx);
  },
  seed(_store: Store, _baseUrl: string): void {
    // No default seed; customers are created on first get_or_create and the
    // plan catalog is seeded by the application under test.
  },
};

export default autumnPlugin;
