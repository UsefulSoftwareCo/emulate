import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "@emulators/core";
import { Store, WebhookDispatcher, authMiddleware, type TokenMap } from "@emulators/core";
import { microsoftPlugin, seedFromConfig, getMicrosoftStore } from "../index.js";
import { decodeJwt } from "jose";

const base = "http://localhost:4000";

function createTestApp() {
  const store = new Store();
  const webhooks = new WebhookDispatcher();
  const tokenMap: TokenMap = new Map();

  const app = new Hono();
  app.use("*", authMiddleware(tokenMap));
  microsoftPlugin.register(app as any, store, webhooks, base, tokenMap);
  microsoftPlugin.seed?.(store, base);
  seedFromConfig(store, base, {
    users: [{ email: "testuser@example.com", name: "Test User" }],
    oauth_clients: [
      {
        client_id: "test-client",
        client_secret: "test-secret",
        name: "Test App",
        redirect_uris: ["http://localhost:3000/callback"],
      },
    ],
  });

  return { app, store, webhooks, tokenMap };
}

async function getAuthCode(
  app: Hono,
  options: {
    email?: string;
    client_id?: string;
    redirect_uri?: string;
    scope?: string;
    state?: string;
    nonce?: string;
    response_mode?: string;
  } = {},
): Promise<{ code: string; state: string }> {
  const email = options.email ?? "testuser@example.com";
  const redirect_uri = options.redirect_uri ?? "http://localhost:3000/callback";
  const scope = options.scope ?? "openid email profile";
  const state = options.state ?? "test-state";
  const nonce = options.nonce ?? "test-nonce";
  const client_id = options.client_id ?? "test-client";
  const response_mode = options.response_mode ?? "query";

  const formData = new URLSearchParams({
    email,
    redirect_uri,
    scope,
    state,
    nonce,
    client_id,
    response_mode,
    code_challenge: "",
    code_challenge_method: "",
  });

  const res = await app.request(`${base}/oauth2/v2.0/authorize/callback`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: formData.toString(),
  });

  if (response_mode === "form_post") {
    const html = await res.text();
    const codeMatch = html.match(/name="code" value="([^"]+)"/);
    const stateMatch = html.match(/name="state" value="([^"]+)"/);
    return {
      code: codeMatch?.[1] ?? "",
      state: stateMatch?.[1] ?? "",
    };
  }

  const location = res.headers.get("location") ?? "";
  const url = new URL(location);
  return {
    code: url.searchParams.get("code") ?? "",
    state: url.searchParams.get("state") ?? "",
  };
}

async function exchangeCode(
  app: Hono,
  code: string,
  options: {
    client_id?: string;
    client_secret?: string;
    redirect_uri?: string;
  } = {},
): Promise<Response> {
  const formData = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: options.client_id ?? "test-client",
    client_secret: options.client_secret ?? "test-secret",
    redirect_uri: options.redirect_uri ?? "http://localhost:3000/callback",
  });

  return app.request(`${base}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: formData.toString(),
  });
}

async function getAccessToken(app: Hono, scope: string, email?: string): Promise<string> {
  const { code } = await getAuthCode(app, { scope, ...(email ? { email } : {}) });
  const tokenRes = await exchangeCode(app, code);
  expect(tokenRes.status).toBe(200);
  const tokenBody = (await tokenRes.json()) as Record<string, unknown>;
  return tokenBody.access_token as string;
}

async function getClientCredentialsToken(app: Hono, scope = "https://graph.microsoft.com/.default"): Promise<string> {
  const formData = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: "test-client",
    client_secret: "test-secret",
    scope,
  });

  const res = await app.request(`${base}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: formData.toString(),
  });

  expect(res.status).toBe(200);
  const body = (await res.json()) as Record<string, unknown>;
  return body.access_token as string;
}

