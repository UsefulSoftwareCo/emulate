import { createHash, randomBytes } from "crypto";
import type { Store } from "@emulators/core";
import { getOpenAIStore, type OpenAIKey } from "./store.js";

export interface KeyInput {
  name: string;
  key?: string;
  rate_limit?: { requests: number; window_seconds: number } | null;
}

function validLimit(raw: unknown, where: string): OpenAIKey["rate_limit"] {
  if (raw === undefined || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (!Number.isInteger(r.requests) || (r.requests as number) < 0) {
    throw new Error(`${where}.requests must be an integer >= 0.`);
  }
  if (!Number.isInteger(r.window_seconds) || (r.window_seconds as number) < 1) {
    throw new Error(`${where}.window_seconds must be an integer >= 1.`);
  }
  return { requests: r.requests as number, window_seconds: r.window_seconds as number };
}

/** Create or update a key by name. A new key without a value gets one in OpenAI's `sk-proj-` form. */
export function upsertKey(store: Store, raw: KeyInput, where = "api_keys[]"): OpenAIKey {
  const os = getOpenAIStore(store);
  if (!raw || typeof raw.name !== "string" || !raw.name) throw new Error(`${where}.name is required.`);
  const rate_limit = validLimit(raw.rate_limit, `${where}.rate_limit`);
  const existing = os.keys.findOneBy("name", raw.name);
  if (existing) {
    return os.keys.update(existing.id, {
      rate_limit: raw.rate_limit === undefined ? existing.rate_limit : rate_limit,
      ...(raw.key ? { key: raw.key } : {}),
    })!;
  }
  const key = raw.key ?? `sk-proj-${randomBytes(36).toString("base64url")}`;
  if (os.keys.findOneBy("key", key)) throw new Error(`${where}.key is already in use.`);
  return os.keys.insert({
    key,
    key_id: "key_" + createHash("sha256").update(key).digest("hex").slice(0, 24),
    name: raw.name,
    rate_limit,
  });
}

/** Forget a key's open window, so a changed limit applies from now. */
export function resetKeyWindow(store: Store, keyId: string): void {
  const os = getOpenAIStore(store);
  for (const w of os.rateWindows.findBy("key_id", keyId)) os.rateWindows.delete(w.id);
}
