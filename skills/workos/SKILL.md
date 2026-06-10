---
name: workos
description: Emulated WorkOS APIs (AuthKit user management, organizations, memberships, invitations, API keys, Vault KV, OAuth authorization server) for local development and testing. Use when the user needs WorkOS auth flows or sealed sessions without calling real WorkOS.
allowed-tools: Bash(npx emulate:*), Bash(curl:*)
---

# WorkOS Emulator

Stateful WorkOS emulation: AuthKit hosted login, authorization-code and refresh grants, sealed-session JWKS, organizations, memberships, invitations, user API keys, Vault KV, and an OAuth authorization server suitable for MCP clients.

## Start

```bash
npx emulate --service workos
```

When all services run together, WorkOS uses `http://localhost:4014`.

## Point the real SDK at it

The official `@workos-inc/node` SDK works unmodified, including sealed-session crypto:

```ts
import { WorkOS } from "@workos-inc/node";

const workos = new WorkOS("sk_test_anything", {
  clientId: "client_emulate",
  apiHostname: "localhost",
  port: 4014,
  https: false,
});
```

Sealed sessions are sealed and unsealed locally by the SDK with your cookie password; the emulator signs access tokens with RS256 and serves the JWKS the SDK verifies against at `/sso/jwks/:clientId`.

## Headless sign-in

`GET /user_management/authorize?login_hint=<email>&redirect_uri=...&client_id=...` redirects straight back with a code for that user, creating the user if new. Without `login_hint`, a hosted login page renders with user buttons and a new-user form.

## Other surfaces

- OAuth authorization server for MCP clients: `/.well-known/oauth-authorization-server`, `/oauth2/register`, `/oauth2/authorize`, `/oauth2/token`, `/oauth2/jwks`. Set `EMULATE_WORKOS_AUDIENCE` to control the `aud` claim resource servers verify.
- Vault KV: `POST /vault/v1/kv`, `GET /vault/v1/kv/name/:name`, `PUT /vault/v1/kv/:id`, `DELETE /vault/v1/kv/:id`.

## Seed

```bash
curl -X POST "$WORKOS_EMULATOR_URL/_emulate/seed" -H "Content-Type: application/json" -d '{
  "users": [{ "email": "admin@example.com", "first_name": "Admin" }],
  "organizations": [{ "name": "Acme", "members": ["admin@example.com"] }]
}'
```

Inspect calls at `GET /_emulate/ledger`; reset with `POST /_emulate/reset`.
