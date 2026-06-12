import type { RouteContext } from "@emulators/core";

// OpenAPI 3.1 document for this Clerk emulator instance, pointed at itself,
// with the bearer secret-key security scheme real Clerk uses. Covers the
// hand-authored Backend API surface (see manifest.ts); unsupported operations
// are omitted so OpenAPI-aware clients only see what actually works.
export function openapiRoutes({ app, baseUrl }: RouteContext): void {
  app.get("/openapi.json", (c) => c.json(buildSpec(baseUrl)));
}

const ok = (description: string) => ({
  description,
  content: { "application/json": { schema: { type: "object" } } },
});
const userId = { name: "userId", in: "path", required: true, schema: { type: "string" } };
const emailId = { name: "emailId", in: "path", required: true, schema: { type: "string" } };
const orgId = { name: "orgId", in: "path", required: true, schema: { type: "string" } };
const invitationId = { name: "invitationId", in: "path", required: true, schema: { type: "string" } };
const sessionId = { name: "sessionId", in: "path", required: true, schema: { type: "string" } };
const template = { name: "template", in: "path", required: true, schema: { type: "string" } };
const limit = { name: "limit", in: "query", required: false, schema: { type: "integer" } };
const offset = { name: "offset", in: "query", required: false, schema: { type: "integer" } };
const jsonBody = (properties: Record<string, unknown>, required: readonly string[], description: string) => ({
  required: true,
  description,
  content: {
    "application/json": {
      schema: { type: "object", properties, required: [...required] },
    },
  },
});
const metadataProperties = {
  public_metadata: { type: "object" },
  private_metadata: { type: "object" },
};

