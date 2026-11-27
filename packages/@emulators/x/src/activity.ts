import { createHash, createHmac, randomBytes, timingSafeEqual } from "crypto";
import type { Store, WebhookDispatcher, WebhookDelivery } from "@emulators/core";
import { getXStore } from "./store.js";
import type { XActivitySubscription, XOAuthClient, XWebhook } from "./entities.js";
import { USER_FIELDS, findMediaByKey, formatIncludedUser, textEntities, type DmEventView } from "./dm-model.js";

/**
 * Webhooks and the X Activity API (XAA), from X's current documentation:
 *   - https://docs.x.com/x-api/webhooks/quickstart (CRC and signatures)
 *   - https://docs.x.com/x-api/activity/introduction (subscriptions, event types)
 *   - https://docs.x.com/x-api/activity/event-payloads (delivery envelope, dm.sent / dm.received)
 *
 * CRC: `GET <url>?crc_token=...`, answered with
 * `{"response_token": "sha256=" + base64(HMAC-SHA256(secret, crc_token))}`, the
 * secret being the app's OAuth 2.0 client secret (recommended) or its legacy
 * OAuth 1.0a consumer secret.
 *
 * Deliveries: `POST <url>`, signed over the raw body as `sha256=<base64 HMAC-SHA256>`
 * in `X-Twitter-Webhooks-Signature-OAuth2` (client secret) and, only when the app
 * also has a consumer secret, `X-Twitter-Webhooks-Signature` (consumer secret).
 */

export function hmacBase64(secret: string, message: string): string {
  return "sha256=" + createHmac("sha256", secret).update(message, "utf8").digest("base64");
}

function appSecrets(client: XOAuthClient): string[] {
  return [client.client_secret, client.consumer_secret].filter((s): s is string => typeof s === "string" && !!s);
}

