import type { ServiceManifest } from "@emulators/core";

/**
 * Vercel's machine-readable service manifest. This is the single source of truth
 * for Vercel's surfaces, auth, specs, seed shape, and copyable connection
 * snippets, consumed by the CLI registry, the Cloudflare host, and the console.
 */
export const manifest: ServiceManifest = {
  id: "vercel",
  name: "Vercel",
  description:
    "Stateful Vercel API emulator for projects, deployments, domains, teams, users, env vars, and integration OAuth flows.",
  docsUrl: "https://docs.emulators.dev/vercel",
  surfaces: [
    { id: "rest", kind: "rest", title: "REST API", status: "partial", basePath: "/" },
    { id: "oauth", kind: "oauth", title: "Integration OAuth", status: "supported", basePath: "/oauth" },
  ],
  auth: [
    { id: "bearer", title: "Bearer token", type: "bearer-token", status: "partial" },
    { id: "oauth-code", title: "OAuth authorization code", type: "oauth-authorization-code", status: "supported" },
  ],
  specs: [
    {
      kind: "openapi",
      title: "Vercel REST API subset",
      coverage: "hand-authored",
      url: "/openapi.json",
      operations: [
        { operationId: "getCurrentUser", method: "GET", path: "/v2/user", status: "hand-authored" },
        { operationId: "updateCurrentUser", method: "PATCH", path: "/v2/user", status: "hand-authored" },
        { operationId: "listTeams", method: "GET", path: "/v2/teams", status: "hand-authored" },
        { operationId: "getTeam", method: "GET", path: "/v2/teams/:teamId", status: "hand-authored" },
        { operationId: "createTeam", method: "POST", path: "/v2/teams", status: "hand-authored" },
        { operationId: "patchTeam", method: "PATCH", path: "/v2/teams/:teamId", status: "hand-authored" },
        { operationId: "listTeamMembers", method: "GET", path: "/v2/teams/:teamId/members", status: "hand-authored" },
        { operationId: "inviteTeamMember", method: "POST", path: "/v2/teams/:teamId/members", status: "hand-authored" },
        { operationId: "listProjects", method: "GET", path: "/v10/projects", status: "hand-authored" },
        { operationId: "createProject", method: "POST", path: "/v11/projects", status: "hand-authored" },
        { operationId: "getProject", method: "GET", path: "/v9/projects/:idOrName", status: "hand-authored" },
        { operationId: "updateProject", method: "PATCH", path: "/v9/projects/:idOrName", status: "hand-authored" },
        { operationId: "deleteProject", method: "DELETE", path: "/v9/projects/:idOrName", status: "hand-authored" },
        {
          operationId: "updateProtectionBypass",
          method: "PATCH",
          path: "/v1/projects/:idOrName/protection-bypass",
          status: "hand-authored",
        },
        { operationId: "createDeployment", method: "POST", path: "/v13/deployments", status: "hand-authored" },
        { operationId: "listDeployments", method: "GET", path: "/v6/deployments", status: "hand-authored" },
        { operationId: "getDeployment", method: "GET", path: "/v13/deployments/:idOrUrl", status: "hand-authored" },
        { operationId: "deleteDeployment", method: "DELETE", path: "/v13/deployments/:id", status: "hand-authored" },
        {
          operationId: "getRuntimeLogs",
          method: "GET",
          path: "/v1/projects/:projectId/deployments/:deploymentId/runtime-logs",
          status: "hand-authored",
        },
        {
          operationId: "cancelDeployment",
          method: "PATCH",
          path: "/v12/deployments/:id/cancel",
          status: "hand-authored",
        },
        {
          operationId: "getDeploymentEvents",
          method: "GET",
          path: "/v3/deployments/:idOrUrl/events",
          status: "hand-authored",
        },
        { operationId: "uploadFile", method: "POST", path: "/v2/files", status: "hand-authored" },
        {
          operationId: "listProjectDomains",
          method: "GET",
          path: "/v9/projects/:idOrName/domains",
          status: "hand-authored",
        },
        {
          operationId: "addProjectDomain",
          method: "POST",
          path: "/v10/projects/:idOrName/domains",
          status: "hand-authored",
        },
        {
          operationId: "verifyProjectDomain",
          method: "POST",
          path: "/v9/projects/:idOrName/domains/:domain/verify",
          status: "hand-authored",
        },
        {
          operationId: "deleteProjectDomain",
          method: "DELETE",
          path: "/v9/projects/:idOrName/domains/:domain",
          status: "hand-authored",
        },
        { operationId: "listProjectEnv", method: "GET", path: "/v10/projects/:idOrName/env", status: "hand-authored" },
        {
          operationId: "createProjectEnv",
          method: "POST",
          path: "/v10/projects/:idOrName/env",
          status: "hand-authored",
        },
        {
          operationId: "editProjectEnv",
          method: "PATCH",
          path: "/v9/projects/:idOrName/env/:id",
          status: "hand-authored",
        },
        {
          operationId: "deleteProjectEnv",
          method: "DELETE",
          path: "/v9/projects/:idOrName/env/:id",
          status: "hand-authored",
        },
        { operationId: "createAuthToken", method: "POST", path: "/v1/api-keys", status: "hand-authored" },
        { operationId: "listAuthTokens", method: "GET", path: "/v1/api-keys", status: "hand-authored" },
        { operationId: "deleteAuthToken", method: "DELETE", path: "/v1/api-keys/:keyId", status: "hand-authored" },
      ],
    },
    { kind: "oauth-metadata", title: "Integration OAuth authorize and token flow", coverage: "hand-authored" },
  ],
  seedSchema: {
    description: "Seed users, teams, projects (with env vars), and integration OAuth apps.",
    fields: [
      {
        key: "users",
        title: "Users",
        description: "Accounts addressable by username.",
        example: [{ username: "developer", name: "Developer", email: "dev@example.com" }],
      },
      {
        key: "teams",
        title: "Teams",
        description: "Teams addressable by slug.",
        example: [{ slug: "my-team", name: "My Team" }],
      },
      {
        key: "projects",
        title: "Projects",
        description: "Projects owned by a user or team, optionally with env vars.",
        example: [{ name: "my-app", team: "my-team", framework: "nextjs" }],
      },
      {
        key: "integrations",
        title: "Integration OAuth apps",
        description: "OAuth clients for the integration authorization-code flow.",
        example: [
          {
            client_id: "oac_example_client_id",
            client_secret: "example_client_secret",
            name: "My Vercel App",
            redirect_uris: ["http://localhost:3000/api/auth/callback/vercel"],
          },
        ],
      },
    ],
    example: {
      users: [{ username: "developer", name: "Developer", email: "dev@example.com" }],
      teams: [{ slug: "my-team", name: "My Team" }],
      projects: [{ name: "my-app", team: "my-team", framework: "nextjs" }],
      integrations: [
        {
          client_id: "oac_example_client_id",
          client_secret: "example_client_secret",
          name: "My Vercel App",
          redirect_uris: ["http://localhost:3000/api/auth/callback/vercel"],
        },
      ],
    },
  },
  stateModel: {
    description: "Entities mutated by Vercel provider calls.",
    collections: [
      { name: "users" },
      { name: "teams" },
      { name: "team_members" },
      { name: "projects" },
      { name: "deployments" },
      { name: "deployment_aliases" },
      { name: "builds" },
      { name: "deployment_events" },
      { name: "files" },
      { name: "deployment_files" },
      { name: "domains" },
      { name: "env_vars" },
      { name: "protection_bypasses" },
      { name: "api_keys" },
      { name: "integrations" },
    ],
  },
  connections: [
    {
      id: "vercel-sdk",
      title: "Vercel SDK (TypeScript)",
      kind: "sdk",
      language: "typescript",
      description: "Point the Vercel SDK at the emulator instance via serverURL.",
      template:
        'import { Vercel } from "@vercel/sdk";\n\nconst vercel = new Vercel({\n  serverURL: "{{baseUrl}}",\n  bearerToken: "{{token}}",\n});\n\nconst { projects } = await vercel.projects.getProjects({});',
    },
    {
      id: "vercel-fetch",
      title: "fetch (TypeScript)",
      kind: "sdk",
      language: "typescript",
      description: "Call the REST API directly with the emulator base URL.",
      template:
        'const res = await fetch("{{baseUrl}}/v2/user", {\n  headers: { authorization: "Bearer {{token}}" },\n});\nconst { user } = await res.json();',
    },
    {
      id: "vercel-env",
      title: "Vercel API base URL (env)",
      kind: "env",
      language: "bash",
      description: "Point the Vercel CLI or your app at the emulator instead of api.vercel.com.",
      template: "VERCEL_API_URL={{baseUrl}}\nVERCEL_TOKEN={{token}}",
    },
    {
      id: "curl",
      title: "curl",
      kind: "curl",
      language: "bash",
      description: "Call the REST API directly.",
      template: 'curl -s {{baseUrl}}/v2/user -H "authorization: Bearer {{token}}"',
    },
  ],
};
