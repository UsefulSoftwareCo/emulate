# Changelog

## 0.17.2

<!-- release:start -->

### Changes

- **X accepts local webhook addresses in CRC control mode.** With `webhook_crc_delivery: "control"`, `POST /2/webhooks` on an https instance (every hosted one) also accepts an `http` address or one with a port, so a test can register a local receiver, subscribe it and preview its deliveries. It is an emulator-only relaxation of X's rule, listed as such in the manifest; outbound mode keeps X's rule (https, no port, at most 200 characters).

<!-- release:end -->

## 0.17.1

### Fixes

- **Hosted instances keep what they issue.** An instance on `*.emulators.dev` now keeps every token it has issued (OAuth access tokens, API keys, bearer credentials, and their revocations) and GitHub's webhook subscriptions across Durable Object unloads and deploys, and saves its ledger after every request, reads included. A rebuild used to answer 401 to GitHub, Apple, Microsoft, Slack and Vercel tokens issued moments earlier, stop delivering GitHub webhooks, and drop ledger entries since the last write. Reaching one instance over both `http` and `https` no longer loses anything either.
- **Hosted saves cost what changed and never fail a request.** Each ledger entry is written once, so a read at a full ledger of 1,000 entries writes about 2 KB. Values over the storage limit for a single value are split, so an 8 MB body saves like any other. A save that fails no longer fails the request; the failure is listed at `GET /_emulate/persistence` and the next save catches up.
- **Hosted emulators are HTTPS only.** Plain `http` is redirected to the same address over `https` with a `308`, which keeps the method and body. A client on the wrong scheme used to rebuild the instance on every switch.
- **Docs answer at every service's bare address.** `docs.emulators.dev/<service>` redirects to the service's page for every page, as the manifests advertise, not only the older ones.

## 0.17.0

### New Features

- **X direct messages.** The three v2 DM event lookups, an event by id, delete, and sends to a participant, a conversation or a new group, with `dm_event.fields`, `expansions`, `user.fields`, `media.fields`, `event_types` and base32hex pagination tokens. A seed can describe thousands of events with `generate` or `dm_bulk` without storing them, and events older than X's 30 days are hidden.
- **X media.** v2 upload in one request or in chunks, and the DM media download, streamed with its length.
- **X webhooks and the X Activity API.** `/2/webhooks` sends the CRC at creation and on PUT, `dm.sent` and `dm.received` subscriptions deliver X's envelope signed with `X-Twitter-Webhooks-Signature-OAuth2`, and `/_emulate/x` can make a message arrive, preview a delivery unsent, and hold challenges for a test the emulator cannot reach. The Account Activity API, which X has deprecated, is listed as unsupported.
- **X rate limits.** `x-rate-limit-*` headers and the 429 with code 88, per user and per app as X's table has them, with limits an instance can set through the seed or `POST /_emulate/x/rate-limits`. Each request, 429s included, is in the ledger with its user, and a hosted instance keeps reads and their counts across eviction.
- **Gmail push.** `users.watch` pushes to Pub/Sub push subscriptions set by seed or control plane, with the wrapped body and an OIDC token verifiable at `/oauth2/v3/certs`, at most once a second per user. `/_emulate/google/gmail/arrive` delivers mail and `preview-push` returns a push unsent.
- **`users.getProfile`**, and the `list:` search operator.
- **An OpenAI emulator.** The Responses API and Chat Completions for text, streamed or not, with API keys, per-key request limits, deterministic answers a test seeds, answers paced into a stated number of chunks, and a usage record per call. Token counts are approximate and labelled so.
- **A Zapier MCP emulator.** Zapier's managed-mode MCP server at `/api/v1/connect` for protocol 2026-07-28 and the 2025-11-25 and 2025-06-18 handshake era, OAuth per person as `mcp.zapier.com` publishes it, and a deterministic tool list per account of any size that pages with opaque cursors and changes on command.

### Fixes

