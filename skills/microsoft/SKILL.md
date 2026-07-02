---
name: microsoft
description: Emulated Microsoft Entra ID (Azure AD) OAuth 2.0 / OpenID Connect plus Microsoft Graph users, mail, calendar, and OneDrive for local development and testing. Use when the user needs to test Microsoft sign-in locally, emulate Entra ID OIDC discovery, handle Microsoft token exchange, configure Azure AD OAuth clients, work with Microsoft Graph /me, mail, calendar, or files, or test PKCE/client credentials flows without hitting real Microsoft APIs. Triggers include "Microsoft OAuth", "Entra ID", "Azure AD", "emulate Microsoft", "mock Microsoft login", "test Microsoft sign-in", "Microsoft OIDC", "local Microsoft auth", or any task requiring a local Microsoft OAuth/OIDC provider.
allowed-tools: Bash(npx emulate:*), Bash(emulate:*), Bash(curl:*)
---

# Microsoft Entra ID Emulator

Microsoft Entra ID (Azure AD) v2.0 OAuth 2.0 and OpenID Connect emulation with authorization code flow, PKCE, client credentials, RS256 ID tokens, OIDC discovery, and a Microsoft Graph subset for users, mail, calendar, and OneDrive.

## Start

```bash
# Microsoft only
npx emulate --service microsoft

# Default port (when run alone)
# http://localhost:4000
```

Or programmatically:

```typescript
import { createEmulator } from 'emulate'

const microsoft = await createEmulator({ service: 'microsoft', port: 4005 })
// microsoft.url === 'http://localhost:4005'
```

## Pointing Your App at the Emulator

### Environment Variable

```bash
MICROSOFT_EMULATOR_URL=http://localhost:4005
```

### OAuth URL Mapping

| Real Microsoft URL | Emulator URL |
|--------------------|-------------|
| `https://login.microsoftonline.com/{tenant}/v2.0/.well-known/openid-configuration` | `$MICROSOFT_EMULATOR_URL/{tenant}/v2.0/.well-known/openid-configuration` |
| `https://login.microsoftonline.com/.well-known/openid-configuration` | `$MICROSOFT_EMULATOR_URL/.well-known/openid-configuration` |
| `https://login.microsoftonline.com/common/oauth2/v2.0/authorize` | `$MICROSOFT_EMULATOR_URL/oauth2/v2.0/authorize` |
| `https://login.microsoftonline.com/common/oauth2/v2.0/token` | `$MICROSOFT_EMULATOR_URL/oauth2/v2.0/token` |
| `https://login.microsoftonline.com/common/discovery/v2.0/keys` | `$MICROSOFT_EMULATOR_URL/discovery/v2.0/keys` |
| `https://graph.microsoft.com/oidc/userinfo` | `$MICROSOFT_EMULATOR_URL/oidc/userinfo` |
| `https://graph.microsoft.com/v1.0/me` | `$MICROSOFT_EMULATOR_URL/v1.0/me` |
| `https://graph.microsoft.com/v1.0/me/messages` | `$MICROSOFT_EMULATOR_URL/v1.0/me/messages` |
| `https://graph.microsoft.com/v1.0/me/events` | `$MICROSOFT_EMULATOR_URL/v1.0/me/events` |
| `https://graph.microsoft.com/v1.0/me/drive` | `$MICROSOFT_EMULATOR_URL/v1.0/me/drive` |

### Auth.js / NextAuth.js

```typescript
import MicrosoftEntraId from '@auth/core/providers/microsoft-entra-id'

MicrosoftEntraId({
  clientId: process.env.MICROSOFT_CLIENT_ID,
  clientSecret: process.env.MICROSOFT_CLIENT_SECRET,
  authorization: {
    url: `${process.env.MICROSOFT_EMULATOR_URL}/oauth2/v2.0/authorize`,
    params: { scope: 'openid email profile User.Read' },
  },
  token: {
    url: `${process.env.MICROSOFT_EMULATOR_URL}/oauth2/v2.0/token`,
  },
  userinfo: {
    url: `${process.env.MICROSOFT_EMULATOR_URL}/oidc/userinfo`,
  },
  issuer: process.env.MICROSOFT_EMULATOR_URL,
})
```

### Passport.js

