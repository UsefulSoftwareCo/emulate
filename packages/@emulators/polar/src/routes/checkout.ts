import { escapeAttr, escapeHtml, renderCardPage, type RouteContext } from "@emulators/core";

import type { PolarCustomer } from "../entities.js";
import { createSubscription, newUuid, productAmount, settleCheckout } from "../serialize.js";
import { getPolarStore } from "../store.js";

const SERVICE_LABEL = "Polar";

function checkoutCustomer(
  email: string,
  externalId: string | null,
  name: string | null,
  customerMetadata: Record<string, string | number | boolean>,
): Omit<PolarCustomer, "id" | "created_at" | "updated_at"> {
  return {
    polar_id: newUuid(),
    external_id: externalId,
    email,
    email_verified: false,
    type: "individual",
    name,
    billing_name: null,
    billing_address: null,
    tax_id: null,
    locale: null,
    metadata: customerMetadata,
  };
}

function redirectUrl(successUrl: string, checkoutId: string): string {
  return successUrl.replaceAll("{CHECKOUT_ID}", checkoutId);
}

export function checkoutRoutes(ctx: RouteContext): void {
  const { app, store } = ctx;
  const ps = () => getPolarStore(store);

  app.get("/checkout/:clientSecret", (c) => {
    const polar = ps();
    const checkout = polar.checkouts.findOneBy("client_secret", c.req.param("clientSecret"));
    if (!checkout)
      return c.html(renderCardPage("Checkout not found", "This checkout does not exist.", "", SERVICE_LABEL), 404);
    if (checkout.status === "succeeded") {
      return c.html(
        renderCardPage(
          "Checkout complete",
          "The checkout succeeded. Subscription settlement may still be in progress.",
          '<p class="empty check">Subscription pending</p>',
          SERVICE_LABEL,
        ),
      );
    }
    const product = polar.products.findOneBy("polar_id", checkout.product_ids[0] ?? "");
    if (!product)
      return c.html(renderCardPage("Checkout unavailable", "The product no longer exists.", "", SERVICE_LABEL), 404);
    const trial = checkout.allow_trial && product.trial_interval !== null && product.trial_interval_count !== null;
    const amount = productAmount(product);
    const price = `${(amount / 100).toFixed(2)} ${checkout.currency.toUpperCase()}`;
    const trialLine = trial
      ? `<p class="info-text">${product.trial_interval_count} ${escapeHtml(product.trial_interval!)} free trial</p>`
      : "";
    const email = checkout.customer_email ?? "";
    const body = `<div class="s-card">
  <div class="section-heading">${escapeHtml(product.name)}</div>
  <p class="info-text">${escapeHtml(price)} per ${escapeHtml(product.recurring_interval ?? "purchase")}</p>
  ${trialLine}
</div>
<form method="post" action="/checkout/${escapeAttr(checkout.client_secret)}/confirm">
  <div class="checkout-form-section">
    <label class="checkout-form-label" for="email">Customer email</label>
    <input id="email" type="email" name="email" class="checkout-input" value="${escapeAttr(email)}" required/>
  </div>
  <button type="submit" class="checkout-pay-btn">${trial ? "Start free trial" : "Subscribe"}</button>
</form>`;
    return c.html(renderCardPage("Subscribe", "Complete this simulated Polar checkout.", body, SERVICE_LABEL));
  });

  app.post("/checkout/:clientSecret/confirm", async (c) => {
    const polar = ps();
    const checkout = polar.checkouts.findOneBy("client_secret", c.req.param("clientSecret"));
    if (!checkout)
      return c.html(renderCardPage("Checkout not found", "This checkout does not exist.", "", SERVICE_LABEL), 404);
    if (checkout.status === "succeeded") return c.redirect(redirectUrl(checkout.success_url, checkout.polar_id), 303);
    const product = polar.products.findOneBy("polar_id", checkout.product_ids[0] ?? "");
    if (!product)
      return c.html(renderCardPage("Checkout unavailable", "The product no longer exists.", "", SERVICE_LABEL), 404);
    const form = await c.req.parseBody();
    const email = typeof form.email === "string" ? form.email : checkout.customer_email;
    if (!email) {
      return c.html(renderCardPage("Email required", "Enter a customer email to continue.", "", SERVICE_LABEL), 422);
    }
    let customer = checkout.customer_id ? polar.customers.findOneBy("polar_id", checkout.customer_id) : undefined;
    customer ??= polar.customers.findOneBy("email", email);
    if (!customer) {
      customer = polar.customers.insert(
        checkoutCustomer(email, checkout.external_customer_id, checkout.customer_name, checkout.customer_metadata),
      );
    }
    const now = new Date();
    const appliesTrial =
      checkout.allow_trial && product.trial_interval !== null && product.trial_interval_count !== null;
    let pendingSubscriptionId = checkout.pending_subscription_id;
    if (!checkout.subscription_id) {
      const subscription = createSubscription(polar, customer, product, {
        status: appliesTrial ? "trialing" : "active",
        metadata: checkout.metadata,
        pending: true,
        checkoutId: checkout.polar_id,
        now,
      });
      pendingSubscriptionId = subscription.polar_id;
    }
    polar.checkouts.update(checkout.id, {
      status: "succeeded",
      customer_id: customer.polar_id,
      customer_email: customer.email,
      pending_subscription_id: pendingSubscriptionId,
      confirmed_at: now.toISOString(),
    });
    return c.redirect(redirectUrl(checkout.success_url, checkout.polar_id), 303);
  });

  app.post("/checkout/:clientSecret/settle", (c) => {
    const polar = ps();
    const checkout = polar.checkouts.findOneBy("client_secret", c.req.param("clientSecret"));
    if (!checkout) return c.json({ error: "ResourceNotFound", detail: "Not found" }, 404);
    const settled = settleCheckout(polar, checkout);
    return c.json({ settled: settled.settled_at !== null, checkout_id: checkout.polar_id });
  });
}
