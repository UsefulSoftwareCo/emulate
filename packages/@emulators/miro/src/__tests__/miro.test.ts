import { createHash, randomBytes } from "crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decodeProtectedHeader, jwtVerify } from "jose";
import { createServer, serve, type Store } from "@emulators/core";

import { miroPlugin, seedFromConfig } from "../index.js";
import { manifest } from "../manifest.js";

const PORT = 41933;
const BASE = `http://localhost:${PORT}`;
const REDIRECT = "http://127.0.0.1:8765/callback";
const SCOPES = ["boards:read", "boards:write", "openid", "email"];
const GRANTS = ["authorization_code", "refresh_token", "urn:ietf:params:oauth:grant-type:jwt-bearer"];

let httpServer: ReturnType<typeof serve>;
let store: Store;

beforeAll(() => {
  const server = createServer(miroPlugin, { port: PORT, baseUrl: BASE, manifest });
  store = server.store;
  miroPlugin.seed?.(store, BASE);
  httpServer = serve({ fetch: server.app.fetch, port: PORT });
});

afterAll(() => {
  httpServer.close();
});

interface Registration {
  client_id: string;
  client_secret: string;
  [key: string]: unknown;
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
  scope: string;
  id_token?: string;
}

async function register(body: Record<string, unknown> = {}): Promise<Registration> {
  const res = await fetch(`${BASE}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "Executor", redirect_uris: [REDIRECT], ...body }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as Registration;
}

const pkce = () => {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
};

/** Load the consent page, then submit the user button form the way a browser would. */
async function authorize(clientId: string, challenge: string, extra: Record<string, string> = {}): Promise<URL> {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT,
    response_type: "code",
    state: "state-123",
    scope: "boards:read openid email",
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: `${BASE}/`,
    ...extra,
  });
  const page = await fetch(`${BASE}/authorize?${params}`);
  expect(page.status).toBe(200);
  const html = await page.text();
  expect(html).toContain(`action="${BASE}/authorize"`);
  expect(html).toContain("user@example.com");

  const approve = await fetch(`${BASE}/authorize`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...Object.fromEntries(params), login: "user@example.com" }),
    redirect: "manual",
  });
  expect(approve.status).toBe(302);
  return new URL(approve.headers.get("location")!);
}

function tokenRequest(fields: Record<string, string>, authorization?: string): Promise<Response> {
  return fetch(`${BASE}/token`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      ...(authorization ? { authorization } : {}),
    },
    body: new URLSearchParams(fields),
  });
}

const basic = (id: string, secret: string) => `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`;

/** Register, consent, and exchange the code with client_secret_post. */
async function signIn(extra: Record<string, string> = {}) {
  const client = await register();
  const { verifier, challenge } = pkce();
  const redirect = await authorize(client.client_id, challenge, extra);
  const res = await tokenRequest({
    grant_type: "authorization_code",
    code: redirect.searchParams.get("code")!,
    redirect_uri: REDIRECT,
    code_verifier: verifier,
    client_id: client.client_id,
    client_secret: client.client_secret,
  });
  expect(res.status).toBe(200);
  return { client, tokens: (await res.json()) as TokenResponse };
}

const mcp = (body: unknown, token?: string) =>
  fetch(`${BASE}/`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });

describe("discovery documents", () => {
  it("serves the RFC 8414 document exactly as Miro does", async () => {
    const res = await fetch(`${BASE}/.well-known/oauth-authorization-server`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      issuer: `${BASE}/`,
      authorization_endpoint: `${BASE}/authorize`,
      token_endpoint: `${BASE}/token`,
      registration_endpoint: `${BASE}/register`,
      scopes_supported: SCOPES,
      response_types_supported: ["code"],
      grant_types_supported: GRANTS,
      token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic"],
      service_documentation: "https://developers.miro.com/docs/miro-mcp#installing-miro-mcp-team-selection",
      code_challenge_methods_supported: ["S256"],
    });
  });

  it("serves the OIDC document with its real disagreements", async () => {
    const res = await fetch(`${BASE}/.well-known/openid-configuration`);
    expect(res.status).toBe(200);
    const doc = (await res.json()) as Record<string, unknown>;
    expect(doc).toEqual({
      issuer: `${BASE}/`,
      token_endpoint: `${BASE}/token`,
      token_endpoint_auth_methods_supported: ["none"],
      grant_types_supported: GRANTS,
      authorization_endpoint: `${BASE}/authorize`,
      registration_endpoint: `${BASE}/register`,
      response_types_supported: ["code"],
      subject_types_supported: ["public"],
      id_token_signing_alg_values_supported: ["HS256"],
      scopes_supported: SCOPES,
      claims_supported: ["iss", "sub", "aud", "exp", "iat", "email", "email_verified"],
      code_challenge_methods_supported: ["S256"],
      revocation_endpoint: `${BASE}/oidc/revoke`,
      audience: BASE,
    });
    expect(doc).not.toHaveProperty("jwks_uri");
  });

  it("serves protected resource metadata for the origin root", async () => {
    const res = await fetch(`${BASE}/.well-known/oauth-protected-resource`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      resource: `${BASE}/`,
      authorization_servers: [`${BASE}/`],
      scopes_supported: SCOPES,
      bearer_methods_supported: ["header"],
    });
  });
});

describe("dynamic client registration", () => {
  it("issues a confidential client", async () => {
    const client = await register();
    expect(client).toMatchObject({
      client_name: "Executor",
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: "client_secret_post",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      scope: SCOPES.join(" "),
    });
    expect(client.client_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(client.client_secret).toMatch(/^[0-9a-f]{64}$/);
    expect(typeof client.client_id_issued_at).toBe("number");
  });

  it("reports validation errors with Miro's messages", async () => {
    const post = (body: unknown) =>
      fetch(`${BASE}/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const missing = await post({});
    expect(missing.status).toBe(400);
    expect(await missing.json()).toEqual({
      error: "invalid_client_metadata",
      error_description: "redirect_uris: Field required",
    });
    const notList = await post({ redirect_uris: "notalist" });
    expect(await notList.json()).toEqual({
      error: "invalid_client_metadata",
      error_description: "redirect_uris: Input should be a valid list",
    });
  });
});

