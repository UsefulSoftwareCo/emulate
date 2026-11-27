import type { RouteContext } from "@emulators/core";
import { X_SCOPES } from "./oauth.js";

/**
 * Serves a curated OpenAPI 3.0 subset of the X (Twitter) v2 API, pointed at this
 * emulator instance. It declares the three real X security schemes (app-only
 * BearerToken, OAuth 2.0 user-context with PKCE, and the legacy OAuth 1.0a
 * UserToken modelled as a partial/unsupported surface) and the operations this
 * emulator actually implements. Served at both /2/openapi.json (X's real path)
 * and /openapi.json (the emulate convention).
 */
export function openapiRoutes({ app, baseUrl }: RouteContext): void {
  const handler = (c: { json: (v: unknown) => Response }) => c.json(buildSpec(baseUrl));
  app.get("/2/openapi.json", handler);
  app.get("/openapi.json", handler);
}

const ok = (description: string) => ({
  description,
  content: { "application/json": { schema: { type: "object" } } },
});

function buildSpec(baseUrl: string): Record<string, unknown> {
  const userScopes = Object.fromEntries(X_SCOPES.map((s) => [s, `Scope: ${s}`]));
  return {
    openapi: "3.0.3",
    info: {
      title: "X API v2 (Emulated)",
      version: "2.0.0",
      description:
        "Emulated subset of the X (formerly Twitter) API v2. Supports app-only Bearer tokens (client_credentials), the OAuth 2.0 Authorization Code flow with PKCE (user context), direct messages, DM media upload and download, webhooks with X Activity API DM subscriptions, and a documented-partial legacy OAuth 1.0a user context. Limited responses carry x-rate-limit-limit, x-rate-limit-remaining and x-rate-limit-reset (epoch seconds); a spent window answers 429.",
    },
    servers: [{ url: baseUrl }],
    components: {
      securitySchemes: {
        // App-only Bearer token, minted via POST /2/oauth2/token grant_type=client_credentials.
        BearerToken: {
          type: "http",
          scheme: "bearer",
          description:
            "App-only Bearer token (OAuth 2.0 client_credentials). Minted with client_secret_basic (HTTP Basic) only; client_secret_post is not supported. Read-only public endpoints.",
        },
        // OAuth 2.0 Authorization Code with PKCE (S256). User context.
        OAuth2UserToken: {
          type: "oauth2",
          description:
            "OAuth 2.0 Authorization Code with PKCE (S256). User-context access and writes. Confidential clients authenticate with client_secret_basic (HTTP Basic) only; client_secret_post is not supported.",
          flows: {
            authorizationCode: {
              authorizationUrl: `${baseUrl}/2/oauth2/authorize`,
              tokenUrl: `${baseUrl}/2/oauth2/token`,
              scopes: userScopes,
            },
          },
        },
        // Legacy OAuth 1.0a user context — declared faithfully but NOT implemented.
        UserToken: {
          type: "http",
          scheme: "OAuth",
          description:
            "Legacy OAuth 1.0a user context. Declared for fidelity but emulated as a partial/unsupported surface; the emulator does not validate OAuth 1.0a signatures.",
        },
      },
    },
    security: [{ BearerToken: [] }, { OAuth2UserToken: [...X_SCOPES] }],
    paths: {
      "/2/oauth2/token": {
        post: {
          operationId: "oauth2Token",
          summary: "Token endpoint (authorization_code, refresh_token, client_credentials)",
          responses: { "200": ok("Token response."), "400": ok("OAuth error."), "401": ok("invalid_client.") },
        },
      },
      "/2/oauth2/revoke": {
        post: { operationId: "oauth2Revoke", summary: "Revoke a token", responses: { "200": ok("Revoked.") } },
      },
      "/2/users/me": {
        get: {
          operationId: "findMyUser",
          summary: "Get the authenticated user",
          security: [{ OAuth2UserToken: ["users.read"] }],
          responses: { "200": ok("User object."), "401": ok("Unauthorized."), "403": ok("Insufficient scope.") },
        },
      },
      "/2/users/{id}": {
        get: {
          operationId: "findUserById",
          summary: "Get a user by id",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          security: [{ BearerToken: [] }, { OAuth2UserToken: ["users.read"] }],
          responses: { "200": ok("User object."), "404": ok("Not found.") },
        },
      },
      "/2/users/by/username/{username}": {
        get: {
          operationId: "findUserByUsername",
          summary: "Get a user by username",
          parameters: [{ name: "username", in: "path", required: true, schema: { type: "string" } }],
          security: [{ BearerToken: [] }, { OAuth2UserToken: ["users.read"] }],
          responses: { "200": ok("User object."), "404": ok("Not found.") },
        },
      },
      "/2/users/{id}/tweets": {
        get: {
          operationId: "usersIdTweets",
          summary: "Get a user's Tweets timeline",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          security: [{ BearerToken: [] }, { OAuth2UserToken: ["tweet.read", "users.read"] }],
          responses: { "200": ok("Tweet list."), "404": ok("Not found.") },
        },
      },
      "/2/tweets/{id}": {
        get: {
          operationId: "findTweetById",
          summary: "Get a Tweet by id",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          security: [{ BearerToken: [] }, { OAuth2UserToken: ["tweet.read"] }],
          responses: { "200": ok("Tweet object."), "404": ok("Not found.") },
        },
        delete: {
          operationId: "deleteTweetById",
          summary: "Delete a Tweet",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          security: [{ OAuth2UserToken: ["tweet.write"] }],
          responses: { "200": ok("Deletion result."), "403": ok("Insufficient scope.") },
        },
      },
      ...dmPaths(),
      "/2/tweets": {
        get: {
          operationId: "findTweetsById",
          summary: "Get Tweets by ids",
          parameters: [{ name: "ids", in: "query", required: true, schema: { type: "string" } }],
          security: [{ BearerToken: [] }, { OAuth2UserToken: ["tweet.read"] }],
          responses: { "200": ok("Tweet list."), "400": ok("Invalid request.") },
        },
        post: {
          operationId: "createTweet",
          summary: "Create a Tweet",
          security: [{ OAuth2UserToken: ["tweet.write"] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { type: "object", required: ["text"], properties: { text: { type: "string" } } },
              },
            },
          },
          responses: { "201": ok("Created Tweet."), "403": ok("Insufficient scope.") },
        },
      },
    },
  };
}

