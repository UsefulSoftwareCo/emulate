import { readFile, writeFile } from "node:fs/promises";
import type { Emulator, SeedConfig, ServiceName } from "emulate";

export interface PersistenceAdapter {
  load(): string | null | Promise<string | null>;
  save(data: string): void | Promise<void>;
}

export function filePersistence(path: string): PersistenceAdapter {
  return {
    async load() {
      try {
        return await readFile(path, "utf8");
      } catch (error) {
        if ((error as { code?: string }).code === "ENOENT") return null;
        throw error;
      }
    },
    async save(data: string) {
      await writeFile(path, data);
    },
  };
}

export interface Entity {
  id: number;
  created_at: string;
  updated_at: string;
}

export type InsertInput<T extends Entity> = Omit<T, "id" | "created_at" | "updated_at"> & { id?: number };
export type FilterFn<T> = (item: T) => boolean;
export type SortFn<T> = (a: T, b: T) => number;

export interface QueryOptions<T> {
  filter?: FilterFn<T>;
  sort?: SortFn<T>;
  page?: number;
  per_page?: number;
}

export interface PaginatedResult<T> {
  items: T[];
  total_count: number;
  page: number;
  per_page: number;
  has_next: boolean;
  has_prev: boolean;
}

export interface CollectionSnapshot<T extends Entity = Entity> {
  items: T[];
  autoId: number;
  indexFields: string[];
}

export interface StoreSnapshot {
  collections: Record<string, CollectionSnapshot>;
  data: Record<string, unknown>;
}

export function serializeValue(value: unknown): unknown {
  if (value instanceof Map) {
    return { __type: "Map" as const, entries: [...value.entries()].map(([key, val]) => [key, serializeValue(val)]) };
  }
  if (value instanceof Set) {
    return { __type: "Set" as const, values: [...value.values()] };
  }
  return value;
}

export function deserializeValue(value: unknown): unknown {
  if (value !== null && typeof value === "object" && "__type" in value) {
    const tagged = value as Record<string, unknown>;
    if (tagged.__type === "Map") {
      const entries = tagged.entries as [unknown, unknown][];
      return new Map(entries.map(([key, val]) => [key, deserializeValue(val)]));
    }
    if (tagged.__type === "Set") {
      return new Set(tagged.values as unknown[]);
    }
  }
  return value;
}

export class Collection<T extends Entity> {
  private items = new Map<number, T>();
  private autoId = 1;
  readonly fieldNames: string[];

  constructor(private indexFields: (keyof T)[] = []) {
    this.fieldNames = indexFields.map(String).sort();
  }

  insert(data: InsertInput<T>): T {
    const now = new Date().toISOString();
    const explicitId = data.id != null && data.id > 0 ? data.id : undefined;
    const id = explicitId ?? this.autoId++;
    if (id >= this.autoId) this.autoId = id + 1;
    const item = { ...data, id, created_at: now, updated_at: now } as unknown as T;
    this.items.set(id, item);
    return item;
  }

  get(id: number): T | undefined {
    return this.items.get(id);
  }

  findBy(field: keyof T, value: T[keyof T] | string | number): T[] {
    return this.all().filter((item) => item[field] === value);
  }

  findOneBy(field: keyof T, value: T[keyof T] | string | number): T | undefined {
    return this.findBy(field, value)[0];
  }

  update(id: number, data: Partial<T>): T | undefined {
    const existing = this.items.get(id);
    if (!existing) return undefined;
    const updated = { ...existing, ...data, id, updated_at: new Date().toISOString() } as T;
    this.items.set(id, updated);
    return updated;
  }

  delete(id: number): boolean {
    return this.items.delete(id);
  }

  all(): T[] {
    return Array.from(this.items.values());
  }

  query(options: QueryOptions<T> = {}): PaginatedResult<T> {
    let results = this.all();
    if (options.filter) results = results.filter(options.filter);
    if (options.sort) results.sort(options.sort);
    const total_count = results.length;
    const page = options.page ?? 1;
    const per_page = Math.min(options.per_page ?? 30, 100);
    const start = (page - 1) * per_page;
    return {
      items: results.slice(start, start + per_page),
      total_count,
      page,
      per_page,
      has_next: start + per_page < total_count,
      has_prev: page > 1,
    };
  }

  count(filter?: FilterFn<T>): number {
    return filter ? this.all().filter(filter).length : this.items.size;
  }

