import type { ServiceManifest } from "@emulators/core";

export const manifest: ServiceManifest = {
  id: "autumn",
  name: "Autumn",
  description:
    "Stateful Autumn billing emulator: customers (with seedable subscriptions and a plan catalog), usage tracking, plan eligibility, and a hosted checkout flow for paid plans and card-required free trials.",
  docsUrl: "https://docs.emulators.dev/autumn",
  surfaces: [
    { id: "rest", kind: "rest", title: "Autumn v1 API", status: "partial", basePath: "/v1" },
    { id: "checkout", kind: "ui", title: "Hosted checkout", status: "partial", basePath: "/checkout" },
  ],
  auth: [{ id: "api-key", title: "Autumn secret key", type: "api-key", status: "supported" }],
  specs: [
    {
      kind: "openapi",
      title: "Autumn v1 subset",
      coverage: "hand-authored",
      url: "/openapi.json",
      operations: [
        {
          operationId: "customers.get_or_create",
          method: "POST",
          path: "/v1/customers.get_or_create",
          status: "hand-authored",
        },
        { operationId: "customers.list", method: "POST", path: "/v1/customers.list", status: "hand-authored" },
        { operationId: "customers.update", method: "POST", path: "/v1/customers.update", status: "hand-authored" },
        { operationId: "balances.track", method: "POST", path: "/v1/balances.track", status: "hand-authored" },
        { operationId: "plans.list", method: "POST", path: "/v1/plans.list", status: "hand-authored" },
        { operationId: "billing.attach", method: "POST", path: "/v1/billing.attach", status: "hand-authored" },
        {
          operationId: "billing.open_customer_portal",
          method: "POST",
          path: "/v1/billing.open_customer_portal",
          status: "hand-authored",
        },
        { operationId: "features.list", method: "POST", path: "/v1/features.list", status: "hand-authored" },
        { operationId: "events.list", method: "POST", path: "/v1/events.list", status: "hand-authored" },
      ],
    },
  ],
  seedSchema: {
    description: "Seed the plan catalog and customers (with subscriptions).",
    fields: [
      {
        key: "plans",
        title: "Plans",
        description:
          "Plan catalog advertised by plans.list and attachable via billing.attach. A plan with a price or a card-required free_trial routes attach through hosted checkout.",
        example: [
          {
            id: "team",
            name: "Team",
            price: { amount: 150, interval: "month" },
            free_trial: { duration_length: 14, duration_type: "day", card_required: true },
          },
        ],
      },
      {
        key: "customers",
        title: "Customers",
        description: "Customers keyed by id, each with optional subscriptions.",
        example: [{ id: "org_123", subscriptions: [{ plan_id: "team", status: "active" }] }],
      },
    ],
    example: {
      plans: [{ id: "free", name: "Free", auto_enable: true }],
      customers: [{ id: "org_123", subscriptions: [{ plan_id: "team", status: "active" }] }],
    },
  },
  stateModel: {
    description: "Entities mutated by Autumn provider calls.",
    collections: [
      { name: "autumn.customers" },
      { name: "autumn.events" },
      { name: "autumn.plans" },
      { name: "autumn.checkouts" },
    ],
  },
  connections: [
    {
      id: "autumn-js",
      title: "autumn-js SDK",
      kind: "sdk",
      language: "typescript",
      description: "Point autumn-js at the emulator via serverURL.",
      template:
        'import { Autumn } from "autumn-js";\n\nconst autumn = new Autumn({ secretKey: "{{token}}", serverURL: "{{baseUrl}}" });',
    },
  ],
};
