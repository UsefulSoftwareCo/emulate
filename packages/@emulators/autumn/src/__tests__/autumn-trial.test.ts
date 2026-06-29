import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, serve } from "@emulators/core";
import { Autumn } from "autumn-js";

import { autumnPlugin, seedFromConfig } from "../index.js";
import { manifest } from "../manifest.js";

// Drives the card-required free-trial checkout flow through the real autumn-js
// SDK (zod-validated responses) plus raw fetch for the hosted checkout page.
// This is the contract the cloud app's billing UI depends on.

const PORT = 41875;
const BASE = `http://localhost:${PORT}`;
const SUCCESS_URL = `${BASE}/back-to-billing`;

let httpServer: ReturnType<typeof serve>;
let autumn: Autumn;

beforeAll(() => {
  const { app, store } = createServer(autumnPlugin, {
    port: PORT,
    baseUrl: BASE,
    manifest,
    fallbackUser: { login: "am_emulate_admin", id: 1, scopes: [] },
  });
  // Mirror the executor plan catalog: a free plan and a card-required Team trial.
  seedFromConfig(store, BASE, {
    plans: [
      { id: "free", name: "Free", auto_enable: true, items: [{ feature_id: "executions", included: 10000 }] },
      {
        id: "team",
        name: "Team",
        price: { amount: 150, interval: "month" },
        free_trial: { duration_length: 14, duration_type: "day", card_required: true },
        items: [{ feature_id: "executions", included: 250000 }],
      },
    ],
  });
  httpServer = serve({ fetch: app.fetch, port: PORT });
  autumn = new Autumn({ secretKey: "am_test_emulate", serverURL: BASE });
});

afterAll(async () => {
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
});

const teamPlan = async (customerId: string) => {
  const { list } = await autumn.plans.list({ customerId });
  const team = list.find((p) => p.id === "team")!;
  const free = list.find((p) => p.id === "free")!;
  return { team, free };
};

describe("autumn emulator: card-required free-trial checkout", () => {
  const CUSTOMER = "org_trial";

  it("a fresh customer is offered the Team trial and sits on free", async () => {
    const { team, free } = await teamPlan(CUSTOMER);
    expect(team.freeTrial, "Team advertises a free trial").not.toBeNull();
    expect(team.customerEligibility?.trialAvailable, "trial is available").toBe(true);
    expect(team.customerEligibility?.attachAction, "not yet on Team").toBe("upgrade");
    expect(team.customerEligibility?.status, "not the current plan").toBeUndefined();
    expect(free.customerEligibility?.status, "free is the current plan").toBe("active");
  });

  it("attach returns a checkout payment URL (card required)", async () => {
    const res = await autumn.billing.attach({ customerId: CUSTOMER, planId: "team", successUrl: SUCCESS_URL });
    expect(res.paymentUrl, "a checkout URL is returned").toContain("/checkout/");

    // Attaching alone must NOT activate the subscription: the customer is still
    // on free until the checkout completes and the webhook settles.
    const { team } = await teamPlan(CUSTOMER);
    expect(team.customerEligibility?.status, "still not active after attach").toBeUndefined();
  });

  it("completing checkout redirects to success_url but does not yet activate", async () => {
    const { paymentUrl } = await autumn.billing.attach({
      customerId: CUSTOMER,
      planId: "team",
      successUrl: SUCCESS_URL,
    });
    const sessionId = new URL(paymentUrl!).pathname.split("/").pop()!;

    const page = await fetch(paymentUrl!);
    expect(page.status).toBe(200);
    expect(await page.text(), "checkout page names the plan").toContain("Team");

    const completed = await fetch(`${BASE}/checkout/${sessionId}/complete`, {
      method: "POST",
      redirect: "manual",
    });
    expect(completed.status, "completion redirects").toBe(302);
    expect(completed.headers.get("location"), "back to the app").toBe(SUCCESS_URL);

    // The webhook has not landed yet: the customer is STILL on free. This is the
    // exact window in which the billing UI shows the stale plan.
    const customer = await autumn.customers.getOrCreate({ customerId: CUSTOMER });
    expect(customer.subscriptions ?? [], "no active subscription before settle").toHaveLength(0);
  });

  it("settling the checkout activates the Team trial", async () => {
    const res = await fetch(`${BASE}/checkout/settle`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ customer_id: CUSTOMER }),
    });
    expect(res.ok).toBe(true);

    const { team, free } = await teamPlan(CUSTOMER);
    expect(team.customerEligibility?.status, "Team is now the active plan").toBe("active");
    expect(team.customerEligibility?.trialing, "on a trial").toBe(true);
    expect(team.customerEligibility?.attachAction, "nothing to attach").toBe("none");
    expect(free.customerEligibility?.attachAction, "free is now a downgrade").toBe("downgrade");

    const customer = await autumn.customers.getOrCreate({ customerId: CUSTOMER });
    const sub = (customer.subscriptions ?? []).find((s) => s.planId === "team");
    expect(sub, "customer carries the Team subscription").toBeTruthy();
    expect(sub?.status).toBe("trialing");
  });
});
