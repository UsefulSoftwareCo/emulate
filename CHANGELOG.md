# Changelog

## 0.8.1

<!-- release:start -->

### New Features

- **GitLab GraphQL emulator** — a new `gitlab` emulator serves GitLab's full GraphQL schema with real graphql-js introspection and validation. It loads the complete published SDL (4000+ types) so generated GraphQL clients see the same surface they would in production, and rejects malformed operations with verbatim graphql-js validation errors. The hosted `gitlab.emulators.dev` host and `createEmulator({ service: "gitlab" })` both expose the schema at `/api/graphql`, with metadata and echo queries resolving and an honest unauthenticated `currentUser`.
<!-- release:end -->

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
