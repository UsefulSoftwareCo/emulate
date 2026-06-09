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
    "Stateful X (formerly Twitter) API v2 emulator focused on faithful auth: app-only Bearer tokens, OAuth 2.0 Authorization Code with PKCE, and a documented-partial legacy OAuth 1.0a surface.",
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
