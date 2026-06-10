import type { Entity } from "@emulators/core";

export interface AutumnSubscription {
  plan_id: string;
  status: string;
  [key: string]: unknown;
}

export interface AutumnCustomer extends Entity {
  customer_id: string;
  name: string | null;
  email: string | null;
  subscriptions: AutumnSubscription[];
}

export interface AutumnTrackEvent extends Entity {
  customer_id: string;
  feature_id: string;
  value: number;
}
