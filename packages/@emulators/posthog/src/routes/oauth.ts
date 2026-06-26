import { createHash, randomBytes } from "node:crypto";
import type { RouteContext } from "@emulators/core";
import {
  bodyStr,
  constantTimeSecretEqual,
  matchesRedirectUri,
  renderCardPage,
  renderUserButton,
} from "@emulators/core";

import type { OAuthClientMetadata, PendingOAuthCode, RegisteredOAuthClient } from "../entities.js";
import { getPendingOAuthCodes, getPostHogStore } from "../store.js";

const CODE_TTL_MS = 10 * 60 * 1000;

export const POSTHOG_SCOPES = [
  "project:read",
  "project:write",
  "event_definition:read",
  "event_definition:write",
  "event:read",
  "event:write",
  "person:read",
  "person:write",
  "feature_flag:read",
  "feature_flag:write",
  "organization:read",
  "user:read",
  "openid",
  "email",
  "profile",
] as const;

const SERVICE_LABEL = "PostHog";

function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
}

function isAcceptableClientIdUrl(url: URL): boolean {
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && isLoopbackHost(url.hostname);
}

function invalidClientId() {
  return { error: "invalid_request", error_description: "Invalid client_id parameter value." };
}

function codeExpired(code: PendingOAuthCode): boolean {
  return Date.now() - code.created_at > CODE_TTL_MS;
}

function randomId(prefix: string): string {
  return `${prefix}_${randomBytes(24).toString("base64url")}`;
}

function parseScopes(scope: string): string[] {
  return scope.split(/\s+/).filter(Boolean);
}

function verifyPkce(code: PendingOAuthCode, verifier: string): boolean {
  if (!code.code_challenge) return true;
  if (!verifier) return false;
  if ((code.code_challenge_method ?? "").toLowerCase() !== "s256") return false;
  const digest = createHash("sha256").update(verifier).digest("base64url");
  return constantTimeSecretEqual(digest, code.code_challenge);
}

function isOAuthClientMetadata(value: unknown, clientId: string): value is OAuthClientMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const body = value as Record<string, unknown>;
  if (typeof body.client_id === "string" && body.client_id !== clientId) return false;
  if (!Array.isArray(body.redirect_uris)) return false;
  return body.redirect_uris.every((uri) => typeof uri === "string");
}

async function resolveClientMetadata(clientId: string): Promise<OAuthClientMetadata | null> {
  let url: URL;
  try {
    url = new URL(clientId);
  } catch {
    return null;
  }
  if (!isAcceptableClientIdUrl(url)) return null;

  const response = await fetch(url).catch(() => null);
  if (!response?.ok) return null;
  const body = (await response.json().catch(() => null)) as unknown;
  if (!isOAuthClientMetadata(body, clientId)) return null;
  return {
    client_id: clientId,
    client_name: typeof body.client_name === "string" ? body.client_name : undefined,
    redirect_uris: body.redirect_uris,
    token_endpoint_auth_method:
      typeof body.token_endpoint_auth_method === "string" ? body.token_endpoint_auth_method : "none",
    grant_types: Array.isArray(body.grant_types)
      ? body.grant_types.filter((v): v is string => typeof v === "string")
      : undefined,
    response_types: Array.isArray(body.response_types)
      ? body.response_types.filter((v): v is string => typeof v === "string")
      : undefined,
  };
}

function registeredClientToMetadata(client: RegisteredOAuthClient): OAuthClientMetadata {
  return {
    client_id: client.client_id,
    client_name: client.client_name,
    redirect_uris: client.redirect_uris,
    token_endpoint_auth_method: client.token_endpoint_auth_method,
    grant_types: ["authorization_code"],
    response_types: ["code"],
  };
}

async function resolveClient(ctx: RouteContext, clientId: string): Promise<OAuthClientMetadata | null> {
  const registered = getPostHogStore(ctx.store).oauthClients.findOneBy("client_id", clientId);
  if (registered) return registeredClientToMetadata(registered);
  return resolveClientMetadata(clientId);
}

