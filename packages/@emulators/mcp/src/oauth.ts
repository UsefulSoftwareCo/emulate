import { createHash, randomBytes, randomUUID } from "crypto";
import type { RouteContext, Store, TokenMap } from "@emulators/core";
import { bodyStr, matchesRedirectUri, renderCardPage, renderUserButton } from "@emulators/core";
import { getGitHubStore } from "@emulators/github";
import { getOAuthClients, getPendingCodes, isCodeExpired, type OAuthClientRecord } from "./oauth-store.js";

const SERVICE_LABEL = "GitHub MCP";

// A loopback/localhost redirect URI is REQUIRED for MCP clients (the OAuth flow
// runs in a local desktop/CLI agent). RFC 8252 §7.3 / the MCP spec mandate
// accepting these, so DCR must not reject them.
function isAcceptableRedirect(uri: string): boolean {
  try {
    const u = new URL(uri);
    if (u.protocol === "https:") return true;
    if (u.protocol === "http:") {
      const host = u.hostname;
      return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
    }
    // Custom/native app schemes (e.g. myapp://callback) are allowed.
    return u.protocol !== "" && u.protocol !== "http:";
  } catch {
    return false;
  }
}

function issueAccessToken(
  store: Store,
  tokenMap: TokenMap | undefined,
  login: string,
  userId: number,
  scope: string,
): string {
  const accessToken = "mcp_" + randomBytes(24).toString("base64url");
  const scopes = scope ? scope.split(/\s+/).filter(Boolean) : [];
  tokenMap?.set(accessToken, { login, id: userId, scopes });
  return accessToken;
}

type ConsentFields = Record<string, string>;

// Consent buttons for every seeded user (ghost is internal-only). Each is a form
// that POSTs back to /authorize/approve — so the same set doubles as the recovery
// UI when an unknown login was submitted.
function userButtonsHtml(store: Store, baseUrl: string, hidden: ConsentFields): string {
  const gh = getGitHubStore(store);
  return gh.users
    .all()
    .filter((u) => u.login !== "ghost")
    .map((u) =>
      renderUserButton({
        letter: (u.login[0] ?? "?").toUpperCase(),
        login: u.login,
        name: u.name ?? undefined,
        email: u.email ?? undefined,
        formAction: `${baseUrl}/authorize/approve`,
        hiddenFields: hidden,
      }),
    )
    .join("\n");
}

// Copy-pasteable instructions to seed a user into THIS instance (the only way to
// add an authorizable identity). The github seed shape lives under the `github` key.
function seedHintHtml(baseUrl: string, login: string): string {
  const who = login || "octocat";
  const cmd = `curl -X POST ${baseUrl}/__seed \\
  -H 'content-type: application/json' \\
  -d '{"github":{"users":[{"login":"${who}"}]}}'`;
  return `<p class="empty" style="text-align:left;margin-top:18px">Only <strong>seeded</strong> users can be authorized. Add one to this instance, then retry:</p>
<pre style="white-space:pre-wrap;word-break:break-all;background:#0b0e14;border:1px solid #222a35;border-radius:8px;padding:12px;font-size:12px;text-align:left;color:#d6dae0">${escapeBasic(cmd)}</pre>`;
}

