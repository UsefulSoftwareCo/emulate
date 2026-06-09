import type { ServiceManifest } from "@emulators/core";

/**
 * Apple's machine-readable service manifest. This is the single source of truth
 * for Apple's Sign in with Apple surfaces, OAuth/OIDC auth, seed shape, and
 * copyable connection snippets, consumed by the CLI registry, the Cloudflare
 * host, and the console.
 */
export const manifest: ServiceManifest = {
  id: "apple",
  name: "Apple Sign In / OAuth",
  description: "Stateful Sign in with Apple emulator for OAuth authorization code and OpenID Connect flows.",
  docsUrl: "https://docs.emulators.dev/apple",
  surfaces: [
    { id: "oauth", kind: "oauth", title: "Sign in with Apple", status: "supported", basePath: "/auth" },
    { id: "oidc", kind: "oidc", title: "OpenID Connect", status: "supported", basePath: "/.well-known" },
  ],
  auth: [
    { id: "oauth-code", title: "OAuth authorization code", type: "oauth-authorization-code", status: "supported" },
    { id: "oidc", title: "OIDC identity tokens", type: "oidc", status: "supported" },
  ],
  specs: [
    {
      kind: "oauth-metadata",
      title: "Apple OIDC metadata",
      coverage: "hand-authored",
      operations: [
        {
          operationId: "openid-configuration",
          method: "GET",
          path: "/.well-known/openid-configuration",
          status: "hand-authored",
          summary: "OIDC discovery document.",
        },
        {
          operationId: "jwks",
          method: "GET",
          path: "/auth/keys",
          status: "hand-authored",
          summary: "JWKS signing keys.",
        },
        {
          operationId: "authorize",
          method: "GET",
          path: "/auth/authorize",
          status: "hand-authored",
          summary: "Sign in with Apple authorization page.",
        },
        {
          operationId: "authorize-callback",
          method: "POST",
          path: "/auth/authorize/callback",
          status: "hand-authored",
          summary: "Issues an authorization code after user selection.",
        },
        {
          operationId: "token",
          method: "POST",
          path: "/auth/token",
          status: "hand-authored",
          summary: "Exchanges authorization codes and refresh tokens for access and id tokens.",
        },
        {
          operationId: "revoke",
          method: "POST",
          path: "/auth/revoke",
          status: "hand-authored",
          summary: "Revokes an access or refresh token.",
        },
      ],
    },
  ],
  seedSchema: {
    description: "Seed Apple ID users and registered Sign in with Apple service clients.",
    fields: [
      {
        key: "users",
        title: "Users",
        description: "Apple ID accounts addressable by email, optionally using private relay.",
        example: [{ email: "testuser@icloud.com", name: "Test User", is_private_email: false }],
      },
      {
        key: "oauth_clients",
        title: "OAuth clients",
        description: "Registered service IDs with team id and redirect URIs.",
        example: [
          {
            client_id: "com.example.app",
            team_id: "TEAM001",
            name: "My Apple App",
            redirect_uris: ["http://localhost:3000/api/auth/callback/apple"],
          },
        ],
      },
    ],
    example: {
      users: [{ email: "testuser@icloud.com", name: "Test User", is_private_email: false }],
      oauth_clients: [
        {
          client_id: "com.example.app",
          team_id: "TEAM001",
          name: "My Apple App",
          redirect_uris: ["http://localhost:3000/api/auth/callback/apple"],
        },
      ],
    },
  },
  stateModel: {
    description: "Entities mutated by Apple Sign in with Apple flows.",
    collections: [{ name: "apple.users" }, { name: "apple.oauth_clients" }],
  },
  connections: [
    {
      id: "openid-client",
      title: "openid-client (TypeScript)",
      kind: "sdk",
      language: "typescript",
      description: "Discover the emulator issuer and run the authorization code flow.",
      template:
        'import * as client from "openid-client";\n\nconst config = await client.discovery(\n  new URL("{{baseUrl}}"),\n  "{{clientId}}",\n  "{{clientSecret}}",\n);',
    },
    {
      id: "apple-env",
      title: "Sign in with Apple (env)",
      kind: "env",
      language: "bash",
      description: "Point your auth library at the emulator issuer and endpoints.",
      template:
        "APPLE_ISSUER={{baseUrl}}\nAPPLE_AUTHORIZATION_URL={{baseUrl}}/auth/authorize\nAPPLE_TOKEN_URL={{baseUrl}}/auth/token\nAPPLE_JWKS_URL={{baseUrl}}/auth/keys\nAPPLE_CLIENT_ID={{clientId}}\nAPPLE_CLIENT_SECRET={{clientSecret}}",
    },
    {
      id: "curl-discovery",
      title: "curl OIDC discovery",
      kind: "curl",
      language: "bash",
      description: "Fetch the OpenID Connect discovery document.",
      template: "curl -s {{baseUrl}}/.well-known/openid-configuration",
    },
    {
      id: "curl-token",
      title: "curl token exchange",
      kind: "curl",
      language: "bash",
      description: "Exchange an authorization code for tokens.",
      template:
        'curl -s -X POST {{baseUrl}}/auth/token \\\n  -H "content-type: application/x-www-form-urlencoded" \\\n  -d "grant_type=authorization_code&code=<code>&client_id={{clientId}}&client_secret={{clientSecret}}"',
    },
  ],
};
