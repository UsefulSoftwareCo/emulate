import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createServer, serveOnFreePort, type FreePortServer } from "@emulators/core";
import { manifest as oktaManifest, oktaPlugin, seedFromConfig as seedOkta } from "@emulators/okta";
import type { LedgerEntry } from "@emulators/core";
import { decodeJwt } from "jose";
import { mcpPlugin } from "./index.js";

// Ports the system chooses, held from the start (see serveOnFreePort).
let OKTA_BASE = "";
let MCP_BASE = "";
let OKTA_ISSUER = "";
const CLIENT_ID = "mcp-desktop-client";
const CLIENT_SECRET = "mcp-desktop-secret";
const REDIRECT_URI = "http://127.0.0.1:9/callback";
const USER_LOGIN = "admin@localhost";
const OKTA_API_TOKEN = "okta-admin-token";

const TOKEN_EXCHANGE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:token-exchange";
const JWT_BEARER_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:jwt-bearer";
const ID_JAG_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:id-jag";
const ID_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:id_token";

let oktaServer: FreePortServer;
let mcpServer: FreePortServer;
let oktaLedger: { list: () => LedgerEntry[] };
let mcpLedger: { list: () => LedgerEntry[] };

beforeAll(async () => {
  oktaServer = await serveOnFreePort();
  mcpServer = await serveOnFreePort();
  OKTA_BASE = `http://localhost:${oktaServer.port}`;
  MCP_BASE = `http://localhost:${mcpServer.port}`;
  OKTA_ISSUER = `${OKTA_BASE}/oauth2/default`;
  const okta = createServer(oktaPlugin, {
    port: oktaServer.port,
    baseUrl: OKTA_BASE,
    manifest: oktaManifest,
    tokens: { [OKTA_API_TOKEN]: { login: "okta-admin", id: 1, scopes: ["okta.*"] } },
  });
  oktaPlugin.seed?.(okta.store, OKTA_BASE);
  seedOkta(okta.store, OKTA_BASE, {
    users: [{ login: USER_LOGIN, email: USER_LOGIN, first_name: "Admin", last_name: "User" }],
    oauth_clients: [
      {
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        name: "MCP Desktop Client",
        redirect_uris: [REDIRECT_URI],
        auth_server_id: "default",
      },
    ],
  });
  oktaLedger = okta.ledger;
  oktaServer.use(okta.app.fetch);

  const mcp = createServer(mcpPlugin, {
    port: mcpServer.port,
    baseUrl: MCP_BASE,
    fallbackUser: { login: "admin", id: 1, scopes: [] },
  });
  mcpPlugin.seed?.(mcp.store, MCP_BASE);
  mcpLedger = mcp.ledger;
  mcpServer.use(mcp.app.fetch);
});

afterAll(async () => {
  await Promise.all([oktaServer.close(), mcpServer.close()]);
});

/** OIDC single sign-on to the MCP client, ending with an Okta ID token. */
async function oktaIdToken(): Promise<string> {
  const callback = await fetch(`${OKTA_BASE}/oauth2/default/v1/authorize/callback`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    redirect: "manual",
    body: new URLSearchParams({
      user_ref: USER_LOGIN,
      redirect_uri: REDIRECT_URI,
      scope: "openid profile email",
      client_id: CLIENT_ID,
      response_mode: "query",
      auth_server_id: "default",
    }),
  });
  expect(callback.status).toBe(302);
  const code = new URL(callback.headers.get("location") ?? "").searchParams.get("code");
  expect(code).toBeTruthy();

  const token = await fetch(`${OKTA_BASE}/oauth2/default/v1/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: code ?? "",
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri: REDIRECT_URI,
    }),
  });
  expect(token.status).toBe(200);
  const body = (await token.json()) as { id_token?: string };
  expect(body.id_token).toBeTruthy();
  return body.id_token ?? "";
}

async function requestIdJag(overrides: Record<string, string> = {}): Promise<Response> {
  const subjectToken = overrides.subject_token ?? (await oktaIdToken());
  return fetch(`${OKTA_BASE}/oauth2/default/v1/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: TOKEN_EXCHANGE_GRANT_TYPE,
      requested_token_type: ID_JAG_TOKEN_TYPE,
      audience: MCP_BASE,
      resource: `${MCP_BASE}/mcp`,
      scope: "repo read:user",
      subject_token_type: ID_TOKEN_TYPE,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      ...overrides,
      subject_token: subjectToken,
    }),
  });
}