/** The response_token values X accepts for this app and token (one per configured secret). */
export function expectedCrcTokens(client: XOAuthClient, crcToken: string): string[] {
  return appSecrets(client).map((secret) => hmacBase64(secret, crcToken));
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function crcAnswerValid(client: XOAuthClient, crcToken: string, responseToken: unknown): boolean {
  return (
    typeof responseToken === "string" && expectedCrcTokens(client, crcToken).some((e) => safeEqual(e, responseToken))
  );
}

export function newCrcToken(): string {
  return randomBytes(24).toString("base64url");
}

export function crcUrl(url: string, crcToken: string): string {
  const target = new URL(url);
  target.searchParams.set("crc_token", crcToken);
  return target.toString();
}

export interface CrcResult {
  valid: boolean;
  crc_token: string;
  status: number | null;
  reason?: string;
}

/** Send a CRC challenge to `url` and check the answer, as X does at registration and on PUT. */
export async function runCrc(client: XOAuthClient, url: string): Promise<CrcResult> {
  const crcToken = newCrcToken();
  if (appSecrets(client).length === 0) {
    return { valid: false, crc_token: crcToken, status: null, reason: "The app has no client or consumer secret." };
  }
  try {
    const res = await fetch(crcUrl(url, crcToken), {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(10000),
    });
    if (res.status < 200 || res.status >= 300) {
      await res.body?.cancel().catch(() => {});
      return { valid: false, crc_token: crcToken, status: res.status, reason: "Non-2xx response to the CRC." };
    }
    const body = (await res.json().catch(() => null)) as { response_token?: unknown } | null;
    const valid = crcAnswerValid(client, crcToken, body?.response_token);
    return {
      valid,
      crc_token: crcToken,
      status: res.status,
      reason: valid ? undefined : "The response_token did not match.",
    };
  } catch (err) {
    return {
      valid: false,
      crc_token: crcToken,
      status: null,
      reason: err instanceof Error ? err.message : "The CRC request failed.",
    };
  }
}

/** Signature headers for a delivery body, one per secret the app has. */
export function signatureHeaders(client: XOAuthClient, body: string): Record<string, string> {
  const headers: Record<string, string> = {};
  if (client.client_secret) headers["x-twitter-webhooks-signature-oauth2"] = hmacBase64(client.client_secret, body);
  if (client.consumer_secret) headers["x-twitter-webhooks-signature"] = hmacBase64(client.consumer_secret, body);
  return headers;
}

function legacyEntities(store: Store, text: string): Record<string, unknown> {
  const e = (textEntities(store, text) ?? {}) as Record<string, Array<Record<string, unknown>>>;
  const idx = (x: Record<string, unknown>) => [x.start, x.end];
  return {
    hashtags: (e.hashtags ?? []).map((h) => ({ text: h.tag, indices: idx(h) })),
    symbols: (e.cashtags ?? []).map((h) => ({ text: h.tag, indices: idx(h) })),
    user_mentions: (e.mentions ?? []).map((m) => ({ screen_name: m.username, id_str: m.id, indices: idx(m) })),
    urls: (e.urls ?? []).map((u) => ({
      url: u.url,
      expanded_url: u.expanded_url,
      display_url: u.display_url,
      indices: idx(u),
    })),
  };
}

/** The legacy `message_create` event XAA carries in a dm.sent / dm.received payload. */
function legacyMessageEvent(
  store: Store,
  baseUrl: string,
  event: DmEventView,
  recipientId: string,
): Record<string, unknown> {
  const messageData: Record<string, unknown> = {
    text: event.text ?? "",
    entities: legacyEntities(store, event.text ?? ""),
  };
  const mediaKey = event.media_keys[0];
  const media = mediaKey ? findMediaByKey(store, mediaKey) : null;
  if (media) {
    // XAA's samples show no attachment; this follows the v1.1 DM event shape.
    const url = `${baseUrl}/2/dm_conversations/media/${event.id}/${media.media_key}/${media.media_id}`;
    messageData.attachment = {
      type: "media",
      media: { id: media.media_id, id_str: media.media_id, media_url_https: url, url, type: media.type },
    };
  }
  return {
    type: "message_create",
    id: event.id,
    created_timestamp: String(event.created_at_ms),
    message_create: {
      target: { recipient_id: recipientId },
      sender_id: event.sender_id,
      message_data: messageData,
    },
  };
}

/** A stable signed 64-bit decimal id, so a preview and the real delivery carry the same bytes. */
function eventUuid(eventId: string, subscriptionId: string): string {
  const digest = createHash("sha256").update(`${eventId}:${subscriptionId}`).digest();
  return digest.readBigInt64BE(0).toString();
}

export const DM_ACTIVITY_EVENT_TYPES = ["dm.sent", "dm.received", "dm.read", "dm.indicate_typing"] as const;

/** The XAA delivery body for one DM event and one subscription. */
export function dmActivityEnvelope(
  store: Store,
  baseUrl: string,
  sub: XActivitySubscription,
  event: DmEventView,
  participants: string[],
): Record<string, unknown> {
  const xs = getXStore(store);
  const others = participants.filter((p) => p !== event.sender_id);
  const recipientId = sub.event_type === "dm.received" ? sub.user_id : (others[0] ?? sub.user_id);
  const users: Record<string, unknown> = {};
  for (const id of new Set([event.sender_id, recipientId].filter((x): x is string => !!x))) {
    const u = xs.users.findOneBy("user_id", id);
    if (u) users[id] = { data: formatIncludedUser(u, USER_FIELDS) };
  }
  const data: Record<string, unknown> = {
    event_uuid: eventUuid(event.id, sub.subscription_id),
    created_at: new Date(event.created_at_ms).toISOString(),
    filter: { user_id: sub.user_id },
    event_type: sub.event_type,
  };
  if (sub.tag) data.tag = sub.tag;
  data.payload = { direct_message_events: [legacyMessageEvent(store, baseUrl, event, recipientId)], users };
  return { data };
}

export interface PreparedDelivery {
  subscription_id: string;
  webhook_id: string;
  event_type: string;
  for_user_id: string;
  url: string;
  method: "POST";
  headers: Record<string, string>;
  body: string;
  /** Why the emulator holds this delivery instead of sending it (it is still previewable). */
  held?: string;
}

/**
 * Why a delivery to this webhook is held, or null when it may be sent. X delivers only
 * to an address whose owner answered the challenge; and an address accepted only through
 * control mode's relaxation (http, or a port, on an https instance) is never called at all,
 * so a public instance cannot be pointed at an arbitrary host and port.
 */
export function deliveryHold(baseUrl: string, webhook: XWebhook): string | null {
  if (baseUrl.startsWith("https://") && webhookUrlProblem(webhook.url, true)) {
    return "held: the address was accepted only through control mode's relaxation (http or a port), and the emulator never calls such an address";
  }
  if (!webhook.crc_proven) {
    return "held: no challenge has been answered for this webhook; answer it (the CRC on PUT /2/webhooks/:id, or POST /_emulate/x/webhooks/:id/challenge in control mode) before deliveries are sent";
  }
  return null;
}

function activeSubscription(sub: XActivitySubscription, now: number): boolean {
  return !sub.expires_at_x || Date.parse(sub.expires_at_x) > now;
}

/**
 * Every delivery X would make for a DM event: `dm.sent` to the sender's
 * subscriptions and `dm.received` to each recipient's, one per subscription
 * whose webhook is valid.
 */
export function prepareDmDeliveries(
  store: Store,
  baseUrl: string,
  event: DmEventView,
  participants: string[],
  options: { forUserId?: string; includeInvalid?: boolean } = {},
): PreparedDelivery[] {
  const xs = getXStore(store);
  const now = Date.now();
  const out: PreparedDelivery[] = [];
  const users = options.forUserId ? [options.forUserId] : participants;
  for (const userId of users) {
    const eventType = userId === event.sender_id ? "dm.sent" : "dm.received";
    for (const sub of xs.activitySubscriptions.findBy("user_id", userId)) {
      if (sub.event_type !== eventType || !activeSubscription(sub, now)) continue;
      const webhook = xs.webhooks.findOneBy("webhook_id", sub.webhook_id);
      if (!webhook || (!webhook.valid && !options.includeInvalid)) continue;
      const client = xs.oauthClients.findOneBy("client_id", webhook.client_id);
      if (!client) continue;
      const body = JSON.stringify(dmActivityEnvelope(store, baseUrl, sub, event, participants));
      out.push({
        subscription_id: sub.subscription_id,
        webhook_id: webhook.webhook_id,
        event_type: eventType,
        for_user_id: userId,
        url: webhook.url,
        method: "POST",
        headers: { "content-type": "application/json", ...signatureHeaders(client, body) },
        body,
        ...(deliveryHold(baseUrl, webhook) ? { held: deliveryHold(baseUrl, webhook)! } : {}),
      });
    }
  }
  return out;
}

export interface DeliveryResult {
  subscription_id: string;
  webhook_id: string;
  event_type: string;
  for_user_id: string;
  url: string;
  status_code: number | null;
  success: boolean;
  delivery_id: number;
  /** Set when the delivery was held, not sent: the reason. */
  held?: string;
}

export async function sendDeliveries(
  dispatcher: WebhookDispatcher,
  deliveries: PreparedDelivery[],
): Promise<DeliveryResult[]> {
  const results: DeliveryResult[] = [];
  for (const d of deliveries) {
    if (d.held) {
      results.push({
        subscription_id: d.subscription_id,
        webhook_id: d.webhook_id,
        event_type: d.event_type,
        for_user_id: d.for_user_id,
        url: d.url,
        status_code: null,
        success: false,
        delivery_id: 0,
        held: d.held,
      });
      continue;
    }
    const rec: WebhookDelivery = await dispatcher.deliver({
      hookRef: d.webhook_id,
      event: d.event_type,
      url: d.url,
      method: d.method,
      headers: d.headers,
      body: d.body,
    });
    results.push({
      subscription_id: d.subscription_id,
      webhook_id: d.webhook_id,
      event_type: d.event_type,
      for_user_id: d.for_user_id,
      url: d.url,
      status_code: rec.status_code,
      success: rec.success,
      delivery_id: rec.id,
    });
  }
  return results;
}

/**
 * X's URL rules for webhooks: HTTPS, at most 200 characters, no explicit port.
 * Enforced when the emulator itself is served over HTTPS (a hosted instance) in
 * outbound CRC mode; a local instance, or any instance in control mode, also
 * accepts `http://` and ports so a test can register a local receiver.
 */
export function webhookUrlProblem(url: string, strict: boolean): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "The url is not a valid absolute URL.";
  }
  if (url.length > 200) return "The url is longer than 200 characters.";
  if (!strict) return parsed.protocol === "http:" || parsed.protocol === "https:" ? null : "The url must be http(s).";
  if (parsed.protocol !== "https:") return "The url must use https.";
  if (parsed.port) return "The url cannot include a port.";
  return null;
}

