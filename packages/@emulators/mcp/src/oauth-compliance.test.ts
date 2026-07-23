import { describe, expect, it } from "vitest";
import { Hono, Store, WebhookDispatcher, type TokenMap } from "@emulators/core";
import { mcpPlugin, seedFromConfig, type McpOAuthConfig } from "./index.js";
import { getOAuthClients, getPendingCodes } from "./oauth-store.js";

const base = "http://localhost:4000";
const redirectUri = "http://localhost:3000/callback";
const jwtBearerGrantType = "urn:ietf:params:oauth:grant-type:jwt-bearer";

function createApp(oauth?: McpOAuthConfig) {
  const store = new Store();
  const webhooks = new WebhookDispatcher();
  const tokenMap: TokenMap = new Map();
  const app = new Hono();
  mcpPlugin.register(app as never, store, webhooks, base, tokenMap);
  mcpPlugin.seed?.(store, base);
  if (oauth) seedFromConfig(store, base, { oauth });
  return { app, store };
}

async function getJson(app: Hono, path: string): Promise<Record<string, unknown>> {
  const response = await app.request(path);
  expect(response.status).toBe(200);
  return (await response.json()) as Record<string, unknown>;
}

async function registerClient(
  app: Hono,
  tokenEndpointAuthMethod: string,
  clientName = "Executor test client",
): Promise<{ client_id: string; client_secret?: string; token_endpoint_auth_method: string }> {
  const response = await app.request("/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      redirect_uris: [redirectUri],
      client_name: clientName,
      token_endpoint_auth_method: tokenEndpointAuthMethod,
    }),
  });
  expect(response.status).toBe(201);
  return (await response.json()) as {
    client_id: string;
    client_secret?: string;
    token_endpoint_auth_method: string;
  };
}

async function approveClient(app: Hono, clientId: string): Promise<string> {
  const response = await app.request("/authorize/approve", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: "repo",
      login: "admin",
    }).toString(),
  });
  expect(response.status).toBe(302);
  return new URL(response.headers.get("location") ?? "").searchParams.get("code") ?? "";
}

function basicAuthorization(clientId: string, clientSecret: string): string {
  const encoded = Buffer.from(`${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`).toString("base64");
  return `Basic ${encoded}`;
}

describe("MCP OAuth compliance scenario metadata", () => {
  it("advertises issuer and resource overrides while keeping real endpoint URLs", async () => {
    const { app } = createApp({
      issuerOverride: "https://evil.example.com",
      resourceOverride: "https://other.example.com/mcp",
    });

    for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
      expect((await getJson(app, path)).resource).toBe("https://other.example.com/mcp");
    }
    for (const path of ["/.well-known/oauth-authorization-server", "/.well-known/oauth-authorization-server/mcp"]) {
      const metadata = await getJson(app, path);
      expect(metadata.issuer).toBe("https://evil.example.com");
      expect(metadata.authorization_endpoint).toBe(`${base}/authorize`);
      expect(metadata.token_endpoint).toBe(`${base}/token`);
    }
  });

  it("advertises an exact auth-method list and applies live re-seeding to omit it", async () => {
    const { app, store } = createApp({ tokenEndpointAuthMethods: ["client_secret_basic"] });
    const initial = await getJson(app, "/.well-known/oauth-authorization-server");
    expect(initial.token_endpoint_auth_methods_supported).toEqual(["client_secret_basic"]);

    seedFromConfig(store, base, { oauth: { tokenEndpointAuthMethods: "omit" } });
    const reseeded = await getJson(app, "/.well-known/oauth-authorization-server");
    expect(reseeded).not.toHaveProperty("token_endpoint_auth_methods_supported");
  });
});

describe("MCP OAuth dynamic client registration scenarios", () => {
  it("rejects client_name matches case-insensitively", async () => {
    const { app } = createApp({ rejectClientNameContaining: "GitHub" });
    const response = await app.request("/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: [redirectUri], client_name: "executor for github" }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "invalid_client_metadata",
      error_description: 'client_name must not contain "GitHub".',
    });
  });

  it("substitutes the stored and returned auth method and mints a secret", async () => {
    const { app } = createApp({ dcrAuthMethodOverride: "client_secret_basic" });
    const client = await registerClient(app, "none");

    expect(client.token_endpoint_auth_method).toBe("client_secret_basic");
    expect(client.client_secret).toBeTruthy();
  });
});

describe("MCP OAuth token endpoint client authentication", () => {
  it("accepts HTTP Basic and rejects a form secret for a basic client", async () => {
    const { app } = createApp({ dcrAuthMethodOverride: "client_secret_basic" });
    const client = await registerClient(app, "none");
    const code = await approveClient(app, client.client_id);
    expect(code).toBeTruthy();

    const formResponse = await app.request("/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: client.client_id,
        client_secret: client.client_secret ?? "",
      }).toString(),
    });
    expect(formResponse.status).toBe(401);
    expect(await formResponse.json()).toMatchObject({
      error: "invalid_client",
      error_description: expect.stringContaining("HTTP Basic"),
    });

    const basicResponse = await app.request("/token", {
      method: "POST",
      headers: {
        authorization: basicAuthorization(client.client_id, client.client_secret ?? ""),
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
      }).toString(),
    });
    expect(basicResponse.status).toBe(200);
    expect(await basicResponse.json()).toMatchObject({ token_type: "Bearer", scope: "repo" });
  });

  it("uses the same Basic authentication rules for jwt-bearer grants", async () => {
    const { app } = createApp({ dcrAuthMethodOverride: "client_secret_basic" });
    const client = await registerClient(app, "none");

    const formResponse = await app.request("/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: jwtBearerGrantType,
        client_id: client.client_id,
        client_secret: client.client_secret ?? "",
      }).toString(),
    });
    expect(formResponse.status).toBe(401);
    expect(await formResponse.json()).toMatchObject({ error_description: expect.stringContaining("HTTP Basic") });

    const basicResponse = await app.request("/token", {
      method: "POST",
      headers: {
        authorization: basicAuthorization(client.client_id, client.client_secret ?? ""),
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ grant_type: jwtBearerGrantType }).toString(),
    });
    expect(basicResponse.status).toBe(400);
    expect(await basicResponse.json()).toMatchObject({
      error: "invalid_request",
      error_description: "assertion is required.",
    });
  });

  it("keeps client_secret_post working through the form body", async () => {
    const { app } = createApp();
    const client = await registerClient(app, "client_secret_post");
    const code = await approveClient(app, client.client_id);

    const response = await app.request("/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: client.client_id,
        client_secret: client.client_secret ?? "",
      }).toString(),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ token_type: "Bearer", scope: "repo" });
  });

  it("percent-decodes client credentials from the Basic header", async () => {
    const { app, store } = createApp();
    const clientId = "client id+value/%";
    const clientSecret = "secret value+:/%";
    const code = "encoded-basic-code";
    getOAuthClients(store).set(clientId, {
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: "client_secret_basic",
      created_at: Date.now(),
    });
    getPendingCodes(store).set(code, {
      client_id: clientId,
      redirect_uri: redirectUri,
      code_challenge: null,
      code_challenge_method: null,
      resource: null,
      scope: "repo",
      login: "admin",
      userId: 1,
      created_at: Date.now(),
    });

    const response = await app.request("/token", {
      method: "POST",
      headers: {
        authorization: basicAuthorization(clientId, clientSecret),
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
      }).toString(),
    });

    expect(response.status).toBe(200);
  });
});
