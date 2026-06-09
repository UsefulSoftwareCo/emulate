import { createHash, randomBytes } from "crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { Hono } from "@emulators/core";
import { Store, WebhookDispatcher, authMiddleware, createApiErrorHandler, createErrorHandler } from "@emulators/core";
import { xPlugin, seedFromConfig } from "../index.js";

const base = "http://localhost:4000";

function createTestApp() {
  const store = new Store();
  const webhooks = new WebhookDispatcher();
  // X tokens are resolved from the store, so the core tokenMap stays empty.
  const tokenMap = new Map();

  const app = new Hono();
  app.onError(createApiErrorHandler());
  app.use("*", createErrorHandler());
  app.use("*", authMiddleware(tokenMap));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  xPlugin.register(app as any, store, webhooks, base, tokenMap);

  seedFromConfig(store, base, {
    users: [
      {
        username: "developer",
        name: "Developer",
        user_id: "1000000000000000001",
        description: "Building with X.",
        verified: true,
        followers_count: 1200,
      },
      { username: "other", name: "Other Person", user_id: "1000000000000000002" },
    ],
    oauth_clients: [
      {
        client_id: "x-confidential-client",
        client_secret: "x-confidential-secret",
        client_type: "confidential",
        name: "Confidential App",
        redirect_uris: ["http://localhost:3000/callback"],
      },
      {
        client_id: "x-public-client",
        client_type: "public",
        name: "Public App",
        redirect_uris: ["http://localhost:3000/callback"],
      },
    ],
    tweets: [{ text: "Hello world", author: "developer", tweet_id: "2000000000000000001", like_count: 5 }],
  });

  return { app, store };
}

function form(body: Record<string, string>): URLSearchParams {
  return new URLSearchParams(body);
}

function basicHeader(id: string, secret: string): string {
  return "Basic " + Buffer.from(`${id}:${secret}`).toString("base64");
}

function pkcePair() {
  const verifier = randomBytes(40).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

/** Run the authorize → consent → code flow, returning the issued code. */
async function getAuthCode(
  app: Hono,
  opts: { clientId: string; challenge: string; scope: string; redirectUri?: string; userId?: string },
): Promise<string> {
  const redirectUri = opts.redirectUri ?? "http://localhost:3000/callback";
  const userId = opts.userId ?? "1000000000000000001";
  const consentRes = await app.request(`${base}/2/oauth2/authorize/consent`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form({
      user_id: userId,
      client_id: opts.clientId,
      redirect_uri: redirectUri,
      scope: opts.scope,
      state: "xyz",
      code_challenge: opts.challenge,
      code_challenge_method: "S256",
    }).toString(),
  });
  expect(consentRes.status).toBe(302);
  const location = consentRes.headers.get("Location")!;
  const code = new URL(location).searchParams.get("code")!;
  expect(code).toBeTruthy();
  return code;
}

