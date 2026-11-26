import { createHash, createHmac } from "crypto";
import type { Store } from "@emulators/core";
import { getZapierStore, type ExplicitTool, type ZapierToolSpec } from "./store.js";

/**
 * Tools in Zapier's managed mode are one per action the person enabled. Zapier
 * does not document the tool names or schemas it sends, so the emulator's are
 * its own: `{app}_{verb}_{object}` with a short suffix for uniqueness, an
 * `instructions` string plus a few fields, all computed from a seed string so
 * the same seed gives the same tools on every instance and after eviction.
 */
export interface Tool {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: Record<string, unknown>;
}

const APPS = [
  "slack",
  "gmail",
  "google_sheets",
  "google_calendar",
  "google_drive",
  "notion",
  "trello",
  "asana",
  "jira",
  "github",
  "hubspot",
  "salesforce",
  "airtable",
  "dropbox",
  "zoom",
  "microsoft_teams",
  "outlook",
  "shopify",
  "stripe",
  "mailchimp",
  "zendesk",
  "intercom",
  "monday",
  "clickup",
  "todoist",
  "discord",
  "twilio",
  "calendly",
  "typeform",
  "linear",
  "pipedrive",
  "quickbooks",
  "xero",
  "box",
  "onedrive",
  "confluence",
  "freshdesk",
  "webflow",
];
const ACTIONS: Array<[verb: string, object: string, read: boolean]> = [
  ["send", "message", false],
  ["find", "message", true],
  ["create", "record", false],
  ["update", "record", false],
  ["find", "record", true],
  ["create", "task", false],
  ["find", "task", true],
  ["add", "comment", false],
  ["create", "event", false],
  ["find", "event", true],
  ["upload", "file", false],
  ["find", "file", true],
  ["create", "contact", false],
  ["find", "contact", true],
  ["update", "contact", false],
  ["create", "invoice", false],
  ["find", "invoice", true],
  ["add", "row", false],
  ["lookup", "row", true],
  ["create", "draft", false],
];
const FIELD_NAMES = [
  "channel",
  "recipient",
  "subject",
  "body",
  "title",
  "due_date",
  "status",
  "owner",
  "amount",
  "folder",
];

function hashInt(...parts: Array<string | number>): number {
  return createHash("sha256").update(parts.join("\u0000")).digest().readUInt32BE(0);
}

function words(s: string): string {
  return s.replace(/_/g, " ").replace(/\b\w/g, (m) => m.toUpperCase());
}

/** The i-th generated tool for a seed: a pure function of (seed, i). */
export function generatedTool(seed: string, i: number): Tool {
  const app = APPS[hashInt(seed, i, "app") % APPS.length]!;
  const [verb, object, read] = ACTIONS[hashInt(seed, i, "action") % ACTIONS.length]!;
  const name = `${app}_${verb}_${object}_${i.toString(36).padStart(3, "0")}`;
  const fieldCount = 2 + (hashInt(seed, i, "fields") % 3);
  const properties: Record<string, unknown> = {
    instructions: {
      type: "string",
      description: `Instructions for running this action, in plain language.`,
    },
  };
  for (let f = 0; f < fieldCount; f++) {
    const field = FIELD_NAMES[hashInt(seed, i, "field", f) % FIELD_NAMES.length]!;
    properties[field] = { type: "string", description: `${words(field)} for the ${words(object).toLowerCase()}.` };
  }
  return {
    name,
    title: `${words(app)}: ${words(verb)} ${words(object)}`,
    description: `${words(verb)} a ${object} in ${words(app)}. Runs through the account's ${words(app)} connection.`,
    inputSchema: { type: "object", properties, required: ["instructions"] },
    annotations: { readOnlyHint: read, destructiveHint: false, openWorldHint: true },
  };
}

function fromExplicit(t: ExplicitTool): Tool {
  return {
    name: t.name,
    title: t.title ?? words(t.name),
    description: t.description ?? `Emulated tool ${t.name}.`,
    inputSchema: t.inputSchema ?? { type: "object", properties: { instructions: { type: "string" } } },
    annotations: t.annotations ?? {},
  };
}

/** Indexes of generated tools the spec removed, read from the names (which carry their index). */
function removedIndexes(spec: ZapierToolSpec): Set<number> {
  const out = new Set<number>();
  if (!spec.generated) return out;
  for (const name of spec.removed) {
    const m = /_([0-9a-z]{3,})$/.exec(name);
    if (!m) continue;
    const i = parseInt(m[1]!, 36);
    if (i < spec.generated.count && generatedTool(spec.generated.seed, i).name === name) out.add(i);
  }
  return out;
}

/** How many tools the account currently has. */
export function toolCount(spec: ZapierToolSpec | undefined): number {
  if (!spec) return 0;
  const removed = new Set(spec.removed);
  const explicit = spec.explicit.filter((e) => !removed.has(e.name)).length;
  return (spec.generated?.count ?? 0) - removedIndexes(spec).size + explicit;
}

