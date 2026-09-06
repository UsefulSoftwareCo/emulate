import { recordSideEffect, type AppEnv, type Context, type RouteContext, type Store } from "@emulators/core";

import type {
  PolarAggregation,
  PolarCustomer,
  PolarFilter,
  PolarMeterCreditProperties,
  PolarProduct,
  PolarStoredPrice,
} from "../entities.js";
import {
  POLAR_ORGANIZATION_ID,
  addInterval,
  createSubscription,
  isFreeProduct,
  liveSubscriptions,
  matchesMeter,
  metadata,
  meterBalances,
  newUuid,
  paginate,
  productAmount,
  productCurrency,
  rolloverSubscription,
  serializeBenefit,
  serializeCheckout,
  serializeCustomer,
  serializeCustomerState,
  serializeEvent,
  serializeMeter,
  serializeProduct,
  serializeSubscription,
} from "../serialize.js";
import { getPolarStore, type PolarStore } from "../store.js";

type Body = Record<string, unknown>;
const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function notFound(c: Context<AppEnv>) {
  return c.json({ error: "ResourceNotFound", detail: "Not found" }, 404);
}

function validation(c: Context<AppEnv>, field: string, message: string, input: unknown) {
  return c.json(
    {
      error: "RequestValidationError",
      detail: [{ type: "value_error", loc: ["body", field], msg: message, input }],
    },
    422,
  );
}

function bodyCustomer(ps: PolarStore, body: Body): PolarCustomer | undefined {
  if (typeof body.customer_id === "string") return ps.customers.findOneBy("polar_id", body.customer_id);
  if (typeof body.external_customer_id === "string") {
    return ps.customers.findOneBy("external_id", body.external_customer_id);
  }
  return undefined;
}

function insertCustomer(ps: PolarStore, body: Body): PolarCustomer {
  return ps.customers.insert({
    polar_id: newUuid(),
    external_id: typeof body.external_id === "string" ? body.external_id : null,
    email: String(body.email),
    email_verified: false,
    type: body.type === "team" ? "team" : "individual",
    name: typeof body.name === "string" ? body.name : null,
    billing_name: null,
    billing_address:
      body.billing_address && typeof body.billing_address === "object"
        ? (body.billing_address as Record<string, unknown>)
        : null,
    tax_id: typeof body.tax_id === "string" ? body.tax_id : null,
    locale: typeof body.locale === "string" ? body.locale : null,
    metadata: metadata(body.metadata),
  });
}

function validateCustomerUniqueness(ps: PolarStore, body: Body, current?: PolarCustomer) {
  if (typeof body.email === "string") {
    const duplicate = ps.customers.findOneBy("email", body.email);
    if (duplicate && duplicate.id !== current?.id) {
      return {
        field: "email",
        message: "A customer with this email address already exists.",
        input: body.email,
      };
    }
  }
  if (typeof body.external_id === "string") {
    const duplicate = ps.customers.findOneBy("external_id", body.external_id);
    if (duplicate && duplicate.id !== current?.id) {
      return {
        field: "external_id",
        message: "A customer with this external ID already exists.",
        input: body.external_id,
      };
    }
  }
  return null;
}

function updateCustomer(ps: PolarStore, customer: PolarCustomer, body: Body): PolarCustomer {
  return ps.customers.update(customer.id, {
    external_id:
      body.external_id === null ? null : typeof body.external_id === "string" ? body.external_id : customer.external_id,
    email: typeof body.email === "string" ? body.email : customer.email,
    type: body.type === "team" || body.type === "individual" ? body.type : customer.type,
    name: body.name === null ? null : typeof body.name === "string" ? body.name : customer.name,
    billing_address:
      body.billing_address === null
        ? null
        : body.billing_address && typeof body.billing_address === "object"
          ? (body.billing_address as Record<string, unknown>)
          : customer.billing_address,
    tax_id: body.tax_id === null ? null : typeof body.tax_id === "string" ? body.tax_id : customer.tax_id,
    locale: body.locale === null ? null : typeof body.locale === "string" ? body.locale : customer.locale,
    metadata: body.metadata === undefined ? customer.metadata : metadata(body.metadata),
  })!;
}

function revokeCustomerSubscriptions(ps: PolarStore, customer: PolarCustomer): void {
  const now = new Date().toISOString();
  for (const subscription of ps.subscriptions.findBy("customer_id", customer.polar_id)) {
    const revoked = ps.subscriptions.update(subscription.id, {
      status: "canceled",
      ended_at: now,
      ends_at: now,
      cancel_at_period_end: false,
    });
    if (revoked) ps.subscriptions.delete(revoked.id);
  }
}

function queryValues(url: string, key: string): string[] {
  return new URL(url).searchParams.getAll(key);
}

function includesQuery(values: string[], value: string | null): boolean {
  return values.length === 0 || (value !== null && values.includes(value));
}