- **Gmail returns every header.** `List-Id`, `List-Unsubscribe` and the rest now appear in `format=full`, and in `format=metadata` when named.
- **Google's token endpoint accepts `client_secret_basic`**, which its discovery document advertised, and issued Google credentials name `/oauth2/token`, the route that exists, instead of `/token`.
- **Hosted Google instances keep the access tokens they issued** across eviction; they used to answer 401 to them.
- **Slack finds a channel named with a leading `#`.** `channel: "#general"` works wherever a channel name does, as in Slack's own examples.
- **Discovery probes get a 404, not a page.** The apex and service hosts answer `/.well-known/*` with a JSON 404 instead of HTML with a 200, so OAuth discovery clients move on to the next candidate.

## 0.16.0


### New Features

- **Deny on every OAuth consent page.** Each consent page that lists users to approve as (Apple, Clerk, GitHub, Google, MCP, Microsoft, Miro, Okta, PlanetScale, PostHog, Slack, Vercel, WorkOS, X) now has a Deny button. It sends the person back to the client's registered redirect URI with `error=access_denied` and the request's `state` (RFC 6749 section 4.1.2.1), in the response mode the request asked for (`query`, `fragment` or `form_post`, with `iss` where the provider sends it), and issues no code. It comes from one shared `renderDenyButton` in `@emulators/core`.
- **`strict` on `createEmulator`.** With `strict: true`, only seeded or minted tokens authenticate and an unknown or revoked token gets the real API's unauthorized answer, as hosted strict instances already do. The default is unchanged: an unknown token still acts as the service's default user.
- **An MCP server that needs no sign-in.** The `mcp` service accepts `auth: none`: every request to `/mcp` acts as the first seeded user, as a public or locally trusted MCP server does.

### Fixes

- **Approving on the MCP and PlanetScale consent pages works from a browser.** Their user buttons did not post the chosen user, so approving always answered "Unknown user". Tests that posted `login` themselves never saw it.
- **Vercel's minted OAuth client names its real authorize page.** `credentials.mint` for Vercel returned `/integrations/oauth/authorize`, which does not exist; it now returns `/oauth/authorize`, where the consent page is.


## 0.15.1


### Changes

- **The package installs only what it runs.** `@executor-js/emulate` now depends on `commander`, `graphql`, `picocolors` and `yaml`, the four packages its bundle imports. The seventeen vendor SDKs it used to declare (`googleapis`, `@aws-sdk/client-s3`, `@aws-sdk/client-sqs`, `@azure/msal-node`, `@clerk/backend`, `@octokit/rest`, `@okta/okta-auth-js`, `@slack/web-api`, `@vercel/sdk`, `@workos-inc/node`, `atlas-api-client`, `autumn-js`, `graphql-request`, `resend`, `spotify-web-api-node`, `stripe`, `twitter-api-v2`) appear only in copyable snippets, so they no longer come along. A clean install is now five packages. Nothing about how the emulators behave changes.

## 0.15.0


### New Features

- **Listen on a free loopback port** — `createEmulator` takes a `hostname` (for example `'127.0.0.1'` or `'::1'`) and accepts `port: 0`. It now resolves only once the server is listening, rejects when the port cannot be bound (instead of resolving and failing later), and the instance reports the bound `port`. When no base URL is configured, `url` names the listen address and the bound port (`http://127.0.0.1:<port>`, IPv6 in brackets), so every seeded URL, OAuth redirect and issuer uses a reachable address. Without a `hostname`, URLs still use `localhost`. Callers that pass a fixed port see no change beyond the earlier, clearer error.
- **`onRequest` on local emulators** — `emulator.onRequest(fn)` calls `fn` with each provider request's ledger entry as it is recorded, after the handler has finished and its state is visible, and returns a function that stops it. A test can wait for "the application under test has sent this email" without polling.
- **Context company lookup emulator** — a new `context` service serving brand retrieval by work email address or domain over seeded brands. Free and disposable mailbox domains are rejected the way the real resolver does.
- **PlanetScale OAuth and MCP emulator** — authorization server metadata, dynamic client registration with the real `pscale_app_` id and secret formats, consent, a token endpoint with Doorkeeper's literal HTTP Basic comparison (form-url-encoded Basic credentials fail, as they do upstream), refresh rotation, revocation, and a read-only MCP server at `/mcp/planetscale`.
- **Miro MCP OAuth emulator** — both discovery documents as served by `mcp.miro.com`, protected resource metadata, dynamic client registration, S256 PKCE consent, `client_secret_post` and `client_secret_basic`, refresh rotation, revocation, and the MCP server behind Miro's gateway 401. ID tokens drop the nonce by default, as Miro does; seed `id_token_nonce: echo` to compare.
- **Autumn** — `customers.get` (read-only, 404 `customer_not_found` without creating), moving a paid customer to another plan on its Stripe subscription, `auto_enable_plan_id`, atomic check-and-consume, `billing.update` cancellation, a feature and plan catalog seeded by id, and usage events rolled up per feature.
- **WorkOS organization metadata** — organizations support `metadata`.

