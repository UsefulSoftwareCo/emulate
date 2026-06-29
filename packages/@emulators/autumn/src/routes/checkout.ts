import type { RouteContext, CheckoutLineItem } from "@emulators/core";
import { renderCheckoutPage, renderCardPage } from "@emulators/core";

import { getAutumnStore, type AutumnStore } from "../store.js";
import type { AutumnCheckout } from "../entities.js";
import { activateSubscription } from "../serialize.js";

const SERVICE_LABEL = "Autumn";

/** Process a completed checkout the way Autumn processes Stripe's asynchronous
 *  `checkout.session.completed` webhook: now (and only now) does the customer's
 *  subscription actually become active. A card-required trial lands `trialing`. */
function settle(as: AutumnStore, session: AutumnCheckout): void {
  const customer = as.customers.findOneBy("customer_id", session.customer_id);
  const plan = as.plans.findOneBy("plan_id", session.plan_id);
  if (customer && plan) activateSubscription(as, customer, plan, { trial: plan.free_trial != null });
  as.checkouts.update(session.id, { status: "settled" });
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
    for (const session of sessions) settle(store, session);
    return c.json({ settled: sessions.length });
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
    settle(store, session);
    return c.json({ settled: 1 });
  });
}
