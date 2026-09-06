import type {
  PolarBenefit,
  PolarCheckout,
  PolarCustomer,
  PolarEvent,
  PolarFilter,
  PolarFilterClause,
  PolarMetadata,
  PolarMeter,
  PolarProduct,
  PolarStoredPrice,
  PolarSubscription,
  PolarSubscriptionStatus,
} from "./entities.js";
import type { PolarStore } from "./store.js";

export const POLAR_ORGANIZATION_ID = "00000000-0000-4000-8000-000000000001";

const ACTIVE_STATUSES = new Set<PolarSubscriptionStatus>(["active", "trialing"]);

export function newUuid(): string {
  return crypto.randomUUID();
}

function modifiedAt(entity: { created_at: string; updated_at: string }): string | null {
  return entity.updated_at === entity.created_at ? null : entity.updated_at;
}

export function serializeCustomer(customer: PolarCustomer): Record<string, unknown> {
  return {
    id: customer.polar_id,
    created_at: customer.created_at,
    modified_at: modifiedAt(customer),
    metadata: customer.metadata,
    external_id: customer.external_id,
    email: customer.email,
    email_verified: customer.email_verified,
    type: customer.type,
    name: customer.name,
    billing_name: customer.billing_name,
    billing_address: customer.billing_address,
    tax_id: customer.tax_id ? [customer.tax_id] : null,
    locale: customer.locale,
    organization_id: POLAR_ORGANIZATION_ID,
    default_payment_method_id: null,
    deleted_at: null,
    avatar_url: null,
  };
}

export function serializeMeter(meter: PolarMeter): Record<string, unknown> {
  return {
    id: meter.polar_id,
    created_at: meter.created_at,
    modified_at: modifiedAt(meter),
    metadata: meter.metadata,
    name: meter.name,
    unit: meter.unit,
    custom_label: meter.custom_label,
    custom_multiplier: meter.custom_multiplier,
    filter: meter.filter,
    aggregation: meter.aggregation,
    organization_id: POLAR_ORGANIZATION_ID,
    archived_at: meter.archived_at,
  };
}

export function serializeBenefit(benefit: PolarBenefit): Record<string, unknown> {
  return {
    id: benefit.polar_id,
    created_at: benefit.created_at,
    modified_at: modifiedAt(benefit),
    type: benefit.type,
    description: benefit.description,
    selectable: true,
    deletable: true,
    is_deleted: false,
    organization_id: POLAR_ORGANIZATION_ID,
    metadata: benefit.metadata,
    visibility: benefit.visibility,
    properties: benefit.properties,
    visibility_configurable: true,
  };
}

function serializePublicBenefit(benefit: PolarBenefit): Record<string, unknown> {
  return {
    id: benefit.polar_id,
    created_at: benefit.created_at,
    modified_at: modifiedAt(benefit),
    type: benefit.type,
    description: benefit.description,
    selectable: true,
    deletable: true,
    is_deleted: false,
    organization_id: POLAR_ORGANIZATION_ID,
  };
}

export function serializePrice(
  ps: PolarStore,
  product: PolarProduct,
  price: PolarStoredPrice,
): Record<string, unknown> {
  const common = {
    id: price.id,
    created_at: price.created_at,
    modified_at: null,
    source: "catalog",
    amount_type: price.amount_type,
    type: product.recurring_interval ? "recurring" : "one_time",
    recurring_interval: product.recurring_interval,
    price_currency: price.price_currency,
    tax_behavior: null,
    is_archived: false,
    product_id: product.polar_id,
  };

  if (price.amount_type === "fixed") {
    return { ...common, price_amount: price.price_amount };
  }
  if (price.amount_type === "metered_unit") {
    const meter = ps.meters.findOneBy("polar_id", price.meter_id);
    return {
      ...common,
      meter_id: price.meter_id,
      unit_amount: price.unit_amount,
      cap_amount: price.cap_amount,
      meter: meter
        ? {
            id: meter.polar_id,
            name: meter.name,
            unit: meter.unit,
            custom_label: meter.custom_label,
            custom_multiplier: meter.custom_multiplier,
          }
        : {
            id: price.meter_id,
            name: "Unknown meter",
            unit: "scalar",
            custom_label: null,
            custom_multiplier: null,
          },
    };
  }
  return {
    ...common,
    minimum_amount: price.minimum_amount,
    maximum_amount: price.maximum_amount,
    preset_amount: price.preset_amount,
  };
}

