---
name: clerk
description: Emulated Clerk authentication and user management APIs for local development and testing. Use when the user needs Clerk users, organizations, sessions, secret keys, or OAuth/OIDC flows without calling real Clerk.
allowed-tools: Bash(npx emulate:*), Bash(curl:*)
---

# Clerk Emulator

Stateful Clerk API emulation with secret-key management APIs and OAuth/OIDC flows.

## Start

```bash
npx emulate --service clerk
```

When all services run together, Clerk uses `http://localhost:4011`.

## Credentials

Create a secret key:

```bash
curl -X POST "$CLERK_EMULATOR_URL/_emulate/credentials" \
  -H "Content-Type: application/json" \
  -d '{"type":"api-key","login":"admin"}'
```

Create an OAuth client:

```bash
curl -X POST "$CLERK_EMULATOR_URL/_emulate/credentials" \
  -H "Content-Type: application/json" \
  -d '{"type":"oauth-authorization-code","redirect_uris":["http://localhost:3000/callback"]}'
```

## Discovery

Inspect `GET /_emulate/manifest` first to confirm supported surfaces (REST, OAuth/OIDC), auth capabilities, and per-operation spec coverage. Use `GET /_emulate/connections` for copyable SDK, CLI, env, and curl snippets and `GET /_emulate/quickstart` for setup notes.

Mint credentials with `POST /_emulate/credentials`, the canonical, uniform way to create a credential for any service (here a Clerk secret key or an OAuth client, as shown above). Inspect calls with `GET /_emulate/ledger`: each entry includes a correlation id (set `X-Correlation-Id` on a request to trace it), the matched route and operation id, sanitized headers and body, authenticated identity, response status, side effects, and webhook deliveries. Use `POST /_emulate/seed` to add runtime seed data and `POST /_emulate/reset` to replay seeds.

Hosted Clerk is at `https://clerk.emulators.dev` (the bare service host is useful without an instance) with instance hosts of the form `clerk.<instance>.emulators.dev`. The apex `https://emulators.dev` is a links-out catalog of every emulator; discover the same catalog machine-readably at `GET /_emulate/services` from any host. Per-service docs live at `https://docs.emulators.dev/clerk`.
