import type { RouteContext } from "@emulators/core";

// OpenAPI 3.1 document for this Resend emulator instance, pointed at itself,
// with the bearer-token security scheme real Resend uses. Covers the
// hand-authored surface (see manifest.ts); unsupported operations are omitted
// so OpenAPI-aware clients only see what actually works.
export function openapiRoutes({ app, baseUrl }: RouteContext): void {
  app.get("/openapi.json", (c) => c.json(buildSpec(baseUrl)));
}

const ok = (description: string) => ({
  description,
  content: { "application/json": { schema: { type: "object" } } },
});
const id = { name: "id", in: "path", required: true, schema: { type: "string" } };
const audienceId = { name: "audience_id", in: "path", required: true, schema: { type: "string" } };
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
      title: "Resend API (Emulated)",
      version: "1.0.0",
      description:
        "Emulated subset of the Resend REST API. Authenticate with a bearer API key (mint one at POST /_emulate/credentials).",
    },
    servers: [{ url: baseUrl }],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          description: "Resend API key, sent as `Authorization: Bearer re_…`.",
        },
      },
    },
    security: [{ bearerAuth: [] }],
    paths: {
      "/emails": {
        post: {
          operationId: "emails.send",
          tags: ["emails"],
          summary: "Send an email",
          requestBody: jsonBody(
            {
              from: { type: "string" },
              to: { type: ["string", "array"], items: { type: "string" } },
              subject: { type: "string" },
              html: { type: "string" },
              text: { type: "string" },
              cc: { type: ["string", "array"], items: { type: "string" } },
              bcc: { type: ["string", "array"], items: { type: "string" } },
              reply_to: { type: ["string", "array"], items: { type: "string" } },
              scheduled_at: { type: "string" },
            },
            ["from", "to", "subject"],
            "The email to send.",
          ),
          responses: { "200": ok("The created email."), "422": ok("Validation error.") },
        },
        get: {
          operationId: "emails.list",
          tags: ["emails"],
          summary: "List sent emails",
          responses: { "200": ok("Email list.") },
        },
      },
      "/emails/batch": {
        post: {
          operationId: "emails.sendBatch",
          tags: ["emails"],
          summary: "Send up to 100 emails at once",
          requestBody: {
            required: true,
            description: "An array of email objects (same shape as emails.send).",
            content: {
              "application/json": {
                schema: { type: "array", items: { type: "object" } },
              },
            },
          },
          responses: { "200": ok("The created emails."), "422": ok("Validation error.") },
        },
      },
      "/emails/{id}": {
        get: {
          operationId: "emails.get",
          tags: ["emails"],
          summary: "Retrieve a sent email",
          parameters: [id],
          responses: { "200": ok("The email."), "404": ok("Not found.") },
        },
      },
      "/emails/{id}/cancel": {
        post: {
          operationId: "emails.cancel",
          tags: ["emails"],
          summary: "Cancel a scheduled email",
          parameters: [id],
          responses: { "200": ok("The canceled email."), "404": ok("Not found.") },
        },
      },
      "/domains": {
        post: {
          operationId: "domains.create",
          tags: ["domains"],
          summary: "Add a sending domain",
          requestBody: jsonBody(
            { name: { type: "string" }, region: { type: "string" } },
            ["name"],
            "The domain to add.",
          ),
          responses: { "201": ok("The created domain."), "422": ok("Validation error.") },
        },
        get: {
          operationId: "domains.list",
          tags: ["domains"],
          summary: "List domains",
          responses: { "200": ok("Domain list.") },
        },
      },
      "/domains/{id}": {
        get: {
          operationId: "domains.get",
          tags: ["domains"],
          summary: "Retrieve a domain",
          parameters: [id],
          responses: { "200": ok("The domain."), "404": ok("Not found.") },
        },
        delete: {
          operationId: "domains.remove",
          tags: ["domains"],
          summary: "Remove a domain",
          parameters: [id],
          responses: { "200": ok("Deletion confirmation."), "404": ok("Not found.") },
        },
      },
      "/domains/{id}/verify": {
        post: {
          operationId: "domains.verify",
          tags: ["domains"],
          summary: "Trigger domain verification",
          parameters: [id],
          responses: { "200": ok("Verification state."), "404": ok("Not found.") },
        },
      },
      "/api-keys": {
        post: {
          operationId: "apiKeys.create",
          tags: ["api-keys"],
          summary: "Create an API key",
          requestBody: jsonBody(
            { name: { type: "string" }, permission: { type: "string" } },
            ["name"],
            "The API key to create.",
          ),
          responses: { "201": ok("The created key (token shown once).") },
        },
        get: {
          operationId: "apiKeys.list",
          tags: ["api-keys"],
          summary: "List API keys",
          responses: { "200": ok("API key list.") },
        },
      },
      "/api-keys/{id}": {
        delete: {
          operationId: "apiKeys.remove",
          tags: ["api-keys"],
          summary: "Remove an API key",
          parameters: [id],
          responses: { "200": ok("Deletion confirmation."), "404": ok("Not found.") },
        },
      },
      "/audiences": {
        post: {
          operationId: "audiences.create",
          tags: ["audiences"],
          summary: "Create an audience",
          requestBody: jsonBody({ name: { type: "string" } }, ["name"], "The audience to create."),
          responses: { "201": ok("The created audience.") },
        },
        get: {
          operationId: "audiences.list",
          tags: ["audiences"],
          summary: "List audiences",
          responses: { "200": ok("Audience list.") },
        },
      },
      "/audiences/{id}": {
        delete: {
          operationId: "audiences.remove",
          tags: ["audiences"],
          summary: "Remove an audience",
          parameters: [id],
          responses: { "200": ok("Deletion confirmation."), "404": ok("Not found.") },
        },
      },
      "/audiences/{audience_id}/contacts": {
        post: {
          operationId: "contacts.create",
          tags: ["contacts"],
          summary: "Add a contact to an audience",
          parameters: [audienceId],
          requestBody: jsonBody(
            {
              email: { type: "string" },
              first_name: { type: "string" },
              last_name: { type: "string" },
              unsubscribed: { type: "boolean" },
            },
            ["email"],
            "The contact to add.",
          ),
          responses: { "201": ok("The created contact."), "422": ok("Validation error.") },
        },
        get: {
          operationId: "contacts.list",
          tags: ["contacts"],
          summary: "List contacts in an audience",
          parameters: [audienceId],
          responses: { "200": ok("Contact list."), "404": ok("Audience not found.") },
        },
      },
      "/audiences/{audience_id}/contacts/{id}": {
        delete: {
          operationId: "contacts.remove",
          tags: ["contacts"],
          summary: "Remove a contact from an audience",
          parameters: [audienceId, id],
          responses: { "200": ok("Deletion confirmation."), "404": ok("Not found.") },
        },
      },
    },
  };
}
