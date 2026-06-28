import type { Context } from "@emulators/core";
import { renderCardPage, renderUserButton, escapeHtml, type RouteContext } from "@emulators/core";

import { getWorkosStore, type WorkosStore } from "../store.js";
import type { WorkosUser } from "../entities.js";
import { signAccessToken } from "../keys.js";
import {
  listEnvelope,
  parseStatuses,
  randomToken,
  serializeApiKey,
  serializeInvitation,
  serializeMembership,
  serializeUser,
  workosError,
  workosId,
} from "../helpers.js";

/** Resolve a user by email, creating one when asked (the e2e fresh-identity path). */
export function ensureUserByEmail(ws: WorkosStore, email: string): WorkosUser {
  const existing = ws.users.findOneBy("email", email);
  if (existing) return existing;
  return ws.users.insert({
    workos_id: workosId("user"),
    email,
    first_name: "Test",
    last_name: "User",
    email_verified: true,
    profile_picture_url: null,
  });
}

async function authenticationResponse(
  c: Context,
  ws: WorkosStore,
  baseUrl: string,
  user: WorkosUser,
  organizationId: string | null,
  clientId: string,
): Promise<Response> {
  const session = ws.sessions.insert({
    workos_id: workosId("session"),
    refresh_token: randomToken("rt"),
    user_id: user.workos_id,
    organization_id: organizationId,
    client_id: clientId,
    revoked: false,
    scope: null,
  });
  const membership = organizationId
    ? ws.memberships.findBy("user_id", user.workos_id).find((m) => m.organization_id === organizationId)
    : undefined;
  const accessToken = await signAccessToken(
    {
      sub: user.workos_id,
      sid: session.workos_id,
      ...(organizationId ? { org_id: organizationId } : {}),
      ...(membership ? { role: membership.role_slug } : {}),
      permissions: [],
    },
    { issuer: baseUrl, audience: clientId },
  );
  return c.json({
    user: serializeUser(user),
    organization_id: organizationId,
    access_token: accessToken,
    refresh_token: session.refresh_token,
    authentication_method: "SSO",
  });
}

