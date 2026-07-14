import { describe, expect, it } from "vitest";
import { EmulatorDurableObject } from "../durable-object.js";
import worker, { parseHostRoute, type Env } from "../worker.js";

describe("cloudflare worker routing", () => {
  it("passes docs.<suffix> through to the docs custom-domain worker", async () => {
    const env: Env = {
      EMULATE_HOST_SUFFIX: "emulators.dev",
      EMULATOR: { idFromName: (n) => n, get: () => ({ fetch: async () => Response.json({}) }) },
    };
    const passedThrough: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: Request | string | URL) => {
      passedThrough.push(input instanceof Request ? input.url : String(input));
      return new Response("docs site");
    }) as typeof fetch;
    try {
      const res = await worker.fetch(new Request("https://docs.emulators.dev/docs/deployment"), env);
      expect(await res.text()).toBe("docs site");
      expect(passedThrough).toEqual(["https://docs.emulators.dev/docs/deployment"]);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("parses service and instance from the preferred subdomain route", () => {
    expect(parseHostRoute("github.instance.emulators.dev", "emulators.dev")).toEqual({
      service: "github",
      instance: "instance",
      suffix: "emulators.dev",
    });
    expect(parseHostRoute("github.emulators.dev", "emulators.dev")).toEqual({
      service: "github",
      suffix: "emulators.dev",
    });
    expect(parseHostRoute("emulators.dev", "emulators.dev")).toBeNull();
  });

  it("forwards host-routed requests with the origin as the provider base URL", async () => {
    const seen: Array<{ idName: string; url: string; service: string | null; baseUrl: string | null }> = [];
    const env: Env = {
      EMULATOR: {
        idFromName(name) {
          return name;
        },
        get(id) {
          return {
            async fetch(request) {
              seen.push({
                idName: String(id),
                url: request.url,
                service: request.headers.get("x-emulator-service"),
                baseUrl: request.headers.get("x-emulator-base-url"),
              });
              return Response.json({ ok: true });
            },
          };
        },
      },
    };

    const response = await worker.fetch(
      new Request("https://github.instance.emulators.dev/repos/acme/widget?per_page=1"),
      env,
    );

    expect(response.status).toBe(200);
    expect(seen).toEqual([
      {
        idName: "github:instance",
        url: "https://github.instance.emulators.dev/repos/acme/widget?per_page=1",
        service: "github",
        baseUrl: "https://github.instance.emulators.dev",
      },
    ]);
  });

  it("creates named instance URLs in the cert-safe path form with an unguessable suffix", async () => {
    const env: Env = {
      EMULATE_HOST_SUFFIX: "emulators.dev",
      EMULATOR: { idFromName: (n) => n, get: () => ({ fetch: async () => Response.json({}) }) },
    };

    const response = await worker.fetch(
      new Request("https://github.emulators.dev/_emulate/instances", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ instance: "smoke" }),
      }),
      env,
    );

    expect(response.status).toBe(200);
    const created = (await response.json()) as {
      service: string;
      instance: string;
      providerBaseUrl: string;
      controlBaseUrl: string;
    };
    expect(created.service).toBe("github");
    // The requested name is only a prefix: the instance URL is the sole access
    // control, so the server always appends 96 bits of randomness.
    expect(created.instance).toMatch(/^smoke-[0-9a-f]{24}$/);
    // Path form on the apex: a 2-label instance subdomain has no Universal SSL cert.
    expect(created.providerBaseUrl).toBe(`https://emulators.dev/github/${created.instance}`);
    expect(created.controlBaseUrl).toBe(`https://emulators.dev/github/${created.instance}/_emulate`);
  });

  it("generates a fully random instance name when none is requested", async () => {
    const env: Env = {
      EMULATE_HOST_SUFFIX: "emulators.dev",
      EMULATOR: { idFromName: (n) => n, get: () => ({ fetch: async () => Response.json({}) }) },
    };

    const response = await worker.fetch(
      new Request("https://github.emulators.dev/_emulate/instances", { method: "POST" }),
      env,
    );

    expect(response.status).toBe(200);
    const created = (await response.json()) as { instance: string };
    expect(created.instance).toMatch(/^[0-9a-f]{24}$/);
  });

  it("serves the service host as control plane only, with no shared default instance", async () => {
    let doHits = 0;
    const env: Env = {
      EMULATE_HOST_SUFFIX: "emulators.dev",
      EMULATOR: {
        idFromName: (n) => n,
        get: () => ({
          async fetch() {
            doHits++;
            return Response.json({ ok: true });
          },
        }),
      },
    };

    // The service-level control plane answers without any instance (or DO call).
    const manifestRes = await worker.fetch(new Request("https://github.emulators.dev/_emulate/manifest"), env);
    expect(manifestRes.status).toBe(200);
    const manifest = (await manifestRes.json()) as { manifest: { id: string }; instance: unknown };
    expect(manifest.manifest.id).toBe("github");
    expect(manifest.instance).toBeNull();

    // Provider routes have no shared instance behind the well-known host: they
    // point at instance creation instead of serving world-readable state.
    const provider = await worker.fetch(
      new Request("https://github.emulators.dev/user", { headers: { accept: "application/json" } }),
      env,
    );
    expect(provider.status).toBe(404);
    await expect(provider.json()).resolves.toMatchObject({
      error: "instance_required",
      createInstance: "https://github.emulators.dev/_emulate/instances",
    });

    // Same for instance-scoped control-plane routes like /_emulate/state.
    const state = await worker.fetch(new Request("https://github.emulators.dev/_emulate/state"), env);
    expect(state.status).toBe(404);

    expect(doHits).toBe(0);
  });

  it("serves the SPA to browser navigations but the no-JS landing to agents", async () => {
    let doHits = 0;
    const env: Env = {
      EMULATE_HOST_SUFFIX: "emulators.dev",
      EMULATOR: {
        idFromName: (n) => n,
        get: () => ({
          async fetch(request) {
            doHits++;
            return Response.json({ path: new URL(request.url).pathname });
          },
        }),
      },
    };

    const browser = await worker.fetch(
      new Request("https://github.emulators.dev/", { headers: { accept: "text/html", "sec-fetch-mode": "navigate" } }),
      env,
    );
    expect(browser.headers.get("content-type")).toContain("text/html");

    // Agent root gets the server-rendered service landing; agents asking for
    // JSON get the service-level manifest. Neither touches a Durable Object.
    const agent = await worker.fetch(new Request("https://github.emulators.dev/", { headers: { accept: "*/*" } }), env);
    expect(agent.status).toBe(200);
    expect(agent.headers.get("content-type")).toContain("text/html");
    expect(await agent.text()).toContain("Create an instance");

    const agentJson = await worker.fetch(
      new Request("https://github.emulators.dev/", { headers: { accept: "application/json" } }),
      env,
    );
    expect(agentJson.status).toBe(200);
    const body = (await agentJson.json()) as { manifest: { id: string } };
    expect(body.manifest.id).toBe("github");

    expect(doHits).toBe(0);
  });

  it("lists the deployed service catalog from any host", async () => {
    const env: Env = {
      EMULATE_HOST_SUFFIX: "emulators.dev",
      EMULATOR: { idFromName: (n) => n, get: () => ({ fetch: async () => Response.json({}) }) },
    };
    const res = await worker.fetch(new Request("https://emulators.dev/_emulate/services"), env);
    expect(res.status).toBe(200);
    const { services } = (await res.json()) as { services: Array<{ id: string }> };
    const ids = services.map((s) => s.id);
    expect(ids).toContain("github");
    expect(ids).toContain("mcp");
    expect(ids).toContain("stripe");
  });

  it("keeps path routing available for local and shared-domain URLs", async () => {
    const seen: Array<{ idName: string; url: string; baseUrl: string | null }> = [];
    const env: Env = {
      EMULATOR: {
        idFromName(name) {
          return name;
        },
        get(id) {
          return {
            async fetch(request) {
              seen.push({
                idName: String(id),
                url: request.url,
                baseUrl: request.headers.get("x-emulator-base-url"),
              });
              return Response.json({ ok: true });
            },
          };
        },
      },
    };

    await worker.fetch(new Request("https://emulators.dev/github/instance/repos/acme/widget"), env);

    expect(seen).toEqual([
      {
        idName: "github:instance",
        url: "https://emulators.dev/repos/acme/widget",
        baseUrl: "https://emulators.dev/github/instance",
      },
    ]);
  });
});

