import type { OperationCoverage, ServiceManifest } from "@emulators/core";

const graphOperations: OperationCoverage[] = [
  { operationId: "graphUser_GetMyProfile", method: "GET", path: "/v1.0/me", status: "hand-authored" },
  { operationId: "graphUser_List", method: "GET", path: "/v1.0/users", status: "hand-authored" },
  { operationId: "graphUser_GetById", method: "GET", path: "/v1.0/users/:id", status: "hand-authored" },
  { operationId: "message_List", method: "GET", path: "/v1.0/me/messages", status: "hand-authored" },
  { operationId: "message_Get", method: "GET", path: "/v1.0/me/messages/:id", status: "hand-authored" },
  { operationId: "message_SendMail", method: "POST", path: "/v1.0/me/sendMail", status: "hand-authored" },
  { operationId: "calendar_GetDefaultCalendar", method: "GET", path: "/v1.0/me/calendar", status: "hand-authored" },
  { operationId: "calendar_List", method: "GET", path: "/v1.0/me/calendars", status: "hand-authored" },
  { operationId: "event_List", method: "GET", path: "/v1.0/me/events", status: "hand-authored" },
  { operationId: "event_Create", method: "POST", path: "/v1.0/me/events", status: "hand-authored" },
  { operationId: "event_Get", method: "GET", path: "/v1.0/me/events/:id", status: "hand-authored" },
  { operationId: "event_Delete", method: "DELETE", path: "/v1.0/me/events/:id", status: "hand-authored" },
  { operationId: "event_ListCalendarView", method: "GET", path: "/v1.0/me/calendar/events", status: "hand-authored" },
  { operationId: "drive_GetMyDrive", method: "GET", path: "/v1.0/me/drive", status: "hand-authored" },
  { operationId: "driveItem_GetRoot", method: "GET", path: "/v1.0/me/drive/root", status: "hand-authored" },
  {
    operationId: "driveItem_ListRootChildren",
    method: "GET",
    path: "/v1.0/me/drive/root/children",
    status: "hand-authored",
  },
  { operationId: "driveItem_Get", method: "GET", path: "/v1.0/me/drive/items/:id", status: "hand-authored" },
  { operationId: "driveItem_Update", method: "PATCH", path: "/v1.0/me/drive/items/:id", status: "hand-authored" },
  { operationId: "driveItem_Delete", method: "DELETE", path: "/v1.0/me/drive/items/:id", status: "hand-authored" },
  {
    operationId: "driveItem_ListChildren",
    method: "GET",
    path: "/v1.0/me/drive/items/:id/children",
    status: "hand-authored",
  },
  { operationId: "directoryObject_ListMemberOf", method: "GET", path: "/v1.0/me/memberOf", status: "partial" },
];

export const manifest: ServiceManifest = {
  id: "microsoft",
  name: "Microsoft Entra ID",
  description:
    "Stateful Microsoft Entra ID emulator for OAuth 2.0, OpenID Connect, client credentials, and a curated Microsoft Graph subset covering users, mail, calendar, and OneDrive.",
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
      kind: "openapi",
      title: "Microsoft Graph v1.0 subset",
      coverage: "hand-authored",
      url: "/openapi.json",
      operations: graphOperations,
    },
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
      operations: graphOperations,
    },
  ],
  seedSchema: {
    description: "Seed Entra ID users, OAuth client applications, and Microsoft Graph fixtures.",
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
      {
        key: "messages",
        title: "Mail messages",
        description: "Seeded Outlook messages returned from /v1.0/me/messages.",
        example: [{ subject: "Welcome", body: "Seeded message", from: "sender@example.com" }],
      },
      {
        key: "events",
        title: "Calendar events",
        description: "Seeded calendar events returned from /v1.0/me/events.",
        example: [
          {
            subject: "Customer call",
            start_date_time: "2026-07-01T09:00:00",
            end_date_time: "2026-07-01T09:30:00",
          },
        ],
      },
      {
        key: "drive_items",
        title: "Drive items",
        description: "Seeded OneDrive files and folders returned from /v1.0/me/drive.",
        example: [{ name: "Project Notes.txt", mime_type: "text/plain", content: "Notes" }],
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
      messages: [{ subject: "Welcome", body: "Seeded message", from: "sender@example.com" }],
      events: [
        {
          subject: "Customer call",
          start_date_time: "2026-07-01T09:00:00",
          end_date_time: "2026-07-01T09:30:00",
        },
      ],
      drive_items: [{ name: "Project Notes.txt", mime_type: "text/plain", content: "Notes" }],
    },
  },
  stateModel: {
    description: "Entities mutated by Microsoft provider calls.",
    collections: [
      { name: "microsoft.users" },
      { name: "microsoft.oauth_clients" },
      { name: "microsoft.messages" },
      { name: "microsoft.calendars" },
      { name: "microsoft.events" },
      { name: "microsoft.drives" },
      { name: "microsoft.drive_items" },
    ],
  },
  connections: [
    {
      id: "msal-node",
      title: "MSAL Node (TypeScript)",
      kind: "sdk",
      language: "typescript",
      description: "Point MSAL at the emulator by overriding the Entra authority host.",
      template:
        'import { ConfidentialClientApplication } from "@azure/msal-node";\n\nconst app = new ConfidentialClientApplication({\n  auth: {\n    clientId: "{{clientId}}",\n    clientSecret: "{{clientSecret}}",\n    authority: "{{baseUrl}}/common/v2.0",\n  },\n});\n\nconst token = await app.acquireTokenByClientCredential({\n  scopes: ["https://graph.microsoft.com/.default"],\n});',
    },
    {
      id: "graph-client",
      title: "Microsoft Graph client (fetch)",
      kind: "sdk",
      language: "typescript",
      description: "Call the Microsoft Graph subset with a bearer token from the emulator.",
      template:
        'const res = await fetch("{{baseUrl}}/v1.0/me/messages", {\n  headers: { authorization: "Bearer {{token}}" },\n});\nconst messages = await res.json();',
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
      description: "Call Microsoft Graph /me with a delegated bearer token.",
      template: 'curl -s {{baseUrl}}/v1.0/me -H "authorization: Bearer {{token}}"',
    },
  ],
};