### Changes

- **Google ID tokens are signed with RS256** and the signing key is published at the JWKS endpoint, so relying parties that verify Google tokens (and refuse HS256) accept them. Hosted instances keep their signing key across Durable Object eviction.
- **Hosted instances persist only changed state**, and keep armed faults (with their remaining counts) across Durable Object eviction.
- **`openid-client` is no longer a dependency.** Nothing imported it, but it pulled in `jose ^6.2.18`, which forced a second copy of `jose` (and of packages that take `jose` as a peer) into applications on an older `jose`.


## 0.14.2


### New Features

- **Autumn payment method setup and billing portal** — the Autumn emulator now models the card on file end to end. `POST /v1/billing.setup_payment` (autumn-js `billing.setupPayment`) opens a Stripe setup-mode checkout and returns `{ customer_id, entity_id?, url }`; the hosted page at `GET /checkout/setup/:sessionId` captures a card (`card_number`, `exp`, both editable so a test can pick the brand) and redirects to `success_url`. As with the existing checkout flow, nothing changes on the customer until the `checkout.session.completed` webhook lands, modelled by `POST /checkout/setup/:sessionId/settle` (or the customer-wide `POST /checkout/settle`, which now settles setup sessions too). Settling matches real Autumn's surprising behaviour: a setup session only sets the default payment method when the customer has none, and never replaces an existing card, because Autumn's setup-checkout handler reads the current default first and re-sets that same card.
- **Autumn hosted billing portal** — `POST /v1/billing.open_customer_portal` now returns a URL that actually serves a page. `GET /checkout/portal/:customerId` shows the customer's current plan, the card on file (or "No payment method"), a form to update it, and a link back to the `return_url` the portal session was opened with (recorded in the new `autumn.portals` collection). `POST /checkout/portal/:customerId/payment-method` changes the card IMMEDIATELY, with no settle step, because real Stripe swaps the default inside the portal and Autumn reads the card live on every expand. This is how an application under test changes a card. Unknown customers 404.
- **Autumn `payment_method` expand** — `customers.get_or_create` honours `expand: ["payment_method"]`, returning the Stripe PaymentMethod (`id`, `type`, `card.brand`, `card.last4`, `card.exp_month`, `card.exp_year`), and omitting the field entirely when there is no card or when `expand` does not ask for it. Settling a paid checkout also leaves a visa 4242 on file when the customer had no card, and customers can be seeded with a `payment_method`.


## 0.14.1

### New Features

- **Autumn `balances.update`** — the Autumn emulator now supports the SDK's balance update call (`POST /v1/balances.update`) for reconciling continuous-use features such as seats. Exactly one of `usage`, `remaining`, or `add_to_balance` is required; the update is recorded as an adjustment event, so `events.list` shows the reconciliation and `balances.check` and `customers.get_or_create` reflect it from the same state. `remaining` is rejected on unlimited balances, unknown customers 404 with Autumn's real `customer_not_found` code (update is a non-creating endpoint upstream, unlike track and check), and a feature the customer's plan does not carry 404s.

## 0.14.0

### New Features

- **Okta enterprise-managed authorization (ID-JAG token exchange)** — the Okta emulator's token endpoint now handles RFC 8693 token exchange minting Identity Assertion JWT Authorization Grants (`requested_token_type=urn:ietf:params:oauth:token-type:id-jag`, per draft-ietf-oauth-identity-assertion-authz-grant-04) on both the org issuer and per-authorization-server issuers, accepting ID-token and refresh-token subject tokens with the draft's validation rules (issuer-pinned signature, subject-token audience must be the authenticating client). A seedable administrator policy table (`token_exchange_policies`: user × client × audience × resource × scopes, ALLOW/DENY with DENY-wins and scope narrowing) governs issuance — unconfigured means every exchange is allowed, any seeded policy flips the table to an allowlist — and is manageable at `/api/v1/tokenExchangePolicies` behind management auth (an emulator extension; real Okta has no public API for this). Denials return RFC 8693 `invalid_target`/`invalid_scope`. Minted ID-JAGs redeem against the MCP emulator's existing jwt-bearer endpoint unchanged, proven by a new Okta → MCP enterprise-managed-authorization end-to-end suite.

