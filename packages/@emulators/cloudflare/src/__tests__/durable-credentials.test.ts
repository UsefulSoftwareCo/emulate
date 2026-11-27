import { createServer as createHttpServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EmulatorDurableObject } from "../durable-object.js";
import worker, { type Env } from "../worker.js";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** In-memory Durable Object storage with the 128 KiB value limit. */
function memoryState() {
  const storage = new Map<string, unknown>();
  const copy = <T>(v: unknown): T => JSON.parse(JSON.stringify(v)) as T;
  return {
    storage: {
      async get<T>(key: string): Promise<T | undefined> {
        return storage.has(key) ? copy<T>(storage.get(key)) : undefined;
      },
      async put(key: string, value: unknown): Promise<void> {
        const size = new TextEncoder().encode(JSON.stringify(value)).length;
        if (size > 128 * 1024) throw new Error(`Values cannot be larger than 131072 bytes (got ${size}).`);
        storage.set(key, copy(value));
      },
      async delete(key: string | string[]): Promise<boolean | number> {
        if (Array.isArray(key)) return key.filter((k) => storage.delete(k)).length;
        return storage.delete(key);
      },
      async list<T>(options?: { prefix?: string }): Promise<Map<string, T>> {
        const out = new Map<string, T>();
        for (const [key, value] of storage)
          if (!options?.prefix || key.startsWith(options.prefix)) out.set(key, copy<T>(value));
        return out;
      },
    },
    async blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T> {
      return fn();
    },
    raw: storage,
  };
}