function buildSpec(baseUrl: string): Record<string, unknown> {
  return {
    openapi: "3.1.0",
    info: {
      title: "Clerk Backend API (Emulated)",
      version: "1.0.0",
      description:
        "Emulated subset of the Clerk Backend API. Authenticate with a bearer secret key (mint one at POST /_emulate/credentials).",
    },
    servers: [{ url: baseUrl }],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          description: "Clerk secret key, sent as `Authorization: Bearer sk_test_…` or `sk_live_…`.",
        },
      },
    },
    security: [{ bearerAuth: [] }],
    paths: {
      "/v1/users": {
        get: {
          operationId: "GetUserList",
          tags: ["users"],
          summary: "List users",
          parameters: [
            limit,
            offset,
            { name: "query", in: "query", required: false, schema: { type: "string" } },
            { name: "order_by", in: "query", required: false, schema: { type: "string" } },
            {
              name: "email_address",
              in: "query",
              required: false,
              schema: { type: "array", items: { type: "string" } },
            },
          ],
          responses: { "200": ok("Paginated user list.") },
        },
        post: {
          operationId: "CreateUser",
          tags: ["users"],
          summary: "Create a user",
          requestBody: jsonBody(
            {
              email_address: { type: ["string", "array"], items: { type: "string" } },
              username: { type: "string" },
              first_name: { type: "string" },
              last_name: { type: "string" },
              external_id: { type: "string" },
              password: { type: "string" },
              ...metadataProperties,
              unsafe_metadata: { type: "object" },
            },
            [],
            "The user to create.",
          ),
          responses: { "200": ok("The created user.") },
        },
      },
      "/v1/users/count": {
        get: {
          operationId: "GetUsersCount",
          tags: ["users"],
          summary: "Count users",
          responses: { "200": ok("Total user count.") },
        },
      },
      "/v1/users/{userId}": {
        get: {
          operationId: "GetUser",
          tags: ["users"],
          summary: "Retrieve a user",
          parameters: [userId],
          responses: { "200": ok("The user."), "404": ok("Not found.") },
        },
        patch: {
          operationId: "UpdateUser",
          tags: ["users"],
          summary: "Update a user",
          parameters: [userId],
          requestBody: jsonBody(
            {
              first_name: { type: "string" },
              last_name: { type: "string" },
              username: { type: "string" },
              external_id: { type: "string" },
              primary_email_address_id: { type: "string" },
              primary_phone_number_id: { type: "string" },
              password: { type: "string" },
              ...metadataProperties,
              unsafe_metadata: { type: "object" },
            },
            [],
            "The fields to update.",
          ),
          responses: { "200": ok("The updated user."), "404": ok("Not found.") },
        },
        delete: {
          operationId: "DeleteUser",
          tags: ["users"],
          summary: "Delete a user",
          parameters: [userId],
          responses: { "200": ok("Deletion confirmation."), "404": ok("Not found.") },
        },
      },
      "/v1/users/{userId}/ban": {
        post: {
          operationId: "BanUser",
          tags: ["users"],
          summary: "Ban a user",
          parameters: [userId],
          responses: { "200": ok("The banned user."), "404": ok("Not found.") },
        },
      },
      "/v1/users/{userId}/unban": {
        post: {
          operationId: "UnbanUser",
          tags: ["users"],
          summary: "Unban a user",
          parameters: [userId],
          responses: { "200": ok("The unbanned user."), "404": ok("Not found.") },
        },
      },
      "/v1/users/{userId}/lock": {
        post: {
          operationId: "LockUser",
          tags: ["users"],
          summary: "Lock a user",
          parameters: [userId],
          responses: { "200": ok("The locked user."), "404": ok("Not found.") },
        },
      },
      "/v1/users/{userId}/unlock": {
        post: {
          operationId: "UnlockUser",
          tags: ["users"],
          summary: "Unlock a user",
          parameters: [userId],
          responses: { "200": ok("The unlocked user."), "404": ok("Not found.") },
        },
      },
      "/v1/users/{userId}/metadata": {
        patch: {
          operationId: "UpdateUserMetadata",
          tags: ["users"],
          summary: "Merge and update a user's metadata",
          parameters: [userId],
          requestBody: jsonBody(
            { ...metadataProperties, unsafe_metadata: { type: "object" } },
            [],
            "Metadata objects to deep-merge into the user.",
          ),
          responses: { "200": ok("The updated user."), "404": ok("Not found.") },
        },
      },
      "/v1/users/{userId}/verify_password": {
        post: {
          operationId: "VerifyPassword",
          tags: ["users"],
          summary: "Verify a user's password",
          parameters: [userId],
          requestBody: jsonBody({ password: { type: "string" } }, ["password"], "The password to verify."),
          responses: { "200": ok("Verification result."), "404": ok("Not found.") },
        },
      },
      "/v1/email_addresses": {
        post: {
          operationId: "CreateEmailAddress",
          tags: ["email-addresses"],
          summary: "Create an email address",
          requestBody: jsonBody(
            {
              user_id: { type: "string" },
              email_address: { type: "string" },
              verified: { type: "boolean" },
              primary: { type: "boolean" },
            },
            ["user_id", "email_address"],
            "The email address to create.",
          ),
          responses: { "200": ok("The created email address."), "422": ok("Validation error.") },
        },
      },
      "/v1/email_addresses/{emailId}": {
        get: {
          operationId: "GetEmailAddress",
          tags: ["email-addresses"],
          summary: "Retrieve an email address",
          parameters: [emailId],
          responses: { "200": ok("The email address."), "404": ok("Not found.") },
        },
        patch: {
          operationId: "UpdateEmailAddress",
          tags: ["email-addresses"],
          summary: "Update an email address",
          parameters: [emailId],
          requestBody: jsonBody(
            { verified: { type: "boolean" }, primary: { type: "boolean" } },
            [],
            "The fields to update.",
          ),
          responses: { "200": ok("The updated email address."), "404": ok("Not found.") },
        },
        delete: {
          operationId: "DeleteEmailAddress",
          tags: ["email-addresses"],
          summary: "Delete an email address",
          parameters: [emailId],
          responses: { "200": ok("Deletion confirmation."), "404": ok("Not found.") },
        },
      },
      "/v1/organizations": {
        get: {
          operationId: "ListOrganizations",
          tags: ["organizations"],
          summary: "List organizations",
          parameters: [limit, offset, { name: "query", in: "query", required: false, schema: { type: "string" } }],
          responses: { "200": ok("Paginated organization list.") },
        },
        post: {
          operationId: "CreateOrganization",
          tags: ["organizations"],
          summary: "Create an organization",
          requestBody: jsonBody(
            {
              name: { type: "string" },
              slug: { type: "string" },
              created_by: { type: "string" },
              max_allowed_memberships: { type: "integer" },
              admin_delete_enabled: { type: "boolean" },
              ...metadataProperties,
            },
            ["name"],
            "The organization to create.",
          ),
          responses: { "200": ok("The created organization."), "422": ok("Validation error.") },
        },
      },
      "/v1/organizations/{orgId}": {
        get: {
          operationId: "GetOrganization",
          tags: ["organizations"],
          summary: "Retrieve an organization by id or slug",
          parameters: [orgId],
          responses: { "200": ok("The organization."), "404": ok("Not found.") },
        },
        patch: {
          operationId: "UpdateOrganization",
          tags: ["organizations"],
          summary: "Update an organization",
          parameters: [orgId],
          requestBody: jsonBody(
            {
              name: { type: "string" },
              slug: { type: "string" },
              max_allowed_memberships: { type: "integer" },
              admin_delete_enabled: { type: "boolean" },
              ...metadataProperties,
            },
            [],
            "The fields to update.",
          ),
          responses: { "200": ok("The updated organization."), "404": ok("Not found.") },
        },
        delete: {
          operationId: "DeleteOrganization",
          tags: ["organizations"],
          summary: "Delete an organization",
          parameters: [orgId],
          responses: { "200": ok("Deletion confirmation."), "404": ok("Not found.") },
        },
      },
      "/v1/organizations/{orgId}/memberships": {
        get: {
          operationId: "ListOrganizationMemberships",
          tags: ["memberships"],
          summary: "List organization memberships",
          parameters: [
            orgId,
            limit,
            offset,
            { name: "role", in: "query", required: false, schema: { type: "string" } },
          ],
          responses: { "200": ok("Paginated membership list."), "404": ok("Organization not found.") },
        },
        post: {
          operationId: "CreateOrganizationMembership",
          tags: ["memberships"],
          summary: "Add a member to an organization",
          parameters: [orgId],
          requestBody: jsonBody(
            { user_id: { type: "string" }, role: { type: "string" } },
            ["user_id"],
            "The membership to create.",
          ),
          responses: { "200": ok("The created membership."), "422": ok("Validation error.") },
        },
      },
      "/v1/organizations/{orgId}/memberships/{userId}": {
        patch: {
          operationId: "UpdateOrganizationMembership",
          tags: ["memberships"],
          summary: "Update an organization membership",
          parameters: [orgId, userId],
          requestBody: jsonBody({ role: { type: "string" } }, [], "The fields to update."),
          responses: { "200": ok("The updated membership."), "404": ok("Not found.") },
        },
        delete: {
          operationId: "DeleteOrganizationMembership",
          tags: ["memberships"],
          summary: "Remove a member from an organization",
          parameters: [orgId, userId],
          responses: { "200": ok("Deletion confirmation."), "404": ok("Not found.") },
        },
      },
      "/v1/organizations/{orgId}/invitations": {
        get: {
          operationId: "ListOrganizationInvitations",
          tags: ["invitations"],
          summary: "List organization invitations",
          parameters: [
            orgId,
            limit,
            offset,
            { name: "status", in: "query", required: false, schema: { type: "string" } },
          ],
          responses: { "200": ok("Paginated invitation list."), "404": ok("Organization not found.") },
        },
        post: {
          operationId: "CreateOrganizationInvitation",
          tags: ["invitations"],
          summary: "Invite a user to an organization",
          parameters: [orgId],
          requestBody: jsonBody(
            {
              email_address: { type: "string" },
              role: { type: "string" },
              expires_in_days: { type: "integer" },
            },
            ["email_address"],
            "The invitation to create.",
          ),
          responses: { "200": ok("The created invitation."), "422": ok("Validation error.") },
        },
      },
      "/v1/organizations/{orgId}/invitations/bulk": {
        post: {
          operationId: "CreateOrganizationInvitationBulk",
          tags: ["invitations"],
          summary: "Invite multiple users to an organization",
          parameters: [orgId],
          requestBody: jsonBody(
            {
              email_addresses: { type: "array", items: { type: "string" } },
              role: { type: "string" },
              expires_in_days: { type: "integer" },
            },
            ["email_addresses"],
            "The invitations to create.",
          ),
          responses: { "200": ok("The created invitations."), "422": ok("Validation error.") },
        },
      },
      "/v1/organizations/{orgId}/invitations/{invitationId}/revoke": {
        post: {
          operationId: "RevokeOrganizationInvitation",
          tags: ["invitations"],
          summary: "Revoke a pending invitation",
          parameters: [orgId, invitationId],
          responses: { "200": ok("The revoked invitation."), "404": ok("Not found.") },
        },
      },
      "/v1/sessions": {
        get: {
          operationId: "GetSessionList",
          tags: ["sessions"],
          summary: "List sessions",
          parameters: [limit, offset, { name: "user_id", in: "query", required: false, schema: { type: "string" } }],
          responses: { "200": ok("Paginated session list.") },
        },
        post: {
          operationId: "CreateSession",
          tags: ["sessions"],
          summary: "Create a session",
          requestBody: jsonBody(
            { user_id: { type: "string" }, client_id: { type: "string" } },
            ["user_id"],
            "The session to create.",
          ),
          responses: { "200": ok("The created session."), "422": ok("Validation error.") },
        },
      },
      "/v1/sessions/{sessionId}": {
        get: {
          operationId: "GetSession",
          tags: ["sessions"],
          summary: "Retrieve a session",
          parameters: [sessionId],
          responses: { "200": ok("The session."), "404": ok("Not found.") },
        },
      },
      "/v1/sessions/{sessionId}/revoke": {
        post: {
          operationId: "RevokeSession",
          tags: ["sessions"],
          summary: "Revoke a session",
          parameters: [sessionId],
          responses: { "200": ok("The revoked session."), "404": ok("Not found.") },
        },
      },
      "/v1/sessions/{sessionId}/tokens": {
        post: {
          operationId: "CreateSessionToken",
          tags: ["sessions"],
          summary: "Mint a session JWT",
          parameters: [sessionId],
          responses: { "200": ok("The session token."), "404": ok("Not found.") },
        },
      },
      "/v1/sessions/{sessionId}/tokens/{template}": {
        post: {
          operationId: "CreateSessionTokenFromTemplate",
          tags: ["sessions"],
          summary: "Mint a session JWT from a template",
          parameters: [sessionId, template],
          responses: { "200": ok("The session token."), "404": ok("Not found.") },
        },
      },
      "/v1/jwks": {
        get: {
          operationId: "GetJWKS",
          tags: ["jwks"],
          summary: "Retrieve the JSON Web Key Set",
          security: [],
          responses: { "200": ok("The JWKS used to verify session tokens.") },
        },
      },
    },
  };
}
