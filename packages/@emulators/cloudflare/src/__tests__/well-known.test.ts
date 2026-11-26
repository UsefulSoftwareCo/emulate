import { describe, expect, it } from "vitest";
import { EmulatorDurableObject } from "../durable-object.js";
import worker, { type Env } from "../worker.js";
import { SERVICES } from "../services.js";

function memoryState() {
  const storage = new Map<string, unknown>();
  return {
    storage: {
      async get<T>(key: string): Promise<T | undefined> {
        return storage.get(key) as T | undefined;
      },
      async put(key: string, value: unknown): Promise<void> {
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

/** The real worker in front of real Durable Objects, one per instance name. */
function hostEnv(): Env {
  const objects = new Map<string, EmulatorDurableObject>();
  return {
    EMULATE_HOST_SUFFIX: "emulators.dev",
    EMULATOR: {
      idFromName: (name: string) => name,
      get(id: unknown) {
        const key = String(id);
        if (!objects.has(key)) objects.set(key, new EmulatorDurableObject(memoryState() as never, {}));
        return objects.get(key)!;
      },
    },
  } as Env;
}

const DOCS = ["oauth-protected-resource", "oauth-authorization-server", "openid-configuration"];
const navigate = { "sec-fetch-mode": "navigate", accept: "text/html" };

describe("well-known discovery documents", () => {
  it("answers 404 JSON, not the catalog page, on the bare host", async () => {
    const env = hostEnv();
    for (const doc of DOCS) {
      for (const url of [
        `https://emulators.dev/.well-known/${doc}`,
        `https://emulators.dev/.well-known/${doc}/github`,
        `https://emulators.dev/.well-known/${doc}/`,
      ]) {
        for (const headers of [{}, navigate, { accept: "application/json" }] as Array<Record<string, string>>) {
          const res = await worker.fetch(new Request(url, { headers }), env);
          expect(res.status, `${url} ${JSON.stringify(headers)}`).toBe(404);
          expect(res.headers.get("content-type")).toContain("application/json");
          expect(((await res.json()) as { error: string }).error).toBe("not_found");
        }
      }
    }
    const bare = await worker.fetch(new Request("https://emulators.dev/.well-known"), env);
    expect(bare.status).toBe(404);
  });

  it("answers 404 JSON on service hosts, known or unknown, even to browser navigation", async () => {
    const env = hostEnv();
    for (const host of [...Object.keys(SERVICES), "nosuch"]) {
      for (const doc of DOCS) {
        for (const headers of [{}, navigate] as Array<Record<string, string>>) {
          const res = await worker.fetch(
            new Request(`https://${host}.emulators.dev/.well-known/${doc}`, { headers }),
            env,
          );
          expect(res.status, `${host} ${doc} ${JSON.stringify(headers)}`).toBe(404);
          expect(res.headers.get("content-type")).toContain("application/json");
        }
      }
    }
  });

  it("never answers a discovery probe with an HTML 200 on any host form", async () => {
    const env = hostEnv();
    for (const service of Object.keys(SERVICES)) {
      for (const doc of DOCS) {
        for (const url of [
          `https://${service}.probe.emulators.dev/.well-known/${doc}`,
          `https://emulators.dev/.well-known/${doc}/${service}/probe`,
          `https://emulators.dev/${service}/probe/.well-known/${doc}`,
        ]) {
          const res = await worker.fetch(new Request(url), env);
          const isHtml = (res.headers.get("content-type") ?? "").includes("text/html");
          expect(res.status === 200 && isHtml, url).toBe(false);
        }
      }
    }
  });

  it("still serves an instance's own discovery documents and the bare host's catalog", async () => {
    const env = hostEnv();
    const prm = await worker.fetch(
      new Request("https://emulators.dev/.well-known/oauth-protected-resource/github/probe"),
      env,
    );
    expect(prm.status).toBe(200);
    expect(prm.headers.get("content-type")).toContain("application/json");
    const oidc = await worker.fetch(
      new Request("https://emulators.dev/google/probe/.well-known/openid-configuration"),
      env,
    );
    expect(oidc.status).toBe(200);
    expect(((await oidc.json()) as { issuer: string }).issuer).toBe("https://emulators.dev/google/probe");
    const catalog = await worker.fetch(new Request("https://emulators.dev/"), env);
    expect(catalog.status).toBe(200);
    expect(catalog.headers.get("content-type")).toContain("text/html");
  });
});