  clear(): void {
    this.items.clear();
    this.autoId = 1;
  }

  snapshot(): CollectionSnapshot<T> {
    return { items: this.all(), autoId: this.autoId, indexFields: this.fieldNames };
  }

  restore(snap: CollectionSnapshot<T>): void {
    this.clear();
    this.autoId = snap.autoId;
    for (const item of snap.items) this.items.set(item.id, item);
  }
}

export class Store {
  private collections = new Map<string, Collection<Entity>>();
  private data = new Map<string, unknown>();

  collection<T extends Entity>(name: string, indexFields: (keyof T)[] = []): Collection<T> {
    const existing = this.collections.get(name);
    if (existing) return existing as unknown as Collection<T>;
    const collection = new Collection<T>(indexFields);
    this.collections.set(name, collection as unknown as Collection<Entity>);
    return collection;
  }

  getData<V>(key: string): V | undefined {
    return this.data.get(key) as V | undefined;
  }

  setData<V>(key: string, value: V): void {
    this.data.set(key, value);
  }

  reset(): void {
    for (const collection of this.collections.values()) collection.clear();
    this.data.clear();
  }

  snapshot(): StoreSnapshot {
    const collections: Record<string, CollectionSnapshot> = {};
    for (const [name, collection] of this.collections) collections[name] = collection.snapshot();
    const data: Record<string, unknown> = {};
    for (const [key, value] of this.data) data[key] = serializeValue(value);
    return { collections, data };
  }

  restore(snapshot: StoreSnapshot): void {
    this.collections.clear();
    for (const [name, collectionSnapshot] of Object.entries(snapshot.collections)) {
      const collection = this.collection(name, collectionSnapshot.indexFields as (keyof Entity)[]);
      collection.restore(collectionSnapshot);
    }
    this.data.clear();
    for (const [key, value] of Object.entries(snapshot.data)) this.data.set(key, deserializeValue(value));
  }
}

export type ContentfulStatusCode = number;
export type Next = () => Promise<void>;
export type Handler = (context: Context, next?: Next) => Response | Promise<Response> | void | Promise<void>;
export type MiddlewareHandler = Handler;
export type ErrorHandler = (error: Error, context: Context) => Response | Promise<Response>;
export type FetchHandler = (request: Request, ...rest: unknown[]) => Response | Promise<Response>;

export interface CorsOptions {
  origin?: string | string[];
}

export interface ServeOptions {
  fetch?: FetchHandler;
  port?: number;
}

export class Context {
  req = new HonoRequest();
}

export class HonoRequest {}

export class Hono<TEnv = unknown> {
  fetch: FetchHandler = async () => new Response("Not found", { status: 404 });

  constructor(readonly env?: TEnv) {}

  use(..._args: unknown[]): this {
    return this;
  }

  get(..._args: unknown[]): this {
    return this;
  }

  post(..._args: unknown[]): this {
    return this;
  }

  put(..._args: unknown[]): this {
    return this;
  }

  patch(..._args: unknown[]): this {
    return this;
  }

  delete(..._args: unknown[]): this {
    return this;
  }

  options(..._args: unknown[]): this {
    return this;
  }

  onError(..._args: unknown[]): this {
    return this;
  }

  notFound(..._args: unknown[]): this {
    return this;
  }
}

export function cors(): MiddlewareHandler {
  return async (_context, next) => {
    await next?.();
  };
}

export function serve(_options: ServeOptions): never {
  throw new Error("The TypeScript server runtime has been removed. Use npx emulate or createServer as a native proxy.");
}

export interface AuthUser {
  login: string;
  id?: number;
  scopes?: string[];
}

export interface AuthApp {
  id: string;
  slug?: string;
}

export interface AuthInstallation {
  id: number;
}

export type AuthFallback = AuthUser | (() => AuthUser | undefined);
export type AppKeyResolver = (appId: string) => Promise<unknown | string | undefined> | unknown | string | undefined;
export type AppEnv = Record<string, unknown>;

export interface TokenEntry {
  token?: string;
  login: string;
  id?: number;
  scopes?: string[];
}

export type TokenMap = Map<string, TokenEntry>;

export function serializeTokenMap(tokenMap: TokenMap): Record<string, TokenEntry[]> {
  return { tokens: [...tokenMap.entries()].map(([token, entry]) => ({ ...entry, token })) };
}

