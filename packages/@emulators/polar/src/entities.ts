import type { Entity } from "@emulators/core";

export type PolarMetadataValue = string | number | boolean;
export type PolarMetadata = Record<string, PolarMetadataValue>;

export type PolarFilterOperator = "eq" | "ne" | "gt" | "gte" | "lt" | "lte" | "like" | "not_like";

export interface PolarFilterClause {
  property: string;
  operator: PolarFilterOperator;
  value: PolarMetadataValue;
}

export interface PolarFilter {
  conjunction: "and" | "or";
  clauses: Array<PolarFilterClause | PolarFilter>;
}

export type PolarAggregation = { func: "count" } | { func: "sum" | "max" | "min" | "avg" | "unique"; property: string };

export interface PolarCustomer extends Entity {
  polar_id: string;
  external_id: string | null;
  email: string;
  email_verified: boolean;
  type: "individual" | "team";
  name: string | null;
  billing_name: string | null;
  billing_address: Record<string, unknown> | null;
  tax_id: string | null;
  locale: string | null;
  metadata: PolarMetadata;
}

export interface PolarMeter extends Entity {
  polar_id: string;
  name: string;
  unit: "scalar" | "token" | "custom";
  custom_label: string | null;
  custom_multiplier: number | null;
  filter: PolarFilter;
  aggregation: PolarAggregation;
  metadata: PolarMetadata;
  archived_at: string | null;
}

export interface PolarEvent extends Entity {
  polar_id: string;
  external_id: string | null;
  timestamp: string;
  name: string;
  customer_id: string | null;
  external_customer_id: string | null;
  metadata: PolarMetadata;
}

export interface PolarMeterCreditProperties {
  meter_id: string;
  units: number;
  rollover: boolean;
}

export interface PolarCustomBenefitProperties {
  note: string | null;
}

export interface PolarBenefit extends Entity {
  polar_id: string;
  type: "meter_credit" | "custom";
  description: string;
  properties: PolarMeterCreditProperties | PolarCustomBenefitProperties;
  metadata: PolarMetadata;
  visibility: "draft" | "private" | "public";
}

export type PolarStoredPrice =
  | {
      id: string;
      created_at: string;
      amount_type: "fixed";
      price_amount: number;
      price_currency: string;
    }
  | {
      id: string;
      created_at: string;
      amount_type: "metered_unit";
      meter_id: string;
      unit_amount: string;
      cap_amount: number | null;
      price_currency: string;
    }
  | {
      id: string;
      created_at: string;
      amount_type: "custom";
      minimum_amount: number;
      maximum_amount: number | null;
      preset_amount: number | null;
      price_currency: string;
    };

export interface PolarProduct extends Entity {
  polar_id: string;
  name: string;
  description: string | null;
  recurring_interval: "day" | "week" | "month" | "year" | null;
  recurring_interval_count: number | null;
  meter_interval: "day" | "week" | "month" | "year" | null;
  meter_interval_count: number | null;
  trial_interval: "day" | "week" | "month" | "year" | null;
  trial_interval_count: number | null;
  prices: PolarStoredPrice[];
  benefit_ids: string[];
  metadata: PolarMetadata;
  visibility: "draft" | "private" | "public";
  is_archived: boolean;
}

export type PolarSubscriptionStatus = "incomplete" | "trialing" | "active" | "past_due" | "canceled";

export interface PolarPendingUpdate {
  id: string;
  created_at: string;
  applies_at: string;
  product_id: string | null;
  seats: number | null;
  units: number | null;
}

export interface PolarSubscription extends Entity {
  polar_id: string;
  status: PolarSubscriptionStatus;
  amount: number;
  currency: string;
  recurring_interval: "day" | "week" | "month" | "year";
  recurring_interval_count: number;
  current_period_start: string;
  current_period_end: string;
  trial_start: string | null;
  trial_end: string | null;
  cancel_at_period_end: boolean;
  canceled_at: string | null;
  started_at: string | null;
  ends_at: string | null;
  ended_at: string | null;
  customer_id: string;
  product_id: string;
  pending_update: PolarPendingUpdate | null;
  checkout_id: string | null;
  customer_cancellation_reason: string | null;
  customer_cancellation_comment: string | null;
  metadata: PolarMetadata;
  pending: boolean;
}

export interface PolarCheckout extends Entity {
  polar_id: string;
  client_secret: string;
  status: "open" | "succeeded";
  expires_at: string;
  success_url: string;
  return_url: string | null;
  product_ids: string[];
  customer_id: string | null;
  customer_email: string | null;
  customer_name: string | null;
  external_customer_id: string | null;
  subscription_id: string | null;
  pending_subscription_id: string | null;
  amount: number;
  currency: string;
  allow_discount_codes: boolean;
  allow_trial: boolean;
  trial_end: string | null;
  metadata: PolarMetadata;
  customer_metadata: PolarMetadata;
  settle_delay_ms: number | null;
  confirmed_at: string | null;
  settled_at: string | null;
}

export interface PolarCustomerSession extends Entity {
  polar_id: string;
  token: string;
  expires_at: string;
  customer_id: string;
  return_url: string | null;
}
