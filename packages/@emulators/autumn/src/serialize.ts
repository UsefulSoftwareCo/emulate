// Shared state transitions and SDK-shaped serialization for the Autumn
// emulator. Field names are the snake_case keys the real Autumn v1 API returns;
// the autumn-js SDK remaps them to camelCase on the way in.
//
// Shapes here were taken from the real Autumn sandbox API at
// `x-api-version: 2.3.0`, not from the docs, wherever the two disagreed.
import type { Store } from "@emulators/core";

import type { AutumnStore } from "./store.js";
import type {
  AutumnCustomer,
  AutumnFeature,
  AutumnPaymentMethod,
  AutumnPlan,
  AutumnPlanItem,
  AutumnSubscription,
  AutumnTrackEvent,
} from "./entities.js";

const DAY_MS = 86_400_000;

const ACTIVE_STATUSES = new Set(["active", "trialing"]);

function intervalMs(interval: string): number {
  switch (interval) {
    case "year":
      return 365 * DAY_MS;
    case "quarter":
      return 90 * DAY_MS;
    case "week":
      return 7 * DAY_MS;
    case "day":
      return DAY_MS;
    default:
      return 30 * DAY_MS;
  }
}

function freeTrialMs(ft: { duration_length: number; duration_type: string }): number {
  return ft.duration_length * intervalMs(ft.duration_type);
}

export function ensureCustomer(as: AutumnStore, id: string, data: { name?: unknown; email?: unknown }): AutumnCustomer {
  const existing = as.customers.findOneBy("customer_id", id);
  if (existing) return existing;
  const customer = as.customers.insert({
    customer_id: id,
    name: typeof data.name === "string" ? data.name : null,
    email: typeof data.email === "string" ? data.email : null,
    subscriptions: [],
  });
  // A brand-new customer picks up every plan the catalog marks `auto_enable`,
  // exactly as real Autumn does when no `auto_enable_plan_id` is supplied.
  const defaults = as.plans.all().filter((plan) => plan.auto_enable && !plan.archived);
  if (defaults.length === 0) return customer;
  let current = customer;
  for (const plan of defaults) current = attachPlan(as, current, plan, { trial: false });
  return current;
}

/** Whether a plan bills on a recurring cycle, through a flat price or a
 *  usage-based item price. A plan that bills nothing has no cycle, which is
 *  what makes it the free tier of its group and what makes an end-of-cycle
 *  cancellation meaningless for it. */
export function hasBillingCycle(plan: AutumnPlan): boolean {
  return plan.price != null || (plan.items ?? []).some((item) => item.price != null);
}

/** The highest event id issued so far. A subscription records this at
 *  activation so its grants only see usage tracked afterwards. */
function usageWatermark(as: AutumnStore): number {
  return as.events.all().reduce((max, event) => Math.max(max, event.id), 0);
}

/** Attach `plan` to `customer`, replacing any subscription in the same catalog
 *  group (Autumn treats grouped plans as mutually exclusive) and any existing
 *  subscription to the same plan. A card-required trial lands as `trialing`;
 *  everything else as `active`. Returns the updated customer. */
export function attachPlan(
  as: AutumnStore,
  customer: AutumnCustomer,
  plan: AutumnPlan,
  opts: { trial: boolean },
): AutumnCustomer {
  const now = Date.now();
  const trialing = opts.trial && plan.free_trial != null;
  const paid = hasBillingCycle(plan);
  const periodEnd = trialing ? now + freeTrialMs(plan.free_trial!) : paid ? now + 30 * DAY_MS : null;
  const sub: AutumnSubscription = {
    id: `sub_emulate_${customer.id}_${plan.plan_id}`,
    plan_id: plan.plan_id,
    status: trialing ? "trialing" : "active",
    started_at: now,
    // Autumn reports no billing cycle for a plan with no recurring price.
    current_period_start: paid || trialing ? now : null,
    current_period_end: periodEnd,
    trial_ends_at: trialing ? periodEnd : null,
    canceled_at: null,
    expires_at: null,
    quantity: 1,
    usage_epoch: usageWatermark(as),
  };
  const kept = (customer.subscriptions ?? []).filter((existing) => {
    if (existing.plan_id === plan.plan_id) return false;
    const other = as.plans.findOneBy("plan_id", existing.plan_id);
    // Add-ons stack; two plans in the same group never do.
    if (other?.add_on) return true;
    if (plan.add_on) return true;
    return (other?.group ?? null) !== plan.group;
  });
  const trialsUsed = trialing
    ? Array.from(new Set([...(customer.trials_used ?? []), plan.plan_id]))
    : (customer.trials_used ?? []);
  return as.customers.update(customer.id, { subscriptions: [...kept, sub], trials_used: trialsUsed })!;
}

