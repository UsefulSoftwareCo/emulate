import type { ServiceManifest } from "@emulators/core";

/**
 * Clerk's machine-readable service manifest. This is the single source of truth
 * for Clerk's surfaces, auth, specs, seed shape, and copyable connection
 * snippets, consumed by the CLI registry, the Cloudflare host, and the console.
 */
export const manifest: ServiceManifest = {
  id: "clerk",
  name: "Clerk",
  description:
    "Stateful Clerk emulator for the Backend API, OAuth and OIDC sign-in, JWKS, sessions, and organization management.",
  docsUrl: "https://docs.emulators.dev/clerk",
  surfaces: [
    { id: "rest", kind: "rest", title: "Backend API", status: "partial", basePath: "/v1" },
    { id: "oauth", kind: "oauth", title: "OAuth and OIDC", status: "supported", basePath: "/oauth" },
    { id: "oidc", kind: "oidc", title: "OpenID Connect", status: "supported", basePath: "/.well-known" },
  ],
  auth: [
    { id: "secret-key", title: "Clerk secret key", type: "api-key", status: "supported" },
    { id: "oauth-code", title: "OAuth authorization code", type: "oauth-authorization-code", status: "supported" },
    { id: "oidc", title: "OIDC identity tokens", type: "oidc", status: "supported" },
  ],
  specs: [
    {
      kind: "openapi",
      title: "Clerk Backend API subset",
      coverage: "hand-authored",
      operations: [
        { operationId: "GetUserList", method: "GET", path: "/v1/users", status: "hand-authored" },
        { operationId: "GetUsersCount", method: "GET", path: "/v1/users/count", status: "hand-authored" },
        { operationId: "GetUser", method: "GET", path: "/v1/users/:userId", status: "hand-authored" },
        { operationId: "CreateUser", method: "POST", path: "/v1/users", status: "hand-authored" },
        { operationId: "UpdateUser", method: "PATCH", path: "/v1/users/:userId", status: "hand-authored" },
        { operationId: "DeleteUser", method: "DELETE", path: "/v1/users/:userId", status: "hand-authored" },
        { operationId: "BanUser", method: "POST", path: "/v1/users/:userId/ban", status: "hand-authored" },
        { operationId: "UnbanUser", method: "POST", path: "/v1/users/:userId/unban", status: "hand-authored" },
        { operationId: "LockUser", method: "POST", path: "/v1/users/:userId/lock", status: "hand-authored" },
        { operationId: "UnlockUser", method: "POST", path: "/v1/users/:userId/unlock", status: "hand-authored" },
        {
          operationId: "UpdateUserMetadata",
          method: "PATCH",
          path: "/v1/users/:userId/metadata",
          status: "hand-authored",
        },
        {
          operationId: "VerifyPassword",
          method: "POST",
          path: "/v1/users/:userId/verify_password",
          status: "hand-authored",
        },
        {
          operationId: "GetEmailAddress",
          method: "GET",
          path: "/v1/email_addresses/:emailId",
          status: "hand-authored",
        },
        { operationId: "CreateEmailAddress", method: "POST", path: "/v1/email_addresses", status: "hand-authored" },
        {
          operationId: "UpdateEmailAddress",
          method: "PATCH",
          path: "/v1/email_addresses/:emailId",
          status: "hand-authored",
        },
        {
          operationId: "DeleteEmailAddress",
          method: "DELETE",
          path: "/v1/email_addresses/:emailId",
          status: "hand-authored",
        },
        { operationId: "ListOrganizations", method: "GET", path: "/v1/organizations", status: "hand-authored" },
        { operationId: "GetOrganization", method: "GET", path: "/v1/organizations/:orgId", status: "hand-authored" },
        { operationId: "CreateOrganization", method: "POST", path: "/v1/organizations", status: "hand-authored" },
        {
          operationId: "UpdateOrganization",
          method: "PATCH",
          path: "/v1/organizations/:orgId",
          status: "hand-authored",
        },
        {
          operationId: "DeleteOrganization",
          method: "DELETE",
          path: "/v1/organizations/:orgId",
          status: "hand-authored",
        },
        {
          operationId: "ListOrganizationMemberships",
          method: "GET",
          path: "/v1/organizations/:orgId/memberships",
          status: "hand-authored",
        },
        {
          operationId: "CreateOrganizationMembership",
          method: "POST",
          path: "/v1/organizations/:orgId/memberships",
          status: "hand-authored",
        },
        {
          operationId: "UpdateOrganizationMembership",
          method: "PATCH",
          path: "/v1/organizations/:orgId/memberships/:userId",
          status: "hand-authored",
        },
        {
          operationId: "DeleteOrganizationMembership",
          method: "DELETE",
          path: "/v1/organizations/:orgId/memberships/:userId",
          status: "hand-authored",
        },
        {
          operationId: "ListOrganizationInvitations",
          method: "GET",
          path: "/v1/organizations/:orgId/invitations",
          status: "hand-authored",
        },
        {
          operationId: "CreateOrganizationInvitation",
          method: "POST",
          path: "/v1/organizations/:orgId/invitations",
          status: "hand-authored",
        },
        {
          operationId: "CreateOrganizationInvitationBulk",
          method: "POST",
          path: "/v1/organizations/:orgId/invitations/bulk",
          status: "hand-authored",
        },
        {
          operationId: "RevokeOrganizationInvitation",
          method: "POST",
          path: "/v1/organizations/:orgId/invitations/:invitationId/revoke",
          status: "hand-authored",
        },
        { operationId: "GetSessionList", method: "GET", path: "/v1/sessions", status: "hand-authored" },
        { operationId: "GetSession", method: "GET", path: "/v1/sessions/:sessionId", status: "hand-authored" },
        { operationId: "CreateSession", method: "POST", path: "/v1/sessions", status: "hand-authored" },
        {
          operationId: "RevokeSession",
          method: "POST",
          path: "/v1/sessions/:sessionId/revoke",
          status: "hand-authored",
        },
        {
          operationId: "CreateSessionToken",
          method: "POST",
          path: "/v1/sessions/:sessionId/tokens",
          status: "hand-authored",
        },
        {
          operationId: "CreateSessionTokenFromTemplate",
          method: "POST",
          path: "/v1/sessions/:sessionId/tokens/:template",
          status: "partial",
        },
        { operationId: "GetJWKS", method: "GET", path: "/v1/jwks", status: "hand-authored" },
      ],
    },
    {
      kind: "oauth-metadata",
      title: "Clerk OIDC discovery metadata",
      coverage: "hand-authored",
      operations: [
        {
          operationId: "OpenIDConfiguration",
          method: "GET",
          path: "/.well-known/openid-configuration",
          status: "hand-authored",
        },
        { operationId: "Authorize", method: "GET", path: "/oauth/authorize", status: "hand-authored" },
        { operationId: "Token", method: "POST", path: "/oauth/token", status: "hand-authored" },
        { operationId: "UserInfo", method: "GET", path: "/oauth/userinfo", status: "hand-authored" },
      ],
    },
  ],
  seedSchema: {
    description: "Seed Clerk users, organizations, and OAuth applications.",
    fields: [
      {
        key: "users",
        title: "Users",
        description: "Accounts addressable by Clerk id or email address.",
        example: [{ first_name: "Test", last_name: "User", email_addresses: ["test@example.com"] }],
      },
      {
        key: "organizations",
        title: "Organizations",
        description: "Organizations with optional seeded members referencing user emails.",
        example: [{ name: "My Company", slug: "my-company", members: [{ email: "test@example.com", role: "admin" }] }],
      },
      {
        key: "oauth_applications",
        title: "OAuth applications",
        description: "OAuth and OIDC clients for the sign-in flow.",
        example: [
          {
            client_id: "clerk_emulate_client",
            client_secret: "clerk_emulate_secret",
            name: "Emulate App",
            redirect_uris: ["http://localhost:3000/api/auth/callback/clerk"],
          },
        ],
      },
    ],
    example: {
      users: [
        {
          first_name: "Test",
          last_name: "User",
          email_addresses: ["test@example.com"],
          password: "clerk_test_password",
        },
      ],
      organizations: [
        { name: "My Company", slug: "my-company", members: [{ email: "test@example.com", role: "admin" }] },
      ],
      oauth_applications: [
        {
          client_id: "clerk_emulate_client",
          client_secret: "clerk_emulate_secret",
          name: "Emulate App",
          redirect_uris: ["http://localhost:3000/api/auth/callback/clerk"],
        },
      ],
    },
  },
  stateModel: {
    description: "Entities mutated by Clerk provider calls.",
    collections: [
      { name: "clerk.users" },
      { name: "clerk.emails" },
      { name: "clerk.orgs" },
      { name: "clerk.memberships" },
      { name: "clerk.invitations" },
      { name: "clerk.sessions" },
      { name: "clerk.oauth_apps" },
    ],
  },
  connections: [
    {
      id: "clerk-backend",
      title: "Clerk Backend SDK (TypeScript)",
      kind: "sdk",
      language: "typescript",
      description: "Point the Clerk Backend SDK at the emulator instance with apiUrl.",
      template:
        'import { createClerkClient } from "@clerk/backend";\n\nconst clerk = createClerkClient({\n  secretKey: "{{token}}",\n  apiUrl: "{{baseUrl}}",\n});\n\nconst users = await clerk.users.getUserList();',
    },
    {
      id: "clerk-env",
      title: "Clerk environment (env)",
      kind: "env",
      language: "bash",
      description: "The Clerk SDKs honor CLERK_API_URL and CLERK_SECRET_KEY.",
      template: "CLERK_API_URL={{baseUrl}}\nCLERK_SECRET_KEY={{token}}",
    },
    {
      id: "curl",
      title: "curl",
      kind: "curl",
      language: "bash",
      description: "Call the Backend API directly with the secret key.",
      template: 'curl -s {{baseUrl}}/v1/users -H "authorization: Bearer {{token}}"',
    },
  ],
};
