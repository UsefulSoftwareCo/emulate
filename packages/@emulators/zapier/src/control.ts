import { createHash } from "crypto";
import type { Context, RequestLedger, RouteContext, Store } from "@emulators/core";
import { currentTools, generatedTool } from "./catalog.js";
import { notifyListChanged } from "./mcp.js";
import { regenerateConnectionToken } from "./oauth.js";
import {
  getSettings,
  getZapierStore,
  setSettings,
  type ExplicitTool,
  type ZapierSettings,
  type ZapierToolSpec,
} from "./store.js";

/**
 * Emulator controls under /_emulate/zapier. Two are the emulator's own and not
 * Zapier's, and say so in their responses: the list_changed switch and the
 * per-account rate limit.
 */

export interface AccountInput {
  email: string;
  name?: string;
  /** count generated tools from seed (default: the email), and/or explicit tools. */
  tools?: { count?: number; seed?: string; explicit?: ExplicitTool[] };
  behaviors?: BehaviorInput[];
}

export interface BehaviorInput {
  tool: string;
  delay_ms?: number;
  fail?: "tool" | "protocol" | null;
  result_bytes?: number;
}

const EMULATOR_ONLY = "Emulator control, not Zapier behaviour: Zapier documents no such setting.";

export function upsertAccount(store: Store, a: AccountInput, where = "accounts[]"): void {
  const zs = getZapierStore(store);
  if (!a || typeof a.email !== "string" || !a.email.includes("@")) throw new Error(`${where}.email is required.`);
  const email = a.email.toLowerCase();
  if (!zs.accounts.findOneBy("email", email)) {
    zs.accounts.insert({
      email,
      name: a.name ?? email.split("@")[0]!,
      account_id: String(BigInt("0x" + createHash("sha256").update(email).digest("hex").slice(0, 12))),
    });
  }
  if (a.tools) {
    const count = a.tools.count ?? 0;
    if (!Number.isInteger(count) || count < 0 || count > 100000)
      throw new Error(`${where}.tools.count must be 0 to 100000.`);
    const spec = zs.toolSpecs.findOneBy("email", email);
    const fields = {
      generated: count > 0 ? { count, seed: a.tools.seed ?? email } : null,
      explicit: a.tools.explicit ?? [],
      removed: [],
      renamed: {},
    };
    if (spec) zs.toolSpecs.update(spec.id, { ...fields, version: spec.version + 1 });
    else zs.toolSpecs.insert({ email, ...fields, version: 1 });
  }
  for (const b of a.behaviors ?? []) setBehavior(store, email, b);
}

export function setBehavior(store: Store, email: string, b: BehaviorInput): void {
  const zs = getZapierStore(store);
  if (!b || typeof b.tool !== "string") throw new Error("behavior.tool is required.");
  if (b.fail !== undefined && b.fail !== null && b.fail !== "tool" && b.fail !== "protocol") {
    throw new Error('behavior.fail must be "tool", "protocol" or null.');
  }
  const existing = zs.behaviors.findBy("email", email).find((x) => x.tool === b.tool);
  const row = {
    email,
    tool: b.tool,
    delay_ms: Math.max(0, Math.min(600000, b.delay_ms ?? 0)),
    fail: b.fail ?? null,
    result_bytes: Math.max(0, Math.min(16 * 1024 * 1024, b.result_bytes ?? 0)),
  };
  if (existing) zs.behaviors.update(existing.id, row);
  else zs.behaviors.insert(row);
}

