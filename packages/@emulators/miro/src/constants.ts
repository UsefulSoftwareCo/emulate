import { randomBytes, randomUUID } from "crypto";

export const SERVICE_LABEL = "Miro";

// Captured from https://mcp.miro.com/.well-known/oauth-authorization-server and
// /.well-known/openid-configuration.
export const SCOPES_SUPPORTED = ["boards:read", "boards:write", "openid", "email"];

// Miro advertises the jwt-bearer grant. The emulator advertises it too, so the
// metadata a client reads matches production, but the token endpoint does not
// implement it (see the manifest coverage).
export const GRANT_TYPES_ADVERTISED = [
  "authorization_code",
  "refresh_token",
  "urn:ietf:params:oauth:grant-type:jwt-bearer",
];
export const JWT_BEARER_GRANT = "urn:ietf:params:oauth:grant-type:jwt-bearer";

export const SERVICE_DOCUMENTATION = "https://developers.miro.com/docs/miro-mcp#installing-miro-mcp-team-selection";

// Not observable without signing in to real Miro; these are assumptions.
export const ACCESS_TOKEN_TTL_SECONDS = 3600;
export const ID_TOKEN_TTL_SECONDS = 3600;
export const AUTHORIZATION_CODE_TTL_MS = 5 * 60 * 1000;

/** The 401 body Miro's gateway returns for any request without a valid bearer token. */
export const AUTHENTICATION_REQUIRED = { error: "Authentication required" } as const;

// Client id and secret formats are not observable without registering against
// real Miro. These follow the MCP Python SDK registration handler, whose
// validation messages Miro's /register and /authorize errors match exactly.
export function generateClientId(): string {
  return randomUUID();
}

export function generateClientSecret(): string {
  return randomBytes(32).toString("hex");
}

export function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Miro board ids look like `uXjVK1a2b3c=`: `uXjV` then 7 url-safe characters and `=`. */
export function generateBoardId(): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";
  let out = "uXjV";
  for (const byte of randomBytes(7)) out += alphabet[byte % alphabet.length];
  return `${out}=`;
}

/** Miro user ids are 19 digit numeric strings. */
export function generateUserId(): string {
  let out = "3458764";
  for (const byte of randomBytes(12)) out += String(byte % 10);
  return out;
}