describe("Microsoft plugin integration", () => {
  let app: Hono;
  let store: Store;

  beforeEach(() => {
    const testApp = createTestApp();
    app = testApp.app;
    store = testApp.store;
  });

  // --- OpenAPI ---

  it("GET /openapi.json returns a Microsoft Graph subset with delegated OAuth endpoints", async () => {
    const res = await app.request(`${base}/openapi.json`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      openapi: string;
      servers: Array<{ url: string }>;
      components: {
        securitySchemes: {
          azureAdDelegated: {
            type: string;
            flows: {
              authorizationCode: {
                authorizationUrl: string;
                tokenUrl: string;
                scopes: Record<string, string>;
              };
              clientCredentials: {
                tokenUrl: string;
                scopes: Record<string, string>;
              };
            };
          };
        };
      };
      paths: Record<string, unknown>;
    };

    expect(body.openapi).toBe("3.0.3");
    expect(body.servers).toEqual([{ url: base }]);
    expect(body.components.securitySchemes.azureAdDelegated.type).toBe("oauth2");
    expect(body.components.securitySchemes.azureAdDelegated.flows.authorizationCode.authorizationUrl).toBe(
      `${base}/oauth2/v2.0/authorize`,
    );
    expect(body.components.securitySchemes.azureAdDelegated.flows.authorizationCode.tokenUrl).toBe(
      `${base}/oauth2/v2.0/token`,
    );
    expect(body.components.securitySchemes.azureAdDelegated.flows.authorizationCode.scopes).toMatchObject({
      openid: expect.any(String),
      offline_access: expect.any(String),
      "User.Read": expect.any(String),
      "Mail.ReadWrite": expect.any(String),
      "Mail.Send": expect.any(String),
      "Calendars.ReadWrite": expect.any(String),
      "Files.ReadWrite.All": expect.any(String),
    });
    expect(body.components.securitySchemes.azureAdDelegated.flows.clientCredentials.tokenUrl).toBe(
      `${base}/oauth2/v2.0/token`,
    );
    expect(body.paths).toHaveProperty("/v1.0/me");
    expect(body.paths).toHaveProperty("/v1.0/users/{id}");
    expect(body.paths).toHaveProperty("/v1.0/me/messages");
    expect(body.paths).toHaveProperty("/v1.0/me/sendMail");
    expect(body.paths).toHaveProperty("/v1.0/me/events");
    expect(body.paths).toHaveProperty("/v1.0/me/drive/root/children");
    expect(body.paths).toHaveProperty("/v1.0/me/drive/root:/{path}:/content");
    expect(body.paths).toHaveProperty("/v1.0/me/drive/items/{id}/content");
    expect(body.paths).toHaveProperty("/v1.0/drives/{driveId}/items/{itemId}/content");
  });

  // --- OIDC Discovery ---

  it("GET /.well-known/openid-configuration returns Microsoft OIDC discovery document", async () => {
    const res = await app.request(`${base}/.well-known/openid-configuration`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.issuer).toContain("/v2.0");
    expect(body.authorization_endpoint).toBe(`${base}/oauth2/v2.0/authorize`);
    expect(body.token_endpoint).toBe(`${base}/oauth2/v2.0/token`);
    expect(body.userinfo_endpoint).toBe(`${base}/oidc/userinfo`);
    expect(body.end_session_endpoint).toBe(`${base}/oauth2/v2.0/logout`);
    expect(body.jwks_uri).toBe(`${base}/discovery/v2.0/keys`);
    expect(body.response_types_supported).toEqual(["code"]);
    expect(body.response_modes_supported).toEqual(["query", "fragment", "form_post"]);
    expect(body.grant_types_supported).toEqual(["authorization_code", "refresh_token", "client_credentials"]);
    expect(body.subject_types_supported).toEqual(["pairwise"]);
    expect(body.scopes_supported).toContain("openid");
    expect(body.scopes_supported).toContain("User.Read");
    expect(body.scopes_supported).toContain("Mail.ReadWrite");
    expect(body.scopes_supported).toContain("Mail.Send");
    expect(body.scopes_supported).toContain("Calendars.ReadWrite");
    expect(body.scopes_supported).toContain("Files.ReadWrite.All");
    expect(body.claims_supported).toContain("oid");
    expect(body.claims_supported).toContain("tid");
    expect(body.claims_supported).toContain("preferred_username");
    expect(body.code_challenge_methods_supported).toEqual(["plain", "S256"]);
  });

  it("GET /:tenant/v2.0/.well-known/openid-configuration returns tenant-specific OIDC discovery", async () => {
    const tenantId = "my-tenant-id";
    const res = await app.request(`${base}/${tenantId}/v2.0/.well-known/openid-configuration`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.issuer).toBe(`${base}/${tenantId}/v2.0`);
  });

  // --- JWKS ---

  it("GET /discovery/v2.0/keys returns JWKS with RSA public key", async () => {
    const res = await app.request(`${base}/discovery/v2.0/keys`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { keys: Array<Record<string, unknown>> };
    expect(body.keys).toHaveLength(1);
    const key = body.keys[0];
    expect(key.kty).toBe("RSA");
    expect(key.kid).toBe("emulate-microsoft-1");
    expect(key.use).toBe("sig");
    expect(key.alg).toBe("RS256");
  });

  // --- Authorization page ---

  it("GET /oauth2/v2.0/authorize returns an HTML sign-in page", async () => {
    const url = `${base}/oauth2/v2.0/authorize?client_id=test-client&redirect_uri=${encodeURIComponent("http://localhost:3000/callback")}&response_type=code&scope=openid%20email%20profile`;
    const res = await app.request(url);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    const html = await res.text();
    expect(html.length).toBeGreaterThan(0);
    expect(html).toMatch(/Sign in/i);
    expect(html).toMatch(/Microsoft/i);
  });

  it("returns error for unknown client_id when clients are configured", async () => {
    const url = `${base}/oauth2/v2.0/authorize?client_id=unknown-client&redirect_uri=${encodeURIComponent("http://localhost:3000/callback")}`;
    const res = await app.request(url);
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain("Application not found");
  });

  it("callback rejects unknown client_id when clients are configured", async () => {
    const formData = new URLSearchParams({
      email: "testuser@example.com",
      redirect_uri: "http://localhost:3000/callback",
      scope: "openid",
      state: "s",
      nonce: "",
      client_id: "unknown-client",
      response_mode: "query",
      code_challenge: "",
      code_challenge_method: "",
    });

    const res = await app.request(`${base}/oauth2/v2.0/authorize/callback`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: formData.toString(),
    });
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain("Application not found");
  });

  // --- Full OAuth flow ---

  it("completes full OAuth authorization_code flow", async () => {
    const { code, state } = await getAuthCode(app);
    expect(code).toBeTruthy();
    expect(state).toBe("test-state");

    const tokenRes = await exchangeCode(app, code);
    expect(tokenRes.status).toBe(200);
    const tokenBody = (await tokenRes.json()) as Record<string, unknown>;
    expect(tokenBody.access_token).toBeDefined();
    expect((tokenBody.access_token as string).startsWith("microsoft_")).toBe(true);
    expect(tokenBody.refresh_token).toBeDefined();
    expect((tokenBody.refresh_token as string).startsWith("r_microsoft_")).toBe(true);
    expect(tokenBody.token_type).toBe("Bearer");
    expect(tokenBody.expires_in).toBe(3600);
    expect(tokenBody.id_token).toBeDefined();
    expect(tokenBody.scope).toBeDefined();

    // Decode and verify id_token claims
    const claims = decodeJwt(tokenBody.id_token as string);
    expect(claims.iss).toContain("/v2.0");
    expect(claims.aud).toBe("test-client");
    expect(claims.sub).toBeDefined();
    expect(claims.email).toBe("testuser@example.com");
    expect(claims.name).toBe("Test User");
    expect(claims.preferred_username).toBe("testuser@example.com");
    expect(claims.oid).toBeDefined();
    expect(claims.tid).toBeDefined();
    expect(claims.ver).toBe("2.0");
    expect(claims.nonce).toBe("test-nonce");
  });

  // --- Refresh token flow ---

  it("exchanges refresh_token for new access_token with rotated refresh_token", async () => {
    const { code } = await getAuthCode(app);
    const tokenRes = await exchangeCode(app, code);
    const tokenBody = (await tokenRes.json()) as Record<string, unknown>;
    const refreshToken = tokenBody.refresh_token as string;

    const refreshFormData = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: "test-client",
      client_secret: "test-secret",
    });

    const refreshRes = await app.request(`${base}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: refreshFormData.toString(),
    });

    expect(refreshRes.status).toBe(200);
    const refreshBody = (await refreshRes.json()) as Record<string, unknown>;
    expect(refreshBody.access_token).toBeDefined();
    expect((refreshBody.access_token as string).startsWith("microsoft_")).toBe(true);
    expect(refreshBody.id_token).toBeDefined();
    expect(refreshBody.token_type).toBe("Bearer");
    expect(refreshBody.expires_in).toBe(3600);
    // Microsoft rotates refresh tokens
    expect(refreshBody.refresh_token).toBeDefined();
    expect(refreshBody.refresh_token).not.toBe(refreshToken);
  });

  // --- Authorization code is single-use ---

  it("rejects second use of authorization code", async () => {
    const { code } = await getAuthCode(app);

    // First exchange succeeds
    const res1 = await exchangeCode(app, code);
    expect(res1.status).toBe(200);

    // Second exchange fails
    const res2 = await exchangeCode(app, code);
    expect(res2.status).toBe(400);
    const body = (await res2.json()) as Record<string, unknown>;
    expect(body.error).toBe("invalid_grant");
  });

  // --- form_post response mode ---

  it("returns auto-submit form for form_post response mode", async () => {
    const result = await getAuthCode(app, { response_mode: "form_post" });
    expect(result.code).toBeTruthy();
    expect(result.state).toBe("test-state");
  });

  // --- Unsupported grant type ---

  it("rejects unsupported grant type", async () => {
    const formData = new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      client_id: "test-client",
      client_secret: "test-secret",
    });

    const res = await app.request(`${base}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: formData.toString(),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("unsupported_grant_type");
  });

  // --- UserInfo endpoint ---

  it("GET /oidc/userinfo returns user info when authenticated", async () => {
    const { code } = await getAuthCode(app);
    const tokenRes = await exchangeCode(app, code);
    const tokenBody = (await tokenRes.json()) as Record<string, unknown>;
    const accessToken = tokenBody.access_token as string;

    const res = await app.request(`${base}/oidc/userinfo`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.sub).toBeDefined();
    expect(body.email).toBe("testuser@example.com");
    expect(body.name).toBe("Test User");
    expect(body.preferred_username).toBe("testuser@example.com");
  });

  // --- Graph /me endpoint ---

  it("GET /v1.0/me returns Graph-style user profile when authenticated", async () => {
    const accessToken = await getAccessToken(app, "openid email profile User.Read");

    const res = await app.request(`${base}/v1.0/me`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.displayName).toBe("Test User");
    expect(body.mail).toBe("testuser@example.com");
    expect(body.userPrincipalName).toBe("testuser@example.com");
    expect(body.id).toBeDefined();
    expect(body["@odata.context"]).toContain("$metadata#users");
    // Real Graph returns a concrete language code, defaulting to "en-US".
    expect(body.preferredLanguage).toBe("en-US");
  });

  it("GET /v1.0/me honors a seeded preferredLanguage override", async () => {
    const store = new Store();
    const webhooks = new WebhookDispatcher();
    const tokenMap: TokenMap = new Map();
    const localApp = new Hono();
    localApp.use("*", authMiddleware(tokenMap));
    microsoftPlugin.register(localApp as any, store, webhooks, base, tokenMap);
    seedFromConfig(store, base, {
      users: [{ email: "fr@example.com", name: "Fr User", preferred_language: "fr-FR" }],
      oauth_clients: [
        {
          client_id: "test-client",
          client_secret: "test-secret",
          name: "Test App",
          redirect_uris: ["http://localhost:3000/callback"],
        },
      ],
    });
    const accessToken = await getAccessToken(localApp, "openid email profile User.Read", "fr@example.com");
    const res = await localApp.request(`${base}/v1.0/me`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.preferredLanguage).toBe("fr-FR");
  });

  it("GET /v1.0/me rejects app-only client credentials tokens", async () => {
    const accessToken = await getClientCredentialsToken(app);

    const res = await app.request(`${base}/v1.0/me`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: Record<string, unknown> };
    expect(body.error.code).toBe("ErrorAccessDenied");
  });

  it("GET /v1.0/me rejects tokens without User.Read", async () => {
    const accessToken = await getAccessToken(app, "openid email profile Mail.Read");

    const res = await app.request(`${base}/v1.0/me`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: Record<string, unknown> };
    expect(body.error.code).toBe("ErrorAccessDenied");
  });

  it("lists messages and sends mail with delegated mail scopes", async () => {
    const accessToken = await getAccessToken(app, "openid email profile Mail.ReadWrite Mail.Send");

    const listRes = await app.request(`${base}/v1.0/me/messages`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as { value: Array<Record<string, unknown>> };
    expect(listBody.value.length).toBeGreaterThan(0);
    expect(listBody.value[0]).toMatchObject({
      id: expect.any(String),
      subject: expect.any(String),
      body: expect.any(Object),
      toRecipients: expect.any(Array),
    });
    // Real Graph returns a base64 Outlook thread index, never null. 22 bytes ->
    // a 32-character base64 string ending in "==".
    const listedIndex = listBody.value[0].conversationIndex as string;
    expect(typeof listedIndex).toBe("string");
    expect(listedIndex).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(Buffer.from(listedIndex, "base64").length).toBe(22);
    expect(Buffer.from(listedIndex, "base64")[0]).toBe(0x01);

    const firstId = listBody.value[0].id as string;
    const getRes = await app.request(`${base}/v1.0/me/messages/${encodeURIComponent(firstId)}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const getBody = (await getRes.json()) as Record<string, unknown>;
    // conversationIndex is deterministic: list and get agree for the same message.
    expect(getBody.conversationIndex).toBe(listedIndex);

    const sendRes = await app.request(`${base}/v1.0/me/sendMail`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        message: {
          subject: "Graph emulator test",
          body: { contentType: "text", content: "Hello from emulate." },
          toRecipients: [{ emailAddress: { address: "recipient@example.com", name: "Recipient" } }],
        },
        saveToSentItems: true,
      }),
    });
    expect(sendRes.status).toBe(202);

    const afterSendRes = await app.request(`${base}/v1.0/me/messages`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const afterSendBody = (await afterSendRes.json()) as { value: Array<Record<string, unknown>> };
    expect(afterSendBody.value.some((message) => message.subject === "Graph emulator test")).toBe(true);
  });

  it("creates, fetches, and deletes calendar events with delegated calendar scopes", async () => {
    const accessToken = await getAccessToken(app, "openid email profile Calendars.ReadWrite");

    const calendarsRes = await app.request(`${base}/v1.0/me/calendars`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    expect(calendarsRes.status).toBe(200);
    const calendarsBody = (await calendarsRes.json()) as { value: Array<Record<string, unknown>> };
    expect(calendarsBody.value[0]).toMatchObject({ id: expect.any(String), name: expect.any(String) });
    // Real Outlook calendars carry a groupClassId and do not expose webLink.
    expect(calendarsBody.value[0].groupClassId).toBe("0006f0b7-0000-0000-c000-000000000046");
    expect(calendarsBody.value[0]).not.toHaveProperty("webLink");

    const defaultCalRes = await app.request(`${base}/v1.0/me/calendar`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const defaultCal = (await defaultCalRes.json()) as Record<string, unknown>;
    expect(defaultCal.groupClassId).toBe("0006f0b7-0000-0000-c000-000000000046");
    expect(defaultCal).not.toHaveProperty("webLink");

    const createRes = await app.request(`${base}/v1.0/me/events`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        subject: "Customer call",
        body: { contentType: "text", content: "Review Microsoft emulator behavior." },
        start: { dateTime: "2026-07-01T09:00:00", timeZone: "UTC" },
        end: { dateTime: "2026-07-01T09:30:00", timeZone: "UTC" },
        attendees: [{ emailAddress: { address: "customer@example.com", name: "Customer" }, type: "required" }],
      }),
    });
    expect(createRes.status).toBe(201);
    // Real Graph returns a Location header pointing at the created event and an
    // @odata.context on the body.
    expect(createRes.headers.get("location")).toContain("/events(");
    const event = (await createRes.json()) as Record<string, unknown>;
    expect(event.subject).toBe("Customer call");
    expect(event.id).toEqual(expect.any(String));
    expect(event["@odata.context"]).toContain("$metadata#users");
    // An event created without a location gets an empty address/coordinates and
    // no uniqueId, matching real Outlook output. recurrence is null.
    expect(event.location).toMatchObject({ address: {}, coordinates: {} });
    expect(event.location).not.toHaveProperty("uniqueId");
    expect(event.recurrence).toBeNull();

    const getRes = await app.request(`${base}/v1.0/me/events/${event.id as string}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    expect(getRes.status).toBe(200);
    const getBody = (await getRes.json()) as Record<string, unknown>;
    expect(getBody.subject).toBe("Customer call");
    // GET on an event exposes the calendar association/navigation links.
    expect(getBody["calendar@odata.associationLink"]).toContain("/calendars(");
    expect(getBody["calendar@odata.associationLink"]).toContain("/$ref");
    expect(getBody["calendar@odata.navigationLink"]).toContain("/calendars(");

    const deleteRes = await app.request(`${base}/v1.0/me/events/${event.id as string}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    expect(deleteRes.status).toBe(204);
  });

  it("lists and updates OneDrive items with delegated file scopes", async () => {
    const accessToken = await getAccessToken(app, "openid email profile Files.ReadWrite.All");

    const driveRes = await app.request(`${base}/v1.0/me/drive`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    expect(driveRes.status).toBe(200);
    const drive = (await driveRes.json()) as Record<string, any>;
    expect(drive.driveType).toBe("personal");
    // Real drive quota carries storagePlanInformation, and the owner user has no id.
    expect(drive.quota.storagePlanInformation).toMatchObject({ upgradeAvailable: true });
    expect(drive.owner.user).not.toHaveProperty("id");
    expect(drive.owner.user.email).toBe("testuser@example.com");
    expect(drive.description).toBe("");
    expect(drive.createdBy.user.displayName).toBe("System Account");

    const rootRes = await app.request(`${base}/v1.0/me/drive/root`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const root = (await rootRes.json()) as Record<string, any>;
    // Real root items: root:{}, folder.view, isAuthoritative, no @odata.etag/cTag,
    // and a minimal parentReference (only driveType + driveId).
    expect(root.root).toEqual({});
    expect(root.folder.view).toMatchObject({ sortBy: "name", viewType: "thumbnails" });
    expect(root.isAuthoritative).toBe(false);
    expect(root).not.toHaveProperty("@odata.etag");
    expect(root).not.toHaveProperty("cTag");
    expect(Object.keys(root.parentReference).sort()).toEqual(["driveId", "driveType"]);
    expect(root.createdBy.user).not.toHaveProperty("id");

    const childrenRes = await app.request(`${base}/v1.0/me/drive/root/children`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    expect(childrenRes.status).toBe(200);
    const children = (await childrenRes.json()) as { value: Array<Record<string, any>> };
    const documents = children.value.find((item) => item.name === "Documents");
    expect(documents).toBeDefined();
    // Drive items carry eTag/cTag, not @odata.etag, plus isAuthoritative and
    // createdBy.user.email; folders expose folder.view.
    expect(documents).not.toHaveProperty("@odata.etag");
    expect(documents!.eTag).toEqual(expect.any(String));
    expect(documents!.isAuthoritative).toBe(false);
    expect(documents!.createdBy.user.email).toBe("testuser@example.com");
    expect(documents!.createdBy.application.id).toEqual(expect.any(String));
    expect(documents!.folder.view).toMatchObject({ sortBy: "name" });
    expect(documents!.parentReference).toMatchObject({ id: expect.any(String), path: expect.any(String) });

    const updateRes = await app.request(`${base}/v1.0/me/drive/items/${documents!.id as string}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: "Shared Documents" }),
    });
    expect(updateRes.status).toBe(200);
    const updated = (await updateRes.json()) as Record<string, unknown>;
    expect(updated.name).toBe("Shared Documents");
  });

  it("uploads and downloads OneDrive content byte-exact through a working preauthenticated URL", async () => {
    const accessToken = await getAccessToken(app, "openid email profile Files.ReadWrite.All");
    const bytes = new Uint8Array([0, 1, 2, 3, 4, 253, 254, 255]);

    const putRes = await app.request(`${base}/v1.0/me/drive/root:/binary-probe.bin:/content`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "text/plain",
      },
      body: bytes,
    });
    expect(putRes.status).toBe(201);
    const item = (await putRes.json()) as Record<string, any>;
    expect(item.name).toBe("binary-probe.bin");
    expect(item.size).toBe(bytes.byteLength);
    expect(item.eTag).toMatch(/^"\{[0-9a-f-]{36}\},1"$/i);
    expect(item.cTag).toMatch(/^"c:\{[0-9a-f-]{36}\},1"$/i);
    expect(item.file.mimeType).toBe("application/octet-stream");
    expect(item.file.hashes.quickXorHash).toEqual(expect.any(String));
    expect(item["@microsoft.graph.downloadUrl"]).toBe(`${base}/v1.0/_content/${item.id}`);

    const redirectRes = await app.request(`${base}/v1.0/me/drive/items/${item.id}/content`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      redirect: "manual",
    });
    expect(redirectRes.status).toBe(302);
    expect(redirectRes.headers.get("location")).toBe(item["@microsoft.graph.downloadUrl"]);

    const downloadRes = await app.request(redirectRes.headers.get("location") ?? "");
    expect(downloadRes.status).toBe(200);
    expect(downloadRes.headers.get("content-type")).toBe("application/octet-stream");
    expect(new Uint8Array(await downloadRes.arrayBuffer())).toEqual(bytes);
  });

  it("auto-creates nested folders for path-addressed OneDrive uploads and replaces existing paths", async () => {
    const accessToken = await getAccessToken(app, "openid email profile Files.ReadWrite.All");

    const createRes = await app.request(`${base}/v1.0/me/drive/root:/newfolder/note.txt:/content`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/octet-stream",
      },
      body: "first",
    });
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as Record<string, any>;
    expect(created.file.mimeType).toBe("text/plain");
    expect(created.parentReference.name).toBe("newfolder");
    expect(created.parentReference.path).toBe("/drive/root:/newfolder");

    const replaceRes = await app.request(`${base}/v1.0/me/drive/root:/newfolder/note.txt:/content`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: "second",
    });
    expect(replaceRes.status).toBe(200);
    const replaced = (await replaceRes.json()) as Record<string, any>;
    expect(replaced.id).toBe(created.id);
    expect(replaced.size).toBe(Buffer.byteLength("second"));
    expect(replaced.name).toBe("note.txt");
    expect(replaced.parentReference.id).toBe(created.parentReference.id);
    expect(replaced.eTag).toMatch(/^"\{[0-9a-f-]{36}\},2"$/i);
  });

  it("replaces content by item id while preserving name and parent", async () => {
    const accessToken = await getAccessToken(app, "openid email profile Files.ReadWrite.All");

    const createRes = await app.request(`${base}/v1.0/me/drive/root:/replace-me.md:/content`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/octet-stream",
      },
      body: "markdown",
    });
    const created = (await createRes.json()) as Record<string, any>;

    const replaceRes = await app.request(`${base}/v1.0/me/drive/items/${created.id}/content`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/pdf",
      },
      body: new Uint8Array([9, 8, 7]),
    });
    expect(replaceRes.status).toBe(200);
    const replaced = (await replaceRes.json()) as Record<string, any>;
    expect(replaced.id).toBe(created.id);
    expect(replaced.name).toBe("replace-me.md");
    expect(replaced.parentReference.id).toBe(created.parentReference.id);
    expect(replaced.file.mimeType).toBe("text/markdown");
    expect(replaced.size).toBe(3);
  });

  it("returns Microsoft Graph innerError details for drive 404s", async () => {
    const accessToken = await getAccessToken(app, "openid email profile Files.ReadWrite.All");

    const res = await app.request(`${base}/v1.0/me/drive/items/missing-item/content`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as Record<string, any>;
    expect(body.error.code).toBe("itemNotFound");
    expect(body.error.message).toBe("The resource could not be found.");
    expect(body.error.innerError.date).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
    expect(body.error.innerError["request-id"]).toEqual(expect.any(String));
    expect(body.error.innerError["client-request-id"]).toEqual(expect.any(String));
  });

  it("returns 400 invalidRequest for a malformed OneDrive item id", async () => {
    const accessToken = await getAccessToken(app, "openid email profile Files.ReadWrite.All");
    // A id without a "!" segment is not a valid OneDrive id -> 400, not 404.
    const res = await app.request(`${base}/v1.0/me/drive/items/parity-probe-missing`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, any>;
    expect(body.error.code).toBe("invalidRequest");
    expect(body.error.message).toBe("Invalid request");
    expect(body.error.innerError["request-id"]).toEqual(expect.any(String));
  });

  it("returns 404 itemNotFound for a well-formed but missing OneDrive item id", async () => {
    const accessToken = await getAccessToken(app, "openid email profile Files.ReadWrite.All");
    const res = await app.request(`${base}/v1.0/me/drive/items/${encodeURIComponent("545D8DF03C777341!smissing")}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as Record<string, any>;
    expect(body.error.code).toBe("itemNotFound");
  });

  it("returns 400 ErrorInvalidIdMalformed for a malformed event id (no innerError)", async () => {
    const accessToken = await getAccessToken(app, "openid email profile Calendars.ReadWrite");
    const res = await app.request(`${base}/v1.0/me/events/parity-probe-missing`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, any>;
    expect(body.error.code).toBe("ErrorInvalidIdMalformed");
    expect(body.error.message).toBe("The Id is invalid.");
    // Outlook-style malformed-id errors carry no innerError.
    expect(body.error).not.toHaveProperty("innerError");
  });

  it("returns 400 BadRequest for an unknown /v1.0 route segment", async () => {
    const accessToken = await getAccessToken(app, "openid email profile User.Read");
    const res = await app.request(`${base}/v1.0/parity-probe-not-implemented`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, any>;
    expect(body.error.code).toBe("BadRequest");
    expect(body.error.message).toBe("Resource not found for the segment 'parity-probe-not-implemented'.");
    expect(body.error.innerError["request-id"]).toEqual(expect.any(String));
  });

  it("rejects an unknown/garbage bearer token with 401 InvalidAuthenticationToken", async () => {
    // Configure a fallback user (as the standalone server does) and confirm the
    // Microsoft emulator still rejects tokens that are not real credentials.
    const store = new Store();
    const webhooks = new WebhookDispatcher();
    const tokenMap: TokenMap = new Map();
    const fallbackApp = new Hono();
    fallbackApp.use(
      "*",
      authMiddleware(tokenMap, undefined, {
        login: "testuser@example.com",
        id: 1,
        scopes: ["openid", "email", "profile", "User.Read"],
      }),
    );
    microsoftPlugin.register(fallbackApp as any, store, webhooks, base, tokenMap);
    microsoftPlugin.seed?.(store, base);
    seedFromConfig(store, base, {
      users: [{ email: "testuser@example.com", name: "Test User" }],
    });

    const res = await fallbackApp.request(`${base}/v1.0/me`, {
      headers: { Authorization: "Bearer parity-probe-bad-token" },
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as Record<string, any>;
    expect(body.error.code).toBe("InvalidAuthenticationToken");
    expect(body.error.message).toContain("IDX14100");
    expect(body.error.innerError["request-id"]).toEqual(expect.any(String));
    expect(body.error.innerError["client-request-id"]).toEqual(expect.any(String));
  });

  it("supports root folder creation and drive-id scoped OneDrive addressing", async () => {
    const accessToken = await getAccessToken(app, "openid email profile Files.ReadWrite.All");
    const driveRes = await app.request(`${base}/v1.0/me/drive`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const drive = (await driveRes.json()) as Record<string, any>;

    const folderRes = await app.request(`${base}/v1.0/me/drive/root/children`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "parity-folder",
        folder: {},
        "@microsoft.graph.conflictBehavior": "rename",
      }),
    });
    expect(folderRes.status).toBe(201);
    const folder = (await folderRes.json()) as Record<string, any>;
    expect(folder.folder.childCount).toBe(0);

    const pathPutRes = await app.request(`${base}/v1.0/drives/${drive.id}/items/root:/scoped.csv:/content`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "text/plain",
      },
      body: "a,b\n1,2\n",
    });
    expect(pathPutRes.status).toBe(201);
    const scopedItem = (await pathPutRes.json()) as Record<string, any>;
    expect(scopedItem.file.mimeType).toBe("text/csv");

    const driveItemRes = await app.request(`${base}/v1.0/drives/${drive.id}/items/${scopedItem.id}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    expect(driveItemRes.status).toBe(200);
    expect(((await driveItemRes.json()) as Record<string, unknown>).id).toBe(scopedItem.id);

    const childrenRes = await app.request(`${base}/v1.0/drives/${drive.id}/root/children`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    expect(childrenRes.status).toBe(200);
    const children = (await childrenRes.json()) as { value: Array<Record<string, unknown>> };
    expect(children.value.some((item) => item.id === scopedItem.id)).toBe(true);

    const deleteRes = await app.request(`${base}/v1.0/drives/${drive.id}/items/${scopedItem.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    expect(deleteRes.status).toBe(204);
    expect(await deleteRes.text()).toBe("");
  });

  // --- Logout endpoint ---

  it("GET /oauth2/v2.0/logout redirects when post_logout_redirect_uri is registered", async () => {
    const redirectUri = "http://localhost:3000/callback";
    const res = await app.request(
      `${base}/oauth2/v2.0/logout?post_logout_redirect_uri=${encodeURIComponent(redirectUri)}`,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(redirectUri);
  });

  it("GET /oauth2/v2.0/logout rejects unregistered post_logout_redirect_uri", async () => {
    const redirectUri = "http://evil.example.com/phishing";
    const res = await app.request(
      `${base}/oauth2/v2.0/logout?post_logout_redirect_uri=${encodeURIComponent(redirectUri)}`,
    );
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).toBe("Invalid post_logout_redirect_uri");
  });

  it("GET /oauth2/v2.0/logout returns text without redirect URI", async () => {
    const res = await app.request(`${base}/oauth2/v2.0/logout`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toBe("Logged out");
  });

  // --- Token revocation ---

  it("POST /oauth2/v2.0/revoke returns 200", async () => {
    const formData = new URLSearchParams({
      token: "some-token",
    });

    const res = await app.request(`${base}/oauth2/v2.0/revoke`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: formData.toString(),
    });

    expect(res.status).toBe(200);
  });

  // --- Client secret validation ---

  it("rejects incorrect client_secret", async () => {
    const { code } = await getAuthCode(app);
    const res = await exchangeCode(app, code, { client_secret: "wrong-secret" });
    expect(res.status).toBe(401);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("invalid_client");
  });

  // --- client_secret_basic authentication ---

  it("accepts client credentials via Authorization Basic header", async () => {
    const { code } = await getAuthCode(app);

    const credentials = Buffer.from("test-client:test-secret").toString("base64");
    const formData = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: "http://localhost:3000/callback",
    });

    const res = await app.request(`${base}/oauth2/v2.0/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${credentials}`,
      },
      body: formData.toString(),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.access_token).toBeDefined();
    expect((body.access_token as string).startsWith("microsoft_")).toBe(true);
  });

  it("rejects incorrect secret via Authorization Basic header", async () => {
    const { code } = await getAuthCode(app);

    const credentials = Buffer.from("test-client:wrong-secret").toString("base64");
    const formData = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: "http://localhost:3000/callback",
    });

    const res = await app.request(`${base}/oauth2/v2.0/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${credentials}`,
      },
      body: formData.toString(),
    });

    expect(res.status).toBe(401);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("invalid_client");
  });

  // --- client_credentials grant type ---

  it("issues token for client_credentials grant", async () => {
    const formData = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: "test-client",
      client_secret: "test-secret",
      scope: "https://graph.microsoft.com/.default",
    });

    const res = await app.request(`${base}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: formData.toString(),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.access_token).toBeDefined();
    expect((body.access_token as string).startsWith("microsoft_")).toBe(true);
    expect(body.token_type).toBe("Bearer");
    expect(body.expires_in).toBe(3600);
    expect(body.scope).toBe("https://graph.microsoft.com/.default");
    // client_credentials should NOT return refresh_token or id_token
    expect(body.refresh_token).toBeUndefined();
    expect(body.id_token).toBeUndefined();
  });

  it("rejects client_credentials with wrong secret", async () => {
    const formData = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: "test-client",
      client_secret: "wrong-secret",
    });

    const res = await app.request(`${base}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: formData.toString(),
    });

    expect(res.status).toBe(401);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("invalid_client");
  });

  it("supports client_credentials with Basic auth header", async () => {
    const credentials = Buffer.from("test-client:test-secret").toString("base64");
    const formData = new URLSearchParams({
      grant_type: "client_credentials",
      scope: ".default",
    });

    const res = await app.request(`${base}/oauth2/v2.0/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${credentials}`,
      },
      body: formData.toString(),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.access_token).toBeDefined();
  });

  // --- Seed from config ---

  it("seeds users and clients from config", () => {
    const testStore = new Store();
    const webhooks = new WebhookDispatcher();
    const testTokenMap: TokenMap = new Map();
    const testApp = new Hono();
    testApp.use("*", authMiddleware(testTokenMap));
    microsoftPlugin.register(testApp as any, testStore, webhooks, base, testTokenMap);

    seedFromConfig(testStore, base, {
      users: [
        { email: "alice@outlook.com", name: "Alice Smith" },
        { email: "bob@live.com", name: "Bob Jones", tenant_id: "custom-tenant" },
      ],
      oauth_clients: [
        {
          client_id: "my-app",
          client_secret: "my-secret",
          name: "My App",
          redirect_uris: ["http://localhost:3000/callback"],
        },
      ],
    });

    const ms = getMicrosoftStore(testStore);

    const alice = ms.users.findOneBy("email", "alice@outlook.com");
    expect(alice).toBeDefined();
    expect(alice!.name).toBe("Alice Smith");
    expect(alice!.preferred_username).toBe("alice@outlook.com");
    // Seeded users default to en-US unless overridden.
    expect(alice!.preferred_language).toBe("en-US");

    const bob = ms.users.findOneBy("email", "bob@live.com");
    expect(bob).toBeDefined();
    expect(bob!.tenant_id).toBe("custom-tenant");

    const client = ms.oauthClients.findOneBy("client_id", "my-app");
    expect(client).toBeDefined();
    expect(client!.name).toBe("My App");
  });

  // --- v1 OAuth token endpoint (legacy /{tenant}/oauth2/token) ---

  it("POST /:tenant/oauth2/token issues token with client_credentials and resource param", async () => {
    const formData = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: "test-client",
      client_secret: "test-secret",
      resource: "https://graph.microsoft.com",
    });

    const res = await app.request(`${base}/my-tenant/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: formData.toString(),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.access_token).toBeDefined();
    expect((body.access_token as string).startsWith("microsoft_")).toBe(true);
    expect(body.token_type).toBe("Bearer");
    expect(body.expires_in).toBe(3600);
    // resource=https://graph.microsoft.com should become scope=https://graph.microsoft.com/.default
    expect(body.scope).toBe("https://graph.microsoft.com/.default");
  });

  it("POST /:tenant/oauth2/token preserves explicit scope over resource param", async () => {
    const formData = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: "test-client",
      client_secret: "test-secret",
      scope: "https://graph.microsoft.com/.default",
      resource: "https://something-else.example.com",
    });

    const res = await app.request(`${base}/my-tenant/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: formData.toString(),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.scope).toBe("https://graph.microsoft.com/.default");
  });

  it("POST /:tenant/oauth2/token rejects wrong client_secret", async () => {
    const formData = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: "test-client",
      client_secret: "wrong-secret",
      resource: "https://graph.microsoft.com",
    });

    const res = await app.request(`${base}/my-tenant/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: formData.toString(),
    });

    expect(res.status).toBe(401);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("invalid_client");
  });

  // --- Graph /v1.0/users/:id endpoint ---

  it("GET /v1.0/users/:id returns user profile by oid", async () => {
    const ms = getMicrosoftStore(store);
    const user = ms.users.findOneBy("email", "testuser@example.com");
    expect(user).toBeDefined();
    const accessToken = await getClientCredentialsToken(app);

    const res = await app.request(`${base}/v1.0/users/${user!.oid}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.id).toBe(user!.oid);
    expect(body.displayName).toBe("Test User");
    expect(body.mail).toBe("testuser@example.com");
    expect(body.userPrincipalName).toBe("testuser@example.com");
    expect(body["@odata.context"]).toContain("$metadata#users");
  });

  it("GET /v1.0/users lists users with an app-only token", async () => {
    const accessToken = await getClientCredentialsToken(app);
    const res = await app.request(`${base}/v1.0/users`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { value: Array<Record<string, unknown>> };
    expect(body.value.some((user) => user.userPrincipalName === "testuser@example.com")).toBe(true);
  });

  it("GET /v1.0/users/:id returns 404 for unknown user id", async () => {
    const accessToken = await getClientCredentialsToken(app);
    const res = await app.request(`${base}/v1.0/users/00000000-0000-0000-0000-000000000000`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: Record<string, unknown> };
    expect(body.error.code).toBe("Request_ResourceNotFound");
  });

  it("serves seeded drive_items content byte-exact under the seeded user's drive", async () => {
    // A seed that introduces its own user and a drive item without an explicit
    // user_email must attach the item to that seeded user, so a token minted for
    // that user sees it under /me/drive with the seeded content and mimeType.
    seedFromConfig(store, base, {
      users: [{ email: "parity@example.com", name: "Parity User" }],
      drive_items: [{ name: "Seeded Notes.txt", mime_type: "text/plain", content: "Notes" }],
    });
    const accessToken = await getAccessToken(app, "openid email profile Files.ReadWrite.All", "parity@example.com");

    const childrenRes = await app.request(`${base}/v1.0/me/drive/root/children`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    expect(childrenRes.status).toBe(200);
    const children = (await childrenRes.json()) as { value: Array<Record<string, any>> };
    const seeded = children.value.find((item) => item.name === "Seeded Notes.txt");
    expect(seeded).toBeTruthy();
    expect(seeded!.size).toBe(Buffer.byteLength("Notes"));
    expect(seeded!.file.mimeType).toBe("text/plain");
    expect(seeded!["@microsoft.graph.downloadUrl"]).toBe(`${base}/v1.0/_content/${seeded!.id}`);

    const redirectRes = await app.request(`${base}/v1.0/me/drive/items/${seeded!.id}/content`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      redirect: "manual",
    });
    expect(redirectRes.status).toBe(302);
    expect(redirectRes.headers.get("location")).toBe(seeded!["@microsoft.graph.downloadUrl"]);

    const downloadRes = await app.request(redirectRes.headers.get("location") ?? "");
    expect(downloadRes.status).toBe(200);
    expect(downloadRes.headers.get("content-type")).toBe("text/plain");
    expect(await downloadRes.text()).toBe("Notes");
  });
});
