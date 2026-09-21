import type { Hono, Store, WebhookDispatcher, TokenMap, AppEnv, RouteContext, ServicePlugin } from "@emulators/core";

import { getAutumnStore, type AutumnStore } from "./store.js";
import { autumnApiRoutes } from "./routes/api.js";
import { checkoutRoutes } from "./routes/checkout.js";
import { portalRoutes } from "./routes/portal.js";
import { openapiRoutes } from "./routes/openapi.js";
import type { AutumnSubscription, AutumnFeature, AutumnPaymentMethod, AutumnPlan, AutumnPlanItem } from "./entities.js";

export { getAutumnStore, type AutumnStore } from "./store.js";
export * from "./entities.js";
export { manifest } from "./manifest.js";

/** A catalog feature, in the same snake_case shape the real API uses. An
 *  application that provisions its catalog through Autumn's own API can seed
 *  the emulator with the same identities it creates there. */
export interface AutumnSeedFeature {
  id: string;
  name?: string;
  /** `metered` (the default) | `boolean` | `credit_system`. */
  type?: string;
  consumable?: boolean;
  archived?: boolean;
}

export interface AutumnSeedPlan {
  id: string;
  name?: string;
  /** Catalog group. Plans in one group are mutually exclusive: attaching one
   *  replaces the customer's subscription to another plan in the same group. */
  group?: string | null;
  version?: number;
  archived?: boolean;
  add_on?: boolean;
  /** Attach this plan to every new customer that does not name one through
   *  `auto_enable_plan_id`. */
  auto_enable?: boolean;
  /** The plan's flat recurring price. A plan with no price has no billing
   *  cycle, which is what makes it the free tier of its group. */
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
  /** Feature catalog. Seeding features is optional: every feature a seeded
   *  plan item references is already part of the catalog. Seed them explicitly
   *  to control a feature's name, type, or consumable flag, or to declare a
   *  feature no plan carries yet. */
  features?: AutumnSeedFeature[];
  /** Plan catalog the emulator advertises via `plans.list` and attaches via
   *  `billing.attach`. In production these are synced from `autumn.config.ts`
   *  or provisioned through Autumn's own API; the emulator has no such sync,
   *  so the application under test seeds them. */
  plans?: AutumnSeedPlan[];
}

function seedFeatures(as: AutumnStore, features: AutumnSeedFeature[]): void {
  for (const feature of features) {
    const fields: Omit<AutumnFeature, "id" | "created_at" | "updated_at"> = {
      feature_id: feature.id,
      name: feature.name ?? feature.id,
      type: feature.type ?? "metered",
      consumable: feature.consumable ?? true,
      archived: feature.archived ?? false,
    };
    const existing = as.features.findOneBy("feature_id", feature.id);
    if (existing) as.features.update(existing.id, fields);
    else as.features.insert(fields);
  }
}

function seedPlans(as: AutumnStore, plans: AutumnSeedPlan[]): void {
  plans.forEach((plan, index) => {
    const existing = as.plans.findOneBy("plan_id", plan.id);
    const fields: Omit<AutumnPlan, "id" | "created_at" | "updated_at"> = {
      plan_id: plan.id,
      name: plan.name ?? plan.id,
      group: plan.group ?? null,
      version: plan.version ?? 1,
      archived: plan.archived ?? false,
      add_on: plan.add_on ?? false,
      auto_enable: plan.auto_enable ?? false,
      price: plan.price ?? null,
      free_trial: plan.free_trial ?? null,
      items: plan.items ?? [],
      // Keep a re-seeded plan in its catalog position so seeding twice cannot
      // silently turn an upgrade into a downgrade.
      order: existing?.order ?? index,
    };
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
  if (config.features) seedFeatures(as, config.features);
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
