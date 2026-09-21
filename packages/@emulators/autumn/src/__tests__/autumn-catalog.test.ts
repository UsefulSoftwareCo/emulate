import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, serve } from "@emulators/core";
import { Autumn } from "autumn-js";

import { autumnPlugin, seedFromConfig } from "../index.js";
import { manifest } from "../manifest.js";

// A provisioned catalog driven the way a real application drives it: features
// and plans seeded by id, a new customer started on a named plan, execution
// units consumed atomically, and a subscription cancelled through
// `billing.update`.
//
// Every expectation here was taken from the real Autumn sandbox API at
// `x-api-version: 2.3.0`, not from the docs. The catalog mirrors the one an
// application provisions through Autumn's own API: a free plan with a metered
// executions feature and a non-consumable members feature, and a paid team
// plan with unlimited executions and a per-seat usage price.

const PORT = 41881;
const BASE = `http://localhost:${PORT}`;
const NS = "app-stage";
const FREE = `${NS}-free`;
const TEAM = `${NS}-team`;
const TINY = `${NS}-tiny`;
const EXECUTIONS = `${NS}-executions`;
const MEMBERS = `${NS}-members`;
/** The tiny plan's whole allowance, small enough to exhaust from a test. */
const TINY_INCLUDED = 50;

let httpServer: ReturnType<typeof serve>;
let autumn: Autumn;

