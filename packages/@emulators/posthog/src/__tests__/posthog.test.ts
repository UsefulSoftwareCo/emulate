import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Hono, Store, WebhookDispatcher, authMiddleware, serve, type TokenMap } from "@emulators/core";

import { getPostHogStore, posthogPlugin } from "../index.js";

const PORT = 41875;
const BASE = `http://localhost:${PORT}`;

let httpServer: ReturnType<typeof serve>;
let app: Hono;
let store: Store;

function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

beforeAll(() => {
  store = new Store();
  const webhooks = new WebhookDispatcher();
  const tokenMap: TokenMap = new Map();
  tokenMap.set("phx_personal", { login: "admin@example.com", id: 1, scopes: ["project:read"] });

  app = new Hono();
  app.use("*", authMiddleware(tokenMap));
  app.get("/client-id-metadata.json", (c) =>
    c.json({
      client_id: `${BASE}/client-id-metadata.json`,
      client_name: "Executor Test Client",
      redirect_uris: [`${BASE}/callback`],
      grant_types: ["authorization_code"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      application_type: "web",
    }),
  );
  posthogPlugin.register(app as any, store, webhooks, BASE, tokenMap);
  posthogPlugin.seed?.(store, BASE);
  httpServer = serve({ fetch: app.fetch, port: PORT });
});

afterAll(async () => {
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
});

describe("PostHog emulator OAuth discovery", () => {
  it("serves a PostHog-like bearer OpenAPI spec", async () => {
    const response = await fetch(`${BASE}/api/schema/`);
    expect(response.status).toBe(200);
    const spec = (await response.json()) as any;
    expect(spec.info.title).toBe("PostHog API");
    expect(spec.components.securitySchemes.PersonalAPIKeyAuth).toMatchObject({
      type: "http",
      scheme: "bearer",
    });
    expect(spec.paths["/api/projects/"].get.security).toEqual([{ PersonalAPIKeyAuth: ["project:read"] }]);
    expect(spec.components.securitySchemes.DiscoveredOAuth2).toBeUndefined();
  });

  it("advertises CIMD through OAuth metadata", async () => {
    const protectedResource = (await (await fetch(`${BASE}/.well-known/oauth-protected-resource`)).json()) as any;
    expect(protectedResource.resource).toBe(BASE);
    expect(protectedResource.authorization_servers).toEqual([BASE]);

    const authServer = (await (await fetch(`${BASE}/.well-known/oauth-authorization-server`)).json()) as any;
    expect(authServer.authorization_endpoint).toBe(`${BASE}/oauth/authorize/`);
    expect(authServer.token_endpoint).toBe(`${BASE}/oauth/token/`);
    expect(authServer.registration_endpoint).toBe(`${BASE}/oauth/register/`);
    expect(authServer.client_id_metadata_document_supported).toBe(true);
    expect(authServer.code_challenge_methods_supported).toContain("S256");
  });

  it("rejects non-HTTPS, non-loopback CIMD client IDs like PostHog", async () => {
    const params = new URLSearchParams({
      client_id: "http://100.81.219.45:42384/api/oauth/client-id-metadata.json",
      redirect_uri: `${BASE}/callback`,
      response_type: "code",
      scope: "project:read",
      resource: BASE,
    });

    const response = await fetch(`${BASE}/oauth/authorize/?${params}`);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "invalid_request",
      error_description: "Invalid client_id parameter value.",
    });
  });

  it("completes authorization code flow with a loopback CIMD client and calls the API", async () => {
    const verifier = "test-code-verifier";
    const params = new URLSearchParams({
      client_id: `${BASE}/client-id-metadata.json`,
      redirect_uri: `${BASE}/callback`,
      response_type: "code",
      scope: "project:read user:read",
      state: "state-123",
      code_challenge_method: "S256",
      code_challenge: pkceChallenge(verifier),
      resource: BASE,
    });

    const authorize = await fetch(`${BASE}/oauth/authorize/?${params}`);
    expect(authorize.status).toBe(200);
    await expect(authorize.text()).resolves.toContain("Executor Test Client");

    const user = getPostHogStore(store).users.all()[0]!;
    const approval = await fetch(`${BASE}/oauth/authorize/approve`, {
      method: "POST",
      redirect: "manual",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        user_uuid: user.uuid,
        client_id: `${BASE}/client-id-metadata.json`,
        redirect_uri: `${BASE}/callback`,
        state: "state-123",
        scope: "project:read user:read",
        code_challenge_method: "S256",
        code_challenge: pkceChallenge(verifier),
      }),
    });
    expect(approval.status).toBe(302);
    const location = new URL(approval.headers.get("location")!);
    expect(location.searchParams.get("state")).toBe("state-123");
    const code = location.searchParams.get("code")!;
    expect(code).toMatch(/^code_/);

    const tokenResponse = await fetch(`${BASE}/oauth/token/`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: `${BASE}/client-id-metadata.json`,
        redirect_uri: `${BASE}/callback`,
        code_verifier: verifier,
      }),
    });
    expect(tokenResponse.status).toBe(200);
    const tokenBody = (await tokenResponse.json()) as any;
    expect(tokenBody.access_token).toMatch(/^phx_/);

    const projects = await fetch(`${BASE}/api/projects/`, {
      headers: { Authorization: `Bearer ${tokenBody.access_token}` },
    });
    expect(projects.status).toBe(200);
    await expect(projects.json()).resolves.toMatchObject({
      results: [{ id: 1, name: "Demo Project" }],
    });
  });
});