## 0.13.9

### New Features

- **WorkOS organization-owned API keys** — the WorkOS emulator now serves the SDK's organization API key surface: `GET /organizations/:id/api_keys` lists an organization's own keys (organization-owned only — members' personal keys never share the listing) and `POST /organizations/:id/api_keys` mints one. An organization-owned key carries the real wire owner shape (`owner: { type: "organization", id }`, no member field), round-trips through `POST /api_keys/validations` with that shape, and deletes through the shared `DELETE /api_keys/:id`. Unknown organizations 404.

## 0.13.8

### New Features

- **WorkOS organization domains** — the WorkOS emulator now persists organization domains statefully: `POST /organization_domains` creates a pending domain with a DNS verification token, `GET /organization_domains/:id` returns its current state, `POST /organization_domains/:id/verify` performs the real SDK verification transition, and `DELETE /organization_domains/:id` removes it. Deleting an organization cascades to its domains, and a test-only `POST /_emulate/organization_domains/:id/verify` hook flips a pending domain to verified out of band. Domains are globally unique across organizations with WorkOS-shaped conflict errors.
- **Stripe OpenAPI discovery in YAML** — the Stripe emulator serves `GET /openapi.yaml` alongside `GET /openapi.json`, derived from the same OpenAPI document. Form-encoded deep-object metadata (`metadata[foo]=bar`) is modeled in the spec's request encodings, and the customers API projects nested metadata in responses, matching Stripe's wire behavior. The request ledger records the parsed deep-object bodies.

## 0.13.7

### New Features

- **MCP OAuth compliance scenario knobs** — the MCP emulator gains a seedable `oauth` config for exercising RFC 7591/8414/9728 client compliance: `issuerOverride` (advertise a lying issuer), `resourceOverride` (protected-resource metadata naming a foreign resource), `tokenEndpointAuthMethods` (advertise an exact list, or `"omit"` to drop the field so RFC 8414's client_secret_basic default applies), `dcrAuthMethodOverride` (the DCR response substitutes the requested token auth method), and `rejectClientNameContaining` (registration rejects branded client names with `invalid_client_metadata`). The token endpoint now supports HTTP Basic client authentication and enforces the registered method strictly: `client_secret_basic` clients must use Basic, `client_secret_post` clients must use the form body.

## 0.13.6

### New Features

- **WorkOS session logout** — the WorkOS emulator now serves AuthKit's session-end endpoint (`GET /user_management/sessions/logout?session_id=...&return_to=...`), the URL the Node SDK's `getLogoutUrl` builds. It revokes the session (its refresh token stops minting tokens, matching real WorkOS) and redirects to `return_to`, or renders a signed-out page when none is given. Apps can now exercise their full sign-out flow, including the hop through WorkOS, against the emulator.

## 0.13.5

### Bug Fixes

- **WorkOS `authorization.listOrganizationRoles`** — the WorkOS emulator now serves organization roles on the Authorization-API path (`GET /authorization/organizations/:id/roles`) the v10 Node SDK calls, alongside the legacy `GET /organizations/:id/roles`. Before this, `authorization.listOrganizationRoles` hit a 404, so any app loading an org's roles (a members page role picker, for example) got a 500.

## 0.13.4

### New Features

- **WorkOS invitation revocation on pending-membership delete** — deleting a pending organization membership now revokes the matching outstanding invitation, so seat counts stay coherent (a deleted pending member frees its seat instead of leaving a dangling invite).

## 0.13.3

### New Features

- **WorkOS `organizations.deleteOrganization`** — the WorkOS emulator now supports the SDK's org delete (`DELETE /organizations/:id`), returning 204 No Content like the real API. Deletion cascades to the organization's memberships, so a subsequent `getOrganization` 404s and the org drops out of `listOrganizationMemberships`, matching real WorkOS.

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
