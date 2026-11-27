import type { Context, RouteContext, Store } from "@emulators/core";
import { recordSideEffect } from "@emulators/core";
import { getXStore, xNumericId } from "../store.js";
import type { XAccessToken, XWebhook } from "../entities.js";
import { resolveToken, unauthorized, forbidden } from "./auth.js";
import { PROBLEM, invalidRequest, listParam } from "./problems.js";
import {
  DM_ACTIVITY_EVENT_TYPES,
  formatSubscription,
  formatWebhook,
  getCrcDeliveryMode,
  newCrcToken,
  runCrc,
  webhookUrlProblem,
} from "../activity.js";

/**
 * Webhook configs (`/2/webhooks`) and X Activity API subscriptions
 * (`/2/activity/subscriptions`). A webhook belongs to the app that holds the
 * token. See activity.ts for the CRC, signatures and delivery envelope.
 */

/** A failure reason X names for webhook calls (quickstart "Common failure reasons"). */
function webhookFailure(c: Context, reason: string, detail: string, status: 400 | 404 = 400) {
  return c.json(
    {
      errors: [{ message: reason, detail }],
      title: "Invalid Request",
      detail: "One or more parameters to your request was invalid.",
      type: PROBLEM.invalidRequest,
    },
    status,
  );
}

function anyToken(store: Store, c: Context): { token: XAccessToken } | { response: Response } {
  const token = resolveToken(store, c);
  return token ? { token } : { response: unauthorized(c) };
}

/** True when `userId` has authorized the app with every scope given (holds a live token). */
function userAuthorizedApp(store: Store, clientId: string, userId: string, scopes: string[]): boolean {
  const now = Date.now();
  return getXStore(store)
    .accessTokens.findBy("client_id", clientId)
    .some(
      (t) =>
        !t.app_only &&
        t.user_id === userId &&
        (t.expires === 0 || t.expires > now) &&
        scopes.every((s) => t.scopes.includes(s)),
    );
}

/** Hold a challenge for the test to deliver (the emulator's `control` CRC mode). */
export function holdChallenge(store: Store, webhook: XWebhook): string {
  const xs = getXStore(store);
  for (const old of xs.pendingChallenges.findBy("webhook_id", webhook.webhook_id)) xs.pendingChallenges.delete(old.id);
  const crcToken = newCrcToken();
  xs.pendingChallenges.insert({
    webhook_id: webhook.webhook_id,
    crc_token: crcToken,
    created_at_ms: Date.now(),
    answered: false,
    valid: null,
  });
  return crcToken;
}

const XAA_EVENT_TYPES = new Set<string>(DM_ACTIVITY_EVENT_TYPES);

