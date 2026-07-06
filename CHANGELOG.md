# Changelog

## 0.13.3

<!-- release:start -->

### New Features

- **WorkOS `organizations.deleteOrganization`** — the WorkOS emulator now supports the SDK's org delete (`DELETE /organizations/:id`), returning 204 No Content like the real API. Deletion cascades to the organization's memberships, so a subsequent `getOrganization` 404s and the org drops out of `listOrganizationMemberships`, matching real WorkOS.

<!-- release:end -->

## 0.13.2

### New Features

- **Autumn `balances.check`** — the Autumn emulator now supports the SDK's `check()` call (`POST /v1/balances.check`). Access is computed from the same plan items and tracked usage that drive customer balances: unlimited and overage-allowed features always pass, metered features pass while remaining balance covers `required_balance` (default 1), and a feature the customer's plan does not carry is allowed with a `null` balance. The response carries the full balance object (`granted`, `remaining`, `usage`, `unlimited`, `overage_allowed`) in the shape autumn-js validates, and the route participates in fault injection and the request ledger like every other operation.

## 0.13.1

### Fixes

- **Seeded drive items land on the seed's own user** — `drive_items` (and other resources) that omit `user_email` now attach to the first user declared in the seed config instead of the plugin's built-in default user, so a token minted for the seeded user sees the seeded files (and their `content`) under `/me/drive`.

## 0.13.0

### New Features

- **OneDrive file content endpoints** — the Microsoft emulator now supports real Graph file upload and download: `PUT /v1.0/me/drive/root:/{path}:/content` (path-addressed create/replace with automatic intermediate folder creation), `PUT /v1.0/me/drive/items/{id}/content` (replace by id), and `GET .../content` returning a 302 to a working preauthenticated download URL served by the emulator itself. Content is stored base64 so binary payloads round-trip byte-exact. MIME types derive from the file extension like real OneDrive, items carry real `eTag`/`cTag` formats and `quickXorHash`, and folder creation via `POST .../children` honors `@microsoft.graph.conflictBehavior`.
- **Drive-scoped Graph routes** — `/v1.0/drives/{driveId}` addressing (drive, root, children, items, content) alongside the existing `/me/drive` forms.
- **Microsoft Graph parity harness** — `tools/parity/ms-run.mjs` runs 38 self-contained probes against real graph.microsoft.com or the emulator and `tools/parity/diff.mjs` compares the recordings, mirroring the Google harness.

### Fixes

- **Graph responses match live Microsoft Graph**, verified by the parity harness against real recordings: errors carry `innerError`, unknown bearer tokens return 401 `InvalidAuthenticationToken` instead of resolving to a fallback user, malformed drive item and event ids return the real 400 error codes, the `/v1.0` catch-all returns 400 `BadRequest` with the unresolved segment, messages expose `conversationIndex`, users expose `preferredLanguage`, and drive item, calendar, and event serializations follow the shapes real Graph returns.
- **Router wildcard support** — the core router now matches mid-pattern wildcards (for example `/v1.0/me/drive/*`), which the path-addressed content routes require.

## 0.12.0

### Fixes

- **Google emulator parity pass** — responses across Gmail, Calendar, Drive, and userinfo verified against live Google API recordings by the new parity harness (`tools/parity/run.mjs`), plus Drive simple media upload (`uploadType=media`) support with byte-exact binary round-trips.

## 0.11.0

### New Features

- **Okta dynamic client registration (RFC 7591)** — the Okta emulator now serves a real registration endpoint at `POST /oauth2/v1/clients` (org-level, matching real Okta) and `POST /oauth2/{authServerId}/v1/clients` (per auth server). Registered clients persist into the same store as pre-seeded ones, so a freshly minted client immediately completes the authorize and token flows, including PKCE S256. Public clients (`token_endpoint_auth_method: "none"`) receive no secret; confidential clients do. Rejections use RFC 6749 error envelopes (`invalid_client_metadata`, `invalid_redirect_uri`), and registration participates in the ledger and one-shot fault injection like any other route.
- **RFC 8414 path-insert discovery** — authorization-server metadata is now also served at the path-insert well-known forms (`/.well-known/oauth-authorization-server/oauth2/{id}` and `/.well-known/openid-configuration/oauth2/{id}`) alongside the existing suffix forms, plus an org-level `/.well-known/oauth-authorization-server`. Standards-following OAuth clients derive the path-insert form first, so discovery against the emulator no longer 404s. Metadata now advertises `registration_endpoint`, `code_challenge_methods_supported: ["S256"]`, and `token_endpoint_auth_methods_supported`.

