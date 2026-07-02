---
name: spotify
description: Emulated Spotify Web API for local development and testing. Use when the user needs OAuth client credentials, catalog search, artist, album, or track APIs without calling real Spotify.
allowed-tools: Bash(npx emulate:*), Bash(curl:*)
---

# Spotify Emulator

Stateful Spotify Web API emulation focused on Client Credentials OAuth and catalog APIs.

## Start

```bash
npx emulate --service spotify
```

When all services run together, Spotify uses `http://localhost:4012`.

## Credentials

Create a client credentials app:

```bash
curl -X POST "$SPOTIFY_EMULATOR_URL/_emulate/credentials" \
  -H "Content-Type: application/json" \
  -d '{"type":"oauth-client-credentials","name":"Catalog Test"}'
```

Exchange the returned client credentials:

```bash
curl -X POST "$SPOTIFY_EMULATOR_URL/api/token" \
  -u "$SPOTIFY_CLIENT_ID:$SPOTIFY_CLIENT_SECRET" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=client_credentials"
```

## Discovery

Inspect `GET /_emulate/manifest` first to confirm supported surfaces (Web API, Client Credentials OAuth), auth capabilities, and per-operation spec coverage. Use `GET /_emulate/openapi` for the OpenAPI document, `GET /_emulate/connections` for copyable SDK, CLI, env, and curl snippets, and `GET /_emulate/quickstart` for setup notes.

Mint credentials with `POST /_emulate/credentials`, the canonical, uniform way to create a credential for any service (here a Client Credentials app, as shown above). Inspect calls with `GET /_emulate/ledger`: each entry includes a correlation id (set `X-Correlation-Id` on a request to trace it), the matched route and operation id, sanitized headers and body, authenticated identity, response status, side effects, and webhook deliveries. Use `POST /_emulate/seed` to add runtime seed data and `POST /_emulate/reset` to replay seeds. Use `POST /_emulate/faults` to arm one-shot failures; matching faulted requests show `faulted: true` and `faultId` in the ledger.

Hosted Spotify is at `https://spotify.emulators.dev` (the bare service host is useful without an instance) with instance hosts of the form `spotify.<instance>.emulators.dev`. The apex `https://emulators.dev` is a links-out catalog of every emulator; discover the same catalog machine-readably at `GET /_emulate/services` from any host. Per-service docs live at `https://docs.emulators.dev/spotify`.
