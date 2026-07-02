import { graphql, parse, print, visit, Kind, type ExecutionResult } from "graphql";
import type { RouteContext } from "@emulators/core";
import { getGitLabSchema } from "../schema.js";

// GitLab's GraphQL API (graphql-ruby) returns deprecated fields and enum values
// from introspection regardless of the `includeDeprecated` argument. graphql-js,
// which backs this emulator, instead honors `includeDeprecated: false` and hides
// them. To stay faithful to gitlab.com, rewrite every `includeDeprecated`
// argument in an incoming query to true before execution, so introspection
// exposes deprecated members (such as metadata.featureFlags) exactly as the real
// API does. This is what lets client query generators reproduce against the
// emulator the same operations they would emit against gitlab.com (issue 1146:
// a deprecated field with a required argument was selected without it).
function forceIncludeDeprecated(query: string): string {
  if (!query.includes("includeDeprecated")) return query;
  let document;
  try {
    document = parse(query);
  } catch {
    // Let graphql() surface the parse error with its own verbatim message.
    return query;
  }
  return print(
    visit(document, {
      Argument(node) {
        if (node.name.value !== "includeDeprecated") return undefined;
        return { ...node, value: { kind: Kind.BOOLEAN, value: true } };
      },
    }),
  );
}

// GitLab's GraphQL API (gitlab.com/api/graphql), emulated with graphql-js for
// real parsing, validation, and introspection against gitlab's full schema.
//
// This surface is schema complete and data partial: the entire real schema is
// available for introspection and validation, while only a few root fields
// return data. Unauthenticated requests are allowed, matching gitlab's public
// GraphQL access. A bearer Personal Access Token is accepted but not required,
// and is not yet used to resolve an authenticated identity (currentUser is null).
//
// Validation and execution errors are returned verbatim from graphql-js, exactly
// as gitlab.com surfaces them, so clients see real graphql error messages.

const root = {
  // metadata is public on gitlab.com and needs no authentication.
  metadata: () => ({
    version: "17.0.0-emulator",
    revision: "emulator",
    enterprise: false,
    kas: {
      enabled: false,
      version: null,
      externalUrl: null,
      externalK8sProxyUrl: null,
    },
    featureFlags: () => [],
  }),
  // echo returns its argument, matching gitlab's echo field.
  echo: ({ text }: { text: string }) => text,
  // currentUser is null when unauthenticated, the honest default for this surface.
  currentUser: () => null,
};

export function graphqlRoutes(ctx: RouteContext): void {
  const { app } = ctx;

  app.post("/api/graphql", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      query?: unknown;
      variables?: Record<string, unknown>;
      operationName?: string;
    };

    if (typeof body.query !== "string" || body.query.length === 0) {
      // gitlab returns this when no query string is provided.
      return c.json({ errors: [{ message: "No query string was provided" }] }, 200);
    }

    let result: ExecutionResult;
    try {
      result = await graphql({
        schema: getGitLabSchema(),
        source: forceIncludeDeprecated(body.query),
        rootValue: root,
        variableValues: body.variables,
        operationName: body.operationName,
      });
    } catch (e) {
      return c.json({ errors: [{ message: e instanceof Error ? e.message : "Internal error" }] }, 200);
    }

    // Return graphql-js errors verbatim (GraphQLError.toJSON yields
    // { message, locations?, path?, extensions? }), with no gitlab-specific
    // reshaping, so validation messages reach the client unchanged.
    const payload: Record<string, unknown> = {};
    if (result.errors) payload.errors = result.errors;
    if ("data" in result && result.data !== undefined) payload.data = result.data;
    return c.json(payload, 200);
  });
}
