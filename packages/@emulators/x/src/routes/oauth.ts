import { createHash, randomBytes } from "crypto";
import type { Context } from "@emulators/core";
import {
  escapeHtml,
  renderCardPage,
  renderErrorPage,
  renderUserButton,
  matchesRedirectUri,
  constantTimeSecretEqual,
  bodyStr,
  debug,
  type RouteContext,
} from "@emulators/core";
import { getXStore } from "../store.js";
import type { XOAuthClient } from "../entities.js";

const SERVICE_LABEL = "X";
const AUTH_CODE_TTL_MS = 10 * 60 * 1000;
const ACCESS_TOKEN_TTL_SECONDS = 7200;

/**
 * The full set of OAuth 2.0 scopes the X v2 platform declares for the
 * authorization-code flow (OAuth2UserToken). Used to validate requested scopes
 * and to populate the authorize consent.
 */
export const X_SCOPES = [
  "tweet.read",
  "tweet.write",
  "tweet.moderate.write",
  "users.read",
  "follows.read",
  "follows.write",
  "offline.access",
  "space.read",
  "mute.read",
  "mute.write",
  "like.read",
  "like.write",
  "list.read",
  "list.write",
  "block.read",
  "block.write",
  "bookmark.read",
  "bookmark.write",
] as const;

interface ClientCredentials {
  clientId: string;
  clientSecret: string | null;
  /** True when the credentials came from an HTTP Basic Authorization header. */
  fromBasic: boolean;
}

/**
 * Parse client credentials from a token request. X supports a single client-auth
 * method per client type:
 *   - Confidential clients: HTTP Basic header `Authorization: Basic base64(id:secret)`
 *     (client_secret_basic). X does NOT support client_secret_post.
 *   - Public clients: `client_id` in the request body, no secret (PKCE only).
 * The HTTP Basic header takes precedence when present. `fromBasic` records whether
 * the credentials arrived via the Basic header so the authenticator can enforce
 * that confidential clients used it (and did not post their secret in the body).
 */
function parseClientCredentials(c: Context, body: Record<string, unknown>): ClientCredentials {
  const basic = /^Basic\s+(.+)$/i.exec(c.req.header("Authorization") ?? "");
  if (basic) {
    try {
      const decoded = Buffer.from(basic[1].trim(), "base64").toString("utf-8");
      const sep = decoded.indexOf(":");
      if (sep >= 0) {
        return {
          clientId: decodeURIComponent(decoded.slice(0, sep)),
          clientSecret: decodeURIComponent(decoded.slice(sep + 1)),
          fromBasic: true,
        };
      }
    } catch {
      // Malformed Basic header — fall through to body credentials.
    }
  }
  const clientId = typeof body.client_id === "string" ? body.client_id : "";
  const clientSecret = typeof body.client_secret === "string" ? body.client_secret : null;
  return { clientId, clientSecret, fromBasic: false };
}

