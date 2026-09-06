import { Store, type Collection } from "@emulators/core";

import type {
  PolarBenefit,
  PolarCheckout,
  PolarCustomer,
  PolarCustomerSession,
  PolarEvent,
  PolarMeter,
  PolarProduct,
  PolarSubscription,
} from "./entities.js";

export interface PolarStore {
  customers: Collection<PolarCustomer>;
  meters: Collection<PolarMeter>;
  events: Collection<PolarEvent>;
  benefits: Collection<PolarBenefit>;
  products: Collection<PolarProduct>;
  subscriptions: Collection<PolarSubscription>;
  checkouts: Collection<PolarCheckout>;
  customerSessions: Collection<PolarCustomerSession>;
}

export function getPolarStore(store: Store): PolarStore {
  return {
    customers: store.collection<PolarCustomer>("polar.customers", ["polar_id", "external_id", "email"]),
    meters: store.collection<PolarMeter>("polar.meters", ["polar_id", "name"]),
    events: store.collection<PolarEvent>("polar.events", [
      "polar_id",
      "external_id",
      "customer_id",
      "external_customer_id",
      "name",
    ]),
    benefits: store.collection<PolarBenefit>("polar.benefits", ["polar_id", "description"]),
    products: store.collection<PolarProduct>("polar.products", ["polar_id", "name"]),
    subscriptions: store.collection<PolarSubscription>("polar.subscriptions", [
      "polar_id",
      "customer_id",
      "product_id",
    ]),
    checkouts: store.collection<PolarCheckout>("polar.checkouts", ["polar_id", "client_secret", "customer_id"]),
    customerSessions: store.collection<PolarCustomerSession>("polar.customer_sessions", [
      "polar_id",
      "token",
      "customer_id",
    ]),
  };
}
