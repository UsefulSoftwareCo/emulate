import { createServer } from "@emulators/core";
import { HTTPClient, Polar } from "@polar-sh/sdk";
import { HTTPValidationError } from "@polar-sh/sdk/models/errors/httpvalidationerror.js";
import { ResourceNotFound } from "@polar-sh/sdk/models/errors/resourcenotfound.js";
import { beforeAll, describe, expect, it } from "vitest";

import { polarPlugin, seedFromConfig } from "../index.js";
import { manifest } from "../manifest.js";

const PORT = 41881;
const BASE = `http://localhost:${PORT}`;

let polar: Polar;
let localFetch: typeof fetch;
let sumMeterId: string;
let maxMeterId: string;
let benefitId: string;
let freeProductId: string;
let paidProductId: string;
let secondPaidProductId: string;
let customerId: string;
let subscriptionId: string;

async function validationError(promise: Promise<unknown>): Promise<HTTPValidationError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(HTTPValidationError);
    return error as HTTPValidationError;
  }
  throw new Error("Expected an HTTPValidationError");
}

beforeAll(() => {
  const { app, store } = createServer(polarPlugin, {
    port: PORT,
    baseUrl: BASE,
    manifest,
    fallbackUser: { login: "polar_oat_emulate", id: 1, scopes: [] },
  });
  seedFromConfig(store, BASE, { checkout: { settle_delay_ms: null } });
  localFetch = (input, init) => app.fetch(new Request(input, init));
  polar = new Polar({
    accessToken: "polar_oat_test",
    serverURL: BASE,
    httpClient: new HTTPClient({ fetcher: localFetch }),
  });
});

