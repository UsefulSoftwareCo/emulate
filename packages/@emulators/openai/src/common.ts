import { createHash } from "crypto";
import type { Context, Store } from "@emulators/core";
import { getOpenAIStore, type OpenAIKey } from "./store.js";
import { openaiId } from "./text.js";

/**
 * OpenAI's error envelope, `{ error: { message, type, param, code } }`, the
 * model the official SDK parses into its error classes. The error-codes guide
 * (https://developers.openai.com/api/docs/guides/error-codes) names the errors
 * but shows no bodies, so messages follow its wording.
 */
export function openaiError(
  c: Context,
  status: 400 | 401 | 404 | 413 | 429,
  message: string,
  type: string,
  code: string | null,
  param: string | null = null,
  headers: Record<string, string> = {},
) {
  return c.json({ error: { message, type, param, code } }, status, headers);
}

export interface Caller {
  key_id: string;
  name: string;
  key: OpenAIKey | null;
}

function mask(key: string): string {
  if (key.length <= 8) return "*".repeat(key.length);
  const dash = key.lastIndexOf("-", 8);
  const prefix = key.slice(0, dash > 0 ? dash + 1 : 3);
  return `${prefix}${"*".repeat(Math.max(4, key.length - prefix.length - 4))}${key.slice(-4)}`;
}

/**
 * The calling key: one seeded or created through the control plane (stored, so
 * it survives a hosted instance's eviction), or a credential minted by the core
 * control plane. Unknown keys answer 401 like OpenAI; the core's permissive
 * fallback identity is not accepted, because OpenAI never accepts a key it did
 * not issue. Records the key's name and id as the ledger identity.
 */
export function authenticate(store: Store, c: Context): Caller | Response {
  const header = c.req.header("Authorization") ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(header);
  if (!m || !m[1]!.trim()) {
    return openaiError(
      c,
      401,
      "You didn't provide an API key. You need to provide your API key in an Authorization header using Bearer auth (i.e. Authorization: Bearer YOUR_KEY).",
      "invalid_request_error",
      null,
    );
  }
  const token = m[1]!.trim();
  const row = getOpenAIStore(store).keys.findOneBy("key", token);
  let caller: Caller | null = row ? { key_id: row.key_id, name: row.name, key: row } : null;
  const minted = c.get("authUser");
  if (!caller && minted && !minted.fallback) {
    caller = {
      key_id: "key_" + createHash("sha256").update(token).digest("hex").slice(0, 24),
      name: minted.login,
      key: null,
    };
  }
  if (!caller) {
    return openaiError(
      c,
      401,
      `Incorrect API key provided: ${mask(token)}. You can find your API key at https://platform.openai.com/account/api-keys.`,
      "invalid_request_error",
      "invalid_api_key",
    );
  }
  c.set("authUser", { login: caller.name, id: row?.id ?? 0, scopes: [] });
  return caller;
}

