import { createHash, timingSafeEqual } from "crypto";
import type { AppEnv, Context, RouteContext } from "@emulators/core";
import {
  bodyStr,
  escapeHtml,
  recordSideEffect,
  renderCardPage,
  renderErrorPage,
  renderUserButton,
} from "@emulators/core";
import {
  ACCESS_TOKEN_TTL_SECONDS,
  AUTHORIZATION_CODE_TTL_MS,
  DCR_DEFAULT_SCOPES,
  ERROR_DESCRIPTIONS,
  SCOPES_SUPPORTED,
  SERVICE_LABEL,
  SUPPORTED_GRANT_TYPES,
  generateClientId,
  generateClientSecret,
  generateToken,
  missingParam,
} from "../constants.js";
import type { PlanetScaleOAuthClient } from "../entities.js";
import { getPlanetScaleStore, type PlanetScaleStore } from "../store.js";

type Ctx = Context<AppEnv>;

export function authorizationServerMetadata(baseUrl: string) {
  return {
    issuer: baseUrl,
    authorization_endpoint: `${baseUrl}/oauth/authorize`,
    token_endpoint: `${baseUrl}/oauth/token`,
    revocation_endpoint: `${baseUrl}/oauth/revoke`,
    registration_endpoint: `${baseUrl}/oauth/registration`,
    scopes_supported: SCOPES_SUPPORTED,
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: SUPPORTED_GRANT_TYPES,
    token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
    code_challenge_methods_supported: ["plain", "S256"],
    authorization_response_iss_parameter_supported: true,
  };
}

// ---------------------------------------------------------------------------
// Dynamic Client Registration
// ---------------------------------------------------------------------------

