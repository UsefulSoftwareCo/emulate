---
name: autumn
description: Emulated Autumn billing API (customers with seedable subscriptions, usage tracking) for local development and testing. Use when the user needs Autumn billing behavior without calling real Autumn.
allowed-tools: Bash(npx emulate:*), Bash(curl:*)
---

# Autumn Emulator

Stateful Autumn billing emulation: customers (get_or_create), seedable subscriptions (e.g. a paid plan), usage tracking, and list endpoints for plans, features, and events.

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

## Seed a paid customer

```bash
curl -X POST "$AUTUMN_EMULATOR_URL/_emulate/seed" -H "Content-Type: application/json" -d '{
  "customers": [{ "id": "org_123", "subscriptions": [{ "plan_id": "pro", "status": "active" }] }]
}'
```

Inspect calls at `GET /_emulate/ledger`; reset with `POST /_emulate/reset`.
