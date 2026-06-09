import type { Context, Store } from "@emulators/core";
import { lookupAccessToken } from "../store.js";
import type { XAccessToken } from "../entities.js";

/**
 * Extract and resolve the bearer token presented on a v2 API request. Returns the
 * matching access-token row (app-only or user-context) or `null`.
 */
export function resolveToken(store: Store, c: Context): XAccessToken | null {
  const m = /^Bearer\s+(.+)$/i.exec(c.req.header("Authorization") ?? "");
  if (!m) return null;
  return lookupAccessToken(store, m[1].trim()) ?? null;
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
