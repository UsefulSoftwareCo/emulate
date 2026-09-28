---
name: planetscale
description: Emulated PlanetScale OAuth authorization server (Doorkeeper, Dynamic Client Registration, PKCE, literal HTTP Basic client authentication) and hosted MCP server at /mcp/planetscale, for testing MCP and OAuth clients without real PlanetScale. Use when the user needs PlanetScale OAuth or the PlanetScale MCP server in local development, CI, or hosted emulators.dev instances.
allowed-tools: Bash(npx emulate:*), Bash(curl:*)
---

# PlanetScale Emulator

Emulates the two PlanetScale surfaces an MCP client touches: the Doorkeeper OAuth authorization server and the hosted MCP server (`https://mcp.pscale.dev/mcp/planetscale` in production).

## Start

```bash
npx emulate --service planetscale
```

When all services run together, PlanetScale uses `http://localhost:4020`.

Hosted: create a private instance, then use the returned `providerBaseUrl` as the base URL.

```bash
curl -X POST https://planetscale.emulators.dev/_emulate/instances \
  -H 'content-type: application/json' -d '{"instance":"my-test"}'
# {"providerBaseUrl":"https://emulators.dev/planetscale/my-test-<random>", ...}
```

## Routes

| Route | Purpose |
| --- | --- |
| `GET /.well-known/oauth-authorization-server` | Authorization server metadata. Issuer is the base URL. |
| `POST /oauth/registration` | Dynamic Client Registration |
| `GET /oauth/authorize` | Consent page, one sign in button per seeded user |
| `POST /oauth/authorize` | Approval (the consent buttons submit here) |
| `POST /oauth/token` | `authorization_code` and `refresh_token` grants |
| `POST /oauth/revoke` | Token revocation |
| `POST /mcp/planetscale` | Streamable HTTP MCP server |
| `GET /.well-known/oauth-protected-resource/mcp/planetscale` | Protected resource metadata |

An unauthenticated MCP request answers `401` with `WWW-Authenticate: Bearer resource_metadata="<base>/.well-known/oauth-protected-resource/mcp/planetscale"`, so an MCP client discovers OAuth and registers itself.

## Client authentication semantics

The token endpoint behaves like Doorkeeper:

- The HTTP Basic header is base64 decoded, split on the first colon, and compared literally. There is no form url decoding.
- When a Basic header is present, `client_id` and `client_secret` in the body are ignored.
- Without a Basic header, `client_id` and `client_secret` in the body are used (`client_secret_post`).
- Failures answer `401 {"error":"invalid_client",...}` with `WWW-Authenticate: Bearer realm="Doorkeeper", error="invalid_client", error_description="..."`.

Registered client ids (`pscale_app_<32 hex>`) and secrets (`pscale_app_secret_<43 chars>`) always contain `_`. A client that form url encodes its Basic credentials (for example `oauth4webapi`'s `ClientSecretBasic`, which sends `_` as `%5F`) therefore always fails, exactly as it does against real PlanetScale.

Each token and revoke call adds a ledger side effect describing the client authentication, for example:

```text
client_auth method=client_secret_basic outcome=unknown_client client_id="pscale%5Fapp%5F..." client_id_percent_encoded=true
```

Read it from `GET /_emulate/ledger`. Secrets are never recorded.

## Approving consent from automation

`GET /oauth/authorize?...` renders a page with one button per seeded user. Each button is a form that POSTs the original authorize parameters plus `login` to `/oauth/authorize`, which redirects to the client's `redirect_uri` with `code`, `state`, and `iss`.

- Browser automation: click the button whose name contains the login, for example `page.getByRole("button", { name: /planetscale-user/ }).click()`.
- Without a browser: POST the authorize query parameters plus `login=planetscale-user` as `application/x-www-form-urlencoded` to `/oauth/authorize` and read the `Location` header.

## Seed

The default seed has user `planetscale-user` and organization `acme` with database `app-db`.

```bash
curl -X POST http://localhost:4020/_emulate/seed \
  -H 'content-type: application/json' \
  -d '{
    "users": [{"login": "planetscale-user"}],
    "organizations": [{"name": "acme", "databases": [{"name": "app-db", "kind": "mysql",
      "branches": [{"name": "main", "production": true}]}]}]
  }'
```

`oauth_clients` preregisters clients. `POST /_emulate/credentials` with `{"type":"dynamic-client-registration","redirect_uris":["..."]}` registers one and returns its `client_id` and `client_secret`.

## Not emulated

`device_code` and `client_credentials` grants, OIDC userinfo and id tokens, MCP service tokens, and the query, schema, insights, and billing MCP tools.
