import type { ServiceManifest } from "@emulators/core";

/**
 * Microsoft's machine-readable service manifest. This is the single source of
 * truth for Microsoft Entra ID's surfaces, auth, specs, seed shape, and copyable
 * connection snippets, consumed by the CLI registry, the Cloudflare host, and the
 * console.
 */
export const manifest: ServiceManifest = {
  id: "microsoft",
  name: "Microsoft Entra ID",
  description:
    "Stateful Microsoft Entra ID emulator for OAuth 2.0, OpenID Connect, Graph /me, logout, and token flows.",
  docsUrl: "https://docs.emulators.dev/microsoft",
  surfaces: [
    { id: "rest", kind: "rest", title: "Microsoft Graph (subset)", status: "partial", basePath: "/v1.0" },
    { id: "oauth", kind: "oauth", title: "Microsoft OAuth 2.0", status: "supported", basePath: "/oauth2/v2.0" },
    { id: "oidc", kind: "oidc", title: "OpenID Connect", status: "supported", basePath: "/.well-known" },
  ],
  auth: [
    { id: "oauth-code", title: "OAuth authorization code", type: "oauth-authorization-code", status: "supported" },
    {
      id: "client-credentials",
      title: "OAuth client credentials",
      type: "oauth-client-credentials",
      status: "supported",
    },
    { id: "oidc", title: "OIDC identity tokens", type: "oidc", status: "supported" },
  ],
  specs: [
    {
      kind: "oauth-metadata",
      title: "Microsoft OIDC metadata",
      coverage: "hand-authored",
      operations: [
        {
          operationId: "oidc/openidConfiguration",
          method: "GET",
          path: "/.well-known/openid-configuration",
          status: "hand-authored",
        },
        {
          operationId: "oidc/tenantOpenidConfiguration",
          method: "GET",
          path: "/:tenant/v2.0/.well-known/openid-configuration",
          status: "hand-authored",
        },
        { operationId: "oidc/jwks", method: "GET", path: "/discovery/v2.0/keys", status: "hand-authored" },
        { operationId: "oauth/authorize", method: "GET", path: "/oauth2/v2.0/authorize", status: "hand-authored" },
        {
          operationId: "oauth/authorizeCallback",
          method: "POST",
          path: "/oauth2/v2.0/authorize/callback",
          status: "hand-authored",
        },
        {
          operationId: "oauth/token",
          method: "POST",
          path: "/oauth2/v2.0/token",
          status: "hand-authored",
          summary: "authorization_code, refresh_token, and client_credentials grants.",
        },
        {
          operationId: "oauth/tokenV1",
          method: "POST",
          path: "/:tenant/oauth2/token",
          status: "hand-authored",
          summary: "Legacy Azure AD v1 token endpoint that translates resource to scope.",
        },
        { operationId: "oauth/logout", method: "GET", path: "/oauth2/v2.0/logout", status: "hand-authored" },
        { operationId: "oauth/revoke", method: "POST", path: "/oauth2/v2.0/revoke", status: "hand-authored" },
        { operationId: "oidc/userinfo", method: "GET", path: "/oidc/userinfo", status: "hand-authored" },
      ],
    },
    {
      kind: "manual",
      title: "Microsoft Graph behavior",
      coverage: "partial",
      operations: [
        { operationId: "graph/me", method: "GET", path: "/v1.0/me", status: "hand-authored" },
        { operationId: "graph/getUser", method: "GET", path: "/v1.0/users/:id", status: "hand-authored" },
        { operationId: "graph/listUsers", method: "GET", path: "/v1.0/users", status: "unsupported" },
        {
          operationId: "graph/listMessages",
          method: "GET",
          path: "/v1.0/me/messages",
          status: "unsupported",
        },
      ],
    },
  ],
  seedSchema: {
    description: "Seed Entra ID users and registered OAuth client applications.",
    fields: [
      {
        key: "users",
        title: "Users",
        description: "Directory users addressable by email and selectable on the sign-in page.",
        example: [{ email: "testuser@outlook.com", name: "Test User" }],
      },
      {
        key: "oauth_clients",
        title: "OAuth clients",
        description: "Registered application registrations with client secrets and redirect URIs.",
        example: [
          {
            client_id: "example-client-id",
            client_secret: "example-client-secret",
            name: "My Microsoft App",
            redirect_uris: ["http://localhost:3000/api/auth/callback/microsoft-entra-id"],
          },
        ],
      },
    ],
    example: {
      users: [{ email: "testuser@outlook.com", name: "Test User" }],
      oauth_clients: [
        {
          client_id: "example-client-id",
          client_secret: "example-client-secret",
          name: "My Microsoft App",
          redirect_uris: ["http://localhost:3000/api/auth/callback/microsoft-entra-id"],
        },
      ],
    },
  },
  stateModel: {
    description: "Entities mutated by Microsoft provider calls.",
    collections: [{ name: "microsoft.users" }, { name: "microsoft.oauth_clients" }],
  },
  connections: [
    {
      id: "msal-node",
      title: "MSAL Node (TypeScript)",
      kind: "sdk",
      language: "typescript",
      description: "Point MSAL at the emulator by overriding the Entra authority host.",
      template:
        'import { ConfidentialClientApplication } from "@azure/msal-node";\n\nconst app = new ConfidentialClientApplication({\n  auth: {\n    clientId: "{{clientId}}",\n    clientSecret: "{{clientSecret}}",\n    authority: "{{baseUrl}}/common/v2.0",\n  },\n  system: {\n    networkClient: undefined,\n  },\n});\n\n// Authority validation must be disabled for the emulator host.\nconst token = await app.acquireTokenByClientCredential({\n  scopes: ["https://graph.microsoft.com/.default"],\n});',
    },
    {
      id: "graph-client",
      title: "Microsoft Graph client (fetch)",
      kind: "sdk",
      language: "typescript",
      description: "Call the Graph /me endpoint with a bearer token from the emulator.",
      template:
        'const res = await fetch("{{baseUrl}}/v1.0/me", {\n  headers: { authorization: "Bearer {{token}}" },\n});\nconst me = await res.json();',
    },
    {
      id: "ms-env",
      title: "Entra ID environment (env)",
      kind: "env",
      language: "bash",
      description: "Override the Entra authority and Graph base URLs to point at the emulator.",
      template:
        "AZURE_AUTHORITY_HOST={{baseUrl}}\nAZURE_TENANT_ID=common\nAZURE_CLIENT_ID={{clientId}}\nAZURE_CLIENT_SECRET={{clientSecret}}\nMICROSOFT_GRAPH_ENDPOINT={{baseUrl}}/v1.0",
    },
    {
      id: "curl-discovery",
      title: "curl (OIDC discovery)",
      kind: "curl",
      language: "bash",
      description: "Fetch the OpenID configuration the emulator serves.",
      template: "curl -s {{baseUrl}}/.well-known/openid-configuration",
    },
    {
      id: "curl-graph-me",
      title: "curl (Graph /me)",
      kind: "curl",
      language: "bash",
      description: "Call Microsoft Graph /me with a bearer token.",
      template: 'curl -s {{baseUrl}}/v1.0/me -H "authorization: Bearer {{token}}"',
    },
  ],
};
