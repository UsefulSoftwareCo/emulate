---
name: gitlab
description: Emulated GitLab GraphQL API for local development and testing. Use when the user needs GitLab's real GraphQL schema for introspection, validation, or codegen without calling gitlab.com. Triggers include "GitLab GraphQL", "emulate GitLab", "mock GitLab", "GitLab introspection", "test GitLab schema", or any task needing a local GitLab GraphQL endpoint.
allowed-tools: Bash(npx emulate:*), Bash(curl:*)
---

# GitLab Emulator

GitLab GraphQL API emulation carrying GitLab's full, real schema. The emulator
mirrors `gitlab.com/api/graphql`: introspection and validation behave exactly
like the live endpoint, and a curated set of root fields return data.

## Start

```bash
npx emulate --service gitlab
```

When all services run together, GitLab uses `http://localhost:4018`.

Or programmatically:

```typescript
import { createEmulator } from "emulate";

const gitlab = await createEmulator({ service: "gitlab", port: 4018 });
// gitlab.url + "/api/graphql" is the GraphQL endpoint
```

## GraphQL

The single provider surface is `POST /api/graphql`. It carries GitLab's
complete published schema (4000+ types), printed to SDL from the live API and
used as is for parsing, validation, and introspection.

```bash
curl -s -X POST "$GITLAB_EMULATOR_URL/api/graphql" \
  -H "content-type: application/json" \
  -d '{"query":"{ metadata { version revision enterprise } }"}'
```

Because the schema is the real one, malformed operations are rejected with
verbatim graphql-js validation errors (for example, a composite field with no
sub-selection, or a missing required argument). This makes the surface a
faithful target for testing GraphQL clients and query generators against a
large, production-shaped type system.

## Coverage

Resolver coverage is intentionally partial and declared honestly in the
manifest:

- `metadata` returns instance version, revision, and the enterprise flag.
- `echo` returns its input, for a trivial round-trip check.
- `currentUser` resolves to null, matching GitLab's public, unauthenticated
  GraphQL endpoint.

A Personal Access Token may be sent as an `Authorization: Bearer` header to
match GitLab's shape, but it is not yet used to resolve an authenticated
identity. Unauthenticated requests are allowed.

## Discovery

Inspect `GET /_emulate/manifest` first to confirm supported surfaces, auth
capabilities, and per-surface coverage. Use `GET /_emulate/connections` for
copyable snippets and `GET /_emulate/quickstart` for setup notes.

Inspect calls with `GET /_emulate/ledger`: each entry includes a correlation
id, matched route, sanitized headers and body, response status, and side
effects.

Hosted GitLab is at `https://gitlab.emulators.dev` with instance hosts of the
form `gitlab.<instance>.emulators.dev`. Per-service docs live at
`https://docs.emulators.dev/gitlab`.
