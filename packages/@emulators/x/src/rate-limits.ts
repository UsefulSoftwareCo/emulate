import type { Context, MiddlewareHandler, Store } from "@emulators/core";
import { getXStore, lookupAccessToken } from "./store.js";
import type { XAccessToken } from "./entities.js";
import { recordIdentity } from "./routes/auth.js";

/**
 * X-shaped rate limits, from https://docs.x.com/x-api/fundamentals/rate-limits:
 *   - every response from a limited endpoint carries `x-rate-limit-limit`,
 *     `x-rate-limit-remaining` and `x-rate-limit-reset` (Unix epoch seconds);
 *   - a spent window answers 429 with `{"errors":[{"code":88,"message":"Rate limit exceeded"}]}`;
 *   - each endpoint has its own windows; per-user limits apply to user tokens,
 *     per-app limits to app-only Bearer tokens. On endpoints only a user can call
 *     (DM sends, media upload, creating a Post) the per-app figure is a cap shared
 *     by every user of the app, so a user-token call counts against both.
 *
 * Windows are fixed: one opens at the first request and closes `window` seconds
 * later. When several windows apply, the headers describe the one with the fewest
 * requests left (the exhausted one on a 429). Counters live in the store, so they
 * persist with the instance and `/_emulate/reset` clears them.
 */

export interface RateWindowSpec {
  limit: number;
  window_seconds: number;
}

interface LimitedOperation {
  operationId: string;
  method: string;
  pattern: RegExp;
  perUser: RateWindowSpec[];
  perApp: RateWindowSpec[];
  /** True when only user tokens can call it, so `perApp` caps all of the app's users together. */
  appCapForUsers?: boolean;
}

const M15 = 15 * 60;
const H24 = 24 * 60 * 60;
const w = (limit: number, window_seconds: number): RateWindowSpec => ({ limit, window_seconds });

/** Operations the limiter knows, in match order (specific paths before parameterized ones). */
export const LIMITED_OPERATIONS: LimitedOperation[] = [
  // Direct Messages
  op("getDirectMessagesEvents", "GET", "/2/dm_events", [w(15, M15)], []),
  op("getDirectMessagesEventsById", "GET", "/2/dm_events/:id", [w(15, M15)], []),
  op("deleteDirectMessagesEvents", "DELETE", "/2/dm_events/:id", [w(300, M15), w(1500, H24)], [w(4000, H24)], true),
  op("dmConversationsMediaDownload", "GET", "/2/dm_conversations/media/:a/:b/:c", [], []),
  op("getDirectMessagesEventsByParticipantId", "GET", "/2/dm_conversations/with/:id/dm_events", [w(15, M15)], []),
  op(
    "createDirectMessagesByParticipantId",
    "POST",
    "/2/dm_conversations/with/:id/messages",
    [w(15, M15), w(1440, H24)],
    [w(1440, H24)],
    true,
  ),
  op("getDirectMessagesEventsByConversationId", "GET", "/2/dm_conversations/:id/dm_events", [w(15, M15)], []),
  op(
    "createDirectMessagesByConversationId",
    "POST",
    "/2/dm_conversations/:id/messages",
    [w(15, M15), w(1440, H24)],
    [w(1440, H24)],
    true,
  ),
  op(
    "createDirectMessagesConversation",
    "POST",
    "/2/dm_conversations",
    [w(15, M15), w(1440, H24)],
    [w(1440, H24)],
    true,
  ),
  // Media upload
  op("initializeMediaUpload", "POST", "/2/media/upload/initialize", [w(1875, M15)], [w(180000, H24)], true),
  op("appendMediaUpload", "POST", "/2/media/upload/:id/append", [w(1875, M15)], [w(180000, H24)], true),
  op("finalizeMediaUpload", "POST", "/2/media/upload/:id/finalize", [w(1875, M15)], [w(180000, H24)], true),
  op("mediaUpload", "POST", "/2/media/upload", [w(500, M15)], [w(50000, H24)], true),
  op("getMediaUploadStatus", "GET", "/2/media/upload", [w(1000, M15)], [w(100000, H24)], true),
  // Webhooks (app limits only; X lists no per-user row, so a user token counts against the app's)
  op("getWebhooks", "GET", "/2/webhooks", [], [w(450, M15)], true),
  op("createWebhooks", "POST", "/2/webhooks", [], [w(450, M15)], true),
  op("validateWebhooks", "PUT", "/2/webhooks/:id", [], [w(450, M15)], true),
  op("deleteWebhooks", "DELETE", "/2/webhooks/:id", [], [w(450, M15)], true),
  // X Activity API subscriptions (500 per 15 minutes per app)
  op("getActivitySubscriptions", "GET", "/2/activity/subscriptions", [], [w(500, M15)], true),
  op("createActivitySubscription", "POST", "/2/activity/subscriptions", [], [w(500, M15)], true),
  op("deleteActivitySubscriptionsByIds", "DELETE", "/2/activity/subscriptions", [], []),
  op("updateActivitySubscription", "PUT", "/2/activity/subscriptions/:id", [], [w(500, M15)], true),
  op("deleteActivitySubscription", "DELETE", "/2/activity/subscriptions/:id", [], [w(500, M15)], true),
  // Users and Posts
  op("findMyUser", "GET", "/2/users/me", [w(75, M15)], []),
  op("findUserByUsername", "GET", "/2/users/by/username/:u", [w(900, M15)], [w(300, M15)]),
  op("usersIdTweets", "GET", "/2/users/:id/tweets", [w(900, M15)], [w(10000, M15)]),
  op("findUserById", "GET", "/2/users/:id", [w(900, M15)], [w(300, M15)]),
  op("findTweetsById", "GET", "/2/tweets", [w(5000, M15)], [w(3500, M15)]),
  op("createTweet", "POST", "/2/tweets", [w(100, M15)], [w(10000, H24)], true),
  op("findTweetById", "GET", "/2/tweets/:id", [w(900, M15)], [w(450, M15)]),
  op("deleteTweetById", "DELETE", "/2/tweets/:id", [w(50, M15)], []),
];

