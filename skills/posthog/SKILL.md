---
name: posthog
description: Emulated PostHog API for local development and testing. Use when the user needs PostHog OpenAPI discovery, Client ID Metadata Document OAuth, projects, users, or events without calling real PostHog.
allowed-tools: Bash(npx emulate:*), Bash(curl:*)
---

# PostHog Emulator

Stateful PostHog API emulation focused on OpenAPI OAuth discovery and Client ID Metadata Document OAuth.

## Start

```bash
npx emulate --service posthog
```

When all services run together, PostHog uses `http://localhost:4016`.

## OpenAPI

Use the PostHog-shaped schema endpoint:

```bash
curl "$POSTHOG_EMULATOR_URL/api/schema/"
```

The schema intentionally declares only a bearer security scheme. OAuth is discovered from metadata at `/.well-known/oauth-protected-resource` and `/.well-known/oauth-authorization-server`, matching real PostHog.

## CIMD OAuth

The authorization server metadata includes `client_id_metadata_document_supported: true`. Use a `client_id` that is the URL of an OAuth Client ID Metadata Document containing `redirect_uris`, `grant_types`, `response_types`, and `token_endpoint_auth_method`.

For local tests, loopback HTTP metadata URLs are accepted. Non-HTTPS, non-loopback metadata URLs are rejected with PostHog's invalid `client_id` error shape.

## Discovery

Inspect `GET /_emulate/manifest` first to confirm supported surfaces, auth capabilities, and per-operation spec coverage. Use `GET /_emulate/openapi` for the OpenAPI document, `GET /_emulate/connections` for copyable snippets, and `GET /_emulate/quickstart` for setup notes.

Inspect calls with `GET /_emulate/ledger`: each entry includes a correlation id, matched route, sanitized headers and body, authenticated identity, response status, side effects, and webhook deliveries. Use `POST /_emulate/seed` to add users, projects, and events, and `POST /_emulate/reset` to replay seeds. Use `POST /_emulate/faults` to arm one-shot failures; matching faulted requests show `faulted: true` and `faultId` in the ledger.

Hosted PostHog is at `https://posthog.emulators.dev` with instance hosts of the form `posthog.<instance>.emulators.dev`. Per-service docs live at `https://docs.emulators.dev/posthog`.