export function serializeProduct(
  ps: PolarStore,
  product: PolarProduct,
  options: { checkout?: boolean } = {},
): Record<string, unknown> {
  const benefits = product.benefit_ids
    .map((id) => ps.benefits.findOneBy("polar_id", id))
    .filter((benefit): benefit is PolarBenefit => benefit !== undefined)
    .map((benefit) => (options.checkout ? serializePublicBenefit(benefit) : serializeBenefit(benefit)));
  return {
    id: product.polar_id,
    created_at: product.created_at,
    modified_at: modifiedAt(product),
    trial_interval: product.trial_interval,
    trial_interval_count: product.trial_interval_count,
    name: product.name,
    description: product.description,
    visibility: product.visibility,
    recurring_interval: product.recurring_interval,
    recurring_interval_count: product.recurring_interval_count,
    meter_interval: product.meter_interval,
    meter_interval_count: product.meter_interval_count,
    is_recurring: product.recurring_interval !== null,
    is_archived: product.is_archived,
    organization_id: POLAR_ORGANIZATION_ID,
    metadata: product.metadata,
    prices: product.prices.map((price) => serializePrice(ps, product, price)),
    benefits,
    medias: [],
    attached_custom_fields: [],
  };
}

export function productAmount(product: PolarProduct): number {
  return product.prices.reduce((total, price) => {
    if (price.amount_type === "fixed") return total + price.price_amount;
    if (price.amount_type === "custom") return total + (price.preset_amount ?? price.minimum_amount);
    return total;
  }, 0);
}

export function productCurrency(product: PolarProduct): string {
  return product.prices[0]?.price_currency ?? "usd";
}

export function isFreeProduct(product: PolarProduct): boolean {
  return (
    product.prices.length > 0 &&
    product.prices.every((price) => price.amount_type === "fixed" && price.price_amount === 0)
  );
}

export function addInterval(value: Date, interval: "day" | "week" | "month" | "year", count = 1): Date {
  const next = new Date(value);
  if (interval === "day") next.setUTCDate(next.getUTCDate() + count);
  if (interval === "week") next.setUTCDate(next.getUTCDate() + count * 7);
  if (interval === "month") next.setUTCMonth(next.getUTCMonth() + count);
  if (interval === "year") next.setUTCFullYear(next.getUTCFullYear() + count);
  return next;
}

function trialEnd(product: PolarProduct, now: Date): string | null {
  if (!product.trial_interval || !product.trial_interval_count) return null;
  return addInterval(now, product.trial_interval, product.trial_interval_count).toISOString();
}

export function createSubscription(
  ps: PolarStore,
  customer: PolarCustomer,
  product: PolarProduct,
  options: {
    status?: "active" | "trialing";
    metadata?: PolarMetadata;
    pending?: boolean;
    checkoutId?: string | null;
    now?: Date;
  } = {},
): PolarSubscription {
  const now = options.now ?? new Date();
  const status = options.status ?? "active";
  const end = status === "trialing" ? trialEnd(product, now) : null;
  const interval = product.recurring_interval ?? "month";
  const intervalCount = product.recurring_interval_count ?? 1;
  return ps.subscriptions.insert({
    polar_id: newUuid(),
    status,
    amount: productAmount(product),
    currency: productCurrency(product),
    recurring_interval: interval,
    recurring_interval_count: intervalCount,
    current_period_start: now.toISOString(),
    current_period_end: end ?? addInterval(now, interval, intervalCount).toISOString(),
    trial_start: status === "trialing" ? now.toISOString() : null,
    trial_end: end,
    cancel_at_period_end: false,
    canceled_at: null,
    started_at: now.toISOString(),
    ends_at: null,
    ended_at: null,
    customer_id: customer.polar_id,
    product_id: product.polar_id,
    pending_update: null,
    checkout_id: options.checkoutId ?? null,
    customer_cancellation_reason: null,
    customer_cancellation_comment: null,
    metadata: options.metadata ?? {},
    pending: options.pending ?? false,
  });
}

function applyProduct(ps: PolarStore, subscription: PolarSubscription, productId: string): PolarSubscription {
  const product = ps.products.findOneBy("polar_id", productId);
  if (!product) return subscription;
  return ps.subscriptions.update(subscription.id, {
    product_id: product.polar_id,
    amount: productAmount(product),
    currency: productCurrency(product),
    recurring_interval: product.recurring_interval ?? "month",
    recurring_interval_count: product.recurring_interval_count ?? 1,
  })!;
}