function normalizePrice(value: unknown): PolarStoredPrice | null {
  if (!value || typeof value !== "object") return null;
  const price = value as Body;
  const now = new Date().toISOString();
  const common = {
    id: newUuid(),
    created_at: now,
    price_currency: typeof price.price_currency === "string" ? price.price_currency : "usd",
  };
  if (price.amount_type === "fixed") {
    return { ...common, amount_type: "fixed", price_amount: Number(price.price_amount ?? 0) };
  }
  if (price.amount_type === "metered_unit" && typeof price.meter_id === "string") {
    return {
      ...common,
      amount_type: "metered_unit",
      meter_id: price.meter_id,
      unit_amount: String(price.unit_amount ?? "0"),
      cap_amount: typeof price.cap_amount === "number" ? price.cap_amount : null,
    };
  }
  if (price.amount_type === "custom") {
    return {
      ...common,
      amount_type: "custom",
      minimum_amount: Number(price.minimum_amount ?? 0),
      maximum_amount: typeof price.maximum_amount === "number" ? price.maximum_amount : null,
      preset_amount: typeof price.preset_amount === "number" ? price.preset_amount : null,
    };
  }
  return null;
}

function insertProduct(ps: PolarStore, body: Body): PolarProduct {
  const prices = (Array.isArray(body.prices) ? body.prices : []).map(normalizePrice).filter((price) => price !== null);
  const interval = ["day", "week", "month", "year"].includes(String(body.recurring_interval))
    ? (body.recurring_interval as "day" | "week" | "month" | "year")
    : null;
  const meterInterval = ["day", "week", "month", "year"].includes(String(body.meter_interval))
    ? (body.meter_interval as "day" | "week" | "month" | "year")
    : null;
  const trialInterval = ["day", "week", "month", "year"].includes(String(body.trial_interval))
    ? (body.trial_interval as "day" | "week" | "month" | "year")
    : null;
  return ps.products.insert({
    polar_id: newUuid(),
    name: String(body.name ?? "Product"),
    description: typeof body.description === "string" ? body.description : null,
    recurring_interval: interval,
    recurring_interval_count: interval ? Number(body.recurring_interval_count ?? 1) : null,
    meter_interval: meterInterval,
    meter_interval_count: meterInterval ? Number(body.meter_interval_count ?? 1) : null,
    trial_interval: trialInterval,
    trial_interval_count: trialInterval ? Number(body.trial_interval_count ?? 1) : null,
    prices,
    benefit_ids: [],
    metadata: metadata(body.metadata),
    visibility: body.visibility === "draft" || body.visibility === "private" ? body.visibility : "public",
    is_archived: false,
  });
}

function serializeCustomerMeter(
  ps: PolarStore,
  customer: PolarCustomer,
  row: ReturnType<typeof meterBalances>[number],
) {
  const meter = ps.meters.findOneBy("polar_id", row.meter_id)!;
  return {
    ...row,
    customer_id: customer.polar_id,
    customer: serializeCustomer(customer),
    meter: serializeMeter(meter),
  };
}

function organization() {
  const emailSettings = {
    order_confirmation: false,
    subscription_cancellation: false,
    subscription_confirmation: false,
    subscription_cycled: false,
    subscription_cycled_after_trial: false,
    subscription_past_due: false,
    subscription_paused: false,
    subscription_resumed: false,
    subscription_renewal_reminder: false,
    subscription_revoked: false,
    subscription_trial_conversion_reminder: false,
    subscription_uncanceled: false,
    subscription_updated: false,
  };
  return {
    id: POLAR_ORGANIZATION_ID,
    created_at: "2025-01-01T00:00:00.000Z",
    modified_at: null,
    name: "Emulate",
    slug: "emulate",
    avatar_url: null,
    proration_behavior: "prorate",
    allow_customer_updates: true,
    email: null,
    website: null,
    socials: [],
    status: "active",
    details_submitted_at: null,
    sso_enforced: false,
    default_presentment_currency: "usd",
    default_tax_behavior: "location",
    feature_settings: null,
    subscription_settings: {
      allow_multiple_subscriptions: true,
      proration_behavior: "prorate",
      benefit_revocation_grace_period: 0,
      prevent_trial_abuse: false,
      allow_customer_updates: true,
    },
    customer_email_settings: emailSettings,
    customer_portal_settings: {
      usage: { show: true },
      subscription: { update_seats: false, update_plan: false, pause: false },
      customer: { allow_email_change: true },
    },
    country: null,
    account_id: null,
    payout_account_id: null,
    capabilities: {
      checkout_payments: true,
      subscription_renewals: true,
      payouts: false,
      refunds: false,
      api_access: true,
      dashboard_access: true,
    },
  };
}

