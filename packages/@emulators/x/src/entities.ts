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
