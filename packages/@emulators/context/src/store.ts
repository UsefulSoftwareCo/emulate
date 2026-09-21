import { Store, type Collection } from "@emulators/core";
import type { ContextBrand } from "./entities.js";

export interface ContextStore {
  brands: Collection<ContextBrand>;
}

export function getContextStore(store: Store): ContextStore {
  return {
    brands: store.collection<ContextBrand>("context.brands", ["domain"]),
  };
}