describe("authorization endpoint", () => {
  it("reports missing fields as JSON", async () => {
    const res = await fetch(`${BASE}/authorize`);
    expect(res.status).toBe(400);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({
      error: "invalid_request",
      error_description: "client_id: Field required\nresponse_type: Field required\ncode_challenge: Field required",
    });
  });

  it("enforces S256 PKCE", async () => {
    const client = await register();
    const params = new URLSearchParams({
      client_id: "nonexistent",
      response_type: "code",
      code_challenge: "abc",
      code_challenge_method: "plain",
      redirect_uri: REDIRECT,
    });
    const res = await fetch(`${BASE}/authorize?${params}`);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "invalid_request",
      error_description: "code_challenge_method: Input should be 'S256'",
    });

    // A trusted client and redirect URI get the error on the redirect instead.
    params.set("client_id", client.client_id);
    const redirected = await fetch(`${BASE}/authorize?${params}`, { redirect: "manual" });
    expect(redirected.status).toBe(302);
    const location = new URL(redirected.headers.get("location")!);
    expect(location.searchParams.get("error")).toBe("invalid_request");

    params.delete("code_challenge");
    params.delete("code_challenge_method");
    const noChallenge = await fetch(`${BASE}/authorize?${params}`, { redirect: "manual" });
    expect(new URL(noChallenge.headers.get("location")!).searchParams.get("error_description")).toBe(
      "code_challenge: Field required",
    );
  });

  it("tells unknown clients to re-register", async () => {
    const params = new URLSearchParams({
      client_id: "nonexistent",
      response_type: "code",
      code_challenge: "abc",
      code_challenge_method: "S256",
      redirect_uri: REDIRECT,
    });
    const res = await fetch(`${BASE}/authorize?${params}`);
    expect(res.status).toBe(400);
    expect(res.headers.get("link")).toBe(`<${BASE}/register>; rel="http://oauth.net/core/2.1/#registration"`);
    const body = (await res.json()) as Record<string, string>;
    expect(body.error).toBe("invalid_request");
    expect(body.error_description).toContain("Client ID 'nonexistent' is not registered with this server.");
    expect(body.registration_endpoint).toBe(`${BASE}/register`);
  });
});

