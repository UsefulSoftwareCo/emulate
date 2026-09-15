import type { RouteContext, CheckoutLineItem, Store } from "@emulators/core";
import { renderCheckoutPage, renderCardPage } from "@emulators/core";

import { getAutumnStore, type AutumnStore } from "../store.js";
import type { AutumnCheckout, AutumnPaymentMethod, AutumnSetupSession } from "../entities.js";
import { activateSubscription, defaultCard, nextPaymentMethodId } from "../serialize.js";

const SERVICE_LABEL = "Autumn";

/** Process a completed checkout the way Autumn processes Stripe's asynchronous
 *  `checkout.session.completed` webhook: now (and only now) does the customer's
 *  subscription actually become active. A card-required trial lands `trialing`.
 *  Paying also leaves a card on file, as the Stripe subscription does. */
function settle(store: Store, as: AutumnStore, session: AutumnCheckout): void {
  const customer = as.customers.findOneBy("customer_id", session.customer_id);
  const plan = as.plans.findOneBy("plan_id", session.plan_id);
  if (customer && plan) activateSubscription(as, customer, plan, { trial: plan.free_trial != null });
  if (customer && !customer.payment_method) {
    as.customers.update(customer.id, { payment_method: defaultCard(nextPaymentMethodId(store)) });
  }
  as.checkouts.update(session.id, { status: "settled" });
}

/** Read the card the hosted setup page submitted. The brand follows the real
 *  issuer ranges Stripe's test cards use (4 Visa, 5 Mastercard, 3 Amex). */
function cardFromForm(cardNumber: string, exp: string, id: string): AutumnPaymentMethod {
  const digits = cardNumber.replace(/\D/g, "");
  const brand = digits.startsWith("4")
    ? "visa"
    : digits.startsWith("5")
      ? "mastercard"
      : digits.startsWith("3")
        ? "amex"
        : "card";
  const [rawMonth = "", rawYear = ""] = exp.split("/");
  const month = Number(rawMonth.trim());
  const year = Number(rawYear.trim());
  const expYear = Number.isFinite(year) && year > 0 ? (year < 100 ? 2000 + year : year) : 2030;
  return {
    id,
    type: "card",
    card: {
      brand,
      last4: digits.slice(-4) || "4242",
      exp_month: Number.isFinite(month) && month > 0 ? month : 12,
      exp_year: expYear,
    },
  };
}

/** Process a completed setup session the way Autumn processes Stripe's
 *  `checkout.session.completed` webhook for a standalone setup checkout: the
 *  captured card becomes the customer's default payment method. */
function settleSetup(as: AutumnStore, session: AutumnSetupSession): void {
  const customer = as.customers.findOneBy("customer_id", session.customer_id);
  if (customer && session.payment_method) {
    as.customers.update(customer.id, { payment_method: session.payment_method });
  }
  as.setups.update(session.id, { status: "settled" });
}

function setupPage(session: AutumnSetupSession): string {
  return renderCardPage(
    "Update payment method",
    "Save a new card for future payments.",
    `<form method="post" action="/checkout/setup/${session.session_id}/complete">
  <div class="checkout-form-section">
    <label class="checkout-form-label">Card information</label>
    <div class="checkout-card-box">
      <input type="text" name="card_number" class="checkout-input" value="4242 4242 4242 4242"/>
      <div class="checkout-card-row">
        <input type="text" name="exp" class="checkout-input" value="12/30"/>
        <input type="text" name="cvc" class="checkout-input" value="123"/>
      </div>
    </div>
    <div class="checkout-sim-note">Card fields are simulated. The card is saved on file.</div>
  </div>
  <button type="submit" class="checkout-pay-btn">Save card</button>
</form>`,
    SERVICE_LABEL,
  );
}

