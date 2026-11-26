import { createHash, randomInt } from "crypto";
import { SignJWT } from "jose";
import type { Store } from "@emulators/core";
import { compareHistoryIds, getCurrentHistoryId } from "./helpers.js";
import { ensureSigningKey } from "./routes/oauth.js";
import { getGoogleStore } from "./store.js";

/**
 * Gmail push notifications through Cloud Pub/Sub push subscriptions, after:
 *   - https://developers.google.com/workspace/gmail/api/guides/push (notification data,
 *     watch filters, one notification per second per user, 7-day renewal)
 *   - https://docs.cloud.google.com/pubsub/docs/push (the wrapped push body; 102, 200,
 *     201, 202 and 204 acknowledge)
 *   - https://docs.cloud.google.com/pubsub/docs/authenticate-push-subscriptions (the
 *     `Authorization: Bearer` OIDC token, RS256, claims iss, aud, azp, sub, email,
 *     email_verified, iat, exp)
 *
 * Pub/Sub is a separate Google API: topics and push subscriptions are configured
 * through the seed (`pubsub_push_subscriptions`) or `/_emulate/google/pubsub/*`,
 * not emulated as the Pub/Sub admin API. The push token is signed with the
 * emulator's own OIDC key, published at `<base>/oauth2/v3/certs`, with the
 * emulator's issuer (`<base>`) in `iss`, where Google uses https://accounts.google.com.
 */

export interface GmailWatchState {
  topicName: string;
  labelIds: string[];
  labelFilterBehavior: string | null;
  expiration: string;
  /** History id the watch started from, or the last one notified. */
  lastNotifiedHistoryId?: string;
  lastNotifiedAt?: number;
}

export const WATCH_STATE_KEY = "google.gmail.watchStates";
const SUBSCRIPTIONS_KEY = "google.pubsub.pushSubscriptions";
const DELIVERIES_KEY = "google.pubsub.deliveries";
const MAX_DELIVERIES = 200;
/** "Each Gmail user being watched has a maximum notification rate of one event per second." */
export const MIN_NOTIFICATION_INTERVAL_MS = 1000;

export interface PushSubscription {
  /** projects/{project}/subscriptions/{subscription} */
  name: string;
  /** projects/{project}/topics/{topic} */
  topic: string;
  push_endpoint: string;
  /** OIDC token audience; defaults to the push endpoint. */
  audience?: string;
  /** Service account the OIDC token names in `email`; null sends no Authorization header. */
  service_account_email?: string | null;
}

export interface PushRecord {
  subscription: string;
  topic: string;
  email: string;
  history_id: string;
  message_id: string;
  url: string;
  status_code: number | null;
  acknowledged: boolean;
  at: string;
}

export function getWatchStates(store: Store): Map<string, GmailWatchState> {
  return store.getData<Map<string, GmailWatchState>>(WATCH_STATE_KEY) ?? new Map();
}

export function listPushSubscriptions(store: Store): PushSubscription[] {
  return store.getData<PushSubscription[]>(SUBSCRIPTIONS_KEY) ?? [];
}

function validName(value: unknown, kind: "topics" | "subscriptions"): value is string {
  return typeof value === "string" && new RegExp(`^projects/[^/]+/${kind}/[^/]+$`).test(value);
}

export function upsertPushSubscription(store: Store, raw: unknown): PushSubscription {
  const r = (raw ?? {}) as Record<string, unknown>;
  if (!validName(r.name, "subscriptions")) throw new Error("name must be projects/{project}/subscriptions/{name}.");
  if (!validName(r.topic, "topics")) throw new Error("topic must be projects/{project}/topics/{name}.");
  if (typeof r.push_endpoint !== "string" || !/^https?:\/\//.test(r.push_endpoint)) {
    throw new Error("push_endpoint must be an http(s) URL.");
  }
  const project = r.name.split("/")[1]!;
  const sub: PushSubscription = {
    name: r.name,
    topic: r.topic,
    push_endpoint: r.push_endpoint,
    audience: typeof r.audience === "string" ? r.audience : undefined,
    service_account_email:
      r.service_account_email === null
        ? null
        : typeof r.service_account_email === "string"
          ? r.service_account_email
          : `gmail-push@${project}.iam.gserviceaccount.com`,
  };
  const subs = listPushSubscriptions(store).filter((s) => s.name !== sub.name);
  subs.push(sub);
  store.setData(SUBSCRIPTIONS_KEY, subs);
  return sub;
}

export function deletePushSubscription(store: Store, name: string): boolean {
  const subs = listPushSubscriptions(store);
  const next = subs.filter((s) => s.name !== name);
  store.setData(SUBSCRIPTIONS_KEY, next);
  return next.length !== subs.length;
}

export function listPushDeliveries(store: Store): PushRecord[] {
  return store.getData<PushRecord[]>(DELIVERIES_KEY) ?? [];
}

/** A stable numeric id from the subscription's identity, for the token's sub and azp. */
function numericId(value: string): string {
  const n = createHash("sha256").update(value).digest().readBigUInt64BE(0) % 10n ** 21n;
  return n.toString().padStart(21, "1");
}

