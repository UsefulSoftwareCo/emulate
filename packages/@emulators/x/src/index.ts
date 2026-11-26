import type { RouteContext, ServicePlugin, Store } from "@emulators/core";
import { getXStore, xNumericId } from "./store.js";
import { oauthRoutes } from "./routes/oauth.js";
import { usersRoutes } from "./routes/users.js";
import { tweetsRoutes } from "./routes/tweets.js";
import { openapiRoutes } from "./routes/openapi.js";
import { dmRoutes } from "./routes/dm.js";
import { controlRoutes } from "./routes/control.js";
import { mediaRoutes } from "./routes/media.js";
import { webhookRoutes } from "./routes/webhooks.js";
import { setCrcDeliveryMode, type CrcDeliveryMode } from "./activity.js";
import { xRateLimitMiddleware, setRateLimitConfig, type RateLimitConfig } from "./rate-limits.js";
import { seedDmBulk, seedDmConversation, type XSeedDmBulk, type XSeedDmConversation } from "./dm-seed.js";

export { getXStore, lookupAccessToken, type XStore } from "./store.js";
export { manifest } from "./manifest.js";
export * from "./entities.js";
export type { RateLimitConfig, RateWindowSpec } from "./rate-limits.js";
export type { CrcDeliveryMode } from "./activity.js";
export type { XSeedDmBulk, XSeedDmConversation, XSeedAttachment } from "./dm-seed.js";

export interface XSeedConfig {
  users?: Array<{
    username: string;
    name?: string;
    user_id?: string;
    description?: string;
    verified?: boolean;
    protected?: boolean;
    location?: string;
    url?: string;
    profile_image_url?: string;
    followers_count?: number;
    following_count?: number;
    listed_count?: number;
    created_at?: string;
  }>;
  oauth_clients?: Array<{
    client_id: string;
    client_secret?: string | null;
    client_type?: "confidential" | "public";
    name?: string;
    redirect_uris?: string[];
    /** Legacy OAuth 1.0a consumer secret; signs `X-Twitter-Webhooks-Signature`. */
    consumer_secret?: string;
  }>;
  tweets?: Array<{
    text: string;
    author: string; // username or user_id of the author
    tweet_id?: string;
    like_count?: number;
    retweet_count?: number;
    reply_count?: number;
    quote_count?: number;
    impression_count?: number;
    lang?: string;
    created_at?: string;
  }>;
  /** Direct-message conversations, with explicit messages and/or generated history. */
  dm_conversations?: XSeedDmConversation[];
  /** Many generated conversations for one user (partners are created as users). */
  dm_bulk?: XSeedDmBulk;
  /** Rate-limit overrides for this instance (see RateLimitConfig). */
  rate_limits?: RateLimitConfig;
  /** Webhook configs, created without a CRC (seeded state, as if already validated). */
  webhooks?: Array<{ url: string; client_id: string; webhook_id?: string; valid?: boolean }>;
  /** X Activity API subscriptions; `user` is a username or id, `webhook` a webhook id or url. */
  activity_subscriptions?: Array<{ event_type: string; user: string; webhook: string; tag?: string }>;
  /** Who delivers CRC challenges: X's `outbound` GET (default) or the emulator's `control` mode. */
  webhook_crc_delivery?: CrcDeliveryMode;
}

function resolveAuthor(store: Store, ref: string): string | null {
  const xs = getXStore(store);
  const byId = xs.users.findOneBy("user_id", ref);
  if (byId) return byId.user_id;
  const byUsername = xs.users.findOneBy("username", ref.toLowerCase().replace(/^@/, ""));
  return byUsername ? byUsername.user_id : null;
}

