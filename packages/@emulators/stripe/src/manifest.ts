import type { ServiceManifest } from "@emulators/core";

/**
 * Stripe's machine-readable service manifest. This is the single source of truth
 * for Stripe's surfaces, auth, specs, seed shape, and copyable connection
 * snippets, consumed by the CLI registry, the Cloudflare host, and the console.
 */
export const manifest: ServiceManifest = {
  id: "stripe",
  name: "Stripe",
  description:
    "Stateful Stripe payments emulator for customers, payment intents, charges, products, prices, checkout sessions, and webhooks.",
  docsUrl: "https://docs.emulators.dev/stripe",
  surfaces: [
    { id: "rest", kind: "rest", title: "REST API", status: "partial", basePath: "/" },
    { id: "checkout", kind: "ui", title: "Checkout redirect UI", status: "supported", basePath: "/checkout" },
    { id: "webhooks", kind: "webhooks", title: "Webhooks", status: "partial" },
  ],
  auth: [
    { id: "api-key", title: "Secret API key", type: "api-key", status: "partial" },
    { id: "webhook-secret", title: "Webhook signing secret", type: "webhook-secret", status: "partial" },
  ],
  specs: [
    {
      kind: "openapi",
      title: "Stripe API subset",
      coverage: "hand-authored",
      operations: [
        { operationId: "PostCustomers", method: "POST", path: "/v1/customers", status: "hand-authored" },
        { operationId: "GetCustomersCustomer", method: "GET", path: "/v1/customers/:id", status: "hand-authored" },
        { operationId: "PostCustomersCustomer", method: "POST", path: "/v1/customers/:id", status: "hand-authored" },
        {
          operationId: "DeleteCustomersCustomer",
          method: "DELETE",
          path: "/v1/customers/:id",
          status: "hand-authored",
        },
        { operationId: "GetCustomers", method: "GET", path: "/v1/customers", status: "hand-authored" },
        { operationId: "PostCustomerSessions", method: "POST", path: "/v1/customer_sessions", status: "hand-authored" },
        { operationId: "PostPaymentIntents", method: "POST", path: "/v1/payment_intents", status: "hand-authored" },
        {
          operationId: "GetPaymentIntentsIntent",
          method: "GET",
          path: "/v1/payment_intents/:id",
          status: "hand-authored",
        },
        {
          operationId: "PostPaymentIntentsIntent",
          method: "POST",
          path: "/v1/payment_intents/:id",
          status: "hand-authored",
        },
        {
          operationId: "PostPaymentIntentsIntentConfirm",
          method: "POST",
          path: "/v1/payment_intents/:id/confirm",
          status: "hand-authored",
        },
        {
          operationId: "PostPaymentIntentsIntentCancel",
          method: "POST",
          path: "/v1/payment_intents/:id/cancel",
          status: "hand-authored",
        },
        { operationId: "GetPaymentIntents", method: "GET", path: "/v1/payment_intents", status: "hand-authored" },
        {
          operationId: "GetPaymentMethods",
          method: "GET",
          path: "/v1/payment_methods",
          status: "partial",
          summary: "Returns seeded test payment methods; live card tokenization is not modeled.",
        },
        { operationId: "GetChargesCharge", method: "GET", path: "/v1/charges/:id", status: "hand-authored" },
        { operationId: "GetCharges", method: "GET", path: "/v1/charges", status: "hand-authored" },
        { operationId: "PostProducts", method: "POST", path: "/v1/products", status: "hand-authored" },
        { operationId: "GetProductsId", method: "GET", path: "/v1/products/:id", status: "hand-authored" },
        { operationId: "GetProducts", method: "GET", path: "/v1/products", status: "hand-authored" },
        { operationId: "PostPrices", method: "POST", path: "/v1/prices", status: "hand-authored" },
        { operationId: "GetPricesPrice", method: "GET", path: "/v1/prices/:id", status: "hand-authored" },
        { operationId: "GetPrices", method: "GET", path: "/v1/prices", status: "hand-authored" },
        {
          operationId: "PostCheckoutSessions",
          method: "POST",
          path: "/v1/checkout/sessions",
          status: "hand-authored",
        },
        {
          operationId: "GetCheckoutSessionsSession",
          method: "GET",
          path: "/v1/checkout/sessions/:id",
          status: "hand-authored",
        },
        {
          operationId: "PostCheckoutSessionsSessionExpire",
          method: "POST",
          path: "/v1/checkout/sessions/:id/expire",
          status: "hand-authored",
        },
        { operationId: "GetCheckoutSessions", method: "GET", path: "/v1/checkout/sessions", status: "hand-authored" },
        {
          operationId: "PostSubscriptions",
          method: "POST",
          path: "/v1/subscriptions",
          status: "unsupported",
          summary: "Subscriptions and recurring billing are not yet modeled.",
        },
        {
          operationId: "PostRefunds",
          method: "POST",
          path: "/v1/refunds",
          status: "unsupported",
          summary: "Refunds are not yet modeled.",
        },
      ],
    },
    { kind: "manual", title: "Checkout redirect UI and webhook behavior", coverage: "hand-authored" },
  ],
  seedSchema: {
    description: "Seed customers, products, prices, and webhook endpoints.",
    fields: [
      {
        key: "customers",
        title: "Customers",
        description: "Customers addressable by id or email.",
        example: [{ email: "test@example.com", name: "Test Customer" }],
      },
      {
        key: "products",
        title: "Products",
        example: [{ name: "Pro Plan", description: "Monthly pro subscription" }],
      },
      {
        key: "prices",
        title: "Prices",
        description: "Prices are linked to a product by product_name.",
        example: [{ product_name: "Pro Plan", currency: "usd", unit_amount: 2000 }],
      },
      {
        key: "webhooks",
        title: "Webhook endpoints",
        example: [{ url: "https://example.com/webhooks/stripe", events: ["checkout.session.completed"] }],
      },
    ],
    example: {
      customers: [{ email: "test@example.com", name: "Test Customer" }],
      products: [{ name: "Pro Plan", description: "Monthly pro subscription" }],
      prices: [{ product_name: "Pro Plan", currency: "usd", unit_amount: 2000 }],
    },
  },
  stateModel: {
    description: "Entities mutated by Stripe provider calls.",
    collections: [
      { name: "stripe.customers" },
      { name: "stripe.products" },
      { name: "stripe.prices" },
      { name: "stripe.payment_intents" },
      { name: "stripe.charges" },
      { name: "stripe.checkout_sessions" },
    ],
  },
  connections: [
    {
      id: "stripe-node",
      title: "Stripe SDK (TypeScript)",
      kind: "sdk",
      language: "typescript",
      description: "Point the Stripe Node SDK at the emulator instance.",
      template:
        'import Stripe from "stripe";\n\nconst url = new URL("{{baseUrl}}");\nconst stripe = new Stripe("{{token}}", {\n  host: url.hostname,\n  port: Number(url.port),\n  protocol: url.protocol.replace(":", ""),\n});',
    },
    {
      id: "stripe-env",
      title: "Stripe env",
      kind: "env",
      language: "bash",
      description: "Expose the emulator base URL and a secret key to your app.",
      template: "STRIPE_API_BASE={{baseUrl}}\nSTRIPE_SECRET_KEY={{token}}",
    },
    {
      id: "curl",
      title: "curl",
      kind: "curl",
      language: "bash",
      description: "Call the REST API directly.",
      template: 'curl -s {{baseUrl}}/v1/customers -H "authorization: Bearer {{token}}"',
    },
  ],
};
