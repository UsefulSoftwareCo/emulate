import type { RouteContext } from "@emulators/core";
import type { SlackChannel } from "../entities.js";
import { getSlackStore } from "../store.js";
import { formatSlackMessage, slackOk, slackError, parseSlackBody, requireSlackScopes } from "../helpers.js";

export function reactionsRoutes(ctx: RouteContext): void {
  const { app, store, webhooks } = ctx;
  const ss = () => getSlackStore(store);
  const getAuthSlackUser = (authUser: { login: string }) =>
    ss().users.findOneBy("user_id", authUser.login) ?? ss().users.findOneBy("name", authUser.login);
  const isAuthChannelMember = (channel: SlackChannel, authUser: { login: string }) => {
    const user = getAuthSlackUser(authUser);
    const userId = user?.user_id ?? authUser.login;
    return channel.members.includes(userId) || (user ? channel.members.includes(user.name) : false);
  };
  const canAccessConversation = (channel: SlackChannel, authUser: { login: string }) =>
    !channel.is_private || isAuthChannelMember(channel, authUser);

  // reactions.add
  app.post("/api/reactions.add", async (c) => {
    const authUser = c.get("authUser");
    if (!authUser) return slackError(c, "not_authed");
    const scopeError = requireSlackScopes(c, store, ["reactions:write"]);
    if (scopeError) return scopeError;

    const body = await parseSlackBody(c);
    const channel = typeof body.channel === "string" ? body.channel : "";
    const timestamp = typeof body.timestamp === "string" ? body.timestamp : "";
    const name = typeof body.name === "string" ? body.name : "";

    if (!name) return slackError(c, "invalid_name");

    const ch = ss().channels.findOneBy("channel_id", channel);
    if (ch && !canAccessConversation(ch, authUser)) return slackError(c, "not_in_channel");

    const msg = ss()
      .messages.all()
      .find((m) => m.ts === timestamp && m.channel_id === channel);
    if (!msg) return slackError(c, "message_not_found");

    const reactions = [...msg.reactions];
    const existing = reactions.find((r) => r.name === name);
    if (existing) {
      if (existing.users.includes(authUser.login)) {
        return slackError(c, "already_reacted");
      }
      existing.users.push(authUser.login);
      existing.count++;
    } else {
      reactions.push({ name, users: [authUser.login], count: 1 });
    }

    ss().messages.update(msg.id, { reactions });

    await webhooks.dispatch(
      "reaction_added",
      undefined,
      {
        type: "event_callback",
        event: {
          type: "reaction_added",
          user: authUser.login,
          reaction: name,
          item: { type: "message", channel, ts: timestamp },
        },
      },
      "slack",
    );

    return slackOk(c, {});
  });

  // reactions.remove
  app.post("/api/reactions.remove", async (c) => {
    const authUser = c.get("authUser");
    if (!authUser) return slackError(c, "not_authed");
    const scopeError = requireSlackScopes(c, store, ["reactions:write"]);
    if (scopeError) return scopeError;

    const body = await parseSlackBody(c);
    const channel = typeof body.channel === "string" ? body.channel : "";
    const timestamp = typeof body.timestamp === "string" ? body.timestamp : "";
    const name = typeof body.name === "string" ? body.name : "";

    if (!name) return slackError(c, "invalid_name");

    const ch = ss().channels.findOneBy("channel_id", channel);
    if (ch && !canAccessConversation(ch, authUser)) return slackError(c, "not_in_channel");

    const msg = ss()
      .messages.all()
      .find((m) => m.ts === timestamp && m.channel_id === channel);
    if (!msg) return slackError(c, "message_not_found");

    const reactions = [...msg.reactions];
    const existing = reactions.find((r) => r.name === name);
    if (!existing || !existing.users.includes(authUser.login)) {
      return slackError(c, "no_reaction");
    }

    existing.users = existing.users.filter((u) => u !== authUser.login);
    existing.count--;

    const filtered = reactions.filter((r) => r.count > 0);
    ss().messages.update(msg.id, { reactions: filtered });

    await webhooks.dispatch(
      "reaction_removed",
      undefined,
      {
        type: "event_callback",
        event: {
          type: "reaction_removed",
          user: authUser.login,
          reaction: name,
          item: { type: "message", channel, ts: timestamp },
        },
      },
      "slack",
    );

    return slackOk(c, {});
  });

  // reactions.get
  app.post("/api/reactions.get", async (c) => {
    const authUser = c.get("authUser");
    if (!authUser) return slackError(c, "not_authed");
    const scopeError = requireSlackScopes(c, store, ["reactions:read"]);
    if (scopeError) return scopeError;

    const body = await parseSlackBody(c);
    const channel = typeof body.channel === "string" ? body.channel : "";
    const timestamp = typeof body.timestamp === "string" ? body.timestamp : "";

    const ch = ss().channels.findOneBy("channel_id", channel);
    if (ch && !canAccessConversation(ch, authUser)) return slackError(c, "not_in_channel");

    const msg = ss()
      .messages.all()
      .find((m) => m.ts === timestamp && m.channel_id === channel);
    if (!msg) return slackError(c, "message_not_found");

    return slackOk(c, {
      type: "message",
      message: { ...formatSlackMessage(msg), reactions: msg.reactions },
    });
  });
}
