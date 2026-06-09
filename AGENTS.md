# Agents

## Product Vision

Emulate is a stateful integration test double for real developer APIs. It should help humans and agents stand up fake versions of real services, point applications at them, exercise authenticated flows, inspect what happened, and reset or replay scenarios. Treat it as an integration simulator platform for developer and agent-driven testing, not as a generic mock server.

The guiding principle is: emulate what the real service exposes, not every protocol the platform can technically support. A service should only expose the surfaces that match the real provider or an intentionally documented integration target. GitHub can have REST, GraphQL, OAuth app flows, GitHub App auth, webhooks, and a deliberate MCP surface. Spotify should model its real OAuth and catalog behavior, such as client credentials flows, and should not get GraphQL or MCP just because the platform supports those protocols.

Specifications are inputs, not the whole product. OpenAPI, GraphQL schemas or introspection results, MCP manifests, Google Discovery documents, OAuth metadata, and hand-authored behavior packs can all contribute to a service definition. Use subsets of those specs when that is the honest supported surface. A curated subset with clear coverage is better than a broad fake that quietly lies.

Every service should move toward exporting a machine-readable service manifest that describes:

- Service identity, display name, and short description
- Supported surfaces: REST, OAuth/OIDC, GraphQL, MCP, webhooks, redirect UIs, provider-specific auth, and provider-specific SDK semantics
- Spec sources and coverage status, including generated, hand-authored, partial, and unsupported operations
- Auth capabilities, grant types, dynamic client registration support, API keys, bearer tokens, app installations, webhook secrets, and other credential types
- Seed schema, available scenarios, reset behavior, and state model
- Inspector tabs, request ledger capabilities, and links to human docs
- Copyable connection details for SDK, CLI, and application usage

Every hosted emulator should be useful without repository context. A human or agent landing on a service host such as `github.emulators.dev` or an instance host such as `github.my-run.emulators.dev` should be able to learn what the service is, create or select an instance, create credentials, seed state, find base URLs, inspect calls, and copy SDK, CLI, or application snippets.

Prefer host-based routing for deployed emulators when possible. The long-term product shape should support service and instance hosts such as:

```text
https://github.emulators.dev
https://github.my-test-run.emulators.dev
https://stripe.ci-48291.emulators.dev
```

Provider traffic and control-plane traffic should be separate. Provider routes should remain faithful to the real service. Emulate-specific controls should live under a reserved namespace such as `/_emulate`.

The standard control plane should move toward routes like:

```text
GET  /_emulate
GET  /_emulate/manifest
GET  /_emulate/quickstart
GET  /_emulate/openapi
GET  /_emulate/graphql
GET  /_emulate/mcp
POST /_emulate/instances
POST /_emulate/seed
POST /_emulate/reset
POST /_emulate/credentials
GET  /_emulate/state
GET  /_emulate/ledger
GET  /_emulate/logs
```

The request ledger is a core feature, not a debug afterthought. Emulators should record enough information for people and tests to validate how applications called a service: timestamp, method, host, path, matched route or operation id, sanitized headers, sanitized request body, authenticated identity, response status, response summary, side effects, webhook deliveries, and a correlation id.

The remote host should plug naturally into external SDKs, CLIs, agents, and applications. A user should be able to create an instance, generate credentials, and copy ready-to-use connection configuration without knowing the internals of this repository.

OpenAPI generation should be treated as a skeleton generator and fallback layer. It can create route tables, validators, default fake responses, documentation, and coverage reports. Hand-authored behavior should override generated behavior for stateful flows, auth flows, provider-specific semantics, webhooks, and important edge cases.

When making product or architecture decisions, optimize for:

- Deployed use by applications under test
- Local and in-process use by automated tests
- Human-readable landing pages and inspectors
- Agent-readable manifests, quickstarts, and ledgers
- Faithful auth and credential flows
- Honest support boundaries and visible coverage
- Shared definitions across local, hosted, and SDK surfaces

## Package Manager

Use `pnpm` for all package management commands (not npm or yarn).

Exception: End-user install instructions should use `npm` (e.g. `npx emulate`, `npm install emulate`) since npm is universal.

