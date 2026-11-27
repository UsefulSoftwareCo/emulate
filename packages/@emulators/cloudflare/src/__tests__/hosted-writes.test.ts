import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ChunkedStorage, STORAGE_VALUE_LIMIT } from "../chunked-storage.js";
import { EmulatorDurableObject } from "../durable-object.js";
import worker, { type Env } from "../worker.js";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** In-memory storage that enforces the 128 KiB value limit and counts what is written. */
function countingStorage() {
  const map = new Map<string, unknown>();
  const counts = { puts: 0, deletes: 0, bytes: 0 };
  let failPuts: ((key: string) => boolean) | undefined;
  const copy = <T>(v: unknown): T => JSON.parse(JSON.stringify(v)) as T;
  const storage = {
    async get<T>(key: string): Promise<T | undefined> {
      return map.has(key) ? copy<T>(map.get(key)) : undefined;
    },
    async put(key: string, value: unknown): Promise<void> {
      if (failPuts?.(key)) throw new Error(`storage unavailable writing ${key}`);
      const size = new TextEncoder().encode(JSON.stringify(value)).length;
      if (size > STORAGE_VALUE_LIMIT) throw new Error(`Values cannot be larger than 131072 bytes (got ${size}).`);
      counts.puts++;
      counts.bytes += size;
      map.set(key, copy(value));
    },
    async delete(key: string | string[]): Promise<boolean | number> {
      const keys = Array.isArray(key) ? key : [key];
      counts.deletes += keys.length;
      const n = keys.filter((k) => map.delete(k)).length;
      return Array.isArray(key) ? n : n > 0;
    },
    async list<T>(options?: { prefix?: string }): Promise<Map<string, T>> {
      const out = new Map<string, T>();
      for (const [k, v] of [...map].sort(([a], [b]) => a.localeCompare(b)))
        if (!options?.prefix || k.startsWith(options.prefix)) out.set(k, copy<T>(v));
      return out;
    },
  };
  return {
    storage,
    map,
    counts,
    failWhen(predicate: ((key: string) => boolean) | undefined) {
      failPuts = predicate;
    },
    reset() {
      counts.puts = 0;
      counts.deletes = 0;
      counts.bytes = 0;
    },
  };
}