export function polarApiRoutes(ctx: RouteContext): void {
  const { app, store, baseUrl } = ctx;
  const ps = () => getPolarStore(store);

  app.use("/v1/*", async (c, next) => {
    const authorization = c.req.header("Authorization") ?? "";
    const match = /^Bearer\s+(.+)$/i.exec(authorization);
    const token = match?.[1]?.trim();
    if (!token) return c.json({ error: "Unauthorized", detail: "A valid bearer token is required." }, 401);
    let id = 0;
    for (const character of token) id = (id * 31 + character.charCodeAt(0)) >>> 0;
    c.set("authUser", { login: token, id, scopes: [] });
    c.set("authToken", token);
    c.set("authScopes", []);
    await next();
  });

  app.post("/v1/customers/", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Body;
    if (typeof body.email !== "string" || !EMAIL_PATTERN.test(body.email)) {
      return validation(c, "email", "Input should be a valid email address", body.email);
    }
    const duplicate = validateCustomerUniqueness(ps(), body);
    if (duplicate) return validation(c, duplicate.field, duplicate.message, duplicate.input);
    const customer = insertCustomer(ps(), body);
    recordSideEffect(c, { type: "create", collection: "polar.customers", id: customer.polar_id });
    return c.json(serializeCustomer(customer), 201);
  });

  app.get("/v1/customers/", (c) => {
    const url = new URL(c.req.url);
    const externalIds = queryValues(c.req.url, "external_id");
    const emails = queryValues(c.req.url, "email");
    const query = (url.searchParams.get("query") ?? "").toLowerCase();
    const items = ps()
      .customers.all()
      .filter(
        (customer) =>
          includesQuery(externalIds, customer.external_id) &&
          includesQuery(emails, customer.email) &&
          (!query ||
            customer.email.toLowerCase().includes(query) ||
            customer.name?.toLowerCase().includes(query) ||
            customer.external_id?.toLowerCase().includes(query)),
      )
      .map(serializeCustomer);
    return c.json(
      paginate(items, url.searchParams.get("page") ?? undefined, url.searchParams.get("limit") ?? undefined),
    );
  });

  app.get("/v1/customers/external/:externalId/state", (c) => {
    const store = ps();
    const customer = store.customers.findOneBy("external_id", c.req.param("externalId"));
    return customer ? c.json(serializeCustomerState(store, customer)) : notFound(c);
  });

  app.get("/v1/customers/external/:externalId", (c) => {
    const customer = ps().customers.findOneBy("external_id", c.req.param("externalId"));
    return customer ? c.json(serializeCustomer(customer)) : notFound(c);
  });

  app.patch("/v1/customers/external/:externalId", async (c) => {
    const store = ps();
    const customer = store.customers.findOneBy("external_id", c.req.param("externalId"));
    if (!customer) return notFound(c);
    const body = (await c.req.json().catch(() => ({}))) as Body;
    if (typeof body.email === "string" && !EMAIL_PATTERN.test(body.email)) {
      return validation(c, "email", "Input should be a valid email address", body.email);
    }
    const duplicate = validateCustomerUniqueness(store, body, customer);
    if (duplicate) return validation(c, duplicate.field, duplicate.message, duplicate.input);
    const updated = updateCustomer(store, customer, body);
    recordSideEffect(c, { type: "update", collection: "polar.customers", id: updated.polar_id });
    return c.json(serializeCustomer(updated));
  });

  app.delete("/v1/customers/external/:externalId", (c) => {
    const store = ps();
    const customer = store.customers.findOneBy("external_id", c.req.param("externalId"));
    if (!customer) return notFound(c);
    revokeCustomerSubscriptions(store, customer);
    store.customers.delete(customer.id);
    recordSideEffect(c, { type: "delete", collection: "polar.customers", id: customer.polar_id });
    return c.body(null, 204);
  });

  app.get("/v1/customers/:id/state", (c) => {
    const store = ps();
    const customer = store.customers.findOneBy("polar_id", c.req.param("id"));
    return customer ? c.json(serializeCustomerState(store, customer)) : notFound(c);
  });

  app.get("/v1/customers/:id", (c) => {
    const customer = ps().customers.findOneBy("polar_id", c.req.param("id"));
    return customer ? c.json(serializeCustomer(customer)) : notFound(c);
  });

  app.patch("/v1/customers/:id", async (c) => {
    const store = ps();
    const customer = store.customers.findOneBy("polar_id", c.req.param("id"));
    if (!customer) return notFound(c);
    const body = (await c.req.json().catch(() => ({}))) as Body;
    if (typeof body.email === "string" && !EMAIL_PATTERN.test(body.email)) {
      return validation(c, "email", "Input should be a valid email address", body.email);
    }
    const duplicate = validateCustomerUniqueness(store, body, customer);
    if (duplicate) return validation(c, duplicate.field, duplicate.message, duplicate.input);
    const updated = updateCustomer(store, customer, body);
    recordSideEffect(c, { type: "update", collection: "polar.customers", id: updated.polar_id });
    return c.json(serializeCustomer(updated));
  });

  app.delete("/v1/customers/:id", (c) => {
    const store = ps();
    const customer = store.customers.findOneBy("polar_id", c.req.param("id"));
    if (!customer) return notFound(c);
    revokeCustomerSubscriptions(store, customer);
    store.customers.delete(customer.id);
    recordSideEffect(c, { type: "delete", collection: "polar.customers", id: customer.polar_id });
    return c.body(null, 204);
  });

  app.get("/v1/customer-meters/", (c) => {
    const url = new URL(c.req.url);
    const customerIds = queryValues(c.req.url, "customer_id");
    const externalIds = queryValues(c.req.url, "external_customer_id");
    const meterIds = queryValues(c.req.url, "meter_id");
    const store = ps();
    const items = store.customers
      .all()
      .filter(
        (customer) => includesQuery(customerIds, customer.polar_id) && includesQuery(externalIds, customer.external_id),
      )
      .flatMap((customer) => meterBalances(store, customer).map((row) => serializeCustomerMeter(store, customer, row)))
      .filter((row) => includesQuery(meterIds, row.meter_id));
    return c.json(
      paginate(items, url.searchParams.get("page") ?? undefined, url.searchParams.get("limit") ?? undefined),
    );
  });

  app.post("/v1/meters/", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Body;
    const meter = ps().meters.insert({
      polar_id: newUuid(),
      name: String(body.name ?? "Meter"),
      unit: body.unit === "token" || body.unit === "custom" ? body.unit : "scalar",
      custom_label: typeof body.custom_label === "string" ? body.custom_label : null,
      custom_multiplier: typeof body.custom_multiplier === "number" ? body.custom_multiplier : null,
      filter: body.filter as PolarFilter,
      aggregation: body.aggregation as PolarAggregation,
      metadata: metadata(body.metadata),
      archived_at: null,
    });
    recordSideEffect(c, { type: "create", collection: "polar.meters", id: meter.polar_id });
    return c.json(serializeMeter(meter), 201);
  });

  app.get("/v1/meters/", (c) => {
    const url = new URL(c.req.url);
    const query = (url.searchParams.get("query") ?? "").toLowerCase();
    const archived = url.searchParams.get("is_archived");
    const items = ps()
      .meters.all()
      .filter(
        (meter) =>
          (!query || meter.name.toLowerCase().includes(query)) &&
          (archived === null || (meter.archived_at !== null) === (archived === "true")),
      )
      .map(serializeMeter);
    return c.json(
      paginate(items, url.searchParams.get("page") ?? undefined, url.searchParams.get("limit") ?? undefined),
    );
  });

  app.get("/v1/meters/:id", (c) => {
    const meter = ps().meters.findOneBy("polar_id", c.req.param("id"));
    return meter ? c.json(serializeMeter(meter)) : notFound(c);
  });

  app.patch("/v1/meters/:id", async (c) => {
    const store = ps();
    const meter = store.meters.findOneBy("polar_id", c.req.param("id"));
    if (!meter) return notFound(c);
    const body = (await c.req.json().catch(() => ({}))) as Body;
    const updated = store.meters.update(meter.id, {
      name: typeof body.name === "string" ? body.name : meter.name,
      unit: body.unit === "scalar" || body.unit === "token" || body.unit === "custom" ? body.unit : meter.unit,
      custom_label:
        body.custom_label === null
          ? null
          : typeof body.custom_label === "string"
            ? body.custom_label
            : meter.custom_label,
      custom_multiplier:
        body.custom_multiplier === null
          ? null
          : typeof body.custom_multiplier === "number"
            ? body.custom_multiplier
            : meter.custom_multiplier,
      filter: body.filter && typeof body.filter === "object" ? (body.filter as PolarFilter) : meter.filter,
      aggregation:
        body.aggregation && typeof body.aggregation === "object"
          ? (body.aggregation as PolarAggregation)
          : meter.aggregation,
      metadata: body.metadata === undefined ? meter.metadata : metadata(body.metadata),
      archived_at:
        body.is_archived === true ? new Date().toISOString() : body.is_archived === false ? null : meter.archived_at,
    })!;
    recordSideEffect(c, { type: "update", collection: "polar.meters", id: updated.polar_id });
    return c.json(serializeMeter(updated));
  });

  app.post("/v1/events/ingest", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Body;
    const events = Array.isArray(body.events) ? body.events : [];
    let inserted = 0;
    let duplicates = 0;
    const store = ps();
    for (const value of events) {
      if (!value || typeof value !== "object") continue;
      const event = value as Body;
      const externalId = typeof event.external_id === "string" ? event.external_id : null;
      if (externalId && store.events.findOneBy("external_id", externalId)) {
        duplicates += 1;
        continue;
      }
      const created = store.events.insert({
        polar_id: newUuid(),
        external_id: externalId,
        timestamp: typeof event.timestamp === "string" ? event.timestamp : new Date().toISOString(),
        name: String(event.name ?? "event"),
        customer_id: typeof event.customer_id === "string" ? event.customer_id : null,
        external_customer_id: typeof event.external_customer_id === "string" ? event.external_customer_id : null,
        metadata: metadata(event.metadata),
      });
      inserted += 1;
      recordSideEffect(c, { type: "create", collection: "polar.events", id: created.polar_id });
    }
    return c.json({ inserted, duplicates });
  });

  app.get("/v1/events/", (c) => {
    const url = new URL(c.req.url);
    const customerIds = queryValues(c.req.url, "customer_id");
    const externalIds = queryValues(c.req.url, "external_customer_id");
    const names = queryValues(c.req.url, "name");
    const meterId = url.searchParams.get("meter_id");
    const store = ps();
    const meter = meterId ? store.meters.findOneBy("polar_id", meterId) : undefined;
    const items = store.events
      .all()
      .filter(
        (event) =>
          includesQuery(customerIds, event.customer_id) &&
          includesQuery(externalIds, event.external_customer_id) &&
          includesQuery(names, event.name) &&
          (!meterId || (meter !== undefined && matchesMeter(event, meter))),
      )
      .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))
      .map((event) => serializeEvent(store, event));
    return c.json(
      paginate(items, url.searchParams.get("page") ?? undefined, url.searchParams.get("limit") ?? undefined),
    );
  });

  app.get("/v1/events/names", (c) => {
    const url = new URL(c.req.url);
    const grouped = new Map<string, { occurrences: number; first: string; last: string }>();
    for (const event of ps().events.all()) {
      const current = grouped.get(event.name);
      grouped.set(event.name, {
        occurrences: (current?.occurrences ?? 0) + 1,
        first: current && current.first < event.timestamp ? current.first : event.timestamp,
        last: current && current.last > event.timestamp ? current.last : event.timestamp,
      });
    }
    const items = [...grouped].map(([name, value]) => ({
      name,
      label: name,
      source: "user",
      occurrences: value.occurrences,
      first_seen: value.first,
      last_seen: value.last,
    }));
    return c.json(
      paginate(items, url.searchParams.get("page") ?? undefined, url.searchParams.get("limit") ?? undefined),
    );
  });

  app.post("/v1/benefits/", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Body;
    const type = body.type === "meter_credit" ? "meter_credit" : "custom";
    const properties = body.properties && typeof body.properties === "object" ? (body.properties as Body) : {};
    const benefit = ps().benefits.insert({
      polar_id: newUuid(),
      type,
      description: String(body.description ?? "Benefit"),
      properties:
        type === "meter_credit"
          ? {
              meter_id: String(properties.meter_id ?? ""),
              units: Number(properties.units ?? 0),
              rollover: properties.rollover === true,
            }
          : { note: typeof properties.note === "string" ? properties.note : null },
      metadata: metadata(body.metadata),
      visibility: body.visibility === "draft" || body.visibility === "private" ? body.visibility : "public",
    });
    recordSideEffect(c, { type: "create", collection: "polar.benefits", id: benefit.polar_id });
    return c.json(serializeBenefit(benefit), 201);
  });

  app.get("/v1/benefits/", (c) => {
    const url = new URL(c.req.url);
    const items = ps().benefits.all().map(serializeBenefit);
    return c.json(
      paginate(items, url.searchParams.get("page") ?? undefined, url.searchParams.get("limit") ?? undefined),
    );
  });

  app.get("/v1/benefits/:id", (c) => {
    const benefit = ps().benefits.findOneBy("polar_id", c.req.param("id"));
    return benefit ? c.json(serializeBenefit(benefit)) : notFound(c);
  });

  app.patch("/v1/benefits/:id", async (c) => {
    const store = ps();
    const benefit = store.benefits.findOneBy("polar_id", c.req.param("id"));
    if (!benefit) return notFound(c);
    const body = (await c.req.json().catch(() => ({}))) as Body;
    const props = body.properties && typeof body.properties === "object" ? (body.properties as Body) : null;
    const updated = store.benefits.update(benefit.id, {
      description:
        body.description === null
          ? benefit.description
          : typeof body.description === "string"
            ? body.description
            : benefit.description,
      metadata: body.metadata === undefined ? benefit.metadata : metadata(body.metadata),
      visibility:
        body.visibility === "draft" || body.visibility === "private" || body.visibility === "public"
          ? body.visibility
          : benefit.visibility,
      properties:
        props && benefit.type === "meter_credit"
          ? {
              meter_id: String(props.meter_id ?? (benefit.properties as PolarMeterCreditProperties).meter_id),
              units: Number(props.units ?? (benefit.properties as PolarMeterCreditProperties).units),
              rollover:
                props.rollover === undefined
                  ? (benefit.properties as PolarMeterCreditProperties).rollover
                  : props.rollover === true,
            }
          : props && benefit.type === "custom"
            ? { note: typeof props.note === "string" ? props.note : null }
            : benefit.properties,
    })!;
    recordSideEffect(c, { type: "update", collection: "polar.benefits", id: updated.polar_id });
    return c.json(serializeBenefit(updated));
  });

  app.delete("/v1/benefits/:id", (c) => {
    const store = ps();
    const benefit = store.benefits.findOneBy("polar_id", c.req.param("id"));
    if (!benefit) return notFound(c);
    store.benefits.delete(benefit.id);
    for (const product of store.products.all()) {
      if (product.benefit_ids.includes(benefit.polar_id)) {
        store.products.update(product.id, { benefit_ids: product.benefit_ids.filter((id) => id !== benefit.polar_id) });
      }
    }
    recordSideEffect(c, { type: "delete", collection: "polar.benefits", id: benefit.polar_id });
    return c.body(null, 204);
  });

  app.post("/v1/products/", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Body;
    const product = insertProduct(ps(), body);
    recordSideEffect(c, { type: "create", collection: "polar.products", id: product.polar_id });
    return c.json(serializeProduct(ps(), product), 201);
  });

  app.get("/v1/products/", (c) => {
    const url = new URL(c.req.url);
    const archived = url.searchParams.get("is_archived");
    const recurring = url.searchParams.get("is_recurring");
    const store = ps();
    const items = store.products
      .all()
      .filter(
        (product) =>
          (archived === null || product.is_archived === (archived === "true")) &&
          (recurring === null || (product.recurring_interval !== null) === (recurring === "true")),
      )
      .map((product) => serializeProduct(store, product));
    return c.json(
      paginate(items, url.searchParams.get("page") ?? undefined, url.searchParams.get("limit") ?? undefined),
    );
  });

  app.post("/v1/products/:id/benefits", async (c) => {
    const store = ps();
    const product = store.products.findOneBy("polar_id", c.req.param("id"));
    if (!product) return notFound(c);
    const body = (await c.req.json().catch(() => ({}))) as Body;
    const benefitIds = Array.isArray(body.benefits)
      ? body.benefits.filter(
          (id): id is string => typeof id === "string" && store.benefits.findOneBy("polar_id", id) !== undefined,
        )
      : [];
    const updated = store.products.update(product.id, { benefit_ids: benefitIds })!;
    recordSideEffect(c, { type: "update", collection: "polar.products", id: updated.polar_id });
    return c.json(serializeProduct(store, updated));
  });

  app.get("/v1/products/:id", (c) => {
    const store = ps();
    const product = store.products.findOneBy("polar_id", c.req.param("id"));
    return product ? c.json(serializeProduct(store, product)) : notFound(c);
  });

  app.patch("/v1/products/:id", async (c) => {
    const store = ps();
    const product = store.products.findOneBy("polar_id", c.req.param("id"));
    if (!product) return notFound(c);
    const body = (await c.req.json().catch(() => ({}))) as Body;
    const prices = Array.isArray(body.prices)
      ? body.prices.map(normalizePrice).filter((price) => price !== null)
      : product.prices;
    const updated = store.products.update(product.id, {
      name: typeof body.name === "string" ? body.name : product.name,
      description:
        body.description === null
          ? null
          : typeof body.description === "string"
            ? body.description
            : product.description,
      metadata: body.metadata === undefined ? product.metadata : metadata(body.metadata),
      is_archived: typeof body.is_archived === "boolean" ? body.is_archived : product.is_archived,
      prices,
    })!;
    recordSideEffect(c, { type: "update", collection: "polar.products", id: updated.polar_id });
    return c.json(serializeProduct(store, updated));
  });

  app.post("/v1/subscriptions/", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Body;
    const store = ps();
    const product =
      typeof body.product_id === "string" ? store.products.findOneBy("polar_id", body.product_id) : undefined;
    const customer = bodyCustomer(store, body);
    if (!product || !customer) return notFound(c);
    if (!isFreeProduct(product)) {
      return c.json(
        {
          error: "SubscriptionCreationError",
          detail:
            "This endpoint only allows to create subscription on free products. For paid products, use the checkout flow.",
        },
        400,
      );
    }
    const subscription = createSubscription(store, customer, product, { metadata: metadata(body.metadata) });
    recordSideEffect(c, { type: "create", collection: "polar.subscriptions", id: subscription.polar_id });
    return c.json(serializeSubscription(store, subscription), 201);
  });

  app.get("/v1/subscriptions/", (c) => {
    const url = new URL(c.req.url);
    const customerIds = queryValues(c.req.url, "customer_id");
    const externalIds = queryValues(c.req.url, "external_customer_id");
    const productIds = queryValues(c.req.url, "product_id");
    const statuses = queryValues(c.req.url, "status");
    const active = url.searchParams.get("active");
    const store = ps();
    const customersByExternal = new Set(
      store.customers
        .all()
        .filter((customer) => includesQuery(externalIds, customer.external_id))
        .map((customer) => customer.polar_id),
    );
    const items = liveSubscriptions(store)
      .map((subscription) => rolloverSubscription(store, subscription))
      .filter(
        (subscription) =>
          includesQuery(customerIds, subscription.customer_id) &&
          (externalIds.length === 0 || customersByExternal.has(subscription.customer_id)) &&
          includesQuery(productIds, subscription.product_id) &&
          includesQuery(statuses, subscription.status) &&
          (active === null || ["active", "trialing"].includes(subscription.status) === (active === "true")),
      )
      .map((subscription) => serializeSubscription(store, subscription));
    return c.json(
      paginate(items, url.searchParams.get("page") ?? undefined, url.searchParams.get("limit") ?? undefined),
    );
  });

  app.post("/v1/subscriptions/:id/revoke", (c) => {
    c.set("operationId", "subscriptions:revoke");
    const store = ps();
    const subscription = store.subscriptions.findOneBy("polar_id", c.req.param("id"));
    if (!subscription || subscription.pending) return notFound(c);
    const now = new Date().toISOString();
    const updated = store.subscriptions.update(subscription.id, {
      status: "canceled",
      ended_at: now,
      ends_at: now,
      cancel_at_period_end: false,
    })!;
    return c.json(serializeSubscription(store, updated));
  });

  app.get("/v1/subscriptions/:id", (c) => {
    const store = ps();
    const subscription = store.subscriptions.findOneBy("polar_id", c.req.param("id"));
    return subscription && !subscription.pending ? c.json(serializeSubscription(store, subscription)) : notFound(c);
  });

  app.patch("/v1/subscriptions/:id", async (c) => {
    const store = ps();
    const subscription = store.subscriptions.findOneBy("polar_id", c.req.param("id"));
    if (!subscription || subscription.pending) return notFound(c);
    const body = (await c.req.json().catch(() => ({}))) as Body;
    let updated = subscription;
    if (body.revoke === true) {
      const now = new Date().toISOString();
      updated = store.subscriptions.update(subscription.id, {
        status: "canceled",
        ended_at: now,
        ends_at: now,
        cancel_at_period_end: false,
      })!;
    } else if (Object.hasOwn(body, "pending_update") && body.pending_update === null) {
      updated = store.subscriptions.update(subscription.id, { pending_update: null })!;
    } else if (typeof body.cancel_at_period_end === "boolean") {
      const now = new Date().toISOString();
      updated = store.subscriptions.update(subscription.id, {
        cancel_at_period_end: body.cancel_at_period_end,
        canceled_at: body.cancel_at_period_end ? now : null,
        ends_at: body.cancel_at_period_end ? subscription.current_period_end : null,
        customer_cancellation_reason:
          typeof body.customer_cancellation_reason === "string" ? body.customer_cancellation_reason : null,
        customer_cancellation_comment:
          typeof body.customer_cancellation_comment === "string" ? body.customer_cancellation_comment : null,
      })!;
    } else if (typeof body.product_id === "string") {
      const product = store.products.findOneBy("polar_id", body.product_id);
      if (!product) return notFound(c);
      if (body.proration_behavior === "next_period") {
        const now = new Date().toISOString();
        updated = store.subscriptions.update(subscription.id, {
          pending_update: {
            id: newUuid(),
            created_at: now,
            applies_at: subscription.current_period_end,
            product_id: product.polar_id,
            seats: null,
            units: null,
          },
        })!;
      } else {
        const now = new Date();
        updated = store.subscriptions.update(subscription.id, {
          product_id: product.polar_id,
          amount: productAmount(product),
          currency: productCurrency(product),
          recurring_interval: product.recurring_interval ?? "month",
          recurring_interval_count: product.recurring_interval_count ?? 1,
          pending_update: null,
          ...(body.proration_behavior === "reset"
            ? {
                current_period_start: now.toISOString(),
                current_period_end: addInterval(
                  now,
                  product.recurring_interval ?? "month",
                  product.recurring_interval_count ?? 1,
                ).toISOString(),
              }
            : {}),
        })!;
      }
    }
    recordSideEffect(c, { type: "update", collection: "polar.subscriptions", id: updated.polar_id });
    return c.json(serializeSubscription(store, updated));
  });

  app.delete("/v1/subscriptions/:id", (c) => {
    c.set("operationId", "subscriptions:revoke");
    const store = ps();
    const subscription = store.subscriptions.findOneBy("polar_id", c.req.param("id"));
    if (!subscription || subscription.pending) return notFound(c);
    const now = new Date().toISOString();
    const updated = store.subscriptions.update(subscription.id, {
      status: "canceled",
      ended_at: now,
      ends_at: now,
      cancel_at_period_end: false,
    })!;
    recordSideEffect(c, { type: "update", collection: "polar.subscriptions", id: updated.polar_id });
    return c.json(serializeSubscription(store, updated));
  });

  app.post("/v1/checkouts/", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Body;
    const store = ps();
    const productIds = Array.isArray(body.products)
      ? body.products.filter((id): id is string => typeof id === "string")
      : [];
    const product = store.products.findOneBy("polar_id", productIds[0] ?? "");
    if (!product) return notFound(c);
    const referencedSubscription =
      typeof body.subscription_id === "string"
        ? store.subscriptions.findOneBy("polar_id", body.subscription_id)
        : undefined;
    let customer = referencedSubscription
      ? store.customers.findOneBy("polar_id", referencedSubscription.customer_id)
      : bodyCustomer(store, body);
    if (!customer && typeof body.external_customer_id === "string" && typeof body.customer_email === "string") {
      const duplicate = validateCustomerUniqueness(store, {
        email: body.customer_email,
        external_id: body.external_customer_id,
      });
      if (duplicate) return validation(c, duplicate.field, duplicate.message, duplicate.input);
      customer = insertCustomer(store, {
        email: body.customer_email,
        name: body.customer_name,
        external_id: body.external_customer_id,
        metadata: body.customer_metadata,
      });
    }
    const allowTrial = body.allow_trial !== false;
    const now = new Date();
    const checkout = store.checkouts.insert({
      polar_id: newUuid(),
      client_secret: newUuid(),
      status: "open",
      expires_at: new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString(),
      success_url: typeof body.success_url === "string" ? body.success_url : `${baseUrl}/checkout/success`,
      return_url: typeof body.return_url === "string" ? body.return_url : null,
      product_ids: productIds,
      customer_id: customer?.polar_id ?? null,
      customer_email: typeof body.customer_email === "string" ? body.customer_email : (customer?.email ?? null),
      customer_name: typeof body.customer_name === "string" ? body.customer_name : (customer?.name ?? null),
      external_customer_id:
        typeof body.external_customer_id === "string" ? body.external_customer_id : (customer?.external_id ?? null),
      subscription_id: referencedSubscription?.polar_id ?? null,
      pending_subscription_id: null,
      amount: productAmount(product),
      currency: productCurrency(product),
      allow_discount_codes: body.allow_discount_codes !== false,
      allow_trial: allowTrial,
      trial_end:
        allowTrial && product.trial_interval && product.trial_interval_count
          ? addInterval(now, product.trial_interval, product.trial_interval_count).toISOString()
          : null,
      metadata: metadata(body.metadata),
      customer_metadata: metadata(body.customer_metadata),
      settle_delay_ms: storeDataSettleDelay(ctx.store),
      confirmed_at: null,
      settled_at: null,
    });
    recordSideEffect(c, { type: "create", collection: "polar.checkouts", id: checkout.polar_id });
    return c.json(serializeCheckout(store, checkout, baseUrl), 201);
  });

  app.get("/v1/checkouts/client/:clientSecret", (c) => {
    const store = ps();
    const checkout = store.checkouts.findOneBy("client_secret", c.req.param("clientSecret"));
    return checkout ? c.json(serializeCheckout(store, checkout, baseUrl)) : notFound(c);
  });

  app.get("/v1/checkouts/:id", (c) => {
    const store = ps();
    const checkout = store.checkouts.findOneBy("polar_id", c.req.param("id"));
    return checkout ? c.json(serializeCheckout(store, checkout, baseUrl)) : notFound(c);
  });

  app.post("/v1/customer-sessions/", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Body;
    const store = ps();
    const customer = bodyCustomer(store, body);
    if (!customer) return notFound(c);
    const now = new Date();
    const session = store.customerSessions.insert({
      polar_id: newUuid(),
      token: newUuid(),
      expires_at: new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
      customer_id: customer.polar_id,
      return_url: typeof body.return_url === "string" ? body.return_url : null,
    });
    recordSideEffect(c, { type: "create", collection: "polar.customer_sessions", id: session.polar_id });
    return c.json(
      {
        id: session.polar_id,
        created_at: session.created_at,
        modified_at: null,
        token: session.token,
        expires_at: session.expires_at,
        return_url: session.return_url,
        customer_portal_url: `${baseUrl}/portal?customer_session_token=${session.token}`,
        customer_id: customer.polar_id,
        customer: serializeCustomer(customer),
      },
      201,
    );
  });

  app.get("/v1/organizations/", (c) => {
    const url = new URL(c.req.url);
    return c.json(
      paginate([organization()], url.searchParams.get("page") ?? undefined, url.searchParams.get("limit") ?? undefined),
    );
  });
}

function storeDataSettleDelay(store: Store): number | null {
  const delay = store.getData<number | null>("polar.checkout.settle_delay_ms");
  return delay === undefined ? 2500 : delay;
}
