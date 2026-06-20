# @emulators/microsoft

Microsoft Entra ID (Azure AD) v2.0 OAuth 2.0 and OpenID Connect emulation with authorization code flow, PKCE, client credentials, RS256 ID tokens, OIDC discovery, and a curated Microsoft Graph subset.

Part of [emulate](https://github.com/vercel-labs/emulate) — local drop-in replacement services for CI and no-network sandboxes.

## Install

```bash
npm install @emulators/microsoft
```

## Endpoints

- `GET /.well-known/openid-configuration` — OIDC discovery document
- `GET /:tenant/v2.0/.well-known/openid-configuration` — tenant-scoped OIDC discovery
- `GET /discovery/v2.0/keys` — JSON Web Key Set (JWKS)
- `GET /oauth2/v2.0/authorize` — authorization endpoint (shows user picker)
- `POST /oauth2/v2.0/token` — token exchange (authorization code, refresh token, client credentials)
- `GET /oidc/userinfo` — OpenID Connect user info
- `GET /v1.0/me` — Microsoft Graph user profile
- `GET /v1.0/users` — Microsoft Graph users
- `GET /v1.0/users/:id` — Microsoft Graph user by ID
- `GET /v1.0/me/messages` — Outlook mail messages
- `POST /v1.0/me/sendMail` — send mail and optionally save to sent items
- `GET /v1.0/me/calendars` — calendars
- `GET /v1.0/me/events` — calendar events
- `POST /v1.0/me/events` — create calendar event
- `GET /v1.0/me/drive` — OneDrive
- `GET /v1.0/me/drive/root/children` — OneDrive root children
- `GET /oauth2/v2.0/logout` — end session / logout
- `POST /oauth2/v2.0/revoke` — token revocation

## Auth

OIDC authorization code flow with PKCE support. Also supports client credentials grants using `scope=https://graph.microsoft.com/.default`. Delegated tokens can call `/v1.0/me`, mail, calendar, and drive routes. App-only tokens can call `/v1.0/users` and `/v1.0/users/:id`; `/v1.0/me` intentionally returns 403 for app-only tokens.

## Seed Configuration

```yaml
microsoft:
  users:
    - email: testuser@outlook.com
      name: Test User
  oauth_clients:
    - client_id: example-client-id
      client_secret: example-client-secret
      name: My Microsoft App
      redirect_uris:
        - http://localhost:3000/api/auth/callback/microsoft-entra-id
  messages:
    - subject: Welcome
      body: Seeded Outlook message
      from: sender@example.com
  events:
    - subject: Customer call
      start_date_time: "2026-07-01T09:00:00"
      end_date_time: "2026-07-01T09:30:00"
  drive_items:
    - name: Project Notes.txt
      mime_type: text/plain
      content: Notes
```

## Links

- [Full documentation](https://emulate.dev/microsoft)
- [GitHub](https://github.com/vercel-labs/emulate)
