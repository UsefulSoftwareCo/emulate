import type { AppEnv, Hono, RouteContext, ServicePlugin, Store, TokenMap, WebhookDispatcher } from "@emulators/core";

import type {
  PolarAggregation,
  PolarFilter,
  PolarMetadata,
  PolarProduct,
  PolarStoredPrice,
  PolarSubscriptionStatus,
} from "./entities.js";
import { checkoutRoutes } from "./routes/checkout.js";
import { openapiRoutes } from "./routes/openapi.js";
import { polarApiRoutes } from "./routes/api.js";
import { portalRoutes } from "./routes/portal.js";
import { createSubscription, metadata, newUuid, productAmount, productCurrency } from "./serialize.js";
import { getPolarStore, type PolarStore } from "./store.js";

export { getPolarStore, type PolarStore } from "./store.js";
export * from "./entities.js";
export { manifest } from "./manifest.js";

export type PolarSeedPrice =
  | { amount_type: "fixed"; price_amount: number; price_currency?: string }
  | {
      amount_type: "metered_unit";
      meter_id: string;
      unit_amount: number | string;
      cap_amount?: number | null;
      price_currency?: string;
    }
  | {
      amount_type: "custom";
      minimum_amount?: number;
      maximum_amount?: number | null;
      preset_amount?: number | null;
      price_currency?: string;
    };

export interface PolarSeedConfig {
  meters?: Array<{
    name: string;
    filter: PolarFilter;
    aggregation: PolarAggregation;
    metadata?: PolarMetadata;
  }>;
  benefits?: Array<
    | {
        type: "meter_credit";
        description: string;
        meter: string;
        units: number;
        rollover?: boolean;
        metadata?: PolarMetadata;
      }
    | { type: "custom"; description: string; metadata?: PolarMetadata }
  >;
  products?: Array<{
    name: string;
    description?: string;
    recurring_interval?: "day" | "week" | "month" | "year";
    recurring_interval_count?: number;
    prices: PolarSeedPrice[];
    trial_interval?: "day" | "week" | "month" | "year";
    trial_interval_count?: number;
    benefits?: string[];
    metadata?: PolarMetadata;
  }>;
  customers?: Array<{
    external_id: string;
    email: string;
    name?: string;
    subscriptions?: Array<{ product: string; status?: Extract<PolarSubscriptionStatus, "active" | "trialing"> }>;
  }>;
  checkout?: { settle_delay_ms?: number | null };
}

function seedMeters(ps: PolarStore, meters: NonNullable<PolarSeedConfig["meters"]>): void {
  for (const meter of meters) {
    const values = {
      name: meter.name,
      unit: "scalar" as const,
      custom_label: null,
      custom_multiplier: null,
      filter: meter.filter,
      aggregation: meter.aggregation,
      metadata: metadata(meter.metadata),
      archived_at: null,
    };
    const existing = ps.meters.findOneBy("name", meter.name);
    if (existing) ps.meters.update(existing.id, values);
    else ps.meters.insert({ polar_id: newUuid(), ...values });
  }
}

function seedBenefits(ps: PolarStore, benefits: NonNullable<PolarSeedConfig["benefits"]>): void {
  for (const benefit of benefits) {
    const existing = ps.benefits.findOneBy("description", benefit.description);
    const values = {
      type: benefit.type,
      description: benefit.description,
      properties:
        benefit.type === "meter_credit"
          ? {
              meter_id:
                ps.meters.findOneBy("polar_id", benefit.meter)?.polar_id ??
                ps.meters.findOneBy("name", benefit.meter)?.polar_id ??
                benefit.meter,
              units: benefit.units,
              rollover: benefit.rollover ?? false,
            }
          : { note: null },
      metadata: metadata(benefit.metadata),
      visibility: "public" as const,
    };
    if (existing) ps.benefits.update(existing.id, values);
    else ps.benefits.insert({ polar_id: newUuid(), ...values });
  }
}

function seedPrice(ps: PolarStore, value: PolarSeedPrice): PolarStoredPrice {
  const common = { id: newUuid(), created_at: new Date().toISOString(), price_currency: value.price_currency ?? "usd" };
  if (value.amount_type === "fixed") return { ...common, amount_type: "fixed", price_amount: value.price_amount };
  if (value.amount_type === "metered_unit") {
    const meterId =
      ps.meters.findOneBy("polar_id", value.meter_id)?.polar_id ??
      ps.meters.findOneBy("name", value.meter_id)?.polar_id ??
      value.meter_id;
    return {
      ...common,
      amount_type: "metered_unit",
      meter_id: meterId,
      unit_amount: String(value.unit_amount),
      cap_amount: value.cap_amount ?? null,
    };
  }
  return {
    ...common,
    amount_type: "custom",
    minimum_amount: value.minimum_amount ?? 0,
    maximum_amount: value.maximum_amount ?? null,
    preset_amount: value.preset_amount ?? null,
  };
}