async function idJag(overrides: Record<string, string> = {}): Promise<string> {
  const response = await requestIdJag(overrides);
  expect(response.status).toBe(200);
  const body = (await response.json()) as { access_token?: string };
  expect(body.access_token).toBeTruthy();
  return body.access_token ?? "";
}

function redeemAtMcp(assertion: string): Promise<Response> {
  return fetch(`${MCP_BASE}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: JWT_BEARER_GRANT_TYPE,
      assertion,
      client_id: CLIENT_ID,
    }),
  });
}

async function createPolicy(policy: Record<string, unknown>): Promise<string> {
  const response = await fetch(`${OKTA_BASE}/api/v1/tokenExchangePolicies`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `SSWS ${OKTA_API_TOKEN}` },
    body: JSON.stringify(policy),
  });
  expect(response.status).toBe(201);
  const created = (await response.json()) as { id: string };
  return created.id;
}

async function deletePolicy(policyId: string): Promise<void> {
  const response = await fetch(`${OKTA_BASE}/api/v1/tokenExchangePolicies/${policyId}`, {
    method: "DELETE",
    headers: { authorization: `SSWS ${OKTA_API_TOKEN}` },
  });
  expect(response.status).toBe(204);
}

describe("MCP enterprise-managed authorization with Okta as the IdP", () => {
  it("advertises the profile on both ends", async () => {
    const oktaMeta = (await (await fetch(`${OKTA_ISSUER}/.well-known/oauth-authorization-server`)).json()) as Record<
      string,
      unknown
    >;
    expect(oktaMeta.issuer).toBe(OKTA_ISSUER);
    expect(oktaMeta.grant_types_supported).toContain(TOKEN_EXCHANGE_GRANT_TYPE);
    expect(oktaMeta.identity_chaining_requested_token_types_supported).toEqual([ID_JAG_TOKEN_TYPE]);

    const mcpMeta = (await (await fetch(`${MCP_BASE}/.well-known/oauth-authorization-server`)).json()) as Record<
      string,
      unknown
    >;
    expect(mcpMeta.authorization_grant_profiles_supported).toContain("urn:ietf:params:oauth:grant-profile:id-jag");
  });

  it("exchanges an Okta ID token into an MCP access token and uses it", async () => {
    const assertion = await idJag();
    const claims = decodeJwt(assertion);
    expect(claims).toMatchObject({
      iss: OKTA_ISSUER,
      aud: MCP_BASE,
      resource: `${MCP_BASE}/mcp`,
      client_id: CLIENT_ID,
      email: USER_LOGIN,
      scope: "repo read:user",
    });

    const mcpTokenResponse = await redeemAtMcp(assertion);
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
    expect(rpc.result?.structuredContent).toMatchObject({ login: "admin", email: USER_LOGIN });

    const oktaExchange = oktaLedger.list().find((entry) => entry.operationId === "okta.oauth.tokenExchange");
    expect(oktaExchange).toBeTruthy();
    expect(oktaExchange?.response.status).toBe(200);
    expect(oktaExchange?.request.body).toMatchObject({
      grant_type: TOKEN_EXCHANGE_GRANT_TYPE,
      audience: MCP_BASE,
      resource: `${MCP_BASE}/mcp`,
      client_id: CLIENT_ID,
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

  it("rejects an ID-JAG minted for a different audience", async () => {
    const assertion = await idJag({ audience: "https://other-authorization-server.example" });
    expect(decodeJwt(assertion).aud).toBe("https://other-authorization-server.example");

    const response = await redeemAtMcp(assertion);
    expect(response.status).toBe(400);
    expect((await response.json()) as Record<string, unknown>).toMatchObject({ error: "invalid_grant" });
  });

  it("rejects an ID-JAG minted for a different resource", async () => {
    const assertion = await idJag({ resource: "https://other-resource.example/mcp" });
    const response = await redeemAtMcp(assertion);
    expect(response.status).toBe(400);
    expect((await response.json()) as { error_description?: string }).toMatchObject({
      error: "invalid_grant",
      error_description: "Assertion resource does not match this MCP server.",
    });
  });

  it("rejects an expired ID-JAG", async () => {
    const assertion = await idJag();
    expect((await redeemAtMcp(assertion)).status).toBe(200);
    try {
      // Only Date is faked so the two HTTP servers keep their real timers.
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(Date.now() + 10 * 60 * 1000);
      const response = await redeemAtMcp(assertion);
      expect(response.status).toBe(400);
      expect((await response.json()) as Record<string, unknown>).toMatchObject({ error: "invalid_grant" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects an assertion with the wrong typ", async () => {
    // The ID token is signed by the same Okta key but carries typ JWT, so the
    // MCP server must refuse it before it ever checks the signature.
    const response = await redeemAtMcp(await oktaIdToken());
    expect(response.status).toBe(400);
    expect((await response.json()) as { error_description?: string }).toMatchObject({
      error: "invalid_grant",
      error_description: "Assertion typ must be oauth-id-jag+jwt.",
    });
  });

  it("refuses to mint an ID-JAG from a subject token the IdP did not issue", async () => {
    const response = await requestIdJag({ subject_token: "not.a.token" });
    expect(response.status).toBe(400);
    expect((await response.json()) as Record<string, unknown>).toMatchObject({ error: "invalid_grant" });
  });

  it("narrows the MCP access token scope to what administrator policy allows", async () => {
    const policyId = await createPolicy({
      name: "Read only for the MCP server",
      client_id: CLIENT_ID,
      audience: MCP_BASE,
      resource: `${MCP_BASE}/mcp`,
      scopes: ["read:user"],
      effect: "ALLOW",
    });
    try {
      const exchange = await requestIdJag();
      expect(exchange.status).toBe(200);
      const exchanged = (await exchange.json()) as { access_token: string; scope?: string };
      expect(exchanged.scope).toBe("read:user");
      expect(decodeJwt(exchanged.access_token).scope).toBe("read:user");

      const mcpTokenResponse = await redeemAtMcp(exchanged.access_token);
      expect(mcpTokenResponse.status).toBe(200);
      const mcpToken = (await mcpTokenResponse.json()) as { access_token: string; scope?: string };
      expect(mcpToken.scope).toBe("read:user");

      const toolCall = await fetch(`${MCP_BASE}/mcp`, {
        method: "POST",
        headers: { authorization: `Bearer ${mcpToken.access_token}`, "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_me" } }),
      });
      expect(toolCall.status).toBe(200);
      // The ledger lists newest first.
      const narrowed = mcpLedger.list().find((entry) => entry.path === "/mcp" && entry.method === "POST");
      expect(narrowed?.identity.user).toMatchObject({ login: "admin", scopes: ["read:user"] });
    } finally {
      await deletePolicy(policyId);
    }
  });

  it("denies the exchange when administrator policy blocks the client", async () => {
    const allowId = await createPolicy({ name: "Allow everything", effect: "ALLOW" });
    const denyId = await createPolicy({ name: "Block the desktop client", client_id: CLIENT_ID, effect: "DENY" });
    try {
      const response = await requestIdJag();
      expect(response.status).toBe(400);
      expect((await response.json()) as Record<string, unknown>).toMatchObject({ error: "invalid_target" });

      const denied = oktaLedger.list().find((entry) => entry.operationId === "okta.oauth.tokenExchange");
      expect(denied?.response.status).toBe(400);
    } finally {
      await deletePolicy(denyId);
      await deletePolicy(allowId);
    }
  });
});
