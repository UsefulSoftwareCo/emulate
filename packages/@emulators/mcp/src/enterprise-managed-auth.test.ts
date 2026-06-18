import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, serve } from "@emulators/core";
import { manifest as workosManifest, seedFromConfig as seedWorkos, workosPlugin } from "@emulators/workos";
import type { LedgerEntry } from "@emulators/core";
import { mcpPlugin } from "./index.js";

const WORKOS_PORT = 41883;
const MCP_PORT = 41884;
const WORKOS_BASE = `http://localhost:${WORKOS_PORT}`;
const MCP_BASE = `http://localhost:${MCP_PORT}`;
const CLIENT_ID = "https://executor.test/client.json";
const TOKEN_EXCHANGE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:token-exchange";
const JWT_BEARER_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:jwt-bearer";
const ID_JAG_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:id-jag";
const ACCESS_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:access_token";

let workosServer: ReturnType<typeof serve>;
let mcpServer: ReturnType<typeof serve>;
let workosLedger: { list: () => LedgerEntry[] };
let mcpLedger: { list: () => LedgerEntry[] };

beforeAll(async () => {
  const workos = createServer(workosPlugin, {
    port: WORKOS_PORT,
    baseUrl: WORKOS_BASE,
    manifest: workosManifest,
    fallbackUser: { login: "sk_emulate_admin", id: 1, scopes: [] },
  });
  seedWorkos(workos.store, WORKOS_BASE, {
    users: [{ email: "admin@localhost", first_name: "Admin" }],
  });
  workosLedger = workos.ledger;
  workosServer = serve({ fetch: workos.app.fetch, port: WORKOS_PORT });

  const mcp = createServer(mcpPlugin, {
    port: MCP_PORT,
    baseUrl: MCP_BASE,
    fallbackUser: { login: "admin", id: 1, scopes: [] },
  });
  mcpPlugin.seed?.(mcp.store, MCP_BASE);
  mcpLedger = mcp.ledger;
  mcpServer = serve({ fetch: mcp.app.fetch, port: MCP_PORT });
});

afterAll(async () => {
  await Promise.all([
    new Promise<void>((resolve) => workosServer.close(() => resolve())),
    new Promise<void>((resolve) => mcpServer.close(() => resolve())),
  ]);
});

async function workosAccessToken(loginHint: string): Promise<string> {
  const authorize = new URL(`${WORKOS_BASE}/user_management/authorize`);
  authorize.searchParams.set("client_id", CLIENT_ID);
  authorize.searchParams.set("redirect_uri", "http://127.0.0.1:9/callback");
  authorize.searchParams.set("login_hint", loginHint);
  const redirect = await fetch(authorize, { redirect: "manual" });
  expect(redirect.status).toBe(302);
  const code = new URL(redirect.headers.get("location") ?? "").searchParams.get("code");
  expect(code).toBeTruthy();

  const token = await fetch(`${WORKOS_BASE}/user_management/authenticate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      code,
    }),
  });
  expect(token.status).toBe(200);
  const body = (await token.json()) as { access_token?: string };
  expect(body.access_token).toBeTruthy();
  return body.access_token ?? "";
}

describe("MCP enterprise-managed authorization", () => {
  it("exchanges a WorkOS identity assertion into an MCP access token and uses it", async () => {
    const subjectToken = await workosAccessToken("admin@localhost");
    const idJagResponse = await fetch(`${WORKOS_BASE}/oauth2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: TOKEN_EXCHANGE_GRANT_TYPE,
        requested_token_type: ID_JAG_TOKEN_TYPE,
        audience: MCP_BASE,
        resource: `${MCP_BASE}/mcp`,
        scope: "repo read:user",
        subject_token: subjectToken,
        subject_token_type: ACCESS_TOKEN_TYPE,
        client_id: CLIENT_ID,
      }),
    });
    expect(idJagResponse.status).toBe(200);
    const idJag = (await idJagResponse.json()) as { access_token?: string };
    expect(idJag.access_token).toBeTruthy();

    const mcpTokenResponse = await fetch(`${MCP_BASE}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: JWT_BEARER_GRANT_TYPE,
        assertion: idJag.access_token ?? "",
        client_id: CLIENT_ID,
      }),
    });
    expect(mcpTokenResponse.status).toBe(200);
    const mcpToken = (await mcpTokenResponse.json()) as { access_token?: string; scope?: string };
    expect(mcpToken.access_token).toMatch(/^mcp_/);
    expect(mcpToken.scope).toBe("repo read:user");

    const toolCall = await fetch(`${MCP_BASE}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${mcpToken.access_token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "get_me", arguments: {} },
      }),
    });
    expect(toolCall.status).toBe(200);
    const rpc = (await toolCall.json()) as {
      result?: { structuredContent?: { login?: string; email?: string } };
    };
    expect(rpc.result?.structuredContent).toMatchObject({ login: "admin", email: "admin@localhost" });

    const workosExchange = workosLedger.list().find((entry) => entry.operationId === "workos.oauth.tokenExchange");
    expect(workosExchange).toBeTruthy();
    expect(workosExchange?.request.body).toMatchObject({
      grant_type: TOKEN_EXCHANGE_GRANT_TYPE,
      requested_token_type: "[redacted]",
      subject_token_type: "[redacted]",
      audience: MCP_BASE,
    });

    const mcpExchange = mcpLedger.list().find((entry) => entry.operationId === "mcp.oauth.jwtBearer");
    expect(mcpExchange).toBeTruthy();
    expect(mcpExchange?.request.body).toMatchObject({
      grant_type: JWT_BEARER_GRANT_TYPE,
      client_id: CLIENT_ID,
    });

    const mcpCall = mcpLedger.list().find((entry) => entry.path === "/mcp" && entry.method === "POST");
    expect(mcpCall?.identity.user).toMatchObject({ login: "admin", scopes: ["repo", "read:user"] });
  });
});