const path = (name: string) => ({ name, in: "path", required: true, schema: { type: "string" } });
const query = (name: string, schema: Record<string, unknown> = { type: "string" }) => ({
  name,
  in: "query",
  required: false,
  schema,
});
const rateLimited = { "429": ok("Rate limit exceeded: {errors:[{code:88,message}]}.") };
const dmListParams = [
  query("max_results", { type: "integer", minimum: 1, maximum: 100, default: 100 }),
  query("pagination_token", { type: "string", minLength: 16 }),
  query("event_types"),
  query("dm_event.fields"),
  query("expansions"),
  query("user.fields"),
  query("media.fields"),
];
const DM_READ = [{ OAuth2UserToken: ["dm.read", "tweet.read", "users.read"] }];
const DM_WRITE = [{ OAuth2UserToken: ["dm.write", "tweet.read", "users.read"] }];
const MEDIA_WRITE = [{ OAuth2UserToken: ["media.write"] }];
const ANY = [{ BearerToken: [] }, { OAuth2UserToken: [] }];
const json = (properties: Record<string, unknown>, required: string[] = []) => ({
  required: true,
  content: { "application/json": { schema: { type: "object", required, properties } } },
});
const sendBody = json({
  text: { type: "string", minLength: 1 },
  attachments: { type: "array", items: { type: "object", properties: { media_id: { type: "string" } } } },
});

