import { describe, expect, it } from "vitest";
import { EmulatorDurableObject } from "../durable-object.js";

/** In-memory Durable Object state that enforces the 128 KiB value limit. */
function makeState() {
  const storage = new Map<string, unknown>();
  const clone = <T>(value: T): T => (value === undefined ? value : JSON.parse(JSON.stringify(value)));
  return {
    storage,
    state: {
      storage: {
        async get<T>(key: string): Promise<T | undefined> {
          return clone(storage.get(key) as T | undefined);
        },
        async put(key: string, value: unknown): Promise<void> {
          const size = new TextEncoder().encode(JSON.stringify(value)).length;
          if (size > 128 * 1024) throw new Error(`Values cannot be larger than 131072 bytes (got ${size}).`);
          storage.set(key, clone(value));
        },
        async delete(key: string | string[]): Promise<boolean | number> {
          if (Array.isArray(key)) return key.filter((k) => storage.delete(k)).length;
          return storage.delete(key);
        },
        async list<T>(options?: { prefix?: string }): Promise<Map<string, T>> {
          const out = new Map<string, T>();
          for (const [key, value] of storage)
            if (!options?.prefix || key.startsWith(options.prefix)) out.set(key, clone(value) as T);
          return out;
        },
      },
      async blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T> {
        return fn();
      },
    },
  };
}

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const base = "https://emulators.dev/openai/run";

function hosted() {
  const env = makeState();
  const headers = { "x-emulator-service": "openai", "x-emulator-instance": "run", "x-emulator-base-url": base };
  let object = new EmulatorDurableObject(env.state, {});
  const request = (path: string, init: RequestInit = {}) =>
    object.fetch(
      new Request(`https://emulators.dev${path}`, { ...init, headers: { ...headers, ...(init.headers as object) } }),
    );
  const json = (path: string, body: unknown, extra: Record<string, string> = {}) =>
    request(path, {
      method: "POST",
      headers: { "content-type": "application/json", ...extra },
      body: JSON.stringify(body),
    });
  return {
    ...env,
    request,
    json,
    evict() {
      object = new EmulatorDurableObject(env.state, {});
    },
  };
}

describe("OpenAI on the Cloudflare host", () => {
  it("keeps issued keys, answers and per-key limits across eviction", async () => {
    const h = hosted();
    expect(
      (await h.json("/__seed", { openai: { answer_rules: [{ match: { contains: "ping" }, answer: "pong" }] } })).status,
    ).toBe(200);
    const issue = async (name: string) =>
      ((await (await h.json("/_emulate/credentials", { type: "api-key", name })).json()) as Json).credential
        .token as string;
    const a = await issue("alpha");
    const b = await issue("beta");
    expect(a).toMatch(/^sk-proj-/);
    expect((await h.json("/_emulate/openai/keys/alpha/rate-limit", { requests: 1, window_seconds: 300 })).status).toBe(
      200,
    );

    h.evict();
    const ask = (key: string) =>
      h.json("/v1/responses", { model: "gpt-5-mini", input: "ping" }, { authorization: `Bearer ${key}` });
    const first = await ask(a);
    expect(first.status).toBe(200);
    expect(((await first.json()) as Json).output[0].content[0].text).toBe("pong");
    h.evict();
    const limited = await ask(a);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(((await limited.json()) as Json).error.code).toBe("rate_limit_exceeded");
    expect((await ask(b)).status).toBe(200);
    expect((await ask("sk-proj-never-issued")).status).toBe(401);

    h.evict();
    const ledger = (await (await h.request("/_emulate/ledger")).json()) as Json;
    const calls = (ledger.entries as Json[])
      .filter((e) => e.operationId === "responses.create")
      .reverse()
      .map((e) => [e.identity.user?.login ?? null, e.response.status]);
    expect(calls).toEqual([
      ["alpha", 200],
      ["alpha", 429],
      ["beta", 200],
      [null, 401],
    ]);
  });

  it("answers an 8 MB request and stores its ledger entry by size only", async () => {
    const h = hosted();
    await h.json("/__seed", { openai: { api_keys: [{ name: "big", key: "sk-proj-big" }] } });
    const input = "a".repeat(8 * 1024 * 1024);
    const res = await h.json("/v1/responses", { model: "gpt-5-mini", input }, { authorization: "Bearer sk-proj-big" });
    expect(res.status).toBe(200);
    h.evict();
    const ledger = (await (await h.request("/_emulate/ledger")).json()) as Json;
    const entry = (ledger.entries as Json[]).find((e) => e.operationId === "responses.create")!;
    expect(entry.request.bodyBytes).toBeGreaterThan(8 * 1024 * 1024);
    expect(JSON.stringify(entry).length).toBeLessThan(128 * 1024);
  });

  it("streams a paced answer whole and in order from the hosted object", async () => {
    const h = hosted();
    await h.json("/__seed", {
      openai: {
        api_keys: [{ name: "s", key: "sk-proj-stream" }],
        answer_rules: [{ answer: { text: "0123456789", stream: { chunks: 10, interval_ms: 30 } } }],
      },
    });
    const started = Date.now();
    const res = await h.json(
      "/v1/responses",
      { model: "gpt-5-mini", input: "go", stream: true },
      { authorization: "Bearer sk-proj-stream" },
    );
    const text = await res.text();
    const deltas = text
      .split("\n\n")
      .filter((f) => f.includes("response.output_text.delta"))
      .map((f) => (JSON.parse(f.split("\ndata: ")[1]!) as Json).delta);
    expect(deltas.join("")).toBe("0123456789");
    expect(Date.now() - started).toBeGreaterThanOrEqual(9 * 30 - 10);
    expect(text.trimEnd().split("\n\n").at(-1)).toContain("response.completed");
  });
});