/** Retained under its previous name: `billing.attach` settlement and the
 *  checkout routes call it for its side effect only. */
export function activateSubscription(
  as: AutumnStore,
  customer: AutumnCustomer,
  plan: AutumnPlan,
  opts: { trial: boolean },
): void {
  attachPlan(as, customer, plan, opts);
}

export type CancelAction = "cancel_immediately" | "cancel_end_of_cycle" | "uncancel";

export interface CancelOutcome {
  /** Plan ids the action applied to. Empty means nothing matched. */
  readonly planIds: string[];
}

/** Apply a `billing.update` cancel action. `planId` narrows the action to one
 *  subscription; omitting it applies to every live subscription, which is what
 *  real Autumn does. An immediate cancel removes the subscription outright, so
 *  its balances disappear with it; an end-of-cycle cancel leaves the
 *  subscription active and records when it expires. */
export function applyCancelAction(
  as: AutumnStore,
  customer: AutumnCustomer,
  action: CancelAction,
  planId?: string,
): CancelOutcome {
  const subs = customer.subscriptions ?? [];
  const matches = subs.filter((sub) => {
    if (planId !== undefined && sub.plan_id !== planId) return false;
    return action === "uncancel" ? sub.canceled_at != null : ACTIVE_STATUSES.has(sub.status);
  });
  if (matches.length === 0) return { planIds: [] };
  const matched = new Set(matches);
  const now = Date.now();
  const next = subs.flatMap((sub) => {
    if (!matched.has(sub)) return [sub];
    if (action === "cancel_immediately") return [];
    if (action === "uncancel") return [{ ...sub, canceled_at: null, expires_at: null }];
    return [{ ...sub, canceled_at: now, expires_at: sub.current_period_end ?? null }];
  });
  as.customers.update(customer.id, { subscriptions: next });
  return { planIds: matches.map((sub) => sub.plan_id) };
}

function activeSubscriptions(customer: AutumnCustomer): AutumnSubscription[] {
  return (customer.subscriptions ?? []).filter((s) => ACTIVE_STATUSES.has(s.status));
}

/** The reset window a metered item is currently inside. Autumn refills an
 *  item's included grant every interval from when the subscription started, so
 *  usage tracked before the current window no longer counts. */
function resetWindow(sub: AutumnSubscription, item: AutumnPlanItem): { start: number; resetsAt: number } | null {
  const interval = item.reset?.interval;
  if (interval === undefined) return null;
  const startedAt = sub.started_at ?? 0;
  const span = intervalMs(interval);
  const elapsed = Math.max(0, Date.now() - startedAt);
  const start = startedAt + Math.floor(elapsed / span) * span;
  return { start, resetsAt: start + span };
}

function eventTime(event: AutumnTrackEvent): number {
  return Date.parse(event.created_at) || 0;
}

function usageFor(as: AutumnStore, customerId: string, featureId: string, since: number, after: number): number {
  return as.events
    .findBy("customer_id", customerId)
    .filter((e) => e.feature_id === featureId && e.id > after && eventTime(e) >= since)
    .reduce((sum, e) => sum + (e.value ?? 0), 0);
}

/** Raw events one customer and feature may hold before they are rolled up. */
const USAGE_ROLLUP_THRESHOLD = 64;

/**
 * Roll up a customer's usage events for one feature so that storage and balance
 * reads stay bounded however many executions are tracked. Real Autumn keeps a
 * running balance per window rather than replaying history, so a rollup is as
 * faithful as the raw events for every balance Autumn can report.
 *
 * Balances count events after a subscription's usage watermark (by event id)
 * and inside an item's current reset window (by time). Only adjacent events that
 * no watermark or current window start separates are merged; the merged event
 * keeps the newest id and time, so every current balance is unchanged. Later
 * windows start after every existing event, and later watermarks are at or
 * above every existing id, so those balances are unchanged too. A catalog edit
 * that adds a reset interval to an existing item sees rolled-up history at the
 * granularity of the rollups. `events.list` returns the rollups.
 */
