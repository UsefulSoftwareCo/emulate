import type { RouteContext } from "@emulators/core";

// OpenAPI 3.1 document for this Vercel emulator instance, pointed at itself, with
// an OAuth2 authorization-code security scheme bound to the emulator's own
// authorize and token endpoints for OpenAPI-aware clients and test tools.
export function openapiRoutes({ app, baseUrl }: RouteContext): void {
  app.get("/openapi.json", (c) => c.json(buildSpec(baseUrl)));
}

const ok = (description: string) => ({
  description,
  content: { "application/json": { schema: { type: "object" } } },
});
const idOrName = { name: "idOrName", in: "path", required: true, schema: { type: "string" } };

function buildSpec(baseUrl: string): Record<string, unknown> {
  return {
    openapi: "3.1.0",
    info: {
      title: "Vercel API (Emulated)",
      version: "1.0.0",
      description:
        "Emulated subset of the Vercel REST API. OAuth 2.0 Authorization Code (user-scoped). Authorize via the consent page, exchange the code at the token endpoint.",
    },
    servers: [{ url: baseUrl }],
    components: {
      securitySchemes: {
        vercelOAuth: {
          type: "oauth2",
          description: "Authorization Code — user-scoped bearer token.",
          flows: {
            authorizationCode: {
              authorizationUrl: `${baseUrl}/oauth/authorize`,
              tokenUrl: `${baseUrl}/login/oauth/token`,
              scopes: {
                "user:read": "Read the authenticated user",
                "projects:read": "Read projects and domains",
                "projects:write": "Create projects and domains",
              },
            },
          },
        },
      },
    },
    security: [{ vercelOAuth: ["user:read", "projects:read", "projects:write"] }],
    paths: {
      "/v2/user": {
        get: {
          operationId: "getCurrentUser",
          summary: "Get the authenticated user",
          responses: { "200": ok("User object.") },
        },
      },
      "/v10/projects": {
        get: {
          operationId: "listProjects",
          summary: "List projects",
          parameters: [{ name: "limit", in: "query", required: false, schema: { type: "integer" } }],
          responses: { "200": ok("Project list.") },
        },
      },
      "/v11/projects": {
        post: {
          operationId: "createProject",
          summary: "Create a project",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { type: "object", required: ["name"], properties: { name: { type: "string" } } },
              },
            },
          },
          responses: { "200": ok("Created project.") },
        },
      },
      "/v9/projects/{idOrName}": {
        get: {
          operationId: "getProject",
          summary: "Get a project",
          parameters: [idOrName],
          responses: { "200": ok("Project object.") },
        },
      },
      "/v9/projects/{idOrName}/domains": {
        get: {
          operationId: "listDomains",
          summary: "List a project's domains",
          parameters: [idOrName],
          responses: { "200": ok("Domain list.") },
        },
      },
      "/v10/projects/{idOrName}/domains": {
        post: {
          operationId: "addDomain",
          summary: "Add a domain to a project",
          parameters: [idOrName],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { type: "object", required: ["name"], properties: { name: { type: "string" } } },
              },
            },
          },
          responses: { "200": ok("Added domain.") },
        },
      },
      "/v6/deployments": {
        get: {
          operationId: "listDeployments",
          summary: "List deployments",
          parameters: [{ name: "limit", in: "query", required: false, schema: { type: "integer" } }],
          responses: { "200": ok("Deployment list.") },
        },
      },
    },
  };
}
