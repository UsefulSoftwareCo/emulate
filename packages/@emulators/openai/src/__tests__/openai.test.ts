import { afterEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "net";
import OpenAI from "openai";
import { createServer, serve } from "@emulators/core";
import {
  openaiPlugin,
  seedFromConfig,
  getOpenAIStore,
  approxTokens,
  MAX_REQUEST_BYTES,
  type OpenAISeedConfig,
} from "../index.js";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const servers: Array<ReturnType<typeof serve>> = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
});

/** A real HTTP emulator on a free port, seeded, with official SDK clients per key. */
async function start(seed: OpenAISeedConfig = {}) {
  const emulator = createServer(openaiPlugin, { baseUrl: "http://127.0.0.1" });
  const http = serve({ fetch: emulator.app.fetch, port: 0 });
  servers.push(http);
  await new Promise<void>((r) => (http.listening ? r() : http.once("listening", () => r())));
  const base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  seedFromConfig(emulator.store, base, {
    api_keys: [
      { name: "primary", key: "sk-proj-test-primary" },
      { name: "secondary", key: "sk-proj-test-secondary" },
    ],
    ...seed,
  });
  const client = (key = "sk-proj-test-primary") => new OpenAI({ apiKey: key, baseURL: `${base}/v1`, maxRetries: 0 });
  const raw = (path: string, init: RequestInit = {}, key = "sk-proj-test-primary") =>
    fetch(`${base}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json", ...(init.headers as object) },
    });
  const control = (path: string, body?: unknown) =>
    fetch(`${base}/_emulate/openai${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  return { ...emulator, base, client, raw, control };
}

/** Fields OpenAI's OpenAPI document (openai-openapi, 2.3.0) marks required on these objects. */
const REQUIRED = {
  response: [
    "id",
    "object",
    "created_at",
    "error",
    "incomplete_details",
    "instructions",
    "model",
    "tools",
    "output",
    "parallel_tool_calls",
    "metadata",
    "tool_choice",
    "temperature",
    "top_p",
  ],
  message: ["id", "type", "role", "content", "status"],
  output_text: ["type", "text", "annotations"],
  usage: ["input_tokens", "input_tokens_details", "output_tokens", "output_tokens_details", "total_tokens"],
  "response.created": ["type", "response", "sequence_number"],
  "response.in_progress": ["type", "response", "sequence_number"],
  "response.output_item.added": ["type", "output_index", "item", "sequence_number"],
  "response.content_part.added": ["type", "item_id", "output_index", "content_index", "part", "sequence_number"],
  "response.output_text.delta": [
    "type",
    "item_id",
    "output_index",
    "content_index",
    "delta",
    "logprobs",
    "sequence_number",
  ],
  "response.output_text.done": [
    "type",
    "item_id",
    "output_index",
    "content_index",
    "text",
    "logprobs",
    "sequence_number",
  ],
  "response.content_part.done": ["type", "item_id", "output_index", "content_index", "part", "sequence_number"],
  "response.output_item.done": ["type", "output_index", "item", "sequence_number"],
  "response.completed": ["type", "response", "sequence_number"],
};

function hasAll(obj: Json, fields: string[], what: string) {
  for (const f of fields) expect(Object.prototype.hasOwnProperty.call(obj, f), `${what}.${f}`).toBe(true);
}

function checkResponseObject(r: Json) {
  hasAll(r, REQUIRED.response, "response");
  for (const item of r.output) {
    hasAll(item, REQUIRED.message, "message");
    for (const part of item.content) hasAll(part, REQUIRED.output_text, "output_text");
  }
  if (r.usage) hasAll(r.usage, REQUIRED.usage, "usage");
}

describe("POST /v1/responses through the official SDK", () => {
  it("answers a string input with the documented response object", async () => {
    const { client } = await start({
      answer_rules: [{ match: { contains: "summarise" }, answer: "A short summary." }],
    });
    const r = await client().responses.create({ model: "gpt-5-mini", input: "Please summarise this text." });
    expect(r.output_text).toBe("A short summary.");
    expect(r.object).toBe("response");
    expect(r.status).toBe("completed");
    expect(r.id).toMatch(/^resp_[0-9a-f]{48}$/);
    expect(r.output[0]).toMatchObject({ type: "message", role: "assistant", status: "completed" });
    expect(r.usage).toEqual({
      input_tokens: approxTokens("Please summarise this text."),
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: approxTokens("A short summary."),
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: approxTokens("Please summarise this text.") + approxTokens("A short summary."),
    });
    checkResponseObject(r as unknown as Json);
  });

  it("takes instructions and message items, and answers from the queue, then rules, then the default", async () => {
    const { client, control } = await start({
      answer_rules: [{ match: { instructions_contains: "terse" }, answer: "Rule answer." }],
    });
    await control("/answers/queue", { answers: ["Queued one.", "Queued two."] });
    const ask = (input: Parameters<OpenAI["responses"]["create"]>[0]["input"], instructions?: string) =>
      client().responses.create({ model: "gpt-5-mini", input, instructions });
    const items = [
      { role: "user" as const, content: "First question" },
      { role: "assistant" as const, content: "First answer" },
      { role: "user" as const, content: [{ type: "input_text" as const, text: "Second question" }] },
    ];
    expect((await ask(items, "Be terse.")).output_text).toBe("Queued one.");
    expect((await ask("x")).output_text).toBe("Queued two.");
    const ruled = await ask(items, "Be terse.");
    expect(ruled.output_text).toBe("Rule answer.");
    expect(ruled.instructions).toBe("Be terse.");
    expect(ruled.usage!.input_tokens).toBe(
      approxTokens("Be terse.", "First question", "First answer", "Second question"),
    );
    const dflt = await ask("What is the capital of France?");
    expect(dflt.output_text).toBe("Emulated response from gpt-5-mini to: What is the capital of France?");
    expect((await ask("What is the capital of France?")).output_text).toBe(dflt.output_text);
  });

  it("streams the documented events in order and the SDK assembles the answer", async () => {
    const { client } = await start({ answer_rules: [{ answer: "Hello there, streaming world." }] });
    const stream = await client().responses.create({ model: "gpt-5-mini", input: "hi", stream: true });
    const events: Json[] = [];
    for await (const e of stream) events.push(e as unknown as Json);
    const types = events.map((e) => e.type);
    expect(types.slice(0, 4)).toEqual([
      "response.created",
      "response.in_progress",
      "response.output_item.added",
      "response.content_part.added",
    ]);
    expect(types.slice(-4)).toEqual([
      "response.output_text.done",
      "response.content_part.done",
      "response.output_item.done",
      "response.completed",
    ]);
    const deltas = events.filter((e) => e.type === "response.output_text.delta");
    expect(deltas.map((d) => d.delta).join("")).toBe("Hello there, streaming world.");
    expect(events.map((e) => e.sequence_number)).toEqual(events.map((_, i) => i));
    for (const e of events) hasAll(e, REQUIRED[e.type as keyof typeof REQUIRED], e.type);
    checkResponseObject(events[0]!.response);
    checkResponseObject(events.at(-1)!.response);
    expect(events.at(-1)!.response.usage.output_tokens).toBe(approxTokens("Hello there, streaming world."));

    const helper = client().responses.stream({ model: "gpt-5-mini", input: "hi" });
    const final = await helper.finalResponse();
    expect(final.output_text).toBe("Hello there, streaming world.");
  });

  it("paces a slow stream: a stated number of chunks, a stated pause apart, whole and in order", async () => {
    const text = Array.from({ length: 20 }, (_, i) => String.fromCharCode(65 + i)).join("");
    const { client } = await start({
      answer_rules: [
        { match: { last_user_equals: "slow" }, answer: { text, stream: { chunks: 20, interval_ms: 60 } } },
      ],
    });
    const started = Date.now();
    const stream = await client().responses.create({ model: "gpt-5-mini", input: "slow", stream: true });
    const arrivals: Array<{ delta: string; at: number }> = [];
    for await (const e of stream) {
      if (e.type === "response.output_text.delta") arrivals.push({ delta: e.delta, at: Date.now() - started });
    }
    expect(arrivals.map((a) => a.delta).join("")).toBe(text);
    expect(arrivals).toHaveLength(20);
    expect(arrivals.at(-1)!.at - arrivals[0]!.at).toBeGreaterThanOrEqual(19 * 60 - 20);
  });

  it("stops at max_output_tokens with status incomplete, streamed or not", async () => {
    const long = "word ".repeat(200).trim();
    const { client } = await start({ answer_rules: [{ answer: long }] });
    const r = await client().responses.create({ model: "gpt-5-mini", input: "x", max_output_tokens: 16 });
    expect(r.status).toBe("incomplete");
    expect(r.incomplete_details).toEqual({ reason: "max_output_tokens" });
    expect(r.usage!.output_tokens).toBe(16);
    expect(r.output_text).toBe(long.slice(0, 64));
    const stream = await client().responses.create({
      model: "gpt-5-mini",
      input: "x",
      max_output_tokens: 16,
      stream: true,
    });
    const types: string[] = [];
    for await (const e of stream) types.push(e.type);
    expect(types.at(-1)).toBe("response.incomplete");
  });

  it("refuses what it does not emulate with OpenAI's errors", async () => {
    const { client } = await start();
    await expect(
      client().responses.create({
        model: "gpt-5-mini",
        input: "x",
        tools: [{ type: "function", name: "f", parameters: {}, strict: false }],
      }),
    ).rejects.toMatchObject({ status: 400, code: "unsupported_parameter", param: "tools" });
    await expect(
      client().responses.create({
        model: "gpt-5-mini",
        input: [{ role: "user", content: [{ type: "input_image", image_url: "https://x/y.png", detail: "auto" }] }],
      }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(client().responses.retrieve("resp_x")).rejects.toMatchObject({ status: 404 });
  });
});

describe("POST /v1/chat/completions through the official SDK", () => {
  it("answers with the documented chat.completion object", async () => {
    const { client } = await start({ answer_rules: [{ answer: "Hello! How can I assist you today?" }] });
    const r = await client().chat.completions.create({
      model: "gpt-5-mini",
      messages: [
        { role: "system", content: "You are helpful." },
        { role: "user", content: "Hello!" },
      ],
    });
    expect(r.object).toBe("chat.completion");
    expect(r.id).toMatch(/^chatcmpl-/);
    expect(r.choices[0]).toEqual({
      index: 0,
      message: { role: "assistant", content: "Hello! How can I assist you today?", refusal: null, annotations: [] },
      logprobs: null,
      finish_reason: "stop",
    });
    expect(r.usage).toMatchObject({
      prompt_tokens: approxTokens("You are helpful.", "Hello!"),
      completion_tokens: approxTokens("Hello! How can I assist you today?"),
    });
  });

  it("streams chunks ending with [DONE], with a usage chunk when asked, and paces a slow stream", async () => {
    const { client, raw } = await start({
      answer_rules: [
        {
          match: { last_user_equals: "slow" },
          answer: { text: "abcdefghij", stream: { chunks: 10, interval_ms: 50 } },
        },
        { answer: "Hello streaming chat." },
      ],
    });
    const stream = await client().chat.completions.create({
      model: "gpt-5-mini",
      messages: [{ role: "user", content: "Hi" }],
      stream: true,
      stream_options: { include_usage: true },
    });
    const chunks: Json[] = [];
    for await (const ch of stream) chunks.push(ch as unknown as Json);
    expect(chunks[0]!.choices[0].delta.role).toBe("assistant");
    expect(chunks.flatMap((c) => c.choices.map((x: Json) => x.delta.content ?? "")).join("")).toBe(
      "Hello streaming chat.",
    );
    expect(chunks.at(-2)!.choices[0].finish_reason).toBe("stop");
    expect(chunks.at(-1)!.choices).toEqual([]);
    expect(chunks.at(-1)!.usage.completion_tokens).toBe(approxTokens("Hello streaming chat."));
    const text = await (
      await raw("/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "slow" }], stream: true }),
      })
    ).text();
    expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true);
    const deltas = text
      .split("\n\n")
      .filter((f) => f.startsWith("data: {"))
      .map((f) => JSON.parse(f.slice(6)) as Json)
      .map((c) => c.choices[0]?.delta?.content ?? "");
    expect(deltas.join("")).toBe("abcdefghij");
  });

  it("finishes with length at max_completion_tokens", async () => {
    const { client } = await start({ answer_rules: [{ answer: "x".repeat(400) }] });
    const r = await client().chat.completions.create({
      model: "gpt-5-mini",
      messages: [{ role: "user", content: "go" }],
      max_completion_tokens: 10,
    });
    expect(r.choices[0]!.finish_reason).toBe("length");
    expect(r.choices[0]!.message.content).toHaveLength(40);
  });
});

describe("keys, models, limits and the ledger", () => {
  it("refuses a missing or unknown key with 401 invalid_api_key", async () => {
    const { client, raw } = await start();
    await expect(client("sk-proj-unknown-key-1234").responses.create({ model: "m", input: "x" })).rejects.toMatchObject(
      {
        status: 401,
        code: "invalid_api_key",
      },
    );
    const none = await raw("/v1/models", {}, "");
    expect(none.status).toBe(401);
    expect(((await none.json()) as Json).error.type).toBe("invalid_request_error");
  });

  it("lists seeded models and refuses unknown ones when models are seeded", async () => {
    const { client } = await start({ models: [{ id: "gpt-5-mini" }, { id: "gpt-5" }] });
    const ids: string[] = [];
    for await (const m of client().models.list()) ids.push(m.id);
    expect(ids).toEqual(["gpt-5", "gpt-5-mini"]);
    expect((await client().models.retrieve("gpt-5")).id).toBe("gpt-5");
    await expect(client().responses.create({ model: "no-such-model", input: "x" })).rejects.toMatchObject({
      status: 404,
      code: "model_not_found",
    });
  });

  it("limits one key with a 429 and Retry-After while other keys go on, as a rotating caller sees it", async () => {
    const { client, control, ledger } = await start();
    const set = await control("/keys/primary/rate-limit", { requests: 2, window_seconds: 120 });
    expect(set.status).toBe(200);
    for (let i = 0; i < 2; i++) await client().responses.create({ model: "m", input: `call ${i}` });
    const err = (await client()
      .responses.create({ model: "m", input: "third" })
      .catch((e: unknown) => e)) as InstanceType<typeof OpenAI.RateLimitError>;
    expect(err).toBeInstanceOf(OpenAI.RateLimitError);
    expect(err.status).toBe(429);
    expect(err.code).toBe("rate_limit_exceeded");
    expect(Number(err.headers?.get("retry-after"))).toBeGreaterThan(0);
    expect(err.headers?.get("x-ratelimit-remaining-requests")).toBe("0");
    // The caller rotates to the next key, which still works.
    const rotated = await client("sk-proj-test-secondary").responses.create({ model: "m", input: "third" });
    expect(rotated.status).toBe("completed");
    const calls = ledger
      .list()
      .reverse()
      .filter((e) => e.operationId === "responses.create")
      .map((e) => [e.identity.user?.login, e.response.status]);
    expect(calls).toEqual([
      ["primary", 200],
      ["primary", 200],
      ["primary", 429],
      ["secondary", 200],
    ]);
  });

  it("accepts an 8 MB request and records its size, not its content, in the ledger", async () => {
    const { client, ledger, control } = await start({ answer_rules: [{ answer: "Read it all." }] });
    const big = "lorem ipsum ".repeat(Math.ceil((8 * 1024 * 1024) / 12)).slice(0, 8 * 1024 * 1024);
    const r = await client().responses.create({ model: "gpt-5-mini", input: big });
    expect(r.output_text).toBe("Read it all.");
    expect(r.usage!.input_tokens).toBe(approxTokens(big));
    const entry = ledger.list()[0]!;
    expect(entry.request.bodyBytes).toBeGreaterThan(8 * 1024 * 1024);
    expect(String(entry.request.body)).toMatch(/^<request body omitted: \d+ bytes>$/);
    expect(JSON.stringify(entry).length).toBeLessThan(64 * 1024);
    const usage = (await (await control("/usage")).json()) as Json;
    expect(usage.calls[0]).toMatchObject({ key_name: "primary", request_bytes: entry.request.bodyBytes });
  });

  it("answers a request of hundreds of thousands of messages on both endpoints, and records it", async () => {
    const { raw, control } = await start({ answer_rules: [{ answer: "ok" }] });
    const many = Array.from({ length: 300_000 }, () => ({ role: "user", content: "hi" }));
    const responses = await raw("/v1/responses", {
      method: "POST",
      body: JSON.stringify({ model: "gpt-5-mini", input: many }),
    });
    expect(responses.status).toBe(200);
    expect(((await responses.json()) as Json).usage.input_tokens).toBe(Math.ceil((300_000 * 2) / 4));
    const chat = await raw("/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "gpt-5-mini", messages: many }),
    });
    expect(chat.status).toBe(200);
    const usage = (await (await control("/usage")).json()) as Json;
    expect(usage.calls).toHaveLength(2);
  });

  it("counts characters as code points, surrogate pairs once, as before", () => {
    const text = "a\u00e9\u{1F600}b\uD800";
    expect(approxTokens(text.repeat(4))).toBe(Math.ceil([...text.repeat(4)].length / 4));
  });

  it("refuses a body over its stated limit with a 413 in OpenAI's error shape, through the official SDK", async () => {
    const { client, ledger } = await start();
    const big = "a".repeat(MAX_REQUEST_BYTES + 1);
    const err = await client()
      .responses.create({ model: "gpt-5-mini", input: big })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OpenAI.APIError);
    expect((err as InstanceType<typeof OpenAI.APIError>).status).toBe(413);
    expect((err as InstanceType<typeof OpenAI.APIError>).error).toEqual({
      message: `Request body too large. The emulator accepts request bodies of up to ${MAX_REQUEST_BYTES} bytes.`,
      type: "invalid_request_error",
      param: null,
      code: "request_too_large",
    });
    expect(ledger.list()[0]!.response.status).toBe(413);
  });

  it("refuses a body of undeclared length once it passes the limit, and accepts one under it", async () => {
    const { raw } = await start({ answer_rules: [{ answer: "ok" }] });
    const stream = (bytes: number) => {
      const head = new TextEncoder().encode('{"model":"gpt-5-mini","input":"');
      const tail = new TextEncoder().encode('"}');
      let sent = 0;
      const middle = bytes - head.length - tail.length;
      return new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(head);
        },
        pull(controller) {
          if (sent >= middle) {
            controller.enqueue(tail);
            return controller.close();
          }
          const n = Math.min(1024 * 1024, middle - sent);
          controller.enqueue(new Uint8Array(n).fill(97));
          sent += n;
        },
      });
    };
    const send = (bytes: number) =>
      raw("/v1/responses", { method: "POST", body: stream(bytes), duplex: "half" } as RequestInit);
    expect((await send(MAX_REQUEST_BYTES + 1024)).status).toBe(413);
    expect((await send(4 * 1024 * 1024)).status).toBe(200);
  });

  it("keeps one usage record per call whose counts match the responses", async () => {
    const { client, control, store } = await start({ answer_rules: [{ answer: "Two words" }] });
    const a = await client().responses.create({ model: "gpt-5-mini", input: "one" });
    const b = await client("sk-proj-test-secondary").chat.completions.create({
      model: "gpt-5-mini",
      messages: [{ role: "user", content: "two" }],
    });
    const usage = (await (await control("/usage")).json()) as Json;
    expect(usage.totals.calls).toBe(2);
    expect(usage.calls.map((u: Json) => [u.operation, u.key_name, u.input_tokens, u.output_tokens])).toEqual([
      ["responses.create", "primary", a.usage!.input_tokens, a.usage!.output_tokens],
      ["chat.completions.create", "secondary", b.usage!.prompt_tokens, b.usage!.completion_tokens],
    ]);
    expect(getOpenAIStore(store).usage.all()).toHaveLength(2);
  });
});