export function compactUsage(as: AutumnStore, customer: AutumnCustomer, featureId: string): void {
  const events = as.events.findBy("customer_id", customer.customer_id).filter((e) => e.feature_id === featureId);
  if (events.length <= USAGE_ROLLUP_THRESHOLD) return;
  const watermarks: number[] = [];
  const windowStarts: number[] = [];
  for (const sub of customer.subscriptions ?? []) {
    watermarks.push(sub.usage_epoch ?? 0);
    const plan = as.plans.findOneBy("plan_id", sub.plan_id);
    for (const item of plan?.items ?? []) {
      if (item.feature_id !== featureId) continue;
      const window = resetWindow(sub, item);
      if (window) windowStarts.push(window.start);
    }
  }
  const segment = (event: AutumnTrackEvent) =>
    `${watermarks.filter((mark) => event.id > mark).length}:${windowStarts.filter((start) => eventTime(event) >= start).length}`;
  const merge = (run: AutumnTrackEvent[]) => {
    if (run.length < 2) return;
    const last = run[run.length - 1];
    as.events.update(last.id, { value: run.reduce((sum, e) => sum + (e.value ?? 0), 0) });
    for (const event of run.slice(0, -1)) as.events.delete(event.id);
  };
  let run: AutumnTrackEvent[] = [];
  let runSegment = "";
  for (const event of events.sort((a, b) => a.id - b.id)) {
    const key = segment(event);
    if (run.length > 0 && key !== runSegment) {
      merge(run);
      run = [];
    }
    run.push(event);
    runSegment = key;
  }
  merge(run);
}

/** The emulator synthesizes this object for autumn-js's `customerToFeatures`
 *  helper, which throws unless every `balances` entry carries a nested
 *  `feature`. The real v1 API at api-version 2.3.0 omits it; it is an additive
 *  emulator field that SDK response parsing and Autumn's own consumers ignore. */
function serializeBalanceFeature(as: AutumnStore, featureId: string): Record<string, unknown> {
  const feature = as.features.findOneBy("feature_id", featureId);
  return {
    id: featureId,
    name: feature?.name ?? featureId,
    type: feature?.type ?? "metered",
    consumable: feature?.consumable ?? true,
    event_names: [featureId],
    archived: feature?.archived ?? false,
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
    expires_at: sub.expires_at ?? null,
    trial_ends_at: sub.trial_ends_at ?? null,
    started_at: sub.started_at ?? Date.now(),
    current_period_start: sub.current_period_start ?? null,
    current_period_end: sub.current_period_end ?? null,
    quantity: sub.quantity ?? 1,
    scope: "customer",
  };
}

/** One entitlement grant inside a balance, as Autumn's `breakdown` reports it. */
export interface SerializedGrant {
  id: string;
  plan_id: string;
  included_grant: number;
  prepaid_grant: number;
  remaining: number;
  usage: number;
  unlimited: boolean;
  reset: { interval: string; resets_at: number } | null;
  price: unknown;
  expires_at: number | null;
}

/** One feature balance in the snake_case wire shape autumn-js's
 *  `Balance$inboundSchema` requires: every field below is non-optional in the
 *  SDK schema, so a balance is either absent (null) or complete. */
export interface SerializedBalance {
  feature_id: string;
  feature: Record<string, unknown>;
  granted: number;
  remaining: number;
  usage: number;
  unlimited: boolean;
  overage_allowed: boolean;
  max_purchase: number | null;
  next_reset_at: number | null;
  breakdown: SerializedGrant[];
}

interface Granting {
  sub: AutumnSubscription;
  item: AutumnPlanItem;
  window: { start: number; resetsAt: number } | null;
}