## CLI Invocation

`emulate` is a zsh built-in command (it sets shell emulation mode). Running bare `emulate` in zsh invokes the shell built-in, not the npm binary. Always use `npx emulate` in user-facing CLI examples, docs, skills, help output, and post-command messages. The only exception is when `emulate` appears as a subprocess argument to another tool (e.g. `portless github.emulate emulate start`), where the binary is resolved by the parent process rather than the shell.

## Dependencies

Always check for the latest npm version when adding dependencies. Use `pnpm add <package>` (without version) to get the latest, or verify with `npm view <package> version` first.

## No Emojis

Do not use emojis anywhere in this repository (code, comments, output, docs).

## Dashes

Never use `--` as a dash in prose, comments, or user-facing output. Use an em dash (\u2014) when a dash is needed, but prefer rephrasing to avoid dashes entirely. The only exception is CLI flags (e.g. `--port`).

## Emulator UI Design System

All emulator UIs (inspector pages, OAuth flows, checkout pages, inboxes, etc.) must use the shared design system in `packages/@emulators/core/src/ui.ts`. Never write inline HTML with custom `<style>` tags or standalone `<!DOCTYPE html>` templates in individual emulator packages.

Use the appropriate shared render function for each page type:

- `renderCardPage` for centered card layouts (OAuth sign-in, email detail, checkout)
- `renderErrorPage` for error states
- `renderSettingsPage` for sidebar + main content layouts (OAuth app settings, Slack inspector)
- `renderInspectorPage` for tabbed data dashboards (AWS inspector)
- `renderFormPostPage` for OAuth `form_post` auto-submit redirects
- `renderUserButton` for user selection buttons in OAuth flows

These functions provide the shared `head()` (Geist fonts, favicon, CSS), `emuBar()` header, and "Powered by emulate" footer automatically. Use the existing CSS classes (`.inspector-table`, `.s-card`, `.org-row`, `.badge`, `.empty`, etc.) rather than adding inline styles.

If a new page type cannot be built with the existing render functions and CSS classes, add the new styles and render function to `core/src/ui.ts` so every emulator can reuse them.

## Docs Updates

When a change affects how humans or agents use emulate (new/changed/removed commands, flags, behavior, routes, seed config, or SDK integration), update all of these:

1. `README.md`
2. `skills/*/SKILL.md` (agent skills for each service)
3. `apps/web/` (docs site pages)
4. CLI `--help` output in `packages/emulate/src/index.ts`

## Releasing

Releases are manual, single-PR affairs. The maintainer controls the changelog voice and format. All packages share a single version number (`emulate` + every `@emulators/*`).

To prepare a release:

1. Create a branch (e.g. `prepare-v0.5.0`)
2. Bump the version in `packages/emulate/package.json`
3. Run `pnpm sync-versions` to update all `@emulators/*` packages
4. Write the changelog entry in `CHANGELOG.md`, wrapped in `<!-- release:start -->` and `<!-- release:end -->` markers
5. Remove the `<!-- release:start -->` and `<!-- release:end -->` markers from the previous release entry (only the latest release should have markers)
6. Open a PR and merge to `main`

CI compares the version in `packages/emulate/package.json` to what's on npm. If it differs, it builds, publishes all packages with provenance, and creates the GitHub release automatically. The release body is extracted from the content between the markers.

<!-- opensrc:start -->

## Source Code Reference

Source code for dependencies is available in `opensrc/` for deeper understanding of implementation details.

See `opensrc/sources.json` for the list of available packages and their versions.

Use this source code when you need to understand how a package works internally, not just its types/interface.

### Fetching Additional Source Code

To fetch source code for a package or repository you need to understand, run:

```bash
npx opensrc <package>           # npm package (e.g., npx opensrc zod)
npx opensrc pypi:<package>      # Python package (e.g., npx opensrc pypi:requests)
npx opensrc crates:<package>    # Rust crate (e.g., npx opensrc crates:serde)
npx opensrc <owner>/<repo>      # GitHub repo (e.g., npx opensrc vercel/ai)
```

<!-- opensrc:end -->
