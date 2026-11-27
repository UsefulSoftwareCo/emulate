---
name: x
description: Emulated X (Twitter) API v2 for local development and testing. Use when the user needs X OAuth 2.0, users, Posts, direct messages, DM media, webhooks with X Activity API DM events, or X rate limits without calling the real X API.
allowed-tools: Bash(npx emulate:*), Bash(curl:*)
---

# X Emulator

Stateful X API v2 emulation: OAuth 2.0 (Authorization Code with PKCE, app-only Bearer), users, Posts, direct messages, DM media upload and download, webhooks with the CRC and X Activity API DM events, and X's per-endpoint rate limits.

## Start

```bash
npx emulate --service x
```

When all services run together, X uses `http://localhost:4013`.

## Credentials

Run `/2/oauth2/authorize` and `/2/oauth2/token` with scopes such as `dm.read dm.write media.write tweet.read users.read offline.access`, or mint an app-only token:

```bash
curl -s -X POST "$X_EMULATOR_URL/2/oauth2/token" \
  -u "x-confidential-client:x-confidential-secret" \
  -d grant_type=client_credentials
```

DM reads need `dm.read`, `tweet.read`, `users.read`; sends need `dm.write`, `tweet.read`, `users.read`; uploads need `media.write`; DM media download needs `dm.read`. App-only tokens cannot read or send DMs.

## Direct messages

- `GET /2/dm_events`, `GET /2/dm_conversations/with/:participant_id/dm_events`, `GET /2/dm_conversations/:id/dm_events`
- `POST /2/dm_conversations/with/:participant_id/messages`, `POST /2/dm_conversations/:dm_conversation_id/messages`
- `max_results`, `pagination_token`, `dm_event.fields`, `expansions=attachments.media_keys,sender_id`, `media.fields`

Seed a large history with `dm_conversations[].generate` or `dm_bulk` (computed on demand, never stored).

## Media

Upload with `POST /2/media/upload` or the chunked `initialize`/`append`/`finalize`, attach with `attachments: [{ media_id }]`, and download from the `url` in `includes.media` (`GET /2/dm_conversations/media/:dm_id/:media_key/:media_id`, streamed).

## Webhooks

Register with `POST /2/webhooks` (X sends a CRC first), subscribe with `POST /2/activity/subscriptions` (`dm.sent`, `dm.received`). Deliveries are signed in `X-Twitter-Webhooks-Signature-OAuth2` with the client secret.

When the emulator cannot reach the app under test:

```bash
# Emulator mode: hold CRC challenges for the test to deliver itself.
curl -X POST "$X_EMULATOR_URL/_emulate/x/webhooks/crc-delivery" -H "Content-Type: application/json" -d '{"mode":"control"}'
curl "$X_EMULATOR_URL/_emulate/x/webhooks/$WEBHOOK_ID/challenge"

# Make a message arrive, then fetch the exact signed delivery without sending it.
curl -X POST "$X_EMULATOR_URL/_emulate/x/dm/arrive" -H "Content-Type: application/json" \
  -d '{"to":"developer","from":"alice","text":"hi"}'
curl -X POST "$X_EMULATOR_URL/_emulate/x/dm/preview-delivery" -H "Content-Type: application/json" \
  -d '{"dm_event_id":"'"$DM_EVENT_ID"'"}'
```

## Rate limits

Responses carry `x-rate-limit-limit`, `x-rate-limit-remaining`, `x-rate-limit-reset` (epoch seconds); spent windows answer `429` with `{"errors":[{"code":88,"message":"Rate limit exceeded"}]}`. Set a limit per instance:

```bash
curl -X POST "$X_EMULATOR_URL/_emulate/x/rate-limits" -H "Content-Type: application/json" \
  -d '{"endpoints":{"getDirectMessagesEvents":{"limit":3,"window_seconds":5}}}'
```

## Discovery

Read `GET /_emulate/manifest` for supported, partial and unsupported operations (the Account Activity API, which X deprecated, is unsupported). Count upstream calls with `GET /_emulate/ledger`: each entry has the operation id, status and authenticated user, including 429s. Webhook deliveries are in `GET /_emulate/logs`. Per-service docs live at `https://docs.emulators.dev/x`.
