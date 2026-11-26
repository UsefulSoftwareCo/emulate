import type { Context, RouteContext } from "@emulators/core";
import { addRule, enqueueAnswers, type RuleInput } from "../answers.js";
import { resetKeyWindow, upsertKey, type KeyInput } from "../keys.js";
import { getOpenAIStore } from "../store.js";

/**
 * Emulator controls under `/_emulate/openai`: keys and their limits, the answer
 * queue and rules, and the usage record. Not OpenAI routes; they stay out of
 * the provider ledger like the rest of `/_emulate`.
 */
export function controlRoutes({ app, store }: RouteContext): void {
  const os = getOpenAIStore(store);
  const bad = (c: Context, message: string, status: 400 | 404 = 400) =>
    c.json({ error: status === 404 ? "not_found" : "invalid_request", message }, status);
  const body = async (c: Context) => (await c.req.json().catch(() => ({}))) as Record<string, unknown>;

  /** POST /_emulate/openai/keys: { name, key?, rate_limit?: { requests, window_seconds } | null } */
  app.post("/_emulate/openai/keys", async (c) => {
    try {
      const key = upsertKey(store, (await body(c)) as unknown as KeyInput, "body");
      resetKeyWindow(store, key.key_id);
      return c.json({ name: key.name, key: key.key, key_id: key.key_id, rate_limit: key.rate_limit });
    } catch (err) {
      return bad(c, err instanceof Error ? err.message : "Invalid key.");
    }
  });

  app.get("/_emulate/openai/keys", (c) =>
    c.json({ keys: os.keys.all().map((k) => ({ name: k.name, key_id: k.key_id, rate_limit: k.rate_limit })) }),
  );

  /** POST /_emulate/openai/keys/:name/rate-limit: { requests, window_seconds }, or null to remove. */
  app.post("/_emulate/openai/keys/:name/rate-limit", async (c) => {
    const key = os.keys.findOneBy("name", c.req.param("name"));
    if (!key) return bad(c, `No key named ${c.req.param("name")}.`, 404);
    const raw = await c.req.json().catch(() => null);
    try {
      const updated = upsertKey(store, { name: key.name, rate_limit: raw as KeyInput["rate_limit"] }, "body");
      resetKeyWindow(store, key.key_id);
      return c.json({ name: updated.name, key_id: updated.key_id, rate_limit: updated.rate_limit });
    } catch (err) {
      return bad(c, err instanceof Error ? err.message : "Invalid rate limit.");
    }
  });

  /** POST /_emulate/openai/answers/queue: { answers: [text | { text, stream?: { chunks, interval_ms } }] } */
  app.post("/_emulate/openai/answers/queue", async (c) => {
    const b = await body(c);
    if (!Array.isArray(b.answers)) return bad(c, "`answers` must be an array.");
    try {
      return c.json({ queued: enqueueAnswers(store, b.answers) });
    } catch (err) {
      return bad(c, err instanceof Error ? err.message : "Invalid answers.");
    }
  });
  app.delete("/_emulate/openai/answers/queue", (c) => {
    os.queue.clear();
    return c.json({ queued: 0 });
  });

  /** POST /_emulate/openai/answers/rules: { match?, answer, times? }; appended after existing rules. */
  app.post("/_emulate/openai/answers/rules", async (c) => {
    try {
      const rule = addRule(store, (await body(c)) as unknown as RuleInput, "body");
      return c.json({ rule });
    } catch (err) {
      return bad(c, err instanceof Error ? err.message : "Invalid rule.");
    }
  });
  app.get("/_emulate/openai/answers", (c) =>
    c.json({
      queue: os.queue.all().sort((a, b) => a.position - b.position),
      rules: os.rules.all().sort((a, b) => a.position - b.position),
    }),
  );
  app.delete("/_emulate/openai/answers/rules", (c) => {
    os.rules.clear();
    return c.json({ rules: 0 });
  });

  /**
   * GET /_emulate/openai/usage?key_id=&key_name=: one record per model call, with
   * the key, model, approximate token counts, whether it streamed and the
   * request size, plus totals.
   */
  app.get("/_emulate/openai/usage", (c) => {
    const keyId = c.req.query("key_id");
    const keyName = c.req.query("key_name");
    const calls = os.usage
      .all()
      .filter((u) => (!keyId || u.key_id === keyId) && (!keyName || u.key_name === keyName))
      .sort((a, b) => a.id - b.id);
    const sum = (f: "input_tokens" | "output_tokens" | "total_tokens") => calls.reduce((n, u) => n + u[f], 0);
    return c.json({
      calls,
      totals: {
        calls: calls.length,
        input_tokens: sum("input_tokens"),
        output_tokens: sum("output_tokens"),
        total_tokens: sum("total_tokens"),
      },
    });
  });
}