export function rolloverSubscription(
  ps: PolarStore,
  subscription: PolarSubscription,
  now = new Date(),
): PolarSubscription {
  let current = subscription;
  if (current.pending || current.status === "canceled") return current;
  let periodEnd = new Date(current.current_period_end);
  if (now < periodEnd) return current;

  if (current.cancel_at_period_end) {
    return ps.subscriptions.update(current.id, {
      status: "canceled",
      ended_at: now.toISOString(),
      ends_at: current.current_period_end,
    })!;
  }

  if (current.pending_update?.product_id) {
    current = applyProduct(ps, current, current.pending_update.product_id);
  }
  let periodStart = periodEnd;
  if (current.status === "trialing") current = ps.subscriptions.update(current.id, { status: "active" })!;
  do {
    periodEnd = addInterval(periodStart, current.recurring_interval, current.recurring_interval_count);
    if (now < periodEnd) break;
    periodStart = periodEnd;
  } while (true);
  return ps.subscriptions.update(current.id, {
    current_period_start: periodStart.toISOString(),
    current_period_end: periodEnd.toISOString(),
    pending_update: null,
  })!;
}

export function liveSubscriptions(ps: PolarStore): PolarSubscription[] {
  settleDueCheckouts(ps);
  return ps.subscriptions.all().filter((subscription) => !subscription.pending);
}

export function settleCheckout(ps: PolarStore, checkout: PolarCheckout, now = new Date()): PolarCheckout {
  if (checkout.status !== "succeeded" || checkout.settled_at) return checkout;
  const product = ps.products.findOneBy("polar_id", checkout.product_ids[0] ?? "");
  const customer = ps.customers.findOneBy("polar_id", checkout.customer_id ?? "");
  if (!product || !customer) return checkout;
  const appliesTrial = checkout.allow_trial && product.trial_interval !== null && product.trial_interval_count !== null;

  if (checkout.subscription_id) {
    const subscription = ps.subscriptions.findOneBy("polar_id", checkout.subscription_id);
    if (subscription) {
      const end = appliesTrial ? trialEnd(product, now) : null;
      ps.subscriptions.update(subscription.id, {
        status: appliesTrial ? "trialing" : "active",
        product_id: product.polar_id,
        amount: productAmount(product),
        currency: productCurrency(product),
        recurring_interval: product.recurring_interval ?? "month",
        recurring_interval_count: product.recurring_interval_count ?? 1,
        current_period_start: now.toISOString(),
        current_period_end:
          end ??
          addInterval(now, product.recurring_interval ?? "month", product.recurring_interval_count ?? 1).toISOString(),
        trial_start: appliesTrial ? now.toISOString() : null,
        trial_end: end,
        checkout_id: checkout.polar_id,
        cancel_at_period_end: false,
        canceled_at: null,
        ends_at: null,
        ended_at: null,
        pending_update: null,
      });
    }
  } else if (checkout.pending_subscription_id) {
    const subscription = ps.subscriptions.findOneBy("polar_id", checkout.pending_subscription_id);
    if (subscription) {
      const end = appliesTrial ? trialEnd(product, now) : null;
      ps.subscriptions.update(subscription.id, {
        pending: false,
        status: appliesTrial ? "trialing" : "active",
        current_period_start: now.toISOString(),
        current_period_end:
          end ??
          addInterval(now, product.recurring_interval ?? "month", product.recurring_interval_count ?? 1).toISOString(),
        trial_start: appliesTrial ? now.toISOString() : null,
        trial_end: end,
      });
    }
  }

  return ps.checkouts.update(checkout.id, { settled_at: now.toISOString() })!;
}

export function settleDueCheckouts(ps: PolarStore, now = new Date()): void {
  for (const checkout of ps.checkouts.all()) {
    if (!checkout.confirmed_at || checkout.settled_at || checkout.settle_delay_ms === null) continue;
    if (now.getTime() >= Date.parse(checkout.confirmed_at) + checkout.settle_delay_ms) {
      settleCheckout(ps, checkout, now);
    }
  }
}

