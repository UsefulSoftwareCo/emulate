---
name: autumn
description: Emulated Autumn billing API (customers with auto_enable_plan_id, a seedable feature and plan catalog with eligibility, atomic check-and-consume metering, subscription cancellation, and a hosted checkout flow) for local development and testing. Use when the user needs Autumn billing behavior without calling real Autumn.
allowed-tools: Bash(npx emulate:*), Bash(curl:*)
---

# Autumn Emulator

Stateful Autumn billing emulation: customers (`customers.get_or_create`, including `auto_enable_plan_id`), a seedable feature and plan catalog with per-customer eligibility (`plans.list`, `features.list`), usage tracking (`balances.track`), balance reconciliation (`balances.update`), feature access checks with atomic check-and-consume (`balances.check`), subscription changes (`billing.update`), `billing.attach` / `billing.setup_payment` / `billing.open_customer_portal`, a hosted checkout flow for paid plans and card-required free trials, a hosted setup flow for putting a card on file, and a hosted billing portal for changing it.

The request and response shapes, status codes and error codes below were taken from the real Autumn sandbox API at `x-api-version: 2.3.0` rather than from the docs, so an application can point at the emulator with no emulator-specific branches.

## Start

```bash
npx emulate --service autumn
```

When all services run together, Autumn uses `http://localhost:4015`.

## Point the real SDK at it

```ts
import { Autumn } from "autumn-js";

const autumn = new Autumn({ secretKey: "am_test_anything", serverURL: "http://localhost:4015" });
const customer = await autumn.customers.getOrCreate({ customerId: "org_123" });
```

## Seed the feature and plan catalog

The emulator has no plan sync, so seed the catalog your app advertises. Seed it with the same ids your provisioner creates in real Autumn, and the same application code works against both.

Plans that share a `group` are mutually exclusive: attaching one replaces the customer's subscription to another in the group. A plan with a `price` or a card-required `free_trial` routes attach through hosted checkout. A plan with `auto_enable: true` is attached to every new customer that does not name one through `auto_enable_plan_id`.

Seeding `features` is optional, since every feature a plan item references is already part of the catalog. Seed them to control a name, type, or consumable flag.

```bash
curl -X POST "$AUTUMN_EMULATOR_URL/_emulate/seed" -H "Content-Type: application/json" -d '{
  "features": [
    { "id": "app-stage-executions", "name": "Executions", "type": "metered", "consumable": true },
    { "id": "app-stage-members", "name": "Members", "type": "metered", "consumable": false }
  ],
  "plans": [
    { "id": "app-stage-free", "name": "Free", "group": "app-stage", "items": [
      { "feature_id": "app-stage-members", "included": 3, "unlimited": false },
      { "feature_id": "app-stage-executions", "included": 100000, "unlimited": false, "reset": { "interval": "month" } }
    ] },
    { "id": "app-stage-team", "name": "Team", "group": "app-stage",
      "free_trial": { "duration_length": 14, "duration_type": "day", "card_required": true },
      "items": [
        { "feature_id": "app-stage-members", "included": 0, "unlimited": false,
          "price": { "amount": 15, "billing_units": 1, "billing_method": "usage_based", "interval": "month" } },
        { "feature_id": "app-stage-executions", "included": 0, "unlimited": true, "reset": { "interval": "month" } }
      ] }
  ],
  "customers": [{ "id": "org_123", "subscriptions": [{ "plan_id": "app-stage-team", "status": "active" }] }]
}'
```

Seeding is additive: a second seed call updates the plans it names and leaves the rest alone. `POST /_emulate/reset` clears state and replays the seed.

## Start a customer on a plan

`auto_enable_plan_id` names the plan a NEW customer starts on, replacing the catalog's own `auto_enable` defaults. The plan's features are granted with the subscription, so the first read already carries the balances.

```ts
const customer = await autumn.customers.getOrCreate({
  customerId: "org_123",
  autoEnablePlanId: "app-stage-free",
});
// customer.subscriptions -> [{ planId: "app-stage-free", status: "active", ... }]
// customer.balances["app-stage-executions"] -> { granted: 100000, remaining: 100000, usage: 0, unlimited: false }
```

The call is idempotent the way real Autumn is: an existing customer is never re-subscribed, and naming a different plan for one does nothing. An unknown plan id 404s with `product_not_found`.

## Check feature access, and consume in the same call

`balances.check` answers whether a customer can use a feature, computed from the same plan items and tracked usage that drive customer balances. Unlimited features and priced (overage) items always pass; metered features pass while the remaining balance covers `required_balance` (default 1).

With `send_event: true` the check also consumes `required_balance`. This is one atomic step: a denied check consumes nothing, and concurrent callers cannot both spend the last unit. Use it to admit metered work.

```ts
const { allowed, balance } = await autumn.check({
  customerId: "org_123",
  featureId: "app-stage-executions",
  requiredBalance: 1,
  sendEvent: true,
});
// allowed === false means the balance was insufficient AND nothing was deducted.
```

