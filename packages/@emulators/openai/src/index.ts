import type { CredentialRequest, IssuedCredential, RouteContext, ServicePlugin, Store } from "@emulators/core";
import { addRule, enqueueAnswers, type RuleInput } from "./answers.js";
import { upsertKey, type KeyInput } from "./keys.js";
import { getOpenAIStore } from "./store.js";
import { responsesRoutes } from "./routes/responses.js";
import { chatRoutes } from "./routes/chat.js";
import { modelRoutes } from "./routes/models.js";
import { controlRoutes } from "./routes/control.js";

export { getOpenAIStore, type OpenAIStore } from "./store.js";
export type * from "./store.js";
export { approxTokens } from "./text.js";
export { manifest } from "./manifest.js";

export interface OpenAISeedConfig {
  /** API keys by name; a key without a value gets one in `sk-proj-` form. */
  api_keys?: KeyInput[];
  /** Models GET /v1/models lists. With none, requests may name any model. */
  models?: Array<{ id: string; owned_by?: string; created?: number }>;
  /** Answer rules, first match wins: { match?: { model?, contains?, last_user_equals?, instructions_contains? }, answer, times? }. */
  answer_rules?: RuleInput[];
  /** Answers for the next requests, in order, before any rule. */
  answer_queue?: unknown[];
}

export function seedFromConfig(store: Store, _baseUrl: string, config: OpenAISeedConfig): void {
  const os = getOpenAIStore(store);
  (config.api_keys ?? []).forEach((k, i) => upsertKey(store, k, `api_keys[${i}]`));
  for (const m of config.models ?? []) {
    if (!m || typeof m.id !== "string") throw new Error("models[].id is required.");
    if (os.models.findOneBy("model_id", m.id)) continue;
    os.models.insert({ model_id: m.id, owned_by: m.owned_by ?? "openai", created: m.created ?? 1700000000 });
  }
  (config.answer_rules ?? []).forEach((r, i) => addRule(store, r, `answer_rules[${i}]`));
  if (config.answer_queue) enqueueAnswers(store, config.answer_queue);
}

/**
 * `POST /_emulate/credentials` for OpenAI: an API key, stored with the
 * instance (so a hosted instance keeps it across eviction). `name` labels it in
 * the ledger; `token` sets its value.
 */
export function issueCredential(store: Store, _baseUrl: string, request: CredentialRequest): IssuedCredential {
  const type = request.type ?? "api-key";
  if (type !== "api-key" && type !== "bearer-token")
    throw new Error(`Credential type ${type} is not supported by openai`);
  const os = getOpenAIStore(store);
  const name = request.name ?? request.login ?? `key-${os.keys.all().length + 1}`;
  const key = upsertKey(
    store,
    { name, key: typeof request.token === "string" ? request.token : undefined },
    "credential",
  );
  return {
    type: "api-key",
    token: key.key,
    login: key.name,
    scopes: [],
    notes:
      "Send as Authorization: Bearer <token> to <base>/v1. Set a per-key limit with POST /_emulate/openai/keys/<name>/rate-limit.",
  };
}

/** The default instance: one key, so a fresh local emulator is usable at once. */
export const DEFAULT_API_KEY = "sk-proj-emulate-default-key";

export const openaiPlugin: ServicePlugin = {
  name: "openai",
  register(app, store, webhooks, baseUrl, tokenMap): void {
    const ctx: RouteContext = { app, store, webhooks, baseUrl, tokenMap };
    controlRoutes(ctx);
    responsesRoutes(ctx);
    chatRoutes(ctx);
    modelRoutes(ctx);
  },
  seed(store, baseUrl): void {
    seedFromConfig(store, baseUrl, { api_keys: [{ name: "default", key: DEFAULT_API_KEY }] });
  },
};

export default openaiPlugin;