const post = (path: string, body: unknown) =>
  fetch(`${BASE}/v1/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer am_test_emulate" },
    body: JSON.stringify(body),
  });

const json = async <T>(res: Response) => (await res.json()) as T;

interface Balance {
  feature_id: string;
  usage: number;
  remaining: number;
  unlimited: boolean;
  granted: number;
  overage_allowed: boolean;
  next_reset_at: number | null;
  breakdown: Array<{ plan_id: string; included_grant: number; remaining: number }>;
}
interface Customer {
  id: string;
  balances: Record<string, Balance>;
  subscriptions: Array<{ plan_id: string; status: string; canceled_at: number | null; expires_at: number | null }>;
}
interface Check {
  allowed: boolean;
  customer_id: string;
  required_balance: number;
  balance: Balance | null;
}

const customer = async (customerId: string, autoEnablePlanId?: string) =>
  json<Customer>(
    await post("customers.get_or_create", {
      customer_id: customerId,
      ...(autoEnablePlanId === undefined ? {} : { auto_enable_plan_id: autoEnablePlanId }),
    }),
  );

const check = (customerId: string, featureId: string, requiredBalance: number, sendEvent: boolean) =>
  post("balances.check", {
    customer_id: customerId,
    feature_id: featureId,
    required_balance: requiredBalance,
    send_event: sendEvent,
  });

beforeAll(() => {
  const { app, store } = createServer(autumnPlugin, {
    port: PORT,
    baseUrl: BASE,
    manifest,
    fallbackUser: { login: "am_emulate_admin", id: 1, scopes: [] },
  });
  seedFromConfig(store, BASE, {
    features: [
      { id: EXECUTIONS, name: "Executions", type: "metered", consumable: true },
      { id: MEMBERS, name: "Members", type: "metered", consumable: false },
    ],
    plans: [
      {
        id: FREE,
        name: "Free",
        group: NS,
        items: [
          { feature_id: MEMBERS, included: 3, unlimited: false },
          { feature_id: EXECUTIONS, included: 100_000, unlimited: false, reset: { interval: "month" } },
        ],
      },
      {
        id: TEAM,
        name: "Team",
        group: NS,
        free_trial: { duration_length: 14, duration_type: "day", card_required: true },
        items: [
          {
            feature_id: MEMBERS,
            included: 0,
            unlimited: false,
            price: { amount: 15, billing_units: 1, billing_method: "usage_based", interval: "month" },
          },
          { feature_id: EXECUTIONS, included: 0, unlimited: true, reset: { interval: "month" } },
        ],
      },
      {
        id: TINY,
        name: "Tiny",
        group: `${NS}-tiny-group`,
        items: [{ feature_id: EXECUTIONS, included: TINY_INCLUDED, unlimited: false, reset: { interval: "month" } }],
      },
    ],
  });
  httpServer = serve({ fetch: app.fetch, port: PORT });
  autumn = new Autumn({ secretKey: "am_test_emulate", serverURL: BASE });
});

afterAll(async () => {
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
});

describe("customers.get_or_create honours auto_enable_plan_id", () => {
  it("starts a new customer on the named plan with its balances granted", async () => {
    const value = await customer("org_new", FREE);
    expect(value.subscriptions.map((s) => s.plan_id)).toEqual([FREE]);
    expect(value.subscriptions[0]?.status).toBe("active");

    const executions = value.balances[EXECUTIONS];
    expect(executions).toMatchObject({
      feature_id: EXECUTIONS,
      granted: 100_000,
      remaining: 100_000,
      usage: 0,
      unlimited: false,
      overage_allowed: false,
    });
    // A metered item with a reset interval reports when it refills.
    expect(executions?.next_reset_at).toBeGreaterThan(Date.now());
    expect(executions?.breakdown).toEqual([
      expect.objectContaining({ plan_id: FREE, included_grant: 100_000, remaining: 100_000 }),
    ]);

    // A non-consumable seat feature has a grant with no reset.
    expect(value.balances[MEMBERS]).toMatchObject({ granted: 3, remaining: 3, usage: 0, unlimited: false });
    expect(value.balances[MEMBERS]?.next_reset_at).toBeNull();
  });

  it("is idempotent: a second call does not re-subscribe or reset usage", async () => {
    await check("org_new", EXECUTIONS, 10, true);
    const again = await customer("org_new", FREE);
    expect(again.subscriptions).toHaveLength(1);
    expect(again.balances[EXECUTIONS]?.usage, "usage survives the second get_or_create").toBe(10);
  });

  it("never re-subscribes an existing customer to a different plan", async () => {
    const value = await customer("org_new", TEAM);
    expect(value.subscriptions.map((s) => s.plan_id)).toEqual([FREE]);
  });

  it("404s with product_not_found for a plan the catalog does not have", async () => {
    const res = await post("customers.get_or_create", {
      customer_id: "org_unknown_plan",
      auto_enable_plan_id: "no-such-plan",
    });
    expect(res.status).toBe(404);
    expect(await json<{ code: string }>(res)).toMatchObject({ code: "product_not_found" });
  });

  it("grants an unlimited balance without a numeric remaining", async () => {
    const value = await customer("org_unlimited", TEAM);
    expect(value.balances[EXECUTIONS]).toMatchObject({ unlimited: true, granted: 0, remaining: 0 });
    // The per-seat item is priced, so seats above the included count bill as overage.
    expect(value.balances[MEMBERS]).toMatchObject({ granted: 0, overage_allowed: true });
  });

  it("decodes through the real autumn-js SDK", async () => {
    const value = await autumn.customers.getOrCreate({ customerId: "org_sdk", autoEnablePlanId: FREE });
    expect(value.subscriptions?.map((s) => s.planId)).toEqual([FREE]);
    expect(value.balances?.[EXECUTIONS]?.remaining).toBe(100_000);
  });
});

describe("balances.check consumes atomically with send_event", () => {
  it("deducts exactly required_balance and reports the balance after the deduction", async () => {
    await customer("org_consume", FREE);
    const first = await json<Check>(await check("org_consume", EXECUTIONS, 1, true));
    expect(first.allowed).toBe(true);
    expect(first.balance).toMatchObject({ feature_id: EXECUTIONS, usage: 1, remaining: 99_999 });

    const ten = await json<Check>(await check("org_consume", EXECUTIONS, 10, true));
    expect(ten.balance).toMatchObject({ usage: 11, remaining: 99_989 });
  });

  it("does not consume when send_event is absent", async () => {
    const before = await json<Check>(await check("org_consume", EXECUTIONS, 1, false));
    const after = await json<Check>(await check("org_consume", EXECUTIONS, 1, false));
    expect(after.balance?.usage).toBe(before.balance?.usage);
  });

  it("denies without consuming when the balance is insufficient", async () => {
    await customer("org_short", TINY);
    await check("org_short", EXECUTIONS, TINY_INCLUDED - 1, true);

    const denied = await json<Check>(await check("org_short", EXECUTIONS, 5, true));
    expect(denied.allowed, "5 units are not available").toBe(false);
    expect(denied.balance?.usage, "a denied check costs nothing").toBe(TINY_INCLUDED - 1);
    expect(denied.balance?.remaining).toBe(1);

    // The last unit is still there for a caller that asks for one.
    const allowed = await json<Check>(await check("org_short", EXECUTIONS, 1, true));
    expect(allowed.allowed).toBe(true);
    expect(allowed.balance?.remaining).toBe(0);
  });

  // The invariant that makes the emulator usable as a metering backend: a
  // burst of concurrent admissions must spend the allowance exactly once. If
  // the check ever stopped being a single synchronous read-decide-write, two
  // callers would both observe the same remaining balance and overspend it.
  it("never overspends under concurrent checks", async () => {
    await customer("org_race", TINY);
    const attempts = TINY_INCLUDED * 4;
    const results = await Promise.all(
      Array.from({ length: attempts }, () => check("org_race", EXECUTIONS, 1, true).then(json<Check>)),
    );

    const allowed = results.filter((r) => r.allowed).length;
    expect(allowed, "exactly the included allowance is admitted").toBe(TINY_INCLUDED);

    const after = await customer("org_race", TINY);
    expect(after.balances[EXECUTIONS]?.usage, "usage matches the admissions").toBe(TINY_INCLUDED);
    expect(after.balances[EXECUTIONS]?.remaining).toBe(0);
  });

  it("denies a catalog feature no active subscription grants, with a null balance", async () => {
    const res = await json<Check>(await check("org_race", MEMBERS, 1, false));
    expect(res.allowed).toBe(false);
    expect(res.balance).toBeNull();
  });

  it("404s for a feature the catalog does not declare", async () => {
    const res = await check("org_race", "nonsense-feature", 1, false);
    expect(res.status).toBe(404);
    expect(await json<{ code: string }>(res)).toMatchObject({ code: "feature_not_found" });
  });
});

describe("billing.update cancels a subscription", () => {
  it("cancel_immediately ends the subscription and its balances", async () => {
    await customer("org_cancel", FREE);
    const res = await post("billing.update", {
      customer_id: "org_cancel",
      plan_id: FREE,
      cancel_action: "cancel_immediately",
    });
    expect(res.status).toBe(200);
    expect(await json<Record<string, unknown>>(res)).toEqual({ customer_id: "org_cancel", payment_url: null });

    const after = await customer("org_cancel");
    expect(after.subscriptions, "no subscription remains").toHaveLength(0);
    expect(after.balances, "its grants go with it").toEqual({});
  });

  it("cancels every live subscription when no plan_id is given", async () => {
    await customer("org_cancel_all", FREE);
    const res = await post("billing.update", { customer_id: "org_cancel_all", cancel_action: "cancel_immediately" });
    expect(res.status).toBe(200);
    expect((await customer("org_cancel_all")).subscriptions).toHaveLength(0);
  });

  it("re-attaching after a cancel starts from a fresh grant", async () => {
    await customer("org_recycle", TINY);
    await check("org_recycle", EXECUTIONS, 10, true);
    expect((await customer("org_recycle")).balances[EXECUTIONS]?.usage).toBe(10);

    await post("billing.update", { customer_id: "org_recycle", cancel_action: "cancel_immediately" });
    await post("billing.attach", { customer_id: "org_recycle", plan_id: TINY, success_url: `${BASE}/back` });

    const after = await customer("org_recycle");
    expect(after.subscriptions.map((s) => s.plan_id)).toEqual([TINY]);
    expect(after.balances[EXECUTIONS], "the new grant is not charged the old usage").toMatchObject({
      usage: 0,
      remaining: TINY_INCLUDED,
    });
  });

  it("cancel_end_of_cycle keeps a billed plan active until it expires, and uncancel clears it", async () => {
    await customer("org_cycle", FREE);
    // Settle a Team checkout so the customer holds the billed plan.
    const attach = await json<{ payment_url: string }>(
      await post("billing.attach", { customer_id: "org_cycle", plan_id: TEAM, success_url: `${BASE}/back` }),
    );
    const sessionId = new URL(attach.payment_url).pathname.split("/").pop()!;
    await fetch(`${BASE}/checkout/${sessionId}/complete`, { method: "POST", redirect: "manual" });
    await fetch(`${BASE}/checkout/${sessionId}/settle`, { method: "POST" });

    const res = await post("billing.update", {
      customer_id: "org_cycle",
      plan_id: TEAM,
      cancel_action: "cancel_end_of_cycle",
    });
    expect(res.status).toBe(200);

    const cancelling = (await customer("org_cycle")).subscriptions.find((s) => s.plan_id === TEAM);
    expect(cancelling?.status, "still active until the cycle ends").toBe("trialing");
    expect(cancelling?.canceled_at).toBeGreaterThan(0);
    expect(cancelling?.expires_at).toBeGreaterThan(Date.now());

    const undo = await post("billing.update", {
      customer_id: "org_cycle",
      plan_id: TEAM,
      cancel_action: "uncancel",
    });
    expect(undo.status).toBe(200);
    const restored = (await customer("org_cycle")).subscriptions.find((s) => s.plan_id === TEAM);
    expect(restored?.canceled_at).toBeNull();
    expect(restored?.expires_at).toBeNull();
  });

  it("rejects cancel_end_of_cycle for a plan that bills nothing", async () => {
    await customer("org_free_cycle", FREE);
    const res = await post("billing.update", {
      customer_id: "org_free_cycle",
      plan_id: FREE,
      cancel_action: "cancel_end_of_cycle",
    });
    expect(res.status).toBe(400);
    expect(await json<{ code: string; message: string }>(res)).toMatchObject({ code: "invalid_request" });
  });

  it("404s with cus_product_not_found for a plan the customer does not hold", async () => {
    await customer("org_not_held", FREE);
    const res = await post("billing.update", {
      customer_id: "org_not_held",
      plan_id: TEAM,
      cancel_action: "cancel_immediately",
    });
    expect(res.status).toBe(404);
    expect(await json<{ code: string }>(res)).toMatchObject({ code: "cus_product_not_found" });
  });

  it("400s when no update parameter is given", async () => {
    await customer("org_no_action", FREE);
    const res = await post("billing.update", { customer_id: "org_no_action", plan_id: FREE });
    expect(res.status).toBe(400);
    expect(await json<{ code: string }>(res)).toMatchObject({ code: "invalid_inputs" });
  });

  it("404s for an unknown customer", async () => {
    const res = await post("billing.update", {
      customer_id: "org_never_existed",
      cancel_action: "cancel_immediately",
    });
    expect(res.status).toBe(404);
    expect(await json<{ code: string }>(res)).toMatchObject({ code: "customer_not_found" });
  });
});

describe("the seeded catalog reads back the way the provisioner declared it", () => {
  it("plans.list reports group, items and the per-seat price", async () => {
    await customer("org_catalog", FREE);
    const { list } = await json<{
      list: Array<{
        id: string;
        name: string;
        group: string | null;
        archived: boolean;
        price: { amount: number; interval: string } | null;
        items: Array<{ feature_id: string; included: number; unlimited: boolean; price: { amount: number } | null }>;
        customer_eligibility?: { attach_action: string; status?: string };
      }>;
    }>(await post("plans.list", { customer_id: "org_catalog" }));

    const free = list.find((p) => p.id === FREE)!;
    expect(free).toMatchObject({ name: "Free", group: NS, archived: false, price: null });
    expect(free.items.find((i) => i.feature_id === EXECUTIONS)).toMatchObject({ included: 100_000, unlimited: false });
    expect(free.customer_eligibility).toMatchObject({ status: "active", attach_action: "none" });

    const team = list.find((p) => p.id === TEAM)!;
    expect(team.group).toBe(NS);
    expect(team.items.find((i) => i.feature_id === MEMBERS)?.price).toMatchObject({ amount: 15, interval: "month" });
    expect(team.items.find((i) => i.feature_id === EXECUTIONS)).toMatchObject({ included: 0, unlimited: true });
    expect(team.customer_eligibility?.attach_action, "same group as the held free plan").toBe("upgrade");

    // A plan in another group is neither an upgrade nor a downgrade.
    expect(list.find((p) => p.id === TINY)?.customer_eligibility?.attach_action).toBe("activate");
  });

  it("features.list reports the seeded feature registry", async () => {
    const { list } = await json<{ list: Array<{ id: string; consumable: boolean; type: string }> }>(
      await post("features.list", {}),
    );
    expect(list.map((f) => f.id).sort()).toEqual([EXECUTIONS, MEMBERS].sort());
    expect(list.find((f) => f.id === MEMBERS)).toMatchObject({ consumable: false, type: "metered" });
  });

  it("balances.update reconciles a seat count the way an application syncs members", async () => {
    await customer("org_seats_sync", FREE);
    const res = await post("balances.update", {
      customer_id: "org_seats_sync",
      feature_id: MEMBERS,
      usage: 2,
    });
    expect(await json<{ success: boolean }>(res)).toEqual({ success: true });
    expect((await customer("org_seats_sync")).balances[MEMBERS]).toMatchObject({ usage: 2, remaining: 1 });
  });
});
