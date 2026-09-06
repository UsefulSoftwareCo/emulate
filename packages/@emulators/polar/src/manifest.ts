import type { OperationCoverage, ServiceManifest } from "@emulators/core";

export const operations: OperationCoverage[] = [
  { operationId: "customers:create", method: "POST", path: "/v1/customers/", status: "hand-authored" },
  { operationId: "customers:list", method: "GET", path: "/v1/customers/", status: "hand-authored" },
  { operationId: "customers:get", method: "GET", path: "/v1/customers/{id}", status: "hand-authored" },
  { operationId: "customers:update", method: "PATCH", path: "/v1/customers/{id}", status: "hand-authored" },
  { operationId: "customers:delete", method: "DELETE", path: "/v1/customers/{id}", status: "hand-authored" },
  {
    operationId: "customers:get_external",
    method: "GET",
    path: "/v1/customers/external/{external_id}",
    status: "hand-authored",
  },
  {
    operationId: "customers:update_external",
    method: "PATCH",
    path: "/v1/customers/external/{external_id}",
    status: "hand-authored",
  },
  {
    operationId: "customers:delete_external",
    method: "DELETE",
    path: "/v1/customers/external/{external_id}",
    status: "hand-authored",
  },
  { operationId: "customers:get_state", method: "GET", path: "/v1/customers/{id}/state", status: "hand-authored" },
  {
    operationId: "customers:get_state_external",
    method: "GET",
    path: "/v1/customers/external/{external_id}/state",
    status: "hand-authored",
  },
  { operationId: "customer_meters:list", method: "GET", path: "/v1/customer-meters/", status: "hand-authored" },
  { operationId: "meters:create", method: "POST", path: "/v1/meters/", status: "hand-authored" },
  { operationId: "meters:list", method: "GET", path: "/v1/meters/", status: "hand-authored" },
  { operationId: "meters:get", method: "GET", path: "/v1/meters/{id}", status: "hand-authored" },
  { operationId: "meters:update", method: "PATCH", path: "/v1/meters/{id}", status: "hand-authored" },
  { operationId: "events:ingest", method: "POST", path: "/v1/events/ingest", status: "hand-authored" },
  { operationId: "events:list", method: "GET", path: "/v1/events/", status: "hand-authored" },
  { operationId: "benefits:create", method: "POST", path: "/v1/benefits/", status: "hand-authored" },
  { operationId: "benefits:list", method: "GET", path: "/v1/benefits/", status: "hand-authored" },
  { operationId: "benefits:get", method: "GET", path: "/v1/benefits/{id}", status: "hand-authored" },
  { operationId: "benefits:update", method: "PATCH", path: "/v1/benefits/{id}", status: "hand-authored" },
  { operationId: "benefits:delete", method: "DELETE", path: "/v1/benefits/{id}", status: "hand-authored" },
  { operationId: "products:create", method: "POST", path: "/v1/products/", status: "hand-authored" },
  { operationId: "products:list", method: "GET", path: "/v1/products/", status: "hand-authored" },
  { operationId: "products:get", method: "GET", path: "/v1/products/{id}", status: "hand-authored" },
  { operationId: "products:update", method: "PATCH", path: "/v1/products/{id}", status: "hand-authored" },
  {
    operationId: "products:update_benefits",
    method: "POST",
    path: "/v1/products/{id}/benefits",
    status: "hand-authored",
  },
  { operationId: "subscriptions:create", method: "POST", path: "/v1/subscriptions/", status: "hand-authored" },
  { operationId: "subscriptions:list", method: "GET", path: "/v1/subscriptions/", status: "hand-authored" },
  { operationId: "subscriptions:get", method: "GET", path: "/v1/subscriptions/{id}", status: "hand-authored" },
  {
    operationId: "subscriptions:update",
    method: "PATCH",
    path: "/v1/subscriptions/{id}",
    status: "hand-authored",
  },
  {
    operationId: "subscriptions:revoke",
    method: "DELETE",
    path: "/v1/subscriptions/{id}",
    status: "hand-authored",
  },
  { operationId: "checkouts:create", method: "POST", path: "/v1/checkouts/", status: "hand-authored" },
  { operationId: "checkouts:get", method: "GET", path: "/v1/checkouts/{id}", status: "hand-authored" },
  {
    operationId: "checkouts:client_get",
    method: "GET",
    path: "/v1/checkouts/client/{client_secret}",
    status: "hand-authored",
  },
  {
    operationId: "customer_sessions:create",
    method: "POST",
    path: "/v1/customer-sessions/",
    status: "hand-authored",
  },
  { operationId: "organizations:list", method: "GET", path: "/v1/organizations/", status: "hand-authored" },
];

