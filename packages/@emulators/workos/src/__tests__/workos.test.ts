import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, serve } from "@emulators/core";
import { WorkOS } from "@workos-inc/node";

import { workosPlugin, seedFromConfig } from "../index.js";
import { manifest } from "../manifest.js";

// The whole point of this emulator: the REAL @workos-inc/node SDK runs against
// it unmodified, including sealed-session crypto (local iron seal with the
// cookie password) and JWT verification against the emulator's JWKS.

const PORT = 41873;
const BASE = `http://localhost:${PORT}`;
const CLIENT_ID = "client_emulate_test";
const COOKIE_PASSWORD = "emulate-cookie-password-0123456789abcdef0123456789";

let httpServer: ReturnType<typeof serve>;
let workos: WorkOS;

beforeAll(async () => {
  const { app, store } = createServer(workosPlugin, {
    port: PORT,
    baseUrl: BASE,
    manifest,
    fallbackUser: { login: "sk_emulate_admin", id: 1, scopes: [] },
  });
  seedFromConfig(store, BASE, {
    users: [{ email: "seeded@example.com", first_name: "Seeded" }],
  });
  httpServer = serve({ fetch: app.fetch, port: PORT });
  workos = new WorkOS("sk_test_emulate", {
    clientId: CLIENT_ID,
    apiHostname: "localhost",
    port: PORT,
    https: false,
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
});

async function signInAndGetCode(email: string): Promise<string> {
  const authorizeUrl = workos.userManagement.getAuthorizationUrl({
    provider: "authkit",
    clientId: CLIENT_ID,
    redirectUri: "http://127.0.0.1:9/callback",
  });
  const url = new URL(authorizeUrl);
  url.searchParams.set("login_hint", email);
  const response = await fetch(url, { redirect: "manual" });
  expect(response.status).toBe(302);
  const location = new URL(response.headers.get("location") ?? "");
  const code = location.searchParams.get("code");
  expect(code).toBeTruthy();
  return code as string;
}

describe("workos emulator with the real @workos-inc/node SDK", () => {
  it("completes the AuthKit login flow and authenticates the sealed session", async () => {
    const code = await signInAndGetCode("alice@example.com");
    const auth = await workos.userManagement.authenticateWithCode({
      code,
      clientId: CLIENT_ID,
      session: { sealSession: true, cookiePassword: COOKIE_PASSWORD },
    });
    expect(auth.user.email).toBe("alice@example.com");
    expect(auth.sealedSession).toBeTruthy();

    const session = workos.userManagement.loadSealedSession({
      sessionData: auth.sealedSession as string,
      cookiePassword: COOKIE_PASSWORD,
    });
    const result = await session.authenticate();
    expect(result.authenticated).toBe(true);
    if (result.authenticated) {
      expect(result.user.email).toBe("alice@example.com");
    }
  });

  it("creates an org + membership and refreshes the session into it", async () => {
    const code = await signInAndGetCode("bob@example.com");
    const auth = await workos.userManagement.authenticateWithCode({
      code,
      clientId: CLIENT_ID,
      session: { sealSession: true, cookiePassword: COOKIE_PASSWORD },
    });

    const org = await workos.organizations.createOrganization({ name: "Bob Org" });
    expect(org.id).toMatch(/^org_/);
    await workos.userManagement.createOrganizationMembership({
      organizationId: org.id,
      userId: auth.user.id,
      roleSlug: "admin",
    });

    const memberships = await workos.userManagement.listOrganizationMemberships({
      userId: auth.user.id,
      statuses: ["active", "pending"] as never,
    });
    expect(memberships.data.map((m) => m.organizationId)).toContain(org.id);

    const session = workos.userManagement.loadSealedSession({
      sessionData: auth.sealedSession as string,
      cookiePassword: COOKIE_PASSWORD,
    });
    const refreshed = await session.refresh({
      cookiePassword: COOKIE_PASSWORD,
      organizationId: org.id,
    });
    expect(refreshed.authenticated).toBe(true);
    if (refreshed.authenticated && refreshed.sealedSession) {
      const verify = workos.userManagement.loadSealedSession({
        sessionData: refreshed.sealedSession,
        cookiePassword: COOKIE_PASSWORD,
      });
      const verified = await verify.authenticate();
      expect(verified.authenticated).toBe(true);
      if (verified.authenticated) {
        expect(verified.organizationId).toBe(org.id);
      }
    }
  });

  it("round-trips vault objects through workos.vault", async () => {
    const metadata = await workos.vault.createObject({
      name: "executor/secrets/test",
      value: "super-secret",
      context: { app: "executor" },
    });
    expect(metadata.id).toMatch(/^kv_/);

    const read = await workos.vault.readObjectByName("executor/secrets/test");
    expect(read.value).toBe("super-secret");

    await workos.vault.updateObject({ id: read.id, value: "rotated" });
    const reread = await workos.vault.readObjectByName("executor/secrets/test");
    expect(reread.value).toBe("rotated");

    await workos.vault.deleteObject({ id: read.id });
    await expect(workos.vault.readObjectByName("executor/secrets/test")).rejects.toThrow();
  });

  it("mints and validates user API keys via the raw endpoints", async () => {
    const code = await signInAndGetCode("carol@example.com");
    const auth = await workos.userManagement.authenticateWithCode({
      code,
      clientId: CLIENT_ID,
      session: { sealSession: true, cookiePassword: COOKIE_PASSWORD },
    });
    const org = await workos.organizations.createOrganization({ name: "Carol Org" });

    const raw = workos as unknown as {
      post: (path: string, body: unknown) => Promise<{ data: { value?: string } }>;
    };
    const created = await raw.post(`/user_management/users/${auth.user.id}/api_keys`, {
      name: "test key",
      organization_id: org.id,
    });
    expect(created.data.value).toMatch(/^sk_emulate/);

    const validation = (await workos.apiKeys.validateApiKey({
      value: created.data.value as string,
    })) as { apiKey?: { id?: string } } | null;
    expect(validation).toBeTruthy();
  });

  it("serves JWKS on both surfaces and OAuth AS metadata", async () => {
    const sso = (await (await fetch(`${BASE}/sso/jwks/${CLIENT_ID}`)).json()) as {
      keys: Array<{ kid: string }>;
    };
    const oauth = (await (await fetch(`${BASE}/oauth2/jwks`)).json()) as {
      keys: Array<{ kid: string }>;
    };
    expect(sso.keys[0]?.kid).toBe(oauth.keys[0]?.kid);

    const meta = (await (await fetch(`${BASE}/.well-known/oauth-authorization-server`)).json()) as Record<
      string,
      string
    >;
    expect(meta.token_endpoint).toBe(`${BASE}/oauth2/token`);
    expect(meta.registration_endpoint).toBe(`${BASE}/oauth2/register`);
  });

  it("grants exactly the requested OAuth scopes and gates refresh tokens on offline_access", async () => {
    const redirectUri = "http://127.0.0.1:9/callback";
    const register = async (extra: Record<string, unknown> = {}) =>
      (await (
        await fetch(`${BASE}/oauth2/register`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            client_name: "scope-test",
            redirect_uris: [redirectUri],
            ...extra,
          }),
        })
      ).json()) as { client_id: string };
    const mint = async (clientId: string, scope: string | null) => {
      const authorize = new URL(`${BASE}/oauth2/authorize`);
      authorize.searchParams.set("client_id", clientId);
      authorize.searchParams.set("redirect_uri", redirectUri);
      authorize.searchParams.set("login_hint", "scopes@example.com");
      if (scope !== null) authorize.searchParams.set("scope", scope);
      const redirect = await fetch(authorize, { redirect: "manual" });
      const code = new URL(redirect.headers.get("location") ?? "").searchParams.get("code") ?? "";
      return (await (
        await fetch(`${BASE}/oauth2/token`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "authorization_code",
            code,
            redirect_uri: redirectUri,
            client_id: clientId,
          }),
        })
      ).json()) as {
        access_token?: string;
        refresh_token?: string;
        expires_in?: number;
        scope?: string;
      };
    };

    // A client that requests no scopes (what a spec-faithful MCP client does
    // when the resource advertises scopes_supported: []) gets NO refresh token.
    const bare = await register();
    const bareTokens = await mint(bare.client_id, null);
    expect(bareTokens.access_token).toBeTruthy();
    expect(bareTokens.refresh_token).toBeUndefined();
    expect(bareTokens.scope).toBeUndefined();
    expect(bareTokens.expires_in).toBe(3600);

    // offline_access yields a refresh token; the TTL DCR extension compresses
    // the lifecycle; refresh rotates (single use, like AuthKit).
    const offline = await register({ access_token_ttl_seconds: 7 });
    const offlineTokens = await mint(offline.client_id, "openid profile email offline_access");
    expect(offlineTokens.refresh_token).toBeTruthy();
    expect(offlineTokens.scope).toBe("openid profile email offline_access");
    expect(offlineTokens.expires_in).toBe(7);
    const jwtPayload = JSON.parse(
      Buffer.from(offlineTokens.access_token?.split(".")[1] ?? "", "base64url").toString(),
    ) as { exp: number; iat: number };
    expect(jwtPayload.exp - jwtPayload.iat).toBe(7);

    const refresh = async (token: string) =>
      (await (
        await fetch(`${BASE}/oauth2/token`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "refresh_token",
            refresh_token: token,
            client_id: offline.client_id,
          }),
        })
      ).json()) as { refresh_token?: string; expires_in?: number; error?: string };
    const rotated = await refresh(offlineTokens.refresh_token ?? "");
    expect(rotated.refresh_token).toBeTruthy();
    expect(rotated.expires_in).toBe(7);
    const replayed = await refresh(offlineTokens.refresh_token ?? "");
    expect(replayed.error).toBe("invalid_grant");
  });

  it("honors the seeded default access-token TTL for plain DCR clients", async () => {
    const redirectUri = "http://127.0.0.1:9/callback";
    const { app, store } = createServer(workosPlugin, {
      port: PORT + 1,
      baseUrl: `http://localhost:${PORT + 1}`,
      manifest,
      fallbackUser: { login: "sk_emulate_admin", id: 1, scopes: [] },
    });
    seedFromConfig(store, `http://localhost:${PORT + 1}`, {
      oauth: { default_access_token_ttl_seconds: 5 },
    });
    const server = serve({ fetch: app.fetch, port: PORT + 1 });
    try {
      const base = `http://localhost:${PORT + 1}`;
      const registered = (await (
        await fetch(`${base}/oauth2/register`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ client_name: "plain-dcr", redirect_uris: [redirectUri] }),
        })
      ).json()) as { client_id: string };
      const authorize = new URL(`${base}/oauth2/authorize`);
      authorize.searchParams.set("client_id", registered.client_id);
      authorize.searchParams.set("redirect_uri", redirectUri);
      authorize.searchParams.set("login_hint", "ttl@example.com");
      const redirect = await fetch(authorize, { redirect: "manual" });
      const code = new URL(redirect.headers.get("location") ?? "").searchParams.get("code") ?? "";
      const tokens = (await (
        await fetch(`${base}/oauth2/token`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "authorization_code",
            code,
            redirect_uri: redirectUri,
            client_id: registered.client_id,
          }),
        })
      ).json()) as { expires_in?: number };
      expect(tokens.expires_in).toBe(5);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("seeds users from config", async () => {
    const code = await signInAndGetCode("seeded@example.com");
    const auth = await workos.userManagement.authenticateWithCode({
      code,
      clientId: CLIENT_ID,
      session: { sealSession: false } as never,
    });
    expect(auth.user.firstName).toBe("Seeded");
  });
});
