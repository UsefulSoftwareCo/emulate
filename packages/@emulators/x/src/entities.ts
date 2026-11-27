import type { Entity } from "@emulators/core";

/**
 * An X (Twitter) user, addressable by its numeric v2 `user_id` string and by
 * `username` (the @handle, case-insensitively normalized to lowercase on lookup).
 */
export interface XUser extends Entity {
  user_id: string;
  username: string;
  name: string;
  description: string;
  verified: boolean;
  protected: boolean;
  location: string | null;
  url: string | null;
  profile_image_url: string | null;
  followers_count: number;
  following_count: number;
  tweet_count: number;
  listed_count: number;
  created_at_x: string;
}

/** A Tweet (Post) in the v2 model. */
export interface XTweet extends Entity {
  tweet_id: string;
  author_id: string;
  text: string;
  reply_count: number;
  retweet_count: number;
  like_count: number;
  quote_count: number;
  impression_count: number;
  in_reply_to_user_id: string | null;
  conversation_id: string;
  lang: string;
  possibly_sensitive: boolean;
  created_at_x: string;
}

/**
 * A registered OAuth 2.0 client. Confidential clients have a `client_secret` and
 * authenticate at the token endpoint with an HTTP Basic Authorization header.
 * Public clients have no secret and authenticate via PKCE only, supplying their
 * `client_id` in the request body.
 */
export interface XOAuthClient extends Entity {
  client_id: string;
  client_secret: string | null;
  client_type: "confidential" | "public";
  name: string;
  redirect_uris: string[];
  /**
   * The app's legacy OAuth 1.0a consumer secret (API Secret Key), when seeded.
   * X signs webhook deliveries with it in `X-Twitter-Webhooks-Signature` and
   * accepts a CRC response computed with it.
   */
  consumer_secret?: string | null;
}

/**
 * An authorization code minted at `GET /2/oauth2/authorize` and redeemed once at
 * `POST /2/oauth2/token`. Bound to the PKCE challenge, the redirect_uri, the
 * granted scopes, and the authenticated user.
 */
export interface XAuthCode extends Entity {
  code: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  code_challenge_method: string;
  scopes: string[];
  user_id: string;
  expires: number;
}

/**
 * An issued access token. `app_only` tokens (client_credentials grant, the
 * BearerToken security scheme) have no `user_id`; user-context tokens
 * (authorization_code / refresh_token grants, the OAuth2UserToken scheme) carry
 * the authorizing user's id.
 */
export interface XAccessToken extends Entity {
  token: string;
  client_id: string;
  user_id: string | null;
  scopes: string[];
  app_only: boolean;
  expires: number;
}

/** A refresh token, issued only when `offline.access` is granted. */
export interface XRefreshToken extends Entity {
  token: string;
  client_id: string;
  user_id: string;
  scopes: string[];
}

/**
 * Synthetic history attached to a conversation by the seed. Events are computed
 * from their index on demand (never stored), so a seed can describe thousands of
 * events cheaply. Event `i` (0 is the oldest) is sent at `start_ms + i * interval_ms`
 * by `participant_ids[i % participant_ids.length]`.
 */
export interface XDmGeneratedHistory {
  count: number;
  start_ms: number;
  interval_ms: number;
  /** Every Nth event (counting from 1) carries one photo attachment; 0 for none. */
  attachment_every: number;
  attachment_bytes: number;
  attachment_media_type: string;
  text_prefix: string;
  /** Indexes of generated events deleted through DELETE /2/dm_events/:id. */
  deleted: number[];
}

/**
 * A direct-message conversation. One-to-one ids are `{smaller_id}-{larger_id}`;
 * group ids are numeric. `ordinal` (1 to 1022) is embedded in the ids of its
 * generated events so an event id leads back to its conversation.
 */
export interface XDmConversation extends Entity {
  conversation_id: string;
  conversation_type: "OneToOne" | "Group";
  participant_ids: string[];
  ordinal: number;
  generated: XDmGeneratedHistory | null;
}

/** A stored DM event (sent, arrived, or seeded explicitly). */
export interface XDmEvent extends Entity {
  event_id: string;
  dm_conversation_id: string;
  event_type: "MessageCreate" | "ParticipantsJoin" | "ParticipantsLeave";
  sender_id: string | null;
  text: string | null;
  participant_ids: string[] | null;
  media_keys: string[];
  created_at_ms: number;
}

/**
 * Uploaded media. Bytes live in `x.media_chunks` (each part kept small enough
 * for a Durable Object value); seeded media has no chunks and is served as
 * deterministic placeholder bytes of `size` length.
 */
export interface XMedia extends Entity {
  media_id: string;
  media_key: string;
  owner_id: string;
  additional_owners: string[];
  media_category: string;
  media_type: string;
  /** Declared size for a chunked upload, or the stored size once complete. */
  size: number;
  state: "uploading" | "succeeded";
  source: "uploaded" | "seeded";
  width: number | null;
  height: number | null;
  created_at_ms: number;
  expires_at_ms: number;
}

/** One stored part of an uploaded media file, ordered by (segment_index, part). */
export interface XMediaChunk extends Entity {
  media_id: string;
  segment_index: number;
  part: number;
  data_b64: string;
  byte_length: number;
}

/** A registered Account Activity webhook (POST /2/webhooks), owned by an app. */
export interface XWebhook extends Entity {
  webhook_id: string;
  client_id: string;
  url: string;
  valid: boolean;
  created_at_x: string;
}

/**
 * An X Activity API subscription (POST /2/activity/subscriptions): events of
 * `event_type` for `filter.user_id`, delivered to `webhook_id`.
 */
export interface XActivitySubscription extends Entity {
  subscription_id: string;
  client_id: string;
  event_type: string;
  user_id: string;
  webhook_id: string;
  tag: string | null;
  created_at_x: string;
  updated_at_x: string;
  expires_at_x: string | null;
}

/**
 * A CRC challenge the emulator holds for a test to deliver itself (instances in
 * the emulator's `control` CRC delivery mode, never X's default behaviour).
 */
export interface XPendingChallenge extends Entity {
  webhook_id: string;
  crc_token: string;
  created_at_ms: number;
  answered: boolean;
  valid: boolean | null;
}

/** One fixed rate-limit window counter, keyed by scope, endpoint and window. */
export interface XRateWindow extends Entity {
  key: string;
  limit: number;
  used: number;
  reset_at: number;
}
