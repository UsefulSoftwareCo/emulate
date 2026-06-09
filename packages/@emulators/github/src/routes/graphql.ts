import { buildSchema, graphql, GraphQLError, type ExecutionResult } from "graphql";
import type { RouteContext } from "@emulators/core";
import { getGitHubStore } from "../store.js";

// GitHub's GraphQL API (api.github.com/graphql), emulated on the SAME instance as
// the REST routes so both read one store. We use graphql-js for real parsing,
// validation, and introspection, then wrap it with GitHub's HTTP quirks captured
// from the live API:
//   • no User-Agent           → 403 "Request forbidden by administrative rules…"
//   • no/anonymous auth        → 403 "API rate limit exceeded…" (GraphQL needs auth)
//   • invalid token            → 401 {"message":"Bad credentials", …}
//   • empty query              → 200 {"errors":[{"message":"A query attribute …"}]}
//   • undefined field          → 200 errors[].extensions.code = "undefinedField"
//   • success                  → 200 {"data":…} + x-github-media-type / x-ratelimit headers

const SCHEMA = buildSchema(/* GraphQL */ `
  type Query {
    viewer: User!
    user(login: String!): User
    repository(owner: String!, name: String!): Repository
    rateLimit: RateLimit
  }
  type User {
    login: String!
    name: String
    id: ID!
    databaseId: Int
    company: String
    bio: String
    url: String
  }
  type Repository {
    id: ID!
    name: String!
    nameWithOwner: String!
    description: String
    stargazerCount: Int!
    forkCount: Int!
    isPrivate: Boolean!
    primaryLanguage: Language
    defaultBranchRef: Ref
    owner: RepositoryOwner!
    url: String
  }
  type Language {
    name: String!
  }
  type Ref {
    name: String!
  }
  type RepositoryOwner {
    login: String!
  }
  type RateLimit {
    limit: Int!
    cost: Int!
    remaining: Int!
    used: Int!
    resource: String!
  }
`);

// graphql-js validation says "Cannot query field 'x' on type 'T'."; GitHub says
// "Field 'x' doesn't exist on type 'T'" with extensions.code "undefinedField".
// Re-shape known validation errors so the envelope matches the real API.
function toGitHubError(err: GraphQLError): Record<string, unknown> {
  const base: Record<string, unknown> = { message: err.message };
  if (err.locations) base.locations = err.locations;
  if (err.path) base.path = err.path;
  const m = /^Cannot query field "(.+?)" on type "(.+?)"\.?/.exec(err.message);
  if (m) {
    base.message = `Field '${m[1]}' doesn't exist on type '${m[2]}'`;
    base.extensions = { code: "undefinedField", typeName: m[2], fieldName: m[1] };
  } else if (err.extensions && Object.keys(err.extensions).length > 0) {
    base.extensions = err.extensions;
  }
  return base;
}

export function graphqlRoutes(ctx: RouteContext): void {
  const { app, store, tokenMap } = ctx;
  const gh = getGitHubStore(store);

  const root = {
    viewer: (_args: unknown, c: { login: string }) => shapeUser(c.login),
    user: ({ login }: { login: string }) => shapeUser(login),
    repository: ({ owner, name }: { owner: string; name: string }) => {
      const repo = gh.repos.all().find((r) => r.full_name === `${owner}/${name}`);
      if (!repo) return null;
      const ownerLogin =
        gh.users.all().find((u) => u.id === repo.owner_id)?.login ??
        gh.orgs.all().find((o) => o.id === repo.owner_id)?.login ??
        owner;
      return {
        id: repo.node_id,
        name: repo.name,
        nameWithOwner: repo.full_name,
        description: repo.description,
        stargazerCount: repo.stargazers_count ?? 0,
        forkCount: (repo as { forks_count?: number }).forks_count ?? 0,
        isPrivate: Boolean((repo as { private?: boolean }).private),
        primaryLanguage: repo.language ? { name: repo.language } : null,
        defaultBranchRef: repo.default_branch ? { name: repo.default_branch } : null,
        owner: { login: ownerLogin },
        url: `https://github.com/${repo.full_name}`,
      };
    },
    rateLimit: () => ({ limit: 5000, cost: 1, remaining: 4999, used: 1, resource: "graphql" }),
  };

  function shapeUser(login: string) {
    const u = gh.users.all().find((x) => x.login === login);
    if (!u) return null;
    return {
      login: u.login,
      name: u.name ?? null,
      id: u.node_id,
      databaseId: u.id,
      company: u.company ?? null,
      bio: u.bio ?? null,
      url: `https://github.com/${u.login}`,
    };
  }

  app.post("/graphql", async (c) => {
    // Quirk 1: User-Agent required — checked before auth, like the real API.
    if (!c.req.header("user-agent")) {
      return c.text(
        "Request forbidden by administrative rules. Please make sure your request has a User-Agent header (https://docs.github.com/en/rest/overview/resources-in-the-rest-api#user-agent-required). Check https://developer.github.com for other possible causes.",
        403,
      );
    }

    // Quirk 2/3: auth. Anonymous → 403 rate-limit; bad token → 401 Bad credentials.
    const authz = c.req.header("authorization") ?? "";
    const token = /^(?:bearer|token)\s+(.+)$/i.exec(authz)?.[1]?.trim();
    if (!token) {
      return c.json(
        {
          message:
            "API rate limit exceeded for your request. (But here's the good news: Authenticated requests get a higher rate limit. Check out the documentation for more details.)",
          documentation_url:
            "https://docs.github.com/en/free-pro-team@latest/rest/overview/resources-in-the-rest-api#rate-limiting",
        },
        403,
      );
    }
    const authUser = tokenMap?.get(token);
    if (!authUser) {
      return c.json(
        { message: "Bad credentials", documentation_url: "https://docs.github.com/rest", status: "401" },
        401,
      );
    }

    const body = (await c.req.json().catch(() => ({}))) as {
      query?: unknown;
      variables?: Record<string, unknown>;
      operationName?: string;
    };
    if (typeof body.query !== "string" || body.query.length === 0) {
      return c.json({ errors: [{ message: "A query attribute must be specified and must be a string." }] }, 200);
    }

    let result: ExecutionResult;
    try {
      result = await graphql({
        schema: SCHEMA,
        source: body.query,
        rootValue: root,
        contextValue: { login: authUser.login },
        variableValues: body.variables,
        operationName: body.operationName,
      });
    } catch (e) {
      return c.json({ errors: [{ message: e instanceof Error ? e.message : "Internal error" }] }, 200);
    }

    // GitHub returns 200 for executed queries (even with errors) + these headers.
    c.header("X-GitHub-Media-Type", "github.v4; format=json");
    c.header("X-RateLimit-Limit", "5000");
    c.header("X-RateLimit-Remaining", "4999");
    c.header("X-RateLimit-Used", "1");
    c.header("X-RateLimit-Resource", "graphql");
    c.header("X-OAuth-Scopes", (authUser.scopes ?? []).join(", "));

    const payload: Record<string, unknown> = {};
    if (result.errors) payload.errors = result.errors.map((e) => toGitHubError(e as GraphQLError));
    if ("data" in result && result.data !== undefined) payload.data = result.data;
    return c.json(payload, 200);
  });
}
