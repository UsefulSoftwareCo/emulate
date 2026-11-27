import { randomBytes } from "crypto";

/**
 * Approximate token count: one token per four characters of text, rounded up,
 * counted over every text part. A fixed, documented function, so the same text
 * always counts the same in the response and in the ledger. It is not
 * OpenAI's tokenizer, and the manifest says so.
 */
export function approxTokens(...texts: Array<string | null | undefined>): number {
  return tokensOfTexts(texts);
}

/** approxTokens over a list of any length (no argument spread, no per-character array). */
export function tokensOfTexts(texts: Iterable<string | null | undefined>): number {
  let chars = 0;
  for (const t of texts) if (t) chars += codePoints(t);
  return Math.ceil(chars / 4);
}

/** Characters as code points, counted without building an array of them. */
function codePoints(text: string): number {
  let pairs = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        pairs++;
        i++;
      }
    }
  }
  return text.length - pairs;
}

/** A text-only conversation, as the emulator sees a request's input. */
export interface Conversation {
  instructions: string | null;
  messages: Array<{ role: string; text: string }>;
}

export class UnsupportedInput extends Error {
  constructor(
    message: string,
    readonly param: string,
  ) {
    super(message);
  }
}

function textOfParts(parts: unknown, param: string, allowed: string[]): string {
  if (typeof parts === "string") return parts;
  if (!Array.isArray(parts)) throw new UnsupportedInput(`Invalid type for '${param}'.`, param);
  return parts
    .map((part, i) => {
      const p = part as Record<string, unknown>;
      if (!p || typeof p !== "object" || typeof p.type !== "string") {
        throw new UnsupportedInput(`Invalid content part at '${param}[${i}]'.`, `${param}[${i}]`);
      }
      if (!allowed.includes(p.type)) {
        throw new UnsupportedInput(
          `Content of type '${p.type}' is not supported by this emulator (text only).`,
          `${param}[${i}].type`,
        );
      }
      return typeof p.text === "string" ? p.text : "";
    })
    .join("");
}

/** Responses API `input`: a string, or a list of message items with text content. */
export function conversationFromResponsesInput(input: unknown, instructions: unknown): Conversation {
  const conv: Conversation = {
    instructions: typeof instructions === "string" ? instructions : null,
    messages: [],
  };
  if (typeof input === "string") {
    conv.messages.push({ role: "user", text: input });
    return conv;
  }
  if (!Array.isArray(input)) throw new UnsupportedInput("Invalid type for 'input'.", "input");
  input.forEach((item, i) => {
    const it = item as Record<string, unknown>;
    if (!it || typeof it !== "object") throw new UnsupportedInput(`Invalid item at 'input[${i}]'.`, `input[${i}]`);
    const type = typeof it.type === "string" ? it.type : "message";
    if (type !== "message") {
      throw new UnsupportedInput(
        `Input items of type '${type}' are not supported by this emulator (messages only).`,
        `input[${i}].type`,
      );
    }
    const role = typeof it.role === "string" ? it.role : "";
    if (!["user", "assistant", "system", "developer"].includes(role)) {
      throw new UnsupportedInput(`Invalid value for 'input[${i}].role'.`, `input[${i}].role`);
    }
    conv.messages.push({
      role,
      text: textOfParts(it.content, `input[${i}].content`, ["input_text", "output_text", "text"]),
    });
  });
  return conv;
}

/** Chat Completions `messages`: text content only. */
export function conversationFromChatMessages(messages: unknown): Conversation {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new UnsupportedInput("'messages' must be a non-empty array.", "messages");
  }
  const conv: Conversation = { instructions: null, messages: [] };
  messages.forEach((m, i) => {
    const msg = m as Record<string, unknown>;
    const role = typeof msg?.role === "string" ? msg.role : "";
    if (!["system", "developer", "user", "assistant"].includes(role)) {
      throw new UnsupportedInput(
        `Messages with role '${role}' are not supported by this emulator.`,
        `messages[${i}].role`,
      );
    }
    conv.messages.push({
      role,
      text: msg.content == null ? "" : textOfParts(msg.content, `messages[${i}].content`, ["text"]),
    });
  });
  return conv;
}

export function inputTokens(conv: Conversation): number {
  return tokensOfTexts([conv.instructions, ...conv.messages.map((m) => m.text)]);
}

export function lastUserText(conv: Conversation): string {
  for (let i = conv.messages.length - 1; i >= 0; i--) {
    if (conv.messages[i]!.role === "user") return conv.messages[i]!.text;
  }
  return "";
}

/** Ids in OpenAI's shapes: a prefix and 48 hex characters (`resp_`, `msg_`), or `chatcmpl-` and 29 characters. */
export function openaiId(prefix: "resp_" | "msg_" | "req_"): string {
  return prefix + randomBytes(24).toString("hex");
}

export function chatCompletionId(): string {
  return "chatcmpl-" + randomBytes(22).toString("base64url").slice(0, 29);
}

/** Split text into exactly `n` non-empty pieces, as evenly as code points allow. */
export function splitInto(text: string, n: number): string[] {
  const chars = [...text];
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < n; i++) {
    const end = Math.round(((i + 1) * chars.length) / n);
    out.push(chars.slice(start, end).join(""));
    start = end;
  }
  return out;
}

/** Natural streaming pieces for an unpaced answer: words with their following space. */
export function naturalPieces(text: string): string[] {
  const pieces = text.match(/\S+\s*|\s+/g) ?? [];
  return pieces.length > 0 ? pieces : [text];
}

/** Truncate to at most `tokens` approximate tokens (four characters each). */
export function truncateToTokens(text: string, tokens: number): string {
  return [...text].slice(0, Math.max(0, tokens) * 4).join("");
}
