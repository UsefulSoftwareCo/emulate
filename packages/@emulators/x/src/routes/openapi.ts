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
        "Emulated subset of the X (formerly Twitter) API v2. Supports app-only Bearer tokens (client_credentials), the OAuth 2.0 Authorization Code flow with PKCE (user context), and a documented-partial legacy OAuth 1.0a user context.",
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
