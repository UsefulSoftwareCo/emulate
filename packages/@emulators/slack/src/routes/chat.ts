import type { Context, RouteContext } from "@emulators/core";
import type { SlackMessage } from "../entities.js";
import { getSlackStore } from "../store.js";
import {
  formatSlackMessage,
  formatSlackPermalink,
  generateTs,
  hasSlackMessageContent,
  parseSlackBody,
  parseSlackRichMessageFields,
  slackError,
  slackOk,
} from "../helpers.js";

export function chatRoutes(ctx: RouteContext): void {
  const { app, store, webhooks, baseUrl } = ctx;
  const ss = () => getSlackStore(store);

  // chat.postMessage
  app.post("/api/chat.postMessage", async (c) => {
    const authUser = c.get("authUser");
    if (!authUser) return slackError(c, "not_authed");

    const body = await parseSlackBody(c);
    const channel = typeof body.channel === "string" ? body.channel : "";
    const text = typeof body.text === "string" ? body.text : "";
    const thread_ts = typeof body.thread_ts === "string" ? body.thread_ts : undefined;
    const richMessage = parseSlackRichMessageFields(body);
    if (richMessage.error) return slackError(c, richMessage.error);

    if (!channel) return slackError(c, "channel_not_found");
    if (!hasSlackMessageContent(text, richMessage.fields)) return slackError(c, "no_text");

    const ch = ss().channels.findOneBy("channel_id", channel) ?? ss().channels.findOneBy("name", channel);
    if (!ch) return slackError(c, "channel_not_found");
    if (ch.is_archived) return slackError(c, "is_archived");

    const ts = generateTs();
    const msg = ss().messages.insert({
      ts,
      channel_id: ch.channel_id,
      user: authUser.login,
      text,
      type: "message" as const,
      thread_ts,
      ...richMessage.fields,
      reply_count: 0,
      reply_users: [],
      reactions: [],
    });

    // Update parent thread reply count
    if (thread_ts) {
      const parent = ss()
        .messages.all()
        .find((m) => m.ts === thread_ts && m.channel_id === ch.channel_id);
      if (parent) {
        const replyUsers = parent.reply_users.includes(authUser.login)
          ? parent.reply_users
          : [...parent.reply_users, authUser.login];
        ss().messages.update(parent.id, {
          reply_count: parent.reply_count + 1,
          reply_users: replyUsers,
        });
      }
    }

    await webhooks.dispatch(
      "message",
      undefined,
      {
        type: "event_callback",
        event: {
          ...formatSlackMessage(msg),
          type: "message",
          channel: ch.channel_id,
        },
      },
      "slack",
    );

    return slackOk(c, {
      channel: ch.channel_id,
      ts,
      message: formatSlackMessage(msg),
    });
  });

  // chat.update
  app.post("/api/chat.update", async (c) => {
    const authUser = c.get("authUser");
    if (!authUser) return slackError(c, "not_authed");

    const body = await parseSlackBody(c);
    const channel = typeof body.channel === "string" ? body.channel : "";
    const ts = typeof body.ts === "string" ? body.ts : "";
    const hasText = typeof body.text === "string";
    const text = hasText ? (body.text as string) : "";
    const richMessage = parseSlackRichMessageFields(body);
    if (richMessage.error) return slackError(c, richMessage.error);

    if (!channel || !ts) return slackError(c, "message_not_found");

    const msg = ss()
      .messages.all()
      .find((m) => m.ts === ts && m.channel_id === channel);
    if (!msg) return slackError(c, "message_not_found");

    const updates: Partial<SlackMessage> = { ...richMessage.fields };
    if (hasText) {
      updates.text = text;
      if (!richMessage.providedFields.includes("blocks")) updates.blocks = undefined;
      if (!richMessage.providedFields.includes("attachments")) updates.attachments = undefined;
    }

    if (!hasText && Object.keys(updates).length === 0) {
      return slackError(c, "no_text");
    }

    const eventTs = generateTs();
    const updated = ss()
      .messages.update(msg.id, {
        ...updates,
        edited: { user: authUser.login, ts: eventTs },
      })!;

    await webhooks.dispatch(
      "message",
      undefined,
      {
        type: "event_callback",
        event: {
          type: "message",
          subtype: "message_changed",
          hidden: true,
          channel,
          ts: eventTs,
          event_ts: eventTs,
          message: formatSlackMessage(updated),
          previous_message: formatSlackMessage(msg),
        },
      },
      "slack",
    );

    return slackOk(c, {
      channel,
      ts,
      text: updated.text,
      message: formatSlackMessage(updated),
    });
  });

  // chat.delete
  app.post("/api/chat.delete", async (c) => {
    const authUser = c.get("authUser");
    if (!authUser) return slackError(c, "not_authed");

    const body = await parseSlackBody(c);
    const channel = typeof body.channel === "string" ? body.channel : "";
    const ts = typeof body.ts === "string" ? body.ts : "";

    if (!channel || !ts) return slackError(c, "message_not_found");

    const msg = ss()
      .messages.all()
      .find((m) => m.ts === ts && m.channel_id === channel);
    if (!msg) return slackError(c, "message_not_found");

    ss().messages.delete(msg.id);

    const eventTs = generateTs();
    await webhooks.dispatch(
      "message",
      undefined,
      {
        type: "event_callback",
        event: {
          type: "message",
          subtype: "message_deleted",
          hidden: true,
          channel,
          ts: eventTs,
          event_ts: eventTs,
          deleted_ts: ts,
          previous_message: formatSlackMessage(msg),
        },
      },
      "slack",
    );

    return slackOk(c, { channel, ts });
  });

  async function getPermalink(c: Context) {
    const authUser = c.get("authUser");
    if (!authUser) return slackError(c, "not_authed");

    const body = c.req.method === "GET" ? {} : await parseSlackBody(c);
    const channel = typeof body.channel === "string" ? body.channel : (c.req.query("channel") ?? "");
    const messageTs = typeof body.message_ts === "string" ? body.message_ts : (c.req.query("message_ts") ?? "");

    if (!channel) return slackError(c, "channel_not_found");
    if (!messageTs) return slackError(c, "message_not_found");

    const ch = ss().channels.findOneBy("channel_id", channel);
    if (!ch) return slackError(c, "channel_not_found");

    const msg = ss()
      .messages.all()
      .find((m) => m.ts === messageTs && m.channel_id === channel);
    if (!msg) return slackError(c, "message_not_found");

    return slackOk(c, {
      channel,
      permalink: formatSlackPermalink(baseUrl, ch.channel_id, msg),
    });
  }

  // chat.getPermalink
  app.get("/api/chat.getPermalink", getPermalink);
  app.post("/api/chat.getPermalink", getPermalink);

  // chat.meMessage
  app.post("/api/chat.meMessage", async (c) => {
    const authUser = c.get("authUser");
    if (!authUser) return slackError(c, "not_authed");

    const body = await parseSlackBody(c);
    const channel = typeof body.channel === "string" ? body.channel : "";
    const text = typeof body.text === "string" ? body.text : "";

    if (!channel) return slackError(c, "channel_not_found");

    const ch = ss().channels.findOneBy("channel_id", channel) ?? ss().channels.findOneBy("name", channel);
    if (!ch) return slackError(c, "channel_not_found");

    const ts = generateTs();
    ss().messages.insert({
      ts,
      channel_id: ch.channel_id,
      user: authUser.login,
      text,
      type: "message" as const,
      subtype: "me_message",
      reply_count: 0,
      reply_users: [],
      reactions: [],
    });

    return slackOk(c, { channel: ch.channel_id, ts });
  });
}
