import type { RouteContext } from "@emulators/core";
import { renderCardPage, escapeHtml, escapeAttr } from "@emulators/core";

import { getAutumnStore, type AutumnStore } from "../store.js";
import type { AutumnCustomer } from "../entities.js";
import { cardFromForm, nextPaymentMethodId } from "../serialize.js";

const SERVICE_LABEL = "Autumn";

/** The Stripe billing portal session most recently opened for this customer.
 *  Stripe portal sessions are single-use; the emulator keeps them all and the
 *  page reads the newest so the return link matches the latest visit. */
function latestPortal(as: AutumnStore, customerId: string): { return_url: string } | undefined {
  const sessions = as.portals.findBy("customer_id", customerId);
  return sessions.length ? sessions[sessions.length - 1] : undefined;
}

function notFoundPage(): string {
  return renderCardPage(
    "Customer not found",
    "This billing portal link is not valid.",
    '<p class="empty">The customer id is unknown or has been removed.</p>',
    SERVICE_LABEL,
  );
}

function planSummary(as: AutumnStore, customer: AutumnCustomer): string {
  const subs = customer.subscriptions ?? [];
  if (!subs.length) return '<p class="empty">No active subscription</p>';
  return subs
    .map((sub) => {
      const plan = as.plans.findOneBy("plan_id", sub.plan_id);
      const price = plan?.price ? `$${plan.price.amount} / ${plan.price.interval}` : "Free";
      return `<div class="org-row">
  <span class="org-name">${escapeHtml(plan?.name ?? sub.plan_id)}</span>
  <span class="badge badge-granted">${escapeHtml(sub.status)}</span>
  <span>${escapeHtml(price)}</span>
</div>`;
    })
    .join("\n");
}

function cardSummary(customer: AutumnCustomer): string {
  const pm = customer.payment_method;
  if (!pm) return '<p class="empty">No payment method</p>';
  const exp = `${String(pm.card.exp_month).padStart(2, "0")}/${pm.card.exp_year}`;
  return `<div class="org-row">
  <span class="org-name">${escapeHtml(pm.card.brand)}</span>
  <span>&bull;&bull;&bull;&bull; ${escapeHtml(pm.card.last4)}</span>
  <span>Expires ${escapeHtml(exp)}</span>
</div>`;
}

function returnLink(returnUrl: string | undefined): string {
  if (!returnUrl) return "";
  let label = returnUrl;
  try {
    label = new URL(returnUrl).host || returnUrl;
  } catch {
    // A relative or malformed return_url is shown verbatim.
  }
  return `<p class="info-text"><a href="${escapeAttr(returnUrl)}">Return to ${escapeHtml(label)}</a></p>`;
}

function portalPage(as: AutumnStore, customer: AutumnCustomer): string {
  const action = `/checkout/portal/${encodeURIComponent(customer.customer_id)}/payment-method`;
  return renderCardPage(
    "Billing portal",
    "Manage your plan and the card on file.",
    `<div class="section-heading">Current plan</div>
${planSummary(as, customer)}
<div class="section-heading">Payment method</div>
${cardSummary(customer)}
<form method="post" action="${escapeAttr(action)}">
  <div class="checkout-form-section">
    <label class="checkout-form-label">Card information</label>
    <div class="checkout-card-box">
      <input type="text" name="card_number" class="checkout-input" value="4242 4242 4242 4242"/>
      <div class="checkout-card-row">
        <input type="text" name="exp" class="checkout-input" value="12/30"/>
        <input type="text" name="cvc" class="checkout-input" value="123"/>
      </div>
    </div>
    <div class="checkout-sim-note">Card fields are simulated. The new card replaces the default immediately.</div>
  </div>
  <button type="submit" class="checkout-pay-btn">Update payment method</button>
</form>
${returnLink(latestPortal(as, customer.customer_id)?.return_url)}`,
    SERVICE_LABEL,
  );
}

/** The hosted Stripe billing portal, the page `billing.open_customer_portal`
 *  sends a customer to. Only the parts an application under test depends on
 *  are modelled: the current plan, the card on file, and a form that changes
 *  the card.
 *
 *  Unlike the setup checkout flow, updating the card here takes effect
 *  IMMEDIATELY. Stripe owns the portal and swaps the customer's default
 *  payment method inside Stripe before the page returns, and Autumn reads the
 *  card live from Stripe on every `payment_method` expand, so there is no
 *  webhook to wait for and no race to reproduce. This is why an application
 *  that must CHANGE a card uses the portal rather than `billing.setup_payment`
 *  (see settleSetup in routes/checkout.ts). */
export function portalRoutes(ctx: RouteContext): void {
  const { app, store } = ctx;
  const as = () => getAutumnStore(store);

  app.get("/checkout/portal/:customerId", (c) => {
    const autumn = as();
    const customer = autumn.customers.findOneBy("customer_id", c.req.param("customerId"));
    if (!customer) return c.html(notFoundPage(), 404);
    return c.html(portalPage(autumn, customer));
  });

  app.post("/checkout/portal/:customerId/payment-method", async (c) => {
    const customerId = c.req.param("customerId");
    const autumn = as();
    const customer = autumn.customers.findOneBy("customer_id", customerId);
    if (!customer) return c.html(notFoundPage(), 404);
    const form = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
    const cardNumber = typeof form.card_number === "string" ? form.card_number : "4242 4242 4242 4242";
    const exp = typeof form.exp === "string" ? form.exp : "12/30";
    autumn.customers.update(customer.id, {
      payment_method: cardFromForm(cardNumber, exp, nextPaymentMethodId(store)),
    });
    return c.redirect(`/checkout/portal/${encodeURIComponent(customerId)}`);
  });
}