export function formatWebhook(w: XWebhook): Record<string, unknown> {
  return { id: w.webhook_id, url: w.url, valid: w.valid, created_at: w.created_at_x };
}

export function formatSubscription(s: XActivitySubscription): Record<string, unknown> {
  const out: Record<string, unknown> = {
    subscription_id: s.subscription_id,
    event_type: s.event_type,
    filter: { user_id: s.user_id },
    webhook_id: s.webhook_id,
    created_at: s.created_at_x,
    updated_at: s.updated_at_x,
  };
  if (s.tag) out.tag = s.tag;
  if (s.expires_at_x) out.expires_at = s.expires_at_x;
  return out;
}

/** How CRC challenges reach the webhook address: X's outbound GET, or held for the test to deliver. */
export type CrcDeliveryMode = "outbound" | "control";
const CRC_MODE_KEY = "x.webhook_crc_delivery";

export function getCrcDeliveryMode(store: Store): CrcDeliveryMode {
  return store.getData<CrcDeliveryMode>(CRC_MODE_KEY) ?? "outbound";
}

export function setCrcDeliveryMode(store: Store, mode: unknown): CrcDeliveryMode {
  if (mode !== "outbound" && mode !== "control")
    throw new Error('webhook_crc_delivery must be "outbound" or "control".');
  store.setData(CRC_MODE_KEY, mode);
  return mode;
}
