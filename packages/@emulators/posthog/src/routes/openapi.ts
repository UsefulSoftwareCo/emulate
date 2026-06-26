import type { RouteContext } from "@emulators/core";

export function openapiRoutes({ app, baseUrl }: RouteContext): void {
  app.get("/api/schema/", (c) => c.json(buildSpec(baseUrl)));
  app.get("/api/schema", (c) => c.json(buildSpec(baseUrl)));
  app.get("/openapi.json", (c) => c.json(buildSpec(baseUrl)));
}

const ok = (description: string) => ({
  description,
  content: { "application/json": { schema: { type: "object" } } },
});

const projectId = { name: "project_id", in: "path", required: true, schema: { type: "integer" } };
const jsonBody = (properties: Record<string, unknown>, required: readonly string[], description: string) => ({
  required: true,
  description,
  content: {
    "application/json": {
      schema: { type: "object", properties, required: [...required] },
    },
  },
});

function buildSpec(baseUrl: string): Record<string, unknown> {
  return {
    openapi: "3.1.0",
    info: {
      title: "PostHog API",
      version: "1.0.0",
      description:
        "Emulated PostHog API subset. The OpenAPI security scheme matches PostHog's bearer-token schema. OAuth is advertised separately through RFC 9728 and RFC 8414 metadata with Client ID Metadata Document support.",
    },
    servers: [{ url: baseUrl }],
    components: {
      securitySchemes: {
        PersonalAPIKeyAuth: {
          type: "http",
          scheme: "bearer",
          description: "PostHog personal API key or OAuth access token.",
        },
      },
    },
    security: [{ PersonalAPIKeyAuth: [] }],
    paths: {
      "/api/projects/": {
        get: {
          operationId: "projects_list",
          tags: ["projects"],
          summary: "List projects",
          security: [{ PersonalAPIKeyAuth: ["project:read"] }],
          responses: { "200": ok("Project list.") },
        },
      },
      "/api/projects/{project_id}/events/": {
        get: {
          operationId: "events_list",
          tags: ["events"],
          summary: "List events",
          security: [{ PersonalAPIKeyAuth: ["event:read"] }],
          parameters: [projectId],
          responses: { "200": ok("Event list.") },
        },
        post: {
          operationId: "events_create",
          tags: ["events"],
          summary: "Create an event",
          security: [{ PersonalAPIKeyAuth: ["event:write"] }],
          parameters: [projectId],
          requestBody: jsonBody(
            {
              event: { type: "string" },
              distinct_id: { type: "string" },
              properties: { type: "object" },
            },
            ["event", "distinct_id"],
            "The event to capture.",
          ),
          responses: { "201": ok("Captured event."), "400": ok("Validation error.") },
        },
      },
      "/api/users/@me/": {
        get: {
          operationId: "users_me_retrieve",
          tags: ["users"],
          summary: "Get the authenticated user",
          security: [{ PersonalAPIKeyAuth: ["user:read"] }],
          responses: { "200": ok("Authenticated user.") },
        },
      },
    },
  };
}