## 0.10.0

### New Features

- **One-shot fault injection** — every emulator's control plane can now arm failures against otherwise-real endpoints: `POST /_emulate/faults` with a match (`operationId`, `method`, and/or a `pathPattern` glob) and a response (`status`, optional `body`/`headers`/`delayMs`) makes the next `times` matching requests short-circuit with that response, then disarms. Faulted requests still land in the request ledger marked `faulted: true` with the `faultId`, so a test can prove the fault fired and that the caller's fallback ran. Typed surface on both `createEmulator` and `connectEmulator`: `client.faults.arm(...)`, `.list()`, `.clear(id?)`. `reset()` clears armed faults. This is the missing piece for exercising error paths (failed token exchanges, rejected dynamic client registrations, flaky upstreams) against real-shaped services instead of hand-written mocks.

## 0.9.1

### Bug Fixes

- **Autumn customer balances carry their feature** — 0.9.0's per-feature `balances` on `customers.get_or_create` omitted the nested `feature` object, but autumn-js's `useCustomer` always requests `expand: ["balances.feature"]` and asserts the expansion, so every consuming UI render threw `[customerToFeatures] please expand balances.feature` into the app's error boundary. Every balance entry now embeds its feature, matching the real API's expanded shape.

## 0.9.0

### New Features

- **Autumn checkout and free-trial flow** — the Autumn emulator now backs a real billing UI end to end. `plans.list` returns a seedable plan catalog with per-customer eligibility (`attach_action`, `status`, `trialing`, `trial_available`), `billing.attach` and `billing.open_customer_portal` are supported, and a paid plan or a card-required free trial routes attach through a hosted checkout page. Completing checkout redirects to the app's `success_url` without activating the subscription; activation lands when the checkout settles (`POST /checkout/settle`), mirroring Stripe's `checkout.session.completed` webhook arriving after the redirect. `customers.get_or_create` now returns SDK-shaped subscriptions and per-feature balances. This makes the "billing page stays stale until a reload after checkout" race reproducible in tests.

## 0.8.1

### New Features

- **GitLab GraphQL emulator** — a new `gitlab` emulator serves GitLab's full GraphQL schema with real graphql-js introspection and validation. It loads the complete published SDL (4000+ types) so generated GraphQL clients see the same surface they would in production, and rejects malformed operations with verbatim graphql-js validation errors. The hosted `gitlab.emulators.dev` host and `createEmulator({ service: "gitlab" })` both expose the schema at `/api/graphql`, with metadata and echo queries resolving and an honest unauthenticated `currentUser`.

### Bug Fixes

- **WorkOS invitation memberships** — sending an organization invitation now also creates a pending organization membership (and the invited user when one does not exist yet), matching real WorkOS. `listOrganizationMemberships` with status `pending` returns invited but not yet joined people, so consumers can list invited members and count seats accurately. Accepting the invitation activates that membership instead of leaving a duplicate.
- **Publishable `emulate` package** — the published package no longer declares the bundled `@emulators/workos` and `@emulators/autumn` workspace packages as runtime dependencies (they are bundled, so it now lists them as dev dependencies like the other emulators), and it now declares the third-party SDKs the bundle resolves at runtime (`@aws-sdk/*`, `googleapis`, `@octokit/rest`, `@workos-inc/node`, `stripe`, and others). A clean `npm install` of the tarball now resolves and boots every service emulator.

## 0.7.5

### New Features

- **Microsoft Graph emulator expansion** — the Microsoft emulator now includes stateful Graph users, mail, calendar events, and OneDrive routes alongside Entra ID OAuth, OIDC, refresh tokens, and client credentials. The OpenAPI subset, manifest, seed schema, docs, and agent skill now describe the supported Graph workload surface, and tests cover delegated OAuth, app-only token exchange, local credential minting, and opt-in live Microsoft token parity.

