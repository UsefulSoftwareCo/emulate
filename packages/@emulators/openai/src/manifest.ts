import type { ServiceManifest } from "@emulators/core";

/**
 * OpenAI's service manifest: the Responses API and Chat Completions as text
 * models answering deterministically, with API-key auth. Shapes follow OpenAI's
 * API reference (https://developers.openai.com/api/reference) and are checked
 * against the official `openai` SDK in this package's tests.
 */
export const manifest: ServiceManifest = {
  id: "openai",
  name: "OpenAI",
  description:
    "Stateful OpenAI API emulator for text models: the Responses API and Chat Completions, streamed or not, with API-key auth, deterministic answers a test seeds, per-key request limits, and a usage record per call.",
  docsUrl: "https://docs.emulators.dev/openai",
  surfaces: [
    { id: "rest", kind: "rest", title: "OpenAI API (REST)", status: "partial", basePath: "/v1" },
    {
      id: "streaming",
      kind: "provider-specific",
      title: "Server-sent event streaming",
      status: "supported",
      notes:
        "Responses API events in the documented order with sequence_number; Chat Completions chunks ending with data: [DONE]. Pacing (chunks and interval) is set per answer. Request bodies are limited to 32 MiB (the emulator's own limit; OpenAI documents none for these endpoints): a larger one answers 413 request_too_large before it is read.",
    },
    {
      id: "realtime",
      kind: "provider-specific",
      title: "WebSocket and Realtime transports",
      status: "unsupported",
    },
  ],
  auth: [
    {
      id: "api-key",
      title: "API key (Authorization: Bearer)",
      type: "api-key",
      status: "supported",
      notes:
        "Keys are seeded (api_keys), created with POST /_emulate/openai/keys, or minted with POST /_emulate/credentials. Unknown keys answer 401 invalid_api_key. Organization and project headers are accepted and ignored.",
    },
  ],
  specs: [
    {
      kind: "openapi",
      title: "OpenAI API subset",
      coverage: "partial",
      operations: [
        {
          operationId: "responses.create",
          method: "POST",
          path: "/v1/responses",
          status: "partial",
          summary:
            "Text in and out: input as a string or message items, instructions, max_output_tokens (truncates, status incomplete), stream. Tools, images, files, reasoning, background, prompts and previous_response_id are refused with 400.",
        },
        {
          operationId: "responses.retrieve",
          method: "GET",
          path: "/v1/responses/:id",
          status: "unsupported",
          summary: "Responses are not stored; answers 404 in OpenAI's error shape.",
        },
        {
          operationId: "chat.completions.create",
          method: "POST",
          path: "/v1/chat/completions",
          status: "partial",
          summary:
            "Text messages, max_tokens / max_completion_tokens (finish_reason length), stream with stream_options.include_usage. Tools, images, audio, logprobs and n > 1 are refused or not emulated.",
        },
        { operationId: "models.list", method: "GET", path: "/v1/models", status: "hand-authored" },
        { operationId: "models.retrieve", method: "GET", path: "/v1/models/:model", status: "hand-authored" },
        { operationId: "embeddings.create", method: "POST", path: "/v1/embeddings", status: "unsupported" },
        { operationId: "images.generate", method: "POST", path: "/v1/images/generations", status: "unsupported" },
        { operationId: "audio.speech.create", method: "POST", path: "/v1/audio/speech", status: "unsupported" },
      ],
    },
    {
      kind: "manual",
      title: "Token counts",
      coverage: "partial",
      notes:
        "Approximate: one token per four characters of text, rounded up, over instructions and every message (input) and the answer (output). Deterministic and identical in responses and in the usage record; not OpenAI's tokenizer.",
    },
    {
      kind: "manual",
      title: "Rate limits",
      coverage: "partial",
      notes:
        "Per-key request windows with x-ratelimit-limit-requests, -remaining-requests, -reset-requests and a 429 with Retry-After when spent. Token-based limits and the x-ratelimit-*-tokens headers are not emulated. The 429 body's type and code follow OpenAI's SDK error model; the guide shows no body.",
    },
  ],
  scenarios: [
    {
      id: "default",
      title: "One key, any model",
      description:
        "A key named default (sk-proj-emulate-default-key); with no models seeded, any model id is accepted.",
    },
  ],
  seedSchema: {
    description: "Seed API keys, models, and deterministic answers.",
    fields: [
      {
        key: "api_keys",
        title: "API keys",
        description:
          "Keys by name; rate_limit { requests, window_seconds } limits one key, so a caller rotating keys can be shown to move on.",
        example: [
          { name: "primary", key: "sk-proj-test-primary" },
          { name: "secondary", rate_limit: { requests: 0, window_seconds: 60 } },
        ],
      },
      {
        key: "models",
        title: "Models",
        description:
          "Models GET /v1/models lists. With models seeded, an unknown model id answers 404 model_not_found.",
        example: [{ id: "gpt-5-mini" }],
      },
      {
        key: "answer_rules",
        title: "Answer rules",
        description:
          "First match wins. match: { model?, contains?, last_user_equals?, instructions_contains? }. answer: text or { text, stream: { chunks, interval_ms } } to pace a streamed answer. times limits how often a rule applies.",
        example: [
          { match: { contains: "summarise" }, answer: "A short summary." },
          {
            match: { last_user_equals: "slow" },
            answer: { text: "x".repeat(600), stream: { chunks: 600, interval_ms: 500 } },
          },
        ],
      },
      {
        key: "answer_queue",
        title: "Answer queue",
        description: "Answers for the next requests, in order, used before any rule.",
        example: ["first answer", "second answer"],
      },
    ],
    example: {
      api_keys: [{ name: "primary", key: "sk-proj-test-primary" }],
      models: [{ id: "gpt-5-mini" }],
      answer_rules: [{ match: { contains: "summarise" }, answer: "A short summary." }],
    },
  },
  stateModel: {
    description: "Keys, models, answers and the usage record.",
    collections: [
      { name: "openai.api_keys", title: "API keys" },
      { name: "openai.models", title: "Models" },
      { name: "openai.answer_rules", title: "Answer rules" },
      { name: "openai.answer_queue", title: "Queued answers" },
      { name: "openai.usage", title: "Usage, one record per model call" },
      { name: "openai.rate_windows", title: "Open per-key request windows" },
    ],
  },
  connections: [
    {
      id: "openai-node",
      title: "openai (TypeScript)",
      kind: "sdk",
      language: "typescript",
      description: "Point the official SDK at the emulator.",
      template:
        'import OpenAI from "openai";\n\nconst client = new OpenAI({ apiKey: "{{token}}", baseURL: "{{baseUrl}}/v1" });\nconst response = await client.responses.create({ model: "gpt-5-mini", input: "Hello" });\nconsole.log(response.output_text);',
    },
    {
      id: "openai-env",
      title: "Environment",
      kind: "env",
      language: "bash",
      description: "The official SDKs read these.",
      template: "OPENAI_API_KEY={{token}}\nOPENAI_BASE_URL={{baseUrl}}/v1",
    },
    {
      id: "curl-responses",
      title: "curl (Responses API)",
      kind: "curl",
      language: "bash",
      description: "Create a response.",
      template:
        'curl -s {{baseUrl}}/v1/responses \\\n  -H "Authorization: Bearer {{token}}" \\\n  -H "Content-Type: application/json" \\\n  -d \'{"model":"gpt-5-mini","input":"Hello"}\'',
    },
  ],
};
