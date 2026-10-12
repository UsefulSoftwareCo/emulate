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
- `POST /v1.0/me/messages` - create a JSON draft with optional file attachments
- `PATCH /v1.0/me/messages/:id` - update a draft's subject, body, sender or recipients
- `POST /v1.0/me/messages/:id/createReply` - create a reply draft in the original conversation
- `POST /v1.0/me/messages/:id/send` - send a draft with an empty 202 response
- `GET/POST /v1.0/me/messages/:id/attachments` - list or add file attachments
- `GET /v1.0/me/messages/:id/attachments/:attachmentId` - fetch a file attachment
- `GET /v1.0/me/messages/:id/attachments/:attachmentId/$value` - download raw file bytes
- `POST /v1.0/me/sendMail` — send mail and optionally save to sent items
- `GET /v1.0/me/calendars` — calendars
- `GET /v1.0/me/events` — calendar events
- `POST /v1.0/me/events` — create calendar event
- `GET /v1.0/me/drive` — OneDrive
- `GET /v1.0/me/drive/root/children` — OneDrive root children
- `POST /v1.0/me/drive/root/children` — create a OneDrive folder
- `PUT /v1.0/me/drive/root:/{path}:/content` — create or replace file bytes by path
- `GET /v1.0/me/drive/items/:id/content` — redirect to file bytes
- `PUT /v1.0/me/drive/items/:id/content` — replace file bytes by item ID
- `GET /v1.0/drives/:driveId/root/children` — drive-scoped OneDrive root children
- `GET/PUT /v1.0/drives/:driveId/items/:itemId/content` — drive-scoped file bytes
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

Seeded `drive_items[].content` is a plain UTF-8 string. The emulator stores file bytes internally as base64 so binary uploads round-trip byte-exact through the content endpoints.

## Links

- [Full documentation](https://emulate.dev/microsoft)
- [GitHub](https://github.com/vercel-labs/emulate)

## Drafts, replies, and file attachments

Use a delegated token with `Mail.ReadWrite` to create and update drafts or attach files, `Mail.Send` to send, and `Mail.Read` or `Mail.ReadWrite` to read messages and attachments. Every route is scoped to the signed-in mailbox.

A compose flow is `POST /v1.0/me/messages` followed by `POST /v1.0/me/messages/:id/send`. A reply flow is `POST /v1.0/me/messages/:id/createReply`, `PATCH /v1.0/me/messages/:draftId`, optional attachment POSTs, then send. Draft and attachment creation return 201; PATCH returns 200; send returns 202 with no body. Sending moves the existing draft to `sentitems`, preserving its ID, conversation and attachments. Repeated sends of the same draft fail. No mail leaves the emulator.

JSON drafts support `subject`, `body`, `from`, `sender`, `toRecipients`, `ccRecipients`, `bccRecipients`, `replyTo`, and `attachments`. PATCH supports the same fields except attachments, which must use the attachment endpoint. Reply drafts retain the original `conversationId` and use the original `replyTo`, falling back to `from`. Supply either `comment` or `message.body`, or omit the reply request body and PATCH later. Original attachments and quoted original body are not copied.

Attachments must have `@odata.type: "#microsoft.graph.fileAttachment"`, `name`, and base64 `contentBytes`. Optional fields are `contentType`, `isInline`, and `contentId`. Decoded files must be smaller than 3 MB (3,145,728 bytes). Attachment GET returns base64; `/$value` returns the original bytes. Inline-only attachments do not set `hasAttachments`.

This is a curated JSON subset. MIME, item/reference attachments, upload sessions, `/users` and mail-folder mail routes, attachment OData query options, and provider delivery are not implemented. IDs stay stable even without `Prefer: IdType="ImmutableId"`; the emulator does not model default Outlook ID changes. Use `/_emulate/coverage` to inspect these limits and `/_emulate/ledger` to inspect mutations. A fault armed for `message_Send` fails before the draft changes; it does not simulate delivery followed by a lost response.
