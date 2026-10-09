import type { Entity } from "@emulators/core";

/** A Miro account that can approve consent. Its email lands in the ID token. */
export interface MiroUser extends Entity {
  /** Miro's numeric user id, used as the ID token `sub`. */
  user_id: string;
  email: string;
  name: string;
}

export interface MiroBoardItem {
  id: string;
  type: string;
  content: string;
}

export interface MiroBoard extends Entity {
  board_id: string;
  name: string;
  description: string;
  team: string;
  owner_email: string;
  items: MiroBoardItem[];
}

/** A client created by Dynamic Client Registration or seed. */
export interface MiroOAuthClient extends Entity {
  client_id: string;
  client_secret: string;
  client_name: string | null;
  redirect_uris: string[];
  token_endpoint_auth_method: "client_secret_post" | "client_secret_basic";
  grant_types: string[];
  response_types: string[];
  scope: string;
  client_id_issued_at: number;
}

/** An authorization code issued by the consent page. */
export interface MiroOAuthGrant extends Entity {
  code: string;
  client_id: string;
  redirect_uri: string;
  redirect_uri_provided_explicitly: boolean;
  scope: string;
  code_challenge: string;
  resource: string | null;
  /** The nonce the client sent. Kept only so the ledger can show it was dropped. */
  nonce: string | null;
  email: string;
  expires_at: number;
  used: boolean;
}

/** An access token and its paired refresh token. */
export interface MiroOAuthToken extends Entity {
  access_token: string;
  refresh_token: string;
  client_id: string;
  email: string;
  scope: string;
  expires_at: number;
  revoked: boolean;
}

/**
 * How the token endpoint treats the authorization request nonce.
 *  - "omit": Miro's real behaviour. The ID token never carries `nonce`.
 *  - "echo": the OIDC Core behaviour, for comparing a client against a compliant provider.
 */
export type MiroIdTokenNonceMode = "omit" | "echo";

export interface MiroConfig {
  id_token_nonce: MiroIdTokenNonceMode;
}
