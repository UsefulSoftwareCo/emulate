import type { RouteContext } from "@emulators/core";

import { getAutumnStore, type AutumnStore } from "../store.js";
import type { AutumnCustomer } from "../entities.js";

function serializeCustomer(customer: AutumnCustomer): Record<string, unknown> {
  return {
    id: customer.customer_id,
    created_at: Date.parse(customer.created_at),
    name: customer.name,
    email: customer.email,
    fingerprint: null,
    stripe_id: `cus_emulate_${customer.id}`,
    env: "sandbox",
    metadata: {},
    subscriptions: customer.subscriptions,
    products: [],
    features: {},
    invoices: [],
    purchases: [],
    balances: {},
    flags: {},
    billing_controls: {},
  };
}

function ensureCustomer(
  as: AutumnStore,
  id: string,
  data: { name?: unknown; email?: unknown },
): AutumnCustomer {
  const existing = as.customers.findOneBy("customer_id", id);
  if (existing) return existing;
  return as.customers.insert({
    customer_id: id,
    name: typeof data.name === "string" ? data.name : null,
    email: typeof data.email === "string" ? data.email : null,
    subscriptions: [],
  });
}

/** Autumn v1 RPC-style API (paths mirror autumn-js: /v1/<group>.<method>). */
export function autumnApiRoutes(ctx: RouteContext): void {
  const { app, store } = ctx;
  const as = () => getAutumnStore(store);

  app.post("/v1/customers.get_or_create", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const id = String(body.customer_id ?? body.id ?? "");
    if (!id) return c.json({ message: "customer_id is required", code: "invalid_request" }, 400);
    const data = (body.customer_data as Record<string, unknown> | undefined) ?? body;
    const customer = ensureCustomer(as(), id, data);
    return c.json(serializeCustomer(customer));
  });

  app.post("/v1/customers.list", async (c) => {
    const customers = as().customers.all().map(serializeCustomer);
    return c.json({ list: customers, total: customers.length, offset: 0, limit: 100 });
  });

  app.post("/v1/customers.update", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const id = String(body.customer_id ?? body.id ?? "");
    const customer = as().customers.findOneBy("customer_id", id);
    if (!customer) return c.json({ message: "Customer not found", code: "not_found" }, 404);
    const updated = as().customers.update(customer.id, {
      name: typeof body.name === "string" ? body.name : customer.name,
      email: typeof body.email === "string" ? body.email : customer.email,
    })!;
    return c.json(serializeCustomer(updated));
  });

  app.post("/v1/balances.track", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const customerId = String(body.customer_id ?? "");
    const featureId = String(body.feature_id ?? body.event_name ?? "");
    if (!customerId || !featureId) {
      return c.json({ message: "customer_id and feature_id are required", code: "invalid_request" }, 400);
    }
    ensureCustomer(as(), customerId, {});
    const event = as().events.insert({
      customer_id: customerId,
      feature_id: featureId,
      value: typeof body.value === "number" ? body.value : 1,
    });
    return c.json({
      id: `evt_emulate_${event.id}`,
      code: "event_received",
      customer_id: customerId,
      feature_id: featureId,
    });
  });

  app.post("/v1/plans.list", async (c) => c.json({ list: [], total: 0, offset: 0, limit: 100 }));
  app.post("/v1/features.list", async (c) =>
    c.json({ list: [], total: 0, offset: 0, limit: 100 }),
  );
  app.post("/v1/events.list", async (c) => {
    const events = as()
      .events.all()
      .map((event) => ({
        id: `evt_emulate_${event.id}`,
        customer_id: event.customer_id,
        feature_id: event.feature_id,
        value: event.value,
        timestamp: Date.parse(event.created_at),
      }));
    return c.json({ list: events, total: events.length, offset: 0, limit: 100 });
  });
}
