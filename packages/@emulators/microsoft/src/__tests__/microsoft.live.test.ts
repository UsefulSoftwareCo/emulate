import { describe, expect, it } from "vitest";
import { Hono, Store, WebhookDispatcher, authMiddleware, type TokenMap } from "@emulators/core";
import { microsoftPlugin, seedFromConfig } from "../index.js";

const base = "http://localhost:4000";
const tenantId = process.env.MICROSOFT_LIVE_TENANT_ID;
const clientId = process.env.MICROSOFT_LIVE_CLIENT_ID;
const clientSecret = process.env.MICROSOFT_LIVE_CLIENT_SECRET;
const delegatedAccessToken = process.env.MICROSOFT_LIVE_DELEGATED_ACCESS_TOKEN;

const describeClientCredentials = tenantId && clientId && clientSecret ? describe : describe.skip;
const describeDelegated = delegatedAccessToken ? describe : describe.skip;

function createLiveComparisonApp() {
  const store = new Store();
  const webhooks = new WebhookDispatcher();
  const tokenMap: TokenMap = new Map();
  const app = new Hono();

  app.use("*", authMiddleware(tokenMap));
  microsoftPlugin.register(app as any, store, webhooks, base, tokenMap);
  microsoftPlugin.seed?.(store, base);
  seedFromConfig(store, base, {
    users: [{ email: "live-user@example.com", name: "Live User" }],
    oauth_clients: [
      {
        client_id: "live-client",
        client_secret: "live-secret",
        name: "Live Comparison App",
        redirect_uris: ["http://localhost:3000/callback"],
      },
    ],
  });

  return { app };
}

describeClientCredentials("Microsoft live client credentials parity", () => {
  it("matches the real token endpoint response shape", async () => {
    const realTokenRes = await fetch(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: clientId!,
        client_secret: clientSecret!,
        scope: "https://graph.microsoft.com/.default",
      }),
    });
    expect(realTokenRes.status).toBe(200);
    const realToken = (await realTokenRes.json()) as Record<string, unknown>;
    expect(realToken).toMatchObject({
      token_type: "Bearer",
      expires_in: expect.any(Number),
      access_token: expect.any(String),
    });
    expect(realToken.refresh_token).toBeUndefined();
    expect(realToken.id_token).toBeUndefined();

    const { app } = createLiveComparisonApp();
    const emulatorTokenRes = await app.request(`${base}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: "live-client",
        client_secret: "live-secret",
        scope: "https://graph.microsoft.com/.default",
      }),
    });
    expect(emulatorTokenRes.status).toBe(200);
    const emulatorToken = (await emulatorTokenRes.json()) as Record<string, unknown>;
    expect(emulatorToken).toMatchObject({
      token_type: "Bearer",
      expires_in: expect.any(Number),
      access_token: expect.any(String),
      scope: "https://graph.microsoft.com/.default",
    });
    expect(emulatorToken.refresh_token).toBeUndefined();
    expect(emulatorToken.id_token).toBeUndefined();
  });

  it.runIf(process.env.MICROSOFT_LIVE_VALIDATE_USERS === "1")("compares app-only /users response shape", async () => {
    const realTokenRes = await fetch(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: clientId!,
        client_secret: clientSecret!,
        scope: "https://graph.microsoft.com/.default",
      }),
    });
    expect(realTokenRes.status).toBe(200);
    const realToken = (await realTokenRes.json()) as { access_token: string };

    const realUsersRes = await fetch("https://graph.microsoft.com/v1.0/users?$top=1", {
      headers: { Authorization: `Bearer ${realToken.access_token}` },
    });
    expect(realUsersRes.status).toBe(200);
    const realUsers = (await realUsersRes.json()) as { value: unknown[]; "@odata.context"?: string };
    expect(realUsers["@odata.context"]).toEqual(expect.any(String));
    expect(Array.isArray(realUsers.value)).toBe(true);

    const { app } = createLiveComparisonApp();
    const emulatorTokenRes = await app.request(`${base}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: "live-client",
        client_secret: "live-secret",
        scope: "https://graph.microsoft.com/.default",
      }),
    });
    const emulatorToken = (await emulatorTokenRes.json()) as { access_token: string };
    const emulatorUsersRes = await app.request(`${base}/v1.0/users?$top=1`, {
      headers: { Authorization: `Bearer ${emulatorToken.access_token}` },
    });
    expect(emulatorUsersRes.status).toBe(200);
    const emulatorUsers = (await emulatorUsersRes.json()) as { value: unknown[]; "@odata.context"?: string };
    expect(emulatorUsers["@odata.context"]).toEqual(expect.any(String));
    expect(Array.isArray(emulatorUsers.value)).toBe(true);
  });
});

describeDelegated("Microsoft live delegated Graph parity", () => {
  it("compares /me response shape", async () => {
    const realMeRes = await fetch("https://graph.microsoft.com/v1.0/me", {
      headers: { Authorization: `Bearer ${delegatedAccessToken}` },
    });
    expect(realMeRes.status).toBe(200);
    const realMe = (await realMeRes.json()) as Record<string, unknown>;
    expect(realMe).toMatchObject({
      id: expect.any(String),
      displayName: expect.any(String),
      userPrincipalName: expect.any(String),
    });

    const { app } = createLiveComparisonApp();
    const authCodeRes = await app.request(`${base}/oauth2/v2.0/authorize/callback`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        email: "live-user@example.com",
        redirect_uri: "http://localhost:3000/callback",
        scope: "openid email profile User.Read",
        state: "live-state",
        nonce: "live-nonce",
        client_id: "live-client",
        response_mode: "query",
        code_challenge: "",
        code_challenge_method: "",
      }),
    });
    const location = authCodeRes.headers.get("location") ?? "";
    const code = new URL(location).searchParams.get("code") ?? "";
    const tokenRes = await app.request(`${base}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: "live-client",
        client_secret: "live-secret",
        redirect_uri: "http://localhost:3000/callback",
      }),
    });
    expect(tokenRes.status).toBe(200);
    const token = (await tokenRes.json()) as { access_token: string };
    const emulatorMeRes = await app.request(`${base}/v1.0/me`, {
      headers: { Authorization: `Bearer ${token.access_token}` },
    });
    expect(emulatorMeRes.status).toBe(200);
    const emulatorMe = (await emulatorMeRes.json()) as Record<string, unknown>;
    expect(emulatorMe).toMatchObject({
      id: expect.any(String),
      displayName: expect.any(String),
      userPrincipalName: expect.any(String),
    });
  });
});
