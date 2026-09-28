import { createHash, randomBytes } from "crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as oauth from "oauth4webapi";
import { createServer, serve } from "@emulators/core";

import { planetscalePlugin, seedFromConfig } from "../index.js";
import { manifest } from "../manifest.js";

const PORT = 41921;
const BASE = `http://localhost:${PORT}`;
const REDIRECT = "http://127.0.0.1:8765/callback";
const INVALID_CLIENT_DESCRIPTION =
  "Client authentication failed due to unknown client, no client authentication included, or unsupported authentication method.";
const INVALID_GRANT_DESCRIPTION =
  "The provided authorization grant is invalid, expired, revoked, does not match the redirection URI used in the authorization request, or was issued to another client.";

let httpServer: ReturnType<typeof serve>;

beforeAll(() => {
  const { app, store } = createServer(planetscalePlugin, { port: PORT, baseUrl: BASE, manifest });
  planetscalePlugin.seed?.(store, BASE);
  seedFromConfig(store, BASE, {
    organizations: [{ name: "globex", databases: [{ name: "orders", kind: "postgresql" }] }],
  });
  httpServer = serve({ fetch: app.fetch, port: PORT });
});

afterAll(() => {
  httpServer.close();
});

interface Registration {
  client_id: string;
  client_secret: string;
  [key: string]: unknown;
}

async function register(body: Record<string, unknown> = {}): Promise<Registration> {
  const res = await fetch(`${BASE}/oauth/registration`, {
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

/** Drive the consent page the way a browser would: load it, then submit the user button form. */
async function authorize(clientId: string, challenge: string, state = "state-123"): Promise<URL> {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT,
    response_type: "code",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: `${BASE}/mcp/planetscale`,
  });
  const page = await fetch(`${BASE}/oauth/authorize?${params}`);
  expect(page.status).toBe(200);
  const html = await page.text();
  expect(html).toContain(`action="${BASE}/oauth/authorize"`);
  expect(html).toContain("planetscale-user");

  const approve = await fetch(`${BASE}/oauth/authorize`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...Object.fromEntries(params), login: "planetscale-user" }),
    redirect: "manual",
  });
  expect(approve.status).toBe(302);
  return new URL(approve.headers.get("location")!);
}

function tokenRequest(fields: Record<string, string>, authorization?: string): Promise<Response> {
  return fetch(`${BASE}/oauth/token`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      ...(authorization ? { authorization } : {}),
    },
    body: new URLSearchParams(fields),
  });
}

const basic = (id: string, secret: string) => `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`;