export function checkoutRoutes(ctx: RouteContext): void {
  const { app, store } = ctx;
  const as = () => getAutumnStore(store);

  // Settle every open checkout for a customer. This stands in for the Stripe
  // webhook reaching Autumn after the browser has already been redirected back,
  // letting a test control the exact moment the backend becomes consistent.
  app.post("/checkout/settle", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const customerId = String(body.customer_id ?? body.customerId ?? "");
    if (!customerId) return c.json({ message: "customer_id is required", code: "invalid_request" }, 400);
    const store = as();
    const sessions = store.checkouts.findBy("customer_id", customerId).filter((s) => s.status !== "settled");
    for (const session of sessions) settle(ctx.store, store, session);
    const setups = store.setups.findBy("customer_id", customerId).filter((s) => s.status !== "settled");
    for (const session of setups) settleSetup(store, session);
    return c.json({ settled: sessions.length + setups.length });
  });

  // Hosted Stripe "setup mode" checkout: capture a card without charging it.
  app.get("/checkout/setup/:sessionId", (c) => {
    const store = as();
    const session = store.setups.findOneBy("session_id", c.req.param("sessionId"));
    if (!session) {
      return c.html(
        renderCardPage(
          "Setup not found",
          "This setup session does not exist.",
          '<p class="empty">The session id is invalid or has been removed.</p>',
          SERVICE_LABEL,
        ),
        404,
      );
    }
    if (session.status === "settled") {
      return c.html(
        renderCardPage(
          "Payment method updated",
          "This card is already on file.",
          '<p class="empty check">Payment method saved</p>',
          SERVICE_LABEL,
        ),
      );
    }
    return c.html(setupPage(session));
  });

  // The browser submits the hosted setup page here. The card is captured and
  // the browser is redirected back, but the customer's default payment method
  // is deliberately NOT replaced yet: like real Stripe, that happens out of
  // band when the webhook is processed (see /checkout/setup/:id/settle).
  app.post("/checkout/setup/:sessionId/complete", async (c) => {
    const store = as();
    const session = store.setups.findOneBy("session_id", c.req.param("sessionId"));
    if (!session) {
      return c.html(renderCardPage("Setup not found", "This setup session does not exist.", "", SERVICE_LABEL), 404);
    }
    const form = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
    const cardNumber = typeof form.card_number === "string" ? form.card_number : "4242 4242 4242 4242";
    const exp = typeof form.exp === "string" ? form.exp : "12/30";
    store.setups.update(session.id, {
      status: "completed",
      payment_method: cardFromForm(cardNumber, exp, nextPaymentMethodId(ctx.store)),
    });
    return c.redirect(session.success_url || "/");
  });

  // Settle a single setup session explicitly (the Stripe webhook landing).
  app.post("/checkout/setup/:sessionId/settle", (c) => {
    const store = as();
    const session = store.setups.findOneBy("session_id", c.req.param("sessionId"));
    if (!session) return c.json({ message: "setup session not found", code: "not_found" }, 404);
    settleSetup(store, session);
    return c.json({ settled: 1 });
  });

  app.get("/checkout/:sessionId", (c) => {
    const store = as();
    const session = store.checkouts.findOneBy("session_id", c.req.param("sessionId"));
    if (!session) {
      return c.html(
        renderCardPage(
          "Checkout not found",
          "This checkout session does not exist.",
          '<p class="empty">The session id is invalid or has been removed.</p>',
          SERVICE_LABEL,
        ),
        404,
      );
    }
    if (session.status === "settled") {
      return c.html(
        renderCardPage(
          "Checkout complete",
          "This subscription is already active.",
          '<p class="empty check">Subscription active</p>',
          SERVICE_LABEL,
        ),
      );
    }

    const plan = store.plans.findOneBy("plan_id", session.plan_id);
    const planName = plan?.name ?? session.plan_id;
    const trialing = plan?.free_trial != null;
    // The hosted checkout page divides amounts by 100 for display; plan prices
    // are stored in dollars, so scale to cents. A trial owes nothing today.
    const dueCents = trialing ? 0 : Math.round((plan?.price?.amount ?? 0) * 100);
    const lineItems: CheckoutLineItem[] = [
      {
        name: trialing ? `${planName} (free trial)` : planName,
        quantity: 1,
        unitPrice: dueCents,
        totalPrice: dueCents,
        currency: "usd",
      },
    ];
    return c.html(
      renderCheckoutPage(
        {
          merchantName: "Executor",
          lineItems,
          subtotal: dueCents,
          total: dueCents,
          currency: "usd",
          sessionId: session.session_id,
          cancelUrl: session.success_url || null,
        },
        SERVICE_LABEL,
      ),
    );
  });

  // The browser submits the hosted checkout here. The payment "succeeds" and
  // the browser is redirected back to the application's success_url, but the
  // subscription is deliberately NOT activated yet: like real Stripe, that
  // happens out of band when the webhook is processed (see /checkout/settle).
  app.post("/checkout/:sessionId/complete", async (c) => {
    const store = as();
    const session = store.checkouts.findOneBy("session_id", c.req.param("sessionId"));
    if (!session) {
      return c.html(
        renderCardPage("Checkout not found", "This checkout session does not exist.", "", SERVICE_LABEL),
        404,
      );
    }
    if (session.status === "pending") store.checkouts.update(session.id, { status: "completed" });
    return c.redirect(session.success_url || "/");
  });

  // Settle a single session explicitly (the per-session form of /checkout/settle).
  app.post("/checkout/:sessionId/settle", (c) => {
    const store = as();
    const session = store.checkouts.findOneBy("session_id", c.req.param("sessionId"));
    if (!session) return c.json({ message: "checkout not found", code: "not_found" }, 404);
    settle(ctx.store, store, session);
    return c.json({ settled: 1 });
  });
}
