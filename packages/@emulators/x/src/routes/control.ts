import type { Context, RouteContext } from "@emulators/core";
import { getXStore } from "../store.js";
import type { XUser } from "../entities.js";
import { findEvent, findMediaByKey, mediaKeyPrefix, nextStoredId } from "../dm-model.js";
import {
  crcAnswerValid,
  crcUrl,
  expectedCrcTokens,
  getCrcDeliveryMode,
  prepareDmDeliveries,
  setCrcDeliveryMode,
} from "../activity.js";
import { clearRateWindows, getRateLimitConfig, rateLimitState, setRateLimitConfig } from "../rate-limits.js";
import { ensureOneToOne, storeAndDeliverMessage } from "./dm.js";
import type { XSeedAttachment } from "../dm-seed.js";

/**
 * X-specific control calls under `/_emulate/x`. They are emulator controls, not
 * provider routes, so they stay out of the provider ledger like the rest of
 * `/_emulate`; the webhook deliveries they make are recorded by the dispatcher
 * and appear in `/_emulate/logs`.
 */
export function controlRoutes({ app, store, baseUrl, webhooks }: RouteContext): void {
  const xs = getXStore(store);

  function bad(c: Context, message: string, status: 400 | 404 = 400) {
    return c.json({ error: status === 404 ? "not_found" : "invalid_request", message }, status);
  }

  function findUser(ref: unknown): XUser | undefined {
    if (typeof ref !== "string" || !ref) return undefined;
    return xs.users.findOneBy("user_id", ref) ?? xs.users.findOneBy("username", ref.toLowerCase().replace(/^@/, ""));
  }

  /**
   * POST /_emulate/x/dm/arrive: a message "arrives" for `to` from `from`, as if
   * sent from another client. It is stored (so reads return it) and delivered as
   * X Activity API events: dm.received to the recipient's subscriptions and
   * dm.sent to the sender's.
   * Body: { to, from, text?, attachment?: { bytes?, media_type? }, conversation_id? }
   */
  app.post("/_emulate/x/dm/arrive", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const to = findUser(body.to);
    if (!to) return bad(c, "`to` must name a seeded user (username or id).", 404);
    const from = findUser(body.from);
    if (!from) return bad(c, "`from` must name a seeded user (username or id).", 404);
    let conv;
    if (typeof body.conversation_id === "string") {
      conv = xs.dmConversations.findOneBy("conversation_id", body.conversation_id);
      if (!conv) return bad(c, `No conversation ${body.conversation_id}.`, 404);
      if (!conv.participant_ids.includes(to.user_id) || !conv.participant_ids.includes(from.user_id)) {
        return bad(c, "Both users must be participants in the conversation.");
      }
    } else {
      conv = ensureOneToOne(store, to.user_id, from.user_id);
    }
    const text = typeof body.text === "string" && body.text.length > 0 ? body.text : null;
    const mediaKeys: string[] = [];
    if (body.attachment && typeof body.attachment === "object") {
      const a = body.attachment as XSeedAttachment;
      const mediaType = a.media_type ?? "image/jpeg";
      const category = mediaType === "image/gif" ? "dm_gif" : mediaType.startsWith("video/") ? "dm_video" : "dm_image";
      const mediaId = nextStoredId(store);
      const key = `${mediaKeyPrefix(category, mediaType)}${mediaId}`;
      xs.media.insert({
        media_id: mediaId,
        media_key: key,
        owner_id: from.user_id,
        additional_owners: [],
        media_category: category,
        media_type: mediaType,
        size: Number.isInteger(a.bytes) && (a.bytes as number) >= 0 ? (a.bytes as number) : 256 * 1024,
        state: "succeeded",
        source: "seeded",
        width: a.width ?? 1200,
        height: a.height ?? 800,
        created_at_ms: Date.now(),
        expires_at_ms: Date.now() + 24 * 3600 * 1000,
      });
      mediaKeys.push(key);
    }
    if (!text && mediaKeys.length === 0) return bad(c, "Give `text`, `attachment`, or both.");
    const { view, deliveries } = await storeAndDeliverMessage(store, baseUrl, webhooks, {
      sender: from,
      conv,
      text,
      mediaKeys,
    });
    return c.json({
      dm_event_id: view.id,
      dm_conversation_id: conv.conversation_id,
      media_keys: mediaKeys,
      deliveries,
    });
  });

  /**
   * POST /_emulate/x/dm/preview-delivery: exactly what X would POST for a DM
   * event (address, headers with signatures, raw body), without sending it. The
   * bytes match a real delivery of the same event, so a test can POST them to
   * its own app.
   * Body: { dm_event_id, for_user_id?, include_invalid? }
   */
  app.post("/_emulate/x/dm/preview-delivery", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const id = typeof body.dm_event_id === "string" ? body.dm_event_id : "";
    const found = findEvent(store, id);
    if (!found) return bad(c, `No DM event ${id}.`, 404);
    const forUser = body.for_user_id !== undefined ? findUser(body.for_user_id) : undefined;
    if (body.for_user_id !== undefined && !forUser) return bad(c, "`for_user_id` must name a seeded user.", 404);
    const deliveries = prepareDmDeliveries(store, baseUrl, found.view, found.conv.participant_ids, {
      forUserId: forUser?.user_id,
      includeInvalid: body.include_invalid === true,
    });
    return c.json({ deliveries });
  });

  /**
   * CRC delivery mode. `outbound` (the default) is X's behaviour: the emulator
   * sends the challenge to the webhook address at creation and on PUT and refuses
   * a wrong answer. `control` is the emulator's own mode for tests the emulator
   * cannot reach: creation succeeds without an outbound request, and each
   * challenge is held for the test to fetch, deliver to its app, and report back.
   * Body: { mode: "outbound" | "control" }
   */
  app.get("/_emulate/x/webhooks/crc-delivery", (c) => c.json({ mode: getCrcDeliveryMode(store) }));
  app.post("/_emulate/x/webhooks/crc-delivery", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    try {
      return c.json({ mode: setCrcDeliveryMode(store, body.mode) });
    } catch (err) {
      return bad(c, err instanceof Error ? err.message : "Invalid mode.");
    }
  });

  /**
   * GET /_emulate/x/webhooks/:webhook_id/challenge: the challenge held for this
   * webhook (control mode): the exact GET X would send and the answers it accepts.
   */
  app.get("/_emulate/x/webhooks/:webhook_id/challenge", (c) => {
    const webhook = xs.webhooks.findOneBy("webhook_id", c.req.param("webhook_id"));
    if (!webhook) return bad(c, "No such webhook.", 404);
    const pending = xs.pendingChallenges.findOneBy("webhook_id", webhook.webhook_id);
    if (!pending) {
      return bad(c, "No challenge is held for this webhook (holding happens only in control CRC mode).", 404);
    }
    const client = xs.oauthClients.findOneBy("client_id", webhook.client_id);
    return c.json({
      webhook_id: webhook.webhook_id,
      method: "GET",
      url: crcUrl(webhook.url, pending.crc_token),
      crc_token: pending.crc_token,
      expected_response_tokens: client ? expectedCrcTokens(client, pending.crc_token) : [],
      answered: pending.answered,
      valid: pending.valid,
    });
  });

  /**
   * POST /_emulate/x/webhooks/:webhook_id/challenge: report the app's answer to
   * the held challenge (`{ response_token }`, or `{ response: <the app's JSON> }`).
   * It is checked as X checks it; a wrong answer marks the webhook invalid, so
   * it stops receiving deliveries.
   */
  app.post("/_emulate/x/webhooks/:webhook_id/challenge", async (c) => {
    const webhook = xs.webhooks.findOneBy("webhook_id", c.req.param("webhook_id"));
    if (!webhook) return bad(c, "No such webhook.", 404);
    const pending = xs.pendingChallenges.findOneBy("webhook_id", webhook.webhook_id);
    if (!pending) return bad(c, "No challenge is held for this webhook.", 404);
    const client = xs.oauthClients.findOneBy("client_id", webhook.client_id);
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const answer =
      body.response_token ?? (body.response as Record<string, unknown> | undefined)?.response_token ?? undefined;
    const valid = !!client && crcAnswerValid(client, pending.crc_token, answer);
    xs.pendingChallenges.update(pending.id, { answered: true, valid });
    xs.webhooks.update(webhook.id, { valid });
    return c.json({ webhook_id: webhook.webhook_id, valid });
  });

  /** GET /_emulate/x/media/:media_key: metadata for a media key (uploaded, seeded or generated). */
  app.get("/_emulate/x/media/:media_key", (c) => {
    const media = findMediaByKey(store, c.req.param("media_key"));
    return media ? c.json({ media }) : bad(c, "No such media.", 404);
  });

  // Rate limits: configuration and the open windows.
  app.get("/_emulate/x/rate-limits", (c) =>
    c.json({ config: getRateLimitConfig(store), windows: rateLimitState(store) }),
  );
  app.post("/_emulate/x/rate-limits", async (c) => {
    const body = await c.req.json().catch(() => undefined);
    try {
      const config = setRateLimitConfig(store, body);
      clearRateWindows(store);
      return c.json({ config, windows: [] });
    } catch (err) {
      return bad(c, err instanceof Error ? err.message : "Invalid rate limit configuration.");
    }
  });
  app.delete("/_emulate/x/rate-limits/windows", (c) => {
    clearRateWindows(store);
    return c.json({ windows: [] });
  });
}
