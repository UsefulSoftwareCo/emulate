import type {
  AppEnv,
  CredentialRequest,
  Hono,
  IssuedCredential,
  RouteContext,
  ServicePlugin,
  Store,
  TokenMap,
  WebhookDispatcher,
} from "@emulators/core";
import { ControlPlaneRejection } from "@emulators/core";
import { generatePublicId } from "./constants.js";
import { registerMcpRoutes } from "./routes/mcp.js";
import { registerClient, registerOAuthRoutes } from "./routes/oauth.js";
import { getPlanetScaleStore } from "./store.js";

export { getPlanetScaleStore, type PlanetScaleStore } from "./store.js";
export * from "./entities.js";
export { manifest } from "./manifest.js";
export { TOOL_DEFINITIONS } from "./routes/mcp.js";
export { DCR_DEFAULT_SCOPES, MCP_PATH, generateClientId, generateClientSecret } from "./constants.js";

export interface PlanetScaleSeedBranch {
  name: string;
  production?: boolean;
  parent_branch?: string;
}

export interface PlanetScaleSeedDatabase {
  name: string;
  kind?: "mysql" | "postgresql";
  region?: string;
  branches?: PlanetScaleSeedBranch[];
}

export interface PlanetScaleSeedOrganization {
  name: string;
  plan?: string;
  databases?: PlanetScaleSeedDatabase[];
}

export interface PlanetScaleSeedClient {
  client_name: string;
  redirect_uris: string[];
  client_id?: string;
  client_secret?: string;
  token_endpoint_auth_method?: "client_secret_basic" | "client_secret_post";
}

export interface PlanetScaleSeedConfig {
  users?: Array<{ login: string; name?: string; email?: string }>;
  organizations?: PlanetScaleSeedOrganization[];
  oauth_clients?: PlanetScaleSeedClient[];
}

export const DEFAULT_SEED: PlanetScaleSeedConfig = {
  users: [{ login: "planetscale-user", name: "PlanetScale User", email: "user@example.com" }],
  organizations: [
    {
      name: "acme",
      plan: "scaler_pro",
      databases: [
        {
          name: "app-db",
          kind: "mysql",
          region: "us-east",
          branches: [
            { name: "main", production: true },
            { name: "dev", parent_branch: "main" },
          ],
        },
      ],
    },
  ],
};

export function seedFromConfig(store: Store, _baseUrl: string, config: PlanetScaleSeedConfig): void {
  const ps = getPlanetScaleStore(store);

  for (const user of config.users ?? []) {
    const fields = { login: user.login, name: user.name ?? null, email: user.email ?? null };
    const existing = ps.users.findOneBy("login", user.login);
    if (existing) ps.users.update(existing.id, fields);
    else ps.users.insert(fields);
  }

  for (const org of config.organizations ?? []) {
    const existingOrg = ps.organizations.findOneBy("name", org.name);
    if (existingOrg) ps.organizations.update(existingOrg.id, { plan: org.plan ?? existingOrg.plan });
    else ps.organizations.insert({ public_id: generatePublicId(), name: org.name, plan: org.plan ?? "scaler_pro" });

    for (const db of org.databases ?? []) {
      const branches = db.branches ?? [{ name: "main", production: true }];
      const defaultBranch = branches.find((b) => b.production)?.name ?? branches[0]?.name ?? "main";
      const fields = {
        organization: org.name,
        name: db.name,
        kind: db.kind ?? "mysql",
        region: db.region ?? "us-east",
        state: "ready",
        default_branch: defaultBranch,
      };
      const existingDb = ps.databases.findBy("organization", org.name).find((d) => d.name === db.name);
      if (existingDb) ps.databases.update(existingDb.id, fields);
      else ps.databases.insert({ public_id: generatePublicId(), ...fields });

      for (const branch of branches) {
        const branchFields = {
          organization: org.name,
          database: db.name,
          name: branch.name,
          production: branch.production ?? false,
          parent_branch: branch.parent_branch ?? null,
        };
        const existingBranch = ps.branches
          .findBy("database", db.name)
          .find((b) => b.organization === org.name && b.name === branch.name);
        if (existingBranch) ps.branches.update(existingBranch.id, branchFields);
        else ps.branches.insert({ public_id: generatePublicId(), ...branchFields });
      }
    }
  }

  for (const client of config.oauth_clients ?? []) {
    if (client.client_id && ps.oauthClients.findOneBy("client_id", client.client_id)) continue;
    const result = registerClient(ps, client);
    if (!result.ok)
      throw new ControlPlaneRejection(`Invalid PlanetScale OAuth client seed: ${result.error_description}`);
  }
}

/**
 * `POST /_emulate/credentials` with type `dynamic-client-registration` or
 * `oauth-authorization-code` registers a client exactly as DCR would, so the
 * issued client id and secret have PlanetScale's real format.
 */
export function issueCredential(store: Store, baseUrl: string, request: CredentialRequest): IssuedCredential {
  const type = request.type ?? "dynamic-client-registration";
  if (type !== "dynamic-client-registration" && type !== "oauth-authorization-code") {
    throw new ControlPlaneRejection(`Credential type ${type} is not supported by planetscale`);
  }
  const result = registerClient(getPlanetScaleStore(store), {
    client_name: request.name ?? "PlanetScale Client",
    redirect_uris: request.redirect_uris ?? ["http://localhost:3000/callback"],
    token_endpoint_auth_method: request.token_endpoint_auth_method,
    client_id: request.client_id,
    client_secret: request.client_secret,
  });
  if (!result.ok) throw new ControlPlaneRejection(result.error_description);
  return {
    type,
    client_id: result.client.client_id,
    client_secret: result.client.client_secret,
    redirect_uris: result.client.redirect_uris,
    authorization_url: `${baseUrl}/oauth/authorize`,
    token_url: `${baseUrl}/oauth/token`,
  };
}

export const planetscalePlugin: ServicePlugin = {
  name: "planetscale",
  register(app: Hono<AppEnv>, store: Store, webhooks: WebhookDispatcher, baseUrl: string, tokenMap?: TokenMap): void {
    const ctx: RouteContext = { app, store, webhooks, baseUrl, tokenMap };
    registerOAuthRoutes(ctx);
    registerMcpRoutes(ctx);
  },
  seed(store: Store, baseUrl: string): void {
    seedFromConfig(store, baseUrl, DEFAULT_SEED);
  },
};

export default planetscalePlugin;
