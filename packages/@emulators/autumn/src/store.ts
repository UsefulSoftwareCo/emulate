import { Store, type Collection } from "@emulators/core";

import type { AutumnCustomer, AutumnTrackEvent } from "./entities.js";

export interface AutumnStore {
  customers: Collection<AutumnCustomer>;
  events: Collection<AutumnTrackEvent>;
}

export function getAutumnStore(store: Store): AutumnStore {
  return {
    customers: store.collection<AutumnCustomer>("autumn.customers", ["customer_id"]),
    events: store.collection<AutumnTrackEvent>("autumn.events", ["customer_id", "feature_id"]),
  };
}
