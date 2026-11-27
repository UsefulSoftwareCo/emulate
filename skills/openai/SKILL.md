---
name: openai
description: Emulated OpenAI API for local development and testing. Use when the user needs the Responses API or Chat Completions for text, streamed or not, with API keys, deterministic answers, per-key rate limits, or a count of model calls, without calling real OpenAI.
allowed-tools: Bash(npx emulate:*), Bash(curl:*)
---

# OpenAI Emulator

Text-model emulation of the OpenAI API: `POST /v1/responses`, `POST /v1/chat/completions` and `GET /v1/models`, with deterministic answers.

## Start

```bash
npx emulate --service openai
```

When all services run together, OpenAI uses `http://localhost:4022`.

## Connect

```ts
import OpenAI from "openai";
const client = new OpenAI({ apiKey: "sk-proj-emulate-default-key", baseURL: `${process.env.OPENAI_EMULATOR_URL}/v1` });
const r = await client.responses.create({ model: "gpt-5-mini", input: "Hello" });
```

Create more keys with `POST /_emulate/openai/keys {"name":"primary"}` or `POST /_emulate/credentials {"type":"api-key","name":"primary"}`.

## Deterministic answers

```bash
# Queue the next answers exactly
curl -X POST "$OPENAI_EMULATOR_URL/_emulate/openai/answers/queue" -H "Content-Type: application/json" \
  -d '{"answers":["First answer","Second answer"]}'

# A rule: first match wins; stream paces a streamed answer
curl -X POST "$OPENAI_EMULATOR_URL/_emulate/openai/answers/rules" -H "Content-Type: application/json" \
  -d '{"match":{"last_user_equals":"slow"},"answer":{"text":"'"$(printf 'x%.0s' $(seq 600))"'","stream":{"chunks":600,"interval_ms":500}}}'
```

With nothing queued and no rule, the answer is `Emulated response from <model> to: <last user message>`.

## Limits and usage

```bash
# One key answers 429 with Retry-After; others go on
curl -X POST "$OPENAI_EMULATOR_URL/_emulate/openai/keys/primary/rate-limit" -H "Content-Type: application/json" \
  -d '{"requests":2,"window_seconds":60}'

# Every call: key, model, approximate tokens (four characters each), streamed, request size
curl "$OPENAI_EMULATOR_URL/_emulate/openai/usage"
```

## Discovery

`GET /_emulate/manifest` lists what is supported, partial and unsupported (tools, images, audio, embeddings, stored responses and Realtime are not emulated). `GET /_emulate/ledger` records each call with its operation id, status and key name; request bodies over 64 KiB are recorded by size only. Per-service docs live at `https://docs.emulators.dev/openai`.
