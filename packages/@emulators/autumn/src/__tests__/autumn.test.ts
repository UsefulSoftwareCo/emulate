import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, serve } from "@emulators/core";
import { Autumn } from "autumn-js";

import { autumnPlugin, seedFromConfig } from "../index.js";
import { manifest } from "../manifest.js";

// The real autumn-js SDK (zod-validated responses) against the emulator.

const PORT = 41874;
const BASE = `http://localhost:${PORT}`;

let httpServer: ReturnType<typeof serve>;
let autumn: Autumn;

beforeAll(() => {
  const { app, store } = createServer(autumnPlugin, {
    port: PORT,
    baseUrl: BASE,
    manifest,
    fallbackUser: { login: "am_emulate_admin", id: 1, scopes: [] },
  });
  seedFromConfig(store, BASE, {
    customers: [{ id: "org_paid", subscriptions: [{ plan_id: "pro", status: "active" }] }],
  });
  httpServer = serve({ fetch: app.fetch, port: PORT });
  autumn = new Autumn({ secretKey: "am_test_emulate", serverURL: BASE });
});

afterAll(async () => {
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
});

describe("autumn emulator with the real autumn-js SDK", () => {
  it("get_or_create creates a fresh customer with no subscriptions", async () => {
    const customer = await autumn.customers.getOrCreate({ customerId: "org_fresh" });
    expect(customer.id).toBe("org_fresh");
    expect(customer.subscriptions ?? []).toHaveLength(0);
  });

  it("get_or_create returns the seeded paid subscription", async () => {
    const customer = await autumn.customers.getOrCreate({ customerId: "org_paid" });
    expect(customer.subscriptions?.map((s) => s.planId ?? (s as { plan_id?: string }).plan_id)).toContain("pro");
  });

  it("tracks usage events", async () => {
    await autumn.track({ customerId: "org_fresh", featureId: "executions", value: 1 });
  });
});