export function oauthRoutes(ctx: RouteContext): void {
  const { app, store, baseUrl, tokenMap } = ctx;
  const ps = getPostHogStore(store);

  app.get("/.well-known/oauth-protected-resource", (c) =>
    c.json({
      resource: baseUrl,
      authorization_servers: [baseUrl],
      bearer_methods_supported: ["header"],
      scopes_supported: POSTHOG_SCOPES,
    }),
  );

  const authServerMetadata = {
    issuer: baseUrl,
    authorization_endpoint: `${baseUrl}/oauth/authorize/`,
    token_endpoint: `${baseUrl}/oauth/token/`,
    registration_endpoint: `${baseUrl}/oauth/register/`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
    client_id_metadata_document_supported: true,
    resource_indicators_supported: true,
    scopes_supported: POSTHOG_SCOPES,
  };

  app.get("/.well-known/oauth-authorization-server", (c) => c.json(authServerMetadata));
  app.get("/.well-known/openid-configuration", (c) => c.json(authServerMetadata));

  app.post("/oauth/register/", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const redirectUris = Array.isArray(body.redirect_uris)
      ? body.redirect_uris.filter((uri): uri is string => typeof uri === "string" && uri.length > 0)
      : [];
    if (redirectUris.length === 0) {
      return c.json({ error: "invalid_redirect_uri", error_description: "redirect_uris is required." }, 400);
    }

    const authMethod = typeof body.token_endpoint_auth_method === "string" ? body.token_endpoint_auth_method : "none";
    const client = ps.oauthClients.insert({
      client_id: randomId("posthog_client"),
      client_secret: authMethod === "none" ? null : randomId("posthog_secret"),
      client_name: typeof body.client_name === "string" ? body.client_name : "PostHog OAuth client",
      redirect_uris: redirectUris,
      token_endpoint_auth_method: authMethod,
    });

    return c.json(
      {
        client_id: client.client_id,
        ...(client.client_secret ? { client_secret: client.client_secret } : {}),
        redirect_uris: client.redirect_uris,
        grant_types: ["authorization_code"],
        response_types: ["code"],
        token_endpoint_auth_method: client.token_endpoint_auth_method,
        client_name: client.client_name,
      },
      201,
    );
  });

  app.post("/oauth/register", (c) => c.redirect(`${baseUrl}/oauth/register/`, 307));

  app.get("/oauth/authorize/", async (c) => {
    const clientId = c.req.query("client_id") ?? "";
    const redirectUri = c.req.query("redirect_uri") ?? "";
    const responseType = c.req.query("response_type") ?? "";
    const scope = c.req.query("scope") ?? "";
    const state = c.req.query("state") ?? "";
    const resource = c.req.query("resource") ?? "";
    const codeChallenge = c.req.query("code_challenge") ?? "";
    const codeChallengeMethod = c.req.query("code_challenge_method") ?? "";

    if (responseType !== "code") {
      return c.json(
        { error: "unsupported_response_type", error_description: "Only response_type=code is supported." },
        400,
      );
    }
    if (resource && resource !== baseUrl) {
      return c.json({ error: "invalid_target", error_description: "Unknown resource." }, 400);
    }
    if (codeChallengeMethod && codeChallengeMethod.toLowerCase() !== "s256") {
      return c.json({ error: "invalid_request", error_description: "Only S256 PKCE is supported." }, 400);
    }

    const client = await resolveClient(ctx, clientId);
    if (!client || !redirectUri || !matchesRedirectUri(redirectUri, client.redirect_uris)) {
      return c.json(invalidClientId(), 400);
    }

    const users = ps.users.all();
    const buttons = users
      .map((user) =>
        renderUserButton({
          letter: (user.email[0] ?? "?").toUpperCase(),
          login: user.email,
          name: user.name,
          email: user.email,
          formAction: `${baseUrl}/oauth/authorize/approve`,
          hiddenFields: {
            user_uuid: user.uuid,
            client_id: clientId,
            redirect_uri: redirectUri,
            state,
            scope,
            code_challenge: codeChallenge,
            code_challenge_method: codeChallengeMethod,
          },
        }),
      )
      .join("\n");

    const clientName = client.client_name ?? "an OAuth client";
    return c.html(
      renderCardPage(
        "Authorize PostHog",
        `Authorize <strong>${clientName}</strong> to access PostHog as a seeded user.`,
        users.length > 0 ? buttons : '<p class="empty">No users in the emulator store.</p>',
        SERVICE_LABEL,
      ),
    );
  });

  app.get("/oauth/authorize", (c) => {
    const query = new URL(c.req.url).search;
    return c.redirect(`${baseUrl}/oauth/authorize/${query}`, 307);
  });

  app.post("/oauth/authorize/approve", async (c) => {
    const body = await c.req.parseBody();
    const userUuid = bodyStr(body.user_uuid);
    const user = ps.users.findOneBy("uuid", userUuid);
    const clientId = bodyStr(body.client_id);
    const redirectUri = bodyStr(body.redirect_uri);
    const client = await resolveClient(ctx, clientId);

    if (!user || !client || !matchesRedirectUri(redirectUri, client.redirect_uris)) {
      return c.json({ error: "invalid_request", error_description: "Invalid authorization request." }, 400);
    }

    const code = randomId("code");
    getPendingOAuthCodes(store).set(code, {
      user_uuid: user.uuid,
      login: user.email,
      scope: bodyStr(body.scope),
      redirect_uri: redirectUri,
      client_id: clientId,
      code_challenge: bodyStr(body.code_challenge) || null,
      code_challenge_method: bodyStr(body.code_challenge_method) || null,
      created_at: Date.now(),
    });

    const redirect = new URL(redirectUri);
    redirect.searchParams.set("code", code);
    const state = bodyStr(body.state);
    if (state) redirect.searchParams.set("state", state);
    return c.redirect(redirect.toString());
  });

  app.post("/oauth/token/", async (c) => {
    const body = await c.req.parseBody();
    const grantType = bodyStr(body.grant_type);
    if (grantType !== "authorization_code") {
      return c.json(
        { error: "unsupported_grant_type", error_description: "grant_type must be authorization_code" },
        400,
      );
    }

    const codeValue = bodyStr(body.code);
    const code = getPendingOAuthCodes(store).get(codeValue);
    if (!code || codeExpired(code)) {
      return c.json({ error: "invalid_grant", error_description: "Invalid or expired authorization code." }, 400);
    }
    if (bodyStr(body.client_id) !== code.client_id || bodyStr(body.redirect_uri) !== code.redirect_uri) {
      return c.json({ error: "invalid_grant", error_description: "Client or redirect_uri mismatch." }, 400);
    }
    if (!verifyPkce(code, bodyStr(body.code_verifier))) {
      return c.json({ error: "invalid_grant", error_description: "PKCE verification failed." }, 400);
    }

    const user = ps.users.findOneBy("uuid", code.user_uuid);
    if (!user) return c.json({ error: "invalid_grant", error_description: "User no longer exists." }, 400);

    getPendingOAuthCodes(store).delete(codeValue);
    const token = randomId("phx");
    tokenMap?.set(token, { login: user.email, id: user.id, scopes: parseScopes(code.scope) });
    return c.json({
      access_token: token,
      token_type: "Bearer",
      expires_in: 3600,
      scope: code.scope,
    });
  });

  app.post("/oauth/token", (c) => c.redirect(`${baseUrl}/oauth/token/`, 307));
}
