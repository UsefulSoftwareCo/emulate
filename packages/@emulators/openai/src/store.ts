import { Store, type Collection, type Entity } from "@emulators/core";

/** An API key. Requests authenticate with `Authorization: Bearer <key>`. */
export interface OpenAIKey extends Entity {
  key: string;
  /** Stable id recorded on ledger entries (`key_...`); the key itself never is. */
  key_id: string;
  name: string;
  /** Per-key request limit; null for none. */
  rate_limit: { requests: number; window_seconds: number } | null;
}

/** A model `GET /v1/models` lists. With none seeded, any model id is accepted. */
export interface OpenAIModel extends Entity {
  model_id: string;
  owned_by: string;
  created: number;
}

/** How a streamed answer is paced: exactly `chunks` deltas, `interval_ms` apart. */
export interface StreamPacing {
  chunks: number;
  interval_ms: number;
}

/** What to answer. `text` is the whole output; `stream` paces it when the request streams. */
export interface AnswerSpec {
  text: string;
  stream?: StreamPacing;
}

/** A seeded answer rule; the first rule whose every given condition matches wins. */
export interface OpenAIRule extends Entity {
  position: number;
  match: {
    model?: string;
    contains?: string;
    last_user_equals?: string;
    instructions_contains?: string;
  };
  answer: AnswerSpec;
  /** Times left to apply, or null for always. */
  remaining: number | null;
}

/** An answer queued for the next request, used before any rule. */
export interface OpenAIQueued extends Entity {
  position: number;
  answer: AnswerSpec;
}

/** One model call, for tests that count calls and tokens. */
export interface OpenAIUsage extends Entity {
  request_id: string;
  operation: "responses.create" | "chat.completions.create";
  key_id: string;
  key_name: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  streamed: boolean;
  request_bytes: number;
  status: "completed" | "incomplete";
  /** Unix seconds. */
  called_at: number;
}

/** A fixed request window for one key. */
export interface OpenAIRateWindow extends Entity {
  key_id: string;
  limit: number;
  used: number;
  reset_at_ms: number;
}

export interface OpenAIStore {
  keys: Collection<OpenAIKey>;
  models: Collection<OpenAIModel>;
  rules: Collection<OpenAIRule>;
  queue: Collection<OpenAIQueued>;
  usage: Collection<OpenAIUsage>;
  rateWindows: Collection<OpenAIRateWindow>;
}

export function getOpenAIStore(store: Store): OpenAIStore {
  return {
    keys: store.collection<OpenAIKey>("openai.api_keys", ["key", "key_id", "name"]),
    models: store.collection<OpenAIModel>("openai.models", ["model_id"]),
    rules: store.collection<OpenAIRule>("openai.answer_rules", []),
    queue: store.collection<OpenAIQueued>("openai.answer_queue", []),
    usage: store.collection<OpenAIUsage>("openai.usage", ["key_id", "request_id"]),
    rateWindows: store.collection<OpenAIRateWindow>("openai.rate_windows", ["key_id"]),
  };
}
