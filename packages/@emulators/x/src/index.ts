import type { RouteContext, ServicePlugin, Store } from "@emulators/core";
import { getXStore, xNumericId } from "./store.js";
import { oauthRoutes } from "./routes/oauth.js";
import { usersRoutes } from "./routes/users.js";
import { tweetsRoutes } from "./routes/tweets.js";
import { openapiRoutes } from "./routes/openapi.js";

export { getXStore, lookupAccessToken, type XStore } from "./store.js";
export { manifest } from "./manifest.js";
export * from "./entities.js";

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
}

export const xPlugin: ServicePlugin = {
  name: "x",
  register(app, store, webhooks, baseUrl, tokenMap): void {
    const ctx: RouteContext = { app, store, webhooks, baseUrl, tokenMap };
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
