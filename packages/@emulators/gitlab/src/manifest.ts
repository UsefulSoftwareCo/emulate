import type { ServiceManifest } from "@emulators/core";

/**
 * GitLab's machine-readable service manifest. The single source of truth for
 * GitLab's surfaces, auth, specs, and copyable connection snippets, consumed by
 * the CLI registry, the Cloudflare host, and the console.
 *
 * GitLab is modelled as a single GraphQL surface that mirrors gitlab.com's public
 * GraphQL API at /api/graphql. The emulator carries GitLab's full, real schema,
 * so introspection and validation behave exactly like the live API. Only a few
 * root fields return data today (this is declared honestly as a generated, data
 * partial surface). Unauthenticated access is allowed, matching GitLab's public
 * GraphQL endpoint; a Personal Access Token may be sent as a bearer token but is
 * not yet used to resolve an authenticated identity.
 */
export const manifest: ServiceManifest = {
  id: "gitlab",
  name: "GitLab",
  description:
    "Stateful GitLab GraphQL API emulator carrying GitLab's full, real schema. Introspection and validation behave exactly like gitlab.com/api/graphql; a curated set of root fields return data.",
  docsUrl: "https://docs.emulators.dev/gitlab",
  surfaces: [
    {
      id: "graphql",
      kind: "graphql",
      title: "GitLab GraphQL API",
      status: "partial",
      basePath: "/api/graphql",
      notes:
        "Full real schema for introspection and validation. A curated set of root fields (metadata, echo) return data; currentUser is null unauthenticated.",
    },
  ],
  auth: [
    {
      id: "personal-access-token",
      title: "Personal Access Token (bearer)",
      type: "bearer-token",
      status: "partial",
      notes:
        "Accepted as an Authorization: Bearer header to match GitLab, but not yet used to resolve an authenticated identity. Unauthenticated GraphQL requests are allowed, like GitLab's public endpoint.",
    },
  ],
  specs: [
    {
      kind: "graphql",
      title: "GitLab GraphQL schema (full, real)",
      coverage: "generated",
      notes:
        "GitLab's complete GraphQL schema, printed to SDL from the live API. Used as is for parsing, validation, and introspection. Resolver coverage is partial and declared in the surface notes.",
    },
  ],
  scenarios: [
    {
      id: "default",
      title: "Public GraphQL endpoint",
      description:
        "Unauthenticated GitLab GraphQL surface: metadata and echo resolve, currentUser is null, and the full schema is introspectable.",
    },
  ],
  connections: [
    {
      id: "curl-metadata",
      title: "curl (metadata query)",
      kind: "curl",
      language: "bash",
      description: "Query instance metadata against the emulated GraphQL endpoint.",
      template:
        'curl -s -X POST {{baseUrl}}/api/graphql \\\n  -H "content-type: application/json" \\\n  -d \'{"query":"{ metadata { version revision enterprise } }"}\'',
    },
    {
      id: "gitlab-env",
      title: "GitLab GraphQL URL (env)",
      kind: "env",
      language: "bash",
      description: "Point your app at the emulator instead of gitlab.com.",
      template: "GITLAB_GRAPHQL_URL={{baseUrl}}/api/graphql",
    },
    {
      id: "graphql-request",
      title: "graphql-request (TypeScript)",
      kind: "sdk",
      language: "typescript",
      description: "Run real GraphQL queries against the emulator with graphql-request.",
      template:
        'import { GraphQLClient, gql } from "graphql-request";\n\nconst client = new GraphQLClient("{{baseUrl}}/api/graphql");\n\nconst data = await client.request(gql`\n  query {\n    metadata {\n      version\n      enterprise\n    }\n  }\n`);',
    },
  ],
};
