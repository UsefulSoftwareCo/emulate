import { createHash } from "crypto";
import { SignJWT } from "jose";
import type { AppEnv, Context, RouteContext } from "@emulators/core";
import {
  bodyStr,
  constantTimeSecretEqual,
  escapeHtml,
  recordSideEffect,
  renderCardPage,
  renderErrorPage,
  renderUserButton,
} from "@emulators/core";
import {
  ACCESS_TOKEN_TTL_SECONDS,
  AUTHORIZATION_CODE_TTL_MS,
  GRANT_TYPES_ADVERTISED,
  ID_TOKEN_TTL_SECONDS,
  JWT_BEARER_GRANT,
  SCOPES_SUPPORTED,
  SERVICE_DOCUMENTATION,
  SERVICE_LABEL,
  generateClientId,
  generateClientSecret,
  generateToken,
} from "../constants.js";
import type { MiroOAuthClient, MiroUser } from "../entities.js";
import { getMiroConfig, getMiroStore, type MiroStore } from "../store.js";

type Ctx = Context<AppEnv>;

/**
 * Miro's issuer is the origin WITH a trailing slash (`https://mcp.miro.com/`),
 * while every endpoint is joined without a double slash. The emulator keeps
 * that shape relative to its own base URL.
 */
export const issuerFor = (baseUrl: string) => `${baseUrl}/`;

/** RFC 8414 document, as served at https://mcp.miro.com/.well-known/oauth-authorization-server. */
export function authorizationServerMetadata(baseUrl: string) {
  return {
    issuer: issuerFor(baseUrl),
    authorization_endpoint: `${baseUrl}/authorize`,
    token_endpoint: `${baseUrl}/token`,
    registration_endpoint: `${baseUrl}/register`,
    scopes_supported: SCOPES_SUPPORTED,
    response_types_supported: ["code"],
    grant_types_supported: GRANT_TYPES_ADVERTISED,
    token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic"],
    service_documentation: SERVICE_DOCUMENTATION,
    code_challenge_methods_supported: ["S256"],
  };
}

/**
 * OIDC discovery document, as served at https://mcp.miro.com/.well-known/openid-configuration.
 *
 * It disagrees with the RFC 8414 document on purpose, because the real one does:
 * it advertises `token_endpoint_auth_methods_supported: ["none"]` although the
 * token endpoint requires a client secret, it adds `revocation_endpoint` and a
 * nonstandard `audience` (no trailing slash), and it advertises HS256 ID tokens
 * with no `jwks_uri`. The RFC 8414 document has no ID token fields at all.
 */
