// Shared state transitions and SDK-shaped serialization for the Autumn
// emulator. Field names are the snake_case keys the real Autumn v1 API returns;
// the autumn-js SDK remaps them to camelCase on the way in.
import type { AutumnStore } from "./store.js";
import type { AutumnCustomer, AutumnPlan, AutumnSubscription } from "./entities.js";

const DAY_MS = 86_400_000;

const ACTIVE_STATUSES = new Set(["active", "trialing"]);

function freeTrialMs(ft: { duration_length: number; duration_type: string }): number {
  const n = ft.duration_length;
  switch (ft.duration_type) {
    case "year":
      return n * 365 * DAY_MS;
    case "month":
      return n * 30 * DAY_MS;
    default:
      return n * DAY_MS;
  }
}

export function ensureCustomer(
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

/** Activate `plan` for `customer`, replacing any current paid subscription.
 *  A card-required trial lands as `trialing`; everything else as `active`. */
export function activateSubscription(
  as: AutumnStore,
  customer: AutumnCustomer,
  plan: AutumnPlan,
  opts: { trial: boolean },
): void {
  const now = Date.now();
  const trialing = opts.trial && plan.free_trial != null;
  const periodEnd = trialing ? now + freeTrialMs(plan.free_trial!) : now + 30 * DAY_MS;
  const sub: AutumnSubscription = {
    id: `sub_emulate_${customer.id}_${plan.plan_id}`,
    plan_id: plan.plan_id,
    status: trialing ? "trialing" : "active",
    started_at: now,
    current_period_start: now,
    current_period_end: periodEnd,
    trial_ends_at: trialing ? periodEnd : null,
    canceled_at: null,
    quantity: 1,
  };
  const trialsUsed = trialing
    ? Array.from(new Set([...(customer.trials_used ?? []), plan.plan_id]))
    : (customer.trials_used ?? []);
  as.customers.update(customer.id, { subscriptions: [sub], trials_used: trialsUsed });
}

function activeSubscription(customer: AutumnCustomer): AutumnSubscription | undefined {
  return (customer.subscriptions ?? []).find((s) => ACTIVE_STATUSES.has(s.status));
}

function usageFor(as: AutumnStore, customerId: string, featureId: string): number {
  return as.events
    .all()
    .filter((e) => e.customer_id === customerId && e.feature_id === featureId)
    .reduce((sum, e) => sum + (e.value ?? 0), 0);
}

/** The emulator has no first-class feature registry (plan items only carry a
 *  `feature_id`), so synthesize the minimal, honest `feature` object autumn-js
 *  requires on every balance/flag entry. autumn-js 1.2.8's `customerToFeatures`
 *  throws unless `balances.feature` (or `flags.feature`) is present, and the
 *  SDK's own backend route always requests `expand: ["balances.feature"]` on
 *  `customers.get_or_create`, so this is included unconditionally rather than
 *  gated on a request `expand` param. */
function serializeBalanceFeature(featureId: string): Record<string, unknown> {
  return {
    id: featureId,
    name: featureId,
    type: "metered",
    consumable: true,
    event_names: [featureId],
    archived: false,
  };
}

function serializeSubscription(sub: AutumnSubscription): Record<string, unknown> {
  return {
    id: sub.id ?? `sub_emulate_${sub.plan_id}`,
    plan_id: sub.plan_id,
    auto_enable: false,
    add_on: false,
    status: sub.status,
    past_due: false,
    canceled_at: sub.canceled_at ?? null,
    expires_at: null,
    trial_ends_at: sub.trial_ends_at ?? null,
    started_at: sub.started_at ?? Date.now(),
    current_period_start: sub.current_period_start ?? null,
    current_period_end: sub.current_period_end ?? null,
    quantity: sub.quantity ?? 1,
  };
}

function balancesFor(as: AutumnStore, customer: AutumnCustomer): Record<string, unknown> {
  const planId = activeSubscription(customer)?.plan_id ?? "free";
  const plan = as.plans.findOneBy("plan_id", planId);
  const balances: Record<string, unknown> = {};
  for (const item of plan?.items ?? []) {
    const unlimited = item.unlimited === true;
    const granted = unlimited ? 0 : (item.included ?? 0);
    const usage = usageFor(as, customer.customer_id, item.feature_id);
    balances[item.feature_id] = {
      feature_id: item.feature_id,
      feature: serializeBalanceFeature(item.feature_id),
      granted,
      remaining: unlimited ? 0 : Math.max(0, granted - usage),
      usage,
      unlimited,
      overage_allowed: false,
      max_purchase: null,
      next_reset_at: null,
    };
  }
  return balances;
}

export function serializeCustomer(as: AutumnStore, customer: AutumnCustomer): Record<string, unknown> {
  return {
    id: customer.customer_id,
    created_at: Date.parse(customer.created_at) || Date.now(),
    name: customer.name,
    email: customer.email,
    fingerprint: null,
    stripe_id: `cus_emulate_${customer.id}`,
    env: "sandbox",
    metadata: {},
    send_email_receipts: true,
    billing_controls: {},
    subscriptions: (customer.subscriptions ?? []).map(serializeSubscription),
    purchases: [],
    balances: balancesFor(as, customer),
    flags: {},
    invoices: [],
    products: [],
    features: {},
  };
}

/** Per-customer eligibility for one plan, mirroring Autumn's `customer_eligibility`.
 *  `status` is only present when the plan is the customer's current plan; the UI
 *  treats an absent status as "not on this plan". */
function eligibilityFor(as: AutumnStore, customer: AutumnCustomer, plan: AutumnPlan): Record<string, unknown> {
  const subs = customer.subscriptions ?? [];
  const subForPlan = subs.find((s) => s.plan_id === plan.plan_id && ACTIVE_STATUSES.has(s.status));
  if (subForPlan) {
    return {
      status: "active",
      canceling: subForPlan.canceled_at != null,
      trialing: subForPlan.status === "trialing",
      trial_available: false,
      attach_action: "none",
    };
  }

  const paidSub = subs.find((s) => ACTIVE_STATUSES.has(s.status) && s.plan_id !== "free");
  if (plan.plan_id === "free") {
    if (!paidSub) {
      // No paid plan: the auto-enabled free plan is the customer's current plan.
      return { status: "active", canceling: false, trialing: false, attach_action: "none" };
    }
    return { canceling: false, trialing: false, trial_available: false, attach_action: "downgrade" };
  }

  const paidPlan = paidSub ? as.plans.findOneBy("plan_id", paidSub.plan_id) : undefined;
  const trialUsed = (customer.trials_used ?? []).includes(plan.plan_id);
  const attachAction =
    paidSub && paidPlan ? (plan.order > paidPlan.order ? "upgrade" : "downgrade") : "upgrade";
  return {
    canceling: false,
    trialing: false,
    trial_available: plan.free_trial != null && !trialUsed,
    attach_action: attachAction,
  };
}

export function serializePlan(
  as: AutumnStore,
  customer: AutumnCustomer | undefined,
  plan: AutumnPlan,
): Record<string, unknown> {
  return {
    id: plan.plan_id,
    name: plan.name,
    description: null,
    group: null,
    version: 1,
    add_on: plan.add_on,
    auto_enable: plan.auto_enable,
    price: plan.price ? { amount: plan.price.amount, interval: plan.price.interval, interval_count: 1 } : null,
    items: (plan.items ?? []).map((it) => ({
      feature_id: it.feature_id,
      included: it.included ?? 0,
      unlimited: it.unlimited === true,
      reset: null,
      price: it.price ?? null,
    })),
    free_trial: plan.free_trial
      ? {
          duration_length: plan.free_trial.duration_length,
          duration_type: plan.free_trial.duration_type,
          card_required: plan.free_trial.card_required,
        }
      : undefined,
    created_at: Date.parse(plan.created_at) || Date.now(),
    env: "sandbox",
    archived: false,
    base_variant_id: null,
    config: { ignore_past_due: false },
    customer_eligibility: customer ? eligibilityFor(as, customer, plan) : undefined,
  };
}