export function webhookRoutes({ app, store, baseUrl }: RouteContext): void {
  const xs = getXStore(store);
  // X's https and no-port rules apply on an https instance (a hosted one), except in the
  // emulator's control mode: there the challenge is held for the test rather than sent to
  // the address, so a local http address with a port can be registered and subscribed to.
  // An emulator-only relaxation, listed as such in the manifest.
  const strictUrls = () => baseUrl.startsWith("https://") && getCrcDeliveryMode(store) === "outbound";

  // POST /2/webhooks: register a webhook; X sends a CRC to it first.
  app.post("/2/webhooks", async (c) => {
    const auth = anyToken(store, c);
    if ("response" in auth) return auth.response;
    const body = (await c.req.json().catch(() => undefined)) as Record<string, unknown> | undefined;
    const url = typeof body?.url === "string" ? body.url : "";
    if (!url) return invalidRequest(c, "url", "", "`url` is required.");
    const urlProblem = webhookUrlProblem(url, strictUrls());
    if (urlProblem) return webhookFailure(c, "UrlValidationFailed", urlProblem);
    if (xs.webhooks.findBy("client_id", auth.token.client_id).some((w) => w.url === url)) {
      return webhookFailure(
        c,
        "DuplicateUrlFailed",
        "A webhook is already registered by your application for this URL.",
      );
    }
    const client = xs.oauthClients.findOneBy("client_id", auth.token.client_id)!;
    const mode = getCrcDeliveryMode(store);
    if (mode === "outbound") {
      const crc = await runCrc(client, url);
      if (!crc.valid) return webhookFailure(c, "CrcValidationFailed", crc.reason ?? "The CRC check failed.");
    }
    const webhook = xs.webhooks.insert({
      webhook_id: xNumericId(),
      client_id: client.client_id,
      url,
      valid: true,
      crc_proven: mode === "outbound",
      created_at_x: new Date().toISOString(),
    });
    if (mode === "control") holdChallenge(store, webhook);
    recordSideEffect(c, {
      type: "create",
      collection: "x.webhooks",
      id: webhook.webhook_id,
      summary: mode === "control" ? "created; CRC held for the test (emulator control mode)" : "created; CRC passed",
    });
    return c.json({ data: formatWebhook(webhook) });
  });

  // GET /2/webhooks: the app's webhook configs.
  app.get("/2/webhooks", (c) => {
    const auth = anyToken(store, c);
    if ("response" in auth) return auth.response;
    const fields = new Set(listParam(c, "webhook_config.fields") ?? ["created_at", "id", "url", "valid"]);
    const data = xs.webhooks.findBy("client_id", auth.token.client_id).map((w) => {
      const full = formatWebhook(w);
      return Object.fromEntries(Object.entries(full).filter(([k]) => k === "id" || fields.has(k)));
    });
    return c.json({ data, meta: { result_count: data.length } });
  });

  // PUT /2/webhooks/:webhook_id: trigger a CRC and re-enable on success.
  app.put("/2/webhooks/:webhook_id", async (c) => {
    const auth = anyToken(store, c);
    if ("response" in auth) return auth.response;
    const webhook = xs.webhooks.findOneBy("webhook_id", c.req.param("webhook_id"));
    if (!webhook || webhook.client_id !== auth.token.client_id) {
      return webhookFailure(c, "WebhookIdInvalid", "The webhook_id was not found or is not associated with your app.");
    }
    if (getCrcDeliveryMode(store) === "control") {
      holdChallenge(store, webhook);
      return c.json({ data: { valid: webhook.valid } });
    }
    const client = xs.oauthClients.findOneBy("client_id", webhook.client_id)!;
    const crc = await runCrc(client, webhook.url);
    xs.webhooks.update(webhook.id, { valid: crc.valid, crc_proven: crc.valid });
    if (!crc.valid) return webhookFailure(c, "CrcValidationFailed", crc.reason ?? "The CRC check failed.");
    return c.json({ data: { valid: true } });
  });

  // DELETE /2/webhooks/:webhook_id: remove the config and its subscriptions.
  app.delete("/2/webhooks/:webhook_id", (c) => {
    const auth = anyToken(store, c);
    if ("response" in auth) return auth.response;
    const webhook = xs.webhooks.findOneBy("webhook_id", c.req.param("webhook_id"));
    if (!webhook || webhook.client_id !== auth.token.client_id) {
      return webhookFailure(c, "WebhookIdInvalid", "The webhook_id was not found or is not associated with your app.");
    }
    for (const s of xs.activitySubscriptions.findBy("webhook_id", webhook.webhook_id))
      xs.activitySubscriptions.delete(s.id);
    for (const p of xs.pendingChallenges.findBy("webhook_id", webhook.webhook_id)) xs.pendingChallenges.delete(p.id);
    xs.webhooks.delete(webhook.id);
    recordSideEffect(c, { type: "delete", collection: "x.webhooks", id: webhook.webhook_id });
    return c.json({ data: { deleted: true } });
  });

  // POST /2/activity/subscriptions: subscribe a webhook to a user's DM events.
  app.post("/2/activity/subscriptions", async (c) => {
    const auth = anyToken(store, c);
    if ("response" in auth) return auth.response;
    const { token } = auth;
    const body = (await c.req.json().catch(() => undefined)) as Record<string, unknown> | undefined;
    if (!body || typeof body !== "object") return invalidRequest(c, "body", "", "The request body must be JSON.");
    for (const k of Object.keys(body)) {
      if (!["event_type", "filter", "webhook_id", "tag", "expires_at"].includes(k)) {
        return invalidRequest(c, k, "", `[${k}] is not a valid field for this request.`);
      }
    }
    const eventType = body.event_type;
    if (typeof eventType !== "string" || !XAA_EVENT_TYPES.has(eventType)) {
      return invalidRequest(
        c,
        "event_type",
        eventType,
        `This emulator supports the X Activity API DM event types only (${[...XAA_EVENT_TYPES].join(", ")}).`,
      );
    }
    const filter = body.filter as Record<string, unknown> | undefined;
    const userId = typeof filter?.user_id === "string" ? filter.user_id : "";
    if (!/^[0-9]{1,19}$/.test(userId))
      return invalidRequest(c, "filter.user_id", userId, "`filter.user_id` is required.");
    if (filter && (filter.qualifiers !== undefined || filter.keyword !== undefined || filter.direction !== undefined)) {
      return invalidRequest(
        c,
        "filter",
        "",
        "Filter qualifiers, keyword and direction are not supported for DM events here.",
      );
    }
    if (!token.app_only && !token.scopes.includes("dm.read")) {
      return forbidden(c, "Your token is missing the dm.read scope required for dm.* subscriptions.");
    }
    // DM events are private: the user must have authorized this app with dm.read.
    if (!xs.users.findOneBy("user_id", userId) || !userAuthorizedApp(store, token.client_id, userId, ["dm.read"])) {
      return forbidden(
        c,
        "Subscriptions to private events can only be created for users who have authorized your app.",
      );
    }
    const webhookId = typeof body.webhook_id === "string" ? body.webhook_id : "";
    const webhook = xs.webhooks.findOneBy("webhook_id", webhookId);
    if (!webhook || webhook.client_id !== token.client_id) {
      return invalidRequest(
        c,
        "webhook_id",
        webhookId,
        "`webhook_id` must name one of your app's webhooks (the persistent stream is not emulated).",
      );
    }
    const tag = typeof body.tag === "string" ? body.tag : null;
    if (tag !== null && (tag.length < 1 || tag.length > 200)) {
      return invalidRequest(c, "tag", tag, "`tag` must be 1 to 200 characters.");
    }
    const expires = typeof body.expires_at === "string" ? body.expires_at : null;
    if (expires !== null && Number.isNaN(Date.parse(expires))) {
      return invalidRequest(c, "expires_at", expires, "`expires_at` must be an RFC 3339 time.");
    }
    const now = new Date().toISOString();
    // Re-creating the same subscription refreshes it (introduction, "Subscription expiration").
    const existing = xs.activitySubscriptions
      .findBy("user_id", userId)
      .find((s) => s.event_type === eventType && s.client_id === token.client_id);
    if (existing) {
      const updated = xs.activitySubscriptions.update(existing.id, {
        expires_at_x: expires,
        updated_at_x: now,
        webhook_id: webhook.webhook_id,
        tag: tag ?? existing.tag,
      })!;
      return c.json({ data: { subscription: formatSubscription(updated) } });
    }
    const sub = xs.activitySubscriptions.insert({
      subscription_id: xNumericId(),
      client_id: token.client_id,
      event_type: eventType,
      user_id: userId,
      webhook_id: webhook.webhook_id,
      tag,
      created_at_x: now,
      updated_at_x: now,
      expires_at_x: expires,
    });
    recordSideEffect(c, { type: "create", collection: "x.activity_subscriptions", id: sub.subscription_id });
    return c.json({ data: { subscription: formatSubscription(sub) } });
  });

  // GET /2/activity/subscriptions: the app's subscriptions, optionally for one user.
  app.get("/2/activity/subscriptions", (c) => {
    const auth = anyToken(store, c);
    if ("response" in auth) return auth.response;
    const userId = c.req.query("user_id");
    if (userId && !auth.token.app_only && auth.token.user_id !== userId) {
      return forbidden(c, "With a user-context token, user_id must identify the authenticated user.");
    }
    const raw = c.req.query("max_results");
    const max = raw === undefined ? 1000 : Number(raw);
    if (!Number.isInteger(max) || max < 1 || max > 1000) {
      return invalidRequest(c, "max_results", raw, "`max_results` must be between 1 and 1000.");
    }
    const now = Date.now();
    const subs = xs.activitySubscriptions
      .all()
      .filter((s) => s.client_id === auth.token.client_id && (!userId || s.user_id === userId))
      .filter((s) => !s.expires_at_x || Date.parse(s.expires_at_x) > now)
      .slice(0, max);
    return c.json({ data: subs.map(formatSubscription) });
  });

  // PUT /2/activity/subscriptions/:subscription_id: change tag and webhook_id.
  app.put("/2/activity/subscriptions/:subscription_id", async (c) => {
    const auth = anyToken(store, c);
    if ("response" in auth) return auth.response;
    const sub = xs.activitySubscriptions.findOneBy("subscription_id", c.req.param("subscription_id"));
    if (!sub || sub.client_id !== auth.token.client_id) {
      return webhookFailure(c, "SubscriptionNotFound", "No such subscription for your app.", 404);
    }
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const patch: Partial<typeof sub> = { updated_at_x: new Date().toISOString() };
    if (typeof body.tag === "string") patch.tag = body.tag;
    if (typeof body.webhook_id === "string") {
      const w = xs.webhooks.findOneBy("webhook_id", body.webhook_id);
      if (!w || w.client_id !== auth.token.client_id) {
        return invalidRequest(c, "webhook_id", body.webhook_id, "`webhook_id` must name one of your app's webhooks.");
      }
      patch.webhook_id = w.webhook_id;
    }
    const updated = xs.activitySubscriptions.update(sub.id, patch)!;
    return c.json({ data: { subscription: formatSubscription(updated) } });
  });

  // DELETE /2/activity/subscriptions/:subscription_id
  app.delete("/2/activity/subscriptions/:subscription_id", (c) => {
    const auth = anyToken(store, c);
    if ("response" in auth) return auth.response;
    const sub = xs.activitySubscriptions.findOneBy("subscription_id", c.req.param("subscription_id"));
    if (!sub || sub.client_id !== auth.token.client_id) {
      return webhookFailure(c, "SubscriptionNotFound", "No such subscription for your app.", 404);
    }
    xs.activitySubscriptions.delete(sub.id);
    recordSideEffect(c, { type: "delete", collection: "x.activity_subscriptions", id: sub.subscription_id });
    return c.json({ data: { deleted: true } });
  });

  // DELETE /2/activity/subscriptions?ids=...: delete several (app-only Bearer token).
  app.delete("/2/activity/subscriptions", (c) => {
    const auth = anyToken(store, c);
    if ("response" in auth) return auth.response;
    if (!auth.token.app_only) return forbidden(c, "This endpoint requires an app-only Bearer token.");
    const ids = listParam(c, "ids") ?? [];
    if (ids.length < 1 || ids.length > 100) return invalidRequest(c, "ids", ids.join(","), "Give 1 to 100 ids.");
    const data: unknown[] = [];
    const errors: unknown[] = [];
    for (const id of ids) {
      const sub = xs.activitySubscriptions.findOneBy("subscription_id", id);
      if (sub && sub.client_id === auth.token.client_id) {
        xs.activitySubscriptions.delete(sub.id);
        data.push({ subscription_id: id, deleted: true });
      } else {
        errors.push({
          subscription_id: id,
          reason: "SubscriptionNotFound",
          message: "No such subscription for your app.",
        });
      }
    }
    return c.json(errors.length > 0 ? { data, errors } : { data });
  });
}
