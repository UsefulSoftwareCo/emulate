import { createHash, randomBytes } from "crypto";
import type { Context, RouteContext, Store } from "@emulators/core";
import {
  bodyStr,
  constantTimeSecretEqual,
  escapeHtml,
  recordSideEffect,
  renderCardPage,
  renderDenyButton,
  renderErrorPage,
  renderUserButton,
} from "@emulators/core";
import { getZapierStore, type ZapierOAuthClient, type ZapierToken } from "./store.js";

/**
 * Zapier MCP's OAuth, at the addresses its published metadata names (read from
 * mcp.zapier.com on 2026-11-26): path-aware protected resource metadata for
 * /api/v1/connect, an authorization server at the same origin with dynamic
 * registration, S256 PKCE, public and confidential clients, refresh tokens,
 * revocation and userinfo. Token lifetimes are not documented; access tokens
 * last an hour and refresh tokens rotate (assumed).
 */
export const MCP_PATH = "/api/v1/connect";
export const SCOPES = ["openid", "profile", "email"];
const ACCESS_TTL_S = 3600;
const CODE_TTL_MS = 10 * 60 * 1000;
const SERVICE_LABEL = "Zapier";

export function resourceUrl(baseUrl: string): string {
  return `${baseUrl}${MCP_PATH}`;
}

export function protectedResourceMetadataUrl(baseUrl: string): string {
  const u = new URL(baseUrl);
  return `${u.origin}/.well-known/oauth-protected-resource${u.pathname.replace(/\/$/, "")}${MCP_PATH}`;
}

function token(prefix: string): string {
  return prefix + randomBytes(24).toString("base64url");
}

function tokenError(c: Context, status: 400 | 401, error: string, description: string) {
  return c.json({ error, error_description: description }, status);
}

async function readForm(c: Context): Promise<Record<string, string>> {
  const type = c.req.header("Content-Type") ?? "";
  if (type.includes("application/json")) {
    const j = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(j).map(([k, v]) => [k, typeof v === "string" ? v : String(v ?? "")]));
  }
  return Object.fromEntries(new URLSearchParams(await c.req.text()));
}

/** Issue an access token (and refresh token) for an account. */
export function issueOAuthToken(store: Store, clientId: string | null, email: string, scope: string): ZapierToken {
  return getZapierStore(store).tokens.insert({
    access_token: token("zpat_"),
    refresh_token: token("zprt_"),
    client_id: clientId,
    email,
    scope,
    kind: "oauth",
    expires_at: Date.now() + ACCESS_TTL_S * 1000,
    revoked: false,
  });
}

/** The account's long-lived connection token (one per account; regenerating replaces it). */
export function regenerateConnectionToken(store: Store, email: string): ZapierToken {
  const zs = getZapierStore(store);
  for (const t of zs.tokens.findBy("email", email)) if (t.kind === "connection") zs.tokens.delete(t.id);
  return zs.tokens.insert({
    access_token: token("zpct_"),
    refresh_token: null,
    client_id: null,
    email,
    scope: SCOPES.join(" "),
    kind: "connection",
    expires_at: null,
    revoked: false,
  });
}

/** A live token's account, or null. */
export function resolveToken(store: Store, value: string): ZapierToken | null {
  const t = getZapierStore(store).tokens.findOneBy("access_token", value);
  if (!t || t.revoked) return null;
  if (t.expires_at !== null && t.expires_at < Date.now()) return null;
  return t;
}

