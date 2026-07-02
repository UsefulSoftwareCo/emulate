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
    plans: [{ id: "pro", name: "Pro", items: [{ feature_id: "executions", included: 1000 }] }],
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

  // Regression for the autumn-js 0.9.0 emulator regression: autumn-js 1.2.8's
  // `useCustomer` hook drives its backend route, which always calls
  // `customers.getOrCreate` with `expand: ["balances.feature"]` (see
  // node_modules/autumn-js dist/backend/index.js routeConfigs). Its
  // `customerToFeatures` helper then throws
  // "[customerToFeatures] please expand `balances.feature` or `flags.feature`
  // ..." unless every entry in `balances` (and `flags`) carries a nested
  // `feature` object. The emulator must return that shape on every
  // customers.get_or_create response, not just when a client-supplied
  // `expand` happens to ask for it.
  it("get_or_create expands balances.feature for autumn-js's customerToFeatures", async () => {
    const customer = await autumn.customers.getOrCreate({
      customerId: "org_paid",
      expand: ["balances.feature"],
    });

    const balances = Object.values(customer.balances ?? {});
    expect(balances.length).toBeGreaterThan(0);
    for (const balance of balances) {
      expect(balance.feature, `balance ${balance.featureId} is missing an expanded feature`).toBeTruthy();
      expect(balance.feature?.id).toBe(balance.featureId);
    }

    // Mirrors autumn-js's own customerToFeatures check (not part of its public
    // export surface, so replicated here): it throws unless the first
    // balance/flag entry has a `.feature`.
    const customerStates = [...Object.values(customer.balances ?? {}), ...Object.values(customer.flags ?? {})];
    expect(customerStates[0]?.feature, "customerToFeatures would throw on this response").toBeTruthy();
  });
});
