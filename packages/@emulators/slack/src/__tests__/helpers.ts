import type { AddressInfo } from "node:net";
import {
  Hono,
  Store,
  WebhookDispatcher,
  authMiddleware,
  createApiErrorHandler,
  createErrorHandler,
  serve,
} from "@emulators/core";
import type { AppEnv, TokenMap } from "@emulators/core";
import type { Server } from "node:http";
import { vi } from "vitest";
import { getSlackStore, slackPlugin } from "../index.js";

export const slackTestBaseUrl = "http://localhost:4000";
export const slackTestToken = "xoxb-test-token";

export interface SlackTestHttpApp {
  fetch: (request: Request) => Promise<Response>;
  request: (input: string | Request, init?: RequestInit) => Promise<Response>;
}

export interface SlackTestApp {
  app: SlackTestHttpApp;
  store: Store;
  webhooks: WebhookDispatcher;
  tokenMap: TokenMap;
}

export interface SlackTestEmulator extends SlackTestApp {
  url: string;
  close: () => Promise<void>;
}

export function createSlackTestApp(): SlackTestApp {
  const store = new Store();
  const webhooks = new WebhookDispatcher();
  const tokenMap: TokenMap = new Map();
  tokenMap.set(slackTestToken, {
    login: "U000000001",
    id: 1,
    scopes: ["chat:write", "channels:read", "users:read", "reactions:write"],
  });

  const app = new Hono<AppEnv>() as Hono<AppEnv> & SlackTestHttpApp;
  app.onError(createApiErrorHandler());
  app.use("*", createErrorHandler());
  app.use("*", (authMiddleware as (tokens: TokenMap) => ReturnType<typeof authMiddleware>)(tokenMap));
  slackPlugin.register!(app, store, webhooks, slackTestBaseUrl, tokenMap);
  slackPlugin.seed?.(store, slackTestBaseUrl);

  const ss = getSlackStore(store);
  const firstUser = ss.users.all()[0];
  if (firstUser) {
    ss.users.update(firstUser.id, { user_id: "U000000001" });
  }

  return { app, store, webhooks, tokenMap };
}

export function authHeaders(contentType = "application/json"): Record<string, string> {
  return { Authorization: `Bearer ${slackTestToken}`, "Content-Type": contentType };
}

export async function startSlackTestEmulator(
  customize?: (setup: SlackTestApp) => void | Promise<void>,
): Promise<SlackTestEmulator> {
  const setup = createSlackTestApp();
  await customize?.(setup);

  const server = serve({ fetch: setup.app.fetch, port: 0 }) as unknown as Server;
  await new Promise<void>((resolve, reject) => {
    server.once("listening", () => resolve());
    server.once("error", reject);
  });

  const { port } = server.address() as AddressInfo;
  return {
    ...setup,
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

export interface CapturedFetchRequest {
  url: string;
  init: RequestInit;
}

export function captureFetchRequests(status = 200): {
  requests: CapturedFetchRequest[];
  jsonBodies: () => unknown[];
} {
  const requests: CapturedFetchRequest[] = [];

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(input), init: init ?? {} });
      return { ok: status >= 200 && status < 300, status };
    }),
  );

  return {
    requests,
    jsonBodies: () =>
      requests.map((request) => {
        const body = request.init.body;
        if (typeof body !== "string") return body;
        return JSON.parse(body);
      }),
  };
}

export function registerSlackEventSubscription(webhooks: WebhookDispatcher, events: string[] = ["*"]): void {
  webhooks.register({
    url: "https://hooks.example/slack",
    events,
    active: true,
    owner: "slack",
  });
}
