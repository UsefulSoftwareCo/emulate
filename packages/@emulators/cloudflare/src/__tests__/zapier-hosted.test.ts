import { describe, expect, it } from "vitest";
import { EmulatorDurableObject } from "../durable-object.js";
import worker, { type Env } from "../worker.js";

function memoryState() {
  const storage = new Map<string, unknown>();
  return {
    storage: {
      async get<T>(key: string): Promise<T | undefined> {
        return storage.get(key) === undefined ? undefined : (JSON.parse(JSON.stringify(storage.get(key))) as T);
      },
      async put(key: string, value: unknown): Promise<void> {
        const size = new TextEncoder().encode(JSON.stringify(value)).length;
        if (size > 128 * 1024) throw new Error(`Values cannot be larger than 131072 bytes (got ${size}).`);
        storage.set(key, JSON.parse(JSON.stringify(value)));
      },
      async delete(key: string | string[]): Promise<boolean | number> {
        if (Array.isArray(key)) return key.filter((k) => storage.delete(k)).length;
        return storage.delete(key);
      },
      async list<T>(options?: { prefix?: string }): Promise<Map<string, T>> {
        const out = new Map<string, T>();
        for (const [key, value] of storage)
          if (!options?.prefix || key.startsWith(options.prefix)) out.set(key, value as T);
        return out;
      },
    },
    async blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T> {
      return fn();
    },
  };
}

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** The real worker in front of Durable Objects, with eviction (a new object over the same storage). */
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
  const base = "https://emulators.dev/zapier/run";
  const call = (url: string, init: RequestInit = {}) => worker.fetch(new Request(url, init), env);
  const json = (path: string, body: unknown) =>
    call(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const mcp = (token: string, method: string, params: Json = {}) =>
    call(`${base}/api/v1/connect`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2026-07-28",
        "mcp-method": method,
        ...(method === "tools/call" ? { "mcp-name": String(params.name) } : {}),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 7,
        method,
        params: {
          ...params,
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      }),
    });
  return {
    base,
    call,
    json,
    mcp,
    evict() {
      objects.clear();
    },
  };
}

describe("Zapier MCP on the Cloudflare host", () => {
  it("serves the OAuth discovery chain in the path form", async () => {
    const h = hosted();
    const res = await h.call(`${h.base}/api/v1/connect`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(401);
    const prm = /resource_metadata="([^"]+)"/.exec(res.headers.get("www-authenticate") ?? "")![1]!;
    expect(prm).toBe("https://emulators.dev/.well-known/oauth-protected-resource/zapier/run/api/v1/connect");
    const meta = (await (await h.call(prm)).json()) as Json;
    expect(meta).toMatchObject({ resource: `${h.base}/api/v1/connect`, authorization_servers: [h.base] });
    const as = (await (await h.call(`${h.base}/.well-known/oauth-authorization-server`)).json()) as Json;
    expect(as.registration_endpoint).toBe(`${h.base}/api/v1/oauth/register`);
  });

  it("pages 3,000 tools across eviction, the same every time, and reports their size", async () => {
    const h = hosted();
    expect(
      (await h.json("/__seed", { zapier: { accounts: [{ email: "ada@example.com", tools: { count: 3000 } }] } }))
        .status,
    ).toBe(200);
    const cred = (
      (await (await h.json("/_emulate/credentials", { type: "bearer-token", login: "ada@example.com" })).json()) as Json
    ).credential;
    const names: string[] = [];
    let cursor: string | undefined;
    let bytes = 0;
    let pages = 0;
    do {
      h.evict(); // every page from a freshly rebuilt object
      const res = await h.mcp(cred.token, "tools/list", cursor ? { cursor } : {});
      const text = await res.text();
      bytes += text.length;
      const body = JSON.parse(text) as Json;
      names.push(...body.result.tools.map((t: Json) => t.name));
      cursor = body.result.nextCursor;
      pages++;
    } while (cursor);
    expect(names).toHaveLength(3000);
    expect(new Set(names).size).toBe(3000);
    expect(pages).toBe(30);
    expect(bytes).toBeLessThan(30 * 150 * 1024);

    await h.json("/_emulate/zapier/settings", { page_size: 0 });
    h.evict();
    const started = Date.now();
    const whole = await h.mcp(cred.token, "tools/list");
    const text = await whole.text();
    const all = JSON.parse(text) as Json;
    expect(all.result.tools.map((t: Json) => t.name)).toEqual(names);
    expect(all.result.nextCursor).toBeUndefined();
    // About 1.8 MB for 3,000 tools, built in well under a second.
    (await import("fs")).writeFileSync(
      "/tmp/zapier-sizes.txt",
      `whole list ${text.length} bytes in ${Date.now() - started} ms; 30 pages ${bytes} bytes`,
    );
  }, 30000);

  it("holds a 2026-07-28 listen stream open on the object and delivers a change to it", async () => {
    const h = hosted();
    await h.json("/__seed", {
      zapier: { accounts: [{ email: "bob@example.com", tools: { count: 10 } }], settings: { list_changed: true } },
    });
    const cred = (
      (await (await h.json("/_emulate/credentials", { type: "bearer-token", login: "bob@example.com" })).json()) as Json
    ).credential;
    const listen = await h.mcp(cred.token, "subscriptions/listen", { notifications: { toolsListChanged: true } });
    expect(listen.headers.get("content-type")).toContain("text/event-stream");
    const reader = listen.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const next = async (pattern: RegExp) => {
      while (!pattern.test(buffer)) {
        const { value, done } = await reader.read();
        if (done) throw new Error("stream ended");
        buffer += decoder.decode(value);
      }
    };
    await next(/subscriptions\/acknowledged/);
    const change = (await (
      await h.json("/_emulate/zapier/accounts/bob%40example.com/tools", { add: 1 })
    ).json()) as Json;
    expect(change.notified_streams).toBe(1);
    await next(/notifications\/tools\/list_changed/);
    expect(buffer).toContain('"io.modelcontextprotocol/subscriptionId":7');
    await reader.cancel();
    const list = (await (await h.mcp(cred.token, "tools/list")).json()) as Json;
    expect(list.result.tools).toHaveLength(11);
  });
});
