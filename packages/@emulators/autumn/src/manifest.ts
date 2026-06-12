import type { ServiceManifest } from "@emulators/core";

export const manifest: ServiceManifest = {
  id: "autumn",
  name: "Autumn",
  description:
    "Stateful Autumn billing emulator: customers (with seedable subscriptions), usage tracking, and list endpoints for plans, features, and events.",
  docsUrl: "https://docs.emulators.dev/autumn",
  surfaces: [{ id: "rest", kind: "rest", title: "Autumn v1 API", status: "partial", basePath: "/v1" }],
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
        { operationId: "features.list", method: "POST", path: "/v1/features.list", status: "hand-authored" },
        { operationId: "events.list", method: "POST", path: "/v1/events.list", status: "hand-authored" },
      ],
    },
  ],
  seedSchema: {
    description: "Seed customers with subscriptions (e.g. a paid plan).",
    fields: [
      {
        key: "customers",
        title: "Customers",
        description: "Customers keyed by id, each with optional subscriptions.",
        example: [{ id: "org_123", subscriptions: [{ plan_id: "pro", status: "active" }] }],
      },
    ],
    example: {
      customers: [{ id: "org_123", subscriptions: [{ plan_id: "pro", status: "active" }] }],
    },
  },
  stateModel: {
    description: "Entities mutated by Autumn provider calls.",
    collections: [{ name: "autumn.customers" }, { name: "autumn.events" }],
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
