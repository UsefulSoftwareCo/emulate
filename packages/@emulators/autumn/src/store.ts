import { Store, type Collection } from "@emulators/core";

import type { AutumnCustomer, AutumnTrackEvent, AutumnPlan, AutumnCheckout } from "./entities.js";

export interface AutumnStore {
  customers: Collection<AutumnCustomer>;
  events: Collection<AutumnTrackEvent>;
  plans: Collection<AutumnPlan>;
  checkouts: Collection<AutumnCheckout>;
}

export function getAutumnStore(store: Store): AutumnStore {
  return {
    customers: store.collection<AutumnCustomer>("autumn.customers", ["customer_id"]),
    events: store.collection<AutumnTrackEvent>("autumn.events", ["customer_id", "feature_id"]),
    plans: store.collection<AutumnPlan>("autumn.plans", ["plan_id"]),
    checkouts: store.collection<AutumnCheckout>("autumn.checkouts", ["session_id", "customer_id"]),
  };
}
