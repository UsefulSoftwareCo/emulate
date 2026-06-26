import { buildSchema, type GraphQLSchema } from "graphql";
import { GITLAB_SCHEMA_SDL } from "./schema-sdl.js";

let cached: GraphQLSchema | undefined;

/**
 * Build (once) and return GitLab's full GraphQL schema.
 *
 * Parsing the real SDL costs a few hundred milliseconds, so the build is
 * deferred to first use and memoized. Importing this module stays cheap, and the
 * one time cost is paid lazily on the first GraphQL request rather than at module
 * load. assumeValidSDL skips re-validating gitlab.com's already valid schema.
 */
export function getGitLabSchema(): GraphQLSchema {
  if (!cached) {
    cached = buildSchema(GITLAB_SCHEMA_SDL, { assumeValidSDL: true });
  }
  return cached;
}