export function seedFromConfig(store: Store, baseUrl: string, config: XSeedConfig): void {
  const xs = getXStore(store);

  for (const u of config.users ?? []) {
    const username = u.username.toLowerCase().replace(/^@/, "");
    if (xs.users.findOneBy("username", username)) continue;
    const userId = u.user_id ?? xNumericId();
    xs.users.insert({
      user_id: userId,
      username,
      name: u.name ?? u.username,
      description: u.description ?? "",
      verified: u.verified ?? false,
      protected: u.protected ?? false,
      location: u.location ?? null,
      url: u.url ?? null,
      profile_image_url: u.profile_image_url ?? `${baseUrl}/profile_images/${username}.png`,
      followers_count: u.followers_count ?? 0,
      following_count: u.following_count ?? 0,
      tweet_count: 0,
      listed_count: u.listed_count ?? 0,
      created_at_x: u.created_at ?? new Date().toISOString(),
    });
  }

  for (const cl of config.oauth_clients ?? []) {
    if (xs.oauthClients.findOneBy("client_id", cl.client_id)) continue;
    const clientType: "confidential" | "public" = cl.client_type ?? (cl.client_secret ? "confidential" : "public");
    xs.oauthClients.insert({
      client_id: cl.client_id,
      client_secret: clientType === "confidential" ? (cl.client_secret ?? null) : null,
      client_type: clientType,
      name: cl.name ?? cl.client_id,
      redirect_uris: cl.redirect_uris ?? ["http://localhost:3000/callback"],
      consumer_secret: cl.consumer_secret ?? null,
    });
  }

  for (const t of config.tweets ?? []) {
    const authorId = resolveAuthor(store, t.author);
    if (!authorId) continue;
    const tweetId = t.tweet_id ?? xNumericId();
    if (xs.tweets.findOneBy("tweet_id", tweetId)) continue;
    xs.tweets.insert({
      tweet_id: tweetId,
      author_id: authorId,
      text: t.text,
      reply_count: t.reply_count ?? 0,
      retweet_count: t.retweet_count ?? 0,
      like_count: t.like_count ?? 0,
      quote_count: t.quote_count ?? 0,
      impression_count: t.impression_count ?? 0,
      in_reply_to_user_id: null,
      conversation_id: tweetId,
      lang: t.lang ?? "en",
      possibly_sensitive: false,
      created_at_x: t.created_at ?? new Date().toISOString(),
    });
    const author = xs.users.findOneBy("user_id", authorId);
    if (author) xs.users.update(author.id, { tweet_count: author.tweet_count + 1 });
  }

  for (const conv of config.dm_conversations ?? []) seedDmConversation(store, conv);
  if (config.dm_bulk) {
    seedDmBulk(store, config.dm_bulk, (username) => seedFromConfig(store, baseUrl, { users: [{ username }] }));
  }
  if (config.rate_limits) setRateLimitConfig(store, config.rate_limits);
  if (config.webhook_crc_delivery) setCrcDeliveryMode(store, config.webhook_crc_delivery);

  for (const w of config.webhooks ?? []) {
    if (!xs.oauthClients.findOneBy("client_id", w.client_id))
      throw new Error(`webhooks: unknown client_id ${w.client_id}.`);
    if (xs.webhooks.findBy("client_id", w.client_id).some((x) => x.url === w.url)) continue;
    xs.webhooks.insert({
      webhook_id: w.webhook_id ?? xNumericId(),
      client_id: w.client_id,
      url: w.url,
      valid: w.valid ?? true,
      created_at_x: new Date().toISOString(),
    });
  }
  for (const s of config.activity_subscriptions ?? []) {
    const userId = resolveAuthor(store, s.user);
    if (!userId) throw new Error(`activity_subscriptions: unknown user ${s.user}.`);
    const webhook =
      xs.webhooks.findOneBy("webhook_id", s.webhook) ?? xs.webhooks.all().find((w) => w.url === s.webhook);
    if (!webhook) throw new Error(`activity_subscriptions: unknown webhook ${s.webhook}.`);
    if (!["dm.sent", "dm.received", "dm.read", "dm.indicate_typing"].includes(s.event_type)) {
      throw new Error(`activity_subscriptions: unsupported event_type ${s.event_type}.`);
    }
    const now = new Date().toISOString();
    xs.activitySubscriptions.insert({
      subscription_id: xNumericId(),
      client_id: webhook.client_id,
      event_type: s.event_type,
      user_id: userId,
      webhook_id: webhook.webhook_id,
      tag: s.tag ?? null,
      created_at_x: now,
      updated_at_x: now,
      expires_at_x: null,
    });
  }
}

export const xPlugin: ServicePlugin = {
  name: "x",
  // X's own limiter (x-rate-limit-* headers, 429) replaces the shared GitHub-shaped one.
  rateLimit: "provider",
  register(app, store, webhooks, baseUrl, tokenMap): void {
    const ctx: RouteContext = { app, store, webhooks, baseUrl, tokenMap };
    // Every X provider request writes a ledger entry and most count against a rate
    // limit, reads included, so ask a persisting host to save after each one: a
    // hosted instance evicted between reads must not forget them.
    app.use("*", async (c, next) => {
      if (!c.req.path.startsWith("/_emulate")) store.requestPersist();
      return next();
    });
    app.use("/2/*", xRateLimitMiddleware(store));
    controlRoutes(ctx);
    dmRoutes(ctx);
    mediaRoutes(ctx);
    webhookRoutes(ctx);
    oauthRoutes(ctx);
    usersRoutes(ctx);
    tweetsRoutes(ctx);
    openapiRoutes(ctx);
  },
  seed(store, baseUrl): void {
    seedFromConfig(store, baseUrl, {
      users: [
        {
          username: "developer",
          name: "Developer",
          description: "Building with the X API v2 emulator.",
          verified: true,
          followers_count: 1200,
          following_count: 320,
        },
      ],
      oauth_clients: [
        {
          client_id: "x-confidential-client",
          client_secret: "x-confidential-secret",
          client_type: "confidential",
          name: "My X App (confidential)",
          redirect_uris: ["http://localhost:3000/api/auth/callback/twitter"],
        },
        {
          client_id: "x-public-client",
          client_type: "public",
          name: "My X App (public)",
          redirect_uris: ["http://localhost:3000/api/auth/callback/twitter"],
        },
      ],
      tweets: [{ text: "Hello from the X API v2 emulator.", author: "developer", like_count: 42, retweet_count: 7 }],
    });
  },
};

export default xPlugin;
