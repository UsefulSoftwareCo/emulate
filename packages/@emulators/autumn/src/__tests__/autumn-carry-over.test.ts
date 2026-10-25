import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, serve } from "@emulators/core";

import { autumnPlugin, seedFromConfig } from "../index.js";
import { manifest } from "../manifest.js";

// Moving a paid customer between two catalogs in one Autumn account, as the
// real sandbox does it: rename the customer, then attach the new catalog's plan
// with `remove_plan_ids` and `proration_behavior: "none"`, which takes over the
// old plan's Stripe subscription. Raw fetch, since these routes postdate the
// pinned SDK.

const PORT = 41941;
const BASE = `http://localhost:${PORT}`;
const PERIOD_END = Date.UTC(2030, 0, 15);
const TRIAL_END = Date.UTC(2030, 0, 8);

let httpServer: ReturnType<typeof serve>;

const post = async (path: string, body: unknown) => {
  const response = await fetch(`${BASE}/v1/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer am_sk_test_emulate" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as any };
};

const seatsItem = {
  feature_id: "members",
  included: 0,
  price: { amount: 15, interval: "month", billing_units: 1, billing_method: "usage_based" },
};
const flatTeam = {
  price: { amount: 49, interval: "month" },
  items: [
    {
      feature_id: "executions",
      included: 250000,
      price: { amount: 0.2, interval: "month", billing_units: 1000, billing_method: "usage_based" },
    },
  ],
};
const carry = (customerId: string, extra: Record<string, unknown> = {}) => ({
  customer_id: customerId,
  plan_id: "next-team",
  remove_plan_ids: ["team"],
  proration_behavior: "none",
  redirect_mode: "never",
  ...extra,
});
const subscribed = (sub: Record<string, unknown>) => ({
  plan_id: "team",
  status: "active",
  current_period_start: PERIOD_END - 30 * 86_400_000,
  current_period_end: PERIOD_END,
  ...sub,
});

beforeAll(() => {
  const { app, store } = createServer(autumnPlugin, {
    port: PORT,
    baseUrl: BASE,
    manifest,
    fallbackUser: { login: "am_emulate_admin", id: 1, scopes: [] },
  });
  seedFromConfig(store, BASE, {
    plans: [
      { id: "free", name: "Free", auto_enable: true, items: [{ feature_id: "executions", included: 10000 }] },
      // v3 bills per member; v1 was a flat price with metered executions.
      { id: "team", name: "Team", version: 3, items: [seatsItem], versions: [{ version: 1, ...flatTeam }] },
      { id: "next-free", name: "Next Free", group: "next", items: [{ feature_id: "next-members", included: 3 }] },
      {
        id: "next-team",
        name: "Next Team",
        group: "next",
        free_trial: { duration_length: 14, duration_type: "day", card_required: true },
        items: [{ ...seatsItem, feature_id: "next-members" }],
      },
    ],
    customers: [
      { id: "org_seats", subscriptions: [subscribed({})] },
      { id: "org_flat", subscriptions: [subscribed({ version: 1 })] },
      {
        id: "org_trial",
        subscriptions: [subscribed({ status: "trialing", trial_ends_at: TRIAL_END, current_period_end: TRIAL_END })],
      },
      {
        id: "org_cancelled",
        subscriptions: [
          subscribed({ canceled_at: PERIOD_END - 86_400_000, expires_at: PERIOD_END }),
          { plan_id: "free", status: "scheduled" },
        ],
      },
      { id: "org_taken", subscriptions: [{ plan_id: "free", status: "active" }] },
    ],
  });
  httpServer = serve({ fetch: app.fetch, port: PORT });
});

afterAll(async () => {
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
});

describe("autumn emulator: carrying a subscription over to another catalog", () => {
  it("expands each subscription's plan at the version it bills, with a Stripe subscription", async () => {
    const flat = await post("customers.get", { customer_id: "org_flat", expand: ["subscriptions.plan"] });
    const [sub] = flat.body.subscriptions;
    expect(sub.plan).toMatchObject({ id: "team", version: 1, price: { amount: 49, interval: "month" } });
    expect(sub.plan.items[0]).toMatchObject({ feature_id: "executions", price: { billing_method: "usage_based" } });
    const seats = await post("customers.get", { customer_id: "org_seats" });
    expect(seats.body.subscriptions[0].plan).toBeUndefined();
    const verified = await post("billing.verify", { customer_id: "org_seats" });
    expect(verified.body.subscriptions).toEqual([
      { stripe_subscription_id: "sub_emulate_stripe_org_seats_team", status: "correct", mismatches: [] },
    ]);
  });

  it("renames a customer, keeping its subscription and usage, and refuses an id that is taken", async () => {
    await post("balances.update", { customer_id: "org_seats", feature_id: "members", usage: 4 });
    const renamed = await post("customers.update", { customer_id: "org_seats", new_customer_id: "next:org_seats" });
    expect(renamed.status).toBe(200);
    expect(renamed.body.id).toBe("next:org_seats");
    expect((await post("customers.get", { customer_id: "org_seats" })).status).toBe(404);
    const moved = await post("customers.get", { customer_id: "next:org_seats" });
    expect(moved.body.subscriptions[0].plan_id).toBe("team");
    expect(moved.body.balances.members.usage).toBe(4);
    const taken = await post("customers.update", { customer_id: "next:org_seats", new_customer_id: "org_taken" });
    expect(taken.status).toBe(409);
    expect(taken.body.code).toBe("customer_already_exists");
  });

  it("previews and attaches onto the same Stripe subscription with no charge and the same renewal", async () => {
    const preview = await post("billing.preview_attach", carry("next:org_seats", { customize: { free_trial: null } }));
    expect(preview.body).toMatchObject({
      total: 0,
      redirect_to_checkout: false,
      next_cycle: { starts_at: PERIOD_END },
      incoming: [{ plan_id: "next-team" }],
      outgoing: [{ plan_id: "team" }],
    });
    const attached = await post("billing.attach", carry("next:org_seats", { customize: { free_trial: null } }));
    expect(attached.body).toEqual({ customer_id: "next:org_seats", payment_url: null });
    const after = await post("customers.get", { customer_id: "next:org_seats" });
    expect(after.body.subscriptions).toMatchObject([
      { plan_id: "next-team", status: "active", current_period_end: PERIOD_END, trial_ends_at: null },
    ]);
    const verified = await post("billing.verify", { customer_id: "next:org_seats" });
    expect(verified.body.subscriptions.map((s: any) => s.stripe_subscription_id)).toEqual([
      "sub_emulate_stripe_org_seats_team",
    ]);
    // A second attach finds nothing to remove.
    const again = await post("billing.attach", carry("next:org_seats", { customize: { free_trial: null } }));
    expect(again.status).toBe(409);
  });

  it("keeps a flat price through customize and attaches an earlier version back", async () => {
    const custom = {
      price: { amount: 49, interval: "month" },
      items: [{ feature_id: "next-members", unlimited: true }],
      free_trial: null,
    };
    const preview = await post("billing.preview_attach", carry("org_flat", { customize: custom }));
    expect(preview.body.next_cycle).toMatchObject({ starts_at: PERIOD_END, total: 49 });
    await post("billing.attach", carry("org_flat", { customize: custom }));
    const after = await post("customers.get", { customer_id: "org_flat", expand: ["subscriptions.plan"] });
    expect(after.body.subscriptions[0].plan).toMatchObject({ id: "next-team", price: { amount: 49 } });
    expect(after.body.balances["next-members"].unlimited).toBe(true);
    const back = await post("billing.attach", {
      customer_id: "org_flat",
      plan_id: "team",
      version: 1,
      remove_plan_ids: ["next-team"],
      proration_behavior: "none",
      redirect_mode: "never",
      customize: { free_trial: null },
    });
    expect(back.status).toBe(200);
    const restored = await post("customers.get", { customer_id: "org_flat", expand: ["subscriptions.plan"] });
    expect(restored.body.subscriptions[0].plan).toMatchObject({ id: "team", version: 1, price: { amount: 49 } });
  });

  it("keeps a running trial, and refuses to remove it without proration", async () => {
    const refused = await post("billing.preview_attach", carry("org_trial", { customize: { free_trial: null } }));
    expect(refused.status).toBe(400);
    expect(refused.body.message).toBe("Cannot set proration_behavior to 'none' when removing a free trial");
    await post("billing.attach", carry("org_trial"));
    const after = await post("customers.get", { customer_id: "org_trial" });
    expect(after.body.subscriptions[0]).toMatchObject({ plan_id: "next-team", trial_ends_at: TRIAL_END });
  });

  it("drops a cancellation at the end of the cycle and keeps the plan scheduled after it", async () => {
    await post("billing.attach", carry("org_cancelled", { customize: { free_trial: null } }));
    const after = await post("customers.get", { customer_id: "org_cancelled" });
    expect(after.body.subscriptions).toMatchObject([
      { plan_id: "free", status: "scheduled" },
      { plan_id: "next-team", canceled_at: null, expires_at: null },
    ]);
  });

  it("refuses to remove a plan the customer does not have, and deletes a customer", async () => {
    const missing = await post("billing.attach", carry("org_taken"));
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe("product_not_found");
    expect((await post("customers.delete", { customer_id: "org_taken" })).body).toEqual({ success: true });
    expect((await post("customers.delete", { customer_id: "org_taken" })).status).toBe(404);
  });
});