function hosted() {
  const store = countingStorage();
  let object = new EmulatorDurableObject(
    { storage: store.storage, blockConcurrencyWhile: <T>(fn: () => Promise<T>) => fn() } as never,
    {},
  );
  const env = {
    EMULATE_HOST_SUFFIX: "emulators.dev",
    EMULATOR: { idFromName: (n: string) => n, get: () => object },
  } as Env;
  const call = (url: string, init: RequestInit = {}) =>
    worker.fetch(new Request(url, { redirect: "manual", ...init }), env);
  const json = (url: string, body: unknown, headers: Record<string, string> = {}) =>
    call(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  return {
    store,
    call,
    json,
    evict() {
      object = new EmulatorDurableObject(
        { storage: store.storage, blockConcurrencyWhile: <T>(fn: () => Promise<T>) => fn() } as never,
        {},
      );
    },
  };
}

const base = "https://emulators.dev/github/run";
const seed = { github: { users: [{ login: "ada" }], repos: [{ owner: "ada", name: "widget" }] } };
async function credential(h: ReturnType<typeof hosted>) {
  const res = await h.json(`${base}/_emulate/credentials`, { type: "bearer-token", login: "ada" });
  return { authorization: `Bearer ${((await res.json()) as Json).credential.token}` };
}
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

describe("what a hosted request writes", () => {
  it("writes only the new ledger entry and what changed, at a full ledger of 1,000 entries", async () => {
    const h = hosted();
    await h.json(`${base}/__seed`, seed);
    const auth = await credential(h);
    for (let i = 0; i < 1000; i++) await h.call(`${base}/user`, { headers: auth });
    const ledger = (await (await h.call(`${base}/_emulate/ledger`)).json()) as Json;
    expect(ledger.entries).toHaveLength(1000);

    const readBytes: number[] = [];
    const readOps: number[] = [];
    const readMs: number[] = [];
    for (let i = 0; i < 50; i++) {
      h.store.reset();
      const t0 = performance.now();
      expect((await h.call(`${base}/user`, { headers: auth })).status).toBe(200);
      readMs.push(performance.now() - t0);
      readBytes.push(h.store.counts.bytes);
      readOps.push(h.store.counts.puts + h.store.counts.deletes);
    }
    const writeBytes: number[] = [];
    const writeMs: number[] = [];
    for (let i = 0; i < 20; i++) {
      h.store.reset();
      const t0 = performance.now();
      expect((await h.json(`${base}/repos/ada/widget/issues`, { title: `issue ${i}` }, auth)).status).toBe(201);
      writeMs.push(performance.now() - t0);
      writeBytes.push(h.store.counts.bytes);
    }
    // A read at a full ledger: its own entry, the ledger counter, and the delete of the
    // entry that falls off. Nothing grows with the ledger's length.
    expect(median(readOps)).toBe(3);
    expect(Math.max(...readBytes)).toBeLessThan(4 * 1024);
    writeFileSync(
      "/tmp/hosted-write-cost.json",
      JSON.stringify({
        read: {
          medianBytes: median(readBytes),
          maxBytes: Math.max(...readBytes),
          medianOps: median(readOps),
          medianMs: median(readMs),
        },
        write: { medianBytes: median(writeBytes), maxBytes: Math.max(...writeBytes), medianMs: median(writeMs) },
      }),
    );
  }, 60000);

  it("stores an 8 MB request body without a failed write, and reads it back after eviction", async () => {
    const h = hosted();
    await h.json(`${base}/__seed`, seed);
    const auth = await credential(h);
    const body = "x".repeat(8 * 1024 * 1024);
    const created = await h.json(`${base}/repos/ada/widget/issues`, { title: "big", body }, auth);
    expect(created.status).toBe(201);
    const { number } = (await created.json()) as Json;
    expect(((await (await h.call(`${base}/_emulate/persistence`)).json()) as Json).failures).toEqual([]);
    h.evict();
    const issue = (await (await h.call(`${base}/repos/ada/widget/issues/${number}`, { headers: auth })).json()) as Json;
    expect(issue.body.length).toBe(body.length);
    const ledger = (await (await h.call(`${base}/_emulate/ledger`)).json()) as Json;
    expect(
      (ledger.entries as Json[]).find((e) => e.method === "POST" && e.path.endsWith("/issues"))!.request.bodyTruncated,
    ).toBe(true);
  }, 60000);

  it("answers even when storage refuses the write, and shows the failure on the control plane", async () => {
    const h = hosted();
    await h.json(`${base}/__seed`, seed);
    const auth = await credential(h);
    h.store.failWhen(() => true);
    const created = await h.json(`${base}/repos/ada/widget/issues`, { title: "while storage is down" }, auth);
    expect(created.status).toBe(201);
    expect(((await created.json()) as Json).title).toBe("while storage is down");
    expect((await h.call(`${base}/user`, { headers: auth })).status).toBe(200);
    h.store.failWhen(undefined);
    const shown = (await (await h.call(`${base}/_emulate/persistence`)).json()) as Json;
    expect(shown.failures.map((f: Json) => f.during)).toEqual(["GET /user", "POST /repos/ada/widget/issues"]);
    expect(shown.failures[0].error).toContain("storage unavailable");
    // The next save brings storage up to date, so nothing written meanwhile is lost.
    await h.call(`${base}/user`, { headers: auth });
    h.evict();
    const issues = (await (await h.call(`${base}/repos/ada/widget/issues`, { headers: auth })).json()) as Json[];
    expect(issues.map((i) => i.title)).toContain("while storage is down");
  });
});

describe("ChunkedStorage", () => {
  it("splits a value over the limit, reads it back whole, and leaves no parts behind", async () => {
    const inner = countingStorage();
    const storage = new ChunkedStorage(inner.storage);
    const big = { text: "é".repeat(300_000), quote: '"'.repeat(100_000) };
    await storage.put("snapshot:item:a:1", big);
    await storage.put("snapshot:item:a:2", { small: true });
    expect([...inner.map.keys()].filter((k) => k.includes("|chunk:")).length).toBeGreaterThan(1);
    expect(await storage.get("snapshot:item:a:1")).toEqual(big);
    const listed = await new ChunkedStorage(inner.storage).list({ prefix: "snapshot:item:" });
    expect([...listed.keys()]).toEqual(["snapshot:item:a:1", "snapshot:item:a:2"]);
    expect(listed.get("snapshot:item:a:1")).toEqual(big);

    await storage.put("snapshot:item:a:1", { now: "small" });
    expect([...inner.map.keys()].some((k) => k.includes("|chunk:"))).toBe(false);
    await storage.put("snapshot:item:a:1", big);
    await storage.delete(["snapshot:item:a:1"]);
    expect([...inner.map.keys()]).toEqual(["snapshot:item:a:2"]);
  });
});