export function openIdConfiguration(baseUrl: string) {
  return {
    issuer: issuerFor(baseUrl),
    token_endpoint: `${baseUrl}/token`,
    token_endpoint_auth_methods_supported: ["none"],
    grant_types_supported: GRANT_TYPES_ADVERTISED,
    authorization_endpoint: `${baseUrl}/authorize`,
    registration_endpoint: `${baseUrl}/register`,
    response_types_supported: ["code"],
    subject_types_supported: ["public"],
    id_token_signing_alg_values_supported: ["HS256"],
    scopes_supported: SCOPES_SUPPORTED,
    claims_supported: ["iss", "sub", "aud", "exp", "iat", "email", "email_verified"],
    code_challenge_methods_supported: ["S256"],
    revocation_endpoint: `${baseUrl}/oidc/revoke`,
    audience: baseUrl,
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
  scope?: unknown;
  client_id?: string;
  client_secret?: string;
}

export type RegisterResult =
  | { ok: true; client: MiroOAuthClient }
  | { ok: false; error: "invalid_client_metadata"; error_description: string };

const metadataError = (description: string): RegisterResult => ({
  ok: false,
  error: "invalid_client_metadata",
  error_description: description,
});

/**
 * Validation follows the messages observed from the real `/register`
 * (`redirect_uris: Field required`, `redirect_uris: Input should be a valid list`).
 * The remaining rules (auth method, grant types, scope subset) are assumed from
 * the MCP Python SDK registration handler those messages come from.
 */
export function registerClient(miro: MiroStore, input: RegisterClientInput): RegisterResult {
  if (input.redirect_uris === undefined || input.redirect_uris === null) {
    return metadataError("redirect_uris: Field required");
  }
  if (!Array.isArray(input.redirect_uris)) return metadataError("redirect_uris: Input should be a valid list");
  const redirectUris: string[] = [];
  for (const uri of input.redirect_uris) {
    if (typeof uri !== "string") return metadataError("redirect_uris: Input should be a valid URL");
    try {
      new URL(uri);
    } catch {
      return metadataError("redirect_uris: Input should be a valid URL");
    }
    redirectUris.push(uri);
  }
  if (redirectUris.length === 0) return metadataError("redirect_uris: List should have at least 1 item");

  const method = input.token_endpoint_auth_method ?? "client_secret_post";
  if (method !== "client_secret_post" && method !== "client_secret_basic") {
    return metadataError("token_endpoint_auth_method: Input should be 'client_secret_post' or 'client_secret_basic'");
  }

  const grantTypes = Array.isArray(input.grant_types)
    ? input.grant_types.filter((g): g is string => typeof g === "string")
    : ["authorization_code", "refresh_token"];
  if (!grantTypes.includes("authorization_code") || !grantTypes.includes("refresh_token")) {
    return metadataError("grant_types must be authorization_code and refresh_token");
  }

  const requestedScope = typeof input.scope === "string" && input.scope.trim() ? input.scope.trim() : null;
  if (requestedScope) {
    const invalid = requestedScope.split(/\s+/).filter((s) => !SCOPES_SUPPORTED.includes(s));
    if (invalid.length > 0) return metadataError(`Requested scopes are not valid: ${invalid.join(", ")}`);
  }

  const client = miro.oauthClients.insert({
    client_id: input.client_id ?? generateClientId(),
    client_secret: input.client_secret ?? generateClientSecret(),
    client_name: typeof input.client_name === "string" ? input.client_name : null,
    redirect_uris: redirectUris,
    token_endpoint_auth_method: method,
    grant_types: grantTypes,
    response_types: ["code"],
    scope: requestedScope ?? SCOPES_SUPPORTED.join(" "),
    client_id_issued_at: Math.floor(Date.now() / 1000),
  });
  return { ok: true, client };
}

/** The registration response: the client information with null fields omitted. */
export function registrationResponse(client: MiroOAuthClient) {
  return {
    redirect_uris: client.redirect_uris,
    token_endpoint_auth_method: client.token_endpoint_auth_method,
    grant_types: client.grant_types,
    response_types: client.response_types,
    scope: client.scope,
    ...(client.client_name !== null ? { client_name: client.client_name } : {}),
    client_id: client.client_id,
    client_secret: client.client_secret,
    client_id_issued_at: client.client_id_issued_at,
  };
}

// ---------------------------------------------------------------------------
// Token endpoint client authentication
// ---------------------------------------------------------------------------

function tokenError(c: Ctx, status: 400 | 401, error: string, description: string): Response {
  c.header("Cache-Control", "no-store");
  c.header("Pragma", "no-cache");
  return c.json({ error, error_description: description }, status);
}

const safeDecode = (value: string) => {
  try {
    return decodeURIComponent(value.replace(/\+/g, " "));
  } catch {
    return value;
  }
};

type ClientAuth = { ok: true; client: MiroOAuthClient; method: string } | { ok: false; response: Response };

/**
 * Observed on the real endpoint: client authentication runs before any grant
 * validation (`Missing client_id` and `Invalid client_id`, both 401). The
 * secret mismatch message is assumed. Basic credentials are form url decoded
 * per RFC 6749 section 2.3.1. Either method is accepted regardless of the one
 * registered.
 */
function authenticateClient(c: Ctx, miro: MiroStore, form: Record<string, string>): ClientAuth {
  let method = "none";
  let clientId = "";
  let clientSecret = "";
  const basic = /^Basic\s+(.+)$/i.exec(c.req.header("Authorization") ?? "");
  if (basic) {
    const decoded = Buffer.from(basic[1].trim(), "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    method = "client_secret_basic";
    clientId = safeDecode(separator >= 0 ? decoded.slice(0, separator) : decoded);
    clientSecret = separator >= 0 ? safeDecode(decoded.slice(separator + 1)) : "";
  } else if (form.client_id) {
    method = "client_secret_post";
    clientId = form.client_id;
    clientSecret = form.client_secret ?? "";
  }

  let outcome: string;
  let client: MiroOAuthClient | undefined;
  if (!clientId) outcome = "missing_client_id";
  else if (!(client = miro.oauthClients.findOneBy("client_id", clientId))) outcome = "invalid_client_id";
  else if (!clientSecret || !constantTimeSecretEqual(clientSecret, client.client_secret))
    outcome = "invalid_client_secret";
  else outcome = "authenticated";

  recordSideEffect(c, {
    type: "custom",
    collection: "miro.client_auth",
    summary: `client_auth method=${method} outcome=${outcome}${clientId ? ` client_id=${JSON.stringify(clientId)}` : ""}`,
  });

  if (outcome === "authenticated" && client) return { ok: true, client, method };
  const description =
    outcome === "missing_client_id"
      ? "Missing client_id"
      : outcome === "invalid_client_id"
        ? "Invalid client_id"
        : "Invalid client_secret";
  return { ok: false, response: tokenError(c, 401, "invalid_client", description) };
}

async function readForm(c: Ctx): Promise<Record<string, string>> {
  const raw = await c.req.text();
  return Object.fromEntries(new URLSearchParams(raw));
}

// ---------------------------------------------------------------------------
// Authorization endpoint
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
  "nonce",
] as const;
type AuthorizeParams = Record<(typeof AUTHORIZE_FIELDS)[number], string>;

type AuthorizeCheck =
  | { ok: true; client: MiroOAuthClient; redirectUri: string; explicit: boolean; scope: string }
  | { ok: false; response: Response };

function authorizeJsonError(c: Ctx, description: string, extra: Record<string, string> = {}): Response {
  c.header("Cache-Control", "no-store");
  return c.json({ error: "invalid_request", error_description: description, ...extra }, 400);
}

function redirectWith(redirectUri: string, params: Record<string, string>): string {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) if (value) url.searchParams.set(key, value);
  return url.toString();
}