export function oauthRoutes({ app, store, baseUrl }: RouteContext): void {
  const zs = () => getZapierStore(store);

  app.get("/.well-known/oauth-protected-resource", (c) =>
    c.json(
      {
        error: "not_found",
        error_description:
          "No protected resource exists at the root domain. Protected resources are available at specific endpoints",
      },
      404,
    ),
  );

  app.get(`/.well-known/oauth-protected-resource${MCP_PATH}`, (c) => {
    c.set("operationId", "zapier.oauth.protectedResourceMetadata");
    return c.json({ resource: resourceUrl(baseUrl), authorization_servers: [baseUrl], scopes_supported: SCOPES });
  });

  app.get("/.well-known/oauth-authorization-server", (c) => {
    c.set("operationId", "zapier.oauth.authorizationServerMetadata");
    return c.json({
      issuer: baseUrl,
      authorization_endpoint: `${baseUrl}/oauth/authorize`,
      token_endpoint: `${baseUrl}/api/v1/oauth/token`,
      registration_endpoint: `${baseUrl}/api/v1/oauth/register`,
      revocation_endpoint: `${baseUrl}/api/v1/oauth/revoke`,
      userinfo_endpoint: `${baseUrl}/api/v1/oauth/userinfo`,
      scopes_supported: SCOPES,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
      code_challenge_methods_supported: ["S256"],
    });
  });

  // RFC 7591 dynamic client registration.
  app.post("/api/v1/oauth/register", async (c) => {
    c.set("operationId", "zapier.oauth.register");
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return c.json({ error: "invalid_client_metadata", error_description: "Body must be JSON." }, 400);
    const uris = Array.isArray(body.redirect_uris)
      ? body.redirect_uris.filter((u): u is string => typeof u === "string")
      : [];
    if (uris.length === 0 || uris.some((u) => !/^[a-z][a-z0-9+.-]*:/i.test(u))) {
      return c.json({ error: "invalid_redirect_uri", error_description: "redirect_uris must be absolute URIs." }, 400);
    }
    const method = (body.token_endpoint_auth_method as string | undefined) ?? "client_secret_basic";
    if (!["none", "client_secret_post", "client_secret_basic"].includes(method)) {
      return c.json(
        { error: "invalid_client_metadata", error_description: `Unsupported token_endpoint_auth_method ${method}.` },
        400,
      );
    }
    const client = zs().clients.insert({
      client_id: token("zpc_"),
      client_secret: method === "none" ? null : token("zps_"),
      client_name: typeof body.client_name === "string" ? body.client_name : null,
      redirect_uris: uris,
      token_endpoint_auth_method: method as ZapierOAuthClient["token_endpoint_auth_method"],
      grant_types: ["authorization_code", "refresh_token"],
      created_at_s: Math.floor(Date.now() / 1000),
    });
    recordSideEffect(c, { type: "create", collection: "zapier.oauth_clients", id: client.client_id });
    return c.json(
      {
        client_id: client.client_id,
        ...(client.client_secret ? { client_secret: client.client_secret, client_secret_expires_at: 0 } : {}),
        client_id_issued_at: client.created_at_s,
        client_name: client.client_name,
        redirect_uris: client.redirect_uris,
        token_endpoint_auth_method: client.token_endpoint_auth_method,
        grant_types: client.grant_types,
        response_types: ["code"],
      },
      201,
    );
  });

  const FIELDS = [
    "response_type",
    "client_id",
    "redirect_uri",
    "scope",
    "state",
    "code_challenge",
    "code_challenge_method",
    "resource",
  ] as const;
  type Params = Record<(typeof FIELDS)[number], string>;

  function check(c: Context, p: Params): { client: ZapierOAuthClient; scope: string } | Response {
    const client = zs().clients.findOneBy("client_id", p.client_id);
    if (!client) return c.html(renderErrorPage("Unknown client", "This client is not registered.", SERVICE_LABEL), 400);
    if (!client.redirect_uris.includes(p.redirect_uri)) {
      return c.html(
        renderErrorPage("Invalid redirect", "The redirect_uri is not registered for this client.", SERVICE_LABEL),
        400,
      );
    }
    const fail = (error: string, description: string) => {
      const u = new URL(p.redirect_uri);
      u.searchParams.set("error", error);
      u.searchParams.set("error_description", description);
      if (p.state) u.searchParams.set("state", p.state);
      return c.redirect(u.toString(), 302);
    };
    if (p.response_type !== "code") return fail("unsupported_response_type", "response_type must be code.");
    if (!p.code_challenge || p.code_challenge_method !== "S256") {
      return fail("invalid_request", "PKCE with code_challenge_method S256 is required.");
    }
    if (p.resource && p.resource !== resourceUrl(baseUrl)) return fail("invalid_target", "Unknown resource.");
    const scope = p.scope.trim() || SCOPES.join(" ");
    if (scope.split(/\s+/).some((s) => !SCOPES.includes(s))) return fail("invalid_scope", "Unsupported scope.");
    return { client, scope };
  }

  app.get("/oauth/authorize", (c) => {
    c.set("operationId", "zapier.oauth.authorize");
    const p = Object.fromEntries(FIELDS.map((k) => [k, c.req.query(k) ?? ""])) as Params;
    const ok = check(c, p);
    if (ok instanceof Response) return ok;
    const accounts = zs().accounts.all();
    const buttons = accounts
      .map((a) =>
        renderUserButton({
          letter: (a.name[0] ?? a.email[0] ?? "?").toUpperCase(),
          login: a.email,
          name: a.name,
          email: a.email,
          formAction: `${baseUrl}/oauth/authorize`,
          hiddenFields: Object.fromEntries(FIELDS.map((k) => [k, p[k]])),
        }),
      )
      .join("\n");
    const label = ok.client.client_name ?? ok.client.client_id;
    const body = accounts.length
      ? `${buttons}\n${renderDenyButton({ redirectUri: p.redirect_uri, state: p.state })}`
      : `<p class="empty">No accounts are seeded. Seed one with <code>{"accounts":[{"email":"..."}]}</code>.</p>`;
    return c.html(
      renderCardPage(
        "Connect to Zapier MCP",
        `Allow <strong>${escapeHtml(label)}</strong> to use your Zapier MCP server. Choose the account to sign in as.`,
        body,
        SERVICE_LABEL,
      ),
    );
  });

  app.post("/oauth/authorize", async (c) => {
    c.set("operationId", "zapier.oauth.approve");
    const form = await c.req.parseBody();
    const p = Object.fromEntries(FIELDS.map((k) => [k, bodyStr(form[k])])) as Params;
    const ok = check(c, p);
    if (ok instanceof Response) return ok;
    const email = bodyStr(form.login);
    if (!zs().accounts.findOneBy("email", email)) {
      return c.html(
        renderErrorPage("Unknown account", `${email || "(none)"} is not a seeded account.`, SERVICE_LABEL),
        400,
      );
    }
    const code = token("zpcode_");
    zs().codes.insert({
      code,
      client_id: ok.client.client_id,
      redirect_uri: p.redirect_uri,
      code_challenge: p.code_challenge,
      scope: ok.scope,
      email,
      resource: p.resource || null,
      expires_at: Date.now() + CODE_TTL_MS,
      used: false,
    });
    const u = new URL(p.redirect_uri);
    u.searchParams.set("code", code);
    if (p.state) u.searchParams.set("state", p.state);
    return c.redirect(u.toString(), 302);
  });

  function authenticateClient(c: Context, form: Record<string, string>): ZapierOAuthClient | Response {
    const basic = /^Basic\s+(.+)$/i.exec(c.req.header("Authorization") ?? "");
    let id = form.client_id ?? "";
    let secret: string | undefined = form.client_secret;
    if (basic) {
      const decoded = Buffer.from(basic[1]!, "base64").toString();
      const i = decoded.indexOf(":");
      id = decodeURIComponent(decoded.slice(0, i));
      secret = decodeURIComponent(decoded.slice(i + 1));
    }
    const client = zs().clients.findOneBy("client_id", id);
    if (!client) return tokenError(c, 401, "invalid_client", "Unknown client.");
    if (client.token_endpoint_auth_method !== "none") {
      if (!secret || !client.client_secret || !constantTimeSecretEqual(secret, client.client_secret)) {
        return tokenError(c, 401, "invalid_client", "Client authentication failed.");
      }
    }
    return client;
  }

  const tokenResponse = (c: Context, t: ZapierToken) =>
    c.json({
      access_token: t.access_token,
      token_type: "Bearer",
      expires_in: ACCESS_TTL_S,
      refresh_token: t.refresh_token,
      scope: t.scope,
    });

  app.post("/api/v1/oauth/token", async (c) => {
    c.set("operationId", "zapier.oauth.token");
    const form = await readForm(c);
    const client = authenticateClient(c, form);
    if (client instanceof Response) return client;
    if (form.grant_type === "authorization_code") {
      const grant = zs().codes.findOneBy("code", form.code ?? "");
      if (!grant || grant.used || grant.client_id !== client.client_id || grant.expires_at < Date.now()) {
        return tokenError(c, 400, "invalid_grant", "The authorization code is invalid or expired.");
      }
      if (form.redirect_uri !== grant.redirect_uri)
        return tokenError(c, 400, "invalid_grant", "redirect_uri does not match.");
      const computed = createHash("sha256")
        .update(form.code_verifier ?? "")
        .digest("base64url");
      if (computed !== grant.code_challenge) return tokenError(c, 400, "invalid_grant", "PKCE verification failed.");
      zs().codes.update(grant.id, { used: true });
      const t = issueOAuthToken(store, client.client_id, grant.email, grant.scope);
      recordSideEffect(c, { type: "create", collection: "zapier.tokens", summary: `token for ${grant.email}` });
      return tokenResponse(c, t);
    }
    if (form.grant_type === "refresh_token") {
      const prev = zs().tokens.findOneBy("refresh_token", form.refresh_token ?? "");
      if (!prev || prev.revoked || prev.client_id !== client.client_id) {
        return tokenError(c, 400, "invalid_grant", "The refresh token is invalid.");
      }
      zs().tokens.update(prev.id, { revoked: true });
      return tokenResponse(c, issueOAuthToken(store, client.client_id, prev.email, prev.scope));
    }
    return tokenError(
      c,
      400,
      "unsupported_grant_type",
      `grant_type ${form.grant_type || "(missing)"} is not supported.`,
    );
  });

  app.post("/api/v1/oauth/revoke", async (c) => {
    c.set("operationId", "zapier.oauth.revoke");
    const form = await readForm(c);
    const value = form.token ?? "";
    const t = zs().tokens.findOneBy("access_token", value) ?? zs().tokens.findOneBy("refresh_token", value);
    if (t && t.kind === "oauth") zs().tokens.update(t.id, { revoked: true });
    return c.body(null, 200);
  });

  app.get("/api/v1/oauth/userinfo", (c) => {
    c.set("operationId", "zapier.oauth.userinfo");
    const m = /^Bearer\s+(.+)$/i.exec(c.req.header("Authorization") ?? "");
    const t = m ? resolveToken(store, m[1]!.trim()) : null;
    if (!t) return c.json({ error: "invalid_token" }, 401);
    const a = zs().accounts.findOneBy("email", t.email)!;
    return c.json({ sub: a.account_id, email: a.email, email_verified: true, name: a.name });
  });
}
