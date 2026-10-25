import type { RouteContext } from "@emulators/core";

import { getAutumnStore } from "../store.js";
import {
  ensureCustomer,
  serializeCustomer,
  serializeFeature,
  serializePlan,
  activateSubscription,
  attachPlan,
  applyCancelAction,
  balanceForFeature,
  checkAndConsume,
  compactUsage,
  hasBillingCycle,
  knownFeature,
  billedPlan,
  type CancelAction,
} from "../serialize.js";
import type { AutumnCustomer, AutumnCustomize, AutumnPlan, AutumnSubscription } from "../entities.js";
import type { AutumnStore } from "../store.js";

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

const CANCEL_ACTIONS = new Set(["cancel_immediately", "cancel_end_of_cycle", "uncancel"]);

/** A subscription that bills now. Autumn reports a running trial as active;
 *  the emulator marks it `trialing`. */
const isLive = (sub: AutumnSubscription) => sub.status === "active" || sub.status === "trialing";

type Refusal = { status: 400 | 404 | 409; message: string; code: string };

/** What an attach with `remove_plan_ids` does: the new plan takes over the
 *  Stripe subscription of the first paid plan it removes, keeping its billing
 *  period and, unless the attach removes it, its trial. With
 *  `proration_behavior: "none"` nothing is charged now. A cancellation at the
 *  end of the cycle does not carry over: the new plan renews. Plans scheduled to
 *  follow stay scheduled. Returns null when the attach takes over no paid
 *  subscription or prorates, which this emulator routes through checkout. */
function replacement(
  store: AutumnStore,
  customer: AutumnCustomer,
  plan: AutumnPlan,
  body: Record<string, unknown>,
): Refusal | { next: AutumnSubscription[]; sub: AutumnSubscription; removed: AutumnSubscription[] } | null {
  const removeIds = body.remove_plan_ids;
  if (!Array.isArray(removeIds) || removeIds.length === 0) return null;
  const subs = customer.subscriptions ?? [];
  if (subs.some((sub) => isLive(sub) && sub.plan_id === plan.plan_id)) {
    return {
      status: 409,
      message: `Cannot attach because the customer's current product '${plan.name}' is the same as the product being attached`,
      code: "plan_already_attached",
    };
  }
  const removed: AutumnSubscription[] = [];
  for (const id of removeIds) {
    const sub = subs.find((candidate) => isLive(candidate) && candidate.plan_id === id);
    if (!sub) {
      return {
        status: 404,
        message: `No active plan '${String(id)}' found on the customer to remove`,
        code: "product_not_found",
      };
    }
    removed.push(sub);
  }
  const taken = removed.find((sub) => sub.stripe_subscription_id);
  if (!taken || body.proration_behavior !== "none") return null;
  const customize = (body.customize ?? {}) as Record<string, unknown>;
  const removesTrial =
    ("free_trial" in customize && customize.free_trial === null) || ("free_trial" in body && body.free_trial === null);
  const now = Date.now();
  const trialing = taken.status === "trialing" || (taken.trial_ends_at ?? 0) > now;
  if (trialing && removesTrial) {
    return {
      status: 400,
      message: "Cannot set proration_behavior to 'none' when removing a free trial",
      code: "invalid_request",
    };
  }
  const override: AutumnCustomize = {
    ...("price" in customize ? { price: (customize.price as AutumnCustomize["price"]) ?? null } : {}),
    ...(Array.isArray(customize.items) ? { items: customize.items as AutumnCustomize["items"] } : {}),
  };
  const sub: AutumnSubscription = {
    id: `sub_emulate_${customer.id}_${plan.plan_id}`,
    plan_id: plan.plan_id,
    status: trialing ? "trialing" : "active",
    started_at: now,
    current_period_start: taken.current_period_start ?? null,
    current_period_end: taken.current_period_end ?? null,
    trial_ends_at: trialing ? (taken.trial_ends_at ?? null) : null,
    canceled_at: null,
    expires_at: null,
    quantity: 1,
    usage_epoch: store.events.all().reduce((max, event) => Math.max(max, event.id), 0),
    stripe_subscription_id: taken.stripe_subscription_id,
    ...(typeof body.version === "number" ? { version: body.version } : {}),
    ...(Object.keys(override).length > 0 ? { customize: override } : {}),
  };
  const next = [...subs.filter((existing) => !removed.includes(existing)), sub];
  return { next, sub, removed };
}

