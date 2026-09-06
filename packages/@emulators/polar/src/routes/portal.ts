import {
  escapeAttr,
  escapeHtml,
  renderSettingsPage,
  type AppEnv,
  type Context,
  type RouteContext,
} from "@emulators/core";

import { liveSubscriptions, rolloverSubscription } from "../serialize.js";
import { getPolarStore } from "../store.js";

const SERVICE_LABEL = "Polar";

export function portalRoutes(ctx: RouteContext): void {
  const { app, store } = ctx;
  const ps = () => getPolarStore(store);

  app.get("/portal", (c) => {
    const polar = ps();
    const token = c.req.query("customer_session_token") ?? "";
    const session = polar.customerSessions.findOneBy("token", token);
    const customer = session ? polar.customers.findOneBy("polar_id", session.customer_id) : undefined;
    if (!session || !customer || Date.now() >= Date.parse(session.expires_at)) {
      return c.html(
        renderSettingsPage("Customer portal", "", '<p class="empty">Invalid or expired session.</p>', SERVICE_LABEL),
        401,
      );
    }
    const subscriptions = liveSubscriptions(polar)
      .filter((subscription) => subscription.customer_id === customer.polar_id)
      .map((subscription) => rolloverSubscription(polar, subscription));
    const rows = subscriptions.length
      ? subscriptions
          .map((subscription) => {
            const product = polar.products.findOneBy("polar_id", subscription.product_id);
            const action = subscription.cancel_at_period_end ? "resume" : "cancel";
            const label = subscription.cancel_at_period_end ? "Resume" : "Cancel at period end";
            return `<div class="org-row">
  <div class="org-icon">${escapeHtml((product?.name ?? "P").charAt(0).toUpperCase())}</div>
  <div class="user-text">
    <div class="org-name">${escapeHtml(product?.name ?? subscription.product_id)}</div>
    <div class="user-meta">${escapeHtml(subscription.status)} · period ends ${escapeHtml(subscription.current_period_end)}</div>
  </div>
  <form method="post" action="/portal/subscriptions/${escapeAttr(subscription.polar_id)}/${action}">
    <input type="hidden" name="customer_session_token" value="${escapeAttr(token)}"/>
    <button class="btn-revoke" type="submit">${label}</button>
  </form>
</div>`;
          })
          .join("")
      : '<p class="empty">No subscriptions</p>';
    const sidebar = `<a class="active" href="/portal?customer_session_token=${escapeAttr(token)}">Subscriptions</a>${
      session.return_url ? `<a href="${escapeAttr(session.return_url)}">Back</a>` : ""
    }`;
    const body = `<div class="s-card">
  <div class="s-card-header">
    <div class="s-icon">${escapeHtml(customer.email.charAt(0).toUpperCase())}</div>
    <div><div class="s-title">Subscriptions</div><div class="s-subtitle">${escapeHtml(customer.email)}</div></div>
  </div>
  ${rows}
</div>`;
    return c.html(renderSettingsPage("Customer portal", sidebar, body, SERVICE_LABEL));
  });

  const updateCancellation = (cancel: boolean) => async (c: Context<AppEnv>) => {
    const polar = ps();
    const form = await c.req.parseBody();
    const token = typeof form.customer_session_token === "string" ? form.customer_session_token : "";
    const session = polar.customerSessions.findOneBy("token", token);
    const subscription = polar.subscriptions.findOneBy("polar_id", c.req.param("id"));
    if (!session || !subscription || subscription.customer_id !== session.customer_id) {
      return c.html(renderSettingsPage("Customer portal", "", '<p class="empty">Not found.</p>', SERVICE_LABEL), 404);
    }
    polar.subscriptions.update(subscription.id, {
      cancel_at_period_end: cancel,
      canceled_at: cancel ? new Date().toISOString() : null,
      ends_at: cancel ? subscription.current_period_end : null,
    });
    return c.redirect(`/portal?customer_session_token=${encodeURIComponent(token)}`, 303);
  };

  app.post("/portal/subscriptions/:id/cancel", updateCancellation(true));
  app.post("/portal/subscriptions/:id/resume", updateCancellation(false));
}