function balancesFor(as: AutumnStore, customer: AutumnCustomer): Record<string, SerializedBalance> {
  const granting = new Map<string, Granting[]>();
  for (const sub of activeSubscriptions(customer)) {
    const plan = as.plans.findOneBy("plan_id", sub.plan_id);
    for (const item of plan?.items ?? []) {
      const list = granting.get(item.feature_id) ?? [];
      list.push({ sub, item, window: resetWindow(sub, item) });
      granting.set(item.feature_id, list);
    }
  }
  const balances: Record<string, SerializedBalance> = {};
  for (const [featureId, grants] of granting) {
    // Usage is tracked per customer and feature, so the window and watermark of
    // the oldest contributing grant decide what still counts.
    const since = Math.min(...grants.map((g) => g.window?.start ?? 0));
    const after = Math.min(...grants.map((g) => g.sub.usage_epoch ?? 0));
    let outstanding = usageFor(as, customer.customer_id, featureId, since, after);
    const unlimited = grants.some((g) => g.item.unlimited === true);
    const overage = grants.some((g) => g.item.overage_allowed === true || g.item.price != null);
    const granted = grants.reduce((sum, g) => sum + (g.item.unlimited === true ? 0 : (g.item.included ?? 0)), 0);
    const totalUsage = outstanding;
    // Grants drain in declaration order, as Autumn's breakdown shows.
    const breakdown = grants.map((g): SerializedGrant => {
      const itemGranted = g.item.unlimited === true ? 0 : (g.item.included ?? 0);
      const drawn = g.item.unlimited === true ? outstanding : Math.min(outstanding, itemGranted);
      outstanding -= drawn;
      return {
        id: `cus_ent_emulate_${g.sub.id ?? g.sub.plan_id}_${featureId}`,
        plan_id: g.sub.plan_id,
        included_grant: itemGranted,
        prepaid_grant: 0,
        remaining: g.item.unlimited === true ? 0 : Math.max(0, itemGranted - drawn),
        usage: drawn,
        unlimited: g.item.unlimited === true,
        reset: g.window ? { interval: g.item.reset!.interval, resets_at: g.window.resetsAt } : null,
        price: g.item.price ?? null,
        expires_at: null,
      };
    });
    const nextReset = grants
      .map((g) => g.window?.resetsAt)
      .filter((value): value is number => value !== undefined)
      .sort((a, b) => a - b)[0];
    balances[featureId] = {
      feature_id: featureId,
      feature: serializeBalanceFeature(as, featureId),
      granted,
      remaining: unlimited ? 0 : Math.max(0, granted - totalUsage),
      usage: totalUsage,
      unlimited,
      overage_allowed: overage,
      max_purchase: null,
      next_reset_at: nextReset ?? null,
      breakdown,
    };
  }
  return balances;
}

/** The customer's balance for one feature, or undefined when no active
 *  subscription grants it. Shares `balancesFor` so `balances.check` and
 *  `customers.get_or_create` can never disagree about a balance. */
export function balanceForFeature(
  as: AutumnStore,
  customer: AutumnCustomer,
  featureId: string,
): SerializedBalance | undefined {
  return balancesFor(as, customer)[featureId];
}

/** Whether the catalog knows this feature at all. Autumn resolves the feature
 *  before the customer, so an unknown id is a 404 rather than a denied check.
 *  Plan items count as declarations: seeding a plan is enough to make its
 *  features real, so a catalog seeded without an explicit `features` list still
 *  behaves correctly. */
export function knownFeature(as: AutumnStore, featureId: string): boolean {
  if (as.features.findOneBy("feature_id", featureId) !== undefined) return true;
  return as.plans.all().some((plan) => plan.items.some((item) => item.feature_id === featureId));
}

export interface CheckOutcome {
  allowed: boolean;
  balance: SerializedBalance | null;
}

/**
 * Check a feature and, when `sendEvent` is set, consume `requiredBalance` in
 * the same step. This function must stay synchronous: the emulator store is an
 * in-memory structure and JavaScript runs one turn at a time, so the read, the
 * decision and the write cannot interleave with a concurrent request. Adding an
 * `await` between them would let two callers both observe the last unit and
 * overspend it. `__tests__/autumn-check.test.ts` holds that invariant.
 *
 * Autumn consumes exactly `required_balance` and nothing when the check is
 * denied, so a rejected caller never loses a unit.
 */
export function checkAndConsume(
  as: AutumnStore,
  customer: AutumnCustomer,
  featureId: string,
  requiredBalance: number,
  sendEvent: boolean,
): CheckOutcome {
  const balance = balanceForFeature(as, customer, featureId);
  if (balance === undefined) return { allowed: false, balance: null };
  const allowed = balance.unlimited || balance.overage_allowed || balance.remaining >= requiredBalance;
  if (!allowed || !sendEvent || requiredBalance === 0) return { allowed, balance };
  as.events.insert({ customer_id: customer.customer_id, feature_id: featureId, value: requiredBalance });
  const consumed = balanceForFeature(as, customer, featureId) ?? balance;
  compactUsage(as, customer, featureId);
  return { allowed, balance: consumed };
}