async function pushToken(store: Store, baseUrl: string, sub: PushSubscription): Promise<string | null> {
  if (!sub.service_account_email) return null;
  const { privateKey, kid } = await ensureSigningKey(store);
  const id = numericId(sub.service_account_email);
  return new SignJWT({ azp: id, email: sub.service_account_email, email_verified: true })
    .setProtectedHeader({ alg: "RS256", kid, typ: "JWT" })
    .setIssuer(baseUrl)
    .setSubject(id)
    .setAudience(sub.audience ?? sub.push_endpoint)
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(privateKey);
}

export interface PreparedPush {
  subscription: string;
  topic: string;
  url: string;
  method: "POST";
  headers: Record<string, string>;
  body: string;
  /** The notification inside message.data, decoded. */
  data: { emailAddress: string; historyId: string };
}

/** Exactly what Pub/Sub would POST to each push subscription on the topic for this notification. */
export async function preparePushes(
  store: Store,
  baseUrl: string,
  topic: string,
  email: string,
  historyId: string,
): Promise<PreparedPush[]> {
  const out: PreparedPush[] = [];
  for (const sub of listPushSubscriptions(store).filter((s) => s.topic === topic)) {
    const data = { emailAddress: email, historyId };
    const messageId = String(randomInt(1, 2 ** 47));
    const publishTime = new Date().toISOString();
    const body = JSON.stringify({
      message: {
        data: Buffer.from(JSON.stringify(data), "utf8").toString("base64"),
        messageId,
        message_id: messageId,
        publishTime,
        publish_time: publishTime,
      },
      subscription: sub.name,
    });
    const headers: Record<string, string> = { "content-type": "application/json" };
    const token = await pushToken(store, baseUrl, sub);
    if (token) headers.authorization = `Bearer ${token}`;
    out.push({ subscription: sub.name, topic, url: sub.push_endpoint, method: "POST", headers, body, data });
  }
  return out;
}

const ACK_STATUSES = new Set([102, 200, 201, 202, 204]);

async function send(store: Store, push: PreparedPush): Promise<PushRecord> {
  let status: number | null = null;
  try {
    const res = await fetch(push.url, {
      method: push.method,
      headers: push.headers,
      body: push.body,
      redirect: "manual",
      signal: AbortSignal.timeout(10000),
    });
    status = res.status;
    await res.body?.cancel().catch(() => {});
  } catch {
    status = null;
  }
  const record: PushRecord = {
    subscription: push.subscription,
    topic: push.topic,
    email: push.data.emailAddress,
    history_id: push.data.historyId,
    message_id: (JSON.parse(push.body) as { message: { messageId: string } }).message.messageId,
    url: push.url,
    status_code: status,
    acknowledged: status !== null && ACK_STATUSES.has(status),
    at: new Date().toISOString(),
  };
  const all = [...listPushDeliveries(store), record].slice(-MAX_DELIVERIES);
  store.setData(DELIVERIES_KEY, all);
  return record;
}

/**
 * True when a change since `sinceHistoryId` matches the watch's label filter:
 * with labelIds and INCLUDE (the default), a change touching one of them; with
 * EXCLUDE, a change touching none of them; without labelIds, any change.
 */
function matchesFilter(store: Store, email: string, watch: GmailWatchState, sinceHistoryId: string): boolean {
  const gs = getGoogleStore(store);
  const events = gs.history
    .findBy("user_email", email)
    .filter((e) => compareHistoryIds(e.gmail_id, sinceHistoryId) > 0);
  if (events.length === 0) return false;
  if (watch.labelIds.length === 0) return true;
  const exclude = (watch.labelFilterBehavior ?? "INCLUDE").toUpperCase() === "EXCLUDE";
  return events.some((e) => {
    const touches = e.label_ids.some((l) => watch.labelIds.includes(l));
    return exclude ? !touches : touches;
  });
}

/**
 * Notify every watched mailbox whose history moved past what it was last notified
 * of and whose change matches its filter, at most once a second per user (faster
 * notifications are dropped, as Gmail drops them). Returns what was sent.
 */
export async function notifyWatchers(store: Store, baseUrl: string, only?: string): Promise<PushRecord[]> {
  const gs = getGoogleStore(store);
  const states = getWatchStates(store);
  const now = Date.now();
  const sent: PushRecord[] = [];
  let changed = false;
  for (const [email, watch] of states) {
    if (only && email !== only) continue;
    if (Number(watch.expiration) <= now) continue;
    const current = getCurrentHistoryId(gs, email);
    const since = watch.lastNotifiedHistoryId ?? "0";
    if (compareHistoryIds(current, since) <= 0) continue;
    const matched = matchesFilter(store, email, watch, since);
    watch.lastNotifiedHistoryId = current;
    changed = true;
    if (!matched) continue;
    if (watch.lastNotifiedAt !== undefined && now - watch.lastNotifiedAt < MIN_NOTIFICATION_INTERVAL_MS) continue;
    watch.lastNotifiedAt = now;
    for (const push of await preparePushes(store, baseUrl, watch.topicName, email, current)) {
      sent.push(await send(store, push));
    }
  }
  if (changed) store.setData(WATCH_STATE_KEY, states);
  return sent;
}