```typescript
import { OIDCStrategy } from 'passport-azure-ad'

const MICROSOFT_URL = process.env.MICROSOFT_EMULATOR_URL ?? 'https://login.microsoftonline.com'

new OIDCStrategy({
  identityMetadata: `${MICROSOFT_URL}/.well-known/openid-configuration`,
  clientID: process.env.MICROSOFT_CLIENT_ID,
  clientSecret: process.env.MICROSOFT_CLIENT_SECRET,
  redirectUrl: 'http://localhost:3000/api/auth/callback/microsoft-entra-id',
  responseType: 'code',
  responseMode: 'query',
  scope: ['openid', 'email', 'profile'],
}, verifyCallback)
```

### MSAL.js

```typescript
import { ConfidentialClientApplication } from '@azure/msal-node'

const msalConfig = {
  auth: {
    clientId: process.env.MICROSOFT_CLIENT_ID,
    clientSecret: process.env.MICROSOFT_CLIENT_SECRET,
    authority: process.env.MICROSOFT_EMULATOR_URL,
    knownAuthorities: [process.env.MICROSOFT_EMULATOR_URL],
  },
}

const cca = new ConfidentialClientApplication(msalConfig)
```

## Seed Config

```yaml
microsoft:
  users:
    - email: testuser@outlook.com
      name: Test User
      given_name: Test
      family_name: User
      tenant_id: 9188040d-6c67-4c5b-b112-36a304b66dad
  oauth_clients:
    - client_id: example-client-id
      client_secret: example-client-secret
      name: My Microsoft App
      redirect_uris:
        - http://localhost:3000/api/auth/callback/microsoft-entra-id
      tenant_id: 9188040d-6c67-4c5b-b112-36a304b66dad
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

When no OAuth clients are configured, the emulator accepts any `client_id`. With clients configured, strict validation is enforced for `client_id`, `client_secret`, and `redirect_uri`.

## API Endpoints

### OIDC Discovery

```bash
# Default tenant
curl http://localhost:4005/.well-known/openid-configuration

# Tenant-scoped (common, organizations, consumers, or specific tenant ID)
curl http://localhost:4005/common/v2.0/.well-known/openid-configuration
```

Returns the standard OIDC discovery document:

```json
{
  "issuer": "http://localhost:4005/{tenant}/v2.0",
  "authorization_endpoint": "http://localhost:4005/oauth2/v2.0/authorize",
  "token_endpoint": "http://localhost:4005/oauth2/v2.0/token",
  "userinfo_endpoint": "http://localhost:4005/oidc/userinfo",
  "end_session_endpoint": "http://localhost:4005/oauth2/v2.0/logout",
  "jwks_uri": "http://localhost:4005/discovery/v2.0/keys",
  "response_types_supported": ["code"],
  "subject_types_supported": ["pairwise"],
  "id_token_signing_alg_values_supported": ["RS256"],
  "scopes_supported": [
    "openid",
    "email",
    "profile",
    "offline_access",
    "User.Read",
    "Mail.ReadWrite",
    "Mail.Send",
    "Calendars.ReadWrite",
    "Files.ReadWrite.All"
  ],
  "token_endpoint_auth_methods_supported": ["client_secret_post", "client_secret_basic"]
}
```

### JWKS

```bash
curl http://localhost:4005/discovery/v2.0/keys
```

Returns an RSA public key (`kid`: `emulate-microsoft-1`) for verifying `id_token` signatures.

### Authorization

```bash
# Browser flow: redirects to a user picker page
curl -v "http://localhost:4005/oauth2/v2.0/authorize?\
client_id=example-client-id&\
redirect_uri=http://localhost:3000/api/auth/callback/microsoft-entra-id&\
scope=openid+email+profile&\
response_type=code&\
state=random-state&\
nonce=random-nonce"
```

Query parameters:

| Param | Description |
|-------|-------------|
| `client_id` | OAuth client ID |
| `redirect_uri` | Callback URL |
| `scope` | Space-separated scopes (`openid email profile User.Read`) |
| `state` | Opaque state for CSRF protection |
| `nonce` | Nonce for ID token (optional) |
| `response_mode` | `query` (default) or `form_post` |
| `code_challenge` | PKCE challenge (optional) |
| `code_challenge_method` | `plain` or `S256` (optional) |

### Token Exchange

```bash
curl -X POST http://localhost:4005/oauth2/v2.0/token \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "code=<authorization_code>&\
client_id=example-client-id&\
client_secret=example-client-secret&\
redirect_uri=http://localhost:3000/api/auth/callback/microsoft-entra-id&\
grant_type=authorization_code"
```

Returns:

```json
{
  "access_token": "microsoft_...",
  "refresh_token": "r_microsoft_...",
  "id_token": "<jwt>",
  "token_type": "Bearer",
  "expires_in": 3600,
  "scope": "openid email profile"
}
```

The `id_token` is an RS256 JWT containing `sub`, `oid`, `tid` (tenant ID), `email`, `name`, `preferred_username`, `ver` ("2.0"), and optional `nonce`.

For PKCE, include `code_verifier` in the token request.

Supports `Authorization: Basic` header with base64-encoded `client_id:client_secret` as an alternative to body parameters.

### Client Credentials

```bash
curl -X POST http://localhost:4005/oauth2/v2.0/token \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "client_id=example-client-id&\
client_secret=example-client-secret&\
grant_type=client_credentials&\
scope=https://graph.microsoft.com/.default"
```

Returns an `access_token` only (no `refresh_token` or `id_token`).

### Refresh Token

```bash
curl -X POST http://localhost:4005/oauth2/v2.0/token \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "refresh_token=r_microsoft_...&\
client_id=example-client-id&\
grant_type=refresh_token"
```

Returns a new `access_token`, rotated `refresh_token`, and new `id_token`.

### User Info

```bash
curl http://localhost:4005/oidc/userinfo \
  -H "Authorization: Bearer microsoft_..."