export function registerOAuthRoutes(ctx: RouteContext): void {
  const { app, store, baseUrl, tokenMap } = ctx;

  // ---------- Protected-resource metadata (RFC 9728) ----------
  app.get("/.well-known/oauth-protected-resource", (c) => {
    return c.json({
      resource: baseUrl,
      authorization_servers: [baseUrl],
      bearer_methods_supported: ["header"],
      scopes_supported: ["repo", "read:user"],
    });
  });

  // Some clients append the resource path to the well-known probe.
  app.get("/.well-known/oauth-protected-resource/mcp", (c) => {
    return c.json({
      resource: `${baseUrl}/mcp`,
      authorization_servers: [baseUrl],
      bearer_methods_supported: ["header"],
      scopes_supported: ["repo", "read:user"],
    });
  });

  // ---------- Authorization-server metadata (RFC 8414) ----------
  const asMetadata = () => ({
    issuer: baseUrl,
    authorization_endpoint: `${baseUrl}/authorize`,
    token_endpoint: `${baseUrl}/token`,
    registration_endpoint: `${baseUrl}/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
    scopes_supported: ["repo", "read:user"],
  });
  app.get("/.well-known/oauth-authorization-server", (c) => c.json(asMetadata()));
  // OpenID-style probe some MCP clients also try.
  app.get("/.well-known/oauth-authorization-server/mcp", (c) => c.json(asMetadata()));

  // ---------- Dynamic Client Registration (RFC 7591) ----------
  app.post("/register", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const redirectUris = Array.isArray(body.redirect_uris)
      ? body.redirect_uris.filter((u): u is string => typeof u === "string")
      : [];

    if (redirectUris.length === 0) {
      return c.json({ error: "invalid_redirect_uri", error_description: "redirect_uris is required." }, 400);
    }
    for (const uri of redirectUris) {
      if (!isAcceptableRedirect(uri)) {
        return c.json({ error: "invalid_redirect_uri", error_description: `Unacceptable redirect_uri: ${uri}` }, 400);
      }
    }

    const authMethod = typeof body.token_endpoint_auth_method === "string" ? body.token_endpoint_auth_method : "none";

    const clientId = "mcp-client-" + randomUUID();
    const record: OAuthClientRecord = {
      client_id: clientId,
      redirect_uris: redirectUris,
      client_name: typeof body.client_name === "string" ? body.client_name : undefined,
      token_endpoint_auth_method: authMethod,
      created_at: Date.now(),
    };
    // Issue a secret only for confidential clients (client_secret_post). Public
    // clients (auth_method "none", the typical MCP loopback case) get none + use PKCE.
    if (authMethod === "client_secret_post" || authMethod === "client_secret_basic") {
      record.client_secret = randomBytes(24).toString("base64url");
    }
    getOAuthClients(store).set(clientId, record);

    return c.json(
      {
        client_id: record.client_id,
        ...(record.client_secret ? { client_secret: record.client_secret } : {}),
        client_id_issued_at: Math.floor(record.created_at / 1000),
        redirect_uris: record.redirect_uris,
        grant_types: ["authorization_code"],
        response_types: ["code"],
        token_endpoint_auth_method: record.token_endpoint_auth_method,
        ...(record.client_name ? { client_name: record.client_name } : {}),
      },
      201,
    );
  });

  // ---------- Authorization endpoint ----------
  app.get("/authorize", (c) => {
    const clientId = c.req.query("client_id") ?? "";
    const redirectUri = c.req.query("redirect_uri") ?? "";
    const state = c.req.query("state") ?? "";
    const scope = c.req.query("scope") ?? "";
    const codeChallenge = c.req.query("code_challenge") ?? "";
    const codeChallengeMethod = c.req.query("code_challenge_method") ?? "";
    const resource = c.req.query("resource") ?? "";

    const client = getOAuthClients(store).get(clientId);
    if (!client) {
      return c.json({ error: "invalid_client", error_description: "Unknown client_id." }, 400);
    }
    if (!redirectUri || !matchesRedirectUri(redirectUri, client.redirect_uris)) {
      return c.json({ error: "invalid_request", error_description: "redirect_uri mismatch." }, 400);
    }
    if (codeChallenge && codeChallengeMethod && codeChallengeMethod.toLowerCase() !== "s256") {
      return c.json({ error: "invalid_request", error_description: "Only S256 PKCE is supported." }, 400);
    }

    const gh = getGitHubStore(store);
    const users = gh.users.all().filter((u) => u.login !== "ghost");
    const clientName = client.client_name ? client.client_name : "an MCP client";

    const userButtons = users
      .map((user) =>
        renderUserButton({
          letter: (user.login[0] ?? "?").toUpperCase(),
          login: user.login,
          name: user.name ?? undefined,
          email: user.email ?? undefined,
          // Absolute (baseUrl-prefixed) so the POST keeps the instance path prefix
          // when served under CF's /mcp/<id>.
          formAction: `${baseUrl}/authorize/approve`,
          hiddenFields: {
            client_id: clientId,
            redirect_uri: redirectUri,
            state,
            scope,
            code_challenge: codeChallenge,
            code_challenge_method: codeChallengeMethod,
            resource,
          },
        }),
      )
      .join("\n");

    const footer = `<p class="empty" style="margin-top:18px;font-size:12px">Don't see the user you want? Seed it: <code>POST ${baseUrl}/__seed</code> with <code>{"github":{"users":[{"login":"…"}]}}</code>.</p>`;
    const body =
      users.length === 0
        ? `<p class="empty">No users seeded in this instance yet.</p>${seedHintHtml(baseUrl, "")}`
        : userButtons + footer;
    const subtitle = `Authorize <strong>${escapeBasic(clientName)}</strong> to access GitHub as a seeded user.`;
    return c.html(renderCardPage("Authorize MCP client", subtitle, body, SERVICE_LABEL));
  });

  // ---------- Authorization approval (issues the code, redirects back) ----------
  app.post("/authorize/approve", async (c) => {
    const body = await c.req.parseBody();
    const clientId = bodyStr(body.client_id);
    const redirectUri = bodyStr(body.redirect_uri);
    const state = bodyStr(body.state);
    const scope = bodyStr(body.scope);
    const codeChallenge = bodyStr(body.code_challenge);
    const codeChallengeMethod = bodyStr(body.code_challenge_method);
    const resource = bodyStr(body.resource);
    const login = bodyStr(body.login);

    const client = getOAuthClients(store).get(clientId);
    if (!client || !matchesRedirectUri(redirectUri, client.redirect_uris)) {
      return c.json({ error: "invalid_request", error_description: "Invalid client or redirect_uri." }, 400);
    }

    const gh = getGitHubStore(store);
    const user = gh.users.findOneBy("login", login);
    if (!user) {
      // Recoverable dead-end: show how to get to a good state instead of a bare
      // error — list the users you CAN authorize as (clickable, completes the
      // flow) plus how to seed the one that was requested.
      const hidden: ConsentFields = {
        client_id: clientId,
        redirect_uri: redirectUri,
        state,
        scope,
        code_challenge: codeChallenge,
        code_challenge_method: codeChallengeMethod,
        resource,
      };
      const buttons = userButtonsHtml(store, baseUrl, hidden);
      const subtitle = `<strong>${escapeBasic(login || "(no login)")}</strong> isn't a seeded user in this instance.`;
      const pick = buttons
        ? `<p class="empty" style="margin-bottom:8px">Authorize as an available user instead:</p>${buttons}`
        : "";
      return c.html(
        renderCardPage("User not found", subtitle, pick + seedHintHtml(baseUrl, login), SERVICE_LABEL),
        400,
      );
    }

    const code = randomBytes(24).toString("hex");
    getPendingCodes(store).set(code, {
      client_id: clientId,
      redirect_uri: redirectUri,
      code_challenge: codeChallenge || null,
      code_challenge_method: codeChallengeMethod || null,
      resource: resource || null,
      scope,
      login: user.login,
      userId: user.id,
      created_at: Date.now(),
    });

    const url = new URL(redirectUri);
    url.searchParams.set("code", code);
    if (state) url.searchParams.set("state", state);
    return c.redirect(url.toString(), 302);
  });

  // ---------- Token endpoint ----------
  app.post("/token", async (c) => {
    const contentType = c.req.header("Content-Type") ?? "";
    const raw = await c.req.text();
    let form: Record<string, string>;
    if (contentType.includes("application/json")) {
      try {
        form = JSON.parse(raw) as Record<string, string>;
      } catch {
        form = {};
      }
    } else {
      form = Object.fromEntries(new URLSearchParams(raw));
    }

    const grantType = form.grant_type ?? "";
    if (grantType !== "authorization_code") {
      return c.json(
        { error: "unsupported_grant_type", error_description: "Only authorization_code is supported." },
        400,
      );
    }

    const code = form.code ?? "";
    const redirectUri = form.redirect_uri ?? "";
    const clientId = form.client_id ?? "";
    const clientSecret = form.client_secret ?? "";
    const codeVerifier = form.code_verifier;

    const client = getOAuthClients(store).get(clientId);
    if (!client) {
      return c.json({ error: "invalid_client", error_description: "Unknown client_id." }, 401);
    }
    // Confidential clients must present their secret.
    if (client.client_secret) {
      if (!constantTimeEqual(clientSecret, client.client_secret)) {
        return c.json({ error: "invalid_client", error_description: "Bad client_secret." }, 401);
      }
    }

    const codes = getPendingCodes(store);
    const pending = codes.get(code);
    if (!pending) {
      return c.json({ error: "invalid_grant", error_description: "Unknown or used code." }, 400);
    }
    if (isCodeExpired(pending)) {
      codes.delete(code);
      return c.json({ error: "invalid_grant", error_description: "Code expired." }, 400);
    }
    if (pending.client_id !== clientId) {
      return c.json({ error: "invalid_grant", error_description: "Code was issued to a different client." }, 400);
    }
    if (pending.redirect_uri !== redirectUri) {
      return c.json({ error: "invalid_grant", error_description: "redirect_uri mismatch." }, 400);
    }

    // PKCE (S256) verification.
    if (pending.code_challenge) {
      if (!codeVerifier) {
        return c.json({ error: "invalid_grant", error_description: "Missing code_verifier." }, 400);
      }
      const expected = createHash("sha256").update(codeVerifier).digest("base64url");
      if (expected !== pending.code_challenge) {
        return c.json({ error: "invalid_grant", error_description: "PKCE verification failed." }, 400);
      }
    }

    codes.delete(code);

    const accessToken = issueAccessToken(store, tokenMap, pending.login, pending.userId, pending.scope);
    return c.json({
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: 3600,
      scope: pending.scope || "repo read:user",
      ...(pending.resource ? { resource: pending.resource } : {}),
    });
  });
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function escapeBasic(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
