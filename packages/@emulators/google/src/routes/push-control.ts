import type { Context, RouteContext } from "@emulators/core";
import { recordSideEffect } from "@emulators/core";
import { createStoredMessage, getCurrentHistoryId } from "../helpers.js";
import { getGoogleStore } from "../store.js";
import {
  deletePushSubscription,
  getWatchStates,
  listPushDeliveries,
  listPushSubscriptions,
  notifyWatchers,
  preparePushes,
  upsertPushSubscription,
} from "../push.js";

/**
 * Gmail push: the notifier that runs after every request, and the emulator's
 * control calls under `/_emulate/google`. Pub/Sub push subscriptions are
 * configured here (or with the `pubsub_push_subscriptions` seed field) because
 * Pub/Sub is a separate API this emulator does not serve.
 */
export function pushRoutes({ app, store, baseUrl }: RouteContext): void {
  const gs = getGoogleStore(store);

  // After any request that moved a watched mailbox's history, notify its topic's
  // push subscriptions. Control calls below notify (or preview) on their own.
  app.use("*", async (c, next) => {
    const res = await next();
    if (getWatchStates(store).size === 0 || c.req.path.startsWith("/_emulate/google/")) return res;
    const sent = await notifyWatchers(store, baseUrl);
    for (const p of sent) {
      recordSideEffect(c, {
        type: "custom",
        collection: "google.pubsub.deliveries",
        id: p.message_id,
        summary: `Gmail push for ${p.email} (historyId ${p.history_id}) to ${p.subscription}: ${p.status_code ?? "no response"}`,
      });
    }
    return res;
  });

  function bad(c: Context, message: string, status: 400 | 404 = 400) {
    return c.json({ error: status === 404 ? "not_found" : "invalid_request", message }, status);
  }

  app.get("/_emulate/google/pubsub/subscriptions", (c) => c.json({ subscriptions: listPushSubscriptions(store) }));

  /** Body: { name, topic, push_endpoint, audience?, service_account_email? (null for no token) } */
  app.post("/_emulate/google/pubsub/subscriptions", async (c) => {
    try {
      return c.json({ subscription: upsertPushSubscription(store, await c.req.json().catch(() => ({}))) });
    } catch (err) {
      return bad(c, err instanceof Error ? err.message : "Invalid subscription.");
    }
  });

  app.delete("/_emulate/google/pubsub/subscriptions", (c) => {
    const name = c.req.query("name") ?? "";
    return deletePushSubscription(store, name) ? c.json({ deleted: true }) : bad(c, `No subscription ${name}.`, 404);
  });

  app.get("/_emulate/google/pubsub/deliveries", (c) => c.json({ deliveries: listPushDeliveries(store) }));

  /**
   * POST /_emulate/google/gmail/arrive: an email arrives in `to`'s INBOX (unread),
   * then the mailbox's watch is notified like any other change.
   * Body: { to, from, subject?, text?, html?, headers?: [{name, value}], label_ids? }
   */
  app.post("/_emulate/google/gmail/arrive", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const to = typeof body.to === "string" ? body.to.toLowerCase() : "";
    if (!to || !gs.users.findOneBy("email", to)) return bad(c, "`to` must be a seeded user's email address.", 404);
    const from = typeof body.from === "string" && body.from ? body.from : "sender@example.com";
    const headers = Array.isArray(body.headers)
      ? (body.headers as Array<Record<string, unknown>>)
          .filter((h) => typeof h?.name === "string" && typeof h?.value === "string")
          .map((h) => ({ name: h.name as string, value: h.value as string }))
      : undefined;
    const message = createStoredMessage(gs, {
      user_email: to,
      from,
      to,
      subject: typeof body.subject === "string" ? body.subject : "",
      body_text: typeof body.text === "string" ? body.text : null,
      body_html: typeof body.html === "string" ? body.html : null,
      label_ids: Array.isArray(body.label_ids) ? (body.label_ids as string[]) : ["INBOX", "UNREAD"],
      headers,
    });
    const pushes = await notifyWatchers(store, baseUrl, to);
    return c.json({
      id: message.gmail_id,
      threadId: message.thread_id,
      historyId: getCurrentHistoryId(gs, to),
      pushes,
    });
  });

  /**
   * POST /_emulate/google/gmail/preview-push: exactly what Pub/Sub would POST for
   * this mailbox's watch (address, headers with the signed OIDC token, raw body),
   * without sending. A test that the emulator cannot reach sends these bytes itself.
   * Body: { email, history_id? } (history_id defaults to the mailbox's current one)
   */
  app.post("/_emulate/google/gmail/preview-push", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const email = typeof body.email === "string" ? body.email.toLowerCase() : "";
    const watch = getWatchStates(store).get(email);
    if (!watch) return bad(c, `No watch is set for ${email || "that address"}; call users.watch first.`, 404);
    const historyId = typeof body.history_id === "string" ? body.history_id : getCurrentHistoryId(gs, email);
    const pushes = await preparePushes(store, baseUrl, watch.topicName, email, historyId);
    return c.json({
      topic: watch.topicName,
      pushes,
      verify: {
        jwks_uri: `${baseUrl}/oauth2/v3/certs`,
        issuer: baseUrl,
        note: "Pub/Sub's real tokens are issued by https://accounts.google.com; the emulator signs with its own published key and issuer.",
      },
    });
  });
}