function dmPaths(): Record<string, unknown> {
  return {
    "/2/dm_events": {
      get: {
        operationId: "getDirectMessagesEvents",
        summary: "Get DM events across the user's conversations",
        parameters: dmListParams,
        security: DM_READ,
        responses: { "200": ok("DM events, newest first."), ...rateLimited },
      },
    },
    "/2/dm_events/{event_id}": {
      get: {
        operationId: "getDirectMessagesEventsById",
        summary: "Get a DM event by id",
        parameters: [path("event_id"), query("dm_event.fields"), query("expansions")],
        security: DM_READ,
        responses: { "200": ok("DM event."), ...rateLimited },
      },
      delete: {
        operationId: "deleteDirectMessagesEvents",
        summary: "Delete a DM event you sent",
        parameters: [path("event_id")],
        security: [{ OAuth2UserToken: ["dm.read", "dm.write"] }],
        responses: { "200": ok("Deleted."), ...rateLimited },
      },
    },
    "/2/dm_conversations/with/{participant_id}/dm_events": {
      get: {
        operationId: "getDirectMessagesEventsByParticipantId",
        summary: "Get events of the one-to-one conversation with a participant",
        parameters: [path("participant_id"), ...dmListParams],
        security: DM_READ,
        responses: { "200": ok("DM events."), ...rateLimited },
      },
    },
    "/2/dm_conversations/{id}/dm_events": {
      get: {
        operationId: "getDirectMessagesEventsByConversationId",
        summary: "Get events of a conversation by id",
        parameters: [path("id"), ...dmListParams],
        security: DM_READ,
        responses: { "200": ok("DM events."), ...rateLimited },
      },
    },
    "/2/dm_conversations/with/{participant_id}/messages": {
      post: {
        operationId: "createDirectMessagesByParticipantId",
        summary: "Send a DM to a participant",
        parameters: [path("participant_id")],
        security: DM_WRITE,
        requestBody: sendBody,
        responses: { "201": ok("{data:{dm_conversation_id, dm_event_id}}."), ...rateLimited },
      },
    },
    "/2/dm_conversations/{dm_conversation_id}/messages": {
      post: {
        operationId: "createDirectMessagesByConversationId",
        summary: "Send a DM to a conversation",
        parameters: [path("dm_conversation_id")],
        security: DM_WRITE,
        requestBody: sendBody,
        responses: { "201": ok("{data:{dm_conversation_id, dm_event_id}}."), ...rateLimited },
      },
    },
    "/2/dm_conversations": {
      post: {
        operationId: "createDirectMessagesConversation",
        summary: "Create a group conversation",
        security: DM_WRITE,
        requestBody: json(
          { conversation_type: { type: "string", enum: ["Group"] }, participant_ids: { type: "array" }, message: {} },
          ["conversation_type", "participant_ids", "message"],
        ),
        responses: { "201": ok("{data:{dm_conversation_id, dm_event_id}}."), ...rateLimited },
      },
    },
    "/2/dm_conversations/media/{dm_id}/{media_id}/{resource_id}": {
      get: {
        operationId: "dmConversationsMediaDownload",
        summary: "Download DM media",
        parameters: [path("dm_id"), path("media_id"), path("resource_id")],
        security: [{ OAuth2UserToken: ["dm.read"] }],
        responses: {
          "200": {
            description: "Raw bytes.",
            content: { "application/octet-stream": { schema: { type: "string", format: "binary" } } },
          },
        },
      },
    },
    "/2/media/upload": {
      post: {
        operationId: "mediaUpload",
        summary: "Upload media in one request",
        security: MEDIA_WRITE,
        requestBody: json({ media: { type: "string", format: "byte" }, media_category: { type: "string" } }, [
          "media",
          "media_category",
        ]),
        responses: { "200": ok("{data:{id, media_key, size, ...}}."), ...rateLimited },
      },
      get: {
        operationId: "getMediaUploadStatus",
        summary: "Media upload status",
        parameters: [query("media_id"), query("command")],
        security: MEDIA_WRITE,
        responses: { "200": ok("Processing info."), ...rateLimited },
      },
    },
    "/2/media/upload/initialize": {
      post: {
        operationId: "initializeMediaUpload",
        summary: "Start a chunked upload",
        security: MEDIA_WRITE,
        requestBody: json({
          media_category: { type: "string" },
          media_type: { type: "string" },
          total_bytes: { type: "integer" },
        }),
        responses: { "200": ok("{data:{id, media_key, expires_after_secs}}."), ...rateLimited },
      },
    },
    "/2/media/upload/{id}/append": {
      post: {
        operationId: "appendMediaUpload",
        summary: "Append a segment",
        parameters: [path("id")],
        security: MEDIA_WRITE,
        requestBody: json({ media: { type: "string", format: "byte" }, segment_index: { type: "integer" } }, [
          "media",
          "segment_index",
        ]),
        responses: { "200": ok("{data:{expires_at}}."), ...rateLimited },
      },
    },
    "/2/media/upload/{id}/finalize": {
      post: {
        operationId: "finalizeMediaUpload",
        summary: "Finalize a chunked upload",
        parameters: [path("id")],
        security: MEDIA_WRITE,
        responses: { "200": ok("{data:{id, media_key, size, processing_info?}}."), ...rateLimited },
      },
    },
    "/2/webhooks": {
      get: {
        operationId: "getWebhooks",
        summary: "List webhook configs",
        security: ANY,
        responses: { "200": ok("Webhooks.") },
      },
      post: {
        operationId: "createWebhooks",
        summary: "Create a webhook (sends the CRC first)",
        security: ANY,
        requestBody: json({ url: { type: "string", maxLength: 200 } }, ["url"]),
        responses: { "200": ok("{data:{id, url, valid, created_at}}."), "400": ok("CrcValidationFailed and others.") },
      },
    },
    "/2/webhooks/{webhook_id}": {
      put: {
        operationId: "validateWebhooks",
        summary: "Trigger a CRC",
        parameters: [path("webhook_id")],
        security: ANY,
        responses: { "200": ok("{data:{valid}}.") },
      },
      delete: {
        operationId: "deleteWebhooks",
        summary: "Delete a webhook config",
        parameters: [path("webhook_id")],
        security: ANY,
        responses: { "200": ok("{data:{deleted}}.") },
      },
    },
    "/2/activity/subscriptions": {
      post: {
        operationId: "createActivitySubscription",
        summary: "Subscribe a webhook to a user's DM events (dm.sent, dm.received)",
        security: ANY,
        requestBody: json(
          {
            event_type: { type: "string", enum: ["dm.sent", "dm.received", "dm.read", "dm.indicate_typing"] },
            filter: { type: "object", properties: { user_id: { type: "string" } } },
            webhook_id: { type: "string" },
            tag: { type: "string" },
            expires_at: { type: "string" },
          },
          ["event_type", "filter"],
        ),
        responses: { "200": ok("{data:{subscription}}.") },
      },
      get: {
        operationId: "getActivitySubscriptions",
        summary: "List the app's subscriptions",
        parameters: [query("user_id"), query("max_results", { type: "integer", minimum: 1, maximum: 1000 })],
        security: ANY,
        responses: { "200": ok("Subscriptions.") },
      },
      delete: {
        operationId: "deleteActivitySubscriptionsByIds",
        summary: "Delete several subscriptions",
        parameters: [{ ...query("ids"), required: true }],
        security: [{ BearerToken: [] }],
        responses: { "200": ok("Per-id results.") },
      },
    },
    "/2/activity/subscriptions/{subscription_id}": {
      put: {
        operationId: "updateActivitySubscription",
        summary: "Update tag or webhook_id",
        parameters: [path("subscription_id")],
        security: ANY,
        responses: { "200": ok("{data:{subscription}}.") },
      },
      delete: {
        operationId: "deleteActivitySubscription",
        summary: "Delete a subscription",
        parameters: [path("subscription_id")],
        security: ANY,
        responses: { "200": ok("{data:{deleted}}.") },
      },
    },
  };
}
