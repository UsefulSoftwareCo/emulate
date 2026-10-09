---
name: miro
description: Emulated Miro MCP server (https://mcp.miro.com/) and its OAuth 2.1 authorization server (Dynamic Client Registration, S256 PKCE, HS256 OIDC ID tokens that omit nonce like real Miro), for testing MCP and OAuth clients without real Miro. Use when the user needs Miro MCP or Miro MCP OAuth in local development, CI, or hosted emulators.dev instances.
allowed-tools: Bash(npx emulate:*), Bash(curl:*)
---

# Miro Emulator

Emulates the two Miro surfaces an MCP client touches: the remote MCP server at the origin root (`https://mcp.miro.com/` in production) and the OAuth authorization server on the same origin.

## Start

```bash
npx emulate --service miro
```

When all services run together, Miro uses `http://localhost:4021`.

Hosted: create a private instance, then use the returned `providerBaseUrl` as the base URL. The MCP endpoint is `<providerBaseUrl>/`.

```bash
curl -X POST https://miro.emulators.dev/_emulate/instances \
  -H 'content-type: application/json' -d '{"instance":"my-test"}'
# {"providerBaseUrl":"https://emulators.dev/miro/my-test-<random>", ...}
```

## Routes

| Route | Purpose |
| --- | --- |
| `GET /.well-known/oauth-authorization-server` | RFC 8414 metadata. Issuer is `<base>/` (trailing slash). No `jwks_uri` |
| `GET /.well-known/openid-configuration` | OIDC metadata. Advertises `token_endpoint_auth_methods_supported: ["none"]` and HS256, unlike the RFC 8414 document |
| `GET /.well-known/oauth-protected-resource` | Protected resource metadata for resource `<base>/` |
| `POST /register` | Dynamic Client Registration (201, issues `client_secret`) |
| `GET /authorize` | Consent page, one sign in button per seeded user. S256 PKCE required |
| `POST /authorize` | Approval (the consent buttons submit here) |
| `POST /token` | `authorization_code` and `refresh_token`, `client_secret_post` or `client_secret_basic` |
| `POST /oidc/revoke` | Token revocation |
| `POST /` | Streamable HTTP MCP server |

Any request without a valid bearer token on `/` or an unknown path answers `401 {"error":"Authentication required"}` with `WWW-Authenticate: Bearer resource_metadata="<base>/.well-known/oauth-protected-resource"`.

## ID token nonce quirk

With `openid` granted, the token response has an `id_token` signed HS256 with the client secret, carrying `iss`, `sub`, `aud` (client id), `exp`, `iat`, and with `email` granted, `email` and `email_verified`. It never carries `nonce`, even when `/authorize` received one. This matches real Miro and breaks OIDC clients that validate the nonce.

To compare against compliant behaviour, echo the nonce:

```bash
curl -X POST http://localhost:4021/_emulate/seed \
  -H 'content-type: application/json' -d '{"id_token_nonce":"echo"}'
```

`{"id_token_nonce":"omit"}` restores the default. Token issuance records `with id_token (nonce omitted)` or `(nonce echoed)` in `GET /_emulate/ledger`.

## Approving consent from automation

- Browser automation: click the button for the user, for example `page.getByRole("button", { name: /user@example.com/ }).click()`.
- Without a browser: POST the authorize query parameters plus `login=user@example.com` as `application/x-www-form-urlencoded` to `/authorize` and read the `Location` header.

## MCP tools

`board_search_boards` (optional `query`) and `canvas_search` (`board_id`, optional `query`), read only over seeded boards.

## Seed

The default seed has user `user@example.com` and boards `Product Roadmap` and `Retro`.

```bash
curl -X POST http://localhost:4021/_emulate/seed \
  -H 'content-type: application/json' \
  -d '{
    "users": [{"email": "user@example.com", "name": "Miro User"}],
    "boards": [{"name": "Product Roadmap", "items": [{"type": "sticky_note", "content": "Ship it"}]}]
  }'
```

`oauth_clients` preregisters clients. `POST /_emulate/credentials` with `{"type":"dynamic-client-registration","redirect_uris":["..."]}` registers one.

## Not emulated

The jwt-bearer grant (advertised, answers `unsupported_grant_type`), team selection during consent, and the SVG canvas, comment, image, prototype, table, and write MCP tools.
