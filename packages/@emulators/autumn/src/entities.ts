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
  quantity?: number;
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
}

export interface AutumnTrackEvent extends Entity {
  customer_id: string;
  feature_id: string;
  value: number;
}

export interface AutumnPlanItem {
  feature_id: string;
  included?: number;
  unlimited?: boolean;
  price?: unknown;
}

export interface AutumnPlan extends Entity {
  plan_id: string;
  name: string;
  add_on: boolean;
  auto_enable: boolean;
  price: { amount: number; interval: string } | null;
  free_trial: { duration_length: number; duration_type: string; card_required: boolean } | null;
  items: AutumnPlanItem[];
  /** Rank used to classify an attach as upgrade vs downgrade (low to high). */
  order: number;
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
