import type { Context, RouteContext, Store } from "@emulators/core";
import { recordSideEffect } from "@emulators/core";
import { chooseAnswer } from "../answers.js";
import {
  authenticate,
  checkKeyLimit,
  checkModel,
  openaiError,
  readJsonBody,
  requestHeaders,
  sleep,
  sseResponse,
  type Caller,
} from "../common.js";
import { getOpenAIStore } from "../store.js";
import {
  UnsupportedInput,
  approxTokens,
  conversationFromResponsesInput,
  inputTokens,
  naturalPieces,
  openaiId,
  splitInto,
  truncateToTokens,
} from "../text.js";

/**
 * POST /v1/responses, after OpenAI's reference
 * (https://developers.openai.com/api/reference/resources/responses/methods/create):
 * the response object with every field the reference marks required, and the
 * streamed event order response.created, response.in_progress,
 * response.output_item.added, response.content_part.added,
 * response.output_text.delta..., response.output_text.done,
 * response.content_part.done, response.output_item.done, then
 * response.completed (or response.incomplete when max_output_tokens cut it).
 */

const UNSUPPORTED: Array<[string, (v: unknown) => boolean, string]> = [
  ["tools", (v) => Array.isArray(v) && v.length > 0, "Tools are not supported by this emulator."],
  [
    "previous_response_id",
    (v) => v != null,
    "Stored responses (previous_response_id) are not supported by this emulator.",
  ],
  ["conversation", (v) => v != null, "Conversations are not supported by this emulator."],
  ["background", (v) => v === true, "Background responses are not supported by this emulator."],
  ["prompt", (v) => v != null, "Prompt templates are not supported by this emulator."],
];

export function recordUsage(
  store: Store,
  c: Context,
  u: {
    request_id: string;
    operation: "responses.create" | "chat.completions.create";
    caller: Caller;
    model: string;
    input_tokens: number;
    output_tokens: number;
    streamed: boolean;
    request_bytes: number;
    status: "completed" | "incomplete";
  },
): void {
  getOpenAIStore(store).usage.insert({
    request_id: u.request_id,
    operation: u.operation,
    key_id: u.caller.key_id,
    key_name: u.caller.name,
    model: u.model,
    input_tokens: u.input_tokens,
    output_tokens: u.output_tokens,
    total_tokens: u.input_tokens + u.output_tokens,
    streamed: u.streamed,
    request_bytes: u.request_bytes,
    status: u.status,
    called_at: Math.floor(Date.now() / 1000),
  });
  recordSideEffect(c, {
    type: "custom",
    collection: "openai.usage",
    id: u.request_id,
    summary: `${u.operation} model=${u.model} key=${u.caller.key_id} input_tokens=${u.input_tokens} output_tokens=${u.output_tokens} streamed=${u.streamed} request_bytes=${u.request_bytes}`,
  });
}

