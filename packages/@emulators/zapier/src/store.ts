import { Store, type Collection, type Entity } from "@emulators/core";

/** A Zapier account; the person an MCP client acts for. */
export interface ZapierAccount extends Entity {
  email: string;
  name: string;
  /** Stable numeric id (string), used as `sub` in userinfo. */
  account_id: string;
}

/** An explicitly defined tool (seeded or added on command). */
export interface ExplicitTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

/**
 * An account's tool list, kept as a recipe rather than one row per tool:
 * `generated` tools computed from a seed string, then edits applied in order.
 * The same recipe gives the same list, names, schemas and order everywhere.
 */
export interface ZapierToolSpec extends Entity {
  email: string;
  generated: { count: number; seed: string } | null;
  explicit: ExplicitTool[];
  removed: string[];
  renamed: Record<string, string>;
  /** Bumped on every change; part of every cursor. */
  version: number;
}

/** How one tool behaves when called. */
export interface ZapierToolBehavior extends Entity {
  email: string;
  tool: string;
  delay_ms: number;
  /** "tool": a result with isError true; "protocol": a JSON-RPC error. */
  fail: "tool" | "protocol" | null;
  result_bytes: number;
}

export interface ZapierOAuthClient extends Entity {
  client_id: string;
  client_secret: string | null;
  client_name: string | null;
  redirect_uris: string[];
  token_endpoint_auth_method: "none" | "client_secret_post" | "client_secret_basic";
  grant_types: string[];
  created_at_s: number;
}

export interface ZapierAuthCode extends Entity {
  code: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  scope: string;
  email: string;
  resource: string | null;
  expires_at: number;
  used: boolean;
}

export interface ZapierToken extends Entity {
  access_token: string;
  refresh_token: string | null;
  client_id: string | null;
  email: string;
  scope: string;
  /** "oauth" tokens expire and refresh; "connection" tokens are long-lived, one per account. */
  kind: "oauth" | "connection";
  expires_at: number | null;
  revoked: boolean;
}

/** One fixed request window per account (the emulator's own control, not Zapier's). */
export interface ZapierRateWindow extends Entity {
  email: string;
  limit: number;
  used: number;
  reset_at_ms: number;
}

/** One change to an account's tool list, for tests and the ledger. */
export interface ZapierListChange extends Entity {
  email: string;
  version: number;
  summary: string;
  added: string[];
  removed: string[];
  renamed: Record<string, string>;
  at: string;
}

export interface ZapierStore {
  accounts: Collection<ZapierAccount>;
  toolSpecs: Collection<ZapierToolSpec>;
  behaviors: Collection<ZapierToolBehavior>;
  clients: Collection<ZapierOAuthClient>;
  codes: Collection<ZapierAuthCode>;
  tokens: Collection<ZapierToken>;
  rateWindows: Collection<ZapierRateWindow>;
  changes: Collection<ZapierListChange>;
}

export function getZapierStore(store: Store): ZapierStore {
  return {
    accounts: store.collection<ZapierAccount>("zapier.accounts", ["email"]),
    toolSpecs: store.collection<ZapierToolSpec>("zapier.tool_specs", ["email"]),
    behaviors: store.collection<ZapierToolBehavior>("zapier.tool_behaviors", ["email"]),
    clients: store.collection<ZapierOAuthClient>("zapier.oauth_clients", ["client_id"]),
    codes: store.collection<ZapierAuthCode>("zapier.oauth_codes", ["code"]),
    tokens: store.collection<ZapierToken>("zapier.tokens", ["access_token", "refresh_token", "email"]),
    rateWindows: store.collection<ZapierRateWindow>("zapier.rate_windows", ["email"]),
    changes: store.collection<ZapierListChange>("zapier.list_changes", ["email"]),
  };
}

/** Instance settings, kept in the store so a hosted instance keeps them. */
export interface ZapierSettings {
  /** Emulator-only: announce changes with notifications/tools/list_changed. Off, as Zapier documents none. */
  list_changed: boolean;
  /** tools/list page size; 0 means everything in one page. */
  page_size: number;
  /** Emulator-only per-account request limit; null for none. */
  rate_limit: { requests: number; window_seconds: number } | null;
}

const SETTINGS_KEY = "zapier.settings";
export const DEFAULT_PAGE_SIZE = 100;

export function getSettings(store: Store): ZapierSettings {
  return (
    store.getData<ZapierSettings>(SETTINGS_KEY) ?? {
      list_changed: false,
      page_size: DEFAULT_PAGE_SIZE,
      rate_limit: null,
    }
  );
}

export function setSettings(store: Store, patch: Partial<ZapierSettings>): ZapierSettings {
  const next = { ...getSettings(store), ...patch };
  store.setData(SETTINGS_KEY, next);
  return next;
}