/** Mint the next Stripe-style PaymentMethod id for this instance. Stripe ids
 *  are unique per object, so the counter lives on the store rather than on any
 *  one customer (a customer can replace its card any number of times). */
export function nextPaymentMethodId(store: Store): string {
  const next = (store.getData<number>("autumn.payment_method_seq") ?? 0) + 1;
  store.setData("autumn.payment_method_seq", next);
  return `pm_emulate_${next}`;
}

/** The card a paid checkout leaves on file when the customer had none. */
export function defaultCard(id: string): AutumnPaymentMethod {
  return { id, type: "card", card: { brand: "visa", last4: "4242", exp_month: 12, exp_year: 2030 } };
}

/** Read a card out of a hosted page's form fields (the setup checkout and the
 *  billing portal both post the same `card_number` and `exp` pair). The brand
 *  follows the real issuer ranges Stripe's test cards use (4 Visa,
 *  5 Mastercard, 3 Amex). */
export function cardFromForm(cardNumber: string, exp: string, id: string): AutumnPaymentMethod {
  const digits = cardNumber.replace(/\D/g, "");
  const brand = digits.startsWith("4")
    ? "visa"
    : digits.startsWith("5")
      ? "mastercard"
      : digits.startsWith("3")
        ? "amex"
        : "card";
  const [rawMonth = "", rawYear = ""] = exp.split("/");
  const month = Number(rawMonth.trim());
  const year = Number(rawYear.trim());
  const expYear = Number.isFinite(year) && year > 0 ? (year < 100 ? 2000 + year : year) : 2030;
  return {
    id,
    type: "card",
    card: {
      brand,
      last4: digits.slice(-4) || "4242",
      exp_month: Number.isFinite(month) && month > 0 ? month : 12,
      exp_year: expYear,
    },
  };
}

export interface SerializeCustomerOptions {
  /** Autumn's `expand` request param. `payment_method` adds the customer's
   *  default card. Without the expand, or when no card is on file, the field
   *  is omitted entirely (verified against the live sandbox API: a customer
   *  with no card gets no `payment_method` key even when expanded). */
  expand?: string[];
}

export function serializeCustomer(
  as: AutumnStore,
  customer: AutumnCustomer,
  options: SerializeCustomerOptions = {},
): Record<string, unknown> {
  const expanded: Record<string, unknown> =
    options.expand?.includes("payment_method") && customer.payment_method
      ? { payment_method: customer.payment_method }
      : {};
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
    licenses: [],
    balances: balancesFor(as, customer),
    flags: {},
    config: {},
    invoices: [],
    products: [],
    features: {},
    ...expanded,
  };
}

export function serializeFeature(feature: AutumnFeature): Record<string, unknown> {
  return {
    id: feature.feature_id,
    name: feature.name,
    type: feature.type,
    consumable: feature.consumable,
    archived: feature.archived,
    event_names: [feature.feature_id],
    created_at: Date.parse(feature.created_at) || Date.now(),
    env: "sandbox",
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

  // Only a subscription in the same catalog group is something to move from.
  // A plan in a group the customer holds nothing in is an `activate`, which is
  // what real Autumn reports for an unrelated catalog.
  const held = subs
    .filter((s) => ACTIVE_STATUSES.has(s.status))
    .map((s) => as.plans.findOneBy("plan_id", s.plan_id))
    .find((candidate): candidate is AutumnPlan => candidate !== undefined && candidate.group === plan.group);
  const trialUsed = (customer.trials_used ?? []).includes(plan.plan_id);
  return {
    canceling: false,
    trialing: false,
    trial_available: plan.free_trial != null && !trialUsed,
    attach_action: held ? (plan.order > held.order ? "upgrade" : "downgrade") : "activate",
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
    group: plan.group,
    version: plan.version,
    version_slug: `v${plan.version}`,
    active: !plan.archived,
    add_on: plan.add_on,
    auto_enable: plan.auto_enable,
    price: plan.price ? { amount: plan.price.amount, interval: plan.price.interval, interval_count: 1 } : null,
    items: (plan.items ?? []).map((it) => ({
      feature_id: it.feature_id,
      included: it.included ?? 0,
      unlimited: it.unlimited === true,
      pooled: false,
      reset: it.reset ?? null,
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
    archived: plan.archived,
    base_variant_id: null,
    config: { ignore_past_due: false },
    billing_controls: {},
    metadata: {},
    customer_eligibility: customer ? eligibilityFor(as, customer, plan) : undefined,
  };
}
