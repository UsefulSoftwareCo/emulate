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
import { generateBoardId, generateUserId } from "./constants.js";
import type { MiroIdTokenNonceMode } from "./entities.js";
import { registerMcpRoutes } from "./routes/mcp.js";
import { registerClient, registerOAuthRoutes } from "./routes/oauth.js";
import { DEFAULT_CONFIG, getMiroStore, setMiroConfig } from "./store.js";

export { getMiroStore, getMiroConfig, type MiroStore } from "./store.js";
export * from "./entities.js";
export { manifest } from "./manifest.js";
export { TOOL_DEFINITIONS } from "./routes/mcp.js";
export { authorizationServerMetadata, openIdConfiguration, issuerFor } from "./routes/oauth.js";

export interface MiroSeedUser {
  email: string;
  name?: string;
  user_id?: string;
}

export interface MiroSeedBoard {
  name: string;
  board_id?: string;
  description?: string;
  team?: string;
  owner_email?: string;
  items?: Array<{ id?: string; type?: string; content: string }>;
}

export interface MiroSeedClient {
  redirect_uris: string[];
  client_name?: string;
  client_id?: string;
  client_secret?: string;
  token_endpoint_auth_method?: "client_secret_post" | "client_secret_basic";
  scope?: string;
}

export interface MiroSeedConfig {
  users?: MiroSeedUser[];
  boards?: MiroSeedBoard[];
  oauth_clients?: MiroSeedClient[];
  /** "omit" (default, Miro's real behaviour) or "echo" (OIDC Core behaviour). */
  id_token_nonce?: MiroIdTokenNonceMode;
}

export const DEFAULT_SEED: MiroSeedConfig = {
  users: [{ email: "user@example.com", name: "Miro User" }],
  boards: [
    {
      name: "Product Roadmap",
      description: "Quarterly planning board",
      team: "Acme",
      owner_email: "user@example.com",
      items: [
        { type: "sticky_note", content: "Ship OAuth for MCP" },
        { type: "sticky_note", content: "Customer interviews" },
        { type: "frame", content: "Q4" },
      ],
    },
    {
      name: "Retro",
      description: "Sprint retrospective",
      team: "Acme",
      owner_email: "user@example.com",
      items: [{ type: "sticky_note", content: "Faster CI" }],
    },
  ],
};

export function seedFromConfig(store: Store, _baseUrl: string, config: MiroSeedConfig): void {
  const miro = getMiroStore(store);
  if (config.id_token_nonce !== undefined) setMiroConfig(store, { id_token_nonce: config.id_token_nonce });

  for (const user of config.users ?? []) {
    const existing = miro.users.findOneBy("email", user.email);
    const fields = { email: user.email, name: user.name ?? user.email.split("@")[0] };
    if (existing) miro.users.update(existing.id, { ...fields, ...(user.user_id ? { user_id: user.user_id } : {}) });
    else miro.users.insert({ ...fields, user_id: user.user_id ?? generateUserId() });
  }

  for (const board of config.boards ?? []) {
    const existing = board.board_id
      ? miro.boards.findOneBy("board_id", board.board_id)
      : miro.boards.all().find((b) => b.name === board.name);
    const fields = {
      name: board.name,
      description: board.description ?? "",
      team: board.team ?? "Acme",
      owner_email: board.owner_email ?? config.users?.[0]?.email ?? "user@example.com",
      items: (board.items ?? []).map((item, index) => ({
        id: item.id ?? `34587646000000000${String(index + 1).padStart(2, "0")}`,
        type: item.type ?? "sticky_note",
        content: item.content,
      })),
    };
    if (existing) miro.boards.update(existing.id, fields);
    else miro.boards.insert({ board_id: board.board_id ?? generateBoardId(), ...fields });
  }

  for (const client of config.oauth_clients ?? []) {
    if (client.client_id && miro.oauthClients.findOneBy("client_id", client.client_id)) continue;
    const result = registerClient(miro, client);
    if (!result.ok) throw new Error(`Invalid Miro OAuth client seed: ${result.error_description}`);
  }
}

/**
 * `POST /_emulate/credentials` with type `dynamic-client-registration` or
 * `oauth-authorization-code` registers a client exactly as `/register` would.
 */
export function issueCredential(store: Store, baseUrl: string, request: CredentialRequest): IssuedCredential {
  const type = request.type ?? "dynamic-client-registration";
  if (type !== "dynamic-client-registration" && type !== "oauth-authorization-code") {
    throw new Error(`Credential type ${type} is not supported by miro`);
  }
  const result = registerClient(getMiroStore(store), {
    client_name: request.name ?? "Miro Client",
    redirect_uris: request.redirect_uris ?? ["http://localhost:3000/callback"],
    token_endpoint_auth_method: request.token_endpoint_auth_method,
    client_id: request.client_id,
    client_secret: request.client_secret,
  });
  if (!result.ok) throw new Error(result.error_description);
  return {
    type,
    client_id: result.client.client_id,
    client_secret: result.client.client_secret,
    redirect_uris: result.client.redirect_uris,
    authorization_url: `${baseUrl}/authorize`,
    token_url: `${baseUrl}/token`,
  };
}

export const miroPlugin: ServicePlugin = {
  name: "miro",
  register(app: Hono<AppEnv>, store: Store, webhooks: WebhookDispatcher, baseUrl: string, tokenMap?: TokenMap): void {
    const ctx: RouteContext = { app, store, webhooks, baseUrl, tokenMap };
    registerOAuthRoutes(ctx);
    // Registers the gateway catch all, so it must come last.
    registerMcpRoutes(ctx);
  },
  seed(store: Store, baseUrl: string): void {
    setMiroConfig(store, DEFAULT_CONFIG);
    seedFromConfig(store, baseUrl, DEFAULT_SEED);
  },
};

export default miroPlugin;
