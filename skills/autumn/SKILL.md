---
name: autumn
description: Emulated Autumn billing API (customers with seedable subscriptions, a seedable plan catalog with eligibility, usage tracking, and a hosted checkout flow) for local development and testing. Use when the user needs Autumn billing behavior without calling real Autumn.
allowed-tools: Bash(npx emulate:*), Bash(curl:*)
---

# Autumn Emulator

Stateful Autumn billing emulation: customers (get_or_create), seedable subscriptions, a seedable plan catalog with per-customer eligibility (`plans.list`), usage tracking (`balances.track`), feature access checks (`balances.check`), `billing.attach` / `billing.open_customer_portal`, and a hosted checkout flow for paid plans and card-required free trials.

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

## Seed the plan catalog and customers

The emulator has no plan sync, so seed the plans your app advertises (these drive `plans.list` eligibility and `billing.attach`). A plan with a `price` or a card-required `free_trial` routes attach through hosted checkout.

```bash
curl -X POST "$AUTUMN_EMULATOR_URL/_emulate/seed" -H "Content-Type: application/json" -d '{
  "plans": [
    { "id": "free", "name": "Free", "auto_enable": true },
    { "id": "team", "name": "Team", "price": { "amount": 150, "interval": "month" },
      "free_trial": { "duration_length": 14, "duration_type": "day", "card_required": true } }
  ],
  "customers": [{ "id": "org_123", "subscriptions": [{ "plan_id": "team", "status": "active" }] }]
}'
```

## Check feature access

`balances.check` answers whether a customer can use a feature, computed from the same plan items and tracked usage that drive customer balances. Unlimited and overage-allowed features always pass; metered features pass while remaining balance covers `required_balance` (default 1). A feature the customer's plan does not carry is allowed with a `null` balance.

```ts
const { allowed } = await autumn.check({ customerId: "org_123", featureId: "executions" });
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

Inspect calls at `GET /_emulate/ledger`; reset with `POST /_emulate/reset`. Use `POST /_emulate/faults` to arm one-shot failures; matching faulted requests show `faulted: true` and `faultId` in the ledger.