export function serializeSubscription(ps: PolarStore, subscription: PolarSubscription): Record<string, unknown> {
  const current = rolloverSubscription(ps, subscription);
  const customer = ps.customers.findOneBy("polar_id", current.customer_id);
  const product = ps.products.findOneBy("polar_id", current.product_id);
  return {
    id: current.polar_id,
    created_at: current.created_at,
    modified_at: modifiedAt(current),
    amount: current.amount,
    currency: current.currency,
    recurring_interval: current.recurring_interval,
    recurring_interval_count: current.recurring_interval_count,
    status: current.status,
    current_period_start: current.current_period_start,
    current_period_end: current.current_period_end,
    current_meter_period_start: null,
    current_meter_period_end: null,
    trial_start: current.trial_start,
    trial_end: current.trial_end,
    cancel_at_period_end: current.cancel_at_period_end,
    canceled_at: current.canceled_at,
    started_at: current.started_at,
    ends_at: current.ends_at,
    ended_at: current.ended_at,
    past_due_at: null,
    pause_at_period_end: false,
    paused_at: null,
    resumes_at: null,
    customer_id: current.customer_id,
    product_id: current.product_id,
    discount_id: null,
    checkout_id: current.checkout_id,
    seats: null,
    units: null,
    customer_cancellation_reason: current.customer_cancellation_reason,
    customer_cancellation_comment: current.customer_cancellation_comment,
    metadata: current.metadata,
    custom_field_data: {},
    customer: customer ? serializeCustomer(customer) : null,
    product: product ? serializeProduct(ps, product) : null,
    discount: null,
    prices: product ? product.prices.map((price) => serializePrice(ps, product, price)) : [],
    meters: [],
    pending_update: current.pending_update ? { ...current.pending_update, modified_at: null } : null,
  };
}

function eventProperty(event: PolarEvent, property: string): unknown {
  if (property === "name") return event.name;
  if (property === "external_customer_id") return event.external_customer_id;
  if (property === "customer_id") return event.customer_id;
  return event.metadata[property];
}

function numericCompare(left: unknown, right: unknown, compare: (a: number, b: number) => boolean): boolean {
  const a = Number(left);
  const b = Number(right);
  return Number.isFinite(a) && Number.isFinite(b) && compare(a, b);
}

function like(left: unknown, right: unknown): boolean {
  const pattern = String(right)
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/%/g, ".*")
    .replace(/_/g, ".");
  return new RegExp(`^${pattern}$`, "i").test(String(left ?? ""));
}

function matchesClause(event: PolarEvent, clause: PolarFilterClause): boolean {
  const value = eventProperty(event, clause.property);
  if (clause.operator === "eq") return value === clause.value;
  if (clause.operator === "ne") return value !== clause.value;
  if (clause.operator === "gt") return numericCompare(value, clause.value, (a, b) => a > b);
  if (clause.operator === "gte") return numericCompare(value, clause.value, (a, b) => a >= b);
  if (clause.operator === "lt") return numericCompare(value, clause.value, (a, b) => a < b);
  if (clause.operator === "lte") return numericCompare(value, clause.value, (a, b) => a <= b);
  if (clause.operator === "like") return like(value, clause.value);
  return !like(value, clause.value);
}

function isFilter(value: PolarFilterClause | PolarFilter): value is PolarFilter {
  return "conjunction" in value;
}

export function matchesMeter(event: PolarEvent, meter: PolarMeter): boolean {
  const results = meter.filter.clauses.map((clause) =>
    isFilter(clause) ? matchesFilter(event, clause) : matchesClause(event, clause),
  );
  return meter.filter.conjunction === "and" ? results.every(Boolean) : results.some(Boolean);
}

function matchesFilter(event: PolarEvent, filter: PolarFilter): boolean {
  const results = filter.clauses.map((clause) =>
    isFilter(clause) ? matchesFilter(event, clause) : matchesClause(event, clause),
  );
  return filter.conjunction === "and" ? results.every(Boolean) : results.some(Boolean);
}

function aggregate(events: PolarEvent[], meter: PolarMeter): number {
  if (meter.aggregation.func === "count") return events.length;
  const property = meter.aggregation.property;
  const values = events
    .map((event) => eventProperty(event, property))
    .filter((value) => value !== undefined && value !== null);
  if (meter.aggregation.func === "unique") return new Set(values.map(String)).size;
  const numbers = values.map(Number).filter(Number.isFinite);
  if (numbers.length === 0) return 0;
  if (meter.aggregation.func === "sum") return numbers.reduce((sum, value) => sum + value, 0);
  if (meter.aggregation.func === "max") return Math.max(...numbers);
  if (meter.aggregation.func === "min") return Math.min(...numbers);
  return numbers.reduce((sum, value) => sum + value, 0) / numbers.length;
}

function eventsForCustomer(ps: PolarStore, customer: PolarCustomer, since: string | null): PolarEvent[] {
  return ps.events.all().filter((event) => {
    const belongs =
      event.customer_id === customer.polar_id ||
      (customer.external_id !== null && event.external_customer_id === customer.external_id);
    return belongs && (since === null || Date.parse(event.timestamp) >= Date.parse(since));
  });
}

