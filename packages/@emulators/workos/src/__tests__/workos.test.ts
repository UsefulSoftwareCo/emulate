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

    const meta = (await (
      await fetch(`${BASE}/.well-known/oauth-authorization-server`)
    ).json()) as Record<string, string>;
    expect(meta.token_endpoint).toBe(`${BASE}/oauth2/token`);
    expect(meta.registration_endpoint).toBe(`${BASE}/oauth2/register`);
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