// oauth4webapi's ClientSecretBasic encoding: form url encode each half, and also
// escape the characters encodeURIComponent leaves alone, including `_` `-` `.`.
const formEncode = (value: string) =>
  encodeURIComponent(value).replace(/[!'()*._~-]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);

describe("authorization server metadata", () => {
  it("mirrors the real Doorkeeper document", async () => {
    const res = await fetch(`${BASE}/.well-known/oauth-authorization-server`);
    const doc = (await res.json()) as Record<string, unknown>;
    expect(doc).toMatchObject({
      issuer: BASE,
      authorization_endpoint: `${BASE}/oauth/authorize`,
      token_endpoint: `${BASE}/oauth/token`,
      revocation_endpoint: `${BASE}/oauth/revoke`,
      registration_endpoint: `${BASE}/oauth/registration`,
      response_types_supported: ["code"],
      token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
      code_challenge_methods_supported: ["plain", "S256"],
      authorization_response_iss_parameter_supported: true,
    });
    expect(doc.grant_types_supported).toEqual(expect.arrayContaining(["authorization_code", "refresh_token"]));
    expect(doc.scopes_supported).toEqual(expect.arrayContaining(["read_databases", "organization:read_databases"]));
  });
});

describe("dynamic client registration", () => {
  it("returns PlanetScale's client shape", async () => {
    const client = await register({ scope: "read_databases", token_endpoint_auth_method: "client_secret_basic" });
    expect(client.client_id).toMatch(/^pscale_app_[0-9a-f]{32}$/);
    expect(client.client_id).toHaveLength(43);
    expect(client.client_secret).toMatch(/^pscale_app_secret_[A-Za-z0-9_-]{43}$/);
    expect(client.client_secret).toHaveLength(61);
    expect(client).not.toHaveProperty("client_secret_expires_at");
    expect(client).toMatchObject({
      client_name: "Executor",
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: "client_secret_basic",
      response_types: ["code"],
      application_type: "web",
    });
    expect(typeof client.client_id_issued_at).toBe("number");
    // The requested scope is replaced with the default set.
    expect(client.scope).toContain("organization:read_databases");
    expect(client.scope).not.toBe("read_databases");
  });

  it("rejects redirect URIs the way Doorkeeper does", async () => {
    const cases: Array<[unknown, string]> = [
      [[], "Redirect uri can't be blank, Redirect uri is not a valid URI"],
      [["http://example.com/cb"], "Redirect uri must be an HTTPS/SSL URI."],
      [["https://example.com/cb#x"], "Redirect uri cannot contain a fragment."],
      [["not a url"], "Redirect uri must be an absolute URI., Redirect uri is not a valid URI"],
    ];
    for (const [redirect_uris, description] of cases) {
      const res = await fetch(`${BASE}/oauth/registration`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ client_name: "x", redirect_uris }),
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid_client_params", error_description: description });
    }
  });
});

describe("token endpoint client authentication", () => {
  it("accepts raw HTTP Basic credentials", async () => {
    const client = await register();
    const { verifier, challenge } = pkce();
    const redirect = await authorize(client.client_id, challenge);
    expect(redirect.searchParams.get("state")).toBe("state-123");
    expect(redirect.searchParams.get("iss")).toBe(BASE);

    const res = await tokenRequest(
      {
        grant_type: "authorization_code",
        code: redirect.searchParams.get("code")!,
        redirect_uri: REDIRECT,
        code_verifier: verifier,
        resource: `${BASE}/mcp/planetscale`,
      },
      basic(client.client_id, client.client_secret),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ token_type: "Bearer", expires_in: 7200 });
    expect(typeof body.access_token).toBe("string");
    expect(typeof body.refresh_token).toBe("string");
  });

  it("rejects a percent encoded client_id with Doorkeeper's invalid_client", async () => {
    const client = await register();
    const { verifier, challenge } = pkce();
    const redirect = await authorize(client.client_id, challenge);
    const encodedId = client.client_id.replace(/_/g, "%5F");

    const res = await tokenRequest(
      {
        grant_type: "authorization_code",
        code: redirect.searchParams.get("code")!,
        redirect_uri: REDIRECT,
        code_verifier: verifier,
      },
      basic(encodedId, client.client_secret),
    );
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(
      `Bearer realm="Doorkeeper", error="invalid_client", error_description="${INVALID_CLIENT_DESCRIPTION}"`,
    );
    expect(await res.json()).toEqual({ error: "invalid_client", error_description: INVALID_CLIENT_DESCRIPTION });

    // The ledger shows why, without leaking the secret.
    const ledger = (await (await fetch(`${BASE}/_emulate/ledger`)).json()) as {
      entries: Array<{ path: string; response: { status: number }; sideEffects: Array<{ summary?: string }> }>;
    };
    const entry = ledger.entries.find((e) => e.path === "/oauth/token" && e.response.status === 401);
    expect(entry?.sideEffects.map((s) => s.summary)).toContain(
      `client_auth method=client_secret_basic outcome=unknown_client client_id=${JSON.stringify(encodedId)} client_id_percent_encoded=true`,
    );
    expect(JSON.stringify(ledger)).not.toContain(client.client_secret);
  });

  it("rejects a percent encoded client_secret", async () => {
    const client = await register();
    const res = await tokenRequest(
      { grant_type: "authorization_code", code: "bogus", redirect_uri: REDIRECT },
      basic(client.client_id, formEncode(client.client_secret)),
    );
    expect(res.status).toBe(401);
  });

  it("answers invalid_grant for a bogus code once the client authenticates", async () => {
    const client = await register();
    const raw = await tokenRequest(
      { grant_type: "authorization_code", code: "bogus", redirect_uri: REDIRECT },
      basic(client.client_id, client.client_secret),
    );
    expect(raw.status).toBe(400);
    expect(raw.headers.get("www-authenticate")).toBe(
      `Bearer realm="Doorkeeper", error="invalid_grant", error_description="${INVALID_GRANT_DESCRIPTION}"`,
    );
    expect(await raw.json()).toEqual({ error: "invalid_grant", error_description: INVALID_GRANT_DESCRIPTION });

    const encoded = await tokenRequest(
      { grant_type: "authorization_code", code: "bogus", redirect_uri: REDIRECT },
      basic(formEncode(client.client_id), formEncode(client.client_secret)),
    );
    expect(encoded.status).toBe(401);
  });

  it("uses the Basic header even when the body carries valid credentials", async () => {
    const client = await register();
    const res = await tokenRequest(
      {
        grant_type: "authorization_code",
        code: "bogus",
        redirect_uri: REDIRECT,
        client_id: client.client_id,
        client_secret: client.client_secret,
      },
      basic(formEncode(client.client_id), formEncode(client.client_secret)),
    );
    expect(res.status).toBe(401);
  });

  it("accepts client_secret_post", async () => {
    const client = await register({ token_endpoint_auth_method: "client_secret_post" });
    const { verifier, challenge } = pkce();
    const redirect = await authorize(client.client_id, challenge);
    const res = await tokenRequest({
      grant_type: "authorization_code",
      code: redirect.searchParams.get("code")!,
      redirect_uri: REDIRECT,
      code_verifier: verifier,
      client_id: client.client_id,
      client_secret: client.client_secret,
    });
    expect(res.status).toBe(200);
  });

  it("validates parameters before the client, like the real server", async () => {
    const missing = await tokenRequest({}, basic("nobody", "nothing"));
    expect(missing.status).toBe(400);
    expect(await missing.json()).toEqual({
      error: "invalid_request",
      error_description: "Missing required parameter: grant_type.",
    });
    const unsupported = await tokenRequest({ grant_type: "password" }, basic("nobody", "nothing"));
    expect(await unsupported.json()).toMatchObject({ error: "unsupported_grant_type" });
    const noAuth = await tokenRequest({ grant_type: "authorization_code", code: "x", redirect_uri: REDIRECT });
    expect(noAuth.status).toBe(401);
  });

  it("rejects a wrong PKCE verifier and a reused code", async () => {
    const client = await register();
    const { verifier, challenge } = pkce();
    const redirect = await authorize(client.client_id, challenge);
    const code = redirect.searchParams.get("code")!;
    const auth = basic(client.client_id, client.client_secret);
    const wrong = await tokenRequest(
      { grant_type: "authorization_code", code, redirect_uri: REDIRECT, code_verifier: pkce().verifier },
      auth,
    );
    expect(wrong.status).toBe(400);
    const ok = await tokenRequest(
      { grant_type: "authorization_code", code, redirect_uri: REDIRECT, code_verifier: verifier },
      auth,
    );
    expect(ok.status).toBe(200);
    const reused = await tokenRequest(
      { grant_type: "authorization_code", code, redirect_uri: REDIRECT, code_verifier: verifier },
      auth,
    );
    expect(reused.status).toBe(400);
  });
});