## 0.7.4

### Bug Fixes

- **Local MCP packaging** — the npm `emulate` package now includes the MCP emulator in its local service registry. `createEmulator({ service: "github" })` serves the GitHub MCP OAuth metadata locally, matching the hosted Cloudflare worker, and `createEmulator({ service: "mcp" })` is available for MCP-only tests.

## 0.7.3

### New Features

- **MCP Enterprise-Managed Authorization** — the WorkOS emulator can exchange signed user subject tokens for ID-JAG assertions, and the GitHub MCP emulator advertises the ID-JAG grant profile and redeems ID-JAG assertions through the JWT bearer grant. The request ledger now captures both token exchanges so end-to-end tests can prove the enterprise-managed authorization path.

## 0.7.2

### New Features

- **MCP OAuth scope discovery** — the GitHub MCP emulator advertises configurable OAuth scopes for runtime discovery via RFC 9728 protected-resource and RFC 8414 authorization-server metadata. Seed `scopes` and `scopeSource` (`resource`, `authorization-server`, `both`, or `none`) to drive any discovery branch, including the resource-silent fallback to authorization-server metadata and an authoritative empty scope set. The hosted `/github/scope-discovery/mcp` instance deploys the fallback scenario with zero seed config.

## 0.6.0

### New Features

- **Expanded Slack emulator support** — stateful Slack writes for rich chat messages, updates, deletes, permalinks, ephemeral and scheduled messages, conversations and DMs, OAuth installs and scopes, user profiles and presence, modern file uploads, pins and bookmarks, App Home views, modals, inspector tabs, event delivery visibility, docs, and coverage matrix (#152-#164)

### Improvements

- **Slack SDK coverage** — added Slack WebClient conformance tests and route coverage for the supported Slack Web API surface (#152-#164)
- **Slack docs** — audited README, package docs, web docs, skill guidance, CLI seed output, strict scope notes, and unsupported Slack families against the implemented surface (#164)

### Contributors

- @ctate

## 0.5.0

### New Features

- **Clerk emulator** — local emulation of Clerk authentication and session management (#38)
- **Portless integration** — embed emulators directly in your app without dedicated ports, with base URL override support (#78)
- **Google `hd` claim** — hosted domain claim in ID tokens and userinfo for Google OAuth (#73)
- **Stripe Checkout example** — full working example of Stripe Checkout with the Stripe emulator (#82)
- **Resend magic link example** — working example of Resend magic link authentication flow (#51)
- **Docs landing page** — new landing page for the docs site (#81)

### Improvements

- **Unified UI design system** — all emulator UIs now share a consistent design system with CI quality checks (#50)
- **Stripe** — added customer sessions and payment methods API (#47)

### Bug Fixes

- Fixed **AWS S3** emulator compatibility with the official AWS SDK wire format (#65, #69)
- Fixed **Resend** email inbox links not being clickable in preview (#80)

### Contributors

- @ctate
- @disintegrator
- @jlucaso1
- @Railly
- @tmm

## 0.4.1

### Bug Fixes

- Include README in all `@emulators/*` npm packages

## 0.4.0

### New Features

- **Next.js adapter** — embed emulators directly in your Next.js app via `@emulators/adapter-next`, solving the Vercel preview deployment problem where OAuth callback URLs change with every deployment (#43)
- **MongoDB Atlas emulator** — local emulation of MongoDB Atlas with Data API support (#18)
- **Stripe emulator** — local emulation of Stripe billing and payment APIs (#4)
- **Resend emulator** — local emulation of the Resend email API (#7)
- **Okta emulator** — local emulation of Okta authentication and OIDC flows (#32)

### Improvements

- **Microsoft Entra ID** — added v1 OAuth token endpoint and Microsoft Graph `/users/{id}` route (#30)

### Bug Fixes

- Fixed multiple bugs, security hardening, and quality improvements across all emulators (#37)

### Contributors

- @AmorosoDavid12
- @ctate
- @jk4235
- @mvanhorn
