import type { Context, RouteContext } from "@emulators/core";
import { getXStore, xNumericId } from "../store.js";
import type { XTweet } from "../entities.js";
import { resolveToken, unauthorized, forbidden, hasUserScope } from "./auth.js";

/** Format a tweet into the v2 tweet object (default fields plus public_metrics). */
function formatTweet(t: XTweet): Record<string, unknown> {
  return {
    id: t.tweet_id,
    text: t.text,
    author_id: t.author_id,
    created_at: t.created_at_x,
    conversation_id: t.conversation_id,
    lang: t.lang,
    possibly_sensitive: t.possibly_sensitive,
    in_reply_to_user_id: t.in_reply_to_user_id,
    edit_history_tweet_ids: [t.tweet_id],
    public_metrics: {
      retweet_count: t.retweet_count,
      reply_count: t.reply_count,
      like_count: t.like_count,
      quote_count: t.quote_count,
      impression_count: t.impression_count,
    },
  };
}

function notFound(c: Context, detail: string) {
  return c.json(
    {
      errors: [
        {
          title: "Not Found Error",
          type: "https://api.twitter.com/2/problems/resource-not-found",
          detail,
        },
      ],
    },
    404,
  );
}

export function tweetsRoutes({ app, store }: RouteContext): void {
  const xs = getXStore(store);

  // GET /2/tweets/:id — app-only bearer OR user token, both need tweet.read for a
  // user-context token (app-only is implicitly read).
  app.get("/2/tweets/:id", (c) => {
    const token = resolveToken(store, c);
    if (!token) return unauthorized(c);
    if (!token.app_only && !hasUserScope(token, "tweet.read")) {
      return forbidden(c, "Your token is missing the tweet.read scope required by this endpoint.");
    }
    const tweet = xs.tweets.findOneBy("tweet_id", c.req.param("id"));
    if (!tweet) return notFound(c, `Could not find tweet with id: [${c.req.param("id")}].`);
    return c.json({ data: formatTweet(tweet) });
  });

  // GET /2/tweets?ids=1,2,3 — batch lookup by id.
  app.get("/2/tweets", (c) => {
    const token = resolveToken(store, c);
    if (!token) return unauthorized(c);
    if (!token.app_only && !hasUserScope(token, "tweet.read")) {
      return forbidden(c, "Your token is missing the tweet.read scope required by this endpoint.");
    }
    const idsParam = c.req.query("ids") ?? "";
    const ids = idsParam
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (ids.length === 0) {
      return c.json(
        {
          errors: [
            {
              parameters: { ids: [] },
              message: "The `ids` query parameter is required and must be a comma-separated list of Tweet IDs.",
            },
          ],
          title: "Invalid Request",
          detail: "One or more parameters to your request was invalid.",
          type: "https://api.twitter.com/2/problems/invalid-request",
        },
        400,
      );
    }
    const data: Array<Record<string, unknown>> = [];
    const errors: Array<Record<string, unknown>> = [];
    for (const id of ids) {
      const tweet = xs.tweets.findOneBy("tweet_id", id);
      if (tweet) {
        data.push(formatTweet(tweet));
      } else {
        errors.push({
          value: id,
          detail: `Could not find tweet with ids: [${id}].`,
          title: "Not Found Error",
          resource_type: "tweet",
          parameter: "ids",
          resource_id: id,
          type: "https://api.twitter.com/2/problems/resource-not-found",
        });
      }
    }
    const out: Record<string, unknown> = { data };
    if (errors.length > 0) out.errors = errors;
    return c.json(out);
  });

  // GET /2/users/:id/tweets — a user's timeline. App-only bearer OR user token.
  app.get("/2/users/:id/tweets", (c) => {
    const token = resolveToken(store, c);
    if (!token) return unauthorized(c);
    if (!token.app_only && !hasUserScope(token, "tweet.read")) {
      return forbidden(c, "Your token is missing the tweet.read scope required by this endpoint.");
    }
    const authorId = c.req.param("id");
    const author = xs.users.findOneBy("user_id", authorId);
    if (!author) return notFound(c, `Could not find user with id: [${authorId}].`);
    const tweets = xs.tweets.findBy("author_id", authorId).sort((a, b) => b.created_at_x.localeCompare(a.created_at_x));
    return c.json({
      data: tweets.map(formatTweet),
      meta: {
        result_count: tweets.length,
        newest_id: tweets[0]?.tweet_id,
        oldest_id: tweets[tweets.length - 1]?.tweet_id,
      },
    });
  });

  // POST /2/tweets — create a tweet. Requires a user token with tweet.write.
  app.post("/2/tweets", async (c) => {
    const token = resolveToken(store, c);
    if (!token) return unauthorized(c);
    if (token.app_only) {
      return forbidden(c, "Creating a Tweet requires a user-context OAuth 2.0 token; an app-only token cannot post.");
    }
    if (!hasUserScope(token, "tweet.write")) {
      return forbidden(c, "Your token is missing the tweet.write scope required to create a Tweet.");
    }
    const author = token.user_id ? xs.users.findOneBy("user_id", token.user_id) : undefined;
    if (!author) return unauthorized(c);

    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const text = typeof body.text === "string" ? body.text : "";
    if (!text.trim()) {
      return c.json(
        {
          errors: [{ message: "text or media is required", parameters: {} }],
          title: "Invalid Request",
          detail: "One or more parameters to your request was invalid.",
          type: "https://api.twitter.com/2/problems/invalid-request",
        },
        400,
      );
    }

    const reply = body.reply as { in_reply_to_tweet_id?: unknown } | undefined;
    const inReplyToTweetId =
      reply && typeof reply.in_reply_to_tweet_id === "string" ? reply.in_reply_to_tweet_id : null;
    const parent = inReplyToTweetId ? xs.tweets.findOneBy("tweet_id", inReplyToTweetId) : undefined;

    const tweetId = xNumericId();
    const tweet = xs.tweets.insert({
      tweet_id: tweetId,
      author_id: author.user_id,
      text,
      reply_count: 0,
      retweet_count: 0,
      like_count: 0,
      quote_count: 0,
      impression_count: 0,
      in_reply_to_user_id: parent ? parent.author_id : null,
      conversation_id: parent ? parent.conversation_id : tweetId,
      lang: "en",
      possibly_sensitive: false,
      created_at_x: new Date().toISOString(),
    });
    xs.users.update(author.id, { tweet_count: author.tweet_count + 1 });
    if (parent) xs.tweets.update(parent.id, { reply_count: parent.reply_count + 1 });

    // X returns a minimal create payload: { data: { id, text } }.
    return c.json({ data: { id: tweet.tweet_id, text: tweet.text } }, 201);
  });

  // DELETE /2/tweets/:id — delete a tweet. Requires a user token with tweet.write.
  app.delete("/2/tweets/:id", (c) => {
    const token = resolveToken(store, c);
    if (!token) return unauthorized(c);
    if (token.app_only) {
      return forbidden(c, "Deleting a Tweet requires a user-context OAuth 2.0 token; an app-only token cannot delete.");
    }
    if (!hasUserScope(token, "tweet.write")) {
      return forbidden(c, "Your token is missing the tweet.write scope required to delete a Tweet.");
    }
    const tweet = xs.tweets.findOneBy("tweet_id", c.req.param("id"));
    if (!tweet) return notFound(c, `Could not find tweet with id: [${c.req.param("id")}].`);
    // X only lets you delete your own tweet.
    if (token.user_id && tweet.author_id !== token.user_id) {
      return forbidden(c, "You may only delete your own Tweets.");
    }
    xs.tweets.delete(tweet.id);
    return c.json({ data: { deleted: true } });
  });
}
