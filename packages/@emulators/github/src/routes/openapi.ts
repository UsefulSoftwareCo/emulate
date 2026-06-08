import type { RouteContext } from "@emulators/core";

// OpenAPI 3.1 document for this GitHub emulator instance, pointed at itself, with
// an HTTP bearer (personal access token) security scheme. Mint a token via
// POST /__token and bind it as the source's bearer. Ingestable by Executor.
export function openapiRoutes({ app, baseUrl }: RouteContext): void {
  app.get("/openapi.json", (c) => c.json(buildSpec(baseUrl)));
}

const ok = (description: string) => ({
  description,
  content: { "application/json": { schema: { type: "object" } } },
});
const owner = { name: "owner", in: "path", required: true, schema: { type: "string" } };
const repo = { name: "repo", in: "path", required: true, schema: { type: "string" } };

function buildSpec(baseUrl: string): Record<string, unknown> {
  return {
    openapi: "3.1.0",
    info: {
      title: "GitHub REST API (Emulated)",
      version: "1.0.0",
      description:
        "Emulated subset of the GitHub REST API. Authenticate with a bearer token (mint one via POST /__token, or use a seeded token).",
    },
    servers: [{ url: baseUrl }],
    components: {
      securitySchemes: {
        githubToken: { type: "http", scheme: "bearer", description: "Personal access token (emu_github_…)." },
      },
    },
    security: [{ githubToken: [] }],
    paths: {
      "/user": {
        get: { operationId: "getAuthenticatedUser", summary: "Get the authenticated user", responses: { "200": ok("User object.") } },
      },
      "/users/{username}": {
        get: {
          operationId: "getUser",
          summary: "Get a user",
          parameters: [{ name: "username", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": ok("User object.") },
        },
      },
      "/user/repos": {
        get: {
          operationId: "listAuthenticatedUserRepos",
          summary: "List repositories for the authenticated user",
          responses: { "200": ok("Repository list.") },
        },
      },
      "/repos/{owner}/{repo}": {
        get: { operationId: "getRepo", summary: "Get a repository", parameters: [owner, repo], responses: { "200": ok("Repository object.") } },
      },
      "/repos/{owner}/{repo}/issues": {
        get: {
          operationId: "listIssues",
          summary: "List issues in a repository",
          parameters: [owner, repo, { name: "state", in: "query", required: false, schema: { type: "string" } }],
          responses: { "200": ok("Issue list.") },
        },
        post: {
          operationId: "createIssue",
          summary: "Create an issue",
          parameters: [owner, repo],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["title"],
                  properties: { title: { type: "string" }, body: { type: "string" } },
                },
              },
            },
          },
          responses: { "201": ok("Created issue.") },
        },
      },
      "/search/repositories": {
        get: {
          operationId: "searchRepositories",
          summary: "Search repositories",
          parameters: [{ name: "q", in: "query", required: true, schema: { type: "string" } }],
          responses: { "200": ok("Search results.") },
        },
      },
    },
  };
}
