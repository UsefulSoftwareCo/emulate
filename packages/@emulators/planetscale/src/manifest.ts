import type { ServiceManifest } from "@emulators/core";

export const manifest: ServiceManifest = {
  id: "planetscale",
  name: "PlanetScale",
  description:
    "Stateful PlanetScale emulator: the Doorkeeper OAuth authorization server with Dynamic Client Registration, PKCE, and literal HTTP Basic client authentication, plus the hosted MCP server at /mcp/planetscale with read-only organization, database, and branch tools over seeded state.",
  docsUrl: "https://docs.emulators.dev/planetscale",
  surfaces: [
    {
      id: "oauth",
      kind: "oauth",
      title: "PlanetScale OAuth (Doorkeeper)",
      status: "partial",
      basePath: "/oauth",
      notes:
        "authorization_code and refresh_token grants only. Client authentication compares the HTTP Basic credentials literally after base64 decoding, with no form url decoding, exactly like Doorkeeper. A percent encoded client_id or client_secret fails with 401 invalid_client.",
    },
    {
      id: "mcp",
      kind: "mcp",
      title: "PlanetScale MCP server",
      status: "partial",
      basePath: "/mcp/planetscale",
      notes: "Streamable HTTP. OAuth access tokens only; MCP service tokens are not emulated.",
    },
    { id: "consent", kind: "ui", title: "OAuth consent page", status: "supported", basePath: "/oauth/authorize" },
  ],
  auth: [
    {
      id: "dcr",
      title: "Dynamic Client Registration",
      type: "dynamic-client-registration",
      status: "supported",
      notes: "POST /oauth/registration. Also available through POST /_emulate/credentials.",
    },
    {
      id: "oauth",
      title: "OAuth authorization code with PKCE",
      type: "oauth-authorization-code",
      status: "supported",
      notes: "client_secret_basic or client_secret_post, plain or S256 PKCE, refresh token rotation.",
    },
  ],
  specs: [
    {
      kind: "oauth-metadata",
      title: "PlanetScale OAuth authorization server",
      coverage: "hand-authored",
      operations: [
        {
          operationId: "planetscale.oauth.authorizationServerMetadata",
          method: "GET",
          path: "/.well-known/oauth-authorization-server",
          status: "hand-authored",
        },
        {
          operationId: "planetscale.oauth.register",
          method: "POST",
          path: "/oauth/registration",
          status: "hand-authored",
        },
        {
          operationId: "planetscale.oauth.authorize",
          method: "GET",
          path: "/oauth/authorize",
          status: "hand-authored",
        },
        { operationId: "planetscale.oauth.approve", method: "POST", path: "/oauth/authorize", status: "hand-authored" },
        { operationId: "planetscale.oauth.token", method: "POST", path: "/oauth/token", status: "hand-authored" },
        { operationId: "planetscale.oauth.revoke", method: "POST", path: "/oauth/revoke", status: "hand-authored" },
        { operationId: "planetscale.oauth.deviceCode", status: "unsupported", summary: "device_code grant" },
        {
          operationId: "planetscale.oauth.clientCredentials",
          status: "unsupported",
          summary: "client_credentials grant",
        },
        { operationId: "planetscale.oauth.userinfo", status: "unsupported", summary: "OIDC userinfo and id tokens" },
      ],
    },
    {
      kind: "mcp",
      title: "PlanetScale MCP tool subset",
      coverage: "partial",
      operations: [
        {
          operationId: "planetscale.mcp.protectedResourceMetadata",
          method: "GET",
          path: "/.well-known/oauth-protected-resource/mcp/planetscale",
          status: "hand-authored",
        },
        { operationId: "planetscale_list_organizations", status: "hand-authored" },
        { operationId: "planetscale_get_organization", status: "hand-authored" },
        { operationId: "planetscale_list_databases", status: "hand-authored" },
        { operationId: "planetscale_get_database", status: "hand-authored" },
        { operationId: "planetscale_list_branches", status: "hand-authored" },
        {
          operationId: "planetscale_execute_read_query",
          status: "unsupported",
          summary: "Query, schema, insights, and billing tools are not emulated.",
        },
      ],
    },
  ],
  seedSchema: {
    description:
      "Seed the users who can approve consent, the organizations, databases, and branches the MCP tools read, and optional preregistered OAuth clients.",
    fields: [
      {
        key: "users",
        title: "Users",
        description: "Each user becomes a sign in button on the consent page. Defaults to planetscale-user.",
        example: [{ login: "planetscale-user", name: "PlanetScale User", email: "user@example.com" }],
      },
      {
        key: "organizations",
        title: "Organizations",
        description: "Organizations with nested databases and branches.",
        example: [
          {
            name: "acme",
            databases: [{ name: "app-db", kind: "mysql", branches: [{ name: "main", production: true }] }],
          },
        ],
      },
      {
        key: "oauth_clients",
        title: "OAuth clients",
        description:
          "Preregistered clients. Omit client_id and client_secret to get generated ones in the real pscale_app_ format.",
        example: [{ client_name: "My app", redirect_uris: ["http://localhost:3000/callback"] }],
      },
    ],
    example: {
      users: [{ login: "planetscale-user" }],
      organizations: [{ name: "acme", databases: [{ name: "app-db" }] }],
    },
  },
  stateModel: {
    description: "PlanetScale accounts, resources, and OAuth state.",
    collections: [
      { name: "planetscale.users" },
      { name: "planetscale.organizations" },
      { name: "planetscale.databases" },
      { name: "planetscale.branches" },
      { name: "planetscale.oauth_clients" },
      { name: "planetscale.oauth_grants" },
      { name: "planetscale.oauth_tokens" },
    ],
  },
  connections: [
    {
      id: "mcp-endpoint",
      title: "MCP endpoint",
      kind: "mcp",
      description: "Point an MCP client here. It discovers OAuth from the 401 and registers itself.",
      template: "{{baseUrl}}/mcp/planetscale",
    },
    {
      id: "register",
      title: "Register a client",
      kind: "curl",
      template:
        'curl -X POST {{baseUrl}}/oauth/registration \\\n  -H \'content-type: application/json\' \\\n  -d \'{"client_name":"My app","redirect_uris":["http://localhost:3000/callback"]}\'',
    },
  ],
};
