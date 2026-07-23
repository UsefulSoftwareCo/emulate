import type { RouteContext } from "@emulators/core";
import { stringify as stringifyYaml } from "yaml";

// OpenAPI 3.1 document for this Stripe emulator instance, pointed at itself,
// with the bearer-token security scheme real Stripe uses for secret keys.
// Covers the hand-authored surface (see manifest.ts); unsupported operations
// are omitted so OpenAPI-aware clients only see what actually works.
export function openapiRoutes({ app, baseUrl }: RouteContext): void {
  app.get("/openapi.json", (c) => c.json(buildSpec(baseUrl)));
  app.get("/openapi.yaml", (c) =>
    c.body(stringifyYaml(buildSpec(baseUrl)), 200, {
      "content-type": "application/yaml; charset=UTF-8",
    }),
  );
}

const ok = (description: string) => ({
  description,
  content: { "application/json": { schema: { type: "object" } } },
});
const id = { name: "id", in: "path", required: true, schema: { type: "string" } };
const metadata = { type: "object", additionalProperties: { type: "string" } };
// Stripe request bodies are form-encoded (the emulator also accepts JSON with
// the same field names). The body is only required when a field is required.
const formBody = (properties: Record<string, unknown>, required: readonly string[], description: string) => ({
  required: required.length > 0,
  description,
  content: {
    "application/x-www-form-urlencoded": {
      schema: { type: "object", properties, required: [...required] },
      ...(Object.hasOwn(properties, "metadata")
        ? { encoding: { metadata: { style: "deepObject", explode: true } } }
        : {}),
    },
  },
});

