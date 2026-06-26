import { Store, type Collection } from "@emulators/core";

import type { PendingOAuthCode, PostHogEvent, PostHogProject, PostHogUser, RegisteredOAuthClient } from "./entities.js";

export interface PostHogStore {
  users: Collection<PostHogUser>;
  projects: Collection<PostHogProject>;
  events: Collection<PostHogEvent>;
  oauthClients: Collection<RegisteredOAuthClient>;
}

export function getPostHogStore(store: Store): PostHogStore {
  return {
    users: store.collection<PostHogUser>("posthog.users", ["uuid", "email"]),
    projects: store.collection<PostHogProject>("posthog.projects", ["project_id", "api_token"]),
    events: store.collection<PostHogEvent>("posthog.events", ["project_id", "event", "distinct_id"]),
    oauthClients: store.collection<RegisteredOAuthClient>("posthog.oauth_clients", ["client_id"]),
  };
}

export function getPendingOAuthCodes(store: Store): Map<string, PendingOAuthCode> {
  let codes = store.getData<Map<string, PendingOAuthCode>>("posthog.oauth.pending_codes");
  if (!codes) {
    codes = new Map();
    store.setData("posthog.oauth.pending_codes", codes);
  }
  return codes;
}