export const manifest: ServiceManifest = {
  id: "polar",
  name: "Polar",
  description:
    "Stateful Polar merchant-of-record billing emulator for customers, products, subscriptions, usage meters, hosted checkout, and the customer portal.",
  docsUrl: "https://docs.emulators.dev/polar",
  surfaces: [
    { id: "rest", kind: "rest", title: "Polar v1 API", status: "partial", basePath: "/v1" },
    { id: "checkout", kind: "ui", title: "Hosted checkout", status: "partial", basePath: "/checkout" },
    { id: "portal", kind: "ui", title: "Customer portal", status: "partial", basePath: "/portal" },
  ],
  auth: [
    {
      id: "organization-access-token",
      title: "Polar organization access token",
      type: "bearer-token",
      status: "supported",
      notes: "Any non-empty polar_oat_... bearer token is accepted.",
    },
  ],
  specs: [
    {
      kind: "openapi",
      title: "Polar v1 subscription billing subset",
      coverage: "hand-authored",
      url: "/openapi.json",
      operations,
    },
  ],
  seedSchema: {
    description: "Seed meters, benefits, products, customers, subscriptions, and checkout settlement behavior.",
    fields: [
      { key: "meters", title: "Meters", description: "Usage meters, upserted by name." },
      { key: "benefits", title: "Benefits", description: "Meter credit and custom benefits, upserted by description." },
      {
        key: "products",
        title: "Products",
        description: "Subscription products, prices, and attached benefits, upserted by name.",
      },
      { key: "customers", title: "Customers", description: "Customers and subscriptions, upserted by external_id." },
      {
        key: "checkout",
        title: "Checkout",
        description: "Settle delay in milliseconds. Null disables automatic settlement.",
      },
    ],
    example: {
      products: [
        {
          name: "Free",
          recurring_interval: "month",
          prices: [{ amount_type: "fixed", price_amount: 0, price_currency: "usd" }],
        },
      ],
      customers: [{ external_id: "customer_123", email: "customer@example.com" }],
      checkout: { settle_delay_ms: 2500 },
    },
  },
  scenarios: [
    {
      id: "delayed-checkout-settlement",
      title: "Delayed checkout settlement",
      description:
        "Confirm a checkout, observe stale customer state, then settle explicitly or after the configured delay.",
    },
  ],
  stateModel: {
    description: "Entities mutated by Polar provider calls.",
    collections: [
      { name: "polar.customers" },
      { name: "polar.meters" },
      { name: "polar.events" },
      { name: "polar.benefits" },
      { name: "polar.products" },
      { name: "polar.subscriptions" },
      { name: "polar.checkouts" },
      { name: "polar.customer_sessions" },
    ],
  },
  connections: [
    {
      id: "polar-sdk",
      title: "@polar-sh/sdk",
      kind: "sdk",
      language: "typescript",
      description: "Point the official Polar SDK at the emulator with serverURL.",
      template:
        'import { Polar } from "@polar-sh/sdk";\n\nconst polar = new Polar({ accessToken: "{{token}}", serverURL: "{{baseUrl}}" });',
    },
  ],
};