export interface MeterBalance {
  id: string;
  created_at: string;
  modified_at: string | null;
  meter_id: string;
  consumed_units: number;
  credited_units: number;
  balance: number;
}

export function meterBalances(ps: PolarStore, customer: PolarCustomer): MeterBalance[] {
  const subscriptions = liveSubscriptions(ps)
    .filter((subscription) => subscription.customer_id === customer.polar_id)
    .map((subscription) => rolloverSubscription(ps, subscription))
    .filter((subscription) => ACTIVE_STATUSES.has(subscription.status));
  const since = subscriptions.length
    ? subscriptions.map((subscription) => subscription.current_period_start).sort()[0]!
    : null;
  const events = eventsForCustomer(ps, customer, since);
  const credits = new Map<string, number>();
  for (const subscription of subscriptions) {
    const product = ps.products.findOneBy("polar_id", subscription.product_id);
    for (const benefitId of product?.benefit_ids ?? []) {
      const benefit = ps.benefits.findOneBy("polar_id", benefitId);
      if (benefit?.type !== "meter_credit") continue;
      const props = benefit.properties as { meter_id: string; units: number };
      credits.set(props.meter_id, (credits.get(props.meter_id) ?? 0) + props.units);
    }
  }
  const rows: MeterBalance[] = [];
  for (const meter of ps.meters.all()) {
    const matching = events.filter((event) => matchesMeter(event, meter));
    const credited = credits.get(meter.polar_id) ?? 0;
    if (credited === 0 && matching.length === 0) continue;
    const consumed = aggregate(matching, meter);
    rows.push({
      id: meter.polar_id,
      created_at: meter.created_at,
      modified_at: modifiedAt(meter),
      meter_id: meter.polar_id,
      consumed_units: consumed,
      credited_units: credited,
      balance: credited - consumed,
    });
  }
  return rows;
}

function stateSubscription(subscription: PolarSubscription): Record<string, unknown> {
  return {
    id: subscription.polar_id,
    created_at: subscription.created_at,
    modified_at: modifiedAt(subscription),
    custom_field_data: {},
    metadata: subscription.metadata,
    status: subscription.status,
    amount: subscription.amount,
    currency: subscription.currency,
    recurring_interval: subscription.recurring_interval,
    current_period_start: subscription.current_period_start,
    current_period_end: subscription.current_period_end,
    trial_start: subscription.trial_start,
    trial_end: subscription.trial_end,
    cancel_at_period_end: subscription.cancel_at_period_end,
    canceled_at: subscription.canceled_at,
    started_at: subscription.started_at,
    ends_at: subscription.ends_at,
    product_id: subscription.product_id,
    discount_id: null,
    meters: [],
  };
}

export function serializeCustomerState(ps: PolarStore, customer: PolarCustomer): Record<string, unknown> {
  const subscriptions = liveSubscriptions(ps)
    .filter((subscription) => subscription.customer_id === customer.polar_id)
    .map((subscription) => rolloverSubscription(ps, subscription))
    .filter((subscription) => ACTIVE_STATUSES.has(subscription.status));
  const benefitIds = new Set<string>();
  for (const subscription of subscriptions) {
    const product = ps.products.findOneBy("polar_id", subscription.product_id);
    for (const benefitId of product?.benefit_ids ?? []) benefitIds.add(benefitId);
  }
  const grantedBenefits = [...benefitIds]
    .map((id) => ps.benefits.findOneBy("polar_id", id))
    .filter((benefit): benefit is PolarBenefit => benefit !== undefined)
    .map((benefit) => ({
      id: benefit.polar_id,
      created_at: benefit.created_at,
      modified_at: modifiedAt(benefit),
      granted_at: benefit.created_at,
      benefit_id: benefit.polar_id,
      benefit_type: benefit.type,
      benefit_metadata: benefit.metadata,
      properties: benefit.properties,
    }));
  return {
    ...serializeCustomer(customer),
    active_subscriptions: subscriptions.map(stateSubscription),
    granted_benefits: grantedBenefits,
    active_meters: meterBalances(ps, customer),
  };
}

