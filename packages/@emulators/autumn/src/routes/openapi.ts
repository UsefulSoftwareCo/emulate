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
              auto_enable_plan_id: {
                type: "string",
                description:
                  "Plan a NEW customer starts on, replacing the catalog's own auto-enabled defaults. Its features' balances are granted with the subscription. An existing customer is never re-subscribed; an unknown plan 404s with product_not_found.",
              },
              name: { type: "string" },
              email: { type: "string" },
              expand: {
                type: "array",
                items: { type: "string", enum: ["payment_method"] },
                description:
                  "Fields to expand on the returned customer. `payment_method` adds the default card (or null); omit it and the field is absent.",
              },
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
      "/v1/balances.check": {
        post: {
          operationId: "balances.check",
          tags: ["balances"],
          summary: "Check feature access for a customer",
          requestBody: jsonBody(
            {
              customer_id: { type: "string" },
              feature_id: { type: "string" },
              required_balance: { type: "number" },
              send_event: {
                type: "boolean",
                description:
                  "Consume `required_balance` in the same call when the check passes. The check and the deduction are one atomic step, and a denied check consumes nothing, so concurrent callers cannot overspend the allowance.",
              },
            },
            ["customer_id", "feature_id"],
            "The customer and feature to check. `required_balance` defaults to 1. A feature the catalog does not declare 404s; a declared feature no active subscription grants is denied with a null balance.",
          ),
          responses: {
            "200": ok("Access decision with the feature balance."),
            "400": ok("Validation error."),
            "404": ok("Unknown feature."),
          },
        },
      },
      "/v1/balances.update": {
        post: {
          operationId: "balances.update",
          tags: ["balances"],
          summary: "Set a customer's balance for a feature",
          requestBody: jsonBody(
            {
              customer_id: { type: "string" },
              feature_id: { type: "string" },
              usage: { type: "number" },
              remaining: { type: "number" },
              add_to_balance: { type: "number" },
            },
            ["customer_id", "feature_id"],
            "The balance to set. Exactly one of `usage`, `remaining`, or `add_to_balance` is required.",
          ),
          responses: {
            "200": ok("Update confirmation."),
            "400": ok("Validation error."),
            "404": ok("Unknown customer, or no balance for the feature."),
          },
        },
      },
      "/v1/billing.update": {
        post: {
          operationId: "billing.update",
          tags: ["billing"],
          summary: "Change a customer's subscription",
          requestBody: jsonBody(
            {
              customer_id: { type: "string" },
              plan_id: {
                type: "string",
                description: "Narrow the action to one subscription. Omit it to apply to every live subscription.",
              },
              cancel_action: {
                type: "string",
                enum: ["cancel_immediately", "cancel_end_of_cycle", "uncancel"],
              },
            },
            ["customer_id"],
            "Only `cancel_action` is modelled. `cancel_immediately` ends the subscription now, so the customer's next read shows neither it nor its balances. `cancel_end_of_cycle` keeps it active and records when it expires, and is rejected for a plan that bills nothing. `uncancel` clears a scheduled cancellation.",
          ),
          responses: {
            "200": ok("`{ customer_id, payment_url }`."),
            "400": ok("No update parameter was given."),
            "404": ok("Unknown customer, or no such subscription."),
          },
        },
      },
      "/v1/billing.setup_payment": {
        post: {
          operationId: "billing.setup_payment",
          tags: ["billing"],
          summary: "Open a hosted setup checkout to replace the card on file",
          requestBody: jsonBody(
            {
              customer_id: { type: "string" },
              entity_id: { type: "string" },
              plan_id: { type: "string" },
              success_url: { type: "string" },
            },
            ["customer_id"],
            "The customer whose payment method is being set up. Returns `{ customer_id, entity_id?, url }`. The captured card becomes the default only when the setup session settles AND the customer had no card: like real Autumn, a setup session never replaces an existing default. Use the billing portal to change a card.",
          ),
          responses: { "200": ok("The hosted setup URL."), "400": ok("Validation error.") },
        },
      },
      "/v1/billing.open_customer_portal": {
        post: {
          operationId: "billing.open_customer_portal",
          tags: ["billing"],
          summary: "Open a hosted billing portal session",
          requestBody: jsonBody(
            {
              customer_id: { type: "string" },
              return_url: {
                type: "string",
                description:
                  "Where the portal page links back to. Recorded on the session; omit it and no link is shown.",
              },
            },
            ["customer_id"],
            "The customer whose billing portal to open. Returns `{ customer_id, url }`; the portal page changes the card on file immediately, with no settle step.",
          ),
          responses: { "200": ok("The hosted portal URL."), "400": ok("Validation error.") },
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
