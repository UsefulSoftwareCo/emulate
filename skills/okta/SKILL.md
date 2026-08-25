---
name: okta
description: Emulated Okta OAuth/OIDC and management APIs for local development and testing. Use when the user needs Okta users, groups, apps, authorization servers, OAuth clients, token flows, introspection, revocation, OIDC discovery, or enterprise-managed ID-JAG token exchange for MCP.
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

## Enterprise-managed authorization (ID-JAG)

Okta acts as the enterprise IdP in the MCP Enterprise-Managed Authorization profile. After single sign-on, exchange the ID token (or a refresh token) for an Identity Assertion JWT Authorization Grant, then present that grant to the MCP server's authorization server as an RFC 7523 `jwt-bearer` assertion.

```bash
curl -s -X POST "$OKTA_EMULATOR_URL/oauth2/default/v1/token" \
  -d grant_type=urn:ietf:params:oauth:grant-type:token-exchange \
  -d requested_token_type=urn:ietf:params:oauth:token-type:id-jag \
  -d audience="$MCP_EMULATOR_URL" \
  -d resource="$MCP_EMULATOR_URL/mcp" \
  -d scope="repo read:user" \
  -d subject_token="$ID_TOKEN" \
  -d subject_token_type=urn:ietf:params:oauth:token-type:id_token \
  -d client_id=okta-test-client \
  -d client_secret=okta-test-secret
```

The response is `{"issued_token_type":"urn:ietf:params:oauth:token-type:id-jag","access_token":"<ID-JAG>","token_type":"N_A","expires_in":300,"scope":"..."}`. The grant is signed with the same key as ID tokens, carries `typ: oauth-id-jag+jwt`, and is issued by whichever authorization server minted it (`{{baseUrl}}` for the org server, `{{baseUrl}}/oauth2/:authServerId` for a custom one). Both discovery documents advertise the grant type and `identity_chaining_requested_token_types_supported`. Errors are RFC 6749 token errors: `invalid_request` for a malformed request, `invalid_client` for failed client authentication, `invalid_grant` for a bad subject token, `invalid_target` for a policy denial, and `invalid_scope` when policy permits none of the requested scopes.

Admins control who may exchange with the `token_exchange_policies` seed field (and the matching `/api/v1/tokenExchangePolicies` management routes, which need an SSWS token). Each policy matches on user, client, audience and resource; omit a condition to match anything. An empty table allows every exchange, once any policy exists the table is an allowlist, `DENY` beats `ALLOW`, and a non-empty `scopes` list narrows the granted scope.

```bash
curl -s -X POST "$OKTA_EMULATOR_URL/_emulate/seed" \
  -H "Content-Type: application/json" \
  -d '{"okta":{"token_exchange_policies":[{"id":"00p_mcp_read","name":"Read only","client_id":"okta-test-client","audience":"'"$MCP_EMULATOR_URL"'","scopes":["read:user"],"effect":"ALLOW"}]}}'
```

## Discovery

Inspect `GET /_emulate/manifest` first to confirm supported surfaces (OAuth 2.0, OIDC, management APIs), auth capabilities, and per-operation spec coverage. Use `GET /_emulate/connections` for copyable SDK, CLI, env, and curl snippets and `GET /_emulate/quickstart` for setup notes.

Mint credentials with `POST /_emulate/credentials`, the canonical, uniform way to create a credential for any service (here an OAuth/OIDC client, as shown above). Inspect calls with `GET /_emulate/ledger`: each entry includes a correlation id (set `X-Correlation-Id` on a request to trace it), the matched route and operation id, sanitized headers and body, authenticated identity, response status, side effects, and webhook deliveries. Use `POST /_emulate/seed` to add runtime seed data and `POST /_emulate/reset` to replay seeds. Use `POST /_emulate/faults` to arm one-shot failures; matching faulted requests show `faulted: true` and `faultId` in the ledger.

Hosted Okta is at `https://okta.emulators.dev` (the bare service host is useful without an instance) with instance hosts of the form `okta.<instance>.emulators.dev`. The apex `https://emulators.dev` is a links-out catalog of every emulator; discover the same catalog machine-readably at `GET /_emulate/services` from any host. Per-service docs live at `https://docs.emulators.dev/okta`.
