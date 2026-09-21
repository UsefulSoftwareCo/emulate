import type { Entity, ServiceManifest, ServicePlugin, Store } from "@emulators/core";

interface Brand extends Entity {
  domain: string;
  title: string;
}
const brands = (store: Store) => store.collection<Brand>("context.brands", ["domain"]);
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const validDomain = (value: unknown): value is string =>
  typeof value === "string" && /^[a-z0-9.-]+\.[a-z]{2,}$/.test(value);

/** Seed explicit company matches; absent domains deliberately return the provider's no-match response. */
export function seedFromConfig(store: Store, _baseUrl: string, config: unknown): void {
  if (!record(config)) throw new Error("Expected a Context seed object");
  if (config.brands === undefined) return;
  if (!Array.isArray(config.brands)) throw new Error("Expected brands to be an array");
  const parsed = config.brands.map((brand: unknown) => {
    if (!record(brand) || !validDomain(brand.domain) || typeof brand.title !== "string" || !brand.title.trim())
      throw new Error("Each brand requires a lowercase domain and a nonempty title");
    return { domain: brand.domain, title: brand.title.trim() };
  });
  const collection = brands(store);
  for (const brand of parsed) {
    const existing = collection.findOneBy("domain", brand.domain);
    if (existing) collection.update(existing.id, brand);
    else collection.insert(brand);
  }
}

/** Curated Context.dev by-email brand lookup over a real HTTP boundary. */
export const contextPlugin: ServicePlugin = {
  name: "context",
  register(app, store) {
    app.post("/v1/brand/retrieve", async (c) => {
      const input: unknown = await c.req.json().catch(() => null);
      if (!record(input) || input.type !== "by_email" || typeof input.email !== "string")
        return c.json({ error: "invalid_request", message: "Use type by_email with an email address." }, 422);
      const parts = input.email.toLowerCase().split("@");
      const domain = parts.length === 2 ? parts[1] : undefined;
      if (!validDomain(domain)) return c.json({ error: "invalid_email" }, 422);
      const brand = brands(store).findOneBy("domain", domain);
      if (!brand) return c.json({ error: "brand_not_found" }, 404);
      return c.json({
        partial: false,
        brand: {
          domain: brand.domain,
          title: brand.title,

          logos: [],
          colors: [],
        },
      });
    });
  },
};

/** Honest machine-readable coverage for the single supported Context endpoint. */
export const manifest: ServiceManifest = {
  id: "context",
  name: "Context.dev",
  description: "Seeded company matching by email domain for onboarding tests.",
  docsUrl: "https://docs.emulators.dev/context",
  surfaces: [{ id: "rest", kind: "rest", title: "Brand retrieval by email", status: "partial", basePath: "/v1" }],
  auth: [{ id: "api-key", title: "Bearer API key", type: "api-key", status: "supported" }],
  specs: [
    {
      kind: "openapi",
      title: "Curated brand lookup",
      coverage: "hand-authored",
      operations: [
        { operationId: "brand.retrieve", method: "POST", path: "/v1/brand/retrieve", status: "hand-authored" },
      ],
    },
  ],
  seedSchema: {
    description: "Only seeded domains match. Unknown domains return 404; no external requests are made.",
    fields: [
      { key: "brands", title: "Company brands", example: [{ domain: "company.example", title: "Example Company" }] },
    ],
    example: { brands: [{ domain: "company.example", title: "Example Company" }] },
  },
  stateModel: { collections: [{ name: "context.brands", title: "Company matches" }] },
  connections: [
    {
      id: "api",
      title: "Brand lookup",
      kind: "curl",
      language: "shell",
      template:
        "curl -X POST '{{baseUrl}}/v1/brand/retrieve' -H 'Authorization: Bearer {{token}}' -H 'Content-Type: application/json' -d '{\"type\":\"by_email\",\"email\":\"person@company.example\"}'",
    },
  ],
};
