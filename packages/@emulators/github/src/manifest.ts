import type { ServiceManifest } from "@emulators/core";

/**
 * GitHub's machine-readable service manifest. This is the single source of truth
 * for GitHub's surfaces, auth, specs, seed shape, and copyable connection
 * snippets, consumed by the CLI registry, the Cloudflare host, and the console.
 */
export const manifest: ServiceManifest = {
  id: "github",
  name: "GitHub",
  description: "Stateful GitHub emulator for REST, GraphQL, OAuth, GitHub Apps, webhooks, and MCP flows.",
  docsUrl: "https://docs.emulators.dev/github",
  surfaces: [
    { id: "rest", kind: "rest", title: "REST API", status: "partial", basePath: "/" },
    { id: "graphql", kind: "graphql", title: "GraphQL API", status: "partial", basePath: "/graphql" },
    { id: "oauth", kind: "oauth", title: "OAuth app flow", status: "supported", basePath: "/login/oauth" },
    { id: "apps", kind: "provider-specific", title: "GitHub App auth", status: "partial" },
    { id: "mcp", kind: "mcp", title: "GitHub MCP surface", status: "partial", basePath: "/mcp" },
    { id: "webhooks", kind: "webhooks", title: "Webhooks", status: "partial" },
  ],
  auth: [
    { id: "bearer", title: "Bearer token", type: "bearer-token", status: "partial" },
    { id: "oauth-code", title: "OAuth authorization code", type: "oauth-authorization-code", status: "supported" },
    { id: "github-app-jwt", title: "GitHub App JWT", type: "jwt-app", status: "partial" },
    {
      id: "mcp-dcr",
      title: "MCP dynamic client registration",
      type: "dynamic-client-registration",
      status: "partial",
    },
    { id: "webhook-secret", title: "Webhook secret", type: "webhook-secret", status: "partial" },
  ],
  specs: [
    {
      kind: "openapi",
      title: "GitHub REST API subset",
      coverage: "hand-authored",
      operations: [
        { operationId: "users/getAuthenticated", method: "GET", path: "/user", status: "hand-authored" },
        { operationId: "users/getByUsername", method: "GET", path: "/users/:username", status: "hand-authored" },
        { operationId: "repos/get", method: "GET", path: "/repos/:owner/:repo", status: "hand-authored" },
        {
          operationId: "repos/createForAuthenticatedUser",
          method: "POST",
          path: "/user/repos",
          status: "hand-authored",
        },
        {
          operationId: "issues/listForRepo",
          method: "GET",
          path: "/repos/:owner/:repo/issues",
          status: "hand-authored",
        },
        { operationId: "issues/create", method: "POST", path: "/repos/:owner/:repo/issues", status: "hand-authored" },
        { operationId: "pulls/list", method: "GET", path: "/repos/:owner/:repo/pulls", status: "hand-authored" },
        { operationId: "pulls/create", method: "POST", path: "/repos/:owner/:repo/pulls", status: "hand-authored" },
        {
          operationId: "actions/listWorkflowRuns",
          method: "GET",
          path: "/repos/:owner/:repo/actions/runs",
          status: "partial",
        },
      ],
    },
    { kind: "graphql", title: "GitHub GraphQL subset", coverage: "hand-authored" },
    { kind: "mcp", title: "GitHub MCP tool subset", coverage: "hand-authored" },
    { kind: "manual", title: "GitHub App and webhook behavior", coverage: "partial" },
  ],
  scenarios: [
    { id: "empty", title: "Empty account", description: "A single authenticated user with no repositories." },
    { id: "repo-with-pr", title: "Repository with pull request", description: "An org repo seeded with an open PR." },
  ],
  seedSchema: {
    description: "Seed users, organizations, repositories, and OAuth apps.",
    fields: [
      {
        key: "users",
        title: "Users",
        description: "Accounts addressable by login.",
        example: [{ login: "octocat", name: "The Octocat" }],
      },
      { key: "orgs", title: "Organizations", example: [{ login: "my-org", name: "My Organization" }] },
      { key: "repos", title: "Repositories", example: [{ owner: "octocat", name: "hello-world", auto_init: true }] },
      {
        key: "oauth_apps",
        title: "OAuth apps",
        example: [{ client_id: "Iv1.example", client_secret: "example", name: "My App" }],
      },
    ],
    example: {
      users: [{ login: "octocat", name: "The Octocat", email: "octocat@github.com" }],
      orgs: [{ login: "my-org", name: "My Organization" }],
      repos: [{ owner: "octocat", name: "hello-world", description: "My first repository", auto_init: true }],
    },
  },
  stateModel: {
    description: "Entities mutated by GitHub provider calls.",
    collections: [
      { name: "users" },
      { name: "repos" },
      { name: "issues" },
      { name: "pulls" },
      { name: "orgs" },
      { name: "teams" },
      { name: "releases" },
      { name: "apps" },
      { name: "oauth_apps" },
    ],
  },
  connections: [
    {
      id: "octokit",
      title: "Octokit (TypeScript)",
      kind: "sdk",
      language: "typescript",
      description: "Point Octokit at the emulator instance.",
      template:
        'import { Octokit } from "@octokit/rest";\n\nconst octokit = new Octokit({\n  baseUrl: "{{baseUrl}}",\n  auth: "{{token}}",\n});',
    },
    {
      id: "gh-env",
      title: "GitHub API base URL (env)",
      kind: "env",
      language: "bash",
      description: "Many GitHub SDKs and the gh CLI honor GITHUB_API_URL.",
      template: "GITHUB_API_URL={{baseUrl}}\nGITHUB_TOKEN={{token}}",
    },
    {
      id: "curl",
      title: "curl",
      kind: "curl",
      language: "bash",
      description: "Call the REST API directly.",
      template: 'curl -s {{baseUrl}}/user -H "authorization: Bearer {{token}}"',
    },
  ],
};
