---
name: emulate
description: Local drop-in API emulator for Vercel, GitHub, Google, Slack, Apple, Microsoft, Okta, AWS, Resend, Stripe, MongoDB Atlas, Clerk, and Spotify. Use when the user needs to start emulated services, configure seed data, write tests against local APIs, set up CI without network access, or work with the emulate CLI or programmatic API. Triggers include "start the emulator", "emulate services", "mock API locally", "create emulator config", "test against local API", "npx emulate", or any task requiring local service emulation.
allowed-tools: Bash(npx emulate:*), Bash(emulate:*)
---

# Service Emulation with emulate

Local drop-in replacement services for CI and no-network sandboxes. Fully stateful, production-fidelity API emulation, not mocks.

## Quick Start

```bash
npx emulate
```

All services start with sensible defaults:

| Service   | Default Port |
|-----------|-------------|
| Vercel    | 4000        |
| GitHub    | 4001        |
| Google    | 4002        |
| Slack     | 4003        |
| Apple     | 4004        |
| Microsoft | 4005        |
| Okta      | 4006        |
| AWS       | 4007        |
| Resend    | 4008        |
| Stripe    | 4009        |
| MongoDB Atlas | 4010   |
| Clerk     | 4011        |
| Spotify   | 4012        |

## Control Plane

Provider traffic and control-plane traffic are separate. Provider routes stay faithful to the real service; every Emulate-specific control lives under the reserved `/_emulate` namespace. Each running instance exposes:

| Route | Purpose |
|-------|---------|
| `GET /_emulate` | Human-readable landing page for the instance |
| `GET /_emulate/manifest` | Machine-readable manifest (the single source of truth): identity, surfaces, auth capabilities, specs with per-operation coverage, scenarios, seed schema, state model, reset behavior, inspector tabs, ledger capabilities, and copyable connections |
| `GET /_emulate/quickstart` | Plain-text setup notes for humans and agents |
| `GET /_emulate/specs` | Advertised specs and protocol surfaces |
| `GET /_emulate/coverage` | Per-operation coverage (generated, hand-authored, partial, unsupported) with a summary by status |
| `GET /_emulate/connections` | Copyable SDK, CLI, env, and curl connection snippets resolved against the instance (optional `?token=`, `?client_id=`, `?client_secret=` overrides) |
| `GET /_emulate/openapi` | Redirect to OpenAPI when advertised |
| `GET /_emulate/graphql` | Return the GraphQL endpoint when advertised |
| `GET /_emulate/mcp` | Return the MCP endpoint when advertised |
| `GET /_emulate/state` | Current emulator store snapshot |
| `GET /_emulate/ledger` | Recent API calls with sensitive fields redacted (optional `?limit=`) |
| `DELETE /_emulate/ledger` | Clear the request ledger |
| `POST /_emulate/faults` | Arm a one-shot or counted fault against matching provider requests |
| `GET /_emulate/faults` | List armed faults with remaining counts |
| `DELETE /_emulate/faults` | Clear all armed faults |
| `DELETE /_emulate/faults/:id` | Clear one armed fault |
| `GET /_emulate/logs` | Webhook deliveries plus recent requests |
| `POST /_emulate/instances` | Return URLs for a lazily created hosted instance |
| `POST /_emulate/seed` | Add runtime seed data using the service seed schema |
| `POST /_emulate/reset` | Reset state, webhooks, and request logs, then replay seed data |
| `POST /_emulate/credentials` | Mint a credential for the service (the canonical, uniform way) |

There is also a global, host-level catalog:

| Route | Purpose |
|-------|---------|
| `GET /_emulate/services` | Machine-readable catalog of every hosted service: id, name, description, service host, instance host pattern, path form, and manifest URL |

When given an unknown emulator URL, inspect `GET /_emulate/manifest` first, then use `GET /_emulate/connections` for copyable setup, `GET /_emulate/quickstart` for notes, and `GET /_emulate/ledger` to verify calls. To discover what is deployed at all, fetch `GET /_emulate/services`. Do not assume every service has OpenAPI, GraphQL, MCP, or the same OAuth mode. Use only the surfaces advertised by the manifest.

### Minting credentials

`POST /_emulate/credentials` is the canonical, uniform way to mint a credential for any service. The request body's `type` selects what to mint based on the service's auth capabilities (advertised in the manifest):

```bash
# Bearer token / API key (services with token or API-key auth)
curl -X POST "$EMULATOR_URL/_emulate/credentials" \
  -H "Content-Type: application/json" \
  -d '{"type":"api-key","login":"admin"}'

# OAuth client (services with authorization-code auth)
curl -X POST "$EMULATOR_URL/_emulate/credentials" \
  -H "Content-Type: application/json" \
  -d '{"type":"oauth-authorization-code","redirect_uris":["http://localhost:3000/callback"]}'

# OAuth client-credentials app (e.g. Spotify)
curl -X POST "$EMULATOR_URL/_emulate/credentials" \
  -H "Content-Type: application/json" \
  -d '{"type":"oauth-client-credentials","name":"My App"}'
```

