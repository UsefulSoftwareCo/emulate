import type { Hono } from "./http.js";
import type { Store } from "./store.js";
import type { WebhookDispatcher } from "./webhooks.js";
import type { TokenMap, AppEnv } from "./middleware/auth.js";
import type { RequestLedger } from "./ledger.js";

export interface RouteContext {
  app: Hono<AppEnv>;
  store: Store;
  webhooks: WebhookDispatcher;
  baseUrl: string;
  tokenMap?: TokenMap;
  /**
   * The instance's request ledger, for a plugin that records an event the
   * ledger middleware does not see (control-plane calls under /_emulate are
   * skipped by design). Absent where a host does not pass it.
   */
  ledger?: RequestLedger;
}

export interface ServicePlugin {
  name: string;
  register(
    app: Hono<AppEnv>,
    store: Store,
    webhooks: WebhookDispatcher,
    baseUrl: string,
    tokenMap?: TokenMap,
    ledger?: RequestLedger,
  ): void;
  seed?(store: Store, baseUrl: string): void;
}