export function responsesRoutes({ app, store }: RouteContext): void {
  app.post("/v1/responses", async (c) => {
    c.set("operationId", "responses.create");
    const caller = authenticate(store, c);
    if (caller instanceof Response) return caller;
    const limit = checkKeyLimit(store, c, caller);
    if ("response" in limit) return limit.response;
    const parsed = await readJsonBody(c);
    if (parsed instanceof Response) return parsed;
    const { body, bytes } = parsed;

    const model = checkModel(store, c, body.model);
    if (model instanceof Response) return model;
    for (const [param, bad, message] of UNSUPPORTED) {
      if (bad(body[param]))
        return openaiError(c, 400, message, "invalid_request_error", "unsupported_parameter", param);
    }
    if (body.input === undefined) {
      return openaiError(
        c,
        400,
        "Missing required parameter: 'input'.",
        "invalid_request_error",
        "missing_required_parameter",
        "input",
      );
    }
    let conv;
    try {
      conv = conversationFromResponsesInput(body.input, body.instructions);
    } catch (err) {
      if (err instanceof UnsupportedInput) {
        return openaiError(c, 400, err.message, "invalid_request_error", "invalid_value", err.param);
      }
      throw err;
    }
    const maxOutput = body.max_output_tokens;
    if (maxOutput !== undefined && maxOutput !== null && (!Number.isInteger(maxOutput) || (maxOutput as number) < 16)) {
      return openaiError(
        c,
        400,
        `Invalid 'max_output_tokens': integer below minimum value. Expected a value >= 16, but got ${String(maxOutput)} instead.`,
        "invalid_request_error",
        "integer_below_min_value",
        "max_output_tokens",
      );
    }

    const answer = chooseAnswer(store, model, conv);
    const fullTokens = approxTokens(answer.text);
    const truncated = typeof maxOutput === "number" && fullTokens > maxOutput;
    const text = truncated ? truncateToTokens(answer.text, maxOutput as number) : answer.text;
    const inTokens = inputTokens(conv);
    const outTokens = approxTokens(text);
    const responseId = openaiId("resp_");
    const messageId = openaiId("msg_");
    const createdAt = Math.floor(Date.now() / 1000);
    const stream = body.stream === true;
    const headers = { ...requestHeaders(), ...limit.headers };
    recordUsage(store, c, {
      request_id: headers["x-request-id"]!,
      operation: "responses.create",
      caller,
      model,
      input_tokens: inTokens,
      output_tokens: outTokens,
      streamed: stream,
      request_bytes: bytes,
      status: truncated ? "incomplete" : "completed",
    });

    const outputText = (t: string) => ({ type: "output_text", annotations: [], logprobs: [], text: t });
    const message = (status: "in_progress" | "completed" | "incomplete", content: unknown[]) => ({
      id: messageId,
      type: "message",
      status,
      content,
      role: "assistant",
    });
    const responseObject = (status: "in_progress" | "completed" | "incomplete", output: unknown[], done: boolean) => ({
      id: responseId,
      object: "response",
      created_at: createdAt,
      status,
      background: false,
      completed_at: done ? Math.floor(Date.now() / 1000) : null,
      error: null,
      incomplete_details: status === "incomplete" ? { reason: "max_output_tokens" } : null,
      instructions: typeof body.instructions === "string" ? body.instructions : null,
      max_output_tokens: typeof maxOutput === "number" ? maxOutput : null,
      max_tool_calls: null,
      model,
      output,
      parallel_tool_calls: typeof body.parallel_tool_calls === "boolean" ? body.parallel_tool_calls : true,
      previous_response_id: null,
      reasoning: { effort: null, summary: null },
      service_tier: "default",
      store: body.store !== false,
      temperature: typeof body.temperature === "number" ? body.temperature : 1.0,
      text: { format: { type: "text" } },
      tool_choice: "auto",
      tools: [],
      top_logprobs: 0,
      top_p: typeof body.top_p === "number" ? body.top_p : 1.0,
      truncation: "disabled",
      usage: done
        ? {
            input_tokens: inTokens,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens: outTokens,
            output_tokens_details: { reasoning_tokens: 0 },
            total_tokens: inTokens + outTokens,
          }
        : null,
      user: typeof body.user === "string" ? body.user : null,
      metadata: body.metadata && typeof body.metadata === "object" ? body.metadata : {},
    });
    const finalStatus = truncated ? "incomplete" : "completed";

    if (!stream) {
      return c.json(responseObject(finalStatus, [message(finalStatus, [outputText(text)])], true), 200, headers);
    }

    const pieces = answer.stream
      ? splitInto(text, Math.min(answer.stream.chunks, Math.max(1, [...text].length)))
      : naturalPieces(text);
    const interval = answer.stream?.interval_ms ?? 0;
    async function* frames(): AsyncGenerator<string> {
      let seq = 0;
      const ev = (type: string, data: Record<string, unknown>) =>
        `event: ${type}\ndata: ${JSON.stringify({ type, ...data, sequence_number: seq++ })}\n\n`;
      yield ev("response.created", { response: responseObject("in_progress", [], false) });
      yield ev("response.in_progress", { response: responseObject("in_progress", [], false) });
      yield ev("response.output_item.added", { output_index: 0, item: message("in_progress", []) });
      yield ev("response.content_part.added", {
        item_id: messageId,
        output_index: 0,
        content_index: 0,
        part: outputText(""),
      });
      for (let i = 0; i < pieces.length; i++) {
        if (i > 0 && interval > 0) await sleep(interval);
        yield ev("response.output_text.delta", {
          item_id: messageId,
          output_index: 0,
          content_index: 0,
          delta: pieces[i],
          logprobs: [],
        });
      }
      yield ev("response.output_text.done", {
        item_id: messageId,
        output_index: 0,
        content_index: 0,
        text,
        logprobs: [],
      });
      yield ev("response.content_part.done", {
        item_id: messageId,
        output_index: 0,
        content_index: 0,
        part: outputText(text),
      });
      yield ev("response.output_item.done", { output_index: 0, item: message(finalStatus, [outputText(text)]) });
      yield ev(truncated ? "response.incomplete" : "response.completed", {
        response: responseObject(finalStatus, [message(finalStatus, [outputText(text)])], true),
      });
    }
    return sseResponse(frames(), headers);
  });

  // Stored responses are not emulated: say so in OpenAI's error shape rather than 404 HTML.
  app.get("/v1/responses/:id", (c) => {
    const caller = authenticate(store, c);
    if (caller instanceof Response) return caller;
    return openaiError(
      c,
      404,
      `Response with id '${c.req.param("id")}' not found. (Stored responses are not supported by this emulator.)`,
      "invalid_request_error",
      null,
      "response_id",
    );
  });
}
