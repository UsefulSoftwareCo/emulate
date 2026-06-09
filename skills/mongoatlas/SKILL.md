---
name: mongoatlas
description: Emulated MongoDB Atlas Admin API and Data API for local development and testing. Use when the user needs projects, clusters, database users, databases, collections, or Data API document operations without calling real Atlas.
allowed-tools: Bash(npx emulate:*), Bash(curl:*)
---

# MongoDB Atlas Emulator

Stateful MongoDB Atlas Admin API and Data API emulation.

## Start

```bash
npx emulate --service mongoatlas
```

When all services run together, MongoDB Atlas uses `http://localhost:4010`.

## Credentials

Create an API-key style bearer credential:

```bash
curl -X POST "$MONGOATLAS_EMULATOR_URL/_emulate/credentials" \
  -H "Content-Type: application/json" \
  -d '{"type":"api-key","login":"admin"}'
```

Use the returned token as a bearer token for Admin API and Data API calls.

## Discovery

Inspect `GET /_emulate/manifest` first to confirm supported surfaces (Atlas Admin API, Data API), auth capabilities, and per-operation spec coverage. Use `GET /_emulate/connections` for copyable SDK, CLI, env, and curl snippets and `GET /_emulate/quickstart` for setup notes.

Mint credentials with `POST /_emulate/credentials`, the canonical, uniform way to create a credential for any service (here an API-key style bearer credential, as shown above). Inspect calls with `GET /_emulate/ledger`: each entry includes a correlation id (set `X-Correlation-Id` on a request to trace it), the matched route and operation id, sanitized headers and body, authenticated identity, response status, side effects, and webhook deliveries. Use `POST /_emulate/seed` to add runtime seed data and `POST /_emulate/reset` to replay seeds.

Hosted MongoDB Atlas is at `https://mongoatlas.emulators.dev` (the bare service host is useful without an instance) with instance hosts of the form `mongoatlas.<instance>.emulators.dev`. The apex `https://emulators.dev` is a links-out catalog of every emulator; discover the same catalog machine-readably at `GET /_emulate/services` from any host. Per-service docs live at `https://docs.emulators.dev/mongoatlas`.