describe("X plugin integration", () => {
  let app: Hono;

  beforeEach(() => {
    app = createTestApp().app;
  });

  describe("app-only client credentials (BearerToken)", () => {
    it("mints an app-only bearer token from a confidential client and reads a user", async () => {
      const tokenRes = await app.request(`${base}/2/oauth2/token`, {
        method: "POST",
        headers: {
          Authorization: basicHeader("x-confidential-client", "x-confidential-secret"),
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: form({ grant_type: "client_credentials" }).toString(),
      });
      expect(tokenRes.status).toBe(200);
      const body = (await tokenRes.json()) as { token_type: string; access_token: string };
      expect(body.token_type).toBe("bearer");
      expect(body.access_token).toBeTruthy();

      const userRes = await app.request(`${base}/2/users/by/username/developer`, {
        headers: { Authorization: `Bearer ${body.access_token}` },
      });
      expect(userRes.status).toBe(200);
      const userBody = (await userRes.json()) as { data: { username: string; verified: boolean } };
      expect(userBody.data.username).toBe("developer");
      expect(userBody.data.verified).toBe(true);
    });

    it("rejects a confidential client with a bad secret (401 invalid_client)", async () => {
      const res = await app.request(`${base}/2/oauth2/token`, {
        method: "POST",
        headers: {
          Authorization: basicHeader("x-confidential-client", "wrong-secret"),
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: form({ grant_type: "client_credentials" }).toString(),
      });
      expect(res.status).toBe(401);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("invalid_client");
    });

    it("rejects an app-only token at a user-context endpoint (403)", async () => {
      const tokenRes = await app.request(`${base}/2/oauth2/token`, {
        method: "POST",
        headers: {
          Authorization: basicHeader("x-confidential-client", "x-confidential-secret"),
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: form({ grant_type: "client_credentials" }).toString(),
      });
      const { access_token } = (await tokenRes.json()) as { access_token: string };

      const meRes = await app.request(`${base}/2/users/me`, {
        headers: { Authorization: `Bearer ${access_token}` },
      });
      expect(meRes.status).toBe(403);
    });
  });

  describe("authorization code + PKCE — confidential client", () => {
    it("exchanges a code using HTTP Basic auth and no client_id in the body", async () => {
      const { verifier, challenge } = pkcePair();
      const code = await getAuthCode(app, {
        clientId: "x-confidential-client",
        challenge,
        scope: "tweet.read tweet.write users.read offline.access",
      });

      const tokenRes = await app.request(`${base}/2/oauth2/token`, {
        method: "POST",
        headers: {
          Authorization: basicHeader("x-confidential-client", "x-confidential-secret"),
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: form({
          grant_type: "authorization_code",
          code,
          redirect_uri: "http://localhost:3000/callback",
          code_verifier: verifier,
          // Deliberately NO client_id in the body — confidential auth is the Basic header.
        }).toString(),
      });
      expect(tokenRes.status).toBe(200);
      const body = (await tokenRes.json()) as {
        token_type: string;
        access_token: string;
        scope: string;
        refresh_token?: string;
      };
      expect(body.token_type).toBe("bearer");
      expect(body.access_token).toBeTruthy();
      expect(body.scope).toContain("tweet.write");
      // offline.access was granted → a refresh token is returned.
      expect(body.refresh_token).toBeTruthy();
    });

    it("rejects a confidential client that posts client_secret in the body (401 invalid_client)", async () => {
      // X only supports client_secret_basic for confidential clients. Posting the
      // secret in the body (client_secret_post) must be rejected even when the
      // secret value is correct — this is the regression that proves the old
      // body-auth behavior is gone.
      const { verifier, challenge } = pkcePair();
      const code = await getAuthCode(app, {
        clientId: "x-confidential-client",
        challenge,
        scope: "tweet.read users.read",
      });

      const tokenRes = await app.request(`${base}/2/oauth2/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form({
          grant_type: "authorization_code",
          code,
          redirect_uri: "http://localhost:3000/callback",
          code_verifier: verifier,
          client_id: "x-confidential-client",
          // Correct secret, but in the body and with no Basic header → must fail.
          client_secret: "x-confidential-secret",
        }).toString(),
      });
      expect(tokenRes.status).toBe(401);
      const body = (await tokenRes.json()) as { error: string; error_description: string };
      expect(body.error).toBe("invalid_client");
      expect(body.error_description).toBe("Confidential clients must authenticate with HTTP Basic.");
    });

    it("rejects a confidential client presenting the wrong secret in the Basic header (401 invalid_client)", async () => {
      const { verifier, challenge } = pkcePair();
      const code = await getAuthCode(app, {
        clientId: "x-confidential-client",
        challenge,
        scope: "tweet.read users.read",
      });

      const tokenRes = await app.request(`${base}/2/oauth2/token`, {
        method: "POST",
        headers: {
          Authorization: basicHeader("x-confidential-client", "wrong-secret"),
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: form({
          grant_type: "authorization_code",
          code,
          redirect_uri: "http://localhost:3000/callback",
          code_verifier: verifier,
        }).toString(),
      });
      expect(tokenRes.status).toBe(401);
      const body = (await tokenRes.json()) as { error: string };
      expect(body.error).toBe("invalid_client");
    });

    it("rejects client_credentials with the secret posted in the body (401 invalid_client)", async () => {
      // The app-only grant is inherently confidential and likewise requires Basic.
      const tokenRes = await app.request(`${base}/2/oauth2/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form({
          grant_type: "client_credentials",
          client_id: "x-confidential-client",
          client_secret: "x-confidential-secret",
        }).toString(),
      });
      expect(tokenRes.status).toBe(401);
      const body = (await tokenRes.json()) as { error: string };
      expect(body.error).toBe("invalid_client");
    });

    it("refreshes a user-context token (requires offline.access)", async () => {
      const { verifier, challenge } = pkcePair();
      const code = await getAuthCode(app, {
        clientId: "x-confidential-client",
        challenge,
        scope: "tweet.read users.read offline.access",
      });
      const tokenRes = await app.request(`${base}/2/oauth2/token`, {
        method: "POST",
        headers: {
          Authorization: basicHeader("x-confidential-client", "x-confidential-secret"),
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: form({
          grant_type: "authorization_code",
          code,
          redirect_uri: "http://localhost:3000/callback",
          code_verifier: verifier,
        }).toString(),
      });
      const first = (await tokenRes.json()) as { access_token: string; refresh_token: string };

      const refreshRes = await app.request(`${base}/2/oauth2/token`, {
        method: "POST",
        headers: {
          Authorization: basicHeader("x-confidential-client", "x-confidential-secret"),
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: form({ grant_type: "refresh_token", refresh_token: first.refresh_token }).toString(),
      });
      expect(refreshRes.status).toBe(200);
      const refreshed = (await refreshRes.json()) as { access_token: string; refresh_token: string };
      expect(refreshed.access_token).toBeTruthy();
      expect(refreshed.access_token).not.toBe(first.access_token);
      expect(refreshed.refresh_token).toBeTruthy();
    });
  });

  describe("authorization code + PKCE — public client", () => {
    it("exchanges a code with client_id in the body and no secret", async () => {
      const { verifier, challenge } = pkcePair();
      const code = await getAuthCode(app, {
        clientId: "x-public-client",
        challenge,
        scope: "tweet.read users.read",
      });

      const tokenRes = await app.request(`${base}/2/oauth2/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form({
          grant_type: "authorization_code",
          code,
          redirect_uri: "http://localhost:3000/callback",
          code_verifier: verifier,
          client_id: "x-public-client",
        }).toString(),
      });
      expect(tokenRes.status).toBe(200);
      const body = (await tokenRes.json()) as { access_token: string; refresh_token?: string };
      expect(body.access_token).toBeTruthy();
      // No offline.access → no refresh token.
      expect(body.refresh_token).toBeUndefined();
    });

    it("rejects a public-client token request missing client_id (400 invalid_request)", async () => {
      const { verifier, challenge } = pkcePair();
      const code = await getAuthCode(app, {
        clientId: "x-public-client",
        challenge,
        scope: "tweet.read users.read",
      });

      const tokenRes = await app.request(`${base}/2/oauth2/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form({
          grant_type: "authorization_code",
          code,
          redirect_uri: "http://localhost:3000/callback",
          code_verifier: verifier,
          // No Basic header and no client_id → cannot identify the client.
        }).toString(),
      });
      expect(tokenRes.status).toBe(400);
      const body = (await tokenRes.json()) as { error: string };
      expect(body.error).toBe("invalid_request");
    });

    it("rejects a wrong code_verifier (400 invalid_grant)", async () => {
      const { challenge } = pkcePair();
      const code = await getAuthCode(app, {
        clientId: "x-public-client",
        challenge,
        scope: "tweet.read users.read",
      });

      const tokenRes = await app.request(`${base}/2/oauth2/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form({
          grant_type: "authorization_code",
          code,
          redirect_uri: "http://localhost:3000/callback",
          code_verifier: "the-wrong-verifier-entirely",
          client_id: "x-public-client",
        }).toString(),
      });
      expect(tokenRes.status).toBe(400);
      const body = (await tokenRes.json()) as { error: string };
      expect(body.error).toBe("invalid_grant");
    });
  });

  describe("user-context API calls", () => {
    async function userToken(scope: string): Promise<string> {
      const { verifier, challenge } = pkcePair();
      const code = await getAuthCode(app, { clientId: "x-confidential-client", challenge, scope });
      const tokenRes = await app.request(`${base}/2/oauth2/token`, {
        method: "POST",
        headers: {
          Authorization: basicHeader("x-confidential-client", "x-confidential-secret"),
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: form({
          grant_type: "authorization_code",
          code,
          redirect_uri: "http://localhost:3000/callback",
          code_verifier: verifier,
        }).toString(),
      });
      return ((await tokenRes.json()) as { access_token: string }).access_token;
    }

    it("returns the authenticated user from GET /2/users/me", async () => {
      const token = await userToken("tweet.read users.read");
      const res = await app.request(`${base}/2/users/me`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: { id: string; username: string } };
      expect(body.data.username).toBe("developer");
      expect(body.data.id).toBe("1000000000000000001");
    });

    it("creates a tweet with tweet.write scope", async () => {
      const token = await userToken("tweet.read tweet.write users.read");
      const res = await app.request(`${base}/2/tweets`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ text: "Posting from the test." }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { data: { id: string; text: string } };
      expect(body.data.id).toBeTruthy();
      expect(body.data.text).toBe("Posting from the test.");

      // The new tweet is readable.
      const getRes = await app.request(`${base}/2/tweets/${body.data.id}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(getRes.status).toBe(200);
    });

    it("rejects POST /2/tweets without the tweet.write scope (403)", async () => {
      const token = await userToken("tweet.read users.read");
      const res = await app.request(`${base}/2/tweets`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ text: "Should be forbidden." }),
      });
      expect(res.status).toBe(403);
      const body = (await res.json()) as { status: number; title: string };
      expect(body.status).toBe(403);
    });

    it("returns 401 for a missing or invalid token", async () => {
      const res = await app.request(`${base}/2/tweets/2000000000000000001`);
      expect(res.status).toBe(401);

      const badRes = await app.request(`${base}/2/tweets/2000000000000000001`, {
        headers: { Authorization: "Bearer not-a-real-token" },
      });
      expect(badRes.status).toBe(401);
    });
  });

  describe("openapi", () => {
    it("serves a curated spec declaring the three security schemes", async () => {
      const res = await app.request(`${base}/2/openapi.json`);
      expect(res.status).toBe(200);
      const spec = (await res.json()) as {
        components: { securitySchemes: Record<string, { type: string; scheme?: string }> };
      };
      const schemes = spec.components.securitySchemes;
      expect(schemes.BearerToken).toMatchObject({ type: "http", scheme: "bearer" });
      expect(schemes.OAuth2UserToken.type).toBe("oauth2");
      expect(schemes.UserToken).toMatchObject({ type: "http", scheme: "OAuth" });
    });
  });
});