describe("authorization code flow", () => {
  it("issues tokens and an HS256 ID token without the nonce the client sent", async () => {
    const nonce = randomBytes(16).toString("base64url");
    const { client, tokens } = await signIn({ nonce });
    expect(tokens).toMatchObject({ token_type: "Bearer", expires_in: 3600, scope: "boards:read openid email" });
    expect(tokens.access_token).toBeTruthy();
    expect(tokens.refresh_token).toBeTruthy();
    expect(tokens.id_token).toBeTruthy();

    expect(decodeProtectedHeader(tokens.id_token!).alg).toBe("HS256");
    const { payload } = await jwtVerify(tokens.id_token!, new TextEncoder().encode(client.client_secret), {
      algorithms: ["HS256"],
      issuer: `${BASE}/`,
      audience: client.client_id,
    });
    expect(payload).toMatchObject({ email: "user@example.com", email_verified: true });
    expect(typeof payload.sub).toBe("string");
    expect(typeof payload.iat).toBe("number");
    expect(typeof payload.exp).toBe("number");
    // Miro's real quirk: the nonce from the authorization request is dropped.
    expect(payload).not.toHaveProperty("nonce");
    expect(Object.keys(payload).sort()).toEqual(["aud", "email", "email_verified", "exp", "iat", "iss", "sub"]);
  });

  it("echoes the nonce when the instance is seeded with id_token_nonce: echo", async () => {
    seedFromConfig(store, BASE, { id_token_nonce: "echo" });
    try {
      const { client, tokens } = await signIn({ nonce: "n-0S6_WzA2Mj" });
      const { payload } = await jwtVerify(tokens.id_token!, new TextEncoder().encode(client.client_secret));
      expect(payload.nonce).toBe("n-0S6_WzA2Mj");
    } finally {
      seedFromConfig(store, BASE, { id_token_nonce: "omit" });
    }
  });

  it("accepts client_secret_basic and rejects a wrong verifier", async () => {
    const client = await register({ token_endpoint_auth_method: "client_secret_basic" });
    const { verifier, challenge } = pkce();
    const code = (await authorize(client.client_id, challenge)).searchParams.get("code")!;
    const auth = basic(client.client_id, client.client_secret);
    const wrong = await tokenRequest(
      { grant_type: "authorization_code", code, redirect_uri: REDIRECT, code_verifier: "x".repeat(43) },
      auth,
    );
    expect(wrong.status).toBe(400);
    expect(await wrong.json()).toEqual({ error: "invalid_grant", error_description: "incorrect code_verifier" });

    const ok = await tokenRequest(
      { grant_type: "authorization_code", code, redirect_uri: REDIRECT, code_verifier: verifier },
      auth,
    );
    expect(ok.status).toBe(200);
    const replay = await tokenRequest(
      { grant_type: "authorization_code", code, redirect_uri: REDIRECT, code_verifier: verifier },
      auth,
    );
    expect(replay.status).toBe(400);
  });

  it("authenticates the client before anything else", async () => {
    const missing = await tokenRequest({});
    expect(missing.status).toBe(401);
    expect(missing.headers.get("cache-control")).toBe("no-store");
    expect(missing.headers.get("pragma")).toBe("no-cache");
    expect(await missing.json()).toEqual({ error: "invalid_client", error_description: "Missing client_id" });

    const unknown = await tokenRequest({ grant_type: "password", client_id: "nonexistent" });
    expect(unknown.status).toBe(401);
    expect(await unknown.json()).toEqual({ error: "invalid_client", error_description: "Invalid client_id" });

    const client = await register();
    const badSecret = await tokenRequest({ grant_type: "authorization_code", code: "x" }, basic(client.client_id, "x"));
    expect(badSecret.status).toBe(401);
  });

  it("omits the ID token when openid was not granted", async () => {
    const client = await register();
    const { verifier, challenge } = pkce();
    const code = (await authorize(client.client_id, challenge, { scope: "boards:read" })).searchParams.get("code")!;
    const res = await tokenRequest({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT,
      code_verifier: verifier,
      client_id: client.client_id,
      client_secret: client.client_secret,
    });
    const body = (await res.json()) as TokenResponse;
    expect(body.scope).toBe("boards:read");
    expect(body).not.toHaveProperty("id_token");
  });
});

