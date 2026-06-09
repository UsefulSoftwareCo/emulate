import type { ServiceManifest } from "@emulators/core";

/**
 * Google's machine-readable service manifest. This is the single source of truth
 * for Google's surfaces, auth, specs, seed shape, and copyable connection
 * snippets, consumed by the CLI registry, the Cloudflare host, and the console.
 *
 * The emulator models Google's real OAuth 2.0 / OpenID Connect identity flow plus
 * hand-authored subsets of the Gmail, Calendar, and Drive REST APIs. Operation ids
 * follow the Google API Discovery naming convention (e.g. `gmail.users.messages.list`).
 */
export const manifest: ServiceManifest = {
  id: "google",
  name: "Google",
  description: "Stateful Google OAuth, OpenID Connect, Gmail, Calendar, and Drive emulator.",
  docsUrl: "https://docs.emulators.dev/google",
  surfaces: [
    { id: "rest", kind: "rest", title: "REST API", status: "partial", basePath: "/" },
    { id: "oauth", kind: "oauth", title: "OAuth 2.0 flow", status: "supported", basePath: "/o/oauth2/v2" },
    { id: "oidc", kind: "oidc", title: "OpenID Connect", status: "supported", basePath: "/.well-known" },
  ],
  auth: [
    { id: "oauth-code", title: "OAuth authorization code", type: "oauth-authorization-code", status: "supported" },
    { id: "oidc", title: "OIDC identity tokens", type: "oidc", status: "supported" },
    { id: "bearer", title: "Bearer access token", type: "bearer-token", status: "supported" },
  ],
  specs: [
    {
      kind: "oauth-metadata",
      title: "OAuth and OIDC metadata",
      coverage: "hand-authored",
      operations: [
        {
          operationId: "openid-configuration",
          method: "GET",
          path: "/.well-known/openid-configuration",
          status: "hand-authored",
        },
        { operationId: "jwks", method: "GET", path: "/oauth2/v3/certs", status: "partial" },
        { operationId: "authorize", method: "GET", path: "/o/oauth2/v2/auth", status: "hand-authored" },
        { operationId: "token", method: "POST", path: "/oauth2/token", status: "hand-authored" },
        { operationId: "userinfo", method: "GET", path: "/oauth2/v2/userinfo", status: "hand-authored" },
        { operationId: "revoke", method: "POST", path: "/oauth2/revoke", status: "hand-authored" },
      ],
    },
    {
      kind: "google-discovery",
      title: "Gmail API subset",
      coverage: "hand-authored",
      operations: [
        {
          operationId: "gmail.users.messages.list",
          method: "GET",
          path: "/gmail/v1/users/:userId/messages",
          status: "hand-authored",
        },
        {
          operationId: "gmail.users.messages.get",
          method: "GET",
          path: "/gmail/v1/users/:userId/messages/:id",
          status: "hand-authored",
        },
        {
          operationId: "gmail.users.messages.send",
          method: "POST",
          path: "/gmail/v1/users/:userId/messages/send",
          status: "hand-authored",
        },
        {
          operationId: "gmail.users.messages.modify",
          method: "POST",
          path: "/gmail/v1/users/:userId/messages/:id/modify",
          status: "hand-authored",
        },
        {
          operationId: "gmail.users.messages.trash",
          method: "POST",
          path: "/gmail/v1/users/:userId/messages/:id/trash",
          status: "hand-authored",
        },
        {
          operationId: "gmail.users.messages.delete",
          method: "DELETE",
          path: "/gmail/v1/users/:userId/messages/:id",
          status: "hand-authored",
        },
        {
          operationId: "gmail.users.messages.batchModify",
          method: "POST",
          path: "/gmail/v1/users/:userId/messages/batchModify",
          status: "hand-authored",
        },
        {
          operationId: "gmail.users.threads.list",
          method: "GET",
          path: "/gmail/v1/users/:userId/threads",
          status: "hand-authored",
        },
        {
          operationId: "gmail.users.threads.get",
          method: "GET",
          path: "/gmail/v1/users/:userId/threads/:id",
          status: "hand-authored",
        },
        {
          operationId: "gmail.users.threads.modify",
          method: "POST",
          path: "/gmail/v1/users/:userId/threads/:id/modify",
          status: "hand-authored",
        },
        {
          operationId: "gmail.users.drafts.list",
          method: "GET",
          path: "/gmail/v1/users/:userId/drafts",
          status: "hand-authored",
        },
        {
          operationId: "gmail.users.drafts.create",
          method: "POST",
          path: "/gmail/v1/users/:userId/drafts",
          status: "hand-authored",
        },
        {
          operationId: "gmail.users.drafts.send",
          method: "POST",
          path: "/gmail/v1/users/:userId/drafts/send",
          status: "hand-authored",
        },
        {
          operationId: "gmail.users.labels.list",
          method: "GET",
          path: "/gmail/v1/users/:userId/labels",
          status: "hand-authored",
        },
        {
          operationId: "gmail.users.labels.create",
          method: "POST",
          path: "/gmail/v1/users/:userId/labels",
          status: "hand-authored",
        },
        {
          operationId: "gmail.users.history.list",
          method: "GET",
          path: "/gmail/v1/users/:userId/history",
          status: "hand-authored",
        },
        {
          operationId: "gmail.users.settings.filters.list",
          method: "GET",
          path: "/gmail/v1/users/:userId/settings/filters",
          status: "hand-authored",
        },
        {
          operationId: "gmail.users.watch",
          method: "POST",
          path: "/gmail/v1/users/:userId/watch",
          status: "partial",
        },
      ],
    },
    {
      kind: "google-discovery",
      title: "Calendar API subset",
      coverage: "hand-authored",
      operations: [
        {
          operationId: "calendar.calendarList.list",
          method: "GET",
          path: "/calendar/v3/users/:userId/calendarList",
          status: "hand-authored",
        },
        {
          operationId: "calendar.events.list",
          method: "GET",
          path: "/calendar/v3/calendars/:calendarId/events",
          status: "hand-authored",
        },
        {
          operationId: "calendar.events.insert",
          method: "POST",
          path: "/calendar/v3/calendars/:calendarId/events",
          status: "hand-authored",
        },
        {
          operationId: "calendar.events.delete",
          method: "DELETE",
          path: "/calendar/v3/calendars/:calendarId/events/:eventId",
          status: "hand-authored",
        },
        {
          operationId: "calendar.freebusy.query",
          method: "POST",
          path: "/calendar/v3/freeBusy",
          status: "hand-authored",
        },
      ],
    },
    {
      kind: "google-discovery",
      title: "Drive API subset",
      coverage: "hand-authored",
      operations: [
        { operationId: "drive.files.list", method: "GET", path: "/drive/v3/files", status: "hand-authored" },
        { operationId: "drive.files.create", method: "POST", path: "/drive/v3/files", status: "hand-authored" },
        { operationId: "drive.files.get", method: "GET", path: "/drive/v3/files/:fileId", status: "hand-authored" },
        {
          operationId: "drive.files.update",
          method: "PATCH",
          path: "/drive/v3/files/:fileId",
          status: "hand-authored",
        },
      ],
    },
    {
      kind: "manual",
      title: "Google API Discovery passthrough",
      coverage: "partial",
      notes: "Proxies Google's real discovery documents and rewrites base URLs to the emulator instance.",
      operations: [
        {
          operationId: "discovery.apis.getRest",
          method: "GET",
          path: "/discovery/v1/apis/:api/:version/rest",
          status: "partial",
        },
      ],
    },
  ],
  seedSchema: {
    description: "Seed Google users, OAuth clients, Gmail labels and messages, calendars, events, and Drive items.",
    fields: [
      {
        key: "users",
        title: "Users",
        description: "Google accounts addressable by email; used for sign-in and userinfo.",
        example: [{ email: "testuser@example.com", name: "Test User", email_verified: true }],
      },
      {
        key: "oauth_clients",
        title: "OAuth clients",
        description: "Registered OAuth applications with client credentials and redirect URIs.",
        example: [
          {
            client_id: "example-client-id.apps.googleusercontent.com",
            client_secret: "GOCSPX-example_secret",
            name: "Code App (Google)",
            redirect_uris: ["http://localhost:3000/api/auth/callback/google"],
          },
        ],
      },
      {
        key: "labels",
        title: "Gmail labels",
        example: [{ id: "Label_ops", user_email: "testuser@example.com", name: "Ops/Review" }],
      },
      {
        key: "messages",
        title: "Gmail messages",
        example: [
          {
            id: "msg_welcome",
            user_email: "testuser@example.com",
            from: "welcome@example.com",
            to: "testuser@example.com",
            subject: "Welcome to the Gmail emulator",
            label_ids: ["INBOX", "UNREAD"],
          },
        ],
      },
      {
        key: "calendars",
        title: "Calendars",
        example: [
          { id: "primary", user_email: "testuser@example.com", summary: "testuser@example.com", primary: true },
        ],
      },
      {
        key: "calendar_events",
        title: "Calendar events",
        example: [
          {
            id: "evt_kickoff",
            user_email: "testuser@example.com",
            calendar_id: "primary",
            summary: "Project Kickoff",
            start_date_time: "2025-01-10T09:00:00.000Z",
            end_date_time: "2025-01-10T09:30:00.000Z",
          },
        ],
      },
      {
        key: "drive_items",
        title: "Drive items",
        example: [
          {
            id: "drv_docs",
            user_email: "testuser@example.com",
            name: "Docs",
            mime_type: "application/vnd.google-apps.folder",
            parent_ids: ["root"],
          },
        ],
      },
    ],
    example: {
      users: [
        {
          email: "testuser@example.com",
          name: "Test User",
          picture: "https://lh3.googleusercontent.com/a/default-user",
          email_verified: true,
        },
      ],
      oauth_clients: [
        {
          client_id: "example-client-id.apps.googleusercontent.com",
          client_secret: "GOCSPX-example_secret",
          name: "Code App (Google)",
          redirect_uris: ["http://localhost:3000/api/auth/callback/google"],
        },
      ],
      messages: [
        {
          id: "msg_welcome",
          user_email: "testuser@example.com",
          from: "welcome@example.com",
          to: "testuser@example.com",
          subject: "Welcome to the Gmail emulator",
          body_text: "You can now test Gmail, Calendar, and Drive flows locally.",
          label_ids: ["INBOX", "UNREAD", "CATEGORY_UPDATES"],
        },
      ],
      calendars: [
        { id: "primary", user_email: "testuser@example.com", summary: "testuser@example.com", primary: true },
      ],
      calendar_events: [
        {
          id: "evt_kickoff",
          user_email: "testuser@example.com",
          calendar_id: "primary",
          summary: "Project Kickoff",
          start_date_time: "2025-01-10T09:00:00.000Z",
          end_date_time: "2025-01-10T09:30:00.000Z",
        },
      ],
      drive_items: [
        {
          id: "drv_docs",
          user_email: "testuser@example.com",
          name: "Docs",
          mime_type: "application/vnd.google-apps.folder",
          parent_ids: ["root"],
        },
      ],
    },
  },
  stateModel: {
    description: "Entities mutated by Google OAuth, Gmail, Calendar, and Drive provider calls.",
    collections: [
      { name: "google.users" },
      { name: "google.oauth_clients" },
      { name: "google.messages" },
      { name: "google.drafts" },
      { name: "google.attachments" },
      { name: "google.history" },
      { name: "google.labels" },
      { name: "google.filters" },
      { name: "google.forwarding_addresses" },
      { name: "google.send_as" },
      { name: "google.calendars" },
      { name: "google.calendar_events" },
      { name: "google.drive_items" },
    ],
  },
  connections: [
    {
      id: "googleapis",
      title: "googleapis (TypeScript)",
      kind: "sdk",
      language: "typescript",
      description: "Point the official googleapis client at the emulator via per-service rootUrl options.",
      template:
        'import { google } from "googleapis";\n\nconst auth = new google.auth.OAuth2({\n  clientId: "{{clientId}}",\n  clientSecret: "{{clientSecret}}",\n});\nauth.setCredentials({ access_token: "{{token}}" });\n\nconst gmail = google.gmail({\n  version: "v1",\n  auth,\n  rootUrl: "{{baseUrl}}/",\n});\n\nconst { data } = await gmail.users.messages.list({ userId: "me" });',
    },
    {
      id: "oauth-discovery",
      title: "OpenID discovery (fetch)",
      kind: "sdk",
      language: "typescript",
      description: "Discover the OIDC endpoints, then drive the authorization code flow against the emulator.",
      template:
        'const discovery = await fetch(\n  "{{baseUrl}}/.well-known/openid-configuration",\n).then((r) => r.json());\n\n// discovery.authorization_endpoint, discovery.token_endpoint, etc.\nconst userinfo = await fetch(discovery.userinfo_endpoint, {\n  headers: { authorization: "Bearer {{token}}" },\n}).then((r) => r.json());',
    },
    {
      id: "google-env",
      title: "Google API base URL (env)",
      kind: "env",
      language: "bash",
      description: "Point your SDK or app at the emulator instead of Google's production endpoints.",
      template:
        "GOOGLE_BASE_URL={{baseUrl}}\nGOOGLE_CLIENT_ID={{clientId}}\nGOOGLE_CLIENT_SECRET={{clientSecret}}\nGOOGLE_ACCESS_TOKEN={{token}}",
    },
    {
      id: "curl",
      title: "curl",
      kind: "curl",
      language: "bash",
      description: "Call the Gmail REST API directly with a bearer access token.",
      template: 'curl -s {{baseUrl}}/gmail/v1/users/me/messages -H "authorization: Bearer {{token}}"',
    },
  ],
};
