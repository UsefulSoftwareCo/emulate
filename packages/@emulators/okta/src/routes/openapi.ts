import type { RouteContext } from "@emulators/core";

// OpenAPI 3.1 document for this Okta emulator instance, pointed at itself, with
// the SSWS API-token security scheme real Okta uses for the management API.
// Covers the hand-authored management surface (see manifest.ts); the OAuth and
// OIDC browser endpoints are described by the oauth-metadata spec instead, so
// OpenAPI-aware clients only see what actually works over plain REST.
export function openapiRoutes({ app, baseUrl }: RouteContext): void {
  app.get("/openapi.json", (c) => c.json(buildSpec(baseUrl)));
}

const ok = (description: string) => ({
  description,
  content: { "application/json": { schema: { type: "object" } } },
});
const noContent = (description: string) => ({ description });
const userId = { name: "userId", in: "path", required: true, schema: { type: "string" } };
const groupId = { name: "groupId", in: "path", required: true, schema: { type: "string" } };
const appId = { name: "appId", in: "path", required: true, schema: { type: "string" } };
const authServerId = { name: "authServerId", in: "path", required: true, schema: { type: "string" } };
const q = { name: "q", in: "query", required: false, schema: { type: "string" } };
const jsonBody = (properties: Record<string, unknown>, required: readonly string[], description: string) => ({
  required: true,
  description,
  content: {
    "application/json": {
      schema: { type: "object", properties, required: [...required] },
    },
  },
});

const userProfileBody = (description: string) =>
  jsonBody(
    {
      profile: {
        type: "object",
        properties: {
          login: { type: "string" },
          email: { type: "string" },
          firstName: { type: "string" },
          lastName: { type: "string" },
          displayName: { type: "string" },
          locale: { type: "string" },
          timeZone: { type: "string" },
        },
      },
    },
    ["profile"],
    description,
  );

const groupProfileBody = (description: string) =>
  jsonBody(
    {
      profile: {
        type: "object",
        properties: { name: { type: "string" }, description: { type: "string" } },
      },
      type: { type: "string" },
    },
    ["profile"],
    description,
  );

const appBody = (description: string, required: readonly string[]) =>
  jsonBody(
    {
      name: { type: "string" },
      label: { type: "string" },
      status: { type: "string", enum: ["ACTIVE", "INACTIVE"] },
      signOnMode: { type: "string" },
      settings: { type: "object" },
      credentials: { type: "object" },
    },
    required,
    description,
  );

const authServerBody = (description: string, required: readonly string[]) =>
  jsonBody(
    {
      id: { type: "string" },
      name: { type: "string" },
      description: { type: "string" },
      audiences: { type: "array", items: { type: "string" } },
      status: { type: "string", enum: ["ACTIVE", "INACTIVE"] },
    },
    required,
    description,
  );

