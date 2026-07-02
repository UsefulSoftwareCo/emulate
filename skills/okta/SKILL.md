---
name: okta
description: Emulated Okta OAuth/OIDC and management APIs for local development and testing. Use when the user needs Okta users, groups, apps, authorization servers, OAuth clients, token flows, introspection, revocation, or OIDC discovery.
allowed-tools: Bash(npx emulate:*), Bash(curl:*)
---

# Okta Emulator

Stateful Okta identity provider emulation with OAuth 2.0, OIDC, users, groups, apps, and authorization servers.

## Start

```bash
npx emulate --service okta
```

When all services run together, Okta uses `http://localhost:4006`.

## Credentials

Create an OAuth/OIDC client:

```bash
curl -X POST "$OKTA_EMULATOR_URL/_emulate/credentials" \
  -H "Content-Type: application/json" \
  -d '{"type":"oauth-authorization-code","redirect_uris":["http://localhost:3000/callback"]}'
```

## Discovery

Inspect `GET /_emulate/manifest` first to confirm supported surfaces (OAuth 2.0, OIDC, management APIs), auth capabilities, and per-operation spec coverage. Use `GET /_emulate/connections` for copyable SDK, CLI, env, and curl snippets and `GET /_emulate/quickstart` for setup notes.

Mint credentials with `POST /_emulate/credentials`, the canonical, uniform way to create a credential for any service (here an OAuth/OIDC client, as shown above). Inspect calls with `GET /_emulate/ledger`: each entry includes a correlation id (set `X-Correlation-Id` on a request to trace it), the matched route and operation id, sanitized headers and body, authenticated identity, response status, side effects, and webhook deliveries. Use `POST /_emulate/seed` to add runtime seed data and `POST /_emulate/reset` to replay seeds. Use `POST /_emulate/faults` to arm one-shot failures; matching faulted requests show `faulted: true` and `faultId` in the ledger.

Hosted Okta is at `https://okta.emulators.dev` (the bare service host is useful without an instance) with instance hosts of the form `okta.<instance>.emulators.dev`. The apex `https://emulators.dev` is a links-out catalog of every emulator; discover the same catalog machine-readably at `GET /_emulate/services` from any host. Per-service docs live at `https://docs.emulators.dev/okta`.
