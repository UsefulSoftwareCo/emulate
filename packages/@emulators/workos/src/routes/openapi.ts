import type { RouteContext } from "@emulators/core";

// OpenAPI 3.1 document for this WorkOS emulator instance, pointed at itself,
// with the bearer-token security scheme real WorkOS uses for its REST API.
// Covers the hand-authored REST surface (see manifest.ts) — the hosted
// AuthKit/OAuth browser pages are separate UI surfaces and are omitted, as are
// unsupported operations, so OpenAPI-aware clients only see what actually
// works.
export function openapiRoutes({ app, baseUrl }: RouteContext): void {
  app.get("/openapi.json", (c) => c.json(buildSpec(baseUrl)));
}

const ok = (description: string) => ({
  description,
  content: { "application/json": { schema: { type: "object" } } },
});
const noContent = (description: string) => ({ description });
const id = { name: "id", in: "path", required: true, schema: { type: "string" } };
const query = (name: string, description: string) => ({
  name,
  in: "query",
  required: false,
  schema: { type: "string" },
  description,
});
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
      title: "WorkOS API (Emulated)",
      version: "1.0.0",
      description:
        "Emulated subset of the WorkOS REST API: user management, organization memberships, invitations, API keys, Vault KV, and the OAuth token surface. Authenticate with a bearer secret key (mint one at POST /_emulate/credentials).",
    },
    servers: [{ url: baseUrl }],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          description: "WorkOS secret API key, sent as `Authorization: Bearer sk_…`.",
        },
      },
    },
    security: [{ bearerAuth: [] }],
    paths: {
      "/user_management/authenticate": {
        post: {
          operationId: "userManagement.authenticate",
          tags: ["user-management"],
          summary: "Exchange an authorization code or refresh token for a session",
          security: [],
          requestBody: jsonBody(
            {
              grant_type: { type: "string", enum: ["authorization_code", "refresh_token"] },
              client_id: { type: "string" },
              code: { type: "string" },
              refresh_token: { type: "string" },
              organization_id: { type: "string" },
            },
            ["grant_type"],
            "authorization_code grants need `code`; refresh_token grants need `refresh_token` (optionally switching `organization_id`).",
          ),
          responses: {
            "200": ok("User, access token, and refresh token."),
            "400": ok("Invalid or used grant."),
          },
        },
      },
      "/user_management/users/{id}": {
        get: {
          operationId: "userManagement.getUser",
          tags: ["user-management"],
          summary: "Retrieve a user",
          parameters: [id],
          responses: { "200": ok("The user."), "404": ok("Not found.") },
        },
      },
      "/user_management/organization_memberships": {
        get: {
          operationId: "memberships.list",
          tags: ["memberships"],
          summary: "List organization memberships",
          parameters: [
            query("user_id", "Filter by user."),
            query("organization_id", "Filter by organization."),
            query("statuses", "Comma-separated membership statuses."),
          ],
          responses: { "200": ok("Membership list.") },
        },
        post: {
          operationId: "memberships.create",
          tags: ["memberships"],
          summary: "Add a user to an organization",
          requestBody: jsonBody(
            {
              user_id: { type: "string" },
              organization_id: { type: "string" },
              role_slug: { type: "string" },
            },
            ["user_id", "organization_id"],
            "The membership to create.",
          ),
          responses: {
            "201": ok("The created membership."),
            "404": ok("User or organization not found."),
            "409": ok("Already a member."),
          },
        },
      },
      "/user_management/organization_memberships/{id}": {
        get: {
          operationId: "memberships.get",
          tags: ["memberships"],
          summary: "Retrieve a membership",
          parameters: [id],
          responses: { "200": ok("The membership."), "404": ok("Not found.") },
        },
        put: {
          operationId: "memberships.update",
          tags: ["memberships"],
          summary: "Update a membership's role",
          parameters: [id],
          requestBody: jsonBody({ role_slug: { type: "string" } }, [], "Fields to update."),
          responses: { "200": ok("The updated membership."), "404": ok("Not found.") },
        },
        delete: {
          operationId: "memberships.delete",
          tags: ["memberships"],
          summary: "Remove a membership",
          parameters: [id],
          responses: { "204": noContent("Deleted."), "404": ok("Not found.") },
        },
      },
      "/user_management/invitations": {
        get: {
          operationId: "invitations.list",
          tags: ["invitations"],
          summary: "List invitations",
          parameters: [query("email", "Filter by invitee email."), query("organization_id", "Filter by organization.")],
          responses: { "200": ok("Invitation list.") },
        },
        post: {
          operationId: "invitations.send",
          tags: ["invitations"],
          summary: "Send an invitation",
          requestBody: jsonBody(
            {
              email: { type: "string" },
              organization_id: { type: "string" },
              inviter_user_id: { type: "string" },
              role_slug: { type: "string" },
            },
            ["email", "organization_id"],
            "The invitation to send.",
          ),
          responses: {
            "201": ok("The created invitation."),
            "404": ok("Organization not found."),
            "422": ok("Validation error."),
          },
        },
      },
      "/user_management/invitations/{id}/accept": {
        post: {
          operationId: "invitations.accept",
          tags: ["invitations"],
          summary: "Accept a pending invitation",
          parameters: [id],
          responses: {
            "200": ok("The accepted invitation."),
            "400": ok("Invitation is not pending."),
            "404": ok("Not found."),
          },
        },
      },
      "/user_management/users/{id}/api_keys": {
        get: {
          operationId: "userApiKeys.list",
          tags: ["api-keys"],
          summary: "List a user's API keys",
          parameters: [id, query("organization_id", "Filter by organization.")],
          responses: { "200": ok("API key list.") },
        },
        post: {
          operationId: "userApiKeys.create",
          tags: ["api-keys"],
          summary: "Create an API key for a user",
          parameters: [id],
          requestBody: jsonBody(
            { name: { type: "string" }, organization_id: { type: "string" } },
            [],
            "The API key to create.",
          ),
          responses: {
            "201": ok("The created key (value shown once)."),
            "404": ok("User not found."),
          },
        },
      },
      "/api_keys/validations": {
        post: {
          operationId: "apiKeys.validate",
          tags: ["api-keys"],
          summary: "Validate an API key value",
          requestBody: jsonBody({ value: { type: "string" } }, ["value"], "The API key value to validate."),
          responses: { "200": ok("The matching key."), "404": ok("Invalid API key.") },
        },
      },
      "/api_keys/{id}": {
        delete: {
          operationId: "apiKeys.delete",
          tags: ["api-keys"],
          summary: "Delete an API key",
          parameters: [id],
          responses: { "204": noContent("Deleted."), "404": ok("Not found.") },
        },
      },
      "/organizations": {
        post: {
          operationId: "organizations.create",
          tags: ["organizations"],
          summary: "Create an organization",
          requestBody: jsonBody(
            { name: { type: "string" }, external_id: { type: "string" } },
            ["name"],
            "The organization to create.",
          ),
          responses: { "201": ok("The created organization."), "422": ok("Validation error.") },
        },
      },
      "/organizations/{id}": {
        get: {
          operationId: "organizations.get",
          tags: ["organizations"],
          summary: "Retrieve an organization",
          parameters: [id],
          responses: { "200": ok("The organization."), "404": ok("Not found.") },
        },
        put: {
          operationId: "organizations.update",
          tags: ["organizations"],
          summary: "Update an organization",
          parameters: [id],
          requestBody: jsonBody({ name: { type: "string" } }, [], "Fields to update."),
          responses: { "200": ok("The updated organization."), "404": ok("Not found.") },
        },
      },
      "/organizations/{id}/roles": {
        get: {
          operationId: "organizations.roles",
          tags: ["organizations"],
          summary: "List an organization's roles",
          parameters: [id],
          responses: { "200": ok("Role list."), "404": ok("Not found.") },
        },
      },
      "/organization_domains": {
        post: {
          operationId: "organizationDomains.create",
          tags: ["organization-domains"],
          summary: "Create an organization domain",
          requestBody: jsonBody(
            { domain: { type: "string" }, organization_id: { type: "string" } },
            ["domain", "organization_id"],
            "The domain claim to create.",
          ),
          responses: { "201": ok("The created organization domain."), "409": ok("Domain conflict.") },
        },
      },
      "/organization_domains/{id}": {
        get: {
          operationId: "organizationDomains.get",
          tags: ["organization-domains"],
          summary: "Retrieve an organization domain",
          parameters: [id],
          responses: { "200": ok("The organization domain."), "404": ok("Not found.") },
        },
        delete: {
          operationId: "organizationDomains.delete",
          tags: ["organization-domains"],
          summary: "Delete an organization domain",
          parameters: [id],
          responses: { "204": noContent("Deleted."), "404": ok("Not found.") },
        },
      },
      "/sso/jwks/{clientId}": {
        get: {
          operationId: "sso.jwks",
          tags: ["oauth"],
          summary: "JWKS for verifying issued access tokens",
          security: [],
          parameters: [{ name: "clientId", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": ok("JSON Web Key Set.") },
        },
      },
      "/.well-known/oauth-authorization-server": {
        get: {
          operationId: "oauth.metadata",
          tags: ["oauth"],
          summary: "OAuth authorization-server metadata",
          security: [],
          responses: { "200": ok("Authorization-server metadata.") },
        },
      },
      "/oauth2/register": {
        post: {
          operationId: "oauth.register",
          tags: ["oauth"],
          summary: "Dynamically register an OAuth client",
          security: [],
          requestBody: jsonBody(
            {
              redirect_uris: { type: "array", items: { type: "string" } },
              client_name: { type: "string" },
            },
            [],
            "The client to register.",
          ),
          responses: { "201": ok("The registered client.") },
        },
      },
      "/oauth2/token": {
        post: {
          operationId: "oauth.token",
          tags: ["oauth"],
          summary: "Exchange an authorization code or refresh token for tokens",
          security: [],
          requestBody: {
            required: true,
            description:
              "Form-encoded or JSON. authorization_code grants need `code`; refresh_token grants need `refresh_token`.",
            content: {
              "application/x-www-form-urlencoded": {
                schema: {
                  type: "object",
                  properties: {
                    grant_type: {
                      type: "string",
                      enum: ["authorization_code", "refresh_token"],
                    },
                    code: { type: "string" },
                    refresh_token: { type: "string" },
                  },
                  required: ["grant_type"],
                },
              },
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    grant_type: {
                      type: "string",
                      enum: ["authorization_code", "refresh_token"],
                    },
                    code: { type: "string" },
                    refresh_token: { type: "string" },
                  },
                  required: ["grant_type"],
                },
              },
            },
          },
          responses: { "200": ok("Access and refresh tokens."), "400": ok("Invalid grant.") },
        },
      },
      "/vault/v1/kv": {
        post: {
          operationId: "vault.create",
          tags: ["vault"],
          summary: "Create a Vault KV object",
          requestBody: jsonBody(
            {
              name: { type: "string" },
              value: { type: "string" },
              key_context: { type: "object" },
            },
            ["name"],
            "The object to create.",
          ),
          responses: {
            "201": ok("The created object's metadata."),
            "400": ok("Validation error."),
            "409": ok("Name already exists."),
          },
        },
        get: {
          operationId: "vault.list",
          tags: ["vault"],
          summary: "List Vault KV objects",
          responses: { "200": ok("Object list (id + name).") },
        },
      },
      "/vault/v1/kv/name/{name}": {
        get: {
          operationId: "vault.readByName",
          tags: ["vault"],
          summary: "Read a Vault KV object by name",
          parameters: [{ name: "name", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": ok("The object."), "404": ok("Not found.") },
        },
      },
      "/vault/v1/kv/{id}": {
        get: {
          operationId: "vault.read",
          tags: ["vault"],
          summary: "Read a Vault KV object",
          parameters: [id],
          responses: { "200": ok("The object."), "404": ok("Not found.") },
        },
        put: {
          operationId: "vault.update",
          tags: ["vault"],
          summary: "Update a Vault KV object's value",
          parameters: [id],
          requestBody: jsonBody(
            { value: { type: "string" }, version_check: { type: "string" } },
            [],
            "The new value; pass `version_check` for optimistic concurrency.",
          ),
          responses: {
            "200": ok("The updated object."),
            "404": ok("Not found."),
            "409": ok("Version check failed."),
          },
        },
        delete: {
          operationId: "vault.delete",
          tags: ["vault"],
          summary: "Delete a Vault KV object",
          parameters: [id],
          responses: { "204": noContent("Deleted."), "404": ok("Not found.") },
        },
      },
    },
  };
}