function op(
  operationId: string,
  method: string,
  path: string,
  perUser: RateWindowSpec[],
  perApp: RateWindowSpec[],
  appCapForUsers = false,
): LimitedOperation {
  const pattern = new RegExp("^" + path.replace(/:[a-z_]+/g, "[^/]+") + "/?$");
  return { operationId, method, pattern, perUser, perApp, appCapForUsers };
}

export function matchLimitedOperation(method: string, path: string): LimitedOperation | undefined {
  return LIMITED_OPERATIONS.find((o) => o.method === method.toUpperCase() && o.pattern.test(path));
}

/**
 * Instance overrides, set through the seed (`rate_limits`) or
 * `POST /_emulate/x/rate-limits`. An override replaces every documented window
 * of the endpoint it names with one window, counted per user for user tokens
 * and per app for app-only tokens. `default` applies to every endpoint above,
 * including those X documents no limit for. `enabled: false` turns limits off.
 */
export interface RateLimitConfig {
  enabled?: boolean;
  default?: RateWindowSpec;
  endpoints?: Record<string, RateWindowSpec>;
}

const CONFIG_KEY = "x.rate_limit_config";

export function getRateLimitConfig(store: Store): RateLimitConfig {
  return store.getData<RateLimitConfig>(CONFIG_KEY) ?? {};
}

function validSpec(v: unknown, where: string): RateWindowSpec {
  const s = v as Partial<RateWindowSpec> | undefined;
  if (
    !s ||
    typeof s !== "object" ||
    !Number.isInteger(s.limit) ||
    (s.limit as number) < 0 ||
    !Number.isInteger(s.window_seconds) ||
    (s.window_seconds as number) < 1
  ) {
    throw new Error(`${where} must be { limit: integer >= 0, window_seconds: integer >= 1 }.`);
  }
  return { limit: s.limit as number, window_seconds: s.window_seconds as number };
}

/** Validate and store a config; throws with a readable message when it is malformed. */
export function setRateLimitConfig(store: Store, raw: unknown): RateLimitConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("rate_limits must be an object.");
  const r = raw as Record<string, unknown>;
  const known = new Set(LIMITED_OPERATIONS.map((o) => o.operationId));
  const cfg: RateLimitConfig = {};
  if (r.enabled !== undefined) {
    if (typeof r.enabled !== "boolean") throw new Error("rate_limits.enabled must be a boolean.");
    cfg.enabled = r.enabled;
  }
  if (r.default !== undefined) cfg.default = validSpec(r.default, "rate_limits.default");
  if (r.endpoints !== undefined) {
    if (!r.endpoints || typeof r.endpoints !== "object") throw new Error("rate_limits.endpoints must be an object.");
    cfg.endpoints = {};
    for (const [id, spec] of Object.entries(r.endpoints as Record<string, unknown>)) {
      if (!known.has(id)) throw new Error(`rate_limits.endpoints: unknown operation id ${id}.`);
      cfg.endpoints[id] = validSpec(spec, `rate_limits.endpoints.${id}`);
    }
  }
  store.setData(CONFIG_KEY, cfg);
  return cfg;
}

