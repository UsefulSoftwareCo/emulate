import type { ServiceManifest } from "@emulators/core";

export const manifest: ServiceManifest = {
  id: "context",
  name: "Context",
  description:
    "Stateful Context company-lookup emulator: resolve a seeded company profile (title, description, logos, brand colors) from a work email address or a domain, with free and disposable mailbox domains rejected the way the real resolver rejects them.",
  docsUrl: "https://docs.emulators.dev/context",
  surfaces: [{ id: "rest", kind: "rest", title: "Context v1 API", status: "partial", basePath: "/v1" }],
  auth: [{ id: "api-key", title: "Context API key", type: "api-key", status: "supported" }],
  specs: [
    {
      kind: "openapi",
      title: "Context v1 subset",
      coverage: "hand-authored",
      operations: [
        {
          operationId: "brand.retrieve",
          method: "POST",
          path: "/v1/brand/retrieve",
          status: "hand-authored",
        },
      ],
    },
  ],
  seedSchema: {
    description: "Seed the company profiles the lookup can resolve.",
    fields: [
      {
        key: "brands",
        title: "Brands",
        description:
          "Company profiles keyed by domain. A lookup for any other domain returns 404, which is how an unrecognized company is represented.",
        example: [
          {
            domain: "acme.example",
            title: "Acme",
            description: "An example company.",
            logos: [{ url: "https://cdn.example/acme.png", type: "icon" }],
            colors: [{ hex: "#101010" }],
          },
        ],
      },
    ],
    example: {
      brands: [{ domain: "acme.example", title: "Acme" }],
    },
  },
  stateModel: {
    description: "Entities read by Context provider calls.",
    collections: [{ name: "context.brands" }],
  },
  connections: [
    {
      id: "fetch",
      title: "Company lookup",
      kind: "sdk",
      language: "typescript",
      description: "Resolve a company from a work email address.",
      template:
        'const response = await fetch("{{baseUrl}}/v1/brand/retrieve", {\n  method: "POST",\n  headers: {\n    authorization: "Bearer {{token}}",\n    "content-type": "application/json",\n  },\n  body: JSON.stringify({ type: "by_email", email: "someone@acme.example" }),\n});\n\n// 404 means no company matched the domain.\nconst { brand } = await response.json();',
    },
  ],
};