function productValues(ps: PolarStore, product: NonNullable<PolarSeedConfig["products"]>[number]) {
  return {
    name: product.name,
    description: product.description ?? null,
    recurring_interval: product.recurring_interval ?? "month",
    recurring_interval_count: product.recurring_interval_count ?? 1,
    meter_interval: null,
    meter_interval_count: null,
    trial_interval: product.trial_interval ?? null,
    trial_interval_count: product.trial_interval ? (product.trial_interval_count ?? 1) : null,
    prices: product.prices.map((price) => seedPrice(ps, price)),
    benefit_ids: (product.benefits ?? [])
      .map(
        (reference) =>
          ps.benefits.findOneBy("polar_id", reference)?.polar_id ??
          ps.benefits.findOneBy("description", reference)?.polar_id,
      )
      .filter((id): id is string => id !== undefined),
    metadata: metadata(product.metadata),
    visibility: "public" as const,
    is_archived: false,
  } satisfies Omit<PolarProduct, "id" | "created_at" | "updated_at" | "polar_id">;
}

function seedProducts(ps: PolarStore, products: NonNullable<PolarSeedConfig["products"]>): void {
  for (const product of products) {
    const values = productValues(ps, product);
    const existing = ps.products.findOneBy("name", product.name);
    if (existing) ps.products.update(existing.id, values);
    else ps.products.insert({ polar_id: newUuid(), ...values });
  }
}

function seedCustomers(ps: PolarStore, customers: NonNullable<PolarSeedConfig["customers"]>): void {
  for (const customer of customers) {
    const existing = ps.customers.findOneBy("external_id", customer.external_id);
    const values = {
      external_id: customer.external_id,
      email: customer.email,
      email_verified: false,
      type: "individual" as const,
      name: customer.name ?? null,
      billing_name: null,
      billing_address: null,
      tax_id: null,
      locale: null,
      metadata: {},
    };
    const saved = existing
      ? ps.customers.update(existing.id, values)!
      : ps.customers.insert({ polar_id: newUuid(), ...values });
    for (const seededSubscription of customer.subscriptions ?? []) {
      const product =
        ps.products.findOneBy("polar_id", seededSubscription.product) ??
        ps.products.findOneBy("name", seededSubscription.product);
      if (!product) continue;
      const subscription = ps.subscriptions
        .findBy("customer_id", saved.polar_id)
        .find((candidate) => candidate.product_id === product.polar_id && !candidate.pending);
      if (subscription) {
        ps.subscriptions.update(subscription.id, {
          status: seededSubscription.status ?? "active",
          amount: productAmount(product),
          currency: productCurrency(product),
        });
      } else {
        createSubscription(ps, saved, product, { status: seededSubscription.status ?? "active" });
      }
    }
  }
}

export function seedFromConfig(store: Store, _baseUrl: string, config: PolarSeedConfig): void {
  const ps = getPolarStore(store);
  if (config.meters) seedMeters(ps, config.meters);
  if (config.benefits) seedBenefits(ps, config.benefits);
  if (config.products) seedProducts(ps, config.products);
  if (config.customers) seedCustomers(ps, config.customers);
  if (config.checkout && Object.hasOwn(config.checkout, "settle_delay_ms")) {
    store.setData("polar.checkout.settle_delay_ms", config.checkout.settle_delay_ms ?? null);
  }
}

export const polarPlugin: ServicePlugin = {
  name: "polar",
  register(app: Hono<AppEnv>, store: Store, webhooks: WebhookDispatcher, baseUrl: string, tokenMap?: TokenMap): void {
    const ctx: RouteContext = { app, store, webhooks, baseUrl, tokenMap };
    polarApiRoutes(ctx);
    checkoutRoutes(ctx);
    portalRoutes(ctx);
    openapiRoutes(ctx);
  },
  seed(store: Store): void {
    store.setData("polar.checkout.settle_delay_ms", 2500);
  },
};

export default polarPlugin;
