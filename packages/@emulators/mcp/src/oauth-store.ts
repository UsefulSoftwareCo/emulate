import type { Store } from "@emulators/core";

// A dynamically-registered OAuth client (RFC 7591). Stored in the core Store's
// data map so it survives snapshot/restore (DO eviction) like every other piece
// of emulator state.
export interface OAuthClientRecord {
  client_id: string;
  client_secret?: string;
  redirect_uris: string[];
  client_name?: string;
  token_endpoint_auth_method: string;
  created_at: number;
}

// A pending authorization code, bound to the client + PKCE challenge + the
// RFC 8707 resource it was requested for, and the github user that approved it.
export interface PendingAuthCode {
  client_id: string;
  redirect_uri: string;
  code_challenge: string | null;
  code_challenge_method: string | null;
  resource: string | null;
  scope: string;
  login: string;
  userId: number;
  created_at: number;
}

const CLIENTS_KEY = "mcp.oauthClients";
const CODES_KEY = "mcp.oauthCodes";

const CODE_TTL_MS = 10 * 60 * 1000;

export function getOAuthClients(store: Store): Map<string, OAuthClientRecord> {
  let map = store.getData<Map<string, OAuthClientRecord>>(CLIENTS_KEY);
  if (!map) {
    map = new Map();
    store.setData(CLIENTS_KEY, map);
  }
  return map;
}

export function getPendingCodes(store: Store): Map<string, PendingAuthCode> {
  let map = store.getData<Map<string, PendingAuthCode>>(CODES_KEY);
  if (!map) {
    map = new Map();
    store.setData(CODES_KEY, map);
  }
  return map;
}

export function isCodeExpired(code: PendingAuthCode): boolean {
  return Date.now() - code.created_at > CODE_TTL_MS;
}
