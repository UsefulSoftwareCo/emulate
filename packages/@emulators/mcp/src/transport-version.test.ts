import { describe, expect, it } from "vitest";
import { Hono, Store, WebhookDispatcher, type TokenMap } from "@emulators/core";
import { mcpPlugin } from "./index.js";
import { PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS } from "./transport.js";

const BASE_URL = "http://localhost:4000";

const createApp = () => {
  const store = new Store();
  const tokenMap: TokenMap = new Map([["test-token", { login: "admin", id: 1, scopes: ["repo", "read:user"] }]]);
  const app = new Hono();
  mcpPlugin.register(app as never, store, new WebhookDispatcher(), BASE_URL, tokenMap);
  mcpPlugin.seed?.(store, BASE_URL);
  return app;
};

const initialize = async (requestedVersion: string) => {
  const response = await createApp().request("/mcp", {
    method: "POST",
    headers: {
      accept: "application/json",
      authorization: "Bearer test-token",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: requestedVersion,
        capabilities: {},
        clientInfo: { name: "test", version: "1.0.0" },
      },
    }),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as { result: { protocolVersion: string } };
};

const listTools = (protocolVersion?: string, method = "POST") =>
  createApp().request("/mcp", {
    method,
    headers: {
      accept: "application/json",
      authorization: "Bearer test-token",
      "content-type": "application/json",
      ...(protocolVersion === undefined ? {} : { "MCP-Protocol-Version": protocolVersion }),
    },
    body:
      method === "POST"
        ? JSON.stringify({
            jsonrpc: "2.0",
            id: 2,
            method: "tools/list",
            params: {},
          })
        : undefined,
  });

describe("MCP protocol version negotiation", () => {
  it.each(SUPPORTED_PROTOCOL_VERSIONS)("echoes supported version %s", async (version) => {
    expect((await initialize(version)).result.protocolVersion).toBe(version);
  });

  it("selects the latest supported version for an unknown request", async () => {
    expect((await initialize("2099-01-01")).result.protocolVersion).toBe(PROTOCOL_VERSION);
  });

  it.each(SUPPORTED_PROTOCOL_VERSIONS)("accepts supported subsequent-request header %s", async (version) => {
    expect((await listTools(version)).status).toBe(200);
  });

  it("accepts a missing subsequent-request header for backwards compatibility", async () => {
    expect((await listTools()).status).toBe(200);
  });

  it("rejects unsupported subsequent-request headers", async () => {
    const response = await listTools("2099-01-01");
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "unsupported_protocol_version",
      message: "MCP-Protocol-Version is invalid or unsupported.",
    });
  });

  it("validates headers before the authenticated GET fallback", async () => {
    expect((await listTools("2099-01-01", "GET")).status).toBe(400);
  });
});