/** Record a list change as its own ledger entry, with the account as identity and what changed. */
function ledgerChange(ledger: RequestLedger | undefined, c: Context, email: string, summary: string, details: unknown) {
  if (!ledger) return;
  const url = new URL(c.req.url);
  ledger.add({
    correlationId: `cor_${createHash("sha256").update(`${Date.now()}${Math.random()}`).digest("hex").slice(0, 32)}`,
    timestamp: new Date().toISOString(),
    method: "POST",
    host: url.host,
    path: url.pathname,
    query: url.search,
    route: "/_emulate/zapier/accounts/:email/tools",
    operationId: "zapier.control.tools.change",
    request: { headers: {}, body: details },
    identity: { user: { login: email, id: 0, scopes: [] } },
    response: { status: 200, headers: {} },
    summary: `tool list changed for ${email}: ${summary}`,
    sideEffects: [{ type: "update", collection: "zapier.tool_specs", id: email, summary }],
    webhookDeliveries: [],
    durationMs: 0,
  });
}

export function controlRoutes({ app, store, ledger }: RouteContext): void {
  const zs = () => getZapierStore(store);
  const bad = (c: Context, message: string, status: 400 | 404 = 400) =>
    c.json({ error: status === 404 ? "not_found" : "invalid_request", message }, status);
  const json = async (c: Context) => (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const account = (c: Context) =>
    zs().accounts.findOneBy("email", decodeURIComponent(c.req.param("email") ?? "").toLowerCase());

  app.post("/_emulate/zapier/accounts", async (c) => {
    try {
      const body = (await json(c)) as unknown as AccountInput;
      upsertAccount(store, body, "body");
      return c.json({
        email: body.email.toLowerCase(),
        tools: currentTools(zs().toolSpecs.findOneBy("email", body.email.toLowerCase())).length,
      });
    } catch (err) {
      return bad(c, err instanceof Error ? err.message : "Invalid account.");
    }
  });

  /** A long-lived connection token for the account (Zapier's alternative to OAuth). */
  app.post("/_emulate/zapier/accounts/:email/connection-token", (c) => {
    const a = account(c);
    if (!a) return bad(c, "No such account.", 404);
    const t = regenerateConnectionToken(store, a.email);
    return c.json({ email: a.email, connection_token: t.access_token });
  });

  /**
   * POST /_emulate/zapier/accounts/:email/tools: change one account's list now.
   * { add?: number | ExplicitTool[], remove?: string[] | { count: number }, rename?: { from: to }, replace?: { count, seed? } }
   * Applied in that order (replace first). Recorded in the ledger with what changed.
   */
  app.post("/_emulate/zapier/accounts/:email/tools", async (c) => {
    const a = account(c);
    if (!a) return bad(c, "No such account.", 404);
    const body = await json(c);
    let spec: ZapierToolSpec =
      zs().toolSpecs.findOneBy("email", a.email) ??
      zs().toolSpecs.insert({ email: a.email, generated: null, explicit: [], removed: [], renamed: {}, version: 0 });
    const before = new Set(currentTools(spec).map((t) => t.name));
    const patch: Partial<ZapierToolSpec> = {};
    const replace = body.replace as { count?: number; seed?: string } | undefined;
    if (replace) {
      patch.generated = replace.count
        ? { count: replace.count, seed: replace.seed ?? `${a.email}#${spec.version + 1}` }
        : null;
      patch.explicit = [];
      patch.removed = [];
      patch.renamed = {};
    }
    let working = { ...spec, ...patch };
    if (typeof body.add === "number") {
      const n = body.add;
      const existing = new Set(currentTools(working).map((t) => t.name));
      const added: ExplicitTool[] = [];
      for (let i = 0; added.length < n && i < n * 4 + 16; i++) {
        const t = generatedTool(`${a.email}+added@${working.version + 1}`, 100000 + i);
        if (!existing.has(t.name)) added.push({ ...t });
      }
      working = { ...working, explicit: [...working.explicit, ...added] };
    } else if (Array.isArray(body.add)) {
      working = { ...working, explicit: [...working.explicit, ...(body.add as ExplicitTool[])] };
    }
    if (Array.isArray(body.remove)) {
      working = { ...working, removed: [...working.removed, ...(body.remove as string[])] };
    } else if (body.remove && typeof body.remove === "object") {
      const n = (body.remove as { count?: number }).count ?? 0;
      const names = currentTools(working)
        .slice(-n)
        .map((t) => t.name);
      working = { ...working, removed: [...working.removed, ...names] };
    }
    if (body.rename && typeof body.rename === "object") {
      const renamed = { ...working.renamed };
      for (const [from, to] of Object.entries(body.rename as Record<string, string>)) {
        const original = Object.entries(renamed).find(([, t]) => t === from)?.[0] ?? from;
        renamed[original] = to;
      }
      working = { ...working, renamed };
    }
    spec = zs().toolSpecs.update(spec.id, {
      generated: working.generated,
      explicit: working.explicit,
      removed: working.removed,
      renamed: working.renamed,
      version: spec.version + 1,
    })!;
    const after = currentTools(spec).map((t) => t.name);
    const afterSet = new Set(after);
    const added = after.filter((n) => !before.has(n));
    const removed = [...before].filter((n) => !afterSet.has(n));
    const renames = (body.rename as Record<string, string> | undefined) ?? {};
    const summary = `+${added.length} -${removed.length}${Object.keys(renames).length ? ` renamed ${Object.keys(renames).length}` : ""} (now ${after.length}, version ${spec.version})`;
    zs().changes.insert({
      email: a.email,
      version: spec.version,
      summary,
      added,
      removed,
      renamed: renames,
      at: new Date().toISOString(),
    });
    ledgerChange(ledger, c, a.email, summary, {
      added: added.slice(0, 50),
      removed: removed.slice(0, 50),
      renamed: renames,
      added_count: added.length,
      removed_count: removed.length,
    });
    const notified = notifyListChanged(store, a.email);
    return c.json({
      email: a.email,
      version: spec.version,
      tools: after.length,
      added,
      removed,
      renamed: renames,
      notified_streams: notified,
    });
  });

  app.post("/_emulate/zapier/accounts/:email/behaviors", async (c) => {
    const a = account(c);
    if (!a) return bad(c, "No such account.", 404);
    try {
      setBehavior(store, a.email, (await json(c)) as unknown as BehaviorInput);
      return c.json({ behaviors: zs().behaviors.findBy("email", a.email) });
    } catch (err) {
      return bad(c, err instanceof Error ? err.message : "Invalid behavior.");
    }
  });

  app.get("/_emulate/zapier/settings", (c) => c.json({ ...getSettings(store), note: EMULATOR_ONLY }));

  /** { list_changed?, page_size?, rate_limit?: { requests, window_seconds } | null }. */
  app.post("/_emulate/zapier/settings", async (c) => {
    const b = await json(c);
    const patch: Partial<ZapierSettings> = {};
    if (b.list_changed !== undefined) {
      if (typeof b.list_changed !== "boolean") return bad(c, "list_changed must be a boolean.");
      patch.list_changed = b.list_changed;
    }
    if (b.page_size !== undefined) {
      if (!Number.isInteger(b.page_size) || (b.page_size as number) < 0)
        return bad(c, "page_size must be an integer >= 0 (0 for one page).");
      patch.page_size = b.page_size as number;
    }
    if (b.rate_limit !== undefined) {
      const r = b.rate_limit as { requests?: number; window_seconds?: number } | null;
      if (
        r !== null &&
        (!Number.isInteger(r?.requests) || !Number.isInteger(r?.window_seconds) || (r!.window_seconds as number) < 1)
      ) {
        return bad(c, "rate_limit must be { requests, window_seconds } or null.");
      }
      patch.rate_limit = r === null ? null : { requests: r!.requests!, window_seconds: r!.window_seconds! };
      zs().rateWindows.clear();
    }
    return c.json({
      ...setSettings(store, patch),
      note: "list_changed and rate_limit are emulator controls, not Zapier behaviour: Zapier documents neither change notifications nor a per-minute limit.",
    });
  });

  app.get("/_emulate/zapier/usage", (c) =>
    c.json({
      accounts: store.getData("zapier.usage") ?? {},
      changes: zs()
        .changes.all()
        .sort((x, y) => x.id - y.id),
    }),
  );
}