describe.sequential("polar emulator with the real @polar-sh/sdk", () => {
  it("requires a bearer token and publishes the operation IDs", async () => {
    const unauthorized = await localFetch(`${BASE}/v1/customers/`);
    expect(unauthorized.status).toBe(401);
    expect(await unauthorized.json()).toMatchObject({ error: "Unauthorized" });

    const openapi = (await (await localFetch(`${BASE}/openapi.json`)).json()) as {
      paths: Record<string, Record<string, { operationId: string }>>;
    };
    expect(openapi.paths["/v1/customers/external/{external_id}/state"]?.get.operationId).toBe(
      "customers:get_state_external",
    );

    await polar.customers.list({});
    const ledger = (await (await localFetch(`${BASE}/_emulate/ledger`)).json()) as {
      entries: Array<{ operationId?: string; identity: { user?: { login: string } } }>;
    };
    expect(ledger.entries.find((entry) => entry.operationId === "customers:list")?.identity.user?.login).toBe(
      "polar_oat_test",
    );
  });

  it("creates and lists meters, benefits, and products with metadata", async () => {
    const sumMeter = await polar.meters.create({
      name: "API calls",
      filter: { conjunction: "and", clauses: [{ property: "name", operator: "eq", value: "api.call" }] },
      aggregation: { func: "sum", property: "count" },
      metadata: { source: "test" },
    });
    sumMeterId = sumMeter.id;

    const maxMeter = await polar.meters.create({
      name: "Peak payload",
      filter: { conjunction: "and", clauses: [{ property: "name", operator: "eq", value: "api.call" }] },
      aggregation: { func: "max", property: "count" },
      metadata: { source: "test" },
    });
    maxMeterId = maxMeter.id;

    const benefit = await polar.benefits.create({
      type: "meter_credit",
      description: "One hundred API calls",
      properties: { meterId: sumMeter.id, units: 100, rollover: false },
      metadata: { source: "test" },
    });
    benefitId = benefit.id;
    const customBenefit = await polar.benefits.create({
      type: "custom",
      description: "Private support channel",
      properties: { note: "Invite after subscription" },
      metadata: { source: "test" },
    });
    expect(customBenefit).toMatchObject({
      type: "custom",
      properties: { note: "Invite after subscription" },
    });

    const free = await polar.products.create({
      name: "Free",
      recurringInterval: "month",
      prices: [{ amountType: "fixed", priceAmount: 0, priceCurrency: "usd" }],
      metadata: { tier: "free" },
    });
    freeProductId = free.id;
    const withBenefits = await polar.products.updateBenefits({
      id: free.id,
      productBenefitsUpdate: { benefits: [benefit.id] },
    });
    expect(withBenefits.benefits.map((item) => item.id)).toEqual([benefit.id]);

    const paid = await polar.products.create({
      name: "Pro",
      recurringInterval: "month",
      trialInterval: "day",
      trialIntervalCount: 14,
      prices: [{ amountType: "fixed", priceAmount: 2000, priceCurrency: "usd" }],
      metadata: { tier: "pro" },
    });
    paidProductId = paid.id;
    const secondPaid = await polar.products.create({
      name: "Scale",
      recurringInterval: "month",
      prices: [{ amountType: "fixed", priceAmount: 4000, priceCurrency: "usd" }],
    });
    secondPaidProductId = secondPaid.id;
    const meteredProduct = await polar.products.create({
      name: "Usage",
      recurringInterval: "month",
      prices: [
        { amountType: "fixed", priceAmount: 1000, priceCurrency: "usd" },
        { amountType: "metered_unit", meterId: sumMeter.id, unitAmount: "0.5", priceCurrency: "usd" },
      ],
    });
    expect(meteredProduct.prices.find((price) => price.amountType === "metered_unit")).toMatchObject({
      meterId: sumMeter.id,
      unitAmount: "0.5",
    });

    const meterPage = await polar.meters.list({});
    expect(meterPage.result.items.find((item) => item.id === sumMeter.id)?.metadata).toEqual({ source: "test" });
    const benefitPage = await polar.benefits.list({});
    expect(benefitPage.result.items.find((item) => item.id === benefit.id)?.metadata).toEqual({ source: "test" });
    const productPage = await polar.products.list({});
    expect(productPage.result.items.find((item) => item.id === paid.id)?.metadata).toEqual({ tier: "pro" });
    const organizationPage = await polar.organizations.listOrganizations({});
    expect(organizationPage.result.items[0]).toMatchObject({ slug: "emulate", name: "Emulate" });
  });

  it("enforces customer uniqueness and maps unknown state to ResourceNotFound", async () => {
    const customer = await polar.customers.create({
      externalId: "acct_main",
      email: "main@example.com",
      name: "Main Customer",
      metadata: { segment: "test" },
    });
    customerId = customer.id;

    const duplicateEmail = await validationError(
      polar.customers.create({ externalId: "acct_other", email: "main@example.com" }),
    );
    expect(duplicateEmail.detail?.[0]).toMatchObject({
      loc: ["body", "email"],
      msg: "A customer with this email address already exists.",
    });

    const duplicateExternalId = await validationError(
      polar.customers.create({ externalId: "acct_main", email: "other@example.com" }),
    );
    expect(duplicateExternalId.detail?.[0]).toMatchObject({
      loc: ["body", "external_id"],
      msg: "A customer with this external ID already exists.",
    });

    await expect(polar.customers.getStateExternal({ externalId: "missing" })).rejects.toBeInstanceOf(ResourceNotFound);
  });

  it("creates free subscriptions and exposes grants and meter credits in customer state", async () => {
    const subscription = await polar.subscriptions.create({
      externalCustomerId: "acct_main",
      productId: freeProductId,
    });
    subscriptionId = subscription.id;

    await expect(
      polar.subscriptions.create({ externalCustomerId: "acct_main", productId: paidProductId }),
    ).rejects.toBeTruthy();

    const state = await polar.customers.getStateExternal({ externalId: "acct_main" });
    expect(state.activeSubscriptions.map((item) => item.id)).toContain(subscription.id);
    expect(state.grantedBenefits.map((item) => item.benefitId)).toContain(benefitId);
    expect(state.activeMeters.find((item) => item.meterId === sumMeterId)).toMatchObject({
      consumedUnits: 0,
      creditedUnits: 100,
      balance: 100,
    });
    const customerMeters = await polar.customerMeters.list({ externalCustomerId: "acct_main" });
    expect(customerMeters.result.items.find((item) => item.meterId === sumMeterId)).toMatchObject({
      customerId,
      creditedUnits: 100,
    });
  });

  it("aggregates events and connects events ingested before customer creation", async () => {
    const ingest = await polar.events.ingest({
      events: [
        { name: "api.call", externalCustomerId: "acct_main", externalId: "evt_main_1", metadata: { count: 3 } },
        { name: "api.call", externalCustomerId: "acct_main", externalId: "evt_main_2", metadata: { count: 7 } },
        { name: "ignored", externalCustomerId: "acct_main", metadata: { count: 100 } },
        { name: "api.call", externalCustomerId: "acct_late", externalId: "evt_late", metadata: { count: 9 } },
      ],
    });
    expect(ingest).toMatchObject({ inserted: 4, duplicates: 0 });

    const state = await polar.customers.getStateExternal({ externalId: "acct_main" });
    expect(state.activeMeters.find((item) => item.meterId === sumMeterId)).toMatchObject({
      consumedUnits: 10,
      creditedUnits: 100,
      balance: 90,
    });
    expect(state.activeMeters.find((item) => item.meterId === maxMeterId)?.consumedUnits).toBe(7);

    await polar.customers.create({ externalId: "acct_late", email: "late@example.com" });
    const late = await polar.customers.getStateExternal({ externalId: "acct_late" });
    expect(late.activeMeters.find((item) => item.meterId === sumMeterId)?.consumedUnits).toBe(9);

    const events = await polar.events.list({ externalCustomerId: "acct_main", name: "api.call" });
    expect(events.items).toHaveLength(2);
    expect(events.items.every((event) => event.name === "api.call" && event.externalCustomerId === "acct_main")).toBe(
      true,
    );
  });

  it("keeps confirmed checkout subscriptions pending until settlement", async () => {
    const checkout = await polar.checkouts.create({
      products: [paidProductId],
      subscriptionId,
      successUrl: "https://example.test/success?checkout_id={CHECKOUT_ID}",
    });
    expect(checkout.url).toBe(`${BASE}/checkout/${checkout.clientSecret}`);

    const page = await localFetch(checkout.url);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Start free trial");

    const confirmed = await localFetch(`${checkout.url}/confirm`, { method: "POST", redirect: "manual" });
    expect(confirmed.status).toBe(303);
    expect(confirmed.headers.get("location")).toBe(`https://example.test/success?checkout_id=${checkout.id}`);

    const pendingState = await polar.customers.getStateExternal({ externalId: "acct_main" });
    expect(pendingState.activeSubscriptions.find((item) => item.id === subscriptionId)?.productId).toBe(freeProductId);

    const settled = await localFetch(`${checkout.url}/settle`, { method: "POST" });
    expect(settled.status).toBe(200);
    const settledState = await polar.customers.getStateExternal({ externalId: "acct_main" });
    expect(settledState.activeSubscriptions.find((item) => item.id === subscriptionId)).toMatchObject({
      productId: paidProductId,
      status: "trialing",
    });
    expect(settledState.activeSubscriptions.find((item) => item.id === subscriptionId)?.trialEnd).toBeInstanceOf(Date);

    const secondCheckout = await polar.checkouts.create({
      products: [paidProductId],
      externalCustomerId: "acct_main",
      successUrl: "https://example.test/success",
    });
    await localFetch(`${secondCheckout.url}/confirm`, { method: "POST", redirect: "manual" });
    await localFetch(`${secondCheckout.url}/settle`, { method: "POST" });
    const stateWithSecondSubscription = await polar.customers.getStateExternal({ externalId: "acct_main" });
    expect(stateWithSecondSubscription.activeSubscriptions).toHaveLength(2);
  });

  it("schedules, clears, cancels, resumes, and revokes subscription updates", async () => {
    const scheduled = await polar.subscriptions.update({
      id: subscriptionId,
      subscriptionUpdate: { productId: secondPaidProductId, prorationBehavior: "next_period" },
    });
    expect(scheduled.productId).toBe(paidProductId);
    expect(scheduled.pendingUpdate?.productId).toBe(secondPaidProductId);

    const cleared = await polar.subscriptions.update({
      id: subscriptionId,
      subscriptionUpdate: { pendingUpdate: null },
    });
    expect(cleared.pendingUpdate).toBeNull();

    const canceling = await polar.subscriptions.update({
      id: subscriptionId,
      subscriptionUpdate: { cancelAtPeriodEnd: true },
    });
    expect(canceling.cancelAtPeriodEnd).toBe(true);
    const resumed = await polar.subscriptions.update({
      id: subscriptionId,
      subscriptionUpdate: { cancelAtPeriodEnd: false },
    });
    expect(resumed.cancelAtPeriodEnd).toBe(false);

    const revoked = await polar.subscriptions.update({
      id: subscriptionId,
      subscriptionUpdate: { revoke: true },
    });
    expect(revoked.status).toBe("canceled");
    const state = await polar.customers.getStateExternal({ externalId: "acct_main" });
    expect(state.activeSubscriptions.some((item) => item.id === subscriptionId)).toBe(false);

    const directlyRevoked = await polar.subscriptions.create({
      externalCustomerId: "acct_main",
      productId: freeProductId,
    });
    expect((await polar.subscriptions.revoke({ id: directlyRevoked.id })).status).toBe("canceled");
  });

  it("creates a customer portal session that renders", async () => {
    const session = await polar.customerSessions.create({
      externalCustomerId: "acct_main",
      returnUrl: "https://example.test/account",
    });
    expect(session.customerId).toBe(customerId);
    const portal = await localFetch(session.customerPortalUrl);
    expect(portal.status).toBe(200);
    expect(await portal.text()).toContain("main@example.com");
  });

  it("faults state reads by operation ID and records the fault in the ledger", async () => {
    const armed = await localFetch(`${BASE}/_emulate/faults`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        match: { operationId: "customers:get_state_external" },
        response: { status: 503 },
        times: 1,
      }),
    });
    expect(armed.status).toBe(200);
    await expect(polar.customers.getStateExternal({ externalId: "acct_main" })).rejects.toBeTruthy();

    const ledgerResponse = await localFetch(`${BASE}/_emulate/ledger`);
    const ledger = (await ledgerResponse.json()) as {
      entries: Array<{ operationId?: string; faulted?: boolean; response: { status: number } }>;
    };
    expect(
      ledger.entries.find((entry) => entry.operationId === "customers:get_state_external" && entry.faulted),
    ).toMatchObject({ operationId: "customers:get_state_external", faulted: true, response: { status: 503 } });

    const cleared = await localFetch(`${BASE}/_emulate/faults`, { method: "DELETE" });
    expect(cleared.status).toBe(200);
  });

  it("deleting a customer by external ID removes it and its subscriptions", async () => {
    await polar.customers.deleteExternal({ externalId: "acct_main" });
    await expect(polar.customers.getStateExternal({ externalId: "acct_main" })).rejects.toBeInstanceOf(
      ResourceNotFound,
    );
    await expect(polar.subscriptions.get({ id: subscriptionId })).rejects.toBeInstanceOf(ResourceNotFound);
  });
});
