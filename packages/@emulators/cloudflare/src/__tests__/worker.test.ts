import { describe, expect, it } from "vitest";
import { EmulatorDurableObject } from "../durable-object.js";
import worker, { parseHostRoute, type Env } from "../worker.js";

describe("cloudflare worker routing", () => {
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

  it("creates named instance URLs in the cert-safe path form", async () => {
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
    // Path form on the apex: a 2-label instance subdomain has no Universal SSL cert.
    await expect(response.json()).resolves.toMatchObject({
      service: "github",
      instance: "smoke",
      providerBaseUrl: "https://emulators.dev/github/smoke",
      controlBaseUrl: "https://emulators.dev/github/smoke/_emulate",
    });
  });

  it("routes the service host to a default instance over the valid 1-label cert", async () => {
    const seen: Array<{
      idName: string;
      url: string;
      service: string | null;
      instance: string | null;
      baseUrl: string | null;
    }> = [];
    const env: Env = {
      EMULATE_HOST_SUFFIX: "emulators.dev",
      EMULATOR: {
        idFromName: (n) => n,
        get: (id) => ({
          async fetch(request) {
            seen.push({
              idName: String(id),
              url: request.url,
              service: request.headers.get("x-emulator-service"),
              instance: request.headers.get("x-emulator-instance"),
              baseUrl: request.headers.get("x-emulator-base-url"),
            });
            return Response.json({ ok: true });
          },
        }),
      },
    };

    // Provider API and /_emulate both resolve to the default instance.
    await worker.fetch(
      new Request("https://github.emulators.dev/user", { headers: { accept: "application/json" } }),
      env,
    );
    await worker.fetch(new Request("https://github.emulators.dev/_emulate/manifest"), env);

    expect(seen).toEqual([
      {
        idName: "github:default",
        url: "https://github.emulators.dev/user",
        service: "github",
        instance: "default",
        baseUrl: "https://github.emulators.dev",
      },
      {
        idName: "github:default",
        url: "https://github.emulators.dev/_emulate/manifest",
        service: "github",
        instance: "default",
        baseUrl: "https://github.emulators.dev",
      },
    ]);
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
    expect(doHits).toBe(0); // SPA served directly, no DO call

    const agent = await worker.fetch(new Request("https://github.emulators.dev/", { headers: { accept: "*/*" } }), env);
    expect(agent.status).toBe(200);
    expect(doHits).toBe(1); // agent root forwarded to the default instance's /_emulate landing
    await expect(agent.json()).resolves.toMatchObject({ path: "/_emulate" });
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
  it("creates hosted credentials and persists the resulting state", async () => {
    const storage = new Map<string, unknown>();
    const state = {
      storage: {
        async get<T>(key: string): Promise<T | undefined> {
          return storage.get(key) as T | undefined;
        },
        async put(key: string, value: unknown): Promise<void> {
          storage.set(key, value);
        },
      },
      async blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T> {
        return fn();
      },
    };
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

    const persisted = storage.get("state") as { snapshot?: unknown } | undefined;
    expect(persisted?.snapshot).toBeDefined();
  });

  function makeState() {
    const storage = new Map<string, unknown>();
    return {
      storage,
      state: {
        storage: {
          async get<T>(key: string): Promise<T | undefined> {
            return storage.get(key) as T | undefined;
          },
          async put(key: string, value: unknown): Promise<void> {
            storage.set(key, value);
          },
        },
        async blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T> {
          return fn();
        },
      },
    };
  }

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

  it("sheds old history instead of failing mints when the state value would overflow the cap", async () => {
    // Durable Object storage caps each value at 128 KiB. A long-lived shared
    // instance accrues minted tokens (and ledger entries) under one "state"
    // key; once the blob crosses the cap, an unguarded put throws and every
    // future mint 400s. Simulate the cap with a byte-limited fake store and
    // prove the instance trims its oldest history rather than wedging.
    const storage = new Map<string, unknown>();
    const LIMIT = 8_000;
    const state = {
      storage: {
        async get<T>(key: string): Promise<T | undefined> {
          return storage.get(key) as T | undefined;
        },
        async put(key: string, value: unknown): Promise<void> {
          const size = new TextEncoder().encode(JSON.stringify(value)).length;
          if (size > LIMIT) {
            throw new Error(`Values cannot be larger than ${LIMIT} bytes. A value of size ${size} was provided.`);
          }
          storage.set(key, JSON.parse(JSON.stringify(value)));
        },
      },
      async blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T> {
        return fn();
      },
    };
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

    let lastToken = "";
    for (let i = 0; i < 150; i++) {
      const res = await mint("agent");
      expect(res.status, `mint ${i} must not fail on the 128 KiB value cap`).toBe(200);
      lastToken = ((await res.json()) as { credential: { token: string } }).credential.token;
    }

    // Shedding actually happened: fewer tokens persisted than were minted.
    const persisted = storage.get("state") as { minted?: unknown[] };
    expect(persisted.minted?.length).toBeLessThan(150);

    // The most recent token survives eviction — shedding drops the OLDEST
    // history, never the credential we just issued.
    durableObject = makeDo(); // fresh DO over the same storage == eviction + rebuild
    const userRes = await durableObject.fetch(
      new Request("https://github.instance.emulators.dev/user", {
        headers: {
          authorization: `Bearer ${lastToken}`,
          "x-emulator-service": "github",
          "x-emulator-base-url": "https://github.instance.emulators.dev",
        },
      }),
    );
    expect(userRes.status).toBe(200);
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
