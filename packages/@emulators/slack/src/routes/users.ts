import type { Context, RouteContext } from "@emulators/core";
import { getSlackStore } from "../store.js";
import {
  slackOk,
  slackError,
  parseSlackBody,
  requireSlackScopes,
  isSlackStrictScopes,
  hasSlackScope,
} from "../helpers.js";
import type { SlackUser } from "../entities.js";

export function usersRoutes(ctx: RouteContext): void {
  const { app, store } = ctx;
  const ss = () => getSlackStore(store);

  // users.list
  app.post("/api/users.list", async (c) => {
    const authUser = c.get("authUser");
    if (!authUser) return slackError(c, "not_authed");
    const scopeError = requireSlackScopes(c, store, ["users:read"]);
    if (scopeError) return scopeError;

    const body = await parseSlackBody(c);
    const limit = Math.min(Number(body.limit) || 100, 1000);
    const cursor = typeof body.cursor === "string" ? body.cursor : "";

    const allUsers = ss()
      .users.all()
      .filter((u) => !u.deleted);

    let startIndex = 0;
    if (cursor) {
      const idx = allUsers.findIndex((u) => u.user_id === cursor);
      if (idx >= 0) startIndex = idx;
    }

    const page = allUsers.slice(startIndex, startIndex + limit);
    const nextCursor = startIndex + limit < allUsers.length ? allUsers[startIndex + limit].user_id : "";

    return slackOk(c, {
      members: page.map((user) => formatUser(user, canExposeEmail(c))),
      response_metadata: { next_cursor: nextCursor },
    });
  });

  // users.info
  app.post("/api/users.info", async (c) => {
    const authUser = c.get("authUser");
    if (!authUser) return slackError(c, "not_authed");
    const scopeError = requireSlackScopes(c, store, ["users:read"]);
    if (scopeError) return scopeError;

    const body = await parseSlackBody(c);
    const userId = typeof body.user === "string" ? body.user : "";

    const user = ss().users.findOneBy("user_id", userId);
    if (!user) return slackError(c, "user_not_found");

    return slackOk(c, { user: formatUser(user, canExposeEmail(c)) });
  });

  // users.lookupByEmail
  app.post("/api/users.lookupByEmail", async (c) => {
    const authUser = c.get("authUser");
    if (!authUser) return slackError(c, "not_authed");
    const scopeError = requireSlackScopes(c, store, ["users:read", "users:read.email"]);
    if (scopeError) return scopeError;

    const body = await parseSlackBody(c);
    const email = typeof body.email === "string" ? body.email : "";

    if (!email) return slackError(c, "users_not_found");

    const user = ss().users.findOneBy("email", email);
    if (!user) return slackError(c, "users_not_found");

    return slackOk(c, { user: formatUser(user, true) });
  });

  function canExposeEmail(c: Context): boolean {
    return !isSlackStrictScopes(store) || hasSlackScope(c, "users:read.email");
  }
}

function formatUser(u: SlackUser, includeEmail = true) {
  const profile = includeEmail ? u.profile : omitEmail(u.profile);
  return {
    id: u.user_id,
    team_id: u.team_id,
    name: u.name,
    real_name: u.real_name,
    is_admin: u.is_admin,
    is_bot: u.is_bot,
    deleted: u.deleted,
    profile,
  };
}

function omitEmail(profile: SlackUser["profile"]): Omit<SlackUser["profile"], "email"> {
  const { email: _email, ...rest } = profile;
  return rest;
}
