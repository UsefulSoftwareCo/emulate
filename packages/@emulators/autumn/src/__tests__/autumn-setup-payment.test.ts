import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, serve } from "@emulators/core";
import { Autumn } from "autumn-js";

import { autumnPlugin, seedFromConfig } from "../index.js";
import { manifest } from "../manifest.js";

// Drives "change the billing card" end to end through the real autumn-js SDK:
// billing.setup_payment opens a hosted setup page, submitting it captures a
// card and redirects back, and the customer's default payment method only
// changes once the Stripe webhook settles.

const PORT = 41885;
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
  seedFromConfig(store, BASE, {
    plans: [
      { id: "free", name: "Free", auto_enable: true, items: [{ feature_id: "executions", included: 10000 }] },
      {
        id: "team",
        name: "Team",
        price: { amount: 150, interval: "month" },
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

// The SDK types the expanded field as `any`, so read it through a narrow shape.
interface Card {
  id: string;
  type: string;
  card: { brand: string; last4: string; exp_month: number; exp_year: number };
}

const cardOnFile = async (customerId: string): Promise<Card | null> => {
  const customer = await autumn.customers.getOrCreate({ customerId, expand: ["payment_method"] });
  return (customer.paymentMethod ?? null) as Card | null;
};

describe("autumn emulator: setup_payment (change the card on file)", () => {
  const CUSTOMER = "org_setup";

  it("setup_payment returns a hosted setup URL", async () => {
    const res = await autumn.billing.setupPayment({ customerId: CUSTOMER, successUrl: SUCCESS_URL });
    expect(res.customerId).toBe(CUSTOMER);
    expect(res.url, "a hosted setup URL is returned").toContain("/checkout/setup/");

    // A fresh customer has no card on file yet.
    expect(await cardOnFile(CUSTOMER), "no card before setup").toBeNull();
  });

  it("the hosted setup page renders a save-card form", async () => {
    const { url } = await autumn.billing.setupPayment({ customerId: CUSTOMER, successUrl: SUCCESS_URL });
    const page = await fetch(url);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html, "the form offers to save the card").toContain("Save card");
    expect(html, "the page is the payment method update page").toContain("Update payment method");
  });

  it("submitting the card redirects to success_url but does not yet replace the card", async () => {
    const { url } = await autumn.billing.setupPayment({ customerId: CUSTOMER, successUrl: SUCCESS_URL });
    const sessionId = new URL(url).pathname.split("/").pop()!;

    const completed = await fetch(`${BASE}/checkout/setup/${sessionId}/complete`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "card_number=5555 5555 5555 4444&exp=11/31",
      redirect: "manual",
    });
    expect(completed.status, "completion redirects").toBe(302);
    expect(completed.headers.get("location"), "back to the app").toBe(SUCCESS_URL);

    // The webhook has not landed: the customer still has the OLD card (none).
    expect(await cardOnFile(CUSTOMER), "card unchanged before settle").toBeNull();

    const settled = await fetch(`${BASE}/checkout/setup/${sessionId}/settle`, { method: "POST" });
    expect(settled.ok).toBe(true);
    expect(await settled.json()).toEqual({ settled: 1 });

    const card = await cardOnFile(CUSTOMER);
    expect(card?.type).toBe("card");
    expect(card?.id, "a Stripe-style payment method id").toMatch(/^pm_emulate_/);
    expect(card?.card).toMatchObject({ brand: "mastercard", last4: "4444", exp_month: 11, exp_year: 2031 });
  });

  it("settling an unknown setup session 404s", async () => {
    const res = await fetch(`${BASE}/checkout/setup/seti_emulate_nope/settle`, { method: "POST" });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: "not_found" });
  });

  it("get_or_create omits payment_method when expand does not ask for it", async () => {
    const customer = (await autumn.customers.getOrCreate({ customerId: CUSTOMER })) as Record<string, unknown>;
    expect("paymentMethod" in customer, "field is absent without expand").toBe(false);
  });

  it("paying for a plan leaves a visa on file", async () => {
    const PAYING = "org_pays";
    const attach = await autumn.billing.attach({ customerId: PAYING, planId: "team", successUrl: SUCCESS_URL });
    const sessionId = new URL(attach.paymentUrl!).pathname.split("/").pop()!;
    await fetch(`${BASE}/checkout/${sessionId}/complete`, { method: "POST", redirect: "manual" });
    await fetch(`${BASE}/checkout/settle`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ customer_id: PAYING }),
    });

    const card = await cardOnFile(PAYING);
    expect(card?.card).toMatchObject({ brand: "visa", last4: "4242", exp_month: 12, exp_year: 2030 });
  });
});