```

Returns:

```json
{
  "sub": "<oid>",
  "email": "testuser@outlook.com",
  "name": "Test User",
  "given_name": "Test",
  "family_name": "User",
  "preferred_username": "testuser@outlook.com"
}
```

### Microsoft Graph /me

```bash
curl http://localhost:4005/v1.0/me \
  -H "Authorization: Bearer microsoft_..."
```

Returns an OData-style response:

```json
{
  "@odata.context": "https://graph.microsoft.com/v1.0/$metadata#users/$entity",
  "displayName": "Test User",
  "mail": "testuser@outlook.com",
  "userPrincipalName": "testuser@outlook.com",
  "id": "<oid>"
}
```

### Microsoft Graph Workloads

Delegated tokens use the scopes requested during authorization. Common emulator scopes:

- `User.Read` for `/v1.0/me`
- `Mail.Read` or `Mail.ReadWrite` for `/v1.0/me/messages`
- `Mail.Send` for `/v1.0/me/sendMail`
- `Calendars.Read` or `Calendars.ReadWrite` for `/v1.0/me/events`
- `Files.Read` or `Files.ReadWrite.All` for `/v1.0/me/drive`

Client credentials tokens should request `scope=https://graph.microsoft.com/.default`. App-only tokens can call `/v1.0/users` and `/v1.0/users/:id`; `/v1.0/me` returns 403 because there is no signed-in user.

```bash
curl "$MICROSOFT_URL/v1.0/me/messages" \
  -H "Authorization: Bearer microsoft_..."

curl -X POST "$MICROSOFT_URL/v1.0/me/sendMail" \
  -H "Authorization: Bearer microsoft_..." \
  -H "Content-Type: application/json" \
  -d '{"message":{"subject":"Hello","body":{"contentType":"text","content":"Hi"},"toRecipients":[{"emailAddress":{"address":"recipient@example.com"}}]}}'

curl "$MICROSOFT_URL/v1.0/me/drive/root/children" \
  -H "Authorization: Bearer microsoft_..."
```

### Logout

```bash
curl "http://localhost:4005/oauth2/v2.0/logout?post_logout_redirect_uri=http://localhost:3000"
```

Redirects to the `post_logout_redirect_uri` if provided and valid.

### Token Revocation

```bash
curl -X POST http://localhost:4005/oauth2/v2.0/revoke \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "token=microsoft_..."
```

Returns `200 OK`. The token is removed from the emulator's token map.

## Common Patterns

### Full Authorization Code Flow

