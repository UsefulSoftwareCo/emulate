import type { ServiceManifest } from "@emulators/core";

export const manifest: ServiceManifest = {
  id: "autumn",
  name: "Autumn",
  description:
    "Stateful Autumn billing emulator: customers (with auto_enable_plan_id, seedable subscriptions and a seedable feature and plan catalog), usage tracking, atomic check-and-consume, subscription cancellation, plan eligibility, a hosted checkout flow for paid plans and card-required free trials, a hosted setup flow for putting a card on file, and a hosted billing portal for changing it.",
  docsUrl: "https://docs.emulators.dev/autumn",
  surfaces: [
    { id: "rest", kind: "rest", title: "Autumn v1 API", status: "partial", basePath: "/v1" },
    { id: "checkout", kind: "ui", title: "Hosted checkout", status: "partial", basePath: "/checkout" },
    { id: "setup", kind: "ui", title: "Hosted payment method setup", status: "partial", basePath: "/checkout/setup" },
    { id: "portal", kind: "ui", title: "Hosted billing portal", status: "partial", basePath: "/checkout/portal" },
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
        { operationId: "balances.check", method: "POST", path: "/v1/balances.check", status: "hand-authored" },
        { operationId: "balances.update", method: "POST", path: "/v1/balances.update", status: "hand-authored" },
        { operationId: "plans.list", method: "POST", path: "/v1/plans.list", status: "hand-authored" },
        { operationId: "billing.attach", method: "POST", path: "/v1/billing.attach", status: "hand-authored" },
        { operationId: "billing.update", method: "POST", path: "/v1/billing.update", status: "partial" },
        {
          operationId: "billing.setup_payment",
          method: "POST",
          path: "/v1/billing.setup_payment",
          status: "hand-authored",
        },
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
    description: "Seed the feature and plan catalog, and customers with subscriptions.",
    fields: [
      {
        key: "features",
        title: "Features",
        description:
          "Feature catalog. Optional: any feature a seeded plan item references is already part of the catalog. Seed features explicitly to control a name, type, or consumable flag. balances.check 404s with feature_not_found for an id the catalog does not declare.",
        example: [
          { id: "app-stage-executions", name: "Executions", type: "metered", consumable: true },
          { id: "app-stage-members", name: "Members", type: "metered", consumable: false },
        ],
      },
      {
        key: "plans",
        title: "Plans",
        description:
          "Plan catalog advertised by plans.list, attachable via billing.attach, and nameable through auto_enable_plan_id. Plans sharing a group are mutually exclusive. A plan with a price or a card-required free_trial routes attach through hosted checkout.",
        example: [
          {
            id: "app-stage-free",
            name: "Free",
            group: "app-stage",
            items: [
              { feature_id: "app-stage-members", included: 3, unlimited: false },
              { feature_id: "app-stage-executions", included: 100000, unlimited: false, reset: { interval: "month" } },
            ],
          },
          {
            id: "app-stage-team",
            name: "Team",
            group: "app-stage",
            free_trial: { duration_length: 14, duration_type: "day", card_required: true },
            items: [
              {
                feature_id: "app-stage-members",
                included: 0,
                unlimited: false,
                price: { amount: 15, billing_units: 1, billing_method: "usage_based", interval: "month" },
              },
              { feature_id: "app-stage-executions", included: 0, unlimited: true, reset: { interval: "month" } },
            ],
          },
        ],
      },
      {
        key: "customers",
        title: "Customers",
        description: "Customers keyed by id, each with optional subscriptions and an optional card on file.",
        example: [
          {
            id: "org_123",
            subscriptions: [{ plan_id: "app-stage-team", status: "active" }],
            payment_method: { type: "card", card: { brand: "visa", last4: "4242", exp_month: 12, exp_year: 2030 } },
          },
        ],
      },
    ],
    example: {
      features: [{ id: "app-stage-executions", name: "Executions", consumable: true }],
      plans: [
        {
          id: "app-stage-free",
          name: "Free",
          group: "app-stage",
          items: [
            { feature_id: "app-stage-executions", included: 100000, unlimited: false, reset: { interval: "month" } },
          ],
        },
      ],
    },
  },
  stateModel: {
    description: "Entities mutated by Autumn provider calls.",
    collections: [
      { name: "autumn.customers" },
      { name: "autumn.events" },
      { name: "autumn.plans" },
      { name: "autumn.features" },
      { name: "autumn.checkouts" },
      { name: "autumn.setups" },
      { name: "autumn.portals" },
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
