import type { RouteContext } from "@emulators/core";

// OpenAPI 3.1 document for this Autumn emulator instance, pointed at itself,
// with the bearer-token security scheme real Autumn uses. Covers the
// hand-authored surface (see manifest.ts); unsupported operations are omitted
// so OpenAPI-aware clients only see what actually works.
export function openapiRoutes({ app, baseUrl }: RouteContext): void {
  app.get("/openapi.json", (c) => c.json(buildSpec(baseUrl)));
}

const ok = (description: string) => ({
  description,
  content: { "application/json": { schema: { type: "object" } } },
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
      title: "Autumn API (Emulated)",
      version: "1.0.0",
      description:
        "Emulated subset of the Autumn v1 API (RPC-style paths, all POST). Authenticate with a bearer secret key (mint one at POST /_emulate/credentials).",
    },
    servers: [{ url: baseUrl }],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          description: "Autumn secret key, sent as `Authorization: Bearer am_sk_…`.",
        },
      },
    },
    security: [{ bearerAuth: [] }],
    paths: {
      "/v1/customers.get_or_create": {
        post: {
          operationId: "customers.get_or_create",
          tags: ["customers"],
          summary: "Get or create a customer",
          requestBody: jsonBody(
            {
              customer_id: { type: "string" },
              customer_data: {
                type: "object",
                properties: { name: { type: "string" }, email: { type: "string" } },
              },
              name: { type: "string" },
              email: { type: "string" },
            },
            ["customer_id"],
            "The customer to fetch or create.",
          ),
          responses: { "200": ok("The customer."), "400": ok("Validation error.") },
        },
      },
      "/v1/customers.list": {
        post: {
          operationId: "customers.list",
          tags: ["customers"],
          summary: "List customers",
          responses: { "200": ok("Customer list.") },
        },
      },
      "/v1/customers.update": {
        post: {
          operationId: "customers.update",
          tags: ["customers"],
          summary: "Update a customer",
          requestBody: jsonBody(
            {
              customer_id: { type: "string" },
              name: { type: "string" },
              email: { type: "string" },
            },
            ["customer_id"],
            "The customer fields to update.",
          ),
          responses: { "200": ok("The updated customer."), "404": ok("Not found.") },
        },
      },
      "/v1/balances.track": {
        post: {
          operationId: "balances.track",
          tags: ["balances"],
          summary: "Track a usage event",
          requestBody: jsonBody(
            {
              customer_id: { type: "string" },
              feature_id: { type: "string" },
              event_name: { type: "string" },
              value: { type: "number" },
            },
            ["customer_id", "feature_id"],
            "The usage event to record (`event_name` is accepted as an alias for `feature_id`).",
          ),
          responses: { "200": ok("Event confirmation."), "400": ok("Validation error.") },
        },
      },
      "/v1/plans.list": {
        post: {
          operationId: "plans.list",
          tags: ["plans"],
          summary: "List plans",
          responses: { "200": ok("Plan list.") },
        },
      },
      "/v1/features.list": {
        post: {
          operationId: "features.list",
          tags: ["features"],
          summary: "List features",
          responses: { "200": ok("Feature list.") },
        },
      },
      "/v1/events.list": {
        post: {
          operationId: "events.list",
          tags: ["events"],
          summary: "List tracked usage events",
          responses: { "200": ok("Event list.") },
        },
      },
    },
  };
}
