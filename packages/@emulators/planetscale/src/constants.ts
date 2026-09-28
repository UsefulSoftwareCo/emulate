import { randomBytes } from "crypto";

export const SERVICE_LABEL = "PlanetScale";
export const MCP_PATH = "/mcp/planetscale";

// Scopes PlanetScale's Doorkeeper server grants a dynamically registered client.
// The real registration endpoint ignores the requested `scope` and answers with
// exactly this set, in this order.
export const DCR_DEFAULT_SCOPES = [
  "email",
  "openid",
  "profile",
  "database:manage_passwords",
  "database:manage_production_branch_passwords",
  "database:manage_read_only_passwords",
  "database:manage_production_read_only_passwords",
  "database:read_branches",
  "database:read_database",
  "database:read_deploy_requests",
  "organization:create_databases",
  "organization:manage_passwords",
  "organization:manage_production_branch_passwords",
  "organization:manage_read_only_passwords",
  "organization:manage_production_read_only_passwords",
  "organization:read_audit_logs",
  "organization:read_branches",
  "organization:read_databases",
  "organization:read_invoices",
  "organization:read_organization",
  "organization:read_payment_method",
  "organization:write_payment_method",
  "user:read_organizations",
  "user:read_user",
  "read_databases",
  "read_organization",
  "read_organizations",
  "read_user",
];

// A representative subset of the real `scopes_supported` list: the legacy broad
// scopes, the OIDC scopes, and every scope in the DCR default set.
export const SCOPES_SUPPORTED = [
  "read_databases",
  "read_user",
  "read_organization",
  "read_organizations",
  "email",
  "openid",
  "profile",
  "write_databases",
  "write_user",
  "write_organization",
  "branch:read_branch",
  "branch:write_branch",
  ...DCR_DEFAULT_SCOPES.filter((scope) => scope.includes(":")),
  "database:write_database",
  "organization:write_databases",
  "organization:write_organization",
  "user:write_user",
].filter((scope, index, all) => all.indexOf(scope) === index);

// The grants this emulator implements. The real server also advertises
// device_code and client_credentials; they are omitted here rather than
// advertised and then rejected.
export const SUPPORTED_GRANT_TYPES = ["authorization_code", "refresh_token"];

export const ACCESS_TOKEN_TTL_SECONDS = 7200;
export const AUTHORIZATION_CODE_TTL_MS = 10 * 60 * 1000;

// Doorkeeper's exact error descriptions, captured from the real token endpoint.
export const ERROR_DESCRIPTIONS = {
  invalid_client:
    "Client authentication failed due to unknown client, no client authentication included, or unsupported authentication method.",
  invalid_grant:
    "The provided authorization grant is invalid, expired, revoked, does not match the redirection URI used in the authorization request, or was issued to another client.",
  unsupported_grant_type: "The authorization grant type is not supported by the authorization server.",
  invalid_scope: "The requested scope is invalid, unknown, or malformed.",
  unsupported_response_type: "The authorization server does not support this response type.",
  invalid_redirect_uri: "The requested redirect uri is malformed or doesn't match client redirect URI.",
  access_denied: "The resource owner or authorization server denied the request.",
} as const;

export const missingParam = (name: string) => `Missing required parameter: ${name}.`;

/** `pscale_app_` followed by 32 hex characters, 43 characters in total. */
export function generateClientId(): string {
  return `pscale_app_${randomBytes(16).toString("hex")}`;
}

/** `pscale_app_secret_` followed by 43 url-safe base64 characters, 61 characters in total. */
export function generateClientSecret(): string {
  return `pscale_app_secret_${randomBytes(32).toString("base64url")}`;
}

/** Doorkeeper's default opaque token: 32 random bytes, url-safe base64. */
export function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

/** PlanetScale's 12 character lowercase public ids. */
export function generatePublicId(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = randomBytes(12);
  let out = "";
  for (const byte of bytes) out += alphabet[byte % alphabet.length];
  return out;
}