function buildSpec(baseUrl: string): Record<string, unknown> {
  return {
    openapi: "3.1.0",
    info: {
      title: "Okta Management API (Emulated)",
      version: "1.0.0",
      description:
        'Emulated subset of the Okta management REST API. Authenticate with an SSWS API token (mint one at POST /_emulate/credentials with {"type":"api-key"}).',
    },
    servers: [{ url: baseUrl }],
    components: {
      securitySchemes: {
        ssws: {
          type: "apiKey",
          in: "header",
          name: "Authorization",
          description: "Okta API token, sent as `Authorization: SSWS {token}`.",
        },
      },
    },
    security: [{ ssws: [] }],
    paths: {
      "/api/v1/users": {
        get: {
          operationId: "users/list",
          tags: ["users"],
          summary: "List users",
          parameters: [
            q,
            { name: "search", in: "query", required: false, schema: { type: "string" } },
            { name: "filter", in: "query", required: false, schema: { type: "string" } },
          ],
          responses: { "200": ok("User list.") },
        },
        post: {
          operationId: "users/create",
          tags: ["users"],
          summary: "Create a user",
          parameters: [{ name: "activate", in: "query", required: false, schema: { type: "boolean" } }],
          requestBody: userProfileBody("The user profile (profile.login and profile.email are required)."),
          responses: { "201": ok("The created user."), "400": ok("Validation error.") },
        },
      },
      "/api/v1/users/me": {
        get: {
          operationId: "users/getCurrent",
          tags: ["users"],
          summary: "Get the current user",
          responses: { "200": ok("The current user."), "404": ok("Not found.") },
        },
      },
      "/api/v1/users/{userId}": {
        get: {
          operationId: "users/get",
          tags: ["users"],
          summary: "Retrieve a user by id, login, or email",
          parameters: [userId],
          responses: { "200": ok("The user."), "404": ok("Not found.") },
        },
        put: {
          operationId: "users/update",
          tags: ["users"],
          summary: "Update a user profile",
          parameters: [userId],
          requestBody: userProfileBody("The profile fields to replace."),
          responses: { "200": ok("The updated user."), "404": ok("Not found.") },
        },
        post: {
          operationId: "users/partialUpdate",
          tags: ["users"],
          summary: "Partially update a user profile",
          parameters: [userId],
          requestBody: userProfileBody("The profile fields to merge."),
          responses: { "200": ok("The updated user."), "404": ok("Not found.") },
        },
        delete: {
          operationId: "users/delete",
          tags: ["users"],
          summary: "Deactivate, then delete a user",
          description: "Like real Okta, the first delete deactivates the user; a second delete removes them.",
          parameters: [userId],
          responses: { "204": noContent("Deactivated or deleted."), "404": ok("Not found.") },
        },
      },
      "/api/v1/users/{userId}/groups": {
        get: {
          operationId: "users/listGroups",
          tags: ["users"],
          summary: "List a user's groups",
          parameters: [userId],
          responses: { "200": ok("Group list."), "404": ok("Not found.") },
        },
      },
      "/api/v1/users/{userId}/lifecycle/activate": {
        post: {
          operationId: "users/activate",
          tags: ["users"],
          summary: "Activate a user",
          parameters: [userId],
          responses: { "200": ok("The activated user."), "404": ok("Not found.") },
        },
      },
      "/api/v1/users/{userId}/lifecycle/deactivate": {
        post: {
          operationId: "users/deactivate",
          tags: ["users"],
          summary: "Deactivate a user",
          parameters: [userId],
          responses: { "200": ok("The deactivated user."), "404": ok("Not found.") },
        },
      },
      "/api/v1/users/{userId}/lifecycle/suspend": {
        post: {
          operationId: "users/suspend",
          tags: ["users"],
          summary: "Suspend a user",
          parameters: [userId],
          responses: { "200": ok("The suspended user."), "404": ok("Not found.") },
        },
      },
      "/api/v1/users/{userId}/lifecycle/unsuspend": {
        post: {
          operationId: "users/unsuspend",
          tags: ["users"],
          summary: "Unsuspend a user",
          parameters: [userId],
          responses: { "200": ok("The unsuspended user."), "404": ok("Not found.") },
        },
      },
      "/api/v1/users/{userId}/lifecycle/reactivate": {
        post: {
          operationId: "users/reactivate",
          tags: ["users"],
          summary: "Reactivate a user",
          parameters: [userId],
          responses: { "200": ok("The reactivated user."), "404": ok("Not found.") },
        },
      },
      "/api/v1/groups": {
        get: {
          operationId: "groups/list",
          tags: ["groups"],
          summary: "List groups",
          parameters: [q],
          responses: { "200": ok("Group list.") },
        },
        post: {
          operationId: "groups/create",
          tags: ["groups"],
          summary: "Create a group",
          requestBody: groupProfileBody("The group to create (profile.name is required)."),
          responses: { "201": ok("The created group."), "400": ok("Validation error.") },
        },
      },
      "/api/v1/groups/{groupId}": {
        get: {
          operationId: "groups/get",
          tags: ["groups"],
          summary: "Retrieve a group",
          parameters: [groupId],
          responses: { "200": ok("The group."), "404": ok("Not found.") },
        },
        put: {
          operationId: "groups/update",
          tags: ["groups"],
          summary: "Update a group",
          parameters: [groupId],
          requestBody: groupProfileBody("The group fields to replace."),
          responses: { "200": ok("The updated group."), "404": ok("Not found.") },
        },
        delete: {
          operationId: "groups/delete",
          tags: ["groups"],
          summary: "Delete a group",
          parameters: [groupId],
          responses: { "204": noContent("Deleted."), "404": ok("Not found.") },
        },
      },
      "/api/v1/groups/{groupId}/users": {
        get: {
          operationId: "groups/listUsers",
          tags: ["groups"],
          summary: "List a group's members",
          parameters: [groupId],
          responses: { "200": ok("User list."), "404": ok("Not found.") },
        },
      },
      "/api/v1/groups/{groupId}/users/{userId}": {
        put: {
          operationId: "groups/addUser",
          tags: ["groups"],
          summary: "Add a user to a group",
          parameters: [groupId, userId],
          responses: { "204": noContent("Added."), "404": ok("Not found.") },
        },
        delete: {
          operationId: "groups/removeUser",
          tags: ["groups"],
          summary: "Remove a user from a group",
          parameters: [groupId, userId],
          responses: { "204": noContent("Removed."), "404": ok("Not found.") },
        },
      },
      "/api/v1/apps": {
        get: {
          operationId: "apps/list",
          tags: ["apps"],
          summary: "List applications",
          parameters: [q],
          responses: { "200": ok("Application list.") },
        },
        post: {
          operationId: "apps/create",
          tags: ["apps"],
          summary: "Create an application",
          requestBody: appBody("The application to create.", []),
          responses: { "201": ok("The created application.") },
        },
      },
      "/api/v1/apps/{appId}": {
        get: {
          operationId: "apps/get",
          tags: ["apps"],
          summary: "Retrieve an application",
          parameters: [appId],
          responses: { "200": ok("The application."), "404": ok("Not found.") },
        },
        put: {
          operationId: "apps/update",
          tags: ["apps"],
          summary: "Update an application",
          parameters: [appId],
          requestBody: appBody("The application fields to replace.", []),
          responses: { "200": ok("The updated application."), "404": ok("Not found.") },
        },
        delete: {
          operationId: "apps/delete",
          tags: ["apps"],
          summary: "Delete an INACTIVE application",
          parameters: [appId],
          responses: {
            "204": noContent("Deleted."),
            "400": ok("App must be INACTIVE before deletion."),
            "404": ok("Not found."),
          },
        },
      },
      "/api/v1/apps/{appId}/users": {
        get: {
          operationId: "apps/listUsers",
          tags: ["apps"],
          summary: "List users assigned to an application",
          parameters: [appId],
          responses: { "200": ok("Assigned user list."), "404": ok("Not found.") },
        },
      },
      "/api/v1/apps/{appId}/users/{userId}": {
        put: {
          operationId: "apps/assignUser",
          tags: ["apps"],
          summary: "Assign a user to an application",
          parameters: [appId, userId],
          responses: { "204": noContent("Assigned."), "404": ok("Not found.") },
        },
        delete: {
          operationId: "apps/unassignUser",
          tags: ["apps"],
          summary: "Unassign a user from an application",
          parameters: [appId, userId],
          responses: { "204": noContent("Unassigned."), "404": ok("Not found.") },
        },
      },
      "/api/v1/apps/{appId}/lifecycle/activate": {
        post: {
          operationId: "apps/activate",
          tags: ["apps"],
          summary: "Activate an application",
          parameters: [appId],
          responses: { "200": ok("The activated application."), "404": ok("Not found.") },
        },
      },
      "/api/v1/apps/{appId}/lifecycle/deactivate": {
        post: {
          operationId: "apps/deactivate",
          tags: ["apps"],
          summary: "Deactivate an application",
          parameters: [appId],
          responses: { "200": ok("The deactivated application."), "404": ok("Not found.") },
        },
      },
      "/api/v1/authorizationServers": {
        get: {
          operationId: "authorizationServers/list",
          tags: ["authorizationServers"],
          summary: "List authorization servers",
          responses: { "200": ok("Authorization server list.") },
        },
        post: {
          operationId: "authorizationServers/create",
          tags: ["authorizationServers"],
          summary: "Create an authorization server",
          requestBody: authServerBody("The authorization server to create (name is required).", ["name"]),
          responses: { "201": ok("The created authorization server."), "400": ok("Validation error.") },
        },
      },
      "/api/v1/authorizationServers/{authServerId}": {
        get: {
          operationId: "authorizationServers/get",
          tags: ["authorizationServers"],
          summary: "Retrieve an authorization server",
          parameters: [authServerId],
          responses: { "200": ok("The authorization server."), "404": ok("Not found.") },
        },
        put: {
          operationId: "authorizationServers/update",
          tags: ["authorizationServers"],
          summary: "Update an authorization server",
          parameters: [authServerId],
          requestBody: authServerBody("The authorization server fields to replace.", []),
          responses: { "200": ok("The updated authorization server."), "404": ok("Not found.") },
        },
        delete: {
          operationId: "authorizationServers/delete",
          tags: ["authorizationServers"],
          summary: "Delete an authorization server and its clients",
          parameters: [authServerId],
          responses: { "204": noContent("Deleted."), "404": ok("Not found.") },
        },
      },
      "/api/v1/authorizationServers/{authServerId}/lifecycle/activate": {
        post: {
          operationId: "authorizationServers/activate",
          tags: ["authorizationServers"],
          summary: "Activate an authorization server",
          parameters: [authServerId],
          responses: { "200": ok("The activated authorization server."), "404": ok("Not found.") },
        },
      },
      "/api/v1/authorizationServers/{authServerId}/lifecycle/deactivate": {
        post: {
          operationId: "authorizationServers/deactivate",
          tags: ["authorizationServers"],
          summary: "Deactivate an authorization server",
          parameters: [authServerId],
          responses: { "200": ok("The deactivated authorization server."), "404": ok("Not found.") },
        },
      },
    },
  };
}
