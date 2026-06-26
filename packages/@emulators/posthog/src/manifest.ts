import type { ServiceManifest } from "@emulators/core";

export const manifest: ServiceManifest = {
  id: "posthog",
  name: "PostHog",
  description:
    "Stateful PostHog emulator focused on OpenAPI OAuth discovery, Client ID Metadata Document OAuth, projects, users, and events.",
  docsUrl: "https://docs.emulators.dev/posthog",
  surfaces: [
    { id: "rest", kind: "rest", title: "PostHog API", status: "partial", basePath: "/api" },
    {
      id: "oauth",
      kind: "oauth",
      title: "PostHog OAuth 2.0",
      status: "supported",
      basePath: "/oauth",
      notes: "Authorization Code with PKCE and Client ID Metadata Document support.",
    },
  ],
  auth: [
    {
      id: "personal-api-key",
      title: "Personal API key",
      type: "bearer-token",
      status: "supported",
      notes: "Bearer tokens are accepted for the emulated REST API.",
    },
    {
      id: "oauth-cimd",
      title: "OAuth with Client ID Metadata Document",
      type: "oauth-authorization-code",
      status: "supported",
      notes:
        "The authorization server advertises client_id_metadata_document_supported and fetches the client metadata document from client_id.",
    },
    {
      id: "dynamic-client-registration",
      title: "Dynamic Client Registration",
      type: "dynamic-client-registration",
      status: "partial",
      notes: "Advertised to mirror PostHog metadata. CIMD should be preferred by clients that support it.",
    },
  ],
  specs: [
    {
      kind: "openapi",
      title: "PostHog API subset",
      coverage: "hand-authored",
      url: "/api/schema/",
      operations: [
        { operationId: "projects_list", method: "GET", path: "/api/projects/", status: "hand-authored" },
        {
          operationId: "events_list",
          method: "GET",
          path: "/api/projects/{project_id}/events/",
          status: "hand-authored",
        },
        {
          operationId: "events_create",
          method: "POST",
          path: "/api/projects/{project_id}/events/",
          status: "hand-authored",
        },
        { operationId: "users_me_retrieve", method: "GET", path: "/api/users/@me/", status: "hand-authored" },
      ],
      notes:
        "The OpenAPI document intentionally declares only bearer auth. OAuth is discoverable through well-known metadata, like PostHog.",
    },
    {
      kind: "oauth-metadata",
      title: "OAuth protected resource and authorization server metadata",
      coverage: "hand-authored",
      url: "/.well-known/oauth-protected-resource",
    },
  ],
  seedSchema: {
    description: "Seed users, projects, events, and optional registered OAuth clients.",
    fields: [
      {
        key: "users",
        title: "Users",
        description: "PostHog users selectable in the OAuth consent screen.",
        example: [{ email: "admin@example.com", name: "Admin User" }],
      },
      {
        key: "projects",
        title: "Projects",
        description: "Projects returned by the PostHog API.",
        example: [{ id: 1, name: "Demo Project" }],
      },
      {
        key: "events",
        title: "Events",
        description: "Events returned under a project.",
        example: [{ project_id: 1, event: "$pageview", distinct_id: "user_1" }],
      },
    ],
    example: {
      users: [{ email: "admin@example.com", name: "Admin User" }],
      projects: [{ id: 1, name: "Demo Project" }],
      events: [{ project_id: 1, event: "$pageview", distinct_id: "user_1" }],
    },
  },
  stateModel: {
    description: "Entities mutated by PostHog OAuth and REST API calls.",
    collections: [
      { name: "posthog.users" },
      { name: "posthog.projects" },
      { name: "posthog.events" },
      { name: "posthog.oauth_clients" },
    ],
  },
  connections: [
    {
      id: "openapi-schema",
      title: "OpenAPI schema",
      kind: "env",
      language: "bash",
      description: "Use this URL in OpenAPI clients that support discovery.",
      template: "POSTHOG_OPENAPI_URL={{baseUrl}}/api/schema/",
    },
    {
      id: "oauth-metadata",
      title: "OAuth metadata",
      kind: "env",
      language: "bash",
      description: "Protected resource metadata for OAuth discovery.",
      template: "POSTHOG_RESOURCE_METADATA_URL={{baseUrl}}/.well-known/oauth-protected-resource",
    },
  ],
};
