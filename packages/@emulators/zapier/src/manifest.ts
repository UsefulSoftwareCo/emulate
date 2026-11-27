import type { ServiceManifest } from "@emulators/core";

/**
 * Zapier MCP in managed mode: one tool per action the account enabled, a
 * different list per account, OAuth per person. Addresses and OAuth metadata
 * follow what mcp.zapier.com publishes; tool names and schemas are the
 * emulator's own because Zapier does not document them.
 * Sources: https://docs.zapier.com/mcp/overview/how-connections-work,
 * https://docs.zapier.com/mcp/overview/how-tools-work, https://docs.zapier.com/mcp/overview/usage.
 */
export const manifest: ServiceManifest = {
  id: "zapier",
  name: "Zapier MCP",
  description:
    "Zapier's remote MCP server in managed mode: Streamable HTTP at /api/v1/connect for protocol 2026-07-28 and the 2025-11-25 and 2025-06-18 handshake era, OAuth per person with dynamic registration and S256 PKCE, and a deterministic, per-account tool list of any size that changes on command.",
  docsUrl: "https://docs.emulators.dev/zapier",
  surfaces: [
    {
      id: "mcp",
      kind: "mcp",
      title: "Zapier MCP server (managed mode)",
      status: "partial",
      basePath: "/api/v1/connect",
      notes:
        "tools/list (paged, opaque cursors bound to the list version) and tools/call; server/discover and subscriptions/listen in 2026-07-28; initialize in 2025-11-25 and 2025-06-18 with no session minted. Agentic mode's 16 meta-tools, skills, Next Gen Zaps, resources, prompts, sampling, elicitation, completions, logging and the deprecated SSE transport are not emulated.",
    },
    {
      id: "oauth",
      kind: "oauth",
      title: "Zapier MCP OAuth (per person)",
      status: "supported",
      basePath: "/oauth/authorize",
    },
    {
      id: "emulator-controls",
      kind: "provider-specific",
      title: "Emulator-only controls (not Zapier behaviour)",
      status: "supported",
      notes:
        "settings.list_changed (off by default, as Zapier documents no change notification) turns on notifications/tools/list_changed; settings.rate_limit adds a per-account 429 with Retry-After. Zapier documents neither.",
    },
  ],
  auth: [
    {
      id: "oauth",
      title: "OAuth 2.0 authorization code with S256 PKCE",
      type: "oauth-authorization-code",
      status: "supported",
      notes:
        "Path-aware protected resource metadata at /.well-known/oauth-protected-resource/api/v1/connect; authorization server metadata at /.well-known/oauth-authorization-server; refresh tokens rotate and access tokens last an hour (lifetimes assumed, not documented).",
    },
    {
      id: "dcr",
      title: "Dynamic client registration",
      type: "dynamic-client-registration",
      status: "supported",
      notes:
        "POST /api/v1/oauth/register; public (none) and confidential (client_secret_post, client_secret_basic) clients.",
    },
    {
      id: "connection-token",
      title: "Connection token",
      type: "bearer-token",
      status: "supported",
      notes:
        "Long-lived, one per account; Authorization: Bearer or ?token=. Created with POST /_emulate/zapier/accounts/:email/connection-token or /_emulate/credentials.",
    },
  ],
  specs: [
    {
      kind: "mcp",
      title: "MCP methods",
      coverage: "partial",
      operations: [
        {
          operationId: "zapier.mcp.tools/list",
          status: "hand-authored",
          summary: "Paged at settings.page_size (100); page_size 0 returns everything in one page.",
        },
        {
          operationId: "zapier.mcp.tools/call",
          status: "hand-authored",
          summary:
            "Only the caller's own tools; another account's tool answers -32602 Unknown tool. Results are deterministic.",
        },
        { operationId: "zapier.mcp.server/discover", status: "hand-authored" },
        {
          operationId: "zapier.mcp.subscriptions/listen",
          status: "partial",
          summary: "Acknowledges and ends at once unless the emulator's list_changed switch is on.",
        },
        { operationId: "zapier.mcp.initialize", status: "hand-authored" },
        { operationId: "zapier.mcp.resources/list", status: "unsupported" },
        { operationId: "zapier.mcp.prompts/list", status: "unsupported" },
        {
          operationId: "zapier.agentic.meta_tools",
          status: "unsupported",
          summary: "discover_zapier_actions, enable_zapier_action and the other agentic-mode meta-tools.",
        },
      ],
    },
    {
      kind: "oauth-metadata",
      title: "OAuth metadata as mcp.zapier.com publishes it",
      coverage: "hand-authored",
      operations: [
        {
          operationId: "zapier.oauth.protectedResourceMetadata",
          method: "GET",
          path: "/.well-known/oauth-protected-resource/api/v1/connect",
          status: "hand-authored",
        },
        {
          operationId: "zapier.oauth.authorizationServerMetadata",
          method: "GET",
          path: "/.well-known/oauth-authorization-server",
          status: "hand-authored",
        },
        {
          operationId: "zapier.oauth.register",
          method: "POST",
          path: "/api/v1/oauth/register",
          status: "hand-authored",
        },
        { operationId: "zapier.oauth.authorize", method: "GET", path: "/oauth/authorize", status: "hand-authored" },
        { operationId: "zapier.oauth.token", method: "POST", path: "/api/v1/oauth/token", status: "hand-authored" },
        { operationId: "zapier.oauth.revoke", method: "POST", path: "/api/v1/oauth/revoke", status: "hand-authored" },
        {
          operationId: "zapier.oauth.userinfo",
          method: "GET",
          path: "/api/v1/oauth/userinfo",
          status: "hand-authored",
        },
      ],
    },
  ],
  scenarios: [
    { id: "default", title: "One account, 25 tools", description: "user@example.com with 25 generated tools." },
  ],
  seedSchema: {
    description: "Accounts with their own tool lists and tool behaviours, and instance settings.",
    fields: [
      {
        key: "accounts",
        title: "Accounts",
        description:
          "tools: { count, seed?, explicit? } generates count tools from seed (default the email), deterministic everywhere. behaviors: [{ tool, delay_ms?, fail?: tool | protocol, result_bytes? }].",
        example: [
          { email: "ada@example.com", tools: { count: 3000 } },
          {
            email: "bob@example.com",
            tools: { count: 40, seed: "bob" },
            behaviors: [{ tool: "slack_send_message_000", delay_ms: 2000 }],
          },
        ],
      },
      {
        key: "settings",
        title: "Settings",
        description:
          "page_size (default 100, 0 for one page); list_changed and rate_limit are emulator controls, not Zapier behaviour.",
        example: { page_size: 100, list_changed: false, rate_limit: { requests: 60, window_seconds: 60 } },
      },
    ],
    example: { accounts: [{ email: "ada@example.com", tools: { count: 3000 } }] },
  },
  stateModel: {
    description: "Accounts, their tool-list recipes and changes, OAuth state, behaviours and settings.",
    collections: [
      { name: "zapier.accounts", title: "Accounts" },
      { name: "zapier.tool_specs", title: "Tool lists (a recipe per account, not one row per tool)" },
      { name: "zapier.list_changes", title: "Tool list changes" },
      { name: "zapier.tool_behaviors", title: "Tool behaviours" },
      { name: "zapier.oauth_clients", title: "OAuth clients" },
      { name: "zapier.oauth_codes", title: "Authorization codes" },
      { name: "zapier.tokens", title: "Access, refresh and connection tokens" },
      { name: "zapier.rate_windows", title: "Per-account request windows (emulator control)" },
    ],
  },
  connections: [
    {
      id: "mcp-url",
      title: "MCP server URL",
      kind: "config",
      language: "json",
      description: "Point an MCP client at the endpoint; it discovers OAuth from the 401.",
      template: '{ "mcpServers": { "zapier": { "type": "http", "url": "{{baseUrl}}/api/v1/connect" } } }',
    },
    {
      id: "curl-list",
      title: "curl (tools/list, 2026-07-28)",
      kind: "curl",
      language: "bash",
      description: "List tools with a connection token.",
      template:
        'curl -s {{baseUrl}}/api/v1/connect \\\n  -H "Authorization: Bearer {{token}}" \\\n  -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \\\n  -H "MCP-Protocol-Version: 2026-07-28" -H "Mcp-Method: tools/list" \\\n  -d \'{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{}}}}\'',
    },
  ],
};