describe("refresh and revocation", () => {
  it("rotates the refresh token", async () => {
    const { client, tokens } = await signIn();
    const creds = { client_id: client.client_id, client_secret: client.client_secret };
    const refreshed = await tokenRequest({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      ...creds,
    });
    expect(refreshed.status).toBe(200);
    const next = (await refreshed.json()) as TokenResponse;
    expect(next.access_token).not.toBe(tokens.access_token);
    expect(next.refresh_token).not.toBe(tokens.refresh_token);
    expect(next.scope).toBe(tokens.scope);
    const { payload } = await jwtVerify(next.id_token!, new TextEncoder().encode(client.client_secret));
    expect(payload).not.toHaveProperty("nonce");

    const replay = await tokenRequest({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, ...creds });
    expect(replay.status).toBe(400);
    expect(await replay.json()).toEqual({ error: "invalid_grant", error_description: "refresh token does not exist" });
    expect((await mcp({ jsonrpc: "2.0", id: 1, method: "ping" }, tokens.access_token)).status).toBe(401);
    expect((await mcp({ jsonrpc: "2.0", id: 1, method: "ping" }, next.access_token)).status).toBe(200);
  });

  it("revokes tokens at /oidc/revoke", async () => {
    const empty = await fetch(`${BASE}/oidc/revoke`, { method: "POST" });
    expect(empty.status).toBe(200);
    expect(await empty.text()).toBe("");

    const { client, tokens } = await signIn();
    expect((await mcp({ jsonrpc: "2.0", id: 1, method: "ping" }, tokens.access_token)).status).toBe(200);
    const revoked = await fetch(`${BASE}/oidc/revoke`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        token: tokens.access_token,
        client_id: client.client_id,
        client_secret: client.client_secret,
      }),
    });
    expect(revoked.status).toBe(200);
    expect((await mcp({ jsonrpc: "2.0", id: 1, method: "ping" }, tokens.access_token)).status).toBe(401);
    const refresh = await tokenRequest({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      client_id: client.client_id,
      client_secret: client.client_secret,
    });
    expect(refresh.status).toBe(400);
  });
});

describe("MCP server", () => {
  const challenge = `Bearer resource_metadata="${BASE}/.well-known/oauth-protected-resource"`;

  it("challenges unauthenticated requests like Miro's gateway", async () => {
    const res = await mcp({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(challenge);
    expect(await res.json()).toEqual({ error: "Authentication required" });

    const invalid = await mcp({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, "not-a-token");
    expect(invalid.status).toBe(401);

    for (const path of ["/", "/.well-known/oauth-protected-resource/", "/.well-known/jwks.json"]) {
      const probe = await fetch(`${BASE}${path}`);
      expect(probe.status).toBe(401);
      expect(probe.headers.get("www-authenticate")).toBe(challenge);
    }
  });

  it("keeps the control plane reachable behind the gateway catch all", async () => {
    const res = await fetch(`${BASE}/_emulate/manifest`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { manifest: { id: string } }).manifest.id).toBe("miro");
    const state = await fetch(`${BASE}/_emulate/state`);
    expect(state.status).toBe(200);
  });

  it("lists and calls board tools with an issued token", async () => {
    const { tokens } = await signIn();
    const init = await mcp(
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
      tokens.access_token,
    );
    expect(init.status).toBe(200);
    expect(((await init.json()) as { result: { protocolVersion: string } }).result.protocolVersion).toBe("2025-06-18");

    const list = await mcp({ jsonrpc: "2.0", id: 2, method: "tools/list" }, tokens.access_token);
    const tools = ((await list.json()) as { result: { tools: Array<{ name: string }> } }).result.tools;
    expect(tools.map((t) => t.name)).toEqual(["board_search_boards", "canvas_search"]);

    const search = await mcp(
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "board_search_boards", arguments: {} } },
      tokens.access_token,
    );
    const boards = (
      (await search.json()) as { result: { structuredContent: { boards: Array<{ id: string; name: string }> } } }
    ).result.structuredContent.boards;
    expect(boards.map((b) => b.name)).toEqual(["Product Roadmap", "Retro"]);

    const canvas = await mcp(
      {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "canvas_search", arguments: { board_id: boards[0].id, query: "oauth" } },
      },
      tokens.access_token,
    );
    const items = ((await canvas.json()) as { result: { structuredContent: { items: Array<{ content: string }> } } })
      .result.structuredContent.items;
    expect(items.map((i) => i.content)).toEqual(["Ship OAuth for MCP"]);
  });
});