Prefer this over any service-specific or legacy credential endpoints. Check the manifest's auth capabilities to see which credential types a service supports; minting an unsupported type returns a `501`.

### Inspecting requests with the ledger

The request ledger is a core feature, not a debug afterthought. `GET /_emulate/ledger` returns recent calls with sensitive fields redacted. Each entry records:

- `correlationId` (honored from an inbound `X-Correlation-Id` or `X-Request-Id` header and echoed back in the `X-Correlation-Id` response header, otherwise generated)
- matched route and `operationId`
- `method`, `host`, `path`, and query
- sanitized request headers and body
- authenticated identity
- response status and a one-line summary
- `faulted` and `faultId` when `/_emulate/faults` injected the response
- `sideEffects` and `webhookDeliveries`
- `durationMs`

Send `X-Correlation-Id` on a request to trace it end to end, then read it back from the matching ledger entry. Use `sideEffects` and `webhookDeliveries` to assert what an application's call actually did.

### Fault injection

Use `POST /_emulate/faults` to arm a one-shot or counted response for matching provider requests. The body is `{ "match": { "operationId": "...", "method": "GET", "pathPattern": "/v1/*" }, "response": { "status": 503, "body": { "error": "temporary" } }, "times": 1 }`. Match criteria are combined, and `pathPattern` is a glob where `*` matches any characters in the request path. Matched requests short-circuit, decrement `remaining`, and still appear in `GET /_emulate/ledger` with `faulted: true` and `faultId`.

## Host-Based Routing (Deployed Emulators)

Hosted emulators are reachable on `*.emulators.dev`. All services are available:
`vercel`, `github`, `google`, `slack`, `apple`, `microsoft`, `okta`, `aws`, `resend`, `stripe`, `mongoatlas`, `clerk`, `spotify`.

| Form | Example | Notes |
|------|---------|-------|
| Apex catalog | `https://emulators.dev` | The apex is a links-out catalog landing page listing every emulator and linking to each one's host. `GET /_emulate/services` returns the same catalog machine-readably |
| Service host | `https://github.emulators.dev` | Control plane only, no shared instance: serves `/_emulate`, `/_emulate/manifest`, `/_emulate/quickstart`, `/_emulate/specs`, `/_emulate/coverage`, `/_emulate/connections`, `/_emulate/openapi`, and `POST /_emulate/instances`. Provider routes return 404 with instance-creation guidance |
| Instance host | `https://github.my-run.emulators.dev` | One stateful instance: `<service>.<instance>.emulators.dev` (e.g. `stripe.ci-48291.emulators.dev`). State and the ledger persist across eviction |
| Local / path form | `http://localhost:4001/github/my-run` | `<origin>/<service>/<instance>` |

A human or agent landing on a service host can learn what the service is and create an instance via `POST /_emulate/instances` without any repository context. Discover the full catalog at `GET /_emulate/services` from any host.

`POST /_emulate/instances` generates an unguessable instance name; an optional `{"instance":"<prefix>"}` body adds a readable prefix. The instance URL is a capability: hosted instances have no authentication, so anyone holding the URL can read and modify the instance. Save the returned URLs rather than re-deriving the name, do not put real secrets into an emulator, and do not hand-pick short instance names on the public host.

Docs are a separate site at `https://docs.emulators.dev`, with per-service docs at `https://docs.emulators.dev/<service>` (the `docsUrl` convention each manifest advertises). The apex `emulators.dev` is the catalog, not the docs.

## CLI

```bash
# Start all services (zero-config)
npx emulate

# Start specific services
npx emulate --service vercel,github

# Custom base port (auto-increments per service)
npx emulate --port 3000

# Use a seed config file
npx emulate --seed config.yaml

# Generate a starter config
npx emulate init

# Generate config for a specific service
npx emulate init --service vercel

# List available services
npx emulate list
```

### Options

| Flag | Default | Description |
|------|---------|-------------|
| `-p, --port` | `4000` | Base port (auto-increments per service) |
| `-s, --service` | all | Comma-separated services to enable |
| `--seed` | auto-detect | Path to seed config (YAML or JSON) |
| `--base-url` | none | Override advertised base URL (supports `{service}` template) |
| `--portless` | off | Serve over HTTPS via portless (auto-registers aliases) |

The port can also be set via `EMULATE_PORT` or `PORT` environment variables.

The advertised base URL (used in OAuth redirects, webhook URLs, etc.) can be overridden via `--base-url`, the `EMULATE_BASE_URL` env var (supports `{service}` template), or per-service `baseUrl` in the seed config. When running under portless, the `PORTLESS_URL` env var is also detected automatically.