```bash
MICROSOFT_URL="http://localhost:4005"
CLIENT_ID="example-client-id"
CLIENT_SECRET="example-client-secret"
REDIRECT_URI="http://localhost:3000/api/auth/callback/microsoft-entra-id"

# 1. Open in browser (user picks a seeded account)
#    $MICROSOFT_URL/oauth2/v2.0/authorize?client_id=$CLIENT_ID&redirect_uri=$REDIRECT_URI&scope=openid+email+profile&response_type=code&state=abc

# 2. After user selection, emulator redirects to:
#    $REDIRECT_URI?code=<code>&state=abc

# 3. Exchange code for tokens
curl -X POST $MICROSOFT_URL/oauth2/v2.0/token \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "code=<code>&client_id=$CLIENT_ID&client_secret=$CLIENT_SECRET&redirect_uri=$REDIRECT_URI&grant_type=authorization_code"

# 4. Fetch user info with the access_token
curl $MICROSOFT_URL/oidc/userinfo \
  -H "Authorization: Bearer <access_token>"
```

### PKCE Flow

```bash
CODE_VERIFIER=$(openssl rand -base64 32 | tr -d '=+/' | cut -c1-43)
CODE_CHALLENGE=$(echo -n $CODE_VERIFIER | openssl dgst -sha256 -binary | base64 | tr -d '=' | tr '+/' '-_')

# 1. Authorize with challenge
# $MICROSOFT_URL/oauth2/v2.0/authorize?...&code_challenge=$CODE_CHALLENGE&code_challenge_method=S256

# 2. Token exchange with verifier
curl -X POST $MICROSOFT_URL/oauth2/v2.0/token \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "code=<code>&client_id=$CLIENT_ID&client_secret=$CLIENT_SECRET&redirect_uri=$REDIRECT_URI&grant_type=authorization_code&code_verifier=$CODE_VERIFIER"
```

### OIDC Discovery-Based Setup

Libraries that support OIDC discovery can auto-configure from the discovery document:

```typescript
import { Issuer } from 'openid-client'

const microsoftIssuer = await Issuer.discover(
  process.env.MICROSOFT_EMULATOR_URL ?? 'https://login.microsoftonline.com/common/v2.0'
)

const client = new microsoftIssuer.Client({
  client_id: process.env.MICROSOFT_CLIENT_ID,
  client_secret: process.env.MICROSOFT_CLIENT_SECRET,
  redirect_uris: ['http://localhost:3000/api/auth/callback/microsoft-entra-id'],
})
```

## Discovery

When using a running emulator URL, inspect `GET /_emulate/manifest` first to confirm supported surfaces (Entra ID OAuth 2.0, OIDC), auth capabilities, and per-operation spec coverage. Use `GET /_emulate/connections` for copyable SDK, CLI, env, and curl snippets and `GET /_emulate/quickstart` for setup notes.

Mint credentials with `POST /_emulate/credentials`, the canonical, uniform way to create a credential for any service (here a Microsoft OAuth client):

```bash
curl -X POST "$MICROSOFT_EMULATOR_URL/_emulate/credentials" \
  -H "Content-Type: application/json" \
  -d '{"type":"oauth-authorization-code","redirect_uris":["http://localhost:3000/api/auth/callback/microsoft-entra-id"]}'
```

For app-only scenarios, mint the same OAuth client, then exchange it with `grant_type=client_credentials` and `scope=https://graph.microsoft.com/.default`.

Inspect calls with `GET /_emulate/ledger`: each entry includes a correlation id (set `X-Correlation-Id` on a request to trace it), the matched route and operation id, sanitized headers and body, authenticated identity, response status, side effects, and webhook deliveries. Use `POST /_emulate/seed` to add runtime seed data and `POST /_emulate/reset` to replay seeds. Use `POST /_emulate/faults` to arm one-shot failures; matching faulted requests show `faulted: true` and `faultId` in the ledger.

Hosted Microsoft is at `https://microsoft.emulators.dev` (the bare service host is useful without an instance) with instance hosts of the form `microsoft.<instance>.emulators.dev`. The apex `https://emulators.dev` is a links-out catalog of every emulator; discover the same catalog machine-readably at `GET /_emulate/services` from any host. Per-service docs live at `https://docs.emulators.dev/microsoft`.
