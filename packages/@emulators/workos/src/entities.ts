import type { Entity } from "@emulators/core";

/** AuthKit user. */
export interface WorkosUser extends Entity {
  workos_id: string; // user_...
  email: string;
  first_name: string | null;
  last_name: string | null;
  email_verified: boolean;
  profile_picture_url: string | null;
}

export interface WorkosOrganization extends Entity {
  workos_id: string; // org_...
  name: string;
  external_id: string | null;
}

/** Domain claimed by an organization for join-by-domain and SSO flows. */
export interface WorkosOrganizationDomain extends Entity {
  workos_id: string; // org_domain_...
  organization_id: string; // org workos_id
  domain: string;
  state: "pending" | "verified" | "failed";
  verification_strategy: "dns" | "manual";
  verification_token: string | null;
  verification_prefix: string | null;
}

export interface WorkosMembership extends Entity {
  workos_id: string; // om_...
  user_id: string; // user workos_id
  organization_id: string; // org workos_id
  status: "active" | "pending" | "inactive";
  role_slug: string;
}

export interface WorkosInvitation extends Entity {
  workos_id: string; // invitation_...
  email: string;
  organization_id: string;
  inviter_user_id: string | null;
  role_slug: string | null;
  state: "pending" | "accepted" | "expired" | "revoked";
  token: string;
  expires_at: string;
}

export interface WorkosApiKey extends Entity {
  workos_id: string; // key_...
  name: string;
  value: string; // sk_...
  user_id: string;
  organization_id: string;
  last_used_at: string | null;
}

/** One-time authorization code issued by the hosted login page. */
export interface WorkosAuthCode extends Entity {
  code: string;
  user_id: string;
  organization_id: string | null;
  client_id: string;
  redirect_uri: string;
  used: boolean;
}

/** Refresh-token-keyed session (rotated on refresh). */
export interface WorkosSession extends Entity {
  workos_id: string; // session_...
  refresh_token: string;
  user_id: string;
  organization_id: string | null;
  client_id: string;
  revoked: boolean;
  /** Space-delimited granted scopes (null for user-management sessions). */
  scope: string | null;
}

/** Vault KV object. */
export interface WorkosVaultObject extends Entity {
  workos_id: string; // kv_...
  name: string;
  value: string;
  key_context: Record<string, unknown>;
  version_id: string;
}

/** Singleton OAuth-surface settings (emulate control, set via /_emulate/seed `oauth`). */
export interface WorkosOAuthSettings extends Entity {
  /** Default access-token TTL for clients without a per-client override. */
  default_access_token_ttl_seconds: number | null;
}

/** Dynamically-registered OAuth client (AuthKit MCP surface). */
export interface WorkosOAuthClient extends Entity {
  client_id: string;
  client_secret: string | null;
  redirect_uris: string[];
  name: string | null;
  /** Emulate extension (DCR field `access_token_ttl_seconds`): per-client TTL so tests can compress the token lifecycle. */
  access_token_ttl_seconds: number | null;
}

/** One-time code for the /oauth2/authorize surface (MCP clients). */
export interface WorkosOAuthCode extends Entity {
  code: string;
  user_id: string;
  organization_id: string | null;
  client_id: string;
  redirect_uri: string;
  code_challenge: string | null;
  /** Space-delimited scopes the client requested at /oauth2/authorize. */
  scope: string | null;
  used: boolean;
}
