import { renderCardPage, renderUserButton, escapeHtml, type RouteContext } from "@emulators/core";

import { getWorkosStore } from "../store.js";
import { ensureUserByEmail } from "./user-management.js";
import { jwksResponse, signAccessToken, signIdentityAssertion, verifyAccessToken } from "../keys.js";
import { randomToken, workosError, workosId } from "../helpers.js";

const TOKEN_EXCHANGE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:token-exchange";
const ID_JAG_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:id-jag";
const ID_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:id_token";
const ACCESS_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:access_token";
const REFRESH_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:refresh_token";

/**
 * The AuthKit-domain surface (what MCP_AUTHKIT_DOMAIN points at): JWKS, OAuth
 * authorization-server metadata, dynamic client registration, authorize, and
 * token — enough for an MCP client (mcporter, Claude, …) to complete OAuth
 * against the emulator, and for resource servers to verify the minted JWTs.
 * The SDK's sealed-session verify reads /sso/jwks/:clientId — same keypair.
 */
export function oauthRoutes(ctx: RouteContext): void {
  const { app, store, baseUrl } = ctx;
  const ws = () => getWorkosStore(store);

  app.get("/sso/jwks/:clientId", async (c) => c.json(await jwksResponse()));
  app.get("/oauth2/jwks", async (c) => c.json(await jwksResponse()));

  app.get("/.well-known/oauth-authorization-server", (c) =>
    c.json({
      issuer: baseUrl,
      authorization_endpoint: `${baseUrl}/oauth2/authorize`,
      token_endpoint: `${baseUrl}/oauth2/token`,
      registration_endpoint: `${baseUrl}/oauth2/register`,
      jwks_uri: `${baseUrl}/oauth2/jwks`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token", TOKEN_EXCHANGE_GRANT_TYPE],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["client_secret_post", "none"],
    }),
  );

  app.post("/oauth2/register", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const client = ws().oauthClients.insert({
      client_id: workosId("client"),
      client_secret: null,
      redirect_uris: Array.isArray(body.redirect_uris) ? (body.redirect_uris as string[]) : [],
      name: typeof body.client_name === "string" ? body.client_name : null,
      access_token_ttl_seconds:
        typeof body.access_token_ttl_seconds === "number" && body.access_token_ttl_seconds > 0
          ? Math.floor(body.access_token_ttl_seconds)
          : null,
    });
    return c.json(
      {
        client_id: client.client_id,
        client_id_issued_at: Math.floor(Date.now() / 1000),
        redirect_uris: client.redirect_uris,
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      },
      201,
    );
  });

  app.get("/oauth2/authorize", (c) => {
    const clientId = c.req.query("client_id") ?? "";
    const redirectUri = c.req.query("redirect_uri") ?? "";
    const state = c.req.query("state") ?? "";
    const codeChallenge = c.req.query("code_challenge") ?? "";
    const scope = c.req.query("scope") ?? "";
    const loginHint = c.req.query("login_hint");
    if (!redirectUri) return workosError(c, 422, "invalid_request", "redirect_uri is required");

    const issue = (email: string) => {
      const user = ensureUserByEmail(ws(), email);
      const activeMembership = ws()
        .memberships.findBy("user_id", user.workos_id)
        .find((m) => m.status === "active");
      const code = randomToken("mcpcode");
      ws().oauthCodes.insert({
        code,
        user_id: user.workos_id,
        organization_id: activeMembership?.organization_id ?? null,
        client_id: clientId,
        redirect_uri: redirectUri,
        code_challenge: codeChallenge || null,
        scope: scope || null,
        used: false,
      });
      const target = new URL(redirectUri);
      target.searchParams.set("code", code);
      if (state) target.searchParams.set("state", state);
      return c.redirect(target.toString(), 302);
    };

    if (loginHint) return issue(loginHint);

    const users = ws().users.all();
    const buttons = users
      .map((user) =>
        renderUserButton({
          letter: (user.email[0] ?? "?").toUpperCase(),
          login: user.email,
          name: `${user.first_name ?? ""} ${user.last_name ?? ""}`.trim() || user.email,
          email: user.email,
          formAction: `${baseUrl}/oauth2/authorize/submit`,
          hiddenFields: {
            email: user.email,
            client_id: clientId,
            redirect_uri: redirectUri,
            state,
            code_challenge: codeChallenge,
            scope,
          },
        }),
      )
      .join("\n");
    const newUserForm = `
      <form method="post" action="${baseUrl}/oauth2/authorize/submit" class="new-user">
        <input type="hidden" name="client_id" value="${escapeHtml(clientId)}" />
        <input type="hidden" name="redirect_uri" value="${escapeHtml(redirectUri)}" />
        <input type="hidden" name="state" value="${escapeHtml(state)}" />
        <input type="hidden" name="code_challenge" value="${escapeHtml(codeChallenge)}" />
        <input type="hidden" name="scope" value="${escapeHtml(scope)}" />
        <input type="email" name="email" class="checkout-input" placeholder="new-user@example.com" required />
        <button type="submit" class="checkout-pay-btn">Continue as new user</button>
      </form>`;
    return c.html(
      renderCardPage("Authorize MCP client", "Sign in to connect this MCP client.", `${buttons}${newUserForm}`),
      200,
    );
  });

  app.post("/oauth2/authorize/submit", async (c) => {
    const form = await c.req.parseBody();
    const email = String(form.email ?? "");
    const redirectUri = String(form.redirect_uri ?? "");
    if (!email || !redirectUri) {
      return workosError(c, 422, "invalid_request", "email and redirect_uri are required");
    }
    const user = ensureUserByEmail(ws(), email);
    const activeMembership = ws()
      .memberships.findBy("user_id", user.workos_id)
      .find((m) => m.status === "active");
    const code = randomToken("mcpcode");
    ws().oauthCodes.insert({
      code,
      user_id: user.workos_id,
      organization_id: activeMembership?.organization_id ?? null,
      client_id: String(form.client_id ?? ""),
      redirect_uri: redirectUri,
      code_challenge: String(form.code_challenge ?? "") || null,
      scope: String(form.scope ?? "") || null,
      used: false,
    });
    const target = new URL(redirectUri);
    target.searchParams.set("code", code);
    const state = String(form.state ?? "");
    if (state) target.searchParams.set("state", state);
    return c.redirect(target.toString(), 302);
  });

  app.post("/oauth2/token", async (c) => {
    const contentType = c.req.header("content-type") ?? "";
    const body = contentType.includes("json")
      ? ((await c.req.json().catch(() => ({}))) as Record<string, unknown>)
      : ((await c.req.parseBody()) as Record<string, unknown>);
    const grantType = String(body.grant_type ?? "");

    // TTL precedence: per-client DCR extension, then the seeded default
    // (real clients register plain DCR and can't carry the extension), then
    // the AuthKit-like 3600.
    const ttlFor = (clientId: string): number =>
      ws().oauthClients.findOneBy("client_id", clientId)?.access_token_ttl_seconds ??
      ws().oauthSettings.all()[0]?.default_access_token_ttl_seconds ??
      3600;

    if (grantType === TOKEN_EXCHANGE_GRANT_TYPE) {
      c.set("operationId", "workos.oauth.tokenExchange");
      const requestedTokenType = String(body.requested_token_type ?? "");
      if (requestedTokenType !== ID_JAG_TOKEN_TYPE) {
        return workosError(c, 400, "invalid_request", "requested_token_type must be id-jag.");
      }
      const audience = String(body.audience ?? "");
      if (!audience) return workosError(c, 400, "invalid_request", "audience is required.");

      const subjectToken = String(body.subject_token ?? "");
      const subjectTokenType = String(body.subject_token_type ?? "");
      if (!subjectToken) return workosError(c, 400, "invalid_request", "subject_token is required.");
      if (![ID_TOKEN_TYPE, ACCESS_TOKEN_TYPE, REFRESH_TOKEN_TYPE].includes(subjectTokenType)) {
        return workosError(c, 400, "invalid_request", "Unsupported subject_token_type.");
      }

      const subject =
        subjectTokenType === REFRESH_TOKEN_TYPE
          ? subjectFromRefreshToken(ws(), subjectToken)
          : await subjectFromSignedToken(baseUrl, subjectToken).catch(() => null);
      if (!subject) return workosError(c, 400, "invalid_grant", "Subject token is invalid.");

      const user = ws().users.findOneBy("workos_id", subject.user_id);
      if (!user) return workosError(c, 400, "invalid_grant", "Unknown user for subject token.");

      const scope = String(body.scope ?? "").trim();
      const resource = String(body.resource ?? "").trim();
      const clientId = String(body.client_id ?? "").trim();
      const idJag = await signIdentityAssertion(
        {
          sub: user.workos_id,
          email: user.email,
          preferred_username: usernameFromEmail(user.email),
          ...(subject.organization_id ? { org_id: subject.organization_id } : {}),
          ...(resource ? { resource } : {}),
          ...(clientId ? { client_id: clientId } : {}),
          ...(scope ? { scope } : {}),
        },
        { issuer: baseUrl, audience, expiresIn: "5m" },
      );
      c.header("Cache-Control", "no-store");
      c.header("Pragma", "no-cache");
      return c.json({
        issued_token_type: ID_JAG_TOKEN_TYPE,
        access_token: idJag,
        token_type: "N_A",
        expires_in: 300,
        ...(scope ? { scope } : {}),
      });
    }

    if (grantType === "refresh_token") {
      const refreshToken = String(body.refresh_token ?? "");
      const session = ws().sessions.findOneBy("refresh_token", refreshToken);
      if (!session || session.revoked) {
        return workosError(c, 400, "invalid_grant", "Refresh token is invalid.");
      }
      // AuthKit refresh tokens are single use: rotate on every redemption.
      ws().sessions.update(session.id, { revoked: true });
      const rotated = ws().sessions.insert({
        workos_id: workosId("session"),
        refresh_token: randomToken("rt"),
        user_id: session.user_id,
        organization_id: session.organization_id,
        client_id: session.client_id,
        revoked: false,
        scope: session.scope,
      });
      const audience = process.env.EMULATE_WORKOS_AUDIENCE ?? session.client_id;
      const expiresIn = ttlFor(session.client_id);
      const accessToken = await signAccessToken(
        {
          sub: session.user_id,
          sid: rotated.workos_id,
          ...(session.organization_id ? { org_id: session.organization_id } : {}),
          permissions: [],
        },
        { issuer: baseUrl, audience, expiresIn: `${expiresIn}s` },
      );
      return c.json({
        access_token: accessToken,
        token_type: "Bearer",
        expires_in: expiresIn,
        refresh_token: rotated.refresh_token,
        ...(session.scope ? { scope: session.scope } : {}),
      });
    }

    if (grantType !== "authorization_code") {
      return workosError(c, 400, "unsupported_grant_type", `Unsupported grant_type: ${grantType}`);
    }
    const code = String(body.code ?? "");
    const oauthCode = ws().oauthCodes.findOneBy("code", code);
    if (!oauthCode || oauthCode.used) {
      return workosError(c, 400, "invalid_grant", "The code is invalid or has been used.");
    }
    ws().oauthCodes.update(oauthCode.id, { used: true });
    // Resource servers verify audience against THEIR WorkOS client id, not the
    // DCR client's — mirror AuthKit: EMULATE_WORKOS_AUDIENCE (the app's client
    // id) when set, else the requesting client.
    const audience = process.env.EMULATE_WORKOS_AUDIENCE ?? oauthCode.client_id;
    // AuthKit grants exactly the scopes the client requested (no defaulting)
    // and issues a refresh token ONLY when offline_access is among them. A
    // client that requests no scopes gets granted_scopes: [] and a session it
    // can never refresh.
    const grantedScopes = (oauthCode.scope ?? "").split(" ").filter(Boolean);
    const offline = grantedScopes.includes("offline_access");
    const session = offline
      ? ws().sessions.insert({
          workos_id: workosId("session"),
          refresh_token: randomToken("rt"),
          user_id: oauthCode.user_id,
          organization_id: oauthCode.organization_id,
          client_id: oauthCode.client_id,
          revoked: false,
          scope: oauthCode.scope,
        })
      : null;
    const expiresIn = ttlFor(oauthCode.client_id);
    const accessToken = await signAccessToken(
      {
        sub: oauthCode.user_id,
        sid: session?.workos_id ?? workosId("session"),
        ...(oauthCode.organization_id ? { org_id: oauthCode.organization_id } : {}),
        permissions: [],
      },
      { issuer: baseUrl, audience, expiresIn: `${expiresIn}s` },
    );
    return c.json({
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: expiresIn,
      ...(session ? { refresh_token: session.refresh_token } : {}),
      ...(grantedScopes.length > 0 ? { scope: grantedScopes.join(" ") } : {}),
    });
  });
}

function usernameFromEmail(email: string): string {
  const [local] = email.split("@");
  return local || email;
}

function subjectFromRefreshToken(
  ws: ReturnType<typeof getWorkosStore>,
  token: string,
): { user_id: string; organization_id: string | null } | null {
  const session = ws.sessions.findOneBy("refresh_token", token);
  if (!session || session.revoked) return null;
  return { user_id: session.user_id, organization_id: session.organization_id };
}

async function subjectFromSignedToken(
  issuer: string,
  token: string,
): Promise<{ user_id: string; organization_id: string | null }> {
  const { payload } = await verifyAccessToken(token, { issuer });
  return { user_id: payload.sub, organization_id: typeof payload.org_id === "string" ? payload.org_id : null };
}
