import { describe, it, expect } from "vitest";
import { Store } from "@emulators/core";

import { getAutumnStore, seedFromConfig } from "../index.js";
import { balanceForFeature, checkAndConsume, compactUsage } from "../serialize.js";

const DAY_MS = 86_400_000;
const BASE = "http://localhost:0";

// Usage events are rolled up so storage and balance reads stay bounded. Every
// balance Autumn can report must be the same before and after a rollup.
function setup() {
  const store = new Store();
  seedFromConfig(store, BASE, {
    plans: [
      { id: "daily", name: "Daily", items: [{ feature_id: "executions", included: 1000, reset: { interval: "day" } }] },
      { id: "flat", name: "Flat", items: [{ feature_id: "executions", included: 1000 }] },
    ],
    customers: [
      { id: "org_window", subscriptions: [{ plan_id: "daily", status: "active" }] },
      { id: "org_watermark", subscriptions: [{ plan_id: "flat", status: "active" }] },
    ],
  });
  return getAutumnStore(store);
}

function track(as: ReturnType<typeof setup>, customerId: string, count: number, at?: number) {
  for (let i = 0; i < count; i++) {
    const event = as.events.insert({ customer_id: customerId, feature_id: "executions", value: 1 });
    if (at !== undefined) as.events.update(event.id, { created_at: new Date(at).toISOString() });
  }
}

function customer(as: ReturnType<typeof setup>, id: string) {
  return as.customers.findOneBy("customer_id", id)!;
}

describe("autumn usage rollup", () => {
  it("keeps the current reset window's usage when older usage is rolled up", () => {
    const as = setup();
    const now = Date.now();
    const current = customer(as, "org_window");
    // The subscription started 36 hours ago, so its current daily window began 12 hours ago.
    as.customers.update(current.id, {
      subscriptions: current.subscriptions.map((sub) => ({ ...sub, started_at: now - 1.5 * DAY_MS, usage_epoch: 0 })),
    });
    track(as, "org_window", 50, now - DAY_MS);
    track(as, "org_window", 70, now - 60 * 60 * 1000);
    const before = balanceForFeature(as, customer(as, "org_window"), "executions");
    expect(before?.usage).toBe(70);

    compactUsage(as, customer(as, "org_window"), "executions");

    expect(as.events.findBy("customer_id", "org_window")).toHaveLength(2);
    expect(balanceForFeature(as, customer(as, "org_window"), "executions")).toEqual(before);
  });

  it("keeps usage after a subscription's watermark separate from usage before it", () => {
    const as = setup();
    track(as, "org_watermark", 40);
    const watermark = Math.max(...as.events.findBy("customer_id", "org_watermark").map((event) => event.id));
    const current = customer(as, "org_watermark");
    as.customers.update(current.id, {
      subscriptions: current.subscriptions.map((sub) => ({ ...sub, usage_epoch: watermark })),
    });
    track(as, "org_watermark", 60);
    const before = balanceForFeature(as, customer(as, "org_watermark"), "executions");
    expect(before?.usage).toBe(60);

    compactUsage(as, customer(as, "org_watermark"), "executions");

    expect(as.events.findBy("customer_id", "org_watermark")).toHaveLength(2);
    expect(balanceForFeature(as, customer(as, "org_watermark"), "executions")).toEqual(before);
  });

  it("leaves a small history untouched", () => {
    const as = setup();
    track(as, "org_watermark", 10);
    compactUsage(as, customer(as, "org_watermark"), "executions");
    expect(as.events.findBy("customer_id", "org_watermark")).toHaveLength(10);
  });

  it("keeps enforcing the limit while consumption is rolled up", () => {
    const as = setup();
    const current = customer(as, "org_watermark");
    for (let i = 0; i < 1000; i++) {
      expect(checkAndConsume(as, customer(as, "org_watermark"), "executions", 1, true).allowed).toBe(true);
    }
    const denied = checkAndConsume(as, current, "executions", 1, true);
    expect(denied.allowed).toBe(false);
    expect(denied.balance).toMatchObject({ usage: 1000, remaining: 0 });
    expect(as.events.findBy("customer_id", "org_watermark").length).toBeLessThanOrEqual(65);
  });
});
