import type { ServiceManifest } from "@emulators/core";

/**
 * X's machine-readable service manifest. The single source of truth for X's
 * surfaces, auth, specs, seed shape, and copyable connection snippets, consumed
 * by the CLI registry, the Cloudflare host, and the console.
 *
 * X is modelled around its real authentication strategies: an app-only Bearer
 * token (OAuth 2.0 client_credentials), the OAuth 2.0 Authorization Code flow
 * with PKCE for user context, and the legacy OAuth 1.0a user context declared as
 * a documented-partial surface. There is intentionally no GraphQL or MCP surface
 * because the public X API v2 does not expose them.
 */
export const manifest: ServiceManifest = {
  id: "x",
  name: "X",
  description:
    "Stateful X (formerly Twitter) API v2 emulator: app-only Bearer tokens, OAuth 2.0 Authorization Code with PKCE, users, Posts, direct messages, DM media upload and download, webhooks with the CRC and X Activity API DM events, and X's per-endpoint rate limits.",
  docsUrl: "https://docs.emulators.dev/x",
  surfaces: [
    { id: "rest", kind: "rest", title: "X API v2 (REST)", status: "partial", basePath: "/2" },
    {
      id: "oauth2",
      kind: "oauth",
      title: "OAuth 2.0 Authorization Code (PKCE)",
      status: "supported",
      basePath: "/2/oauth2",
    },
    {
      id: "app-only",
      kind: "oauth",
      title: "App-only Bearer token (client credentials)",
      status: "supported",
      basePath: "/2/oauth2/token",
    },
    {
      id: "webhooks",
      kind: "webhooks",
      title: "Webhooks (CRC) and X Activity API DM events",
      status: "partial",
      basePath: "/2/webhooks",
      notes:
        "Webhook configs with the CRC at creation and on PUT; X Activity API subscriptions for dm.sent and dm.received, delivered as the documented envelope and signed with X-Twitter-Webhooks-Signature-OAuth2 (client secret) plus X-Twitter-Webhooks-Signature when a consumer_secret is seeded. Other XAA event types, the persistent stream, replay, filter qualifiers and the hourly CRC are not emulated. CRC delivery mode `control` (POST /_emulate/x/webhooks/crc-delivery) is an emulator mode, not X behaviour. Emulator-only relaxation: in control mode POST /2/webhooks also accepts an http address and one with a port, which X refuses, so a test can register a local receiver and preview its deliveries; the emulator never calls such an address, and its deliveries are held (listed as held, previewable with POST /_emulate/x/dm/preview-delivery). Outbound mode keeps X's rule: https, no port, at most 200 characters. As on X, deliveries go only to a webhook whose challenge was answered: X's CRC at creation or on PUT in outbound mode, or a correct answer at POST /_emulate/x/webhooks/:id/challenge in control mode; until then, and for a seeded webhook until PUT, they are held.",
    },
    {
      id: "account-activity",
      kind: "webhooks",
      title: "Account Activity API (deprecated by X)",
      status: "unsupported",
      basePath: "/2/account_activity",
      notes:
        "X marks the Account Activity API as deprecated in favour of the X Activity API (https://docs.x.com/x-api/account-activity/introduction); its subscription routes are not emulated.",
    },
    {
      id: "rate-limits",
      kind: "provider-specific",
      title: "Rate limits (x-rate-limit-* headers, 429 code 88)",
      status: "supported",
      notes:
        "Per-endpoint fixed windows from https://docs.x.com/x-api/fundamentals/rate-limits, per user for user tokens and per app for app-only tokens (and as an app-wide cap on user-only endpoints). Overridable per instance with the rate_limits seed field or POST /_emulate/x/rate-limits.",
    },
    {
      id: "oauth1",
      kind: "provider-specific",
      title: "Legacy OAuth 1.0a user context",
      status: "unsupported",
      notes: "Declared for fidelity. Signature validation is not implemented.",
    },
  ],
  auth: [
    {
      id: "bearer-token",
      title: "App-only Bearer token",
      type: "bearer-token",
      status: "supported",
      notes: "Minted via POST /2/oauth2/token grant_type=client_credentials with HTTP Basic client auth.",
    },
    {
      id: "oauth2-user",
      title: "OAuth 2.0 Authorization Code with PKCE",
      type: "oauth-authorization-code",
      status: "supported",
      notes:
        "Confidential clients authenticate with client_secret_basic (HTTP Basic header) only; X does not support client_secret_post, so a secret in the request body is rejected. Public clients send client_id in the body and rely on PKCE (S256). offline.access yields a refresh token.",
    },
    {
      id: "oauth1-user",
      title: "Legacy OAuth 1.0a user context",
      type: "provider-specific",
      status: "unsupported",
      notes: "Accepted honestly as a partial surface; OAuth 1.0a request signing is not emulated.",
    },
  ],
  specs: [
    {
      kind: "openapi",
      title: "X API v2 subset",
      coverage: "hand-authored",
      url: "/2/openapi.json",
      operations: [
        {
          operationId: "oauth2Token",
          method: "POST",
          path: "/2/oauth2/token",
          status: "hand-authored",
          summary: "authorization_code (PKCE), refresh_token, and client_credentials grants.",
        },
        { operationId: "oauth2Revoke", method: "POST", path: "/2/oauth2/revoke", status: "hand-authored" },
        {
          operationId: "findMyUser",
          method: "GET",
          path: "/2/users/me",
          status: "hand-authored",
          summary: "User-context token with users.read.",
        },
        { operationId: "findUserById", method: "GET", path: "/2/users/:id", status: "hand-authored" },
        {
          operationId: "findUserByUsername",
          method: "GET",
          path: "/2/users/by/username/:username",
          status: "hand-authored",
        },
        { operationId: "usersIdTweets", method: "GET", path: "/2/users/:id/tweets", status: "hand-authored" },
        { operationId: "findTweetById", method: "GET", path: "/2/tweets/:id", status: "hand-authored" },
        { operationId: "findTweetsById", method: "GET", path: "/2/tweets", status: "hand-authored" },
        {
          operationId: "createTweet",
          method: "POST",
          path: "/2/tweets",
          status: "hand-authored",
          summary: "User-context token with tweet.write.",
        },
        { operationId: "deleteTweetById", method: "DELETE", path: "/2/tweets/:id", status: "hand-authored" },
        {
          operationId: "tweetsRecentSearch",
          method: "GET",
          path: "/2/tweets/search/recent",
          status: "unsupported",
        },
        { operationId: "usersIdFollow", method: "POST", path: "/2/users/:id/following", status: "unsupported" },
        { operationId: "usersIdLike", method: "POST", path: "/2/users/:id/likes", status: "unsupported" },
        {
          operationId: "getDirectMessagesEventsByParticipantId",
          method: "GET",
          path: "/2/dm_conversations/with/:participant_id/dm_events",
          status: "hand-authored",
          summary: "One-to-one conversation events. dm.read, tweet.read, users.read.",
        },
        {
          operationId: "createDirectMessagesByParticipantId",
          method: "POST",
          path: "/2/dm_conversations/with/:participant_id/messages",
          status: "hand-authored",
          summary: "Send to a participant. dm.write, tweet.read, users.read.",
        },
        {
          operationId: "dmConversationsMediaDownload",
          method: "GET",
          path: "/2/dm_conversations/media/:dm_id/:media_id/:resource_id",
          status: "partial",
          summary:
            "Streams a DM attachment to a participant with dm.read. Seeded and generated media are deterministic placeholder bytes; the media url X returns is not documented, so includes.media.url points here.",
        },
        {
          operationId: "getDirectMessagesEventsByConversationId",
          method: "GET",
          path: "/2/dm_conversations/:id/dm_events",
          status: "hand-authored",
        },
        {
          operationId: "createDirectMessagesByConversationId",
          method: "POST",
          path: "/2/dm_conversations/:dm_conversation_id/messages",
          status: "hand-authored",
        },
        {
          operationId: "createDirectMessagesConversation",
          method: "POST",
          path: "/2/dm_conversations",
          status: "hand-authored",
          summary: "Group conversation with an initial message.",
        },
        {
          operationId: "getDirectMessagesEvents",
          method: "GET",
          path: "/2/dm_events",
          status: "hand-authored",
          summary:
            "All of the user's DM events, newest first, 30-day retention, max_results 1-100, base32hex pagination tokens. referenced_posts are never present.",
        },
        {
          operationId: "getDirectMessagesEventsById",
          method: "GET",
          path: "/2/dm_events/:event_id",
          status: "hand-authored",
        },
        {
          operationId: "deleteDirectMessagesEvents",
          method: "DELETE",
          path: "/2/dm_events/:event_id",
          status: "hand-authored",
          summary: "Sender only. dm.read, dm.write.",
        },
        {
          operationId: "initializeMediaUpload",
          method: "POST",
          path: "/2/media/upload/initialize",
          status: "hand-authored",
        },
        {
          operationId: "appendMediaUpload",
          method: "POST",
          path: "/2/media/upload/:id/append",
          status: "hand-authored",
          summary: "JSON (base64) or multipart segments of up to 8 MB.",
        },
        {
          operationId: "finalizeMediaUpload",
          method: "POST",
          path: "/2/media/upload/:id/finalize",
          status: "partial",
          summary: "No processing: video reports processing_info.state succeeded at once; dimensions are not decoded.",
        },
        {
          operationId: "mediaUpload",
          method: "POST",
          path: "/2/media/upload",
          status: "partial",
          summary: "Single-request upload, JSON or multipart. media.write. Dimensions are not decoded.",
        },
        { operationId: "getMediaUploadStatus", method: "GET", path: "/2/media/upload", status: "hand-authored" },
        { operationId: "getMediaByMediaKey", method: "GET", path: "/2/media/:media_key", status: "unsupported" },
        {
          operationId: "chatMediaUploadInitialize",
          method: "POST",
          path: "/2/chat/media/upload/initialize",
          status: "unsupported",
        },
        { operationId: "getWebhooks", method: "GET", path: "/2/webhooks", status: "hand-authored" },
        {
          operationId: "createWebhooks",
          method: "POST",
          path: "/2/webhooks",
          status: "hand-authored",
          summary: "Sends the CRC first and refuses a wrong answer (CrcValidationFailed).",
        },
        { operationId: "validateWebhooks", method: "PUT", path: "/2/webhooks/:webhook_id", status: "hand-authored" },
        { operationId: "deleteWebhooks", method: "DELETE", path: "/2/webhooks/:webhook_id", status: "hand-authored" },
        { operationId: "createWebhookReplayJob", method: "POST", path: "/2/webhooks/replay", status: "unsupported" },
        {
          operationId: "createActivitySubscription",
          method: "POST",
          path: "/2/activity/subscriptions",
          status: "partial",
          summary:
            "dm.sent and dm.received are delivered; dm.read and dm.indicate_typing are accepted but never fire; other event types are refused.",
        },
        {
          operationId: "getActivitySubscriptions",
          method: "GET",
          path: "/2/activity/subscriptions",
          status: "partial",
          summary: "No pagination_token; up to max_results are returned.",
        },
        {
          operationId: "deleteActivitySubscriptionsByIds",
          method: "DELETE",
          path: "/2/activity/subscriptions",
          status: "hand-authored",
        },
        {
          operationId: "updateActivitySubscription",
          method: "PUT",
          path: "/2/activity/subscriptions/:subscription_id",
          status: "hand-authored",
        },
        {
          operationId: "deleteActivitySubscription",
          method: "DELETE",
          path: "/2/activity/subscriptions/:subscription_id",
          status: "hand-authored",
        },
        { operationId: "activityStream", method: "GET", path: "/2/activity/stream", status: "unsupported" },
        {
          operationId: "createAccountActivitySubscription",
          method: "POST",
          path: "/2/account_activity/webhooks/:webhook_id/subscriptions/all",
          status: "unsupported",
          summary: "Account Activity API is deprecated by X; use the X Activity API.",
        },
      ],
    },
    {
      kind: "oauth-metadata",
      title: "OAuth 2.0 client-auth behavior (confidential clients use client_secret_basic only)",
      coverage: "hand-authored",
    },
  ],
  scenarios: [
    {
      id: "default",
      title: "Single developer account",
      description: "One verified user with a seeded confidential and public OAuth client.",
    },
    {
      id: "dm-backfill",
      title: "Direct-message backfill",
      description:
        "Seed dm_bulk (or dm_conversations with generate) to give a user thousands of computed DM events to page through under X's rate limits.",
    },
  ],
  seedSchema: {
    description: "Seed users, OAuth 2.0 clients (confidential or public), and Tweets.",
    fields: [
      {
        key: "users",
        title: "Users",
        description: "X accounts addressable by username (@handle) and numeric id.",
        example: [{ username: "developer", name: "Developer", verified: true }],
      },
      {
        key: "oauth_clients",
        title: "OAuth 2.0 clients",
        description:
          "Confidential clients have a client_secret and use HTTP Basic auth; public clients omit it and use PKCE only.",
        example: [
          {
            client_id: "x-confidential-client",
            client_secret: "x-confidential-secret",
            client_type: "confidential",
            name: "My X App",
            redirect_uris: ["http://localhost:3000/api/auth/callback/twitter"],
          },
          { client_id: "x-public-client", client_type: "public", name: "My X SPA" },
        ],
      },
      {
        key: "tweets",
        title: "Tweets",
        description: "Tweets authored by a seeded user (referenced by username or id).",
        example: [{ text: "Hello from X.", author: "developer", like_count: 42 }],
      },
      {
        key: "dm_conversations",
        title: "Direct-message conversations",
        description:
          "Participants by username or id (two make a one-to-one conversation). Explicit messages are stored; generate:{count, start?, interval_seconds?, attachment_every?, attachment_bytes?} describes history computed on demand and never stored.",
        example: [
          {
            participants: ["developer", "alice"],
            messages: [{ from: "alice", text: "Hi!", attachment: { bytes: 4194304, media_type: "image/jpeg" } }],
            generate: { count: 2000, interval_seconds: 60, attachment_every: 50 },
          },
        ],
      },
      {
        key: "dm_bulk",
        title: "Many generated conversations",
        description: "One user with N partners (created as users dm_partner_1..N), each with generated history.",
        example: { user: "developer", conversations: 50, events_per_conversation: 1000 },
      },
      {
        key: "rate_limits",
        title: "Rate-limit overrides",
        description:
          "{ enabled?, default?: {limit, window_seconds}, endpoints?: { <operationId>: {limit, window_seconds} } }. An override replaces X's windows for that endpoint with one window per user (user tokens) or per app (app-only tokens).",
        example: { endpoints: { getDirectMessagesEvents: { limit: 3, window_seconds: 5 } } },
      },
      {
        key: "webhooks",
        title: "Webhook configs",
        description: "Registered without a CRC, as if already validated.",
        example: [{ url: "https://example.test/webhooks/x", client_id: "x-confidential-client" }],
      },
      {
        key: "activity_subscriptions",
        title: "X Activity API subscriptions",
        description: "dm.sent or dm.received for a user, delivered to a webhook (id or url).",
        example: [{ event_type: "dm.received", user: "developer", webhook: "https://example.test/webhooks/x" }],
      },
      {
        key: "webhook_crc_delivery",
        title: "CRC delivery mode",
        description:
          "outbound (default, X's behaviour) or control: an emulator mode in which webhook creation sends no challenge, each challenge is held at GET /_emulate/x/webhooks/:id/challenge for the test to deliver, and webhook addresses may be http or carry a port (an emulator-only relaxation of X's rule).",
        example: "control",
      },
    ],
    example: {
      users: [{ username: "developer", name: "Developer", verified: true, followers_count: 1200 }],
      oauth_clients: [
        {
          client_id: "x-confidential-client",
          client_secret: "x-confidential-secret",
          client_type: "confidential",
          name: "My X App",
          redirect_uris: ["http://localhost:3000/api/auth/callback/twitter"],
        },
        { client_id: "x-public-client", client_type: "public", name: "My X SPA" },
      ],
      tweets: [{ text: "Hello from the X API v2 emulator.", author: "developer", like_count: 42, retweet_count: 7 }],
    },
  },
  stateModel: {
    description: "Entities seeded and mutated by X provider calls.",
    collections: [
      { name: "x.users", title: "Users" },
      { name: "x.tweets", title: "Tweets" },
      { name: "x.oauth_clients", title: "OAuth 2.0 clients" },
      { name: "x.auth_codes", title: "Authorization codes" },
      { name: "x.access_tokens", title: "Access tokens" },
      { name: "x.refresh_tokens", title: "Refresh tokens" },
      { name: "x.dm_conversations", title: "DM conversations (with any generated history spec)" },
      { name: "x.dm_events", title: "Stored DM events (sent, arrived, seeded)" },
      { name: "x.media", title: "Media" },
      { name: "x.media_chunks", title: "Uploaded media bytes, in parts" },
      { name: "x.webhooks", title: "Webhook configs" },
      { name: "x.activity_subscriptions", title: "X Activity API subscriptions" },
      { name: "x.pending_challenges", title: "CRC challenges held in control mode" },
      { name: "x.rate_windows", title: "Open rate-limit windows" },
    ],
  },
  connections: [
    {
      id: "twitter-api-v2",
      title: "twitter-api-v2 (TypeScript)",
      kind: "sdk",
      language: "typescript",
      description: "Point the twitter-api-v2 SDK at the emulator for both app-only and user-context auth.",
      template:
        'import { TwitterApi } from "twitter-api-v2";\n\nconst base = "{{baseUrl}}";\n\n// App-only Bearer token (client_credentials).\nconst appClient = new TwitterApi("{{token}}", { baseUrl: base });\nconst user = await appClient.v2.userByUsername("developer");\n\n// OAuth 2.0 user-context client (Authorization Code with PKCE).\nconst oauthClient = new TwitterApi({ clientId: "{{clientId}}", clientSecret: "{{clientSecret}}" });\nconst { url, codeVerifier, state } = oauthClient.generateOAuth2AuthLink(\n  "http://localhost:3000/api/auth/callback/twitter",\n  { scope: ["tweet.read", "tweet.write", "users.read", "offline.access"] },\n);\n// Send the user to `url` (against `${base}/2/oauth2/authorize`), then exchange the code at `${base}/2/oauth2/token`.',
    },
    {
      id: "x-env",
      title: "X base URL and credentials (env)",
      kind: "env",
      language: "bash",
      description: "Point your app at the emulator instead of api.x.com.",
      template:
        "X_API_BASE_URL={{baseUrl}}\nX_CLIENT_ID={{clientId}}\nX_CLIENT_SECRET={{clientSecret}}\nX_BEARER_TOKEN={{token}}",
    },
    {
      id: "curl-app-only",
      title: "curl (app-only Bearer)",
      kind: "curl",
      language: "bash",
      description: "Mint an app-only Bearer token (confidential client, HTTP Basic auth) and read a user.",
      template:
        'curl -s -X POST {{baseUrl}}/2/oauth2/token \\\n  -u "{{clientId}}:{{clientSecret}}" \\\n  -d grant_type=client_credentials\n\ncurl -s {{baseUrl}}/2/users/by/username/developer \\\n  -H "authorization: Bearer {{token}}"',
    },
    {
      id: "curl-token-exchange",
      title: "curl (authorization code + PKCE)",
      kind: "curl",
      language: "bash",
      description:
        "Exchange an authorization code for a user-context token. Confidential clients use -u (Basic); public clients send client_id in the body with no secret.",
      template:
        'curl -s -X POST {{baseUrl}}/2/oauth2/token \\\n  -u "{{clientId}}:{{clientSecret}}" \\\n  -d grant_type=authorization_code \\\n  -d code=$CODE \\\n  -d redirect_uri=http://localhost:3000/api/auth/callback/twitter \\\n  -d code_verifier=$CODE_VERIFIER',
    },
  ],
};
