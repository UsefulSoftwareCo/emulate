import type { Entity } from "@emulators/core";

/** A PlanetScale account that can sign in on the consent page. */
export interface PlanetScaleUser extends Entity {
  /** Stable handle used on the consent page and in the ledger. */
  login: string;
  name: string | null;
  email: string | null;
}

export interface PlanetScaleOrganization extends Entity {
  /** PlanetScale's public 12 character id. */
  public_id: string;
  name: string;
  plan: string;
}

export interface PlanetScaleDatabase extends Entity {
  public_id: string;
  organization: string;
  name: string;
  kind: "mysql" | "postgresql";
  region: string;
  state: string;
  default_branch: string;
}

export interface PlanetScaleBranch extends Entity {
  public_id: string;
  organization: string;
  database: string;
  name: string;
  production: boolean;
  parent_branch: string | null;
}

/** A Doorkeeper OAuth application, created by Dynamic Client Registration or seed. */
export interface PlanetScaleOAuthClient extends Entity {
  client_id: string;
  client_secret: string;
  client_name: string;
  redirect_uris: string[];
  token_endpoint_auth_method: string;
  grant_types: string[];
  response_types: string[];
  scope: string;
  application_type: string;
  client_id_issued_at: number;
}

/** An authorization code issued by the consent page. */
export interface PlanetScaleOAuthGrant extends Entity {
  code: string;
  client_id: string;
  redirect_uri: string;
  scope: string;
  code_challenge: string | null;
  code_challenge_method: string | null;
  resource: string | null;
  login: string;
  expires_at: number;
  revoked: boolean;
}

/** An access token and its paired refresh token. */
export interface PlanetScaleOAuthToken extends Entity {
  access_token: string;
  refresh_token: string;
  client_id: string;
  login: string;
  scope: string;
  expires_at: number;
  revoked: boolean;
}