function buildSpec(baseUrl: string): Record<string, unknown> {
  return {
    openapi: "3.1.0",
    info: {
      title: "Stripe API (Emulated)",
      version: "1.0.0",
      description:
        "Emulated subset of the Stripe REST API. Authenticate with a bearer secret API key (mint one at POST /_emulate/credentials). Request bodies are application/x-www-form-urlencoded.",
    },
    servers: [{ url: baseUrl }],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          description: "Stripe secret API key, sent as `Authorization: Bearer …`.",
        },
      },
    },
    security: [{ bearerAuth: [] }],
    paths: {
      "/v1/customers": {
        post: {
          operationId: "PostCustomers",
          tags: ["customers"],
          summary: "Create a customer",
          requestBody: formBody(
            {
              email: { type: "string" },
              name: { type: "string" },
              description: { type: "string" },
              metadata,
            },
            [],
            "The customer to create.",
          ),
          responses: { "200": ok("The created customer.") },
        },
        get: {
          operationId: "GetCustomers",
          tags: ["customers"],
          summary: "List customers",
          responses: { "200": ok("Customer list.") },
        },
      },
      "/v1/customers/{id}": {
        get: {
          operationId: "GetCustomersCustomer",
          tags: ["customers"],
          summary: "Retrieve a customer",
          parameters: [id],
          responses: { "200": ok("The customer."), "404": ok("Not found.") },
        },
        post: {
          operationId: "PostCustomersCustomer",
          tags: ["customers"],
          summary: "Update a customer",
          parameters: [id],
          requestBody: formBody(
            {
              email: { type: "string" },
              name: { type: "string" },
              description: { type: "string" },
              metadata,
            },
            [],
            "The fields to update.",
          ),
          responses: { "200": ok("The updated customer."), "404": ok("Not found.") },
        },
        delete: {
          operationId: "DeleteCustomersCustomer",
          tags: ["customers"],
          summary: "Delete a customer",
          parameters: [id],
          responses: { "200": ok("Deletion confirmation."), "404": ok("Not found.") },
        },
      },
      "/v1/customer_sessions": {
        post: {
          operationId: "PostCustomerSessions",
          tags: ["customers"],
          summary: "Create a customer session",
          requestBody: formBody(
            { customer: { type: "string" }, components: { type: "object" } },
            ["customer"],
            "The customer session to create.",
          ),
          responses: { "200": ok("The created customer session."), "400": ok("Validation error.") },
        },
      },
      "/v1/payment_intents": {
        post: {
          operationId: "PostPaymentIntents",
          tags: ["payment_intents"],
          summary: "Create a payment intent",
          requestBody: formBody(
            {
              amount: { type: "integer" },
              currency: { type: "string" },
              customer: { type: "string" },
              description: { type: "string" },
              payment_method: { type: "string" },
              metadata,
            },
            ["amount", "currency"],
            "The payment intent to create.",
          ),
          responses: { "200": ok("The created payment intent."), "400": ok("Validation error.") },
        },
        get: {
          operationId: "GetPaymentIntents",
          tags: ["payment_intents"],
          summary: "List payment intents",
          responses: { "200": ok("Payment intent list.") },
        },
      },
      "/v1/payment_intents/{id}": {
        get: {
          operationId: "GetPaymentIntentsIntent",
          tags: ["payment_intents"],
          summary: "Retrieve a payment intent",
          parameters: [id],
          responses: { "200": ok("The payment intent."), "404": ok("Not found.") },
        },
        post: {
          operationId: "PostPaymentIntentsIntent",
          tags: ["payment_intents"],
          summary: "Update a payment intent",
          parameters: [id],
          requestBody: formBody(
            {
              amount: { type: "integer" },
              currency: { type: "string" },
              description: { type: "string" },
              payment_method: { type: "string" },
              metadata,
            },
            [],
            "The fields to update.",
          ),
          responses: { "200": ok("The updated payment intent."), "404": ok("Not found.") },
        },
      },
      "/v1/payment_intents/{id}/confirm": {
        post: {
          operationId: "PostPaymentIntentsIntentConfirm",
          tags: ["payment_intents"],
          summary: "Confirm a payment intent",
          parameters: [id],
          requestBody: formBody(
            { payment_method: { type: "string" } },
            [],
            "Optional payment method to attach before confirming.",
          ),
          responses: {
            "200": ok("The confirmed payment intent."),
            "400": ok("Unexpected state."),
            "404": ok("Not found."),
          },
        },
      },
      "/v1/payment_intents/{id}/cancel": {
        post: {
          operationId: "PostPaymentIntentsIntentCancel",
          tags: ["payment_intents"],
          summary: "Cancel a payment intent",
          parameters: [id],
          responses: {
            "200": ok("The canceled payment intent."),
            "400": ok("Unexpected state."),
            "404": ok("Not found."),
          },
        },
      },
      "/v1/payment_methods": {
        get: {
          operationId: "GetPaymentMethods",
          tags: ["payment_methods"],
          summary: "List payment methods (seeded test data only)",
          responses: { "200": ok("Payment method list."), "400": ok("Validation error.") },
        },
      },
      "/v1/charges/{id}": {
        get: {
          operationId: "GetChargesCharge",
          tags: ["charges"],
          summary: "Retrieve a charge",
          parameters: [id],
          responses: { "200": ok("The charge."), "404": ok("Not found.") },
        },
      },
      "/v1/charges": {
        get: {
          operationId: "GetCharges",
          tags: ["charges"],
          summary: "List charges",
          responses: { "200": ok("Charge list.") },
        },
      },
      "/v1/products": {
        post: {
          operationId: "PostProducts",
          tags: ["products"],
          summary: "Create a product",
          requestBody: formBody(
            {
              name: { type: "string" },
              description: { type: "string" },
              active: { type: "boolean" },
              metadata,
            },
            ["name"],
            "The product to create.",
          ),
          responses: { "200": ok("The created product."), "400": ok("Validation error.") },
        },
        get: {
          operationId: "GetProducts",
          tags: ["products"],
          summary: "List products",
          responses: { "200": ok("Product list.") },
        },
      },
      "/v1/products/{id}": {
        get: {
          operationId: "GetProductsId",
          tags: ["products"],
          summary: "Retrieve a product",
          parameters: [id],
          responses: { "200": ok("The product."), "404": ok("Not found.") },
        },
      },
      "/v1/prices": {
        post: {
          operationId: "PostPrices",
          tags: ["prices"],
          summary: "Create a price",
          requestBody: formBody(
            {
              currency: { type: "string" },
              product: { type: "string" },
              unit_amount: { type: "integer" },
              recurring: { type: "object" },
              active: { type: "boolean" },
              metadata,
            },
            ["currency", "product"],
            "The price to create.",
          ),
          responses: { "200": ok("The created price."), "400": ok("Validation error.") },
        },
        get: {
          operationId: "GetPrices",
          tags: ["prices"],
          summary: "List prices",
          responses: { "200": ok("Price list.") },
        },
      },
      "/v1/prices/{id}": {
        get: {
          operationId: "GetPricesPrice",
          tags: ["prices"],
          summary: "Retrieve a price",
          parameters: [id],
          responses: { "200": ok("The price."), "404": ok("Not found.") },
        },
      },
      "/v1/checkout/sessions": {
        post: {
          operationId: "PostCheckoutSessions",
          tags: ["checkout"],
          summary: "Create a checkout session",
          requestBody: formBody(
            {
              mode: { type: "string", enum: ["payment", "setup", "subscription"] },
              customer: { type: "string" },
              success_url: { type: "string" },
              cancel_url: { type: "string" },
              line_items: {
                type: "array",
                items: {
                  type: "object",
                  properties: { price: { type: "string" }, quantity: { type: "integer" } },
                  required: ["price"],
                },
              },
              metadata,
            },
            ["mode"],
            "The checkout session to create.",
          ),
          responses: { "200": ok("The created checkout session."), "400": ok("Validation error.") },
        },
        get: {
          operationId: "GetCheckoutSessions",
          tags: ["checkout"],
          summary: "List checkout sessions",
          responses: { "200": ok("Checkout session list.") },
        },
      },
      "/v1/checkout/sessions/{id}": {
        get: {
          operationId: "GetCheckoutSessionsSession",
          tags: ["checkout"],
          summary: "Retrieve a checkout session",
          parameters: [id],
          responses: { "200": ok("The checkout session."), "404": ok("Not found.") },
        },
      },
      "/v1/checkout/sessions/{id}/expire": {
        post: {
          operationId: "PostCheckoutSessionsSessionExpire",
          tags: ["checkout"],
          summary: "Expire an open checkout session",
          parameters: [id],
          responses: {
            "200": ok("The expired checkout session."),
            "400": ok("Session not open."),
            "404": ok("Not found."),
          },
        },
      },
    },
  };
}