export function restoreTokenMap(tokenMap: TokenMap, entries: TokenEntry[] | Record<string, TokenEntry[]>): void {
  tokenMap.clear();
  const list = Array.isArray(entries) ? entries : entries.tokens;
  for (const entry of list ?? []) {
    if (entry.token) tokenMap.set(entry.token, entry);
  }
}

export interface WebhookSubscription {
  url: string;
  events?: string[];
  secret?: string;
}

export interface WebhookDelivery {
  event: string;
  payload: unknown;
}

export class WebhookDispatcher {
  subscriptions: WebhookSubscription[] = [];

  subscribe(subscription: WebhookSubscription): void {
    this.subscriptions.push(subscription);
  }

  async dispatch(event: string, _action: string | undefined, payload: unknown): Promise<WebhookDelivery[]> {
    return this.subscriptions.map(() => ({ event, payload }));
  }
}

export interface RouteContext {
  app: Hono<AppEnv>;
  store: Store;
  webhooks: WebhookDispatcher;
  baseUrl: string;
  tokenMap?: TokenMap;
}

export interface ServicePlugin {
  name: string;
  runtime?: string;
  register?(app: Hono<AppEnv>, store: Store, webhooks: WebhookDispatcher, baseUrl: string, tokenMap?: TokenMap): void;
  seed?(store: Store, baseUrl: string): void;
}

export interface ServerOptions {
  port?: number;
  baseUrl?: string;
  docsUrl?: string;
  tokens?: Record<string, { login: string; id?: number; scopes?: string[] }>;
  appKeyResolver?: AppKeyResolver;
  fallbackUser?: AuthFallback;
}

export function createServer(plugin: ServicePlugin, options: ServerOptions = {}) {
  const port = options.port ?? 4000;
  const baseUrl = options.baseUrl ?? `http://localhost:${port}`;
  const store = new Store();
  const webhooks = new WebhookDispatcher();
  const tokenMap: TokenMap = new Map();
  for (const [token, user] of Object.entries(options.tokens ?? {})) {
    tokenMap.set(token, { token, ...user });
  }

  let runtime: Promise<{ emulator: Emulator; target: string }> | undefined;
  async function ensureRuntime(): Promise<{ emulator: Emulator; target: string }> {
    if (runtime) return runtime;
    runtime = startNativeServerRuntime(plugin.name, port, baseUrl, options.tokens);
    return runtime;
  }

  const app = {
    async fetch(request: Request): Promise<Response> {
      const native = await ensureRuntime();
      const url = new URL(request.url);
      const target = new URL(`${url.pathname}${url.search}`, native.target);
      const init: RequestInit & { duplex?: string } = {
        method: request.method,
        headers: request.headers,
        redirect: "manual",
      };
      if (!["GET", "HEAD"].includes(request.method)) {
        init.body = request.body;
        init.duplex = "half";
      }
      return fetch(new Request(target, init));
    },
  };

  return {
    app,
    store,
    webhooks,
    port,
    baseUrl,
    tokenMap,
    async close() {
      const native = await runtime;
      await native?.emulator.close();
    },
  };
}

async function startNativeServerRuntime(
  service: string,
  port: number,
  baseUrl: string | undefined,
  tokens: ServerOptions["tokens"],
): Promise<{ emulator: Emulator; target: string }> {
  if (!isServiceName(service)) {
    throw new Error(`Unsupported native emulator service: ${service}`);
  }
  const { createEmulator } = await loadEmulateApi();
  const seed = tokens
    ? ({
        tokens: Object.fromEntries(
          Object.entries(tokens).map(([token, user]) => [token, { login: user.login, scopes: user.scopes }]),
        ),
      } as SeedConfig)
    : undefined;
  const emulator = await createEmulator({ service, port, baseUrl, seed });
  return { emulator, target: `http://127.0.0.1:${port}` };
}

async function loadEmulateApi(): Promise<typeof import("emulate")> {
  const globalLoader = (globalThis as { __emulateCompatLoadEmulateApi?: () => Promise<typeof import("emulate")> })
    .__emulateCompatLoadEmulateApi;
  if (globalLoader) return globalLoader();
  const dynamicImport = new Function("specifier", "return import(specifier)") as (
    specifier: string,
  ) => Promise<typeof import("emulate")>;
  return dynamicImport("emulate");
}

