import type { Entity } from "@emulators/core";

export interface AutumnSubscription {
  /** Stable subscription id (e.g. `sub_emulate_1`). */
  id?: string;
  plan_id: string;
  /** `active` | `trialing` | `scheduled` | `canceled`. */
  status: string;
  started_at?: number;
  current_period_start?: number | null;
  current_period_end?: number | null;
  trial_ends_at?: number | null;
  canceled_at?: number | null;
  /** When a cancellation scheduled for the end of the cycle takes effect. */
  expires_at?: number | null;
  quantity?: number;
  /** Usage watermark: only tracked events with a higher event id count against
   *  this subscription's grants. Autumn issues fresh entitlement grants when a
   *  plan is attached, so a re-attach after a cancel starts from zero usage
   *  rather than inheriting the previous subscription's consumption. */
  usage_epoch?: number;
  [key: string]: unknown;
}

export interface AutumnCustomer extends Entity {
  customer_id: string;
  name: string | null;
  email: string | null;
  subscriptions: AutumnSubscription[];
  /** Plan ids whose free trial this customer has already consumed. Once used,
   *  the plan's `trial_available` flips to false (Autumn offers a trial once). */
  trials_used?: string[];
  /** The customer's default payment method, as Stripe holds it. Only returned
   *  by `customers.get_or_create` when `expand` asks for `payment_method`. */
  payment_method?: AutumnPaymentMethod | null;
}

export interface AutumnTrackEvent extends Entity {
  customer_id: string;
  feature_id: string;
  value: number;
}

/** How often a metered item's included grant is refilled. Autumn only exposes
 *  the interval on the item; the concrete reset instant is derived from when
 *  the subscription started. */
export interface AutumnResetInterval {
  interval: string;
}

/** Usage-based pricing attached to a single plan item (Autumn's per-unit
 *  overage price), as distinct from the plan's own flat base price. */
export interface AutumnItemPrice {
  amount: number;
  interval?: string;
  billing_units?: number;
  billing_method?: string;
  max_purchase?: number | null;
}

export interface AutumnPlanItem {
  feature_id: string;
  included?: number;
  unlimited?: boolean;
  /** A priced item lets usage exceed the included grant and bills the overage,
   *  so a check against it is always allowed. */
  overage_allowed?: boolean;
  reset?: AutumnResetInterval | null;
  price?: AutumnItemPrice | null;
}

export interface AutumnPlan extends Entity {
  plan_id: string;
  name: string;
  /** Catalog group. Autumn treats plans in one group as mutually exclusive and
   *  returns `null` for ungrouped plans. */
  group: string | null;
  version: number;
  archived: boolean;
  add_on: boolean;
  auto_enable: boolean;
  price: { amount: number; interval: string } | null;
  free_trial: { duration_length: number; duration_type: string; card_required: boolean } | null;
  items: AutumnPlanItem[];
  /** Rank used to classify an attach as upgrade vs downgrade (low to high). */
  order: number;
}

/** A catalog feature. Autumn resolves a `balances.check` feature id against
 *  this registry first: an id that is not in the catalog is a 404, while a
 *  known id the customer's plan does not carry is a denied check with a null
 *  balance. The emulator keeps the same distinction, so an application under
 *  test sees a typo as a typo instead of silently passing. */
export interface AutumnFeature extends Entity {
  feature_id: string;
  name: string;
  /** `metered` | `boolean` | `credit_system`. */
  type: string;
  consumable: boolean;
  archived: boolean;
}

/** A checkout session opened by `billing.attach` for a plan that needs payment
 *  (a price, or a card-required trial). Mirrors the real flow: the browser is
 *  redirected to a hosted checkout page; completing it sends the browser back
 *  to `success_url`, but the subscription only activates once the asynchronous
 *  Stripe webhook is processed, modelled here by `settle`. */
export interface AutumnCheckout extends Entity {
  session_id: string;
  customer_id: string;
  plan_id: string;
  success_url: string;
  /** `pending` (checkout open) to `completed` (browser paid, webhook in flight)
   *  to `settled` (webhook processed, subscription active). */
  status: "pending" | "completed" | "settled";
}

/** A Stripe PaymentMethod as Autumn surfaces it on an expanded customer. Only
 *  the card fields an application realistically renders are modelled. */
export interface AutumnPaymentMethod {
  id: string;
  type: "card";
  card: { brand: string; last4: string; exp_month: number; exp_year: number };
}

/** A Stripe Checkout session in `mode: "setup"`, opened by
 *  `billing.setup_payment` so a customer can put a card on file. The hosted
 *  page captures a card and redirects to `success_url`, but the customer's
 *  default payment method only changes once the asynchronous
 *  `checkout.session.completed` webhook is processed, modelled here by
 *  `settle` (the same race as the checkout flow above). Settling only sets the
 *  default when the customer has no card yet; see `settleSetup` in
 *  routes/checkout.ts for why replacing a card needs the billing portal. */
export interface AutumnSetupSession extends Entity {
  session_id: string;
  customer_id: string;
  success_url: string;
  /** `pending` (setup open) to `completed` (card captured, webhook in flight)
   *  to `settled` (webhook processed). */
  status: "pending" | "completed" | "settled";
  /** The card captured when the hosted page was submitted. It becomes the
   *  customer's default at settle only when the customer had no card. */
  payment_method?: AutumnPaymentMethod;
}

/** A Stripe billing portal session, opened by `billing.open_customer_portal`.
 *  Only the `return_url` matters to an application under test: the hosted
 *  portal page renders a link back to it. Stripe portal sessions are
 *  single-use and short-lived; the emulator keeps them so the page can find
 *  the most recent one for a customer. */
export interface AutumnPortalSession extends Entity {
  customer_id: string;
  return_url: string;
}
