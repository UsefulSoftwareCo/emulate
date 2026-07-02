import type { MiddlewareHandler } from "./http.js";
import type { AppEnv, AuthUser, AuthApp } from "./middleware/auth.js";
import type { WebhookDispatcher } from "./webhooks.js";
import { faultLedgerFields } from "./faults.js";

export interface LedgerIdentity {
  user?: Pick<AuthUser, "login" | "id" | "scopes">;
  app?: Pick<AuthApp, "appId" | "slug" | "name">;
}

export interface LedgerSideEffect {
  type: "create" | "update" | "delete" | "custom";
  collection?: string;
  id?: string | number;
  summary?: string;
}

export interface LedgerWebhookDelivery {
  id: number;
  hook_id: number;
  event: string;
  action?: string;
  status_code: number | null;
  success: boolean;
}

export interface LedgerEntry {
  id: string;
  /** Correlation id: honored from X-Correlation-Id / X-Request-Id or generated. */
  correlationId: string;
  timestamp: string;
  method: string;
  host: string;
  path: string;
  query: string;
  /** Matched route pattern, e.g. /repos/:owner/:repo/issues. */
  route?: string;
  /** Provider operation id, when the handler advertises one. */
  operationId?: string;
  /** True when the response was injected by the shared one-shot fault system. */
  faulted?: boolean;
  /** The armed fault id that produced this response. */
  faultId?: string;
  request: {
    headers: Record<string, string>;
    body?: unknown;
    bodyTruncated?: boolean;
  };
  identity: LedgerIdentity;
  response: {
    status: number;
    headers: Record<string, string>;
    body?: unknown;
    bodyTruncated?: boolean;
  };
  /** Human/agent-readable one-liner, e.g. "POST /repos/:owner/:repo -> 201". */
  summary: string;
  sideEffects: LedgerSideEffect[];
  webhookDeliveries: LedgerWebhookDelivery[];
  durationMs: number;
}

export interface LedgerOptions {
  maxEntries?: number;
  maxBodyChars?: number;
  /** When provided, webhook deliveries fired during a request are correlated onto its entry. */
  webhooks?: WebhookDispatcher;
}

export interface LedgerSnapshot {
  entries: LedgerEntry[];
  counter: number;
}

const DEFAULT_MAX_ENTRIES = 1000;
const DEFAULT_MAX_BODY_CHARS = 20000;
const REDACTED = "[redacted]";
const SENSITIVE_HEADERS = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "x-github-token",
  "stripe-signature",
]);
const SENSITIVE_KEYS = /token|secret|password|authorization|api[_-]?key|client[_-]?secret|private[_-]?key/i;

export class RequestLedger {
  private entries: LedgerEntry[] = [];
  private counter = 1;

  constructor(private readonly options: LedgerOptions = {}) {}

  add(entry: Omit<LedgerEntry, "id">): LedgerEntry {
    const saved = { ...entry, id: `req_${this.counter++}` };
    this.entries.push(saved);
    const max = this.options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    if (this.entries.length > max) {
      this.entries.splice(0, this.entries.length - max);
    }
    return saved;
  }

  list(limit?: number): LedgerEntry[] {
    const all = [...this.entries].reverse();
    return limit != null ? all.slice(0, limit) : all;
  }

  clear(): void {
    this.entries.length = 0;
    this.counter = 1;
  }

  /** Serialize for durable persistence (e.g. a Cloudflare Durable Object). */
  serialize(): LedgerSnapshot {
    return { entries: [...this.entries], counter: this.counter };
  }

  restore(snapshot: LedgerSnapshot | undefined): void {
    if (!snapshot) return;
    this.entries = Array.isArray(snapshot.entries) ? [...snapshot.entries] : [];
    this.counter = typeof snapshot.counter === "number" ? snapshot.counter : this.entries.length + 1;
  }
}

function correlationIdFor(headers: Record<string, string>): string {
  const provided = headers["x-correlation-id"] ?? headers["x-request-id"];
  if (provided && provided.length <= 200) return provided;
  return `cor_${crypto.randomUUID().replace(/-/g, "")}`;
}