export function registerOAuthRoutes(ctx: RouteContext): void {
  const { app, store, baseUrl } = ctx;
  const miro = () => getMiroStore(store);

  app.get("/.well-known/oauth-authorization-server", (c) => {
    c.set("operationId", "miro.oauth.authorizationServerMetadata");
    c.header("Cache-Control", "public, max-age=3600");
    return c.json(authorizationServerMetadata(baseUrl));
  });

  app.get("/.well-known/openid-configuration", (c) => {
    c.set("operationId", "miro.oidc.configuration");
    return c.json(openIdConfiguration(baseUrl));
  });

  app.post("/register", async (c) => {
    c.set("operationId", "miro.oauth.register");
    const body = (await c.req.json().catch(() => ({}))) as RegisterClientInput;
    const result = registerClient(miro(), {
      client_name: body.client_name,
      redirect_uris: body.redirect_uris,
      token_endpoint_auth_method: body.token_endpoint_auth_method,
      grant_types: body.grant_types,
      scope: body.scope,
    });
    if (!result.ok) return c.json({ error: result.error, error_description: result.error_description }, 400);
    recordSideEffect(c, {
      type: "create",
      collection: "miro.oauth_clients",
      id: result.client.id,
      summary: `registered ${result.client.client_id}`,
    });
    return c.json(registrationResponse(result.client), 201);
  });

  /**
   * Request validation, in the order the real endpoint applies it:
   * 1. field validation (`client_id: Field required`, `code_challenge_method: Input should be 'S256'`),
   *    reported as JSON unless the client and redirect URI are already trusted,
   * 2. client lookup, with Miro's re-register hint and `Link` header,
   * 3. redirect URI, then scope (both assumed from the MCP Python SDK).
   */
  const checkAuthorize = (c: Ctx, p: AuthorizeParams): AuthorizeCheck => {
    const client = p.client_id ? miro().oauthClients.findOneBy("client_id", p.client_id) : undefined;
    let redirectUri: string | null = null;
    if (client) {
      if (p.redirect_uri) redirectUri = client.redirect_uris.includes(p.redirect_uri) ? p.redirect_uri : null;
      else if (client.redirect_uris.length === 1) redirectUri = client.redirect_uris[0];
    }

    const fieldErrors: string[] = [];
    if (!p.client_id) fieldErrors.push("client_id: Field required");
    if (!p.response_type) fieldErrors.push("response_type: Field required");
    else if (p.response_type !== "code") fieldErrors.push("response_type: Input should be 'code'");
    if (!p.code_challenge) fieldErrors.push("code_challenge: Field required");
    if (p.code_challenge_method && p.code_challenge_method !== "S256") {
      fieldErrors.push("code_challenge_method: Input should be 'S256'");
    }
    if (fieldErrors.length > 0) {
      const description = fieldErrors.join("\n");
      if (client && redirectUri) {
        return {
          ok: false,
          response: c.redirect(
            redirectWith(redirectUri, { error: "invalid_request", error_description: description, state: p.state }),
            302,
          ),
        };
      }
      return { ok: false, response: authorizeJsonError(c, description) };
    }

    if (!client) {
      c.header("Link", `<${baseUrl}/register>; rel="http://oauth.net/core/2.1/#registration"`);
      return {
        ok: false,
        response: authorizeJsonError(
          c,
          `Client ID '${p.client_id}' is not registered with this server. MCP clients should automatically re-register by sending a POST request to the registration_endpoint and retry authorization. If this persists, clear cached authentication tokens and reconnect.`,
          {
            registration_endpoint: `${baseUrl}/register`,
            authorization_server_metadata: `${baseUrl}/.well-known/oauth-authorization-server`,
          },
        ),
      };
    }
    if (!redirectUri) {
      return {
        ok: false,
        response: authorizeJsonError(
          c,
          p.redirect_uri
            ? `Redirect URI '${p.redirect_uri}' not registered for client`
            : "Only one redirect_uri may be omitted when the client has a single registered redirect URI",
        ),
      };
    }
    const scope = p.scope.trim() || client.scope;
    const allowed = new Set(client.scope.split(/\s+/));
    const unknown = scope.split(/\s+/).find((s) => !allowed.has(s));
    if (unknown) {
      return {
        ok: false,
        response: c.redirect(
          redirectWith(redirectUri, {
            error: "invalid_scope",
            error_description: `Client was not registered with scope ${unknown}`,
            state: p.state,
          }),
          302,
        ),
      };
    }
    return { ok: true, client, redirectUri, explicit: Boolean(p.redirect_uri), scope };
  };

  const readAuthorizeQuery = (c: Ctx) =>
    Object.fromEntries(AUTHORIZE_FIELDS.map((k) => [k, c.req.query(k) ?? ""])) as AuthorizeParams;

  app.get("/authorize", (c) => {
    c.set("operationId", "miro.oauth.authorize");
    const p = readAuthorizeQuery(c);
    const check = checkAuthorize(c, p);
    if (!check.ok) return check.response;

    const users = miro().users.all();
    const hidden = Object.fromEntries(AUTHORIZE_FIELDS.map((k) => [k, p[k]]));
    const buttons = users
      .map((user) =>
        renderUserButton({
          letter: (user.name[0] ?? user.email[0] ?? "?").toUpperCase(),
          login: user.email,
          name: user.name,
          email: user.email,
          formAction: `${baseUrl}/authorize`,
          hiddenFields: hidden,
        }),
      )
      .join("\n");
    const empty = `<p class="empty">No users are seeded in this instance. Seed one with <code>POST ${escapeHtml(
      baseUrl,
    )}/_emulate/seed</code> and <code>{"users":[{"email":"..."}]}</code>.</p>`;
    const clientLabel = check.client.client_name ?? check.client.client_id;
    const subtitle = `Allow <strong>${escapeHtml(clientLabel)}</strong> to access your Miro boards (${escapeHtml(
      check.scope,
    )}). Choose the user to sign in as.`;
    return c.html(renderCardPage("Install Miro MCP", subtitle, users.length ? buttons : empty, SERVICE_LABEL));
  });

  // The consent page's user buttons POST here. Issues a code and redirects.
  app.post("/authorize", async (c) => {
    c.set("operationId", "miro.oauth.approve");
    const body = await c.req.parseBody();
    const p = Object.fromEntries(AUTHORIZE_FIELDS.map((k) => [k, bodyStr(body[k])])) as AuthorizeParams;
    const check = checkAuthorize(c, p);
    if (!check.ok) return check.response;
    const email = bodyStr(body.login);
    const user = miro().users.findOneBy("email", email);
    if (!user) {
      return c.html(
        renderErrorPage(
          "Unknown user",
          `${email || "(no user)"} is not a seeded user in this instance.`,
          SERVICE_LABEL,
        ),
        400,
      );
    }
    const code = generateToken();
    const grant = miro().oauthGrants.insert({
      code,
      client_id: check.client.client_id,
      redirect_uri: check.redirectUri,
      redirect_uri_provided_explicitly: check.explicit,
      scope: check.scope,
      code_challenge: p.code_challenge,
      resource: p.resource || null,
      nonce: p.nonce || null,
      email: user.email,
      expires_at: Date.now() + AUTHORIZATION_CODE_TTL_MS,
      used: false,
    });
    recordSideEffect(c, {
      type: "create",
      collection: "miro.oauth_grants",
      id: grant.id,
      summary: `authorization code for ${check.client.client_id} as ${user.email}${grant.nonce ? " (nonce received)" : ""}`,
    });
    return c.redirect(redirectWith(check.redirectUri, { code, state: p.state }), 302);
  });

  app.post("/token", async (c) => {
    c.set("operationId", "miro.oauth.token");
    const form = await readForm(c);
    const data = miro();
    const auth = authenticateClient(c, data, form);
    if (!auth.ok) return auth.response;
    const { client } = auth;
    const grantType = form.grant_type ?? "";

    if (grantType === "authorization_code") {
      if (!form.code) return tokenError(c, 400, "invalid_request", "code: Field required");
      if (!form.code_verifier) return tokenError(c, 400, "invalid_request", "code_verifier: Field required");
      const grant = data.oauthGrants.findOneBy("code", form.code);
      if (!grant || grant.used) return tokenError(c, 400, "invalid_grant", "authorization code does not exist");
      if (grant.client_id !== client.client_id) {
        return tokenError(c, 400, "invalid_grant", "authorization code was not issued to this client");
      }
      if (grant.expires_at < Date.now()) return tokenError(c, 400, "invalid_grant", "authorization code has expired");
      const expectedRedirect = grant.redirect_uri_provided_explicitly ? grant.redirect_uri : null;
      if (expectedRedirect !== null && form.redirect_uri !== expectedRedirect) {
        return tokenError(c, 400, "invalid_request", "redirect_uri did not match the one used when creating auth code");
      }
      const computed = createHash("sha256").update(form.code_verifier).digest("base64url");
      if (computed !== grant.code_challenge) return tokenError(c, 400, "invalid_grant", "incorrect code_verifier");
      data.oauthGrants.update(grant.id, { used: true });
      const user = data.users.findOneBy("email", grant.email);
      return issueTokens(c, store, baseUrl, data, client, grant.email, user, grant.scope, grant.nonce);
    }

    if (grantType === "refresh_token") {
      if (!form.refresh_token) return tokenError(c, 400, "invalid_request", "refresh_token: Field required");
      const previous = data.oauthTokens.findOneBy("refresh_token", form.refresh_token);
      if (!previous || previous.revoked || previous.client_id !== client.client_id) {
        return tokenError(c, 400, "invalid_grant", "refresh token does not exist");
      }
      const scope = form.scope?.trim() || previous.scope;
      const granted = new Set(previous.scope.split(/\s+/));
      const widened = scope.split(/\s+/).find((s) => !granted.has(s));
      if (widened) {
        return tokenError(c, 400, "invalid_scope", `cannot request scope \`${widened}\` not provided by refresh token`);
      }
      // Rotation (assumed): the presented refresh token and its access token are
      // revoked, and a new pair is issued. Replaying the old refresh token fails
      // with invalid_grant.
      data.oauthTokens.update(previous.id, { revoked: true });
      const user = data.users.findOneBy("email", previous.email);
      return issueTokens(c, store, baseUrl, data, client, previous.email, user, scope, null);
    }

    if (grantType === JWT_BEARER_GRANT) {
      return tokenError(
        c,
        400,
        "unsupported_grant_type",
        "The jwt-bearer grant is advertised by Miro but not implemented by this emulator.",
      );
    }
    return tokenError(c, 400, "unsupported_grant_type", `grant_type ${grantType || "(missing)"} is not supported`);
  });

  /**
   * RFC 7009 revocation. The real endpoint answers 200 with an empty body for an
   * empty request. When a token is presented the client must authenticate
   * (assumed); revoking either half revokes the access and refresh token pair.
   */
  app.post("/oidc/revoke", async (c) => {
    c.set("operationId", "miro.oauth.revoke");
    const form = await readForm(c);
    if (!form.token) return c.body(null, 200);
    const data = miro();
    const auth = authenticateClient(c, data, form);
    if (!auth.ok) return auth.response;
    const token =
      data.oauthTokens.findOneBy("access_token", form.token) ?? data.oauthTokens.findOneBy("refresh_token", form.token);
    if (token && token.client_id === auth.client.client_id && !token.revoked) {
      data.oauthTokens.update(token.id, { revoked: true });
      recordSideEffect(c, { type: "update", collection: "miro.oauth_tokens", id: token.id, summary: "revoked" });
    }
    return c.body(null, 200);
  });
}