/**
 * Tools `offset` to `offset + limit` of the account's list, in its fixed order:
 * generated tools, then explicit ones, with edits applied. Only the requested
 * tools are computed, so a page of a 3,000-tool list costs a page, not a list.
 */
export function toolsSlice(spec: ZapierToolSpec | undefined, offset: number, limit: number): Tool[] {
  if (!spec) return [];
  const out: Tool[] = [];
  const removedIdx = removedIndexes(spec);
  const count = spec.generated?.count ?? 0;
  let position = 0;
  for (let i = 0; i < count && out.length < limit; i++) {
    if (removedIdx.has(i)) continue;
    if (position++ < offset) continue;
    out.push(applyRename(generatedTool(spec.generated!.seed, i), spec.renamed));
  }
  const removed = new Set(spec.removed);
  for (const e of spec.explicit) {
    if (out.length >= limit) break;
    if (removed.has(e.name)) continue;
    if (position++ < offset) continue;
    out.push(applyRename(fromExplicit(e), spec.renamed));
  }
  return out;
}

/** The account's whole current list. */
export function currentTools(spec: ZapierToolSpec | undefined): Tool[] {
  return toolsSlice(spec, 0, Number.MAX_SAFE_INTEGER);
}

function applyRename(t: Tool, renamed: Record<string, string>): Tool {
  const to = renamed[t.name];
  return to ? { ...t, name: to } : t;
}

/** Find one tool in the account's current list (never another account's). */
export function findTool(spec: ZapierToolSpec | undefined, name: string): Tool | undefined {
  if (!spec) return undefined;
  // Generated names carry their index, so a lookup does not rebuild the list.
  // A renamed tool answers only to its new name.
  const reverse = new Map(Object.entries(spec.renamed).map(([from, to]) => [to, from]));
  const original = reverse.get(name) ?? (Object.prototype.hasOwnProperty.call(spec.renamed, name) ? null : name);
  if (original === null || spec.removed.includes(original)) return undefined;
  const m = /_([0-9a-z]{3,})$/.exec(original);
  if (spec.generated && m) {
    const i = parseInt(m[1]!, 36);
    if (i < spec.generated.count) {
      const t = generatedTool(spec.generated.seed, i);
      if (t.name === original) return applyRename(t, spec.renamed);
    }
  }
  const e = spec.explicit.find((x) => x.name === original);
  return e ? applyRename(fromExplicit(e), spec.renamed) : undefined;
}

// ---------------------------------------------------------------------------
// Cursors: opaque, signed, and bound to the account and the list version.

function cursorKey(store: Store): string {
  let key = store.getData<string>("zapier.cursor_key");
  if (!key) {
    key = createHash("sha256").update(`zapier-cursor:${Date.now()}:${Math.random()}`).digest("hex");
    store.setData("zapier.cursor_key", key);
  }
  return key;
}

export function encodeCursor(store: Store, email: string, version: number, offset: number): string {
  const body = Buffer.from(JSON.stringify({ v: version, o: offset })).toString("base64url");
  const sig = createHmac("sha256", cursorKey(store)).update(`${email}|${body}`).digest("base64url").slice(0, 22);
  return `${body}.${sig}`;
}

/** The offset a cursor points at, or why it is no longer valid. */
export function decodeCursor(
  store: Store,
  email: string,
  version: number,
  cursor: string,
): { offset: number } | { error: string } {
  const [body, sig] = cursor.split(".");
  if (!body || !sig) return { error: "Invalid cursor." };
  const expected = createHmac("sha256", cursorKey(store)).update(`${email}|${body}`).digest("base64url").slice(0, 22);
  if (sig !== expected) return { error: "Invalid cursor." };
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString()) as { v: number; o: number };
    if (p.v !== version)
      return { error: "Invalid cursor: the tool list changed since it was issued; list again from the start." };
    if (!Number.isInteger(p.o) || p.o < 0) return { error: "Invalid cursor." };
    return { offset: p.o };
  } catch {
    return { error: "Invalid cursor." };
  }
}

// ---------------------------------------------------------------------------
// Results

function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v as object)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v ?? null);
}

/** A call's result: a fixed function of the account, the tool and its arguments. */
export function callResult(email: string, tool: Tool, args: Record<string, unknown>, resultBytes: number) {
  const id = createHash("sha256")
    .update(`${email}|${tool.name}|${canonical(args)}`)
    .digest("hex")
    .slice(0, 16);
  const structured: Record<string, unknown> = {
    status: "success",
    tool: tool.name,
    result_id: `run_${id}`,
    summary: `${tool.title} ran for ${email}.`,
  };
  if (resultBytes > 0) {
    const unit = `${id} `;
    structured.data = unit.repeat(Math.ceil(resultBytes / unit.length)).slice(0, resultBytes);
  }
  const text = JSON.stringify(structured);
  return { content: [{ type: "text", text }], structuredContent: structured, isError: false };
}