## Programmatic API

```bash
npm install emulate
```

Each call to `createEmulator` starts a single service:

```typescript
import { createEmulator } from 'emulate'

const github = await createEmulator({ service: 'github', port: 4001 })
const vercel = await createEmulator({ service: 'vercel', port: 4002 })

github.url   // 'http://localhost:4001'
vercel.url   // 'http://localhost:4002'

await github.close()
await vercel.close()
```

### Options

| Option | Default | Description |
|--------|---------|-------------|
| `service` | *(required)* | `'vercel'`, `'github'`, `'google'`, `'slack'`, `'apple'`, `'microsoft'`, `'okta'`, `'aws'`, `'resend'`, `'stripe'`, `'mongoatlas'`, `'clerk'`, or `'spotify'` |
| `port` | `4000` | Port for the HTTP server |
| `seed` | none | Inline seed data (same shape as YAML config) |
| `baseUrl` | none | Override advertised base URL. Per-service `baseUrl` in seed config takes highest priority, then this option, then `EMULATE_BASE_URL` env var (supports `{service}`), then `PORTLESS_URL` (supports `{service}`, automatically set by the `portless` CLI wrapper), then `http://localhost:<port>`. |

### Instance Methods

| Method | Description |
|--------|-------------|
| `url` | Base URL of the running server |
| `reset()` | Wipe the store and replay seed data |
| `close()` | Shut down the HTTP server, returns a Promise |

## Vitest / Jest Setup

```typescript
import { createEmulator, type Emulator } from 'emulate'

let github: Emulator
let vercel: Emulator

beforeAll(async () => {
  ;[github, vercel] = await Promise.all([
    createEmulator({ service: 'github', port: 4001 }),
    createEmulator({ service: 'vercel', port: 4002 }),
  ])
  process.env.GITHUB_EMULATOR_URL = github.url
  process.env.VERCEL_EMULATOR_URL = vercel.url
})

afterEach(() => { github.reset(); vercel.reset() })
afterAll(() => Promise.all([github.close(), vercel.close()]))
```

## Configuration

Configuration is optional. The CLI auto-detects config files in this order:

1. `emulate.config.yaml` / `.yml`
2. `emulate.config.json`
3. `service-emulator.config.yaml` / `.yml`
4. `service-emulator.config.json`

Or pass `--seed <file>` explicitly. Run `npx emulate init` to generate a starter file.

### Config Structure

```yaml
tokens:
  my_token:
    login: admin
    scopes: [repo, user]

vercel:
  users:
    - username: developer
      name: Developer
      email: dev@example.com
  teams:
    - slug: my-team
      name: My Team
  projects:
    - name: my-app
      team: my-team
      framework: nextjs
  integrations:
    - client_id: oac_abc123
      client_secret: secret_abc123
      name: My Vercel App
      redirect_uris:
        - http://localhost:3000/api/auth/callback/vercel

github:
  users:
    - login: octocat
      name: The Octocat
      email: octocat@github.com
  orgs:
    - login: my-org
      name: My Organization
  repos:
    - owner: octocat
      name: hello-world
      language: JavaScript
      auto_init: true
  oauth_apps:
    - client_id: Iv1.abc123
      client_secret: secret_abc123
      name: My Web App
      redirect_uris:
        - http://localhost:3000/api/auth/callback/github

google:
  users:
    - email: testuser@example.com
      name: Test User
  oauth_clients:
    - client_id: my-client-id.apps.googleusercontent.com
      client_secret: GOCSPX-secret
      redirect_uris:
        - http://localhost:3000/api/auth/callback/google

slack:
  team:
    name: My Workspace
    domain: my-workspace
  users:
    - name: developer
      real_name: Developer
      email: dev@example.com
  channels:
    - name: general
      topic: General discussion
  bots:
    - name: my-bot
  oauth_apps:
    - client_id: "12345.67890"
      client_secret: example_client_secret
      name: My Slack App
      redirect_uris:
        - http://localhost:3000/api/auth/callback/slack

apple:
  users:
    - email: testuser@icloud.com
      name: Test User
  oauth_clients:
    - client_id: com.example.app
      team_id: TEAM001
      name: My Apple App
      redirect_uris:
        - http://localhost:3000/api/auth/callback/apple

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

aws:
  region: us-east-1
  s3:
    buckets:
      - name: my-app-bucket
  sqs:
    queues:
      - name: my-app-events
  iam:
    users:
      - user_name: developer
        create_access_key: true
    roles:
      - role_name: lambda-execution-role
```

### Auth

Tokens map to users. Pass them as `Authorization: Bearer <token>` or `Authorization: token <token>`. When no tokens are configured, a default `test_token_admin` is created for the `admin` user.

