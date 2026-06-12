import { describe, expect, it } from "vitest";
import { createServer } from "../server.js";
import { EmulatorClient, EmulatorControlError } from "../client.js";
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
  },
};

const BASE = "https://demo.instance.emulators.dev";

const makeClient = () => {
  const { app, store, ledger } = createServer(plugin, {
    baseUrl: BASE,
    manifest: {
      id: "demo",
      name: "Demo",
      description: "Demo emulator.",
      surfaces: [{ id: "rest", kind: "rest", title: "REST API", status: "partial", basePath: "/" }],
      auth: [{ id: "bearer", title: "Bearer token", type: "bearer-token", status: "partial" }],
      specs: [{ kind: "manual", title: "Manual behavior", coverage: "partial" }],
    },
    instance: "instance",
    tokens: { admin: { login: "admin", id: 1, scopes: ["demo"] } },
    seed: () => {},
  });
  plugin.seed?.(store, BASE);
  const client = new EmulatorClient(BASE, { fetch: (input, init) => app.request(input, init) });
  return { client, app, ledger };
};

describe("EmulatorClient", () => {
  it("reads manifest, specs, coverage, state, and quickstart, typed", async () => {
    const { client } = makeClient();

    const { manifest, instance } = await client.manifest();
    expect(manifest.id).toBe("demo");
    expect(instance.controlBaseUrl).toBe(`${BASE}/_emulate`);

    const specs = await client.specs();
    expect(specs.surfaces[0]?.kind).toBe("rest");

    const coverage = await client.coverage();
    expect(coverage.summary).toHaveProperty("hand-authored");

    const state = await client.state();
    expect(state.collections["demo.things"]).toBeDefined();

    expect(await client.quickstart()).toContain("Provider base URL");
    expect(client.openapiUrl).toBe(`${BASE}/_emulate/openapi`);
  });

  it("lists and clears the ledger with typed entries", async () => {
    const { client, app } = makeClient();
    await app.request("/things", { headers: { authorization: "Bearer admin" } });

    const entries = await client.ledger.list();
    const hit = entries.find((entry) => entry.path === "/things");
    expect(hit?.method).toBe("GET");
    expect(hit?.response.status).toBe(200);
    expect(hit?.identity.user?.login).toBe("admin");

    await client.ledger.clear();
    expect(await client.ledger.list()).toHaveLength(0);
  });

  it("mints credentials in the service's shape", async () => {
    const { client } = makeClient();
    const credential = await client.credentials.mint({ type: "bearer-token", login: "tester" });
    expect(credential.type).toBe("bearer-token");
    expect(credential.token).toBeTruthy();
  });

  it("surfaces control-plane failures as EmulatorControlError", async () => {
    const { client } = makeClient();
    // This createServer has no runtime `seed` support wired beyond the no-op,
    // so an invalid body still 200s; use an unknown credential type instead.
    await expect(client.credentials.mint({ type: "no-such-kind" })).rejects.toThrowError(
      EmulatorControlError,
    );
  });
});