Because it consumes, a lost response is not evidence that nothing was spent: do not retry a mutating check automatically.

Three outcomes, matching real Autumn:

| Case | Response |
| --- | --- |
| Feature the catalog does not declare | `404 { "code": "feature_not_found" }` |
| Declared feature no active subscription grants | `200 { "allowed": false, "balance": null }` |
| Granted feature | `200` with the balance after any deduction |

## Cancel a subscription

Autumn identifies a subscription by customer and plan, so cancelling is an update carrying a `cancel_action`.

```ts
await autumn.billing.update({
  customerId: "org_123",
  planId: "app-stage-team",
  cancelAction: "cancel_immediately",
});
```

- `cancel_immediately` ends the subscription now. The next customer read shows neither the subscription nor its balances.
- `cancel_end_of_cycle` keeps the subscription active and records `canceled_at` and `expires_at`. Autumn rejects it with `400 invalid_request` for a plan that bills nothing.
- `uncancel` clears a scheduled cancellation.

Omit `plan_id` to apply the action to every live subscription. A plan the customer does not hold 404s with `cus_product_not_found`; an update with no action at all is a `400 invalid_inputs`.

Attaching a plan after an immediate cancel issues fresh grants, so usage starts from zero rather than inheriting the cancelled subscription's consumption.

## Set a balance directly

`balances.update` sets a customer's balance for one feature. Exactly one of `usage`, `remaining`, or `add_to_balance` is required. Use it for continuous-use features (seats, storage) where the app reconciles an absolute count rather than tracking deltas. The update is recorded as an adjustment event, so `events.list` shows the reconciliation and `balances.check` stays consistent. Unknown customers 404 with `customer_not_found`; a feature the customer's plan does not carry 404s with `not_found`.

Once a customer has more than 64 usage events for a feature, the emulator rolls up adjacent events into one event carrying their total. It only rolls up events that no subscription watermark or current reset window separates, so every balance stays the same. `events.list` then returns the rolled-up events, and storage stays bounded however many checks consume usage.

```ts
await autumn.balances.update({ customerId: "org_123", featureId: "members", usage: 12 });
```

## Checkout flow

`billing.attach` for a paid or card-required-trial plan returns a `payment_url` to a hosted checkout page. Completing it (`POST /checkout/:sessionId/complete`) redirects to the app's `success_url` but does NOT activate the subscription yet, mirroring Stripe: activation lands only when the webhook is processed. Settle it to activate:

```bash
# land the "checkout.session.completed" webhook for a customer
curl -X POST "$AUTUMN_EMULATOR_URL/checkout/settle" -H "Content-Type: application/json" \
  -d '{ "customer_id": "org_123" }'
# or settle one session: POST /checkout/:sessionId/settle
```

This deferral lets a test reproduce the real "page is stale until reload" race: the redirect back lands before the subscription is active.

## Putting a card on file

`billing.setupPayment({ customerId, successUrl })` returns `{ customer_id, url }`, where `url` is a hosted setup page (`GET /checkout/setup/:sessionId`). Submitting it (`POST /checkout/setup/:sessionId/complete` with `card_number` and `exp`) redirects to `success_url` but does NOT set the default card yet: that lands with the webhook, so settle the session (`POST /checkout/setup/:sessionId/settle`, or the customer-wide `POST /checkout/settle`).

A setup session never REPLACES an existing default card. This mirrors real Autumn, whose setup-checkout webhook handler reads the customer's current default payment method first and re-sets that same card when one exists. So the second setup session for a customer settles normally and leaves the old card in place. Use the billing portal to change a card.

## Changing the card on file (billing portal)

`billing.openCustomerPortal({ customerId, returnUrl })` returns `{ customer_id, url }` pointing at `GET /checkout/portal/:customerId`. The page shows the current plan, the card on file (or "No payment method"), a form to update the card, and a link back to `return_url` when one was given. Submitting the form (`POST /checkout/portal/:customerId/payment-method` with `card_number` and `exp`) changes the customer's card IMMEDIATELY, with no settle step: real Stripe owns the portal and swaps the default inside Stripe, and Autumn reads the card live on every expand. An unknown customer 404s.

Read the card back with `expand`:

```ts
const customer = await autumn.customers.getOrCreate({ customerId: "org_123", expand: ["payment_method"] });
// customer.paymentMethod: { id, type: "card", card: { brand, last4, exp_month, exp_year } } or null
```

Without `expand`, the field is omitted entirely, as in real Autumn. A paid checkout also leaves a visa 4242 on file when the customer had no card.

Inspect calls at `GET /_emulate/ledger`; reset with `POST /_emulate/reset`. Use `POST /_emulate/faults` to arm one-shot failures; matching faulted requests show `faulted: true` and `faultId` in the ledger.