describe("oauth4webapi against the emulator", () => {
  const insecure = { [oauth.allowInsecureRequests]: true };

  async function exchange(clientAuth: (secret: string) => oauth.ClientAuth): Promise<Response> {
    const issuer = new URL(BASE);
    const server = await oauth.processDiscoveryResponse(
      issuer,
      await oauth.discoveryRequest(issuer, { algorithm: "oauth2", ...insecure }),
    );
    const registered = await register();
    const client: oauth.Client = { client_id: registered.client_id };
    const { verifier, challenge } = pkce();
    const redirect = await authorize(registered.client_id, challenge, "s");
    const params = oauth.validateAuthResponse(server, client, redirect, "s");
    return oauth.authorizationCodeGrantRequest(
      server,
      client,
      clientAuth(registered.client_secret),
      params,
      REDIRECT,
      verifier,
      insecure,
    );
  }

  it("ClientSecretBasic reproduces the PlanetScale invalid_client failure", async () => {
    const response = await exchange((secret) => oauth.ClientSecretBasic(secret));
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: "invalid_client" });
  });

  it("ClientSecretPost succeeds", async () => {
    const response = await exchange((secret) => oauth.ClientSecretPost(secret));
    expect(response.status).toBe(200);
  });
});

describe("MCP server", () => {
  const MCP = `${BASE}/mcp/planetscale`;
  const rpc = (token: string | undefined, body: unknown) =>
    fetch(MCP, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
  const sse = async (res: Response) => {
    const text = await res.text();
    const data = text.split("\n").find((line) => line.startsWith("data: "));
    return JSON.parse(data!.slice(6)) as { result: Record<string, unknown> };
  };

  it("points unauthenticated clients at the protected resource metadata", async () => {
    const res = await rpc(undefined, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(
      `Bearer resource_metadata="${BASE}/.well-known/oauth-protected-resource/mcp/planetscale"`,
    );
    expect(await res.json()).toEqual({
      error: { code: -32001, message: "unauthorized access" },
      id: 1,
      jsonrpc: "2.0",
    });

    const prm = await fetch(`${BASE}/.well-known/oauth-protected-resource/mcp/planetscale`);
    expect(await prm.json()).toEqual({ resource: MCP, authorization_servers: [BASE] });
  });

  it("serves tools after the full authorize, PKCE, and token flow", async () => {
    const client = await register();
    const { verifier, challenge } = pkce();
    const redirect = await authorize(client.client_id, challenge);
    const tokenRes = await tokenRequest(
      {
        grant_type: "authorization_code",
        code: redirect.searchParams.get("code")!,
        redirect_uri: REDIRECT,
        code_verifier: verifier,
      },
      basic(client.client_id, client.client_secret),
    );
    const tokens = (await tokenRes.json()) as { access_token: string; refresh_token: string };

    const init = await sse(
      await rpc(tokens.access_token, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } },
      }),
    );
    expect(init.result.protocolVersion).toBe("2025-06-18");

    const list = await sse(await rpc(tokens.access_token, { jsonrpc: "2.0", id: 2, method: "tools/list" }));
    const names = (list.result.tools as Array<{ name: string }>).map((t) => t.name);
    expect(names).toContain("planetscale_list_organizations");
    expect(names).toContain("planetscale_list_databases");

    const dbs = await sse(
      await rpc(tokens.access_token, {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "planetscale_list_databases", arguments: { organization: "globex" } },
      }),
    );
    expect(dbs.result.structuredContent).toMatchObject({ data: [{ name: "orders", kind: "postgresql" }] });

    // Refresh rotates the token pair; the old refresh and access tokens stop working.
    const refreshed = await tokenRequest(
      { grant_type: "refresh_token", refresh_token: tokens.refresh_token },
      basic(client.client_id, client.client_secret),
    );
    expect(refreshed.status).toBe(200);
    const again = await tokenRequest(
      { grant_type: "refresh_token", refresh_token: tokens.refresh_token },
      basic(client.client_id, client.client_secret),
    );
    expect(again.status).toBe(400);
    const stale = await rpc(tokens.access_token, { jsonrpc: "2.0", id: 4, method: "tools/list" });
    expect(stale.status).toBe(401);
  });
});