export interface RegisterClientInput {
  client_name?: unknown;
  redirect_uris?: unknown;
  token_endpoint_auth_method?: unknown;
  grant_types?: unknown;
  response_types?: unknown;
  client_id?: string;
  client_secret?: string;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Doorkeeper's redirect URI validation messages, as the real endpoint joins them. */
function redirectUriErrors(uris: string[]): string[] {
  if (uris.length === 0) return ["Redirect uri can't be blank", "Redirect uri is not a valid URI"];
  for (const uri of uris) {
    let url: URL;
    try {
      url = new URL(uri);
    } catch {
      return ["Redirect uri must be an absolute URI.", "Redirect uri is not a valid URI"];
    }
    if (url.hash || uri.includes("#")) return ["Redirect uri cannot contain a fragment."];
    if (url.protocol === "http:" && !LOOPBACK_HOSTS.has(url.hostname)) {
      return ["Redirect uri must be an HTTPS/SSL URI."];
    }
  }
  return [];
}

export type RegisterResult =
  | { ok: true; client: PlanetScaleOAuthClient }
  | { ok: false; error: string; error_description: string };

export function registerClient(ps: PlanetScaleStore, input: RegisterClientInput): RegisterResult {
  const clientName = typeof input.client_name === "string" ? input.client_name.trim() : "";
  const redirectUris = Array.isArray(input.redirect_uris)
    ? input.redirect_uris.filter((uri): uri is string => typeof uri === "string" && uri.length > 0)
    : [];
  const problems = [...(clientName ? [] : ["Name can't be blank"]), ...redirectUriErrors(redirectUris)];
  if (problems.length > 0) {
    return { ok: false, error: "invalid_client_params", error_description: problems.join(", ") };
  }
  const authMethod =
    input.token_endpoint_auth_method === "client_secret_post" ? "client_secret_post" : "client_secret_basic";
  const requestedGrants = Array.isArray(input.grant_types)
    ? input.grant_types.filter((g): g is string => typeof g === "string" && SUPPORTED_GRANT_TYPES.includes(g))
    : [];
  const client = ps.oauthClients.insert({
    client_id: input.client_id ?? generateClientId(),
    client_secret: input.client_secret ?? generateClientSecret(),
    client_name: clientName,
    redirect_uris: redirectUris,
    token_endpoint_auth_method: authMethod,
    grant_types: requestedGrants.length > 0 ? requestedGrants : SUPPORTED_GRANT_TYPES,
    response_types: ["code"],
    // PlanetScale replaces whatever scope was requested with its default set.
    scope: DCR_DEFAULT_SCOPES.join(" "),
    application_type: "web",
    client_id_issued_at: Math.floor(Date.now() / 1000),
  });
  return { ok: true, client };
}

/** The registration response, in the real field order. No client_secret_expires_at. */
export function registrationResponse(client: PlanetScaleOAuthClient) {
  return {
    client_secret: client.client_secret,
    client_id: client.client_id,
    client_name: client.client_name,
    client_id_issued_at: client.client_id_issued_at,
    redirect_uris: client.redirect_uris,
    token_endpoint_auth_method: client.token_endpoint_auth_method,
    response_types: client.response_types,
    grant_types: client.grant_types,
    scope: client.scope,
    application_type: client.application_type,
  };
}

// ---------------------------------------------------------------------------
// Doorkeeper client authentication
// ---------------------------------------------------------------------------

interface PresentedCredentials {
  method: "client_secret_basic" | "client_secret_post" | "none";
  clientId: string;
  clientSecret: string | null;
}

/**
 * Doorkeeper's `from_basic` then `from_params`. The Basic header is base64
 * decoded and split on the first colon; the halves are used LITERALLY, with no
 * form url decoding. When a Basic header is present the body is never consulted.
 */
function presentedCredentials(authorization: string | undefined, form: Record<string, string>): PresentedCredentials {
  const basic = /^Basic\s+(.+)$/i.exec(authorization ?? "");
  if (basic) {
    const decoded = Buffer.from(basic[1].trim(), "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    return separator >= 0
      ? {
          method: "client_secret_basic",
          clientId: decoded.slice(0, separator),
          clientSecret: decoded.slice(separator + 1),
        }
      : { method: "client_secret_basic", clientId: decoded, clientSecret: null };
  }
  if (form.client_id) {
    return { method: "client_secret_post", clientId: form.client_id, clientSecret: form.client_secret ?? null };
  }
  return { method: "none", clientId: "", clientSecret: null };
}

function secretsEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

type ClientAuthOutcome =
  | "authenticated"
  | "no_client_authentication"
  | "unknown_client"
  | "missing_client_secret"
  | "client_secret_mismatch";

/**
 * Authenticate the client and record a sanitized ledger note. The note carries
 * the auth method, the client_id exactly as presented (not secret), whether it
 * looks form url encoded, and the outcome. Secrets are never recorded.
 */
function authenticateClient(
  c: Ctx,
  ps: PlanetScaleStore,
  form: Record<string, string>,
): { client: PlanetScaleOAuthClient } | { client: null } {
  const creds = presentedCredentials(c.req.header("Authorization"), form);
  let outcome: ClientAuthOutcome;
  let client: PlanetScaleOAuthClient | undefined;
  if (creds.method === "none") {
    outcome = "no_client_authentication";
  } else {
    client = ps.oauthClients.findOneBy("client_id", creds.clientId);
    if (!client) outcome = "unknown_client";
    else if (creds.clientSecret === null || creds.clientSecret === "") outcome = "missing_client_secret";
    else if (!secretsEqual(creds.clientSecret, client.client_secret)) outcome = "client_secret_mismatch";
    else outcome = "authenticated";
  }
  const percentEncoded = /%[0-9A-Fa-f]{2}/.test(creds.clientId);
  recordSideEffect(c, {
    type: "custom",
    collection: "planetscale.client_auth",
    summary:
      `client_auth method=${creds.method} outcome=${outcome}` +
      (creds.clientId ? ` client_id=${JSON.stringify(creds.clientId)}` : "") +
      ` client_id_percent_encoded=${percentEncoded}`,
  });
  return outcome === "authenticated" && client ? { client } : { client: null };
}

// ---------------------------------------------------------------------------
// Doorkeeper error responses
// ---------------------------------------------------------------------------

function oauthError(c: Ctx, status: 400 | 401, error: string, description: string): Response {
  c.header("Cache-Control", "no-store");
  c.header(
    "WWW-Authenticate",
    `Bearer realm="Doorkeeper", error="${error}", error_description="${description.replace(/"/g, '\\"')}"`,
  );
  return c.json({ error, error_description: description }, status);
}

const invalidClient = (c: Ctx) => oauthError(c, 401, "invalid_client", ERROR_DESCRIPTIONS.invalid_client);
const invalidGrant = (c: Ctx) => oauthError(c, 400, "invalid_grant", ERROR_DESCRIPTIONS.invalid_grant);
const invalidRequest = (c: Ctx, param: string) => oauthError(c, 400, "invalid_request", missingParam(param));

async function readForm(c: Ctx): Promise<Record<string, string>> {
  const raw = await c.req.text();
  const contentType = c.req.header("Content-Type") ?? "";
  if (contentType.includes("application/json")) {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      return Object.fromEntries(
        Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
      );
    } catch {
      return {};
    }
  }
  return Object.fromEntries(new URLSearchParams(raw));
}

function verifyPkce(verifier: string, challenge: string, method: string | null): boolean {
  if (method === "S256") return createHash("sha256").update(verifier).digest("base64url") === challenge;
  return verifier === challenge;
}

function scopeIsAllowed(requested: string, allowed: string): boolean {
  const allowedSet = new Set(allowed.split(/\s+/).filter(Boolean));
  return requested
    .split(/\s+/)
    .filter(Boolean)
    .every((scope) => allowedSet.has(scope));
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const AUTHORIZE_FIELDS = [
  "client_id",
  "redirect_uri",
  "response_type",
  "state",
  "scope",
  "code_challenge",
  "code_challenge_method",
  "resource",
] as const;
type AuthorizeParams = Record<(typeof AUTHORIZE_FIELDS)[number], string>;

type AuthorizeCheck =
  | { ok: true; client: PlanetScaleOAuthClient; scope: string; challengeMethod: string | null }
  | { ok: false; page: Response }
  | { ok: false; redirect: string };

export function registerOAuthRoutes(ctx: RouteContext): void {
  const { app, store, baseUrl } = ctx;
  const ps = () => getPlanetScaleStore(store);

  app.get("/.well-known/oauth-authorization-server", (c) => {
    c.set("operationId", "planetscale.oauth.authorizationServerMetadata");
    return c.json(authorizationServerMetadata(baseUrl));
  });

  app.post("/oauth/registration", async (c) => {
    c.set("operationId", "planetscale.oauth.register");
    const body = (await c.req.json().catch(() => ({}))) as RegisterClientInput;
    const result = registerClient(ps(), {
      client_name: body.client_name,
      redirect_uris: body.redirect_uris,
      token_endpoint_auth_method: body.token_endpoint_auth_method,
      grant_types: body.grant_types,
    });
    if (!result.ok) return c.json({ error: result.error, error_description: result.error_description }, 400);
    recordSideEffect(c, {
      type: "create",
      collection: "planetscale.oauth_clients",
      id: result.client.id,
      summary: `registered ${result.client.client_id}`,
    });
    return c.json(registrationResponse(result.client), 201);
  });

  const redirectWith = (redirectUri: string, params: Record<string, string>): string => {
    const url = new URL(redirectUri);
    for (const [key, value] of Object.entries(params)) if (value) url.searchParams.set(key, value);
    return url.toString();
  };

  // Doorkeeper renders an error page (no redirect) until the client and redirect
  // URI are trusted; after that, errors travel back to the client's redirect URI.
  const checkAuthorize = (c: Ctx, p: AuthorizeParams): AuthorizeCheck => {
    const client = p.client_id ? ps().oauthClients.findOneBy("client_id", p.client_id) : undefined;
    if (!client) {
      return {
        ok: false,
        page: c.html(
          renderErrorPage("Client authentication failed", ERROR_DESCRIPTIONS.invalid_client, SERVICE_LABEL),
          401,
        ),
      };
    }
    if (!p.redirect_uri || !client.redirect_uris.includes(p.redirect_uri)) {
      return {
        ok: false,
        page: c.html(
          renderErrorPage("Invalid redirect URI", ERROR_DESCRIPTIONS.invalid_redirect_uri, SERVICE_LABEL),
          400,
        ),
      };
    }
    const fail = (error: string, description: string): AuthorizeCheck => ({
      ok: false,
      redirect: redirectWith(p.redirect_uri, { error, error_description: description, state: p.state, iss: baseUrl }),
    });
    if (!p.response_type) return fail("invalid_request", missingParam("response_type"));
    if (p.response_type !== "code")
      return fail("unsupported_response_type", ERROR_DESCRIPTIONS.unsupported_response_type);
    const scope = p.scope || client.scope;
    if (!scopeIsAllowed(scope, client.scope)) return fail("invalid_scope", ERROR_DESCRIPTIONS.invalid_scope);
    let challengeMethod: string | null = null;
    if (p.code_challenge) {
      challengeMethod = p.code_challenge_method || "plain";
      if (challengeMethod !== "plain" && challengeMethod !== "S256") {
        return fail("invalid_request", "The code challenge method must be plain or S256.");
      }
    }
    return { ok: true, client, scope, challengeMethod };
  };

  app.get("/oauth/authorize", (c) => {
    c.set("operationId", "planetscale.oauth.authorize");
    const p = Object.fromEntries(AUTHORIZE_FIELDS.map((k) => [k, c.req.query(k) ?? ""])) as AuthorizeParams;
    const check = checkAuthorize(c, p);
    if (!check.ok) return "page" in check ? check.page : c.redirect(check.redirect, 302);

    const users = ps().users.all();
    const hidden = Object.fromEntries(AUTHORIZE_FIELDS.map((k) => [k, p[k]]));
    const buttons = users
      .map((user) =>
        renderUserButton({
          letter: (user.login[0] ?? "?").toUpperCase(),
          login: user.login,
          name: user.name ?? undefined,
          email: user.email ?? undefined,
          formAction: `${baseUrl}/oauth/authorize`,
          hiddenFields: hidden,
        }),
      )
      .join("\n");
    const empty = `<p class="empty">No users are seeded in this instance. Seed one with <code>POST ${escapeHtml(
      baseUrl,
    )}/_emulate/seed</code> and <code>{"users":[{"login":"..."}]}</code>.</p>`;
    const subtitle = `Authorize <strong>${escapeHtml(check.client.client_name)}</strong> to use your PlanetScale account. Choose the user to sign in as.`;
    return c.html(renderCardPage("Authorize application", subtitle, users.length ? buttons : empty, SERVICE_LABEL));
  });

  // Approval: the consent page's user buttons POST here (Doorkeeper approves on
  // POST /oauth/authorize). Issues a code and redirects with code, state, iss.
  app.post("/oauth/authorize", async (c) => {
    c.set("operationId", "planetscale.oauth.approve");
    const body = await c.req.parseBody();
    const p = Object.fromEntries(AUTHORIZE_FIELDS.map((k) => [k, bodyStr(body[k])])) as AuthorizeParams;
    const check = checkAuthorize(c, p);
    if (!check.ok) return "page" in check ? check.page : c.redirect(check.redirect, 302);
    const login = bodyStr(body.login);
    const user = ps().users.findOneBy("login", login);
    if (!user) {
      return c.html(
        renderErrorPage(
          "Unknown user",
          `${login || "(no login)"} is not a seeded user in this instance.`,
          SERVICE_LABEL,
        ),
        400,
      );
    }
    const code = generateToken();
    const grant = ps().oauthGrants.insert({
      code,
      client_id: check.client.client_id,
      redirect_uri: p.redirect_uri,
      scope: check.scope,
      code_challenge: p.code_challenge || null,
      code_challenge_method: check.challengeMethod,
      resource: p.resource || null,
      login: user.login,
      expires_at: Date.now() + AUTHORIZATION_CODE_TTL_MS,
      revoked: false,
    });
    recordSideEffect(c, {
      type: "create",
      collection: "planetscale.oauth_grants",
      id: grant.id,
      summary: `authorization code for ${check.client.client_id} as ${user.login}`,
    });
    return c.redirect(redirectWith(p.redirect_uri, { code, state: p.state, iss: baseUrl }), 302);
  });

  app.post("/oauth/token", async (c) => {
    c.set("operationId", "planetscale.oauth.token");
    const form = await readForm(c);
    const grantType = form.grant_type ?? "";
    // Parameter validation precedes client authentication, as on the real server.
    if (!grantType) return invalidRequest(c, "grant_type");
    if (!SUPPORTED_GRANT_TYPES.includes(grantType)) {
      return oauthError(c, 400, "unsupported_grant_type", ERROR_DESCRIPTIONS.unsupported_grant_type);
    }
    const data = ps();

    if (grantType === "authorization_code") {
      if (!form.code) return invalidRequest(c, "code");
      const grant = data.oauthGrants.findOneBy("code", form.code);
      if (grant?.code_challenge && !form.code_verifier) return invalidRequest(c, "code_verifier");
      if (!form.redirect_uri) return invalidRequest(c, "redirect_uri");

      const { client } = authenticateClient(c, data, form);
      if (!client) return invalidClient(c);
      if (!grant || grant.revoked || grant.expires_at < Date.now() || grant.client_id !== client.client_id) {
        return invalidGrant(c);
      }
      if (grant.redirect_uri !== form.redirect_uri) return invalidGrant(c);
      if (grant.code_challenge && !verifyPkce(form.code_verifier, grant.code_challenge, grant.code_challenge_method)) {
        return invalidGrant(c);
      }
      data.oauthGrants.update(grant.id, { revoked: true });
      return issueTokens(c, data, client.client_id, grant.login, grant.scope);
    }

    // refresh_token
    if (!form.refresh_token) return invalidRequest(c, "refresh_token");
    const { client } = authenticateClient(c, data, form);
    if (!client) return invalidClient(c);
    const previous = data.oauthTokens.findOneBy("refresh_token", form.refresh_token);
    if (!previous || previous.revoked || previous.client_id !== client.client_id) return invalidGrant(c);
    const scope = form.scope || previous.scope;
    if (!scopeIsAllowed(scope, previous.scope)) {
      return oauthError(c, 400, "invalid_scope", ERROR_DESCRIPTIONS.invalid_scope);
    }
    data.oauthTokens.update(previous.id, { revoked: true });
    return issueTokens(c, data, client.client_id, previous.login, scope);
  });

  app.post("/oauth/revoke", async (c) => {
    c.set("operationId", "planetscale.oauth.revoke");
    const form = await readForm(c);
    const data = ps();
    const { client } = authenticateClient(c, data, form);
    if (!client) {
      return c.json(
        { error: "unauthorized_client", error_description: "You are not authorized to revoke this token" },
        403,
      );
    }
    const token =
      data.oauthTokens.findOneBy("access_token", form.token ?? "") ??
      data.oauthTokens.findOneBy("refresh_token", form.token ?? "");
    if (token && token.client_id === client.client_id && !token.revoked) {
      data.oauthTokens.update(token.id, { revoked: true });
      recordSideEffect(c, { type: "update", collection: "planetscale.oauth_tokens", id: token.id, summary: "revoked" });
    }
    return c.json({});
  });
}

function issueTokens(c: Ctx, data: PlanetScaleStore, clientId: string, login: string, scope: string): Response {
  const createdAt = Math.floor(Date.now() / 1000);
  const token = data.oauthTokens.insert({
    access_token: generateToken(),
    refresh_token: generateToken(),
    client_id: clientId,
    login,
    scope,
    expires_at: (createdAt + ACCESS_TOKEN_TTL_SECONDS) * 1000,
    revoked: false,
  });
  recordSideEffect(c, {
    type: "create",
    collection: "planetscale.oauth_tokens",
    id: token.id,
    summary: `access token for ${clientId} as ${login}`,
  });
  c.header("Cache-Control", "no-store");
  return c.json({
    access_token: token.access_token,
    token_type: "Bearer",
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    refresh_token: token.refresh_token,
    scope,
    created_at: createdAt,
  });
}
