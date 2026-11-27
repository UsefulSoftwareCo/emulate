import type { RouteContext } from "@emulators/core";
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
} from "../common.js";
import {
  UnsupportedInput,
  approxTokens,
  chatCompletionId,
  conversationFromChatMessages,
  inputTokens,
  naturalPieces,
  splitInto,
  truncateToTokens,
} from "../text.js";
import { recordUsage } from "./responses.js";

/**
 * POST /v1/chat/completions, after OpenAI's reference
 * (https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create):
 * a chat.completion object, or with stream: true chat.completion.chunk events
 * (the role first, content deltas, an empty delta with finish_reason, a usage
 * chunk when stream_options.include_usage is set) ending with `data: [DONE]`.
 */
export function chatRoutes({ app, store }: RouteContext): void {
  app.post("/v1/chat/completions", async (c) => {
    c.set("operationId", "chat.completions.create");
    const caller = authenticate(store, c);
    if (caller instanceof Response) return caller;
    const limit = checkKeyLimit(store, c, caller);
    if ("response" in limit) return limit.response;
    const parsed = await readJsonBody(c);
    if (parsed instanceof Response) return parsed;
    const { body, bytes } = parsed;

    const model = checkModel(store, c, body.model);
    if (model instanceof Response) return model;
    if (Array.isArray(body.tools) && body.tools.length > 0) {
      return openaiError(
        c,
        400,
        "Tools are not supported by this emulator.",
        "invalid_request_error",
        "unsupported_parameter",
        "tools",
      );
    }
    if (body.n !== undefined && body.n !== 1) {
      return openaiError(
        c,
        400,
        "Only n = 1 is supported by this emulator.",
        "invalid_request_error",
        "unsupported_parameter",
        "n",
      );
    }
    let conv;
    try {
      conv = conversationFromChatMessages(body.messages);
    } catch (err) {
      if (err instanceof UnsupportedInput) {
        return openaiError(c, 400, err.message, "invalid_request_error", "invalid_value", err.param);
      }
      throw err;
    }
    const maxRaw = body.max_completion_tokens ?? body.max_tokens;
    if (maxRaw !== undefined && maxRaw !== null && (!Number.isInteger(maxRaw) || (maxRaw as number) < 1)) {
      return openaiError(
        c,
        400,
        "Invalid 'max_completion_tokens': expected a positive integer.",
        "invalid_request_error",
        "invalid_value",
        "max_completion_tokens",
      );
    }

    const answer = chooseAnswer(store, model, conv);
    const truncated = typeof maxRaw === "number" && approxTokens(answer.text) > maxRaw;
    const text = truncated ? truncateToTokens(answer.text, maxRaw as number) : answer.text;
    const finish = truncated ? "length" : "stop";
    const promptTokens = inputTokens(conv);
    const completionTokens = approxTokens(text);
    const usage = {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
      prompt_tokens_details: { cached_tokens: 0, audio_tokens: 0 },
      completion_tokens_details: {
        reasoning_tokens: 0,
        audio_tokens: 0,
        accepted_prediction_tokens: 0,
        rejected_prediction_tokens: 0,
      },
    };
    const id = chatCompletionId();
    const created = Math.floor(Date.now() / 1000);
    const stream = body.stream === true;
    const headers = { ...requestHeaders(), ...limit.headers };
    recordUsage(store, c, {
      request_id: headers["x-request-id"]!,
      operation: "chat.completions.create",
      caller,
      model,
      input_tokens: promptTokens,
      output_tokens: completionTokens,
      streamed: stream,
      request_bytes: bytes,
      status: truncated ? "incomplete" : "completed",
    });

    if (!stream) {
      return c.json(
        {
          id,
          object: "chat.completion",
          created,
          model,
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: text, refusal: null, annotations: [] },
              logprobs: null,
              finish_reason: finish,
            },
          ],
          usage,
          service_tier: "default",
        },
        200,
        headers,
      );
    }

    const includeUsage = (body.stream_options as { include_usage?: unknown } | undefined)?.include_usage === true;
    const pieces = answer.stream
      ? splitInto(text, Math.min(answer.stream.chunks, Math.max(1, [...text].length)))
      : naturalPieces(text);
    const interval = answer.stream?.interval_ms ?? 0;
    async function* frames(): AsyncGenerator<string> {
      const chunk = (choices: unknown[], extra: Record<string, unknown> = {}) =>
        `data: ${JSON.stringify({
          id,
          object: "chat.completion.chunk",
          created,
          model,
          service_tier: "default",
          system_fingerprint: null,
          choices,
          ...(includeUsage ? { usage: null } : {}),
          ...extra,
        })}\n\n`;
      yield chunk([
        { index: 0, delta: { role: "assistant", content: "", refusal: null }, logprobs: null, finish_reason: null },
      ]);
      for (let i = 0; i < pieces.length; i++) {
        if (i > 0 && interval > 0) await sleep(interval);
        yield chunk([{ index: 0, delta: { content: pieces[i] }, logprobs: null, finish_reason: null }]);
      }
      yield chunk([{ index: 0, delta: {}, logprobs: null, finish_reason: finish }]);
      if (includeUsage) yield chunk([], { usage });
      yield "data: [DONE]\n\n";
    }
    return sseResponse(frames(), headers);
  });
}