/** Forget every open window (the counters), keeping the configuration. */
export function clearRateWindows(store: Store): void {
  getXStore(store).rateWindows.clear();
}

interface AppliedWindow {
  key: string;
  spec: RateWindowSpec;
}

function windowsFor(o: LimitedOperation, token: XAccessToken, cfg: RateLimitConfig): AppliedWindow[] {
  const userScope = !token.app_only && token.user_id ? `user:${token.user_id}` : null;
  const appScope = `app:${token.client_id}`;
  const override = cfg.endpoints?.[o.operationId] ?? cfg.default;
  if (override) {
    return [{ key: `${userScope ?? appScope}:${o.operationId}`, spec: override }];
  }
  const out: AppliedWindow[] = [];
  if (userScope) {
    for (const spec of o.perUser) out.push({ key: `${userScope}:${o.operationId}`, spec });
    if (o.appCapForUsers) for (const spec of o.perApp) out.push({ key: `${appScope}:${o.operationId}`, spec });
  } else {
    for (const spec of o.perApp) out.push({ key: `${appScope}:${o.operationId}`, spec });
  }
  return out;
}

interface WindowState {
  limit: number;
  remaining: number;
  resetSeconds: number;
  exhausted: boolean;
}

/** Count one request against every applicable window, or report the spent one. */
function consume(store: Store, windows: AppliedWindow[], nowMs: number): WindowState[] {
  const rows = getXStore(store).rateWindows;
  const states = windows.map((aw) => {
    const key = `${aw.key}:${aw.spec.limit}/${aw.spec.window_seconds}`;
    let row = rows.findOneBy("key", key);
    if (!row || row.reset_at <= nowMs) {
      if (row) rows.delete(row.id);
      row = rows.insert({ key, limit: aw.spec.limit, used: 0, reset_at: nowMs + aw.spec.window_seconds * 1000 });
    }
    return { row, exhausted: row.used >= row.limit };
  });
  const spent = states.some((s) => s.exhausted);
  return states.map(({ row, exhausted }) => {
    let used = row.used;
    if (!spent) {
      used += 1;
      rows.update(row.id, { used });
    }
    return {
      limit: row.limit,
      remaining: Math.max(0, row.limit - used),
      resetSeconds: Math.ceil(row.reset_at / 1000),
      exhausted,
    };
  });
}

function pickReported(states: WindowState[]): WindowState {
  const exhausted = states.find((s) => s.exhausted);
  if (exhausted) return exhausted;
  return states.reduce((a, b) => (b.remaining < a.remaining ? b : a));
}

/**
 * The limiter. Installed by the X plugin on `/2/*`; the shared GitHub-shaped
 * limiter in core is turned off for X (`rateLimit: "provider"`).
 */
export function xRateLimitMiddleware(store: Store): MiddlewareHandler {
  return async (c: Context, next) => {
    const path = new URL(c.req.url).pathname;
    const o = matchLimitedOperation(c.req.method, path);
    if (!o) {
      await next();
      return;
    }
    if (!c.get("operationId")) c.set("operationId", o.operationId);
    const cfg = getRateLimitConfig(store);
    const m = /^Bearer\s+(.+)$/i.exec(c.req.header("Authorization") ?? "");
    const token = m ? lookupAccessToken(store, m[1]!.trim()) : undefined;
    // Unauthenticated calls are refused by the route (401) and not counted.
    if (token) recordIdentity(store, c, token);
    if (!token || cfg.enabled === false) {
      await next();
      return;
    }
    const windows = windowsFor(o, token, cfg);
    if (windows.length === 0) {
      await next();
      return;
    }
    const reported = pickReported(consume(store, windows, Date.now()));
    const headers = {
      "x-rate-limit-limit": String(reported.limit),
      "x-rate-limit-remaining": String(reported.remaining),
      "x-rate-limit-reset": String(reported.resetSeconds),
    };
    if (reported.exhausted) {
      return c.json({ errors: [{ code: 88, message: "Rate limit exceeded" }] }, 429, headers);
    }
    const res = await next();
    if (!res) return;
    const merged = new Headers(res.headers);
    for (const [k, v] of Object.entries(headers)) merged.set(k, v);
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers: merged });
  };
}

/** Current windows, for the control plane. */
export function rateLimitState(store: Store): Array<Record<string, unknown>> {
  const now = Date.now();
  return getXStore(store)
    .rateWindows.all()
    .filter((r) => r.reset_at > now)
    .map((r) => ({
      key: r.key,
      limit: r.limit,
      used: r.used,
      remaining: Math.max(0, r.limit - r.used),
      reset: Math.ceil(r.reset_at / 1000),
    }));
}
