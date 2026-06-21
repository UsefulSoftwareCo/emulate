import { describe, expect, it } from "vitest";
import { Hono, Store, WebhookDispatcher, type TokenMap } from "@emulators/core";
import { mcpPlugin, setMcpAuthConfig } from "./index.js";
import { TEST_IMAGE_MIME_TYPE, TEST_IMAGE_PNG_BASE64 } from "./tools.js";

const base = "http://localhost:4000";
const token = "test-token";

function createApp() {
  const store = new Store();
  const webhooks = new WebhookDispatcher();
  const tokenMap: TokenMap = new Map([[token, { login: "admin", id: 1, scopes: ["repo", "read:user"] }]]);
  const app = new Hono();
  mcpPlugin.register(app as never, store, webhooks, base, tokenMap);
  mcpPlugin.seed?.(store, base);
  setMcpAuthConfig(store, { auth: "bearer" });
  return { app };
}

async function callTool(app: Hono, name: string): Promise<Record<string, unknown>> {
  const res = await app.request("/mcp", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: {} },
    }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { result?: Record<string, unknown> };
  expect(body.result).toBeDefined();
  return body.result!;
}

function expectFixtureImage(block: unknown) {
  expect(block).toEqual({
    type: "image",
    data: TEST_IMAGE_PNG_BASE64,
    mimeType: TEST_IMAGE_MIME_TYPE,
  });
  const bytes = Buffer.from(TEST_IMAGE_PNG_BASE64, "base64");
  expect([...bytes.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  expect(bytes.byteLength).toBe(70);
}

describe("MCP image content tools", () => {
  it("returns a deterministic PNG as native MCP image content", async () => {
    const { app } = createApp();
    const result = await callTool(app, "get_test_image");
    expect(result.content).toHaveLength(1);
    expectFixtureImage((result.content as unknown[])[0]);
    expect(result.structuredContent).toMatchObject({
      name: "mcp-image-fixture.png",
      mimeType: TEST_IMAGE_MIME_TYPE,
      byteLength: 70,
    });
  });

  it("returns text metadata followed by native MCP image content", async () => {
    const { app } = createApp();
    const result = await callTool(app, "get_test_image_with_metadata");
    expect(result.content).toHaveLength(2);
    expect((result.content as Array<{ type?: string; text?: string }>)[0]).toMatchObject({
      type: "text",
      text: "Deterministic image fixture: mcp-image-fixture.png (image/png, 70 bytes)",
    });
    expectFixtureImage((result.content as unknown[])[1]);
  });
});
