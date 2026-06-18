import type { ServiceManifest } from "@emulators/core";

export const manifest: ServiceManifest = {
  id: "mcp",
  name: "MCP",
  description:
    "Stateful GitHub-backed MCP emulator with streamable HTTP transport, OAuth discovery, Dynamic Client Registration, authorization-code OAuth, and enterprise-managed ID-JAG token exchange.",
  docsUrl: "https://docs.emulators.dev/github",
  surfaces: [
    { id: "mcp", kind: "mcp", title: "Streamable HTTP MCP endpoint", status: "supported", basePath: "/mcp" },
    { id: "oauth", kind: "oauth", title: "MCP OAuth authorization server", status: "supported" },
  ],
  auth: [
    { id: "bearer", title: "Bearer token", type: "bearer-token", status: "supported" },
    {
      id: "dcr",
      title: "Dynamic Client Registration",
      type: "dynamic-client-registration",
      status: "supported",
    },
  ],
  specs: [
    {
      kind: "mcp",
      title: "GitHub MCP tool subset",
      coverage: "hand-authored",
      operations: [{ operationId: "get_me", status: "hand-authored", summary: "Return the authenticated user." }],
    },
    {
      kind: "oauth-metadata",
      title: "MCP OAuth discovery metadata",
      coverage: "hand-authored",
      operations: [
        {
          operationId: "mcp.oauth.protectedResourceMetadata",
          method: "GET",
          path: "/.well-known/oauth-protected-resource",
          status: "hand-authored",
        },
        {
          operationId: "mcp.oauth.authorizationServerMetadata",
          method: "GET",
          path: "/.well-known/oauth-authorization-server",
          status: "hand-authored",
        },
        { operationId: "mcp.oauth.register", method: "POST", path: "/register", status: "hand-authored" },
        { operationId: "mcp.oauth.jwtBearer", method: "POST", path: "/token", status: "hand-authored" },
      ],
    },
  ],
  seedSchema: {
    description: "Seed GitHub users/data plus MCP auth and scope discovery settings.",
    fields: [
      {
        key: "users",
        title: "Users",
        description: "GitHub users addressable by MCP tools and OAuth authorization.",
        example: [{ login: "octocat", email: "octocat@github.com" }],
      },
      {
        key: "auth",
        title: "Auth mode",
        description: "One of oauth, bearer, or query. Defaults to oauth.",
        example: "oauth",
      },
      {
        key: "scopes",
        title: "OAuth scopes",
        description: "Scopes advertised by the MCP OAuth metadata.",
        example: ["repo", "read:user"],
      },
    ],
    example: {
      auth: "oauth",
      users: [{ login: "octocat", email: "octocat@github.com" }],
      scopes: ["repo", "read:user"],
    },
  },
  stateModel: {
    description: "MCP auth settings plus the GitHub store used by MCP tools.",
    collections: [
      { name: "github.users" },
      { name: "github.repos" },
      { name: "github.issues" },
      { name: "github.pulls" },
    ],
  },
  connections: [
    {
      id: "mcp-endpoint",
      title: "MCP endpoint",
      kind: "mcp",
      description: "Connect an MCP client to the streamable HTTP endpoint.",
      template: "{{baseUrl}}/mcp",
    },
  ],
};