export function createLedgerMiddleware(ledger: RequestLedger, options: LedgerOptions = {}): MiddlewareHandler<AppEnv> {
  const maxBodyChars = options.maxBodyChars ?? DEFAULT_MAX_BODY_CHARS;
  const webhooks = options.webhooks;

  return async (c, next) => {
    if (c.req.path.startsWith("/_emulate")) {
      await next();
      return;
    }

    const started = Date.now();
    const url = new URL(c.req.url);
    const rawHeaders = c.req.header();
    const correlationId = correlationIdFor(rawHeaders);
    c.set("correlationId", correlationId);
    c.set("ledgerEffects", []);
    c.header("X-Correlation-Id", correlationId);

    const requestBody = await readBody(c.req.raw.clone(), maxBodyChars);
    const requestHeaders = redactHeaders(rawHeaders);

    // Snapshot existing webhook delivery ids so we can correlate the ones this
    // request fires. Exact under the serialized execution of a Durable Object;
    // best-effort on the concurrent local dev server.
    const beforeDeliveryIds = webhooks ? new Set(webhooks.getDeliveries().map((d) => d.id)) : undefined;

    const response = await next();
    if (!response) return;

    const responseBody = await readBody(response.clone(), maxBodyChars);
    const route = c.req.routePath;
    const operationId = c.get("operationId");
    const sideEffects = (c.get("ledgerEffects") as LedgerSideEffect[] | undefined) ?? [];
    const webhookDeliveries: LedgerWebhookDelivery[] =
      webhooks && beforeDeliveryIds
        ? webhooks
            .getDeliveries()
            .filter((d) => !beforeDeliveryIds.has(d.id))
            .map((d) => ({
              id: d.id,
              hook_id: d.hook_id,
              event: d.event,
              action: d.action,
              status_code: d.status_code,
              success: d.success,
            }))
        : [];

    ledger.add({
      correlationId,
      timestamp: new Date().toISOString(),
      method: c.req.method.toUpperCase(),
      host: url.host,
      path: url.pathname,
      query: url.search,
      route,
      operationId,
      ...faultLedgerFields(c),
      request: {
        headers: requestHeaders,
        ...requestBody,
      },
      identity: {
        user: c.get("authUser"),
        app: c.get("authApp"),
      },
      response: {
        status: response.status,
        headers: redactHeaders(headersToRecord(response.headers)),
        ...responseBody,
      },
      summary: `${c.req.method.toUpperCase()} ${route ?? url.pathname} -> ${response.status}`,
      sideEffects,
      webhookDeliveries,
      durationMs: Date.now() - started,
    });

    return response;
  };
}

/** Record a side effect onto the active request's ledger entry. */
export function recordSideEffect(
  c: { get: (key: "ledgerEffects") => LedgerSideEffect[] | undefined },
  effect: LedgerSideEffect,
): void {
  const effects = c.get("ledgerEffects");
  if (effects) effects.push(effect);
}

async function readBody(
  responseOrRequest: Request | Response,
  maxChars: number,
): Promise<{ body?: unknown; bodyTruncated?: boolean }> {
  const method = responseOrRequest instanceof Request ? responseOrRequest.method.toUpperCase() : undefined;
  if (method === "GET" || method === "HEAD") return {};

  const contentType = responseOrRequest.headers.get("content-type") ?? "";
  if (responseOrRequest instanceof Response && responseOrRequest.status === 204) return {};

  let text: string;
  try {
    text = await responseOrRequest.text();
  } catch {
    return {};
  }
  if (!text) return {};

  const truncated = text.length > maxChars;
  const clipped = truncated ? text.slice(0, maxChars) : text;
  if (contentType.includes("application/json")) {
    try {
      return { body: redactValue(JSON.parse(clipped)), bodyTruncated: truncated || undefined };
    } catch {
      return { body: clipped, bodyTruncated: truncated || undefined };
    }
  }
  if (contentType.includes("application/x-www-form-urlencoded")) {
    const params: Record<string, string> = {};
    for (const [key, value] of new URLSearchParams(clipped)) {
      params[key] = SENSITIVE_KEYS.test(key) ? REDACTED : value;
    }
    return { body: params, bodyTruncated: truncated || undefined };
  }
  return { body: clipped, bodyTruncated: truncated || undefined };
}

function headersToRecord(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    out[key] = SENSITIVE_HEADERS.has(key.toLowerCase()) ? REDACTED : value;
  }
  return out;
}

function redactValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactValue);
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    out[key] = SENSITIVE_KEYS.test(key) ? REDACTED : redactValue(child);
  }
  return out;
}
