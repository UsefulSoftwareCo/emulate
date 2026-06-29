import type { RouteContext } from "@emulators/core";

import { getAutumnStore } from "../store.js";
import { ensureCustomer, serializeCustomer, serializePlan, activateSubscription } from "../serialize.js";

/** Autumn v1 RPC-style API (paths mirror autumn-js: /v1/<group>.<method>). */
export function autumnApiRoutes(ctx: RouteContext): void {
  const { app, store, baseUrl } = ctx;
  const as = () => getAutumnStore(store);

  app.post("/v1/customers.get_or_create", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const id = String(body.customer_id ?? body.customerId ?? body.id ?? "");
    if (!id) return c.json({ message: "customer_id is required", code: "invalid_request" }, 400);
    const data = (body.customer_data as Record<string, unknown> | undefined) ?? body;
    const customer = ensureCustomer(as(), id, data);
    return c.json(serializeCustomer(as(), customer));
  });

  app.post("/v1/customers.list", async (c) => {
    const store = as();
    const customers = store.customers.all().map((customer) => serializeCustomer(store, customer));
    return c.json({ list: customers, total: customers.length, offset: 0, limit: 100 });
  });

  app.post("/v1/customers.update", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const id = String(body.customer_id ?? body.customerId ?? body.id ?? "");
    const store = as();
    const customer = store.customers.findOneBy("customer_id", id);
    if (!customer) return c.json({ message: "Customer not found", code: "not_found" }, 404);
    const updated = store.customers.update(customer.id, {
      name: typeof body.name === "string" ? body.name : customer.name,
      email: typeof body.email === "string" ? body.email : customer.email,
    })!;
    return c.json(serializeCustomer(store, updated));
  });

  app.post("/v1/balances.track", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const customerId = String(body.customer_id ?? body.customerId ?? "");
    const featureId = String(body.feature_id ?? body.featureId ?? body.event_name ?? "");
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

  // The plan catalog, scoped to the calling customer. The backend handler
  // injects `customer_id` into every request, so eligibility is per-customer:
  // a card-required trial reads as "Start free trial" until it is attached.
  app.post("/v1/plans.list", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const customerId = String(body.customer_id ?? body.customerId ?? "");
    const store = as();
    const customer = customerId ? ensureCustomer(store, customerId, body) : undefined;
    const list = store.plans
      .all()
      .sort((a, b) => a.order - b.order)
      .map((plan) => serializePlan(store, customer, plan));
    return c.json({ list });
  });

  // Open a checkout for a paid plan or a card-required trial. Returns a
  // `payment_url` to the hosted checkout page; the subscription is NOT active
  // yet (it activates only when the checkout settles, like a Stripe webhook).
  app.post("/v1/billing.attach", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const customerId = String(body.customer_id ?? body.customerId ?? "");
    const planId = String(body.plan_id ?? body.product_id ?? body.planId ?? body.productId ?? "");
    const successUrl = String(body.success_url ?? body.successUrl ?? "");
    if (!customerId || !planId) {
      return c.json({ message: "customer_id and plan_id are required", code: "invalid_request" }, 400);
    }
    const store = as();
    const customer = ensureCustomer(store, customerId, body);
    const plan = store.plans.findOneBy("plan_id", planId);
    const requiresPayment = plan ? plan.price != null || plan.free_trial?.card_required === true : true;

    if (requiresPayment) {
      const session = store.checkouts.insert({
        session_id: "",
        customer_id: customerId,
        plan_id: planId,
        success_url: successUrl,
        status: "pending",
      });
      const sessionId = `cs_emulate_${session.id}`;
      store.checkouts.update(session.id, { session_id: sessionId });
      return c.json({
        customer_id: customerId,
        payment_url: `${baseUrl}/checkout/${sessionId}`,
        invoice: null,
        required_action: null,
      });
    }

    // Free or no-card plan: attach takes effect immediately, no redirect.
    if (plan) activateSubscription(store, customer, plan, { trial: false });
    return c.json({ customer_id: customerId, payment_url: null, invoice: null, required_action: null });
  });

  app.post("/v1/billing.open_customer_portal", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const customerId = String(body.customer_id ?? body.customerId ?? "");
    if (!customerId) return c.json({ message: "customer_id is required", code: "invalid_request" }, 400);
    ensureCustomer(as(), customerId, body);
    return c.json({ customer_id: customerId, url: `${baseUrl}/checkout/portal/${customerId}` });
  });

  app.post("/v1/features.list", async (c) => c.json({ list: [], total: 0, offset: 0, limit: 100 }));

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
