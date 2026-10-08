import { describe, expect, it, vi } from "vitest";
import { EmulatorDurableObject } from "../durable-object.js";
import { instanceId } from "../diagnostics.js";
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
    expect(ids).toContain("context");
    expect(ids).toContain("planetscale");
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

// Synthetic secrets: an instance URL is the only access control for its
// emulator, and errors and paths can quote tokens, codes and addresses. None of
// these may reach a failure response or a log line.
const SECRET_INSTANCE = "d040-probe-0123456789abcdef01234567";
const SECRETS = [
  SECRET_INSTANCE,
  "0123456789abcdef01234567",
  "emu_resend_SYNTHETICtoken0001",
  "SYNTH-CODE-482913",
  "pat.synthetic@example.test",
  "SYNTHETICtoken482913",
];
const leakedSecrets = (text: string) => SECRETS.filter((secret) => text.includes(secret));
const REPORT_KEYS = [
  "error",
  "errorClass",
  "instanceId",
  "method",
  "overloaded",
  "ray",
  "remote",
  "retryable",
  "route",
  "service",
];
const RAY = "8f1d2c3b4a5e6f70-PHX";

describe("cloudflare worker durable object failures", () => {
  // Cloudflare raises Durable Object stub failures as exceptions carrying
  // `.retryable`, `.overloaded` and `.remote` flags.
  const doError = (message: string, flags: { retryable?: boolean; overloaded?: boolean; remote?: boolean }) =>
    Object.assign(new Error(message), flags);

  const failingEnv = (failures: Error[]) => {
    const calls: string[] = [];
    const env: Env = {
      EMULATOR: {
        idFromName: (n) => n,
        get: () => ({
          async fetch(request) {
            calls.push(`${request.method} ${new URL(request.url).pathname}`);
            const failure = failures.shift();
            if (failure) throw failure;
            return Response.json({ ok: true });
          },
        }),
      },
    };
    return { env, calls };
  };

  const captureErrors = () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    return {
      text: () => spy.mock.calls.map((args) => args.map(String).join(" ")).join("\n"),
      restore: () => spy.mockRestore(),
    };
  };

  it("answers a retryable reset once, with a report and no replay", async () => {
    const logs = captureErrors();
    try {
      const { env, calls } = failingEnv([doError("Network connection lost.", { retryable: true })]);
      const response = await worker.fetch(
        new Request(`https://emulators.dev/resend/${SECRET_INSTANCE}/_emulate/reset`, {
          method: "POST",
          headers: { "cf-ray": RAY },
          body: "{}",
        }),
        env,
      );
      // A retryable flag does not prove the object never ran the reset.
      expect(calls).toEqual(["POST /_emulate/reset"]);
      expect(response.status).toBe(503);
      const report = await response.json();
      expect(report).toEqual({
        error: "emulator_unavailable",
        service: "resend",
        instanceId: await instanceId("resend", SECRET_INSTANCE),
        method: "POST",
        route: "/_emulate/reset",
        errorClass: "Error",
        retryable: true,
        overloaded: false,
        remote: false,
        ray: RAY,
      });
      expect(JSON.parse(logs.text())).toEqual(report);
    } finally {
      logs.restore();
    }
  });

  it("does not replay a WorkOS authorize, which issues a code on every call", async () => {
    const { env, calls } = failingEnv([doError("Network connection lost.", { retryable: true })]);
    const response = await worker.fetch(
      new Request(
        `https://emulators.dev/workos/${SECRET_INSTANCE}/oauth2/authorize?client_id=c&redirect_uri=https%3A%2F%2Fapp.example.test%2Fcb`,
      ),
      env,
    );
    expect(calls).toEqual(["GET /oauth2/authorize"]);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ route: "/oauth2/authorize", retryable: true });
  });

  it("keeps tokens, codes, addresses and the instance out of the response and the log", async () => {
    const logs = captureErrors();
    try {
      const failure = doError(
        `lost while serving ${SECRET_INSTANCE}: token emu_resend_SYNTHETICtoken0001 code SYNTH-CODE-482913 for pat.synthetic@example.test`,
        { retryable: true },
      );
      const { env } = failingEnv([failure]);
      const response = await worker.fetch(
        new Request(
          `https://emulators.dev/resend/${SECRET_INSTANCE}/domains/pat.synthetic@example.test?code=SYNTH-CODE-482913`,
          {
            headers: { authorization: "Bearer emu_resend_SYNTHETICtoken0001", "cf-ray": RAY },
          },
        ),
        env,
      );
      const text = await response.text();
      const report = JSON.parse(text) as Record<string, unknown>;
      expect(Object.keys(report).sort()).toEqual(REPORT_KEYS);
      expect(report.route).toBe("/domains/:id");
      expect(leakedSecrets(text)).toEqual([]);
      expect(logs.text()).not.toBe("");
      expect(leakedSecrets(logs.text())).toEqual([]);
    } finally {
      logs.restore();
    }
  });

  it("does not echo header or path values it cannot vouch for", async () => {
    const logs = captureErrors();
    try {
      const { env } = failingEnv([doError("Network connection lost.", { retryable: true })]);
      const response = await worker.fetch(
        new Request(`https://emulators.dev/pat.synthetic@example.test/${SECRET_INSTANCE}/emails`, {
          headers: { "cf-ray": "SYNTH-CODE-482913" },
        }),
        env,
      );
      const text = await response.text();
      expect(JSON.parse(text)).toMatchObject({ service: "unknown", route: "unmatched", ray: null });
      expect(leakedSecrets(text)).toEqual([]);
      expect(leakedSecrets(logs.text())).toEqual([]);
    } finally {
      logs.restore();
    }
  });

  it("answers an overloaded object with a 503", async () => {
    const { env, calls } = failingEnv([
      doError("Durable Object is overloaded. Too many requests queued.", { retryable: true, overloaded: true }),
    ]);
    const response = await worker.fetch(new Request(`https://emulators.dev/resend/${SECRET_INSTANCE}/emails`), env);
    expect(calls).toEqual(["GET /emails"]);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ overloaded: true, route: "/emails" });
  });

  it("reports an object killed by its own limits as a 500", async () => {
    const { env, calls } = failingEnv([
      doError("Durable Object's isolate exceeded its memory limit and was reset.", { remote: true }),
    ]);
    const response = await worker.fetch(new Request(`https://emulators.dev/resend/${SECRET_INSTANCE}/emails`), env);
    expect(calls).toHaveLength(1);
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ remote: true, retryable: false, service: "resend" });
  });

  it("reports failures to read the body or address the object instead of throwing", async () => {
    const logs = captureErrors();
    try {
      const secretError = () => new Error(`lost ${SECRET_INSTANCE} token emu_resend_SYNTHETICtoken0001`);
      const addressing: Env = {
        EMULATOR: {
          idFromName: () => {
            throw secretError();
          },
          get: () => ({ fetch: async () => Response.json({ ok: true }) }),
        },
      };
      const addressed = await worker.fetch(
        new Request(`https://emulators.dev/resend/${SECRET_INSTANCE}/emails`),
        addressing,
      );
      expect(addressed.status).toBe(500);
      expect(await addressed.json()).toMatchObject({ error: "emulator_unavailable", route: "/emails" });

      const { env, calls } = failingEnv([]);
      const unreadable = new Request(`https://emulators.dev/resend/${SECRET_INSTANCE}/emails`, {
        method: "POST",
        body: new ReadableStream({
          start(controller) {
            controller.error(secretError());
          },
        }),
        duplex: "half",
      } as RequestInit);
      const read = await worker.fetch(unreadable, env);
      expect(calls).toEqual([]);
      expect(read.status).toBe(500);
      expect(await read.json()).toMatchObject({ error: "emulator_unavailable", route: "/emails" });
      expect(leakedSecrets(logs.text())).toEqual([]);
    } finally {
      logs.restore();
    }
  });

  it("reports any other Worker failure instead of throwing", async () => {
    const logs = captureErrors();
    try {
      const env = {
        get EMULATE_HOST_SUFFIX(): string {
          throw new Error(`config read failed for ${SECRET_INSTANCE}`);
        },
      } as unknown as Env;
      const response = await worker.fetch(new Request(`https://emulators.dev/resend/${SECRET_INSTANCE}/emails`), env);
      const text = await response.text();
      expect(response.status).toBe(500);
      expect(JSON.parse(text)).toEqual({
        error: "worker_error",
        service: "unknown",
        instanceId: null,
        method: "GET",
        route: "unmatched",
        errorClass: "Error",
        retryable: false,
        overloaded: false,
        remote: false,
        ray: null,
      });
      expect(leakedSecrets(text + logs.text())).toEqual([]);
    } finally {
      logs.restore();
    }
  });

  it("reports only allowlisted error classes and methods", async () => {
    const logs = captureErrors();
    try {
      const { env } = failingEnv([
        doError("lost", { retryable: true }),
        Object.assign(doError("lost", { retryable: true }), { name: "SYNTHETICtoken482913" }),
        Object.assign(new TypeError("lost"), { retryable: true }),
      ]);
      const send = (method: string) =>
        worker
          .fetch(new Request(`https://emulators.dev/resend/${SECRET_INSTANCE}/emails`, { method }), env)
          .then((r) => r.json() as Promise<Record<string, unknown>>);
      expect(await send("SYNTHETICTOKEN")).toMatchObject({ method: "OTHER", errorClass: "Error" });
      expect(await send("GET")).toMatchObject({ method: "GET", errorClass: "other" });
      expect(await send("GET")).toMatchObject({ errorClass: "TypeError" });
      expect(logs.text()).not.toContain("SYNTHETICTOKEN");
      expect(leakedSecrets(logs.text())).toEqual([]);
    } finally {
      logs.restore();
    }
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

  // Builds the instance, then makes the next storage write throw `failure` once.
  // One-shot, so a later write (the persist after every mutating request)
  // cannot rethrow it and hide what the router did with the first one.
  const failNextWriteAfterWarmup = async (failure: unknown) => {
    const { state } = makeState();
    const durableObject = new EmulatorDurableObject(state, {});
    const warm = await durableObject.fetch(
      new Request("https://github.my-run.emulators.dev/_emulate/manifest", { headers: idHeaders() }),
    );
    expect(warm.status).toBe(200);
    const put = state.storage.put;
    let thrown = false;
    state.storage.put = async (key, value) => {
      if (thrown) return put(key, value);
      thrown = true;
      throw failure;
    };
    return durableObject;
  };
  const control = (path: string, body: unknown, extra: Record<string, string> = {}) =>
    new Request(`https://github.my-run.emulators.dev${path}`, {
      method: "POST",
      headers: { ...idHeaders(extra), "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const moved = () =>
    Object.assign(new Error("cannot access storage because object has moved to a different machine"), {
      retryable: true,
    });

  it("answers an emulator failure with a report instead of throwing", async () => {
    // A 1-byte value cap makes every persist fail the way an oversized value does.
    const { state } = makeState({ limit: 1 });
    const durableObject = new EmulatorDurableObject(state, {});
    const response = await durableObject.fetch(control("/_emulate/reset", {}, { "cf-ray": RAY }));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: "emulator_error",
      service: "github",
      instanceId: await instanceId("github", "my-run"),
      method: "POST",
      route: "/_emulate/reset",
      errorClass: "Error",
      retryable: false,
      overloaded: false,
      remote: false,
      ray: RAY,
    });
  });

  it("keeps secrets in an emulator error out of the response and the log", async () => {
    const logs = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const durableObject = await failNextWriteAfterWarmup(
        new Error(
          `write failed for ${SECRET_INSTANCE}: token emu_resend_SYNTHETICtoken0001 code SYNTH-CODE-482913 for pat.synthetic@example.test`,
        ),
      );
      // The error is thrown inside the router (reset runs in the control plane),
      // which used to answer it with its raw message.
      const response = await durableObject.fetch(control("/_emulate/reset", {}));
      expect(response.status).toBe(500);
      const text = await response.text();
      expect(Object.keys(JSON.parse(text)).sort()).toEqual(REPORT_KEYS);
      expect(JSON.parse(text)).toMatchObject({ error: "emulator_error", route: "/_emulate/reset" });
      expect(leakedSecrets(text)).toEqual([]);
      const logged = logs.mock.calls.map((args) => args.map(String).join(" ")).join("\n");
      expect(logged).not.toBe("");
      expect(leakedSecrets(logged)).toEqual([]);
    } finally {
      logs.mockRestore();
    }
  });

  // Every failure below must come back as a report: an error thrown out of the
  // object is recorded by Cloudflare with its message, stack and URL.
  const reportOf = async (response: Promise<Response>) => {
    const res = await response;
    return { status: res.status, report: (await res.json()) as Record<string, unknown> };
  };

  it("reports Cloudflare's retryable storage failures with their flags instead of throwing", async () => {
    const { state } = makeState();
    state.storage.get = async () => {
      throw moved();
    };
    const durableObject = new EmulatorDurableObject(state, {});
    // Thrown while the object loads, before the service router runs.
    expect(await reportOf(durableObject.fetch(control("/_emulate/reset", {}, { "cf-ray": RAY })))).toEqual({
      status: 503,
      report: {
        error: "emulator_unavailable",
        service: "github",
        instanceId: await instanceId("github", "my-run"),
        method: "POST",
        route: "/_emulate/reset",
        errorClass: "Error",
        retryable: true,
        overloaded: false,
        remote: false,
        ray: RAY,
      },
    });
  });

  it("reports a flagged failure from inside the service router", async () => {
    const durableObject = await failNextWriteAfterWarmup(moved());
    // Reset persists from inside the router, whose error handler used to answer
    // every error as a plain 500 without the flags.
    expect(await reportOf(durableObject.fetch(control("/_emulate/reset", {})))).toMatchObject({
      status: 503,
      report: { error: "emulator_unavailable", route: "/_emulate/reset", retryable: true },
    });
  });

  it("reports flagged and plain storage failures from seed and credential requests", async () => {
    const logs = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const credentials = () => control("/_emulate/credentials", { type: "bearer-token", login: "synthetic-user" });
      const seed = () => control("/_emulate/seed", { users: [{ login: "synthetic-user" }] });
      const plain = () =>
        new Error(
          `storage write failed for ${SECRET_INSTANCE}: token emu_resend_SYNTHETICtoken0001 for pat.synthetic@example.test`,
        );
      for (const [request, route] of [
        [credentials, "/_emulate/credentials"],
        [seed, "/_emulate/seed"],
      ] as const) {
        expect(await reportOf((await failNextWriteAfterWarmup(moved())).fetch(request()))).toMatchObject({
          status: 503,
          report: { error: "emulator_unavailable", route, retryable: true },
        });
        // A host failure is not the caller's mistake: it used to come back as a
        // 400 quoting the raw message.
        const res = await (await failNextWriteAfterWarmup(plain())).fetch(request());
        const text = await res.text();
        expect({ status: res.status, report: JSON.parse(text) }).toMatchObject({
          status: 500,
          report: { error: "emulator_error", route, errorClass: "Error" },
        });
        expect(leakedSecrets(text)).toEqual([]);
      }
      expect(leakedSecrets(logs.mock.calls.map((args) => args.map(String).join(" ")).join("\n"))).toEqual([]);
    } finally {
      logs.mockRestore();
    }
  });

  it("still answers a credential type the emulator does not support with a 400", async () => {
    const { state } = makeState();
    const durableObject = new EmulatorDurableObject(state, {});
    const res = await durableObject.fetch(control("/_emulate/credentials", { type: "synthetic-unsupported-type" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "unsupported",
      message: "Credential type synthetic-unsupported-type is not supported by github",
    });
  });

  it("reports an error whose name could carry a secret as class other", async () => {
    const logs = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const named = Object.assign(new Error("synthetic"), { name: "SYNTHETICtoken482913" });
      const durableObject = await failNextWriteAfterWarmup(named);
      const res = await durableObject.fetch(control("/_emulate/reset", {}));
      const text = await res.text();
      expect(JSON.parse(text)).toMatchObject({ errorClass: "other" });
      expect(text).not.toContain("SYNTHETICtoken482913");
      expect(logs.mock.calls.flat().map(String).join("\n")).not.toContain("SYNTHETICtoken482913");
    } finally {
      logs.mockRestore();
    }
  });

  it("passes the object's flagged report through the Worker as a 503", async () => {
    const logs = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const durableObject = await failNextWriteAfterWarmup(moved());
      const env: Env = { EMULATOR: { idFromName: (n) => n, get: () => durableObject } };
      const response = await worker.fetch(
        new Request("https://emulators.dev/github/my-run/_emulate/reset", {
          method: "POST",
          headers: { "cf-ray": RAY },
          body: "{}",
        }),
        env,
      );
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({
        error: "emulator_unavailable",
        route: "/_emulate/reset",
        retryable: true,
        ray: RAY,
      });
      // Reported once, by the object.
      expect(logs).toHaveBeenCalledTimes(1);
    } finally {
      logs.mockRestore();
    }
  });

  // Executor's cloud onboarding e2e provisions this service exactly this way:
  // mint an api-key, seed a brand, then resolve the company from a work email.
  // A missing registration only shows up here, as a 404 from the control plane.
  it("provisions the context company lookup and resolves a seeded brand", async () => {
    const { state } = makeState();
    const durableObject = new EmulatorDurableObject(state, {});
    const headers = {
      "content-type": "application/json",
      "x-emulator-service": "context",
      "x-emulator-base-url": "https://context.instance.emulators.dev",
    };

    const credentialRes = await durableObject.fetch(
      new Request("https://context.instance.emulators.dev/_emulate/credentials", {
        method: "POST",
        headers,
        body: JSON.stringify({ type: "api-key" }),
      }),
    );
    expect(credentialRes.status).toBe(200);
    const { credential } = (await credentialRes.json()) as { credential: { token: string } };
    expect(credential.token).toMatch(/^emu_context_/);

    const seedRes = await durableObject.fetch(
      new Request("https://context.instance.emulators.dev/_emulate/seed", {
        method: "POST",
        headers,
        body: JSON.stringify({ brands: [{ domain: "acme.example", title: "Example Company" }] }),
      }),
    );
    expect(seedRes.status).toBe(200);

    const hit = await durableObject.fetch(
      new Request("https://context.instance.emulators.dev/v1/brand/retrieve", {
        method: "POST",
        headers: { ...headers, authorization: `Bearer ${credential.token}` },
        body: JSON.stringify({ type: "by_email", email: "workspace@acme.example" }),
      }),
    );
    expect(hit.status).toBe(200);
    const body = (await hit.json()) as { brand: { title: string } };
    expect(body.brand.title).toBe("Example Company");

    const miss = await durableObject.fetch(
      new Request("https://context.instance.emulators.dev/v1/brand/retrieve", {
        method: "POST",
        headers: { ...headers, authorization: `Bearer ${credential.token}` },
        body: JSON.stringify({ type: "by_email", email: "workspace@example.test" }),
      }),
    );
    expect(miss.status).toBe(404);
  });

  // Executor's PlanetScale e2e registers a client through DCR on a path form
  // instance and exchanges a code. The client auth outcome must survive Durable
  // Object eviction, because the registration and the exchange are separate requests.
  it("serves PlanetScale DCR and literal Basic client auth across eviction", async () => {
    const { state } = makeState();
    const base = "https://emulators.dev/planetscale/ps-run";
    const headers = {
      "x-emulator-service": "planetscale",
      "x-emulator-instance": "ps-run",
      "x-emulator-base-url": base,
    };
    const first = new EmulatorDurableObject(state, {});
    const metadata = await first.fetch(
      new Request("https://emulators.dev/.well-known/oauth-authorization-server", { headers }),
    );
    expect(((await metadata.json()) as { issuer: string }).issuer).toBe(base);

    const registered = await first.fetch(
      new Request("https://emulators.dev/oauth/registration", {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ client_name: "Executor", redirect_uris: ["https://app.example/callback"] }),
      }),
    );
    expect(registered.status).toBe(201);
    const client = (await registered.json()) as { client_id: string; client_secret: string };

    const evicted = new EmulatorDurableObject(state, {});
    const exchange = (id: string, secret: string) =>
      evicted.fetch(
        new Request("https://emulators.dev/oauth/token", {
          method: "POST",
          headers: {
            ...headers,
            "content-type": "application/x-www-form-urlencoded",
            authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`,
          },
          body: "grant_type=authorization_code&code=bogus&redirect_uri=https%3A%2F%2Fapp.example%2Fcallback",
        }),
      );
    const raw = await exchange(client.client_id, client.client_secret);
    expect(raw.status).toBe(400);
    expect(((await raw.json()) as { error: string }).error).toBe("invalid_grant");
    const encoded = await exchange(client.client_id.replace(/_/g, "%5F"), client.client_secret);
    expect(encoded.status).toBe(401);
    expect(encoded.headers.get("www-authenticate")).toContain('realm="Doorkeeper", error="invalid_client"');
  });

  // Executor's Cloud onboarding signs in with Google twice against one instance.
  // A relying party caches the JWKS it fetched for the first sign-in and does
  // not refetch it for a short cooldown, so an instance rebuilt in a new isolate
  // must keep signing with the key it already published.
  it("keeps the Google ID token signing key across eviction into a new isolate", async () => {
    const { state } = makeState();
    const base = "https://emulators.dev/google/oidc-run";
    const redirect = "https://app.example/api/auth/callback/google";
    const headers = {
      "x-emulator-service": "google",
      "x-emulator-instance": "oidc-run",
      "x-emulator-base-url": base,
    };
    const request = (object: EmulatorDurableObject, path: string, init: RequestInit = {}) =>
      object.fetch(new Request(`https://emulators.dev${path}`, { ...init, headers: { ...headers, ...init.headers } }));
    const json = (object: EmulatorDurableObject, path: string, body: unknown) =>
      request(object, path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const form = (object: EmulatorDurableObject, path: string, body: Record<string, string>) =>
      request(object, path, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(body).toString(),
      });

    const first = new EmulatorDurableObject(state, {});
    const issued = await json(first, "/_emulate/credentials", {
      type: "oauth-authorization-code",
      redirect_uris: [redirect],
    });
    const { credential } = (await issued.json()) as { credential: { client_id: string; client_secret: string } };
    expect((await json(first, "/_emulate/seed", { users: [{ email: "person@example.test" }] })).status).toBe(200);

    const signIn = async (object: EmulatorDurableObject, nonce: string) => {
      const authorized = await form(object, "/o/oauth2/v2/auth/callback", {
        email: "person@example.test",
        redirect_uri: redirect,
        scope: "openid email profile",
        client_id: credential.client_id,
        nonce,
      });
      const code = new URL(authorized.headers.get("location") ?? "").searchParams.get("code") ?? "";
      const token = await form(object, "/oauth2/token", {
        code,
        grant_type: "authorization_code",
        redirect_uri: redirect,
        client_id: credential.client_id,
        client_secret: credential.client_secret,
      });
      expect(token.status).toBe(200);
      return ((await token.json()) as { id_token: string }).id_token;
    };
    type Jwk = { kid: string; kty: string; n: string; e: string };
    const certs = async (object: EmulatorDurableObject) =>
      ((await (await request(object, "/oauth2/v3/certs")).json()) as { keys: Jwk[] }).keys;
    const verifies = async (idToken: string, keys: Jwk[]) => {
      const [header, payload, signature] = idToken.split(".");
      const { kid } = JSON.parse(Buffer.from(header, "base64url").toString()) as { kid: string };
      const jwk = keys.find((key) => key.kid === kid);
      if (!jwk) return false;
      const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, [
        "verify",
      ]);
      return crypto.subtle.verify(
        "RSASSA-PKCS1-v1_5",
        key,
        Buffer.from(signature, "base64url"),
        new TextEncoder().encode(`${header}.${payload}`),
      );
    };

    const firstToken = await signIn(first, "first-nonce");
    const published = await certs(first);
    expect(await verifies(firstToken, published)).toBe(true);

    // Eviction discards the isolate, including module state, before the rebuild.
    vi.resetModules();
    const { EmulatorDurableObject: Rebuilt } = await import("../durable-object.js");
    const rebuilt = new Rebuilt(state, {});
    const secondToken = await signIn(rebuilt, "second-nonce");
    expect(await verifies(secondToken, published)).toBe(true);
    expect(await verifies(firstToken, await certs(rebuilt))).toBe(true);
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

  it("writes only what an admission changed, never rescans storage, and keeps storage bounded", async () => {
    const { state, storage, puts } = makeState();
    let lists = 0;
    const list = state.storage.list.bind(state.storage);
    state.storage.list = (options) => {
      lists++;
      return list(options);
    };
    const headers = {
      "x-emulator-service": "autumn",
      "x-emulator-instance": "admission",
      "x-emulator-base-url": "https://autumn.admission.emulators.dev",
      authorization: "Bearer am_sk_test",
      "content-type": "application/json",
    };
    const call = (path: string, body: unknown) =>
      do1.fetch(
        new Request(`https://autumn.admission.emulators.dev${path}`, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        }),
      );
    const do1 = new EmulatorDurableObject(state, {});
    const seeded = await do1.fetch(
      new Request("https://autumn.admission.emulators.dev/__seed", {
        method: "POST",
        headers,
        body: JSON.stringify({
          strict: false,
          autumn: {
            plans: [{ id: "team", name: "Team", items: [{ feature_id: "executions", included: 500 }] }],
            customers: [{ id: "org_synthetic", subscriptions: [{ plan_id: "team", status: "active" }] }],
          },
        }),
      }),
    );
    expect(seeded.status).toBe(200);
    const getOrCreate = () => call("/v1/customers.get_or_create", { customer_id: "org_synthetic" });
    const consume = () =>
      call("/v1/balances.check", {
        customer_id: "org_synthetic",
        feature_id: "executions",
        required_balance: 1,
        send_event: true,
      });
    expect((await getOrCreate()).status).toBe(200);

    // A lookup that changes no billing state adds only its ledger entry and the ledger index.
    puts.length = 0;
    lists = 0;
    expect((await getOrCreate()).status).toBe(200);
    expect(puts.map((put) => put.key.replace(/req_\d+$/, "req_N")).sort()).toEqual([
      "ledger:entry:req_N",
      "ledger:meta",
    ]);
    expect(lists).toBe(0);

    // Consumption writes the changed records only, and stored events stay bounded.
    for (let i = 0; i < 300; i++) expect((await consume()).status).toBe(200);
    expect(lists).toBe(0);
    puts.length = 0;
    const last = (await (await consume()).json()) as { balance: { usage: number; remaining: number } };
    expect(last.balance).toMatchObject({ usage: 301, remaining: 199 });
    expect(puts.length).toBeLessThan(10);
    const events = [...storage.keys()].filter((key) => key.startsWith("snapshot:item:autumn.events:"));
    expect(events.length).toBeLessThanOrEqual(65);

    // A fresh Durable Object over the same storage restores the same balance.
    const do2 = new EmulatorDurableObject(state, {});
    const restored = await do2.fetch(
      new Request("https://autumn.admission.emulators.dev/v1/customers.get_or_create", {
        method: "POST",
        headers,
        body: JSON.stringify({ customer_id: "org_synthetic" }),
      }),
    );
    const customer = (await restored.json()) as { balances: { executions: { usage: number } } };
    expect(customer.balances.executions.usage).toBe(301);
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