export function userManagementRoutes(ctx: RouteContext): void {
  const { app, store, baseUrl } = ctx;
  const ws = () => getWorkosStore(store);

  // --- Hosted AuthKit login (the SDK's getAuthorizationUrl points here) ----
  app.get("/user_management/authorize", (c) => {
    const clientId = c.req.query("client_id") ?? "";
    const redirectUri = c.req.query("redirect_uri") ?? "";
    const state = c.req.query("state") ?? "";
    // Headless path: ?login_hint=email signs that user straight in (creating
    // them if new) — what e2e identity minting uses. No hint → hosted page.
    const loginHint = c.req.query("login_hint");
    if (loginHint) {
      return issueCodeRedirect(c, ws(), loginHint, clientId, redirectUri, state);
    }
    const users = ws().users.all();
    const buttons = users
      .map((user) =>
        renderUserButton({
          letter: (user.email[0] ?? "?").toUpperCase(),
          login: user.email,
          name: `${user.first_name ?? ""} ${user.last_name ?? ""}`.trim() || user.email,
          email: user.email,
          formAction: `${baseUrl}/user_management/authorize/submit`,
          hiddenFields: { email: user.email, client_id: clientId, redirect_uri: redirectUri, state },
        }),
      )
      .join("\n");
    const newUserForm = `
      <form method="post" action="${baseUrl}/user_management/authorize/submit" class="new-user">
        <input type="hidden" name="client_id" value="${escapeHtml(clientId)}" />
        <input type="hidden" name="redirect_uri" value="${escapeHtml(redirectUri)}" />
        <input type="hidden" name="state" value="${escapeHtml(state)}" />
        <input type="email" name="email" class="checkout-input" placeholder="new-user@example.com" required />
        <button type="submit" class="checkout-pay-btn">Continue as new user</button>
      </form>`;
    return c.html(
      renderCardPage(
        "Sign in with AuthKit",
        "Pick an existing emulator user or continue as a new one.",
        `${buttons}${newUserForm}`,
      ),
      200,
    );
  });

  app.post("/user_management/authorize/submit", async (c) => {
    const form = await c.req.parseBody();
    const email = String(form.email ?? "");
    if (!email) return workosError(c, 422, "invalid_request", "email is required");
    return issueCodeRedirect(
      c,
      ws(),
      email,
      String(form.client_id ?? ""),
      String(form.redirect_uri ?? ""),
      String(form.state ?? ""),
    );
  });

  function issueCodeRedirect(
    c: Context,
    storeRef: WorkosStore,
    email: string,
    clientId: string,
    redirectUri: string,
    state: string,
  ): Response {
    if (!redirectUri) return workosError(c, 422, "invalid_request", "redirect_uri is required");
    const user = ensureUserByEmail(storeRef, email);
    const code = randomToken("code");
    const activeMembership = storeRef.memberships.findBy("user_id", user.workos_id).find((m) => m.status === "active");
    storeRef.authCodes.insert({
      code,
      user_id: user.workos_id,
      organization_id: activeMembership?.organization_id ?? null,
      client_id: clientId,
      redirect_uri: redirectUri,
      used: false,
    });
    const target = new URL(redirectUri);
    target.searchParams.set("code", code);
    if (state) target.searchParams.set("state", state);
    return c.redirect(target.toString(), 302);
  }

  // --- Token endpoint: authorization_code + refresh_token grants -----------
  app.post("/user_management/authenticate", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const grantType = String(body.grant_type ?? "");
    const clientId = String(body.client_id ?? "");

    if (grantType === "authorization_code") {
      const code = String(body.code ?? "");
      const authCode = ws().authCodes.findOneBy("code", code);
      if (!authCode || authCode.used) {
        return workosError(c, 400, "invalid_grant", "The code is invalid or has been used.");
      }
      ws().authCodes.update(authCode.id, { used: true });
      const user = ws().users.findOneBy("workos_id", authCode.user_id);
      if (!user) return workosError(c, 400, "invalid_grant", "Unknown user for code.");
      return authenticationResponse(c, ws(), baseUrl, user, authCode.organization_id, clientId);
    }

    if (grantType === "refresh_token") {
      const refreshToken = String(body.refresh_token ?? "");
      const session = ws().sessions.findOneBy("refresh_token", refreshToken);
      if (!session || session.revoked) {
        return workosError(c, 400, "invalid_grant", "Refresh token is invalid.");
      }
      const user = ws().users.findOneBy("workos_id", session.user_id);
      if (!user) return workosError(c, 400, "invalid_grant", "Unknown user for session.");
      const requestedOrg =
        typeof body.organization_id === "string" && body.organization_id.length > 0
          ? body.organization_id
          : session.organization_id;
      if (requestedOrg) {
        const membership = ws()
          .memberships.findBy("user_id", user.workos_id)
          .find((m) => m.organization_id === requestedOrg && m.status === "active");
        if (!membership) {
          return workosError(
            c,
            403,
            "sso_required",
            "User does not have an active membership in the requested organization.",
          );
        }
        const organization = ws().organizations.findOneBy("workos_id", requestedOrg);
        if (!organization) return workosError(c, 404, "not_found", "Organization not found.");
      }
      ws().sessions.update(session.id, { revoked: true });
      return authenticationResponse(c, ws(), baseUrl, user, requestedOrg ?? null, clientId);
    }

    return workosError(c, 400, "unsupported_grant_type", `Unsupported grant_type: ${grantType}`);
  });

  // --- Users ----------------------------------------------------------------
  app.get("/user_management/users/:id", (c) => {
    const user = ws().users.findOneBy("workos_id", c.req.param("id"));
    if (!user) return workosError(c, 404, "entity_not_found", "User not found.");
    return c.json(serializeUser(user));
  });

  // --- Organization memberships ----------------------------------------------
  app.get("/user_management/organization_memberships", (c) => {
    const userId = c.req.query("user_id");
    const organizationId = c.req.query("organization_id");
    const statuses = parseStatuses(c);
    let memberships = ws().memberships.all();
    if (userId) memberships = memberships.filter((m) => m.user_id === userId);
    if (organizationId) {
      memberships = memberships.filter((m) => m.organization_id === organizationId);
    }
    if (statuses.length > 0) memberships = memberships.filter((m) => statuses.includes(m.status));
    return c.json(
      listEnvelope(
        memberships.map((m) =>
          serializeMembership(
            m,
            ws().organizations.findOneBy("workos_id", m.organization_id)?.name ?? m.organization_id,
          ),
        ),
      ),
    );
  });

  app.post("/user_management/organization_memberships", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const userId = String(body.user_id ?? "");
    const organizationId = String(body.organization_id ?? "");
    const user = ws().users.findOneBy("workos_id", userId);
    const organization = ws().organizations.findOneBy("workos_id", organizationId);
    if (!user) return workosError(c, 404, "entity_not_found", "User not found.");
    if (!organization) return workosError(c, 404, "entity_not_found", "Organization not found.");
    const existing = ws()
      .memberships.findBy("user_id", userId)
      .find((m) => m.organization_id === organizationId);
    if (existing) {
      return workosError(c, 409, "organization_membership_already_exists", "Already a member.");
    }
    const membership = ws().memberships.insert({
      workos_id: workosId("om"),
      user_id: userId,
      organization_id: organizationId,
      status: "active",
      role_slug: typeof body.role_slug === "string" && body.role_slug ? body.role_slug : "member",
    });
    return c.json(serializeMembership(membership, organization.name), 201);
  });

  app.get("/user_management/organization_memberships/:id", (c) => {
    const membership = ws().memberships.findOneBy("workos_id", c.req.param("id"));
    if (!membership) return workosError(c, 404, "entity_not_found", "Membership not found.");
    const organizationName =
      ws().organizations.findOneBy("workos_id", membership.organization_id)?.name ?? membership.organization_id;
    return c.json(serializeMembership(membership, organizationName));
  });

  app.put("/user_management/organization_memberships/:id", async (c) => {
    const membership = ws().memberships.findOneBy("workos_id", c.req.param("id"));
    if (!membership) return workosError(c, 404, "entity_not_found", "Membership not found.");
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const updated = ws().memberships.update(membership.id, {
      role_slug: typeof body.role_slug === "string" && body.role_slug ? body.role_slug : membership.role_slug,
    })!;
    const organizationName =
      ws().organizations.findOneBy("workos_id", updated.organization_id)?.name ?? updated.organization_id;
    return c.json(serializeMembership(updated, organizationName));
  });

  app.delete("/user_management/organization_memberships/:id", (c) => {
    const membership = ws().memberships.findOneBy("workos_id", c.req.param("id"));
    if (!membership) return workosError(c, 404, "entity_not_found", "Membership not found.");
    ws().memberships.delete(membership.id);
    return c.body(null, 204);
  });

  // --- Invitations ------------------------------------------------------------
  app.get("/user_management/invitations", (c) => {
    const email = c.req.query("email");
    const organizationId = c.req.query("organization_id");
    let invitations = ws().invitations.all();
    if (email) invitations = invitations.filter((i) => i.email === email);
    if (organizationId) {
      invitations = invitations.filter((i) => i.organization_id === organizationId);
    }
    return c.json(listEnvelope(invitations.map(serializeInvitation)));
  });

  app.post("/user_management/invitations", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const email = String(body.email ?? "");
    const organizationId = String(body.organization_id ?? "");
    if (!email) return workosError(c, 422, "invalid_request", "email is required");
    if (!ws().organizations.findOneBy("workos_id", organizationId)) {
      return workosError(c, 404, "entity_not_found", "Organization not found.");
    }
    const roleSlug = typeof body.role_slug === "string" ? body.role_slug : null;
    const invitation = ws().invitations.insert({
      workos_id: workosId("invitation"),
      email,
      organization_id: organizationId,
      inviter_user_id: typeof body.inviter_user_id === "string" ? body.inviter_user_id : null,
      role_slug: roleSlug,
      state: "pending",
      token: randomToken("invite"),
      expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
    });
    // Real WorkOS also creates a PENDING organization membership for the invited
    // user (creating the user record when one does not exist yet), so
    // listOrganizationMemberships with status "pending" returns invited but not
    // yet joined people. Mirror that here so consumers can list invited members
    // and count seats accurately.
    const invitedUser = ensureUserByEmail(ws(), email);
    const existingMembership = ws()
      .memberships.findBy("user_id", invitedUser.workos_id)
      .find((m) => m.organization_id === organizationId);
    if (!existingMembership) {
      ws().memberships.insert({
        workos_id: workosId("om"),
        user_id: invitedUser.workos_id,
        organization_id: organizationId,
        status: "pending",
        role_slug: roleSlug ?? "member",
      });
    }
    return c.json(serializeInvitation(invitation), 201);
  });

  app.post("/user_management/invitations/:id/accept", (c) => {
    const invitation = ws().invitations.findOneBy("workos_id", c.req.param("id"));
    if (!invitation) return workosError(c, 404, "entity_not_found", "Invitation not found.");
    if (invitation.state !== "pending") {
      return workosError(c, 400, "invalid_request", "Invitation is not pending.");
    }
    const updated = ws().invitations.update(invitation.id, { state: "accepted" })!;
    const user = ws().users.findOneBy("email", invitation.email);
    if (user) {
      const already = ws()
        .memberships.findBy("user_id", user.workos_id)
        .find((m) => m.organization_id === invitation.organization_id);
      if (already) {
        // The invite created a pending membership; accepting activates it.
        if (already.status !== "active") {
          ws().memberships.update(already.id, { status: "active" });
        }
      } else {
        ws().memberships.insert({
          workos_id: workosId("om"),
          user_id: user.workos_id,
          organization_id: invitation.organization_id,
          status: "active",
          role_slug: invitation.role_slug ?? "member",
        });
      }
    }
    return c.json(serializeInvitation(updated));
  });

  // --- User API keys (the app calls these via raw workos.get/post) ------------
  app.get("/user_management/users/:id/api_keys", (c) => {
    const userId = c.req.param("id");
    const organizationId = c.req.query("organization_id");
    let keys = ws().apiKeys.findBy("user_id", userId);
    if (organizationId) keys = keys.filter((k) => k.organization_id === organizationId);
    return c.json(listEnvelope(keys.map((k) => serializeApiKey(k))));
  });

  app.post("/user_management/users/:id/api_keys", async (c) => {
    const userId = c.req.param("id");
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const user = ws().users.findOneBy("workos_id", userId);
    if (!user) return workosError(c, 404, "entity_not_found", "User not found.");
    const key = ws().apiKeys.insert({
      workos_id: workosId("key"),
      name: String(body.name ?? "api key"),
      value: randomToken("sk_emulate"),
      user_id: userId,
      organization_id: String(body.organization_id ?? ""),
      last_used_at: null,
    });
    return c.json(serializeApiKey(key, { includeValue: true }), 201);
  });
}
