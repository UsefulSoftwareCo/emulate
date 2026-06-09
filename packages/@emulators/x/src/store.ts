import { Store, type Collection } from "@emulators/core";
import type { XUser, XTweet, XOAuthClient, XAuthCode, XAccessToken, XRefreshToken } from "./entities.js";

export interface XStore {
  users: Collection<XUser>;
  tweets: Collection<XTweet>;
  oauthClients: Collection<XOAuthClient>;
  authCodes: Collection<XAuthCode>;
  accessTokens: Collection<XAccessToken>;
  refreshTokens: Collection<XRefreshToken>;
}

export function getXStore(store: Store): XStore {
  return {
    users: store.collection<XUser>("x.users", ["user_id", "username"]),
    tweets: store.collection<XTweet>("x.tweets", ["tweet_id", "author_id"]),
    oauthClients: store.collection<XOAuthClient>("x.oauth_clients", ["client_id"]),
    authCodes: store.collection<XAuthCode>("x.auth_codes", ["code", "client_id"]),
    accessTokens: store.collection<XAccessToken>("x.access_tokens", ["token", "client_id"]),
    refreshTokens: store.collection<XRefreshToken>("x.refresh_tokens", ["token", "client_id"]),
  };
}

/**
 * Resolve an access token from the store. Returns the token row if it exists and
 * has not expired (expired rows are dropped on read). This is how both the
 * app-only BearerToken and the user-context OAuth2UserToken are validated, since
 * X tokens are opaque (not the core tokenMap, which isn't persisted across DO
 * eviction) and we need to distinguish app-only from user context per request.
 */
export function lookupAccessToken(store: Store, token: string): XAccessToken | undefined {
  const xs = getXStore(store);
  const row = xs.accessTokens.findOneBy("token", token);
  if (!row) return undefined;
  if (row.expires > 0 && Date.now() > row.expires) {
    xs.accessTokens.delete(row.id);
    return undefined;
  }
  return row;
}

/** X v2 numeric snowflake-style id (a long decimal string). */
export function xNumericId(): string {
  let s = "";
  for (let i = 0; i < 19; i++) {
    s += Math.floor(Math.random() * 10).toString();
  }
  // Avoid a leading zero so the id reads like a real snowflake.
  return s[0] === "0" ? "1" + s.slice(1) : s;
}
