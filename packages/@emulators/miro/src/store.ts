import { Store, type Collection } from "@emulators/core";
import type {
  MiroBoard,
  MiroConfig,
  MiroIdTokenNonceMode,
  MiroOAuthClient,
  MiroOAuthGrant,
  MiroOAuthToken,
  MiroUser,
} from "./entities.js";

export interface MiroStore {
  users: Collection<MiroUser>;
  boards: Collection<MiroBoard>;
  oauthClients: Collection<MiroOAuthClient>;
  oauthGrants: Collection<MiroOAuthGrant>;
  oauthTokens: Collection<MiroOAuthToken>;
}

// OAuth clients, codes, and tokens live in store collections (not the shared
// tokenMap) so they survive hosted Durable Object eviction like all other state.
export function getMiroStore(store: Store): MiroStore {
  return {
    users: store.collection<MiroUser>("miro.users", ["email"]),
    boards: store.collection<MiroBoard>("miro.boards", ["board_id"]),
    oauthClients: store.collection<MiroOAuthClient>("miro.oauth_clients", ["client_id"]),
    oauthGrants: store.collection<MiroOAuthGrant>("miro.oauth_grants", ["code"]),
    oauthTokens: store.collection<MiroOAuthToken>("miro.oauth_tokens", ["access_token", "refresh_token"]),
  };
}

const CONFIG_KEY = "miro.config";
export const DEFAULT_CONFIG: MiroConfig = { id_token_nonce: "omit" };

export function setMiroConfig(store: Store, config: { id_token_nonce?: MiroIdTokenNonceMode }): void {
  const current = getMiroConfig(store);
  const mode = config.id_token_nonce ?? current.id_token_nonce;
  if (mode !== "omit" && mode !== "echo") {
    throw new Error(`Invalid Miro id_token_nonce: ${String(mode)}. Use "omit" or "echo".`);
  }
  store.setData<MiroConfig>(CONFIG_KEY, { id_token_nonce: mode });
}

export function getMiroConfig(store: Store): MiroConfig {
  return store.getData<MiroConfig>(CONFIG_KEY) ?? DEFAULT_CONFIG;
}
