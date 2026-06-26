import { describe, it, expect, beforeEach } from "vitest";
import { Hono, Store, WebhookDispatcher } from "@emulators/core";
import { getIntrospectionQuery } from "graphql";
import { gitlabPlugin } from "../index.js";

const base = "http://localhost:4000";

function createTestApp() {
  const store = new Store();
  const webhooks = new WebhookDispatcher();
  const app = new Hono();
  gitlabPlugin.register(app as never, store, webhooks, base);
  return app;
}

interface GraphQLResponse {
  data?: Record<string, unknown> | null;
  errors?: Array<{ message: string }>;
}

function gql(app: Hono, query: string, variables?: Record<string, unknown>) {
  return app.request(`${base}/api/graphql`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
}

describe("GitLab GraphQL surface", () => {
  let app: Hono;

  beforeEach(() => {
    app = createTestApp();
  });

  it("introspects the full real schema", async () => {
    const res = await gql(app, getIntrospectionQuery());
    expect(res.status).toBe(200);
    const body = (await res.json()) as GraphQLResponse;
    expect(body.errors).toBeUndefined();
    const schema = body.data?.__schema as { queryType: { name: string }; types: unknown[] } | undefined;
    expect(schema?.queryType.name).toBe("Query");
    // GitLab's real schema is large; this guards against a trimmed stand in.
    expect(schema?.types.length).toBeGreaterThan(1000);
  });

  it("resolves metadata", async () => {
    const res = await gql(app, "{ metadata { version revision enterprise kas { enabled } } }");
    const body = (await res.json()) as GraphQLResponse;
    expect(body.errors).toBeUndefined();
    const metadata = body.data?.metadata as { enterprise: boolean; kas: { enabled: boolean } };
    expect(metadata.enterprise).toBe(false);
    expect(metadata.kas.enabled).toBe(false);
  });

  it("resolves echo with a required argument", async () => {
    const res = await gql(app, "query Echo($t: String!) { echo(text: $t) }", { t: "hi from gitlab" });
    const body = (await res.json()) as GraphQLResponse;
    expect(body.errors).toBeUndefined();
    expect(body.data?.echo).toBe("hi from gitlab");
  });

  it("returns a verbatim validation error when a composite field lacks a selection", async () => {
    // This is the shape of the invalid operation the executor GraphQL plugin
    // emits against a rich schema (issue 1146): a composite field with no subfields.
    const res = await gql(app, "query { currentUser }");
    expect(res.status).toBe(200);
    const body = (await res.json()) as GraphQLResponse;
    const messages = (body.errors ?? []).map((e) => e.message);
    expect(messages.some((m) => /must have a selection of subfields/.test(m))).toBe(true);
  });

  it("returns a verbatim validation error when a required argument is missing", async () => {
    // featureFlags requires names: [String!]!; omitting it is the other failure
    // mode the executor plugin produces (dropped nested required argument).
    const res = await gql(app, "query { metadata { featureFlags { name } } }");
    expect(res.status).toBe(200);
    const body = (await res.json()) as GraphQLResponse;
    const messages = (body.errors ?? []).map((e) => e.message);
    expect(
      messages.some((m) => /argument "[^"]+" of type "[^"]+" is required, but it was not provided\./.test(m)),
    ).toBe(true);
  });
});
