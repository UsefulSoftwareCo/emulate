import type { Hono, Store, WebhookDispatcher, TokenMap, AppEnv, RouteContext, ServicePlugin } from "@emulators/core";

import type { PostHogEvent } from "./entities.js";
import { apiRoutes } from "./routes/api.js";
import { oauthRoutes } from "./routes/oauth.js";
import { openapiRoutes } from "./routes/openapi.js";
import { getPostHogStore } from "./store.js";

export { manifest } from "./manifest.js";
export { POSTHOG_SCOPES } from "./routes/oauth.js";
export { getPostHogStore, type PostHogStore } from "./store.js";
export * from "./entities.js";

export interface PostHogSeedConfig {
  users?: Array<{
    uuid?: string;
    email: string;
    name?: string;
  }>;
  projects?: Array<{
    id?: number;
    project_id?: number;
    name?: string;
    api_token?: string;
  }>;
  events?: Array<{
    project_id?: number;
    event: string;
    distinct_id: string;
    properties?: Record<string, unknown>;
    timestamp?: string;
  }>;
  oauth_clients?: Array<{
    client_id: string;
    client_secret?: string | null;
    client_name?: string;
    name?: string;
    redirect_uris: string[];
    token_endpoint_auth_method?: string;
  }>;
}

function nextProjectId(store: Store): number {
  const projects = getPostHogStore(store).projects.all();
  return projects.reduce((max, project) => Math.max(max, project.project_id), 0) + 1;
}

export function seedFromConfig(store: Store, _baseUrl: string, config: PostHogSeedConfig): void {
  const ps = getPostHogStore(store);

  for (const user of config.users ?? []) {
    const existing = ps.users.findOneBy("email", user.email);
    if (existing) {
      ps.users.update(existing.id, {
        uuid: user.uuid ?? existing.uuid,
        name: user.name ?? existing.name,
      });
      continue;
    }
    ps.users.insert({
      uuid: user.uuid ?? `user_${crypto.randomUUID().replace(/-/g, "")}`,
      email: user.email,
      name: user.name ?? user.email,
    });
  }

  for (const project of config.projects ?? []) {
    const projectId = project.project_id ?? project.id ?? nextProjectId(store);
    const existing = ps.projects.findOneBy("project_id", projectId);
    if (existing) {
      ps.projects.update(existing.id, {
        name: project.name ?? existing.name,
        api_token: project.api_token ?? existing.api_token,
      });
      continue;
    }
    ps.projects.insert({
      project_id: projectId,
      name: project.name ?? `Project ${projectId}`,
      api_token: project.api_token ?? `phc_${crypto.randomUUID().replace(/-/g, "")}`,
    });
  }

  for (const event of config.events ?? []) {
    const projectId = event.project_id ?? ps.projects.all()[0]?.project_id ?? 1;
    ps.events.insert({
      project_id: projectId,
      event: event.event,
      distinct_id: event.distinct_id,
      properties: event.properties ?? {},
      timestamp: event.timestamp ?? new Date().toISOString(),
    } satisfies Omit<PostHogEvent, "id" | "created_at" | "updated_at">);
  }

  for (const client of config.oauth_clients ?? []) {
    const existing = ps.oauthClients.findOneBy("client_id", client.client_id);
    const record = {
      client_secret: client.client_secret ?? null,
      client_name: client.client_name ?? client.name ?? "PostHog OAuth client",
      redirect_uris: client.redirect_uris,
      token_endpoint_auth_method:
        client.token_endpoint_auth_method ?? (client.client_secret ? "client_secret_post" : "none"),
    };
    if (existing) {
      ps.oauthClients.update(existing.id, record);
      continue;
    }
    ps.oauthClients.insert({ client_id: client.client_id, ...record });
  }
}

export const posthogPlugin: ServicePlugin = {
  name: "posthog",
  register(app: Hono<AppEnv>, store: Store, webhooks: WebhookDispatcher, baseUrl: string, tokenMap?: TokenMap): void {
    const ctx: RouteContext = { app, store, webhooks, baseUrl, tokenMap };
    oauthRoutes(ctx);
    apiRoutes(ctx);
    openapiRoutes(ctx);
  },
  seed(store: Store, baseUrl: string): void {
    seedFromConfig(store, baseUrl, {
      users: [{ email: "admin@example.com", name: "Admin User" }],
      projects: [{ id: 1, name: "Demo Project" }],
      events: [{ project_id: 1, event: "$pageview", distinct_id: "user_1", properties: { path: "/" } }],
    });
  },
};

export default posthogPlugin;