/** `x-ratelimit-reset-requests` style duration: `1s`, `6m0s`. */
function duration(ms: number): string {
  const total = Math.max(1, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m}m${s}s` : `${s}s`;
}

/**
 * The key's own request limit, if it has one: a fixed window counted per key,
 * reported in x-ratelimit-*-requests headers, and a 429 with Retry-After
 * (seconds) when spent (https://developers.openai.com/api/docs/guides/rate-limits).
 * Token limits are not emulated.
 */
export function checkKeyLimit(
  store: Store,
  c: Context,
  caller: Caller,
): { headers: Record<string, string> } | { response: Response } {
  const limit = caller.key?.rate_limit;
  if (!limit) return { headers: {} };
  const windows = getOpenAIStore(store).rateWindows;
  const now = Date.now();
  let w = windows.findOneBy("key_id", caller.key_id);
  if (!w || w.reset_at_ms <= now || w.limit !== limit.requests) {
    if (w) windows.delete(w.id);
    w = windows.insert({
      key_id: caller.key_id,
      limit: limit.requests,
      used: 0,
      reset_at_ms: now + limit.window_seconds * 1000,
    });
  }
  const resetMs = w.reset_at_ms - now;
  if (w.used >= w.limit) {
    const retry = String(Math.max(1, Math.ceil(resetMs / 1000)));
    return {
      response: openaiError(
        c,
        429,
        `Rate limit reached for requests on API key ${caller.name}: Limit ${w.limit}, Used ${w.used}, Requested 1. Please try again in ${retry}s.`,
        "requests",
        "rate_limit_exceeded",
        null,
        {
          "retry-after": retry,
          "x-ratelimit-limit-requests": String(w.limit),
          "x-ratelimit-remaining-requests": "0",
          "x-ratelimit-reset-requests": duration(resetMs),
        },
      ),
    };
  }
  windows.update(w.id, { used: w.used + 1 });
  return {
    headers: {
      "x-ratelimit-limit-requests": String(w.limit),
      "x-ratelimit-remaining-requests": String(w.limit - w.used - 1),
      "x-ratelimit-reset-requests": duration(resetMs),
    },
  };
}

/** Request bodies above this many bytes are recorded in the ledger by size only. */
export const LEDGER_BODY_LIMIT = 64 * 1024;

/**
 * The largest request body the emulator accepts, in bytes. OpenAI documents no
 * overall limit for these endpoints (only 50 MB across the files in one request),
 * so this is the emulator's own, stated in its docs and manifest. A larger body is
 * refused with a 413 before it is read.
 */
export const MAX_REQUEST_BYTES = 32 * 1024 * 1024;

/** The 413 for a body over MAX_REQUEST_BYTES, in OpenAI's error shape. */
export function requestTooLargeResponse(limit = MAX_REQUEST_BYTES): Response {
  return new Response(
    JSON.stringify({
      error: {
        message: `Request body too large. The emulator accepts request bodies of up to ${limit} bytes.`,
        type: "invalid_request_error",
        param: null,
        code: "request_too_large",
      },
    }),
    { status: 413, headers: { "content-type": "application/json" } },
  );
}

/** The declared body size, or null when the request does not say. */
function declaredLength(c: Context): number | null {
  const n = Number(c.req.header("content-length") ?? NaN);
  return Number.isFinite(n) ? n : null;
}

/** The body as text, or null once it passes `limit` bytes (reading stops there). */
async function readLimitedText(c: Context, limit: number): Promise<string | null> {
  const stream = c.req.raw.body;
  if (!stream) return "";
  const reader = stream.getReader();
  // Decoded as it arrives, so the raw bytes are not held alongside the text.
  const decoder = new TextDecoder();
  const pieces: string[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > limit) {
      // Not awaited: the rest of the body may never arrive, and cancelling must not hold the answer.
      void reader.cancel().catch(() => {});
      return null;
    }
    pieces.push(decoder.decode(value, { stream: true }));
  }
  pieces.push(decoder.decode());
  return pieces.join("");
}

/** Read and parse the JSON body, recording a large one in the ledger by size only. */
export async function readJsonBody(c: Context): Promise<{ body: Record<string, unknown>; bytes: number } | Response> {
  const declared = declaredLength(c);
  if (declared !== null && declared > MAX_REQUEST_BYTES) return requestTooLargeResponse();
  const raw = await readLimitedText(c, MAX_REQUEST_BYTES);
  if (raw === null) return requestTooLargeResponse();
  const bytes = Buffer.byteLength(raw, "utf8");
  if (bytes > LEDGER_BODY_LIMIT) c.set("ledgerRequestBodyBytes", bytes);
  try {
    const body = JSON.parse(raw) as unknown;
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("not an object");
    return { body: body as Record<string, unknown>, bytes };
  } catch {
    return openaiError(
      c,
      400,
      "We could not parse the JSON body of your request. (HINT: This likely means you aren't using your HTTP library correctly. The OpenAI API expects a JSON payload, but what was sent was not valid JSON.)",
      "invalid_request_error",
      null,
    );
  }
}

export function requestHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { "x-request-id": openaiId("req_"), ...extra };
}

/**
 * A server-sent event stream fed by an async generator of SSE frames. Pauses
 * come from the generator; cancelling the stream (the client went away) stops it.
 */
export function sseResponse(frames: AsyncGenerator<string>, headers: Record<string, string>): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await frames.next();
      if (next.done) controller.close();
      else controller.enqueue(encoder.encode(next.value));
    },
    async cancel() {
      await frames.return(undefined);
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", ...headers },
  });
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Model check: with models seeded, an unknown id is refused; with none, any id is accepted. */
export function checkModel(store: Store, c: Context, model: unknown): string | Response {
  if (typeof model !== "string" || !model) {
    return openaiError(
      c,
      400,
      "Missing required parameter: 'model'.",
      "invalid_request_error",
      "missing_required_parameter",
      "model",
    );
  }
  const models = getOpenAIStore(store).models;
  if (models.all().length > 0 && !models.findOneBy("model_id", model)) {
    return openaiError(
      c,
      404,
      `The model \`${model}\` does not exist or you do not have access to it.`,
      "invalid_request_error",
      "model_not_found",
      "model",
    );
  }
  return model;
}
