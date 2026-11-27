import type { Store } from "@emulators/core";
import { getOpenAIStore, type AnswerSpec, type OpenAIRule } from "./store.js";
import { lastUserText, type Conversation } from "./text.js";

/** The longest pacing the emulator accepts: 10,000 chunks, 60 s apart. */
export const MAX_CHUNKS = 10000;
export const MAX_INTERVAL_MS = 60000;

export function validateAnswer(raw: unknown, where: string): AnswerSpec {
  const a = (typeof raw === "string" ? { text: raw } : raw) as Record<string, unknown> | undefined;
  if (!a || typeof a !== "object" || typeof a.text !== "string") {
    throw new Error(`${where} must be a string or { text, stream?: { chunks, interval_ms } }.`);
  }
  const out: AnswerSpec = { text: a.text };
  if (a.stream !== undefined) {
    const s = a.stream as Record<string, unknown>;
    const chunks = s?.chunks;
    const interval = s?.interval_ms ?? 0;
    if (!Number.isInteger(chunks) || (chunks as number) < 1 || (chunks as number) > MAX_CHUNKS) {
      throw new Error(`${where}.stream.chunks must be an integer from 1 to ${MAX_CHUNKS}.`);
    }
    if (!Number.isInteger(interval) || (interval as number) < 0 || (interval as number) > MAX_INTERVAL_MS) {
      throw new Error(`${where}.stream.interval_ms must be an integer from 0 to ${MAX_INTERVAL_MS}.`);
    }
    if ([...a.text].length < (chunks as number)) {
      throw new Error(`${where}.text must have at least stream.chunks characters, so every chunk carries text.`);
    }
    out.stream = { chunks: chunks as number, interval_ms: interval as number };
  }
  return out;
}

export interface RuleInput {
  match?: OpenAIRule["match"];
  answer: unknown;
  times?: number;
}

export function addRule(store: Store, raw: RuleInput, where = "rule"): OpenAIRule {
  const os = getOpenAIStore(store);
  const m = (raw.match ?? {}) as Record<string, unknown>;
  const match: OpenAIRule["match"] = {};
  for (const k of ["model", "contains", "last_user_equals", "instructions_contains"] as const) {
    if (m[k] !== undefined) {
      if (typeof m[k] !== "string") throw new Error(`${where}.match.${k} must be a string.`);
      match[k] = m[k] as string;
    }
  }
  if (raw.times !== undefined && (!Number.isInteger(raw.times) || raw.times < 1)) {
    throw new Error(`${where}.times must be a positive integer.`);
  }
  const position = os.rules.all().reduce((n, r) => Math.max(n, r.position), 0) + 1;
  return os.rules.insert({
    position,
    match,
    answer: validateAnswer(raw.answer, `${where}.answer`),
    remaining: raw.times ?? null,
  });
}

export function enqueueAnswers(store: Store, answers: unknown[]): number {
  const os = getOpenAIStore(store);
  let position = os.queue.all().reduce((n, q) => Math.max(n, q.position), 0);
  const specs = answers.map((a, i) => validateAnswer(a, `answers[${i}]`));
  for (const answer of specs) os.queue.insert({ position: ++position, answer });
  return os.queue.all().length;
}

function matches(rule: OpenAIRule, model: string, conv: Conversation): boolean {
  const m = rule.match;
  const all = [conv.instructions ?? "", ...conv.messages.map((x) => x.text)].join("\n");
  if (m.model !== undefined && m.model !== model) return false;
  if (m.contains !== undefined && !all.includes(m.contains)) return false;
  if (m.last_user_equals !== undefined && lastUserText(conv) !== m.last_user_equals) return false;
  if (m.instructions_contains !== undefined && !(conv.instructions ?? "").includes(m.instructions_contains)) {
    return false;
  }
  return true;
}

/** The fixed answer when nothing is queued and no rule matches: a function of the model and the prompt. */
export function defaultAnswer(model: string, conv: Conversation): string {
  const last = lastUserText(conv).replace(/\s+/g, " ").trim();
  const quoted = [...last].length > 200 ? [...last].slice(0, 200).join("") + "..." : last;
  return `Emulated response from ${model} to: ${quoted || "(empty input)"}`;
}

/** Choose the answer: the queue first, then the first matching rule, then the default. */
export function chooseAnswer(store: Store, model: string, conv: Conversation): AnswerSpec & { source: string } {
  const os = getOpenAIStore(store);
  const next = os.queue.all().sort((a, b) => a.position - b.position)[0];
  if (next) {
    os.queue.delete(next.id);
    return { ...next.answer, source: "queue" };
  }
  for (const rule of os.rules.all().sort((a, b) => a.position - b.position)) {
    if (!matches(rule, model, conv)) continue;
    if (rule.remaining !== null) {
      if (rule.remaining <= 1) os.rules.delete(rule.id);
      else os.rules.update(rule.id, { remaining: rule.remaining - 1 });
    }
    return { ...rule.answer, source: `rule ${rule.position}` };
  }
  return { text: defaultAnswer(model, conv), source: "default" };
}