function s256(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

async function parseTokenBody(c: Context): Promise<Record<string, unknown>> {
  const contentType = c.req.header("Content-Type") ?? "";
  const rawText = await c.req.text();
  if (contentType.includes("application/json")) {
    try {
      return JSON.parse(rawText) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return Object.fromEntries(new URLSearchParams(rawText));
}

function opaqueToken(): string {
  // X access tokens are opaque, long, URL-safe strings.
  return randomBytes(32).toString("base64url");
}

export function oauthRoutes({ app, store, baseUrl }: RouteContext): void {
  const xs = getXStore(store);

  /**
   * Validate a client and its authentication for the token endpoint. X supports a
   * single client-auth method per client type, and is strict about it:
   *   - Confidential clients authenticate with the HTTP Basic Authorization header
   *     (client_secret_basic). X does NOT support client_secret_post, so a secret
   *     sent in the request body is rejected even when it is correct.
   *   - Public clients send client_id in the body, carry no secret, and rely on
   *     PKCE (enforced at code redemption).
   * Returns the client on success, or a faithful error tuple on failure.
   */
  function authenticateClient(
    creds: ClientCredentials,
    _body: Record<string, unknown>,
  ): { client: XOAuthClient } | { error: string; description: string; status: 400 | 401 } {
    // A request with neither a Basic header nor a body client_id cannot identify
    // the client at all.
    if (!creds.clientId) {
      return {
        error: "invalid_request",
        description: "A client_id is required. Public clients must include client_id in the request body.",
        status: 400,
      };
    }

    const client = xs.oauthClients.findOneBy("client_id", creds.clientId);
    if (!client) {
      return { error: "invalid_client", description: "Unknown client_id.", status: 401 };
    }

    if (client.client_type === "confidential") {
      // Confidential clients MUST authenticate with the HTTP Basic header
      // (client_secret_basic). A secret in the body (client_secret_post) is not a
      // supported method on X and is rejected even when the secret value is
      // correct — this is what lets the emulator reproduce the real-world failure
      // of an app that incorrectly posts its secret in the body.
      if (!creds.fromBasic) {
        return {
          error: "invalid_client",
          description: "Confidential clients must authenticate with HTTP Basic.",
          status: 401,
        };
      }
      if (!constantTimeSecretEqual(creds.clientSecret ?? "", client.client_secret ?? "")) {
        return { error: "invalid_client", description: "Invalid client credentials.", status: 401 };
      }
    } else {
      // Public clients have no secret. Presenting one (in the Basic header or the
      // body) is not a valid public-client request on X.
      if (creds.fromBasic || creds.clientSecret != null) {
        return {
          error: "invalid_client",
          description: "Public clients have no client_secret and must authenticate with PKCE only.",
          status: 401,
        };
      }
    }

    return { client };
  }

  // ---------- Authorization page (GET /2/oauth2/authorize) ----------

  app.get("/2/oauth2/authorize", (c) => {
    const client_id = c.req.query("client_id") ?? "";
    const redirect_uri = c.req.query("redirect_uri") ?? "";
    const scope = c.req.query("scope") ?? "";
    const state = c.req.query("state") ?? "";
    const response_type = c.req.query("response_type") ?? "";
    const code_challenge = c.req.query("code_challenge") ?? "";
    const code_challenge_method = c.req.query("code_challenge_method") ?? "";

    const client = xs.oauthClients.findOneBy("client_id", client_id);
    if (!client) {
      return c.html(
        renderErrorPage(
          "Application not found",
          `The client_id '${escapeHtml(client_id)}' is not registered.`,
          SERVICE_LABEL,
        ),
        400,
      );
    }
    if (redirect_uri && !matchesRedirectUri(redirect_uri, client.redirect_uris)) {
      return c.html(
        renderErrorPage(
          "Redirect URI mismatch",
          "The redirect_uri is not registered for this application.",
          SERVICE_LABEL,
        ),
        400,
      );
    }
    if (response_type && response_type !== "code") {
      return c.html(
        renderErrorPage("Unsupported response_type", "Only response_type=code is supported.", SERVICE_LABEL),
        400,
      );
    }
    // X requires PKCE for the authorization-code flow.
    if (!code_challenge) {
      return c.html(
        renderErrorPage(
          "PKCE required",
          "A code_challenge is required for the authorization code flow.",
          SERVICE_LABEL,
        ),
        400,
      );
    }
    if (code_challenge_method.toUpperCase() !== "S256") {
      return c.html(
        renderErrorPage(
          "Unsupported PKCE method",
          "code_challenge_method must be S256 for the X authorization code flow.",
          SERVICE_LABEL,
        ),
        400,
      );
    }

    const requestedScopes = scope.split(/[\s+]+/).filter(Boolean);
    const unknownScope = requestedScopes.find((s) => !X_SCOPES.includes(s as (typeof X_SCOPES)[number]));
    if (unknownScope) {
      return c.html(
        renderErrorPage("Invalid scope", `The scope '${escapeHtml(unknownScope)}' is not supported.`, SERVICE_LABEL),
        400,
      );
    }

    const users = [...xs.users.all()].sort((a, b) => a.username.localeCompare(b.username));
    const subtitleText = `Authorize <strong>${escapeHtml(client.name)}</strong> to access your X account.`;

    const userButtons = users
      .map((u) =>
        renderUserButton({
          letter: (u.name[0] ?? u.username[0] ?? "?").toUpperCase(),
          login: `@${u.username}`,
          name: u.name,
          formAction: `${baseUrl}/2/oauth2/authorize/consent`,
          hiddenFields: {
            user_id: u.user_id,
            redirect_uri,
            scope,
            state,
            client_id,
            code_challenge,
            code_challenge_method,
          },
        }),
      )
      .join("\n");

    const body = users.length === 0 ? '<p class="empty">No users in the emulator store.</p>' : userButtons;
    return c.html(renderCardPage("Sign in to X", subtitleText, body, SERVICE_LABEL));
  });

  // ---------- Authorize consent (auto-approve, mints the code) ----------

  app.post("/2/oauth2/authorize/consent", async (c) => {
    const form = (await c.req.parseBody()) as Record<string, string>;
    const user_id = bodyStr(form.user_id);
    const redirect_uri = bodyStr(form.redirect_uri);
    const scope = bodyStr(form.scope);
    const state = bodyStr(form.state);
    const client_id = bodyStr(form.client_id);
    const code_challenge = bodyStr(form.code_challenge);
    const code_challenge_method = bodyStr(form.code_challenge_method);

    const user = xs.users.findOneBy("user_id", user_id);
    if (!user) {
      return c.html(renderErrorPage("User not found", "The selected user no longer exists.", SERVICE_LABEL), 400);
    }

    const code = randomBytes(24).toString("base64url");
    xs.authCodes.insert({
      code,
      client_id,
      redirect_uri,
      code_challenge,
      code_challenge_method: code_challenge_method || "S256",
      scopes: scope.split(/[\s+]+/).filter(Boolean),
      user_id,
      expires: Date.now() + AUTH_CODE_TTL_MS,
    });

    debug("x.oauth", `[authorize] minted code for user ${user_id} client ${client_id}`);

    const url = new URL(redirect_uri);
    url.searchParams.set("code", code);
    if (state) url.searchParams.set("state", state);
    return c.redirect(url.toString(), 302);
  });

  // ---------- Token endpoint (POST /2/oauth2/token) ----------

  app.post("/2/oauth2/token", async (c) => {
    const body = await parseTokenBody(c);
    const grant_type = typeof body.grant_type === "string" ? body.grant_type : "";
    const creds = parseClientCredentials(c, body);

    // client_credentials → app-only BearerToken. Confidential clients only.
    if (grant_type === "client_credentials") {
      const auth = authenticateClient(creds, body);
      if ("error" in auth) {
        return c.json({ error: auth.error, error_description: auth.description }, auth.status);
      }
      if (auth.client.client_type !== "confidential") {
        return c.json(
          {
            error: "unauthorized_client",
            error_description: "Only confidential clients may use the client_credentials grant.",
          },
          400,
        );
      }
      const token = opaqueToken();
      const expires = Date.now() + ACCESS_TOKEN_TTL_SECONDS * 1000;
      xs.accessTokens.insert({
        token,
        client_id: auth.client.client_id,
        user_id: null,
        scopes: [],
        app_only: true,
        expires,
      });
      return c.json({
        token_type: "bearer",
        access_token: token,
        expires_in: ACCESS_TOKEN_TTL_SECONDS,
      });
    }

    if (grant_type === "authorization_code") {
      const auth = authenticateClient(creds, body);
      if ("error" in auth) {
        return c.json({ error: auth.error, error_description: auth.description }, auth.status);
      }
      const client = auth.client;

      const code = typeof body.code === "string" ? body.code : "";
      const redirect_uri = typeof body.redirect_uri === "string" ? body.redirect_uri : "";
      const code_verifier = typeof body.code_verifier === "string" ? body.code_verifier : "";

      const codeRow = xs.authCodes.findOneBy("code", code);
      if (!codeRow || codeRow.expires < Date.now()) {
        if (codeRow) xs.authCodes.delete(codeRow.id);
        return c.json(
          { error: "invalid_grant", error_description: "The authorization code is invalid or expired." },
          400,
        );
      }
      if (codeRow.client_id !== client.client_id) {
        return c.json(
          { error: "invalid_grant", error_description: "The authorization code was issued to another client." },
          400,
        );
      }
      if (codeRow.redirect_uri !== redirect_uri) {
        return c.json(
          { error: "invalid_grant", error_description: "The redirect_uri does not match the authorization request." },
          400,
        );
      }
      // PKCE: base64url(sha256(code_verifier)) must equal the stored S256 challenge.
      if (!code_verifier) {
        return c.json({ error: "invalid_request", error_description: "A code_verifier is required (PKCE)." }, 400);
      }
      if (s256(code_verifier) !== codeRow.code_challenge) {
        return c.json({ error: "invalid_grant", error_description: "PKCE verification failed." }, 400);
      }

      // Single-use code.
      xs.authCodes.delete(codeRow.id);

      const scopes = codeRow.scopes;
      const token = opaqueToken();
      const expires = Date.now() + ACCESS_TOKEN_TTL_SECONDS * 1000;
      xs.accessTokens.insert({
        token,
        client_id: client.client_id,
        user_id: codeRow.user_id,
        scopes,
        app_only: false,
        expires,
      });

      const response: Record<string, unknown> = {
        token_type: "bearer",
        access_token: token,
        scope: scopes.join(" "),
        expires_in: ACCESS_TOKEN_TTL_SECONDS,
      };

      // A refresh token is only issued when offline.access was granted.
      if (scopes.includes("offline.access")) {
        const refreshToken = opaqueToken();
        xs.refreshTokens.insert({
          token: refreshToken,
          client_id: client.client_id,
          user_id: codeRow.user_id,
          scopes,
        });
        response.refresh_token = refreshToken;
      }

      debug("x.oauth", `[token] authorization_code → user ${codeRow.user_id} scopes ${scopes.join(",")}`);
      return c.json(response);
    }

    if (grant_type === "refresh_token") {
      const auth = authenticateClient(creds, body);
      if ("error" in auth) {
        return c.json({ error: auth.error, error_description: auth.description }, auth.status);
      }
      const client = auth.client;

      const refresh_token = typeof body.refresh_token === "string" ? body.refresh_token : "";
      const row = xs.refreshTokens.findOneBy("token", refresh_token);
      if (!row || row.client_id !== client.client_id) {
        return c.json({ error: "invalid_grant", error_description: "The refresh token is invalid." }, 400);
      }
      // Refresh requires that offline.access was granted on the original token.
      if (!row.scopes.includes("offline.access")) {
        return c.json(
          { error: "invalid_grant", error_description: "The refresh token does not have offline.access." },
          400,
        );
      }

      const token = opaqueToken();
      const expires = Date.now() + ACCESS_TOKEN_TTL_SECONDS * 1000;
      xs.accessTokens.insert({
        token,
        client_id: client.client_id,
        user_id: row.user_id,
        scopes: row.scopes,
        app_only: false,
        expires,
      });

      // Rotate the refresh token, as X does.
      const newRefresh = opaqueToken();
      xs.refreshTokens.update(row.id, { token: newRefresh });

      return c.json({
        token_type: "bearer",
        access_token: token,
        scope: row.scopes.join(" "),
        expires_in: ACCESS_TOKEN_TTL_SECONDS,
        refresh_token: newRefresh,
      });
    }

    return c.json(
      {
        error: "unsupported_grant_type",
        error_description: "grant_type must be authorization_code, refresh_token, or client_credentials.",
      },
      400,
    );
  });

  // ---------- Token revocation (POST /2/oauth2/revoke) ----------

  app.post("/2/oauth2/revoke", async (c) => {
    const body = await parseTokenBody(c);
    const creds = parseClientCredentials(c, body);
    const auth = authenticateClient(creds, body);
    if ("error" in auth) {
      return c.json({ error: auth.error, error_description: auth.description }, auth.status);
    }

    const token = typeof body.token === "string" ? body.token : "";
    if (token) {
      const access = xs.accessTokens.findOneBy("token", token);
      if (access && access.client_id === auth.client.client_id) {
        xs.accessTokens.delete(access.id);
      }
      const refresh = xs.refreshTokens.findOneBy("token", token);
      if (refresh && refresh.client_id === auth.client.client_id) {
        xs.refreshTokens.delete(refresh.id);
      }
    }
    // X returns { revoked: true } on success.
    return c.json({ revoked: true });
  });
}
