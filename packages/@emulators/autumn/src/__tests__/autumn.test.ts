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
    plans: [
      { id: "pro", name: "Pro", items: [{ feature_id: "executions", included: 1000 }] },
      { id: "starter", name: "Starter", items: [{ feature_id: "executions", included: 2 }] },
      {
        id: "scale",
        name: "Scale",
        items: [
          { feature_id: "executions", included: 1000 },
          { feature_id: "members", unlimited: true },
        ],
      },
    ],
    customers: [
      { id: "org_paid", subscriptions: [{ plan_id: "pro", status: "active" }] },
      { id: "org_capped", subscriptions: [{ plan_id: "starter", status: "active" }] },
      { id: "org_seats", subscriptions: [{ plan_id: "scale", status: "active" }] },
    ],
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

  it("check allows a feature with remaining balance", async () => {
    const check = await autumn.check({ customerId: "org_paid", featureId: "executions" });
    expect(check.allowed).toBe(true);
    expect(check.customerId).toBe("org_paid");
    expect(check.balance?.remaining).toBe(1000);
    expect(check.balance?.unlimited).toBe(false);
  });

  it("check denies an exhausted feature with no overage", async () => {
    // starter includes 2 executions; burn them both through balances.track.
    await autumn.track({ customerId: "org_capped", featureId: "executions", value: 2 });
    const check = await autumn.check({ customerId: "org_capped", featureId: "executions" });
    expect(check.allowed).toBe(false);
    expect(check.balance?.remaining).toBe(0);
    expect(check.balance?.usage).toBe(2);
    expect(check.balance?.overageAllowed).toBe(false);
  });

  it("check allows a feature the customer's plan does not carry", async () => {
    const check = await autumn.check({ customerId: "org_paid", featureId: "not-a-feature" });
    expect(check.allowed).toBe(true);
    expect(check.balance).toBeNull();
  });

  it("an armed fault on balances.check returns the injected 500 and marks the ledger entry", async () => {
    const armRes = await fetch(`${BASE}/_emulate/faults`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        match: { operationId: "balances.check" },
        response: { status: 500, body: { message: "injected failure" } },
      }),
    });
    expect(armRes.status).toBe(200);
    const { fault } = (await armRes.json()) as { fault: { id: string } };

    const faulted = await fetch(`${BASE}/v1/balances.check`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer am_test_emulate" },
      body: JSON.stringify({ customer_id: "org_paid", feature_id: "executions" }),
    });
    expect(faulted.status).toBe(500);
    expect(await faulted.json()).toEqual({ message: "injected failure" });

    const ledger = (await (await fetch(`${BASE}/_emulate/ledger`)).json()) as {
      entries: Array<{ path: string; faulted?: boolean; faultId?: string; response: { status: number } }>;
    };
    const entry = ledger.entries.find((e) => e.path === "/v1/balances.check" && e.faulted);
    expect(entry).toMatchObject({ faulted: true, faultId: fault.id, response: { status: 500 } });

    // The fault was one-shot; the next check goes through normally.
    const check = await autumn.check({ customerId: "org_paid", featureId: "executions" });
    expect(check.allowed).toBe(true);
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

// balances.update: reconciliation for continuous-use features (seats,
// storage). The update lands as an adjustment event, so every read path
// (get_or_create, check, events.list) reflects it from the same state.
describe("balances.update", () => {
  const rawUpdate = (body: Record<string, unknown>) =>
    fetch(`${BASE}/v1/balances.update`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer am_test_emulate" },
      body: JSON.stringify(body),
    });

  it("sets absolute usage for a metered feature", async () => {
    const res = await autumn.balances.update({ customerId: "org_paid", featureId: "executions", usage: 400 });
    expect(res.success).toBe(true);
    const customer = await autumn.customers.getOrCreate({ customerId: "org_paid" });
    expect(customer.balances?.executions?.usage).toBe(400);
    expect(customer.balances?.executions?.remaining).toBe(600);
  });

  it("reconciles usage downward as well as upward", async () => {
    await autumn.balances.update({ customerId: "org_paid", featureId: "executions", usage: 100 });
    const customer = await autumn.customers.getOrCreate({ customerId: "org_paid" });
    expect(customer.balances?.executions?.usage).toBe(100);
    expect(customer.balances?.executions?.remaining).toBe(900);
  });

  it("sets usage on an unlimited balance for visibility", async () => {
    const res = await autumn.balances.update({ customerId: "org_seats", featureId: "members", usage: 12 });
    expect(res.success).toBe(true);
    const customer = await autumn.customers.getOrCreate({ customerId: "org_seats" });
    expect(customer.balances?.members?.usage).toBe(12);
    expect(customer.balances?.members?.unlimited).toBe(true);
  });

  it("records the reconciliation as an adjustment event", async () => {
    const events = (await (
      await fetch(`${BASE}/v1/events.list`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer am_test_emulate" },
        body: JSON.stringify({}),
      })
    ).json()) as { list: Array<{ customer_id: string; feature_id: string; value: number }> };
    const seatEvents = events.list.filter((e) => e.customer_id === "org_seats" && e.feature_id === "members");
    expect(seatEvents.map((e) => e.value)).toEqual([12]);
  });

  it("add_to_balance credits balance back", async () => {
    // org_capped burned its 2 included executions earlier in this suite.
    await autumn.balances.update({ customerId: "org_capped", featureId: "executions", addToBalance: 1 });
    const check = await autumn.check({ customerId: "org_capped", featureId: "executions" });
    expect(check.allowed).toBe(true);
    expect(check.balance?.usage).toBe(1);
    expect(check.balance?.remaining).toBe(1);
  });

  it("remaining sets usage relative to the grant", async () => {
    await autumn.balances.update({ customerId: "org_capped", featureId: "executions", remaining: 2 });
    const customer = await autumn.customers.getOrCreate({ customerId: "org_capped" });
    expect(customer.balances?.executions?.usage).toBe(0);
    expect(customer.balances?.executions?.remaining).toBe(2);
  });

  it("rejects remaining on an unlimited balance", async () => {
    const res = await rawUpdate({ customer_id: "org_seats", feature_id: "members", remaining: 5 });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("invalid_request");
  });

  it("requires exactly one of usage, remaining, add_to_balance", async () => {
    const none = await rawUpdate({ customer_id: "org_paid", feature_id: "executions" });
    expect(none.status).toBe(400);
    const two = await rawUpdate({ customer_id: "org_paid", feature_id: "executions", usage: 1, remaining: 1 });
    expect(two.status).toBe(400);
  });

  it("404s with customer_not_found for an unknown customer", async () => {
    const res = await rawUpdate({ customer_id: "org_never_seen", feature_id: "executions", usage: 1 });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: string }).code).toBe("customer_not_found");
  });

  it("404s when the customer's plan has no balance for the feature", async () => {
    const res = await rawUpdate({ customer_id: "org_paid", feature_id: "members", usage: 1 });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: string }).code).toBe("not_found");
  });
});
