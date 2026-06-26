import type { RouteContext, ServicePlugin, Store } from "@emulators/core";
import { graphqlRoutes } from "./routes/graphql.js";

export { manifest } from "./manifest.js";
export { getGitLabSchema } from "./schema.js";

/**
 * GitLab's emulated surface is a stateless GraphQL endpoint, so there is nothing
 * to seed. The config shape is kept open for forward compatibility and so the
 * service registers like every other emulator.
 */
export interface GitLabSeedConfig {
  [key: string]: unknown;
}

export function seedFromConfig(_store: Store, _baseUrl: string, _config: GitLabSeedConfig): void {
  // No state to seed: the GraphQL surface returns static, schema complete data.
}

export const gitlabPlugin: ServicePlugin = {
  name: "gitlab",
  register(app, store, webhooks, baseUrl, tokenMap): void {
    const ctx: RouteContext = { app, store, webhooks, baseUrl, tokenMap };
    graphqlRoutes(ctx);
  },
  seed(): void {
    // No default seed.
  },
};

export default gitlabPlugin;
