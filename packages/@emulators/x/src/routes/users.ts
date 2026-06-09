import type { Context, RouteContext } from "@emulators/core";
import { getXStore } from "../store.js";
import type { XUser } from "../entities.js";
import { resolveToken, unauthorized, forbidden, hasUserScope } from "./auth.js";

/**
 * Format an X user into the v2 user object. The default fields match what the v2
 * API returns without an explicit `user.fields` request, plus the common
 * expansions tools rely on (public_metrics, verified, etc.).
 */
function formatUser(u: XUser): Record<string, unknown> {
  return {
    id: u.user_id,
    name: u.name,
    username: u.username,
    created_at: u.created_at_x,
    description: u.description,
    location: u.location,
    url: u.url,
    protected: u.protected,
    verified: u.verified,
    profile_image_url: u.profile_image_url,
    public_metrics: {
      followers_count: u.followers_count,
      following_count: u.following_count,
      tweet_count: u.tweet_count,
      listed_count: u.listed_count,
    },
  };
}

function notFound(c: Context, detail: string) {
  return c.json(
    {
      errors: [
        {
          title: "Not Found Error",
          type: "https://api.twitter.com/2/problems/resource-not-found",
          detail,
        },
      ],
    },
    404,
  );
}

export function usersRoutes({ app, store }: RouteContext): void {
  const xs = getXStore(store);

  // GET /2/users/me — the authenticated user. Requires a user-context token with
  // the users.read scope (app-only tokens have no user → 403).
  app.get("/2/users/me", (c) => {
    const token = resolveToken(store, c);
    if (!token) return unauthorized(c);
    if (token.app_only) {
      return forbidden(c, "This endpoint requires a user-context OAuth 2.0 token; an app-only token has no user.");
    }
    if (!hasUserScope(token, "users.read")) {
      return forbidden(c, "Your token is missing the users.read scope required by this endpoint.");
    }
    const user = token.user_id ? xs.users.findOneBy("user_id", token.user_id) : undefined;
    if (!user) return unauthorized(c);
    return c.json({ data: formatUser(user) });
  });

  // GET /2/users/:id — app-only bearer OR user token with users.read.
  app.get("/2/users/:id", (c) => {
    const token = resolveToken(store, c);
    if (!token) return unauthorized(c);
    if (!token.app_only && !hasUserScope(token, "users.read")) {
      return forbidden(c, "Your token is missing the users.read scope required by this endpoint.");
    }
    const user = xs.users.findOneBy("user_id", c.req.param("id"));
    if (!user) return notFound(c, `Could not find user with id: [${c.req.param("id")}].`);
    return c.json({ data: formatUser(user) });
  });

  // GET /2/users/by/username/:username — app-only bearer OR user token.
  app.get("/2/users/by/username/:username", (c) => {
    const token = resolveToken(store, c);
    if (!token) return unauthorized(c);
    if (!token.app_only && !hasUserScope(token, "users.read")) {
      return forbidden(c, "Your token is missing the users.read scope required by this endpoint.");
    }
    const username = c.req.param("username").toLowerCase();
    const user = xs.users.findOneBy("username", username);
    if (!user) return notFound(c, `Could not find user with username: [${c.req.param("username")}].`);
    return c.json({ data: formatUser(user) });
  });
}