/** The real worker in front of Durable Objects; `evict()` replaces every object, keeping storage. */
function hosted() {
  const states = new Map<string, ReturnType<typeof memoryState>>();
  const objects = new Map<string, EmulatorDurableObject>();
  const env = {
    EMULATE_HOST_SUFFIX: "emulators.dev",
    EMULATOR: {
      idFromName: (name: string) => name,
      get(id: unknown) {
        const key = String(id);
        if (!states.has(key)) states.set(key, memoryState());
        if (!objects.has(key)) objects.set(key, new EmulatorDurableObject(states.get(key) as never, {}));
        return objects.get(key)!;
      },
    },
  } as Env;
  const call = (url: string, init: RequestInit = {}) =>
    worker.fetch(new Request(url, { redirect: "manual", ...init }), env);
  const json = (url: string, body: unknown, headers: Record<string, string> = {}) =>
    call(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  const form = (url: string, fields: Record<string, string>, headers: Record<string, string> = {}) =>
    call(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
      body: new URLSearchParams(fields).toString(),
    });
  return {
    call,
    json,
    form,
    states,
    evict() {
      objects.clear();
    },
  };
}

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});
async function receiver() {
  const received: Array<{ headers: Record<string, unknown>; body: string }> = [];
  const server = createHttpServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      received.push({ headers: req.headers, body });
      res.writeHead(200);
      res.end();
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}/hook`, received };
}

const R = "http://localhost:3999/cb";

async function githubToken(h: ReturnType<typeof hosted>, base: string): Promise<string> {
  const cb = await h.form(`${base}/login/oauth/callback`, {
    login: "ada",
    redirect_uri: R,
    client_id: "cid",
    state: "s",
    scope: "repo admin:repo_hook",
  });
  const code = new URL(cb.headers.get("location")!).searchParams.get("code")!;
  const res = await h.json(
    `${base}/login/oauth/access_token`,
    { client_id: "cid", client_secret: "csec", code, redirect_uri: R },
    { accept: "application/json" },
  );
  return ((await res.json()) as Json).access_token as string;
}

const githubSeed = {
  github: {
    users: [{ login: "ada" }],
    repos: [{ owner: "ada", name: "widget" }],
    oauth_apps: [{ client_id: "cid", client_secret: "csec", name: "App", redirect_uris: [R] }],
  },
};

describe("what a hosted instance issues outlives the object", () => {
  it("keeps a token a service wrote into the token map, and its webhooks, across eviction", async () => {
    const h = hosted();
    const base = "https://emulators.dev/github/keep";
    expect((await h.json(`${base}/__seed`, githubSeed)).status).toBe(200);
    const token = await githubToken(h, base);
    const auth = { authorization: `Bearer ${token}` };
    const hook = await receiver();
    expect(
      (
        await h.json(
          `${base}/repos/ada/widget/hooks`,
          { name: "web", active: true, events: ["issues"], config: { url: hook.url, content_type: "json" } },
          auth,
        )
      ).status,
    ).toBe(201);
    expect((await h.json(`${base}/repos/ada/widget/issues`, { title: "before" }, auth)).status).toBe(201);
    // GitHub sends deliveries without holding up the response.
    await vi.waitFor(() => expect(hook.received).toHaveLength(1));

    h.evict();
    expect((await h.call(`${base}/user`, { headers: auth })).status).toBe(200);
    h.evict();
    expect((await h.json(`${base}/repos/ada/widget/issues`, { title: "after an unload" }, auth)).status).toBe(201);
    await vi.waitFor(() => expect(hook.received).toHaveLength(2));
    expect(hook.received.map((r) => r.headers["x-github-event"])).toEqual(["issues", "issues"]);
    expect(JSON.parse(hook.received[1]!.body).issue.title).toBe("after an unload");
  });

  it("keeps a revocation across eviction, for an issued token and a seeded one", async () => {
    const h = hosted();
    const base = "https://emulators.dev/google/revoke";
    await h.json(`${base}/__seed`, {
      tokens: { "seeded-token": { login: "ada@example.com" } },
      google: {
        users: [{ email: "ada@example.com" }],
        oauth_clients: [{ client_id: "c1", client_secret: "s1", redirect_uris: [R] }],
      },
    });
    const cb = await h.form(`${base}/o/oauth2/v2/auth/callback`, {
      email: "ada@example.com",
      redirect_uri: R,
      client_id: "c1",
      scope: "openid email",
    });
    const code = new URL(cb.headers.get("location")!).searchParams.get("code")!;
    const issued = (
      (await (
        await h.form(`${base}/oauth2/token`, {
          code,
          grant_type: "authorization_code",
          redirect_uri: R,
          client_id: "c1",
          client_secret: "s1",
        })
      ).json()) as Json
    ).access_token as string;
    const userinfo = (token: string) =>
      h.call(`${base}/oauth2/v2/userinfo`, { headers: { authorization: `Bearer ${token}` } }).then((r) => r.status);

    expect([await userinfo(issued), await userinfo("seeded-token")]).toEqual([200, 200]);
    await h.form(`${base}/oauth2/revoke`, { token: issued });
    await h.form(`${base}/oauth2/revoke`, { token: "seeded-token" });
    h.evict();
    expect([await userinfo(issued), await userinfo("seeded-token")]).toEqual([401, 401]);
  });

  it("keeps read-only ledger entries across eviction", async () => {
    const h = hosted();
    const base = "https://emulators.dev/github/reads";
    await h.json(`${base}/__seed`, githubSeed);
    const token = await githubToken(h, base);
    for (let i = 0; i < 3; i++) await h.call(`${base}/user`, { headers: { authorization: `Bearer ${token}` } });
    h.evict();
    const ledger = (await (await h.call(`${base}/_emulate/ledger`)).json()) as Json;
    const reads = (ledger.entries as Json[]).filter((e) => e.method === "GET" && e.path === "/user");
    expect(reads.map((e) => e.response.status)).toEqual([200, 200, 200]);
  });

  it("loses nothing when one instance is reached over http and https in turn", async () => {
    const h = hosted();
    const https = "https://emulators.dev/github/schemes";
    const http = "http://emulators.dev/github/schemes";
    await h.json(`${https}/__seed`, githubSeed);
    const token = await githubToken(h, https);
    const status: number[] = [];
    for (const base of [http, https, http, https]) {
      status.push((await h.call(`${base}/user`, { headers: { authorization: `Bearer ${token}` } })).status);
    }
    expect(status).toEqual([200, 200, 200, 200]);
    const ledger = (await (await h.call(`${https}/_emulate/ledger`)).json()) as Json;
    expect((ledger.entries as Json[]).filter((e) => e.method === "GET" && e.path === "/user")).toHaveLength(4);
  });

  it("still accepts the tokens of an instance saved before the whole token map was kept", async () => {
    const h = hosted();
    const base = "https://emulators.dev/github/legacy";
    await h.json(`${base}/__seed`, { ...githubSeed, tokens: { "seeded-token": { login: "ada" } } });
    const minted = (
      (await (await h.json(`${base}/_emulate/credentials`, { type: "bearer-token", login: "ada" })).json()) as Json
    ).credential.token as string;
    // As the previous version left storage: control-plane tokens only, no marker.
    const raw = h.states.get("github:legacy")!.raw;
    for (const key of [...raw.keys()]) {
      if (key === "minted-complete") raw.delete(key);
      else if (key.startsWith("minted:") && (raw.get(key) as Json).token !== minted) raw.delete(key);
    }
    h.evict();
    const user = (token: string) =>
      h.call(`${base}/user`, { headers: { authorization: `Bearer ${token}` } }).then((r) => r.status);
    expect([await user(minted), await user("seeded-token")]).toEqual([200, 200]);
    expect(raw.get("minted-complete")).toBe(true);
  });
});
