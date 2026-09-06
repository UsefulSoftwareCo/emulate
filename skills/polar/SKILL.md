---
name: polar
description: Emulated Polar billing API for customers, subscription products, usage meters, benefits, hosted checkout, and customer portal flows. Use when the user needs Polar billing behavior without calling real Polar.
allowed-tools: Bash(npx emulate:*), Bash(curl:*)
---

# Polar Emulator

Use the Polar emulator for stateful subscription and usage-based billing tests through the official `@polar-sh/sdk` client. It supports customers, meters, events, benefits, products, subscriptions, hosted checkout, customer sessions, and customer state.

## Start

```bash
npx emulate --service polar
```

When all services run together, Polar uses `http://localhost:4019`. Any non-empty bearer token is accepted.

## Connect the official SDK

```ts
import { Polar } from "@polar-sh/sdk";

const polar = new Polar({
  accessToken: "polar_oat_test",
  serverURL: "http://localhost:4019",
});

const state = await polar.customers.getStateExternal({ externalId: "customer_123" });
```

## Seed billing state

Seed meters, benefits, and products before customers so references can resolve by name. Customers can include subscriptions that refer to products by name or ID.

```bash
curl -X POST "$POLAR_EMULATOR_URL/_emulate/seed" -H "Content-Type: application/json" -d '{
  "meters": [{
    "name": "API calls",
    "filter": { "conjunction": "and", "clauses": [{ "property": "name", "operator": "eq", "value": "api.call" }] },
    "aggregation": { "func": "sum", "property": "count" }
  }],
  "benefits": [{
    "type": "meter_credit", "description": "100 API calls", "meter": "API calls", "units": 100
  }],
  "products": [{
    "name": "Free", "recurring_interval": "month",
    "prices": [{ "amount_type": "fixed", "price_amount": 0, "price_currency": "usd" }],
    "benefits": ["100 API calls"]
  }],
  "customers": [{
    "external_id": "customer_123", "email": "customer@example.com",
    "subscriptions": [{ "product": "Free", "status": "active" }]
  }]
}'
```

Meters, benefits, and products are upserted by name or description. Customers are upserted by external ID.

## Exercise usage billing

Ingest events with a Polar customer ID or your external customer ID. Metadata values feed `sum`, `max`, `min`, `avg`, and `unique` aggregations.

```ts
await polar.events.ingest({
  events: [
    {
      name: "api.call",
      externalCustomerId: "customer_123",
      metadata: { count: 3 },
    },
  ],
});

const state = await polar.customers.getStateExternal({ externalId: "customer_123" });
```

Events for an unknown external customer remain stored and begin counting after that customer is created.

## Complete a checkout

Create paid subscriptions with `polar.checkouts.create`. Open the returned `url`, submit the hosted form, then account for the deliberate state delay. Call the settle route for deterministic tests:

```bash
curl -X POST "$POLAR_CHECKOUT_URL/settle"
```

Seed `checkout.settle_delay_ms` to control automatic settlement. The default is 2500 milliseconds. A value of `null` disables automatic settlement.

## Inspect calls and inject faults

Inspect requests at `GET /_emulate/ledger`. Arm a failure by the official operation ID:

```bash
curl -X POST "$POLAR_EMULATOR_URL/_emulate/faults" -H "Content-Type: application/json" -d '{
  "match": { "operationId": "customers:get_state_external" },
  "response": { "status": 503 },
  "times": 1
}'
```

Clear faults with `DELETE /_emulate/faults`. Reset state and the ledger with `POST /_emulate/reset`.