function refuse(c: { json: (body: unknown, status: number) => Response }, refusal: Refusal) {
  return c.json({ message: refusal.message, code: refusal.code }, refusal.status);
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
    const store = as();
    // `auto_enable_plan_id` names the plan a NEW customer starts on, replacing
    // the catalog's own auto-enabled defaults. Autumn resolves the plan before
    // it touches the customer, so an unknown id is a 404 even when the customer
    // already exists, and an existing customer is never re-subscribed.
    const autoEnablePlanId = body.auto_enable_plan_id ?? body.autoEnablePlanId;
    let plan;
    if (typeof autoEnablePlanId === "string" && autoEnablePlanId !== "") {
      plan = store.plans.findOneBy("plan_id", autoEnablePlanId);
      if (!plan) {
        return c.json({ message: `Product ${autoEnablePlanId} not found`, code: "product_not_found" }, 404);
      }
    }
    const existing = store.customers.findOneBy("customer_id", id);
    let customer;
    if (existing) {
      customer = existing;
    } else if (plan) {
      customer = store.customers.insert({
        customer_id: id,
        name: typeof data.name === "string" ? data.name : null,
        email: typeof data.email === "string" ? data.email : null,
        subscriptions: [],
      });
      customer = attachPlan(store, customer, plan, { trial: false });
    } else {
      customer = ensureCustomer(store, id, data);
    }
    return c.json(serializeCustomer(store, customer, { expand: parseExpand(body.expand) }));
  });

  // Read-only: unlike get_or_create, an unknown customer is a 404 and nothing is created.
  app.post("/v1/customers.get", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const id = String(body.customer_id ?? body.customerId ?? "");
    if (!id) return c.json({ message: "customer_id is required", code: "invalid_request" }, 400);
    const store = as();
    const customer = store.customers.findOneBy("customer_id", id);
    if (!customer) {
      return c.json({ message: `Customer ${id} not found`, code: "customer_not_found" }, 404);
    }
    return c.json(serializeCustomer(store, customer, { expand: parseExpand(body.expand) }));
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
    // `new_customer_id` gives the customer a new id. Its Stripe customer,
    // subscriptions and usage stay; an id another customer has is refused.
    const newId = body.new_customer_id ?? body.newCustomerId;
    if (typeof newId === "string" && newId !== "" && newId !== id) {
      if (store.customers.findOneBy("customer_id", newId)) {
        return c.json(
          {
            message: `Customer with ID ${newId} already exists, can't change to this ID`,
            code: "customer_already_exists",
          },
          409,
        );
      }
      for (const collection of [store.events, store.checkouts, store.setups, store.portals] as const) {
        for (const row of collection.findBy("customer_id", id)) {
          (collection as typeof store.events).update(row.id, { customer_id: newId });
        }
      }
    }
    const updated = store.customers.update(customer.id, {
      name: typeof body.name === "string" ? body.name : customer.name,
      email: typeof body.email === "string" ? body.email : customer.email,
      ...(typeof newId === "string" && newId !== "" ? { customer_id: newId } : {}),
    })!;
    return c.json(serializeCustomer(store, updated));
  });

  // Delete a customer. Its Stripe customer is left alone unless
  // `delete_in_stripe`, which the emulator has no Stripe to apply to.
  app.post("/v1/customers.delete", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const id = String(body.customer_id ?? body.customerId ?? "");
    const store = as();
    const customer = store.customers.findOneBy("customer_id", id);
    if (!customer) return c.json({ message: `Customer ${id} not found`, code: "customer_not_found" }, 404);
    store.customers.delete(customer.id);
    return c.json({ success: true });
  });

  // Compare each paid plan's Stripe subscription with Autumn's record. The
  // emulator's Stripe is its own record, so every subscription is correct.
  app.post("/v1/billing.verify", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const id = String(body.customer_id ?? body.customerId ?? "");
    const store = as();
    const customer = store.customers.findOneBy("customer_id", id);
    if (!customer) return c.json({ message: `Customer ${id} not found`, code: "customer_not_found" }, 404);
    const ids = Array.from(
      new Set(
        (customer.subscriptions ?? [])
          .filter((sub) => isLive(sub) && sub.stripe_subscription_id)
          .map((sub) => sub.stripe_subscription_id as string),
      ),
    );
    return c.json({
      customer_id: id,
      customer_mismatches: [],
      subscriptions: ids.map((stripeId) => ({ stripe_subscription_id: stripeId, status: "correct", mismatches: [] })),
    });
  });

  // What an attach would charge and change, changing nothing.
  app.post("/v1/billing.preview_attach", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const customerId = String(body.customer_id ?? body.customerId ?? "");
    const planId = String(body.plan_id ?? body.planId ?? "");
    const store = as();
    const plan = store.plans.findOneBy("plan_id", planId);
    if (!plan) return c.json({ message: `Product ${planId} not found`, code: "product_not_found" }, 404);
    const customer = store.customers.findOneBy("customer_id", customerId);
    if (!customer) return c.json({ message: `Customer ${customerId} not found`, code: "customer_not_found" }, 404);
    const change = replacement(store, customer, plan, body);
    if (change && "status" in change) return refuse(c, change);
    if (change) {
      const billed = billedPlan(store, change.sub);
      return c.json({
        customer_id: customerId,
        line_items: [],
        subtotal: 0,
        total: 0,
        currency: "usd",
        next_cycle: change.sub.current_period_end
          ? {
              starts_at: change.sub.current_period_end,
              subtotal: billed.price?.amount ?? 0,
              total: billed.price?.amount ?? 0,
              line_items: [],
            }
          : null,
        incoming: [
          { plan_id: plan.plan_id, feature_quantities: [], effective_at: null, canceled_at: null, expires_at: null },
        ],
        outgoing: change.removed.map((sub) => ({
          plan_id: sub.plan_id,
          feature_quantities: [],
          effective_at: Date.now(),
          canceled_at: sub.canceled_at ?? null,
          expires_at: sub.expires_at ?? null,
        })),
        redirect_to_checkout: false,
        checkout_type: null,
      });
    }
    const requiresPayment = plan.price != null || plan.free_trial?.card_required === true;
    const outgoing = (customer.subscriptions ?? []).filter((sub) => {
      const other = store.plans.findOneBy("plan_id", sub.plan_id);
      return isLive(sub) && !plan.add_on && !other?.add_on && (other?.group ?? null) === plan.group;
    });
    return c.json({
      customer_id: customerId,
      line_items: [],
      subtotal: plan.price?.amount ?? 0,
      total: plan.price?.amount ?? 0,
      currency: "usd",
      next_cycle: null,
      incoming: [
        { plan_id: plan.plan_id, feature_quantities: [], effective_at: null, canceled_at: null, expires_at: null },
      ],
      outgoing: outgoing.map((sub) => ({
        plan_id: sub.plan_id,
        feature_quantities: [],
        effective_at: Date.now(),
        canceled_at: sub.canceled_at ?? null,
        expires_at: sub.expires_at ?? null,
      })),
      redirect_to_checkout: requiresPayment,
      checkout_type: requiresPayment ? "stripe_checkout" : null,
    });
  });

  app.post("/v1/balances.track", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const customerId = String(body.customer_id ?? body.customerId ?? "");
    const featureId = String(body.feature_id ?? body.featureId ?? body.event_name ?? "");
    if (!customerId || !featureId) {
      return c.json({ message: "customer_id and feature_id are required", code: "invalid_request" }, 400);
    }
    const customer = ensureCustomer(as(), customerId, {});
    const event = as().events.insert({
      customer_id: customerId,
      feature_id: featureId,
      value: typeof body.value === "number" ? body.value : 1,
    });
    compactUsage(as(), customer, featureId);
    return c.json({
      id: `evt_emulate_${event.id}`,
      code: "event_received",
      customer_id: customerId,
      feature_id: featureId,
    });
  });

  // Feature access check, shaped after the real v1 response at api-version
  // 2.3.0 (allowed, customer_id, required_balance, balance, flag).
  //
  // Three outcomes, matching real Autumn:
  //   - the feature is not in the catalog at all: 404 feature_not_found, so a
  //     typo surfaces as a typo instead of silently passing;
  //   - the feature exists but no active subscription grants it: allowed false
  //     with a null balance;
  //   - otherwise the balance decides, and `send_event` consumes in the
  //     same call.
  //
  // With `send_event: true` the check and the consumption are one step. Autumn
  // deducts exactly `required_balance` and deducts nothing when the check is
  // denied, so a rejected caller never loses a unit and two concurrent callers
  // cannot both spend the last one. See `checkAndConsume` for why the
  // read-decide-write sequence must stay synchronous.
  app.post("/v1/balances.check", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const customerId = String(body.customer_id ?? body.customerId ?? "");
    const featureId = String(body.feature_id ?? body.featureId ?? "");
    if (!customerId || !featureId) {
      return c.json({ message: "customer_id and feature_id are required", code: "invalid_request" }, 400);
    }
    const requiredBalance = typeof body.required_balance === "number" ? body.required_balance : 1;
    const sendEvent = body.send_event === true || body.sendEvent === true;
    const entityId = typeof body.entity_id === "string" ? body.entity_id : undefined;
    const store = as();
    if (!knownFeature(store, featureId)) {
      return c.json({ message: `Feature ${featureId} not found`, code: "feature_not_found" }, 404);
    }
    // Real Autumn auto-creates unknown customers on check (the SDK's own
    // backend flow relies on get_or_create semantics), so mirror that here.
    const customer = ensureCustomer(store, customerId, body);
    const outcome = checkAndConsume(store, customer, featureId, requiredBalance, sendEvent);
    return c.json({
      allowed: outcome.allowed,
      customer_id: customerId,
      ...(entityId === undefined ? {} : { entity_id: entityId }),
      required_balance: requiredBalance,
      balance: outcome.balance,
      flag: null,
    });
  });

  // Set a customer's balance for one feature, shaped after autumn-js's
  // balances.update (UpdateBalanceParams in, `{ success }` out). Exactly one
  // of `usage`, `remaining`, or `add_to_balance` must be provided. Usage is
  // event-sourced (see serialize.ts), so the update lands as an adjustment
  // event rather than mutating a stored counter: events.list shows the
  // reconciliation and balances.check can never disagree with it.
  // Entity-scoped balances, balance ids, and grant updates (included_grant)
  // are unsupported. Unknown customers 404 with Autumn's real
  // customer_not_found code; unlike track/check, update is a non-creating
  // endpoint upstream, so the emulator mirrors that.
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
      compactUsage(store, customer, featureId);
    }
    return c.json({ success: true });
  });

  // The plan catalog, scoped to the calling customer. The backend handler
  // injects `customer_id` into every request, so eligibility is per-customer:
  // a card-required trial reads as "Start free trial" until it is attached.
  // A `customer_id` the emulator has never seen does not create a customer
  // here; real Autumn answers the catalog without eligibility instead.
  app.post("/v1/plans.list", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const customerId = String(body.customer_id ?? body.customerId ?? "");
    const store = as();
    const customer = customerId ? store.customers.findOneBy("customer_id", customerId) : undefined;
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
    const plan = store.plans.findOneBy("plan_id", planId);
    if (!plan) return c.json({ message: `Product ${planId} not found`, code: "product_not_found" }, 404);
    const customer = ensureCustomer(store, customerId, body);
    const change = replacement(store, customer, plan, body);
    if (change && "status" in change) return refuse(c, change);
    if (change) {
      store.customers.update(customer.id, { subscriptions: change.next });
      return c.json({ customer_id: customerId, payment_url: null });
    }
    const requiresPayment = plan.price != null || plan.free_trial?.card_required === true;

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
    activateSubscription(store, customer, plan, { trial: false });
    return c.json({ customer_id: customerId, payment_url: null, invoice: null, required_action: null });
  });

  // Change an existing subscription. Autumn identifies a subscription by
  // (customer, plan), so cancelling is an update carrying a `cancel_action`
  // rather than its own endpoint. `plan_id` narrows the action to one
  // subscription; omitting it applies to every live subscription.
  //
  // `cancel_immediately` ends the subscription now, so the customer's next read
  // shows neither the subscription nor its balances. `cancel_end_of_cycle`
  // keeps it active and records when it expires; Autumn rejects it for a plan
  // with no billing cycle, which the emulator mirrors. `uncancel` clears a
  // scheduled cancellation.
  //
  // Only `cancel_action` is modelled. The other update parameters
  // (feature_quantities, version, customize, discounts, billing_cycle_anchor,
  // recalculate_balances) are not supported and report Autumn's own 400.
  app.post("/v1/billing.update", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const customerId = String(body.customer_id ?? body.customerId ?? "");
    if (!customerId) {
      return c.json({ message: "customer_id: must be a string (received undefined)", code: "invalid_inputs" }, 400);
    }
    const rawPlanId = body.plan_id ?? body.planId;
    const planId = typeof rawPlanId === "string" && rawPlanId !== "" ? rawPlanId : undefined;
    const rawAction = body.cancel_action ?? body.cancelAction;
    if (typeof rawAction !== "string" || !CANCEL_ACTIONS.has(rawAction)) {
      return c.json(
        {
          message:
            "input: At least one update parameter must be provided (feature_quantities, version, customize, cancel_action, recalculate_balances, billing_cycle_anchor, discounts, or custom_line_items)",
          code: "invalid_inputs",
        },
        400,
      );
    }
    const action = rawAction as CancelAction;
    const store = as();
    const customer = store.customers.findOneBy("customer_id", customerId);
    if (!customer) {
      return c.json({ message: `Customer ${customerId} not found`, code: "customer_not_found" }, 404);
    }
    if (action === "cancel_end_of_cycle") {
      const targeted = (customer.subscriptions ?? []).filter((sub) => planId === undefined || sub.plan_id === planId);
      // A plan that bills nothing has no cycle to cancel at the end of.
      const billable = (planId: string) => {
        const candidate = store.plans.findOneBy("plan_id", planId);
        return candidate !== undefined && hasBillingCycle(candidate);
      };
      if (targeted.length > 0 && !targeted.some((sub) => billable(sub.plan_id))) {
        return c.json(
          {
            message: "Free products do not have billing cycles; use cancel: 'immediately' instead.",
            code: "invalid_request",
          },
          400,
        );
      }
    }
    const outcome = applyCancelAction(store, customer, action, planId);
    if (outcome.planIds.length === 0 && planId !== undefined) {
      return c.json(
        {
          message: `No active subscription found for plan '${planId}' on customer '${customerId}'`,
          code: "cus_product_not_found",
        },
        404,
      );
    }
    return c.json({ customer_id: customerId, payment_url: null });
  });

  // Open a Stripe Checkout session in `mode: "setup"` so the customer can
  // replace the card on file. Like the real flow, the returned `url` is a
  // hosted page; completing it redirects back to `success_url`, but the
  // default payment method only changes when the asynchronous
  // `checkout.session.completed` webhook is processed (see /checkout/setup).
  app.post("/v1/billing.setup_payment", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const customerId = String(body.customer_id ?? body.customerId ?? "");
    if (!customerId) {
      // Real Autumn's validation error for a missing/invalid field.
      return c.json({ message: "customer_id: must be a string (received undefined)", code: "invalid_inputs" }, 400);
    }
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

  // Open a Stripe billing portal session. The returned `url` is the hosted
  // portal page, where the customer can change the card on file. The session
  // is recorded so that page can link back to the application's `return_url`,
  // as Stripe's portal does. The portal is a read of an existing customer, so
  // an unknown one 404s rather than being created.
  app.post("/v1/billing.open_customer_portal", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const customerId = String(body.customer_id ?? body.customerId ?? "");
    if (!customerId) return c.json({ message: "customer_id is required", code: "invalid_request" }, 400);
    const store = as();
    if (!store.customers.findOneBy("customer_id", customerId)) {
      return c.json({ message: `Customer ${customerId} not found`, code: "customer_not_found" }, 404);
    }
    const returnUrl = String(body.return_url ?? body.returnUrl ?? "");
    store.portals.insert({ customer_id: customerId, return_url: returnUrl });
    return c.json({ customer_id: customerId, url: `${baseUrl}/checkout/portal/${customerId}` });
  });

  app.post("/v1/features.list", async (c) => {
    const list = as().features.all().map(serializeFeature);
    return c.json({ list, total: list.length, offset: 0, limit: 100 });
  });

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
