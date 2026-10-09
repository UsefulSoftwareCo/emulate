import type { ServiceManifest } from "@emulators/core";

const op = (operationId: string, method: string, path: string) => ({
  operationId,
  method,
  path,
  status: "hand-authored" as const,
});

export const manifest: ServiceManifest = {
  id: "miro",
  name: "Miro",
  description:
    "Stateful Miro MCP emulator: the OAuth 2.1 authorization server at the origin root (Dynamic Client Registration, S256 PKCE, HS256 OIDC ID tokens signed with the client secret and, like real Miro, without the nonce claim) plus the remote MCP server at / with read-only board tools over seeded state.",
  docsUrl: "https://docs.emulators.dev/miro",
  surfaces: [
    {
      id: "oauth",
      kind: "oauth",
      title: "Miro MCP OAuth and OIDC",
      status: "partial",
      basePath: "/",
      notes:
        "authorization_code and refresh_token grants. The jwt-bearer grant is advertised, as on the real server, but answers unsupported_grant_type. ID tokens are HS256 signed with the client secret, carry iss/sub/aud/exp/iat/email/email_verified, and omit nonce even when the authorization request sent one (seed id_token_nonce: echo to change that).",
    },
    {
      id: "mcp",
      kind: "mcp",
      title: "Miro MCP server",
      status: "partial",
      basePath: "/",
      notes:
        "Streamable HTTP JSON-RPC at the origin root. Every request without a valid bearer token, on any unknown path, answers 401 with the resource_metadata challenge like Miro's gateway.",
    },
    { id: "consent", kind: "ui", title: "OAuth consent page", status: "supported", basePath: "/authorize" },
  ],
  auth: [
    {
      id: "dcr",
      title: "Dynamic Client Registration",
      type: "dynamic-client-registration",
      status: "supported",
      notes: "POST /register (RFC 7591). Also available through POST /_emulate/credentials.",
    },
    {
      id: "oauth",
      title: "OAuth authorization code with PKCE",
      type: "oauth-authorization-code",
      status: "supported",
      notes: "client_secret_post or client_secret_basic, S256 PKCE required, refresh token rotation.",
    },
  ],
  scenarios: [
    {
      id: "id-token-nonce-omitted",
      title: "ID token without nonce (default)",
      description:
        "Miro's real behaviour. The ID token never carries nonce, so OIDC clients that send one and validate it fail.",
    },
    {
      id: "id-token-nonce-echoed",
      title: "ID token with nonce",
      description:
        'POST /_emulate/seed with {"id_token_nonce":"echo"} to echo the authorization request nonce, as OIDC Core requires.',
    },
  ],
  specs: [
    {
      kind: "oauth-metadata",
      title: "Miro MCP authorization server",
      coverage: "hand-authored",
      operations: [
        op("miro.oauth.authorizationServerMetadata", "GET", "/.well-known/oauth-authorization-server"),
        op("miro.oidc.configuration", "GET", "/.well-known/openid-configuration"),
        op("miro.oauth.register", "POST", "/register"),
        op("miro.oauth.authorize", "GET", "/authorize"),
        op("miro.oauth.approve", "POST", "/authorize"),
        op("miro.oauth.token", "POST", "/token"),
        op("miro.oauth.revoke", "POST", "/oidc/revoke"),
        { operationId: "miro.oauth.jwtBearer", status: "unsupported", summary: "jwt-bearer grant" },
        { operationId: "miro.oauth.teamSelection", status: "unsupported", summary: "Team selection during consent" },
      ],
    },
    {
      kind: "mcp",
      title: "Miro MCP tool subset",
      coverage: "partial",
      operations: [
        op("miro.mcp.protectedResourceMetadata", "GET", "/.well-known/oauth-protected-resource"),
        { operationId: "board_search_boards", status: "hand-authored" },
        { operationId: "canvas_search", status: "hand-authored" },
        {
          operationId: "canvas_read_as_svg",
          status: "unsupported",
          summary: "SVG canvas, comment, image, prototype, table, and write tools are not emulated.",
        },
      ],
    },
  ],
  seedSchema: {
    description:
      "Seed the users who can approve consent, the boards the MCP tools read, optional preregistered OAuth clients, and the ID token nonce behaviour.",
    fields: [
      {
        key: "users",
        title: "Users",
        description: "Each user becomes a sign in button on the consent page. Their email lands in the ID token.",
        example: [{ email: "user@example.com", name: "Miro User" }],
      },
      {
        key: "boards",
        title: "Boards",
        description: "Boards with items for board_search_boards and canvas_search.",
        example: [{ name: "Product Roadmap", items: [{ type: "sticky_note", content: "Ship it" }] }],
      },
      {
        key: "oauth_clients",
        title: "OAuth clients",
        description: "Preregistered clients. Omit client_id and client_secret to get generated ones.",
        example: [{ client_name: "My app", redirect_uris: ["http://localhost:3000/callback"] }],
      },
      {
        key: "id_token_nonce",
        title: "ID token nonce",
        description: '"omit" (default, matches real Miro) or "echo".',
        example: "omit",
      },
    ],
    example: { users: [{ email: "user@example.com" }], boards: [{ name: "Product Roadmap" }] },
  },
  stateModel: {
    description: "Miro users, boards, and OAuth state.",
    collections: [
      { name: "miro.users" },
      { name: "miro.boards" },
      { name: "miro.oauth_clients" },
      { name: "miro.oauth_grants" },
      { name: "miro.oauth_tokens" },
    ],
  },
  connections: [
    {
      id: "mcp-endpoint",
      title: "MCP endpoint",
      kind: "mcp",
      description: "Point an MCP client here. It discovers OAuth from the 401 and registers itself.",
      template: "{{baseUrl}}/",
    },
    {
      id: "register",
      title: "Register a client",
      kind: "curl",
      template:
        'curl -X POST {{baseUrl}}/register \\\n  -H \'content-type: application/json\' \\\n  -d \'{"client_name":"My app","redirect_uris":["http://localhost:3000/callback"]}\'',
    },
  ],
};