export function serializeEvent(ps: PolarStore, event: PolarEvent): Record<string, unknown> {
  const customer = event.customer_id
    ? ps.customers.findOneBy("polar_id", event.customer_id)
    : event.external_customer_id
      ? ps.customers.findOneBy("external_id", event.external_customer_id)
      : undefined;
  return {
    id: event.polar_id,
    external_id: event.external_id,
    timestamp: event.timestamp,
    name: event.name,
    label: event.name,
    source: "user",
    organization_id: POLAR_ORGANIZATION_ID,
    customer_id: customer?.polar_id ?? event.customer_id,
    external_customer_id: event.external_customer_id ?? customer?.external_id ?? null,
    customer: customer ? serializeCustomer(customer) : null,
    child_count: 0,
    parent_id: null,
    metadata: event.metadata,
  };
}

export function serializeCheckout(ps: PolarStore, checkout: PolarCheckout, baseUrl: string): Record<string, unknown> {
  settleDueCheckouts(ps);
  const current = ps.checkouts.get(checkout.id) ?? checkout;
  const products = current.product_ids
    .map((id) => ps.products.findOneBy("polar_id", id))
    .filter((item): item is PolarProduct => item !== undefined);
  const product = products[0];
  const customer = ps.customers.findOneBy("polar_id", current.customer_id ?? "");
  const price = product?.prices[0];
  const appliesTrial = current.allow_trial && product?.trial_interval != null && product.trial_interval_count != null;
  return {
    id: current.polar_id,
    created_at: current.created_at,
    modified_at: modifiedAt(current),
    custom_field_data: {},
    payment_processor: "stripe",
    status: current.status,
    client_secret: current.client_secret,
    url: `${baseUrl}/checkout/${current.client_secret}`,
    expires_at: current.expires_at,
    success_url: current.success_url,
    return_url: current.return_url,
    embed_origin: null,
    amount: current.amount,
    seats: null,
    min_seats: null,
    max_seats: null,
    discount_amount: 0,
    net_amount: current.amount,
    tax_amount: 0,
    tax_behavior: null,
    total_amount: current.amount,
    currency: current.currency,
    allow_trial: current.allow_trial,
    active_trial_interval: appliesTrial ? product?.trial_interval : null,
    active_trial_interval_count: appliesTrial ? product?.trial_interval_count : null,
    trial_end: current.trial_end,
    organization_id: POLAR_ORGANIZATION_ID,
    product_id: product?.polar_id ?? null,
    product_price_id: price?.id ?? null,
    discount_id: null,
    allow_discount_codes: current.allow_discount_codes,
    require_billing_address: false,
    is_discount_applicable: false,
    is_free_product_price: product ? isFreeProduct(product) : false,
    is_payment_required: current.amount > 0 && !appliesTrial,
    is_payment_setup_required: appliesTrial && current.amount > 0,
    is_payment_form_required: current.amount > 0,
    customer_id: customer?.polar_id ?? null,
    is_business_customer: customer?.type === "team",
    customer_name: current.customer_name ?? customer?.name ?? null,
    customer_email: current.customer_email ?? customer?.email ?? null,
    customer_ip_address: null,
    customer_billing_name: null,
    customer_billing_address: null,
    customer_tax_id: null,
    locale: null,
    payment_processor_metadata: {},
    billing_address_fields: {
      country: "disabled",
      state: "disabled",
      city: "disabled",
      postal_code: "disabled",
      line1: "disabled",
      line2: "disabled",
    },
    trial_interval: product?.trial_interval ?? null,
    trial_interval_count: product?.trial_interval_count ?? null,
    metadata: current.metadata,
    customer_external_id: current.external_customer_id,
    external_customer_id: current.external_customer_id,
    products: products.map((item) => serializeProduct(ps, item, { checkout: true })),
    product: product ? serializeProduct(ps, product, { checkout: true }) : null,
    product_price: product && price ? serializePrice(ps, product, price) : null,
    prices: null,
    discount: null,
    subscription_id: current.subscription_id,
    attached_custom_fields: [],
    customer_metadata: current.customer_metadata,
  };
}

export function paginate<T>(items: T[], pageValue: string | undefined, limitValue: string | undefined) {
  const page = Math.max(1, Number.parseInt(pageValue ?? "1", 10) || 1);
  const limit = Math.min(100, Math.max(1, Number.parseInt(limitValue ?? "10", 10) || 10));
  const total = items.length;
  return {
    items: items.slice((page - 1) * limit, page * limit),
    pagination: { total_count: total, max_page: Math.max(1, Math.ceil(total / limit)) },
  };
}

export function metadata(value: unknown): PolarMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string | number | boolean] =>
      ["string", "number", "boolean"].includes(typeof entry[1]),
    ),
  );
}