Each service also has a fallback user. If no token is provided, requests authenticate as the first seeded user.

## HTTPS with portless

[portless](https://github.com/vercel-labs/portless) gives emulators trusted HTTPS URLs with auto-generated certs. Use the `--portless` flag to auto-register each service as a portless alias:

```bash
npx emulate start --portless
# github  https://github.emulate.localhost
# google  https://google.emulate.localhost
# ...
```

This requires the portless proxy to be running (`portless proxy start`). If portless is not installed, emulate will prompt to install it.

The `--portless` flag overwrites any existing portless aliases matching `*.emulate`. Aliases are removed automatically when emulate shuts down.

For a single service behind portless:

```bash
portless github.emulate emulate start --service github
```

For a custom base URL without portless (any reverse proxy):

```bash
npx emulate start --base-url "https://{service}.myproxy.test"
# or
EMULATE_BASE_URL="https://{service}.myproxy.test" npx emulate start
```

The `PORTLESS_URL` env var is automatically set by the `portless` CLI wrapper when running a command through it (e.g. `portless github.emulate emulate start`), typically to a value like `https://{service}.emulate.localhost`. It supports `{service}` interpolation, just like `--base-url` and `EMULATE_BASE_URL`. When no explicit `baseUrl` is provided, it is used as a fallback.

Per-service overrides in the seed config (these take highest priority over all other base URL sources):

```yaml
github:
  baseUrl: https://github.emulate.localhost
google:
  baseUrl: https://google.emulate.localhost
```

## Pointing Your App at the Emulator

Set environment variables to override real service URLs:

```bash
VERCEL_EMULATOR_URL=http://localhost:4000
GITHUB_EMULATOR_URL=http://localhost:4001
GOOGLE_EMULATOR_URL=http://localhost:4002
SLACK_EMULATOR_URL=http://localhost:4003
APPLE_EMULATOR_URL=http://localhost:4004
MICROSOFT_EMULATOR_URL=http://localhost:4005
OKTA_EMULATOR_URL=http://localhost:4006
AWS_EMULATOR_URL=http://localhost:4007
RESEND_EMULATOR_URL=http://localhost:4008
STRIPE_EMULATOR_URL=http://localhost:4009
MONGOATLAS_EMULATOR_URL=http://localhost:4010
CLERK_EMULATOR_URL=http://localhost:4011
SPOTIFY_EMULATOR_URL=http://localhost:4012
```

Then use these in your app to construct API and OAuth URLs. See each service's skill for SDK-specific override instructions.

## Next.js Integration (Embedded Mode)

The `@emulators/adapter-next` package embeds emulators directly into a Next.js app on the same origin. See the **next** skill (`skills/next/SKILL.md`) for full setup, Auth.js configuration, persistence, and font tracing details.

## Persistence

By default, all emulator state is in-memory. For persistence across process restarts and serverless cold starts, use a `PersistenceAdapter`.

### Built-in file persistence

```typescript
import { filePersistence } from '@emulators/core'

// CLI or local dev: persists to a JSON file
const adapter = filePersistence('.emulate/state.json')
```

### Custom adapters

```typescript
import type { PersistenceAdapter } from '@emulators/core'

const kvAdapter: PersistenceAdapter = {
  async load() { return await kv.get('emulate-state') },
  async save(data) { await kv.set('emulate-state', data) },
}
```

State is loaded on cold start and saved after every mutating request (POST, PUT, PATCH, DELETE). Saves are serialized to prevent race conditions.

## Architecture

```
packages/
  emulate/           # CLI entry point + programmatic API
  @emulators/
    core/            # HTTP server, Store, plugin interface, middleware
    adapter-next/    # Next.js App Router integration
    vercel/          # Vercel API service plugin
    github/          # GitHub API service plugin
    google/          # Google OAuth 2.0 / OIDC plugin
    slack/           # Slack Web API, OAuth, incoming webhooks plugin
    apple/           # Sign in with Apple / OIDC plugin
    microsoft/       # Microsoft Entra ID OAuth 2.0 / OIDC plugin
    okta/            # Okta OAuth 2.0 / OIDC + management APIs plugin
    aws/             # AWS S3, SQS, IAM, STS plugin
    resend/          # Resend email API plugin
    stripe/          # Stripe REST, hosted checkout, webhooks plugin
    mongoatlas/      # MongoDB Atlas Admin API + Data API plugin
    clerk/           # Clerk auth, users, orgs, OAuth/OIDC plugin
    spotify/         # Spotify Web API + Client Credentials OAuth plugin
```

The core provides a generic `Store` with typed `Collection<T>` instances supporting CRUD, indexing, filtering, and pagination. Each service plugin registers routes with the shared internal app and uses the store for state.