async function issueTokens(
  c: Ctx,
  store: RouteContext["store"],
  baseUrl: string,
  data: MiroStore,
  client: MiroOAuthClient,
  email: string,
  user: MiroUser | undefined,
  scope: string,
  nonce: string | null,
): Promise<Response> {
  const now = Math.floor(Date.now() / 1000);
  const token = data.oauthTokens.insert({
    access_token: generateToken(),
    refresh_token: generateToken(),
    client_id: client.client_id,
    email,
    scope,
    expires_at: (now + ACCESS_TOKEN_TTL_SECONDS) * 1000,
    revoked: false,
  });
  const scopes = scope.split(/\s+/);
  let idToken: string | undefined;
  if (scopes.includes("openid")) {
    const mode = getMiroConfig(store).id_token_nonce;
    // MIRO QUIRK: the real Miro token endpoint signs the ID token with HS256 using
    // the client secret and NEVER includes the `nonce` claim, even when the
    // authorization request carried one. OIDC Core 3.1.3.7 requires the claim
    // whenever a nonce was sent, so strict clients (oauth4webapi, openid-client)
    // reject the response. `mode === "omit"` reproduces this; seed
    // `id_token_nonce: "echo"` to compare against compliant behaviour.
    const claims: Record<string, unknown> = {};
    if (scopes.includes("email")) {
      claims.email = email;
      claims.email_verified = true;
    }
    if (mode === "echo" && nonce) claims.nonce = nonce;
    idToken = await new SignJWT(claims)
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setIssuer(issuerFor(baseUrl))
      .setSubject(user?.user_id ?? email)
      .setAudience(client.client_id)
      .setIssuedAt(now)
      .setExpirationTime(now + ID_TOKEN_TTL_SECONDS)
      .sign(new TextEncoder().encode(client.client_secret));
  }
  recordSideEffect(c, {
    type: "create",
    collection: "miro.oauth_tokens",
    id: token.id,
    summary:
      `access token for ${client.client_id} as ${email}` +
      (idToken
        ? ` with id_token (nonce ${nonce ? (getMiroConfig(store).id_token_nonce === "echo" ? "echoed" : "omitted") : "not requested"})`
        : ""),
  });
  c.header("Cache-Control", "no-store");
  c.header("Pragma", "no-cache");
  return c.json({
    access_token: token.access_token,
    token_type: "Bearer",
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    scope,
    refresh_token: token.refresh_token,
    ...(idToken ? { id_token: idToken } : {}),
  });
}
