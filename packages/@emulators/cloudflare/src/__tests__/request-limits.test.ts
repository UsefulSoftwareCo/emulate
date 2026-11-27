import { describe, expect, it } from "vitest";
import { MAX_REQUEST_BYTES as OPENAI_MAX } from "@emulators/openai";
import { EmulatorDurableObject } from "../durable-object.js";
import { HOSTED_MAX_REQUEST_BYTES } from "../services.js";
import worker, { type Env } from "../worker.js";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

function memoryState() {
  const map = new Map<string, unknown>();
  const copy = <T>(v: unknown): T => JSON.parse(JSON.stringify(v)) as T;
  return {
    storage: {
      get: async <T>(k: string) => (map.has(k) ? copy<T>(map.get(k)) : undefined),
      put: async (k: string, v: unknown) => void map.set(k, copy(v)),
      delete: async (k: string | string[]) =>
        Array.isArray(k) ? k.filter((x) => map.delete(x)).length : map.delete(k),
      list: async <T>(o?: { prefix?: string }) =>
        new Map([...map].filter(([k]) => !o?.prefix || k.startsWith(o.prefix)).map(([k, v]) => [k, copy<T>(v)])),
    },
    blockConcurrencyWhile: <T>(fn: () => Promise<T>) => fn(),
  };
}

function hosted() {
  const objects = new Map<string, EmulatorDurableObject>();
  const fetched: string[] = [];
  const env = {
    EMULATE_HOST_SUFFIX: "emulators.dev",
    EMULATOR: {
      idFromName: (name: string) => name,
      get(id: unknown) {
        const key = String(id);
        if (!objects.has(key)) objects.set(key, new EmulatorDurableObject(memoryState() as never, {}));
        const object = objects.get(key)!;
        return {
          fetch: (request: Request) => {
            fetched.push(new URL(request.url).pathname);
            return object.fetch(request);
          },
        };
      },
    },
  } as unknown as Env;
  return { call: (req: Request) => worker.fetch(req, env), fetched };
}

/** A body that claims `length` bytes and fails the test if anyone reads it. */
function unreadable(): ReadableStream<Uint8Array> {
  return new ReadableStream({
    pull() {
      throw new Error("the body was read");
    },
  });
}

/** A body of `bytes` bytes with no declared length, sent in 1 MiB pieces. */
function chunked(bytes: number, prefix = ""): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  let sent = 0;
  let first = true;
  return new ReadableStream({
    pull(controller) {
      if (sent >= bytes) return controller.close();
      const head = first ? enc.encode(prefix) : new Uint8Array(0);
      first = false;
      const n = Math.min(1024 * 1024, bytes - sent) - head.length;
      const piece = new Uint8Array(head.length + n).fill(97);
      piece.set(head, 0);
      sent += piece.length;
      controller.enqueue(piece);
    },
  });
}

const post = (url: string, body: RequestInit["body"], headers: Record<string, string>) =>
  new Request(url, { method: "POST", headers, body, duplex: "half" } as RequestInit);

describe("request bodies over the hosted limit", () => {
  it("refuses an oversized OpenAI body with OpenAI's 413 shape, without reading it or reaching the instance", async () => {
    const h = hosted();
    const res = await h.call(
      post("https://emulators.dev/openai/run/v1/responses", unreadable(), {
        "content-type": "application/json",
        "content-length": String(100 * 1024 * 1024),
        authorization: "Bearer sk-proj-emulate-default-key",
      }),
    );
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({
      error: {
        message: `Request body too large. The emulator accepts request bodies of up to ${OPENAI_MAX} bytes.`,
        type: "invalid_request_error",
        param: null,
        code: "request_too_large",
      },
    });
    expect(h.fetched).toEqual([]);
  });

  it("refuses a body of undeclared length once it passes the limit", async () => {
    const h = hosted();
    const res = await h.call(
      post("https://emulators.dev/openai/run/v1/responses", chunked(OPENAI_MAX + 1, '{"input":"'), {
        "content-type": "application/json",
        authorization: "Bearer sk-proj-emulate-default-key",
      }),
    );
    expect(res.status).toBe(413);
    expect(((await res.json()) as Json).error.code).toBe("request_too_large");
    expect(h.fetched).toEqual([]);
  });

  it("refuses other services' oversized bodies with the hosted limit", async () => {
    const h = hosted();
    const res = await h.call(
      post("https://emulators.dev/github/run/repos/a/b/issues", unreadable(), {
        "content-type": "application/json",
        "content-length": String(HOSTED_MAX_REQUEST_BYTES + 1),
      }),
    );
    expect(res.status).toBe(413);
    expect(((await res.json()) as Json).error).toBe("request_too_large");
    expect(h.fetched).toEqual([]);
  });

  it("passes a body at the limit through, declared or not", async () => {
    const h = hosted();
    const input = "a".repeat(2 * 1024 * 1024);
    const body = JSON.stringify({ model: "gpt-5-mini", input });
    const auth = { "content-type": "application/json", authorization: "Bearer sk-proj-emulate-default-key" };
    const declared = await h.call(
      post("https://emulators.dev/openai/run/v1/responses", body, { ...auth, "content-length": String(body.length) }),
    );
    expect(declared.status).toBe(200);
    const undeclared = await h.call(
      post("https://emulators.dev/openai/run/v1/responses", new Blob([body]).stream(), auth),
    );
    expect(undeclared.status).toBe(200);
    expect(((await undeclared.json()) as Json).usage.input_tokens).toBe(
      ((await declared.json()) as Json).usage.input_tokens,
    );
  });
});