describe("cloudflare durable object control plane", () => {
  function makeState(options: { limit?: number; initial?: Record<string, unknown> } = {}) {
    const storage = new Map<string, unknown>();
    const puts: Array<{ key: string; size: number }> = [];
    const clone = <T>(value: T): T => (value === undefined ? value : JSON.parse(JSON.stringify(value)));
    const sizeOf = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).length;

    for (const [key, value] of Object.entries(options.initial ?? {})) {
      storage.set(key, clone(value));
    }

    return {
      storage,
      puts,
      state: {
        storage: {
          async get<T>(key: string): Promise<T | undefined> {
            return clone(storage.get(key) as T | undefined);
          },
          async put(key: string, value: unknown): Promise<void> {
            const size = sizeOf(value);
            puts.push({ key, size });
            if (options.limit !== undefined && size > options.limit) {
              throw new Error(
                `Values cannot be larger than ${options.limit} bytes. A value of size ${size} was provided.`,
              );
            }
            storage.set(key, clone(value));
          },
          async delete(key: string | string[]): Promise<boolean | number> {
            if (Array.isArray(key)) {
              let count = 0;
              for (const item of key) {
                if (storage.delete(item)) count++;
              }
              return count;
            }
            return storage.delete(key);
          },
          async list<T>(options?: { prefix?: string }): Promise<Map<string, T>> {
            const out = new Map<string, T>();
            for (const [key, value] of storage) {
              if (!options?.prefix || key.startsWith(options.prefix)) {
                out.set(key, clone(value) as T);
              }
            }
            return out;
          },
        },
        async blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T> {
          return fn();
        },
      },
    };
  }

  it("creates hosted credentials and persists the resulting state", async () => {
    const { storage, state } = makeState();
    const durableObject = new EmulatorDurableObject(state, {});

    const credentialRes = await durableObject.fetch(
      new Request("https://github.instance.emulators.dev/_emulate/credentials", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-emulator-service": "github",
          "x-emulator-base-url": "https://github.instance.emulators.dev",
        },
        body: JSON.stringify({ type: "bearer-token", login: "agent-user", scopes: ["repo"] }),
      }),
    );
    expect(credentialRes.status).toBe(200);
    const credentialBody = (await credentialRes.json()) as { credential: { token: string } };
    expect(credentialBody.credential.token).toMatch(/^emu_github_/);

    const userRes = await durableObject.fetch(
      new Request("https://github.instance.emulators.dev/user", {
        headers: {
          authorization: `Bearer ${credentialBody.credential.token}`,
          "x-emulator-service": "github",
          "x-emulator-base-url": "https://github.instance.emulators.dev",
        },
      }),
    );
    expect(userRes.status).toBe(200);
    const user = (await userRes.json()) as { login: string };
    expect(user.login).toBe("agent-user");

    expect(storage.get("snapshot:meta")).toBeDefined();
    expect([...storage.keys()].some((key) => key.startsWith("minted:"))).toBe(true);
  });

  const idHeaders = (extra: Record<string, string> = {}) => ({
    "x-emulator-service": "github",
    "x-emulator-instance": "my-run",
    "x-emulator-base-url": "https://github.my-run.emulators.dev",
    ...extra,
  });

  it("reports the real instance id in the manifest", async () => {
    const { state } = makeState();
    const durableObject = new EmulatorDurableObject(state, {});
    const res = await durableObject.fetch(
      new Request("https://github.my-run.emulators.dev/_emulate/manifest", { headers: idHeaders() }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { instance: { instance?: string; service: string } };
    expect(body.instance.instance).toBe("my-run");
    expect(body.instance.service).toBe("github");
  });

  it("serves the standalone MCP image fixture service", async () => {
    const { state } = makeState();
    const durableObject = new EmulatorDurableObject(state, {});
    const res = await durableObject.fetch(
      new Request("https://emulators.dev/mcp?token=demo-token", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-emulator-service": "mcp",
          "x-emulator-instance": "query",
          "x-emulator-base-url": "https://emulators.dev/mcp/query",
          "x-emulator-mcp-mode": "query",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "get_test_image", arguments: {} },
        }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result?: { content?: Array<{ type?: string; mimeType?: string; data?: string }> };
    };
    expect(body.result?.content?.[0]).toMatchObject({
      type: "image",
      mimeType: "image/png",
    });
    expect(Buffer.from(body.result?.content?.[0]?.data ?? "", "base64").byteLength).toBe(70);
  });

  it("splits minted credentials so credential history does not overflow one storage value", async () => {
    const LIMIT = 8_000;
    const { storage, state, puts } = makeState({ limit: LIMIT });
    const makeDo = () => new EmulatorDurableObject(state, {});
    let durableObject = makeDo();
    const mint = (login: string) =>
      durableObject.fetch(
        new Request("https://github.instance.emulators.dev/_emulate/credentials", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-emulator-service": "github",
            "x-emulator-base-url": "https://github.instance.emulators.dev",
          },
          body: JSON.stringify({ type: "bearer-token", login, scopes: ["repo"] }),
        }),
      );

    let firstToken = "";
    let lastToken = "";
    for (let i = 0; i < 150; i++) {
      const res = await mint("agent");
      expect(res.status, `mint ${i} must not fail on the per-value cap`).toBe(200);
      lastToken = ((await res.json()) as { credential: { token: string } }).credential.token;
      firstToken ||= lastToken;
    }

    expect(puts.every((put) => put.size <= LIMIT)).toBe(true);
    expect([...storage.keys()].filter((key) => key.startsWith("minted:"))).toHaveLength(150);
    expect((storage.get("state") as { minted?: unknown[] } | undefined)?.minted).toBeUndefined();

    // A fresh Durable Object over the same storage simulates eviction + rebuild.
    // Split credential records keep both old and new tokens usable.
    durableObject = makeDo(); // fresh DO over the same storage == eviction + rebuild
    const firstUserRes = await durableObject.fetch(
      new Request("https://github.instance.emulators.dev/user", {
        headers: {
          authorization: `Bearer ${firstToken}`,
          "x-emulator-service": "github",
          "x-emulator-base-url": "https://github.instance.emulators.dev",
        },
      }),
    );
    expect(firstUserRes.status).toBe(200);

    const lastUserRes = await durableObject.fetch(
      new Request("https://github.instance.emulators.dev/user", {
        headers: {
          authorization: `Bearer ${lastToken}`,
          "x-emulator-service": "github",
          "x-emulator-base-url": "https://github.instance.emulators.dev",
        },
      }),
    );
    expect(lastUserRes.status).toBe(200);
  });

  it("migrates a legacy oversized combined state blob before Resend credential mint writes", async () => {
    const LIMIT = 8_000;
    const legacyEntries = Array.from({ length: 70 }, (_, i) => ({
      id: `req_${i + 1}`,
      correlationId: `cor_${i + 1}`,
      timestamp: "2026-07-04T09:00:00.000Z",
      method: "POST",
      host: "resend.emulators.dev",
      path: "/emails",
      query: "",
      route: "/emails",
      operationId: "emails.send",
      request: {
        headers: { "content-type": "application/json" },
        body: { to: `user-${i}@example.com`, subject: "executor", html: "x".repeat(120) },
      },
      identity: {},
      response: {
        status: 200,
        headers: { "content-type": "application/json" },
        body: { id: `email_${i}`, object: "email" },
      },
      summary: "POST /emails -> 200",
      sideEffects: [],
      webhookDeliveries: [],
      durationMs: 1,
    }));
    const legacyMinted = Array.from({ length: 120 }, (_, i) => ({
      token: `re_legacy_${String(i).padStart(4, "0")}`,
      login: "admin",
      id: i + 1,
      scopes: [],
    }));
    const legacyState = {
      strict: true,
      snapshot: { collections: {}, data: {} },
      ledger: { entries: legacyEntries, counter: legacyEntries.length + 1 },
      minted: legacyMinted,
    };
    const legacySize = new TextEncoder().encode(JSON.stringify(legacyState)).length;
    expect(legacySize).toBeGreaterThan(LIMIT);

    const { storage, state, puts } = makeState({ limit: LIMIT, initial: { state: legacyState } });
    const durableObject = new EmulatorDurableObject(state, {});
    const credentialRes = await durableObject.fetch(
      new Request("https://resend.emulators.dev/_emulate/credentials", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-emulator-service": "resend",
          "x-emulator-base-url": "https://resend.emulators.dev",
        },
        body: JSON.stringify({ type: "api-key" }),
      }),
    );

    expect(credentialRes.status).toBe(200);
    const body = (await credentialRes.json()) as { credential: { token: string } };
    expect(body.credential.token).toMatch(/^re_/);
    expect(puts.every((put) => put.size <= LIMIT)).toBe(true);
    expect(storage.get("state")).toEqual({ strict: true });
    expect([...storage.keys()].filter((key) => key.startsWith("minted:"))).toHaveLength(121);
    expect([...storage.keys()].filter((key) => key.startsWith("ledger:entry:"))).toHaveLength(70);
  });

  it("persists the request ledger across durable object eviction", async () => {
    const { state } = makeState();
    const do1 = new EmulatorDurableObject(state, {});

    const credRes = await do1.fetch(
      new Request("https://github.my-run.emulators.dev/_emulate/credentials", {
        method: "POST",
        headers: idHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({ type: "bearer-token", login: "agent" }),
      }),
    );
    const token = ((await credRes.json()) as { credential: { token: string } }).credential.token;

    const created = await do1.fetch(
      new Request("https://github.my-run.emulators.dev/user/repos", {
        method: "POST",
        headers: idHeaders({ authorization: `Bearer ${token}`, "content-type": "application/json" }),
        body: JSON.stringify({ name: "widget" }),
      }),
    );
    expect(created.status).toBeLessThan(500);

    // A fresh Durable Object over the same storage simulates eviction + rebuild.
    const do2 = new EmulatorDurableObject(state, {});
    const ledgerRes = await do2.fetch(
      new Request("https://github.my-run.emulators.dev/_emulate/ledger", { headers: idHeaders() }),
    );
    const { entries } = (await ledgerRes.json()) as {
      entries: Array<{ method: string; path: string; correlationId: string; summary: string }>;
    };
    const repoCall = entries.find((e) => e.method === "POST" && e.path === "/user/repos");
    expect(repoCall).toBeDefined();
    expect(repoCall?.correlationId).toMatch(/^cor_|.+/);
    expect(repoCall?.summary).toContain("POST");
  });

  it("the scope-discovery preset deploys resource-silent, AS-scoped MCP metadata", async () => {
    const { state } = makeState();
    const durableObject = new EmulatorDurableObject(state, {});
    // `/github/scope-discovery/mcp` routes the preset in via this header (the
    // worker derives it from the instance segment).
    const headers = {
      "x-emulator-service": "github",
      "x-emulator-instance": "scope-discovery",
      "x-emulator-base-url": "https://github.scope-discovery.emulators.dev",
      "x-emulator-mcp-mode": "scope-discovery",
    };

    // The protected resource stays silent on scopes, so a discovering client must
    // fall back to the authorization server it names.
    const prRes = await durableObject.fetch(
      new Request("https://github.scope-discovery.emulators.dev/.well-known/oauth-protected-resource", { headers }),
    );
    expect(prRes.status).toBe(200);
    const pr = (await prRes.json()) as Record<string, unknown>;
    expect(pr).not.toHaveProperty("scopes_supported");
    expect(pr.authorization_servers).toEqual(["https://github.scope-discovery.emulators.dev"]);

    // The authorization-server metadata carries the discoverable scopes.
    const asRes = await durableObject.fetch(
      new Request("https://github.scope-discovery.emulators.dev/.well-known/oauth-authorization-server", { headers }),
    );
    expect(asRes.status).toBe(200);
    const as = (await asRes.json()) as Record<string, unknown>;
    expect(as.scopes_supported).toEqual(["channels:history", "users:read"]);
  });
});