function isServiceName(service: string): service is ServiceName {
  return [
    "vercel",
    "github",
    "google",
    "slack",
    "apple",
    "microsoft",
    "okta",
    "aws",
    "resend",
    "stripe",
    "mongoatlas",
    "clerk",
  ].includes(service);
}

export function errorHandler(error: Error): Response {
  return renderErrorPage(error.message, 500);
}

export function createErrorHandler(): ErrorHandler {
  return (error) => errorHandler(error);
}

export function createApiErrorHandler(): ErrorHandler {
  return (error) => Response.json({ message: error.message }, { status: 500 });
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export function notFound(message = "Not Found"): never {
  throw new ApiError(message, 404);
}

export function validationError(message: string): never {
  throw new ApiError(message, 400);
}

export function unauthorized(message = "Unauthorized"): never {
  throw new ApiError(message, 401);
}

export function forbidden(message = "Forbidden"): never {
  throw new ApiError(message, 403);
}

export async function parseJsonBody<T = unknown>(request: Request): Promise<T> {
  return (await request.json()) as T;
}

export function authMiddleware(): MiddlewareHandler {
  return async (_context, next) => {
    await next?.();
  };
}

export function requireAuth(): AuthUser {
  return { login: "emulate" };
}

export function requireAppAuth(): AuthApp {
  return { id: "emulate" };
}

export interface PaginationParams {
  page: number;
  per_page: number;
}

export function parsePagination(url: string | URL): PaginationParams {
  const parsed = new URL(url.toString());
  return {
    page: Number(parsed.searchParams.get("page") ?? 1),
    per_page: Number(parsed.searchParams.get("per_page") ?? 30),
  };
}

export function setLinkHeader(): void {
  return undefined;
}

export function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function escapeAttr(value: unknown): string {
  return escapeHtml(value);
}

export interface UserButtonOptions {
  label: string;
  value?: string;
}

export interface CheckoutLineItem {
  name: string;
  amount?: number;
  quantity?: number;
}

export interface CheckoutPageOptions {
  title?: string;
  lineItems?: CheckoutLineItem[];
}

export interface InspectorTab {
  id: string;
  label: string;
  content: string;
}

export function renderCardPage(options: { title?: string; body?: string } | string): string {
  const title = typeof options === "string" ? options : (options.title ?? "emulate");
  const body = typeof options === "string" ? "" : (options.body ?? "");
  return `<!doctype html><html><head><title>${escapeHtml(title)}</title></head><body>${body}</body></html>`;
}

export function renderErrorPage(message: string, status = 500): Response {
  return new Response(renderCardPage({ title: String(status), body: escapeHtml(message) }), {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

export function renderSettingsPage(options: { title?: string; body?: string }): string {
  return renderCardPage(options);
}

export function renderInspectorPage(options: { title?: string; tabs?: InspectorTab[] }): string {
  return renderCardPage({ title: options.title, body: options.tabs?.map((tab) => tab.content).join("") ?? "" });
}

export function renderFormPostPage(action: string, fields: Record<string, string>): string {
  const inputs = Object.entries(fields)
    .map(([name, value]) => `<input type="hidden" name="${escapeAttr(name)}" value="${escapeAttr(value)}">`)
    .join("");
  return renderCardPage({ title: "Redirecting", body: `<form method="post" action="${escapeAttr(action)}">${inputs}</form>` });
}

export function renderCheckoutPage(options: CheckoutPageOptions): string {
  return renderCardPage({ title: options.title ?? "Checkout" });
}

export function renderUserButton(options: UserButtonOptions): string {
  return `<button value="${escapeAttr(options.value ?? options.label)}">${escapeHtml(options.label)}</button>`;
}

export function registerFontRoutes(): void {
  return undefined;
}

export function normalizeUri(uri: string): string {
  return uri.replace(/\/+$/, "");
}

export function matchesRedirectUri(actual: string, expected: string): boolean {
  return normalizeUri(actual) === normalizeUri(expected);
}

export function constantTimeSecretEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
  return diff === 0;
}

export async function bodyStr(request: Request): Promise<string> {
  return request.text();
}

export function parseCookies(header: string | null | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const part of header?.split(";") ?? []) {
    const [name, ...value] = part.trim().split("=");
    if (name) cookies[name] = value.join("=");
  }
  return cookies;
}

export function debug(..._args: unknown[]): void {
  return undefined;
}

export const runtime = "native-go";
