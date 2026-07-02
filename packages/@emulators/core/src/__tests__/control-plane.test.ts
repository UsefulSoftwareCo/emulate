import { describe, expect, it } from "vitest";
import { createServer } from "../server.js";
import type { ServicePlugin } from "../plugin.js";
import type { Store } from "../store.js";

interface Thing {
  id: number;
  created_at: string;
  updated_at: string;
  name: string;
}

const plugin: ServicePlugin = {
  name: "demo",
  seed(store: Store) {
    store.collection<Thing>("demo.things").insert({ name: "seeded" });
  },
  register(app, store) {
    app.get("/things", (c) => c.json({ things: store.collection<Thing>("demo.things").all() }));
    app.post("/things", async (c) => {
      const body = (await c.req.json()) as { name: string; token?: string };
      const thing = store.collection<Thing>("demo.things").insert({ name: body.name });
      return c.json({ thing, token: body.token }, 201);
    });
  },
};

describe("control plane", () => {
  it("serves manifest, quickstart, state, and landing page", async () => {
    const { app, store } = createServer(plugin, {
      baseUrl: "https://demo.instance.emulators.dev",
      manifest: {
        id: "demo",
        name: "Demo",
        description: "Demo emulator.",
        surfaces: [{ id: "rest", kind: "rest", title: "REST API", status: "partial", basePath: "/" }],
        auth: [{ id: "bearer", title: "Bearer token", type: "bearer-token", status: "partial" }],
        specs: [{ kind: "manual", title: "Manual behavior", coverage: "partial" }],
      },
      instance: "instance",
    });
    plugin.seed?.(store, "https://demo.instance.emulators.dev");

    const manifestRes = await app.request("/_emulate/manifest");
    expect(manifestRes.status).toBe(200);
    const manifest = (await manifestRes.json()) as { manifest: { id: string }; instance: { controlBaseUrl: string } };
    expect(manifest.manifest.id).toBe("demo");
    expect(manifest.instance.controlBaseUrl).toBe("https://demo.instance.emulators.dev/_emulate");

    const quickstart = await (await app.request("/_emulate/quickstart")).text();
    expect(quickstart).toContain("Provider base URL: https://demo.instance.emulators.dev");
    expect(quickstart).toContain("/_emulate/faults");

    const state = (await (await app.request("/_emulate/state")).json()) as { collections: Record<string, unknown> };
    expect(state.collections["demo.things"]).toBeDefined();

    const landing = await (await app.request("/_emulate")).text();
    expect(landing).toContain("Demo Emulator");
  });

  it("records request ledger entries with redacted secrets", async () => {
    const { app, store } = createServer(plugin, {
      baseUrl: "https://demo.instance.emulators.dev",
      tokens: { admin: { login: "admin", id: 1, scopes: ["demo"] } },
    });
    plugin.seed?.(store, "https://demo.instance.emulators.dev");

    const createRes = await app.request("/things", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer admin",
      },
      body: JSON.stringify({ name: "created", token: "secret-token" }),
    });
    expect(createRes.status).toBe(201);

    const ledger = (await (await app.request("/_emulate/ledger")).json()) as {
      entries: Array<{
        method: string;
        path: string;
        request: { headers: Record<string, string>; body: { token: string } };
        response: { status: number; body: { token: string } };
        identity: { user?: { login: string } };
      }>;
    };
    expect(ledger.entries).toHaveLength(1);
    expect(ledger.entries[0]!.method).toBe("POST");
    expect(ledger.entries[0]!.path).toBe("/things");
    expect(ledger.entries[0]!.request.headers.authorization).toBe("[redacted]");
    expect(ledger.entries[0]!.request.body.token).toBe("[redacted]");
    expect(ledger.entries[0]!.response.body.token).toBe("[redacted]");
    expect(ledger.entries[0]!.response.status).toBe(201);
    expect(ledger.entries[0]!.identity.user?.login).toBe("admin");
  });

  it("arms, lists, clears, and records one-shot faults", async () => {
    const { app, store } = createServer(plugin, {
      baseUrl: "https://demo.instance.emulators.dev",
      manifest: {
        id: "demo",
        name: "Demo",
        description: "Demo emulator.",
        surfaces: [{ id: "rest", kind: "rest", title: "REST API", status: "partial", basePath: "/" }],
        auth: [{ id: "bearer", title: "Bearer token", type: "bearer-token", status: "partial" }],
        specs: [
          {
            kind: "manual",
            title: "Manual behavior",
            coverage: "partial",
            operations: [{ operationId: "listThings", method: "GET", path: "/things", status: "hand-authored" }],
          },
        ],
      },
    });
    plugin.seed?.(store, "https://demo.instance.emulators.dev");

    const armRes = await app.request("/_emulate/faults", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        match: { operationId: "listThings" },
        response: { status: 503, body: { error: "planned" } },
      }),
    });
    expect(armRes.status).toBe(200);
    const { fault } = (await armRes.json()) as { fault: { id: string; remaining: number } };
    expect(fault.remaining).toBe(1);

    let faults = (await (await app.request("/_emulate/faults")).json()) as { faults: Array<{ id: string }> };
    expect(faults.faults.map((f) => f.id)).toContain(fault.id);

    const faulted = await app.request("/things");
    expect(faulted.status).toBe(503);
    expect(await faulted.json()).toEqual({ error: "planned" });

    const ledger = (await (await app.request("/_emulate/ledger")).json()) as {
      entries: Array<{ path: string; response: { status: number }; faulted?: boolean; faultId?: string }>;
    };
    expect(ledger.entries[0]).toMatchObject({
      path: "/things",
      response: { status: 503 },
      faulted: true,
      faultId: fault.id,
    });

    const normal = await app.request("/things");
    expect(normal.status).toBe(200);
    expect(((await normal.json()) as { things: Thing[] }).things).toHaveLength(1);

    faults = (await (await app.request("/_emulate/faults")).json()) as { faults: Array<{ id: string }> };
    expect(faults.faults).toHaveLength(0);

    const pathFaultRes = await app.request("/_emulate/faults", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ match: { method: "GET", pathPattern: "/things" }, response: { status: 429 } }),
    });
    const pathFault = (await pathFaultRes.json()) as { fault: { id: string } };
    const clearOne = await app.request(`/_emulate/faults/${pathFault.fault.id}`, { method: "DELETE" });
    expect(clearOne.status).toBe(200);

    await app.request("/_emulate/faults", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ match: { method: "GET", pathPattern: "/things" }, response: { status: 500 } }),
    });
    await app.request("/_emulate/faults", { method: "DELETE" });
    faults = (await (await app.request("/_emulate/faults")).json()) as { faults: Array<{ id: string }> };
    expect(faults.faults).toHaveLength(0);
  });

  it("runs the supplied reset callback", async () => {
    let resets = 0;
    const { app, store, ledger } = createServer(plugin, {
      baseUrl: "https://demo.instance.emulators.dev",
      reset() {
        resets += 1;
        store.reset();
        ledger.clear();
        plugin.seed?.(store, "https://demo.instance.emulators.dev");
      },
    });
    plugin.seed?.(store, "https://demo.instance.emulators.dev");

    await app.request("/things", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "created" }),
    });
    await app.request("/_emulate/faults", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ match: { method: "GET", pathPattern: "/unused" }, response: { status: 503 } }),
    });
    let things = (await (await app.request("/things")).json()) as { things: Thing[] };
    expect(things.things).toHaveLength(2);

    const resetRes = await app.request("/_emulate/reset", { method: "POST" });
    expect(resetRes.status).toBe(200);
    expect(resets).toBe(1);

    things = (await (await app.request("/things")).json()) as { things: Thing[] };
    expect(things.things).toHaveLength(1);
    expect(things.things[0]!.name).toBe("seeded");
    const faults = (await (await app.request("/_emulate/faults")).json()) as { faults: unknown[] };
    expect(faults.faults).toHaveLength(0);
  });

  it("creates default bearer credentials through the control plane", async () => {
    const { app } = createServer(plugin, {
      baseUrl: "https://demo.instance.emulators.dev",
      manifest: {
        id: "demo",
        name: "Demo",
        description: "Demo emulator.",
        surfaces: [{ id: "rest", kind: "rest", title: "REST API", status: "partial", basePath: "/" }],
        auth: [{ id: "bearer", title: "Bearer token", type: "bearer-token", status: "supported" }],
        specs: [{ kind: "manual", title: "Manual behavior", coverage: "partial" }],
      },
    });

    const credentialRes = await app.request("/_emulate/credentials", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ login: "octocat", scopes: ["repo"] }),
    });
    expect(credentialRes.status).toBe(200);
    const credentialBody = (await credentialRes.json()) as { credential: { token: string; login: string } };
    expect(credentialBody.credential.token).toMatch(/^emu_demo_/);
    expect(credentialBody.credential.login).toBe("octocat");

    const createRes = await app.request("/things", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${credentialBody.credential.token}`,
      },
      body: JSON.stringify({ name: "created" }),
    });
    expect(createRes.status).toBe(201);

    const ledger = (await (await app.request("/_emulate/ledger")).json()) as {
      entries: Array<{ identity: { user?: { login: string } } }>;
    };
    expect(ledger.entries[0]!.identity.user?.login).toBe("octocat");
  });

  it("runs runtime seed callbacks and advertises spec helpers", async () => {
    const { app, store } = createServer(plugin, {
      baseUrl: "https://demo.instance.emulators.dev",
      manifest: {
        id: "demo",
        name: "Demo",
        description: "Demo emulator.",
        surfaces: [
          { id: "rest", kind: "rest", title: "REST API", status: "partial", basePath: "/" },
          { id: "graphql", kind: "graphql", title: "GraphQL API", status: "partial", basePath: "/graphql" },
        ],
        auth: [{ id: "bearer", title: "Bearer token", type: "bearer-token", status: "supported" }],
        specs: [{ kind: "openapi", title: "OpenAPI subset", coverage: "hand-authored", url: "/openapi.json" }],
      },
      seed(seed) {
        const body = seed as { things?: Array<{ name: string }> };
        for (const thing of body.things ?? []) {
          store.collection<Thing>("demo.things").insert({ name: thing.name });
        }
      },
    });

    const seedRes = await app.request("/_emulate/seed", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ things: [{ name: "runtime" }] }),
    });
    expect(seedRes.status).toBe(200);
    const things = (await (await app.request("/things")).json()) as { things: Thing[] };
    expect(things.things.map((t) => t.name)).toContain("runtime");

    const specs = (await (await app.request("/_emulate/specs")).json()) as { specs: Array<{ kind: string }> };
    expect(specs.specs[0]!.kind).toBe("openapi");

    const openapi = await app.request("/_emulate/openapi");
    expect(openapi.status).toBe(302);
    expect(openapi.headers.get("location")).toBe("https://demo.instance.emulators.dev/openapi.json");

    const graphql = (await (await app.request("/_emulate/graphql")).json()) as { endpoint: string };
    expect(graphql.endpoint).toBe("https://demo.instance.emulators.dev/graphql");
  });
});
