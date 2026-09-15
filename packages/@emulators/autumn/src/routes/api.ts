import type { RouteContext } from "@emulators/core";

import { getAutumnStore } from "../store.js";
import {
  ensureCustomer,
  serializeCustomer,
  serializePlan,
  activateSubscription,
  balanceForFeature,
} from "../serialize.js";

/** Autumn's `expand` request param: an array of field names, and (for hand-rolled
 *  HTTP callers) a comma-separated string. Anything else expands nothing. */
function parseExpand(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string");
  if (typeof value === "string") {
    return value
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean);
  }
  return [];
}

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
    return c.json(serializeCustomer(as(), customer, { expand: parseExpand(body.expand) }));
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

  // Feature access check, shaped after autumn-js's CheckResponse schema
  // (allowed, customer_id, entity_id, required_balance, balance, flag).
  // `allowed` is computed from the same balance state customers.get_or_create
  // serializes: unlimited features and overage-allowed features always pass,
  // metered features pass while `remaining` covers the required balance.
  // A feature the customer's plan does not carry gets a permissive
  // `allowed: true` with a null balance. The SDK types leave this case
  // ambiguous (CheckResponse.balance is nullable either way), so the emulator
  // deliberately fails open: an unseeded feature should not block every
  // request in the application under test. Seed a plan item with included: 0
  // to model a feature that denies access.
  app.post("/v1/balances.check", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const customerId = String(body.customer_id ?? body.customerId ?? "");
    const featureId = String(body.feature_id ?? body.featureId ?? "");
    if (!customerId || !featureId) {
      return c.json({ message: "customer_id and feature_id are required", code: "invalid_request" }, 400);
    }
    const requiredBalance = typeof body.required_balance === "number" ? body.required_balance : 1;
    const entityId = typeof body.entity_id === "string" ? body.entity_id : null;
    const store = as();
    // Real Autumn auto-creates unknown customers on check (the SDK's own
    // backend flow relies on get_or_create semantics), so mirror that here.
    const customer = ensureCustomer(store, customerId, body);
    const balance = balanceForFeature(store, customer, featureId);
    const allowed =
      balance === undefined || balance.unlimited || balance.overage_allowed || balance.remaining >= requiredBalance;
    return c.json({
      allowed,
      customer_id: customerId,
      entity_id: entityId,
      required_balance: requiredBalance,
      balance: balance ?? null,
      flag: null,
    });
  });

  // Set a customer's balance for one feature, shaped after autumn-js's
  // balances.update (UpdateBalanceParams in, `{ success }` out). Exactly one
  // of `usage`, `remaining`, or `add_to_balance` must be provided. Usage is
  // event-sourced (see serialize.ts usageFor), so the update lands as an
  // adjustment event rather than mutating a stored counter: events.list shows
  // the reconciliation and balances.check can never disagree with it.
  // Entity-scoped balances, reset intervals, balance ids, and grant updates
  // (included_grant) are unsupported. Unknown customers 404 with Autumn's
  // real customer_not_found code; unlike track/check, update is a
  // non-creating endpoint upstream, so the emulator mirrors that.
  app.post("/v1/balances.update", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const customerId = String(body.customer_id ?? body.customerId ?? "");
    const featureId = String(body.feature_id ?? body.featureId ?? "");
    if (!customerId || !featureId) {
      return c.json({ message: "customer_id and feature_id are required", code: "invalid_request" }, 400);
    }
    const store = as();
    const customer = store.customers.findOneBy("customer_id", customerId);
    if (!customer) {
      return c.json({ message: `Customer ${customerId} not found`, code: "customer_not_found" }, 404);
    }
    const balance = balanceForFeature(store, customer, featureId);
    if (!balance) {
      return c.json(
        { message: `Customer ${customerId} has no balance for feature ${featureId}`, code: "not_found" },
        404,
      );
    }
    const usage = typeof body.usage === "number" ? body.usage : undefined;
    const remaining = typeof body.remaining === "number" ? body.remaining : undefined;
    const addToBalance = typeof body.add_to_balance === "number" ? body.add_to_balance : undefined;
    const provided = [usage, remaining, addToBalance].filter((v) => v !== undefined);
    if (provided.length !== 1) {
      return c.json(
        { message: "exactly one of usage, remaining, or add_to_balance is required", code: "invalid_request" },
        400,
      );
    }
    if (remaining !== undefined && balance.unlimited) {
      return c.json({ message: "remaining cannot be set on an unlimited balance", code: "invalid_request" }, 400);
    }
    const targetUsage =
      usage !== undefined
        ? usage
        : remaining !== undefined
          ? balance.granted - remaining
          : balance.usage - (addToBalance ?? 0);
    const delta = targetUsage - balance.usage;
    if (delta !== 0) {
      store.events.insert({ customer_id: customerId, feature_id: featureId, value: delta });
    }
    return c.json({ success: true });
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

  // Open a Stripe Checkout session in `mode: "setup"` so the customer can
  // replace the card on file. Like the real flow, the returned `url` is a
  // hosted page; completing it redirects back to `success_url`, but the
  // default payment method only changes when the asynchronous
  // `checkout.session.completed` webhook is processed (see /checkout/setup).
  app.post("/v1/billing.setup_payment", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const customerId = String(body.customer_id ?? body.customerId ?? "");
    if (!customerId) return c.json({ message: "customer_id is required", code: "invalid_request" }, 400);
    const entityId = typeof body.entity_id === "string" ? body.entity_id : undefined;
    const successUrl = String(body.success_url ?? body.successUrl ?? "");
    const store = as();
    ensureCustomer(store, customerId, body);
    const session = store.setups.insert({
      session_id: "",
      customer_id: customerId,
      success_url: successUrl,
      status: "pending",
    });
    const sessionId = `seti_emulate_${session.id}`;
    store.setups.update(session.id, { session_id: sessionId });
    return c.json({
      customer_id: customerId,
      ...(entityId ? { entity_id: entityId } : {}),
      url: `${baseUrl}/checkout/setup/${sessionId}`,
    });
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
