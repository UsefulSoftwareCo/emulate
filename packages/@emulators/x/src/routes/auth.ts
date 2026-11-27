import type { Context, Store } from "@emulators/core";
import { getXStore, lookupAccessToken } from "../store.js";
import type { XAccessToken, XUser } from "../entities.js";

/**
 * Extract and resolve the bearer token presented on a v2 API request. Returns the
 * matching access-token row (app-only or user-context) or `null`.
 *
 * X tokens live in the store rather than the core token map, so this is also
 * where the request's identity is recorded for the ledger: `authUser` for a
 * user-context token (with X's 19-digit id as `externalId`) and `authApp` for
 * the app that holds the token.
 */
export function resolveToken(store: Store, c: Context): XAccessToken | null {
  const m = /^Bearer\s+(.+)$/i.exec(c.req.header("Authorization") ?? "");
  if (!m) return null;
  const token = lookupAccessToken(store, m[1].trim()) ?? null;
  if (token) recordIdentity(store, c, token);
  return token;
}

/** Record the token's user and app on the request for the ledger. */
export function recordIdentity(store: Store, c: Context, token: XAccessToken): void {
  const xs = getXStore(store);
  const client = xs.oauthClients.findOneBy("client_id", token.client_id);
  if (client) c.set("authApp", { appId: client.id, slug: client.client_id, name: client.name });
  if (token.app_only || !token.user_id) {
    c.set("authUser", undefined);
    return;
  }
  const user = xs.users.findOneBy("user_id", token.user_id);
  c.set("authUser", {
    login: user?.username ?? token.user_id,
    id: user?.id ?? 0,
    scopes: token.scopes,
    externalId: token.user_id,
  });
}

/** X v2 error envelope for a missing or invalid bearer token (HTTP 401). */
export function unauthorized(c: Context) {
  return c.json(
    {
      title: "Unauthorized",
      type: "about:blank",
      status: 401,
      detail: "Unauthorized",
    },
    401,
  );
}

/**
 * X v2 error envelope for an authenticated request that lacks the required scope
 * or token type (HTTP 403). Used when an app-only token hits a user-context
 * endpoint, or when a user token is missing a required scope.
 */
export function forbidden(c: Context, detail: string) {
  return c.json(
    {
      title: "Forbidden",
      type: "https://api.twitter.com/2/problems/oauth2-insufficient-scope",
      status: 403,
      detail,
    },
    403,
  );
}

/** True when the token is a user-context token that holds every required scope. */
export function hasUserScope(token: XAccessToken, ...required: string[]): boolean {
  if (token.app_only) return false;
  return required.every((s) => token.scopes.includes(s));
}

/**
 * Resolve a user-context token that holds every scope in `required` and the user
 * it belongs to, or the response X gives when it does not: 401 for no or an
 * unknown token, 403 for an app-only token or a missing scope.
 */
export function requireUserContext(
  store: Store,
  c: Context,
  required: string[],
): { token: XAccessToken; user: XUser } | { response: Response } {
  const token = resolveToken(store, c);
  if (!token) return { response: unauthorized(c) };
  if (token.app_only) {
    return {
      response: forbidden(
        c,
        "This endpoint requires a user-context OAuth 2.0 token; an app-only token has no user and cannot access Direct Messages or upload media.",
      ),
    };
  }
  const missing = required.filter((s) => !token.scopes.includes(s));
  if (missing.length > 0) {
    return {
      response: forbidden(c, `Your token is missing the ${missing.join(", ")} scope required by this endpoint.`),
    };
  }
  const user = token.user_id ? getXStore(store).users.findOneBy("user_id", token.user_id) : undefined;
  if (!user) return { response: unauthorized(c) };
  return { token, user };
}

/**
 * Resolve an app-only Bearer token (OAuth 2.0 client credentials), or the 401/403
 * X returns otherwise.
 */
export function requireAppOnly(store: Store, c: Context): { token: XAccessToken } | { response: Response } {
  const token = resolveToken(store, c);
  if (!token) return { response: unauthorized(c) };
  if (!token.app_only) {
    return {
      response: forbidden(c, "This endpoint requires an app-only Bearer token (OAuth 2.0 client credentials)."),
    };
  }
  return { token };
}
