import type { Context, RouteContext } from "@emulators/core";

import { getWorkosStore } from "../store.js";
import { listEnvelope, serializeOrganization, workosError, workosId } from "../helpers.js";

export function organizationRoutes(ctx: RouteContext): void {
  const { app, store, baseUrl } = ctx;
  const ws = () => getWorkosStore(store);

  app.post("/organizations", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const name = String(body.name ?? "");
    if (!name) return workosError(c, 422, "invalid_request", "name is required");
    const organization = ws().organizations.insert({
      workos_id: workosId("org"),
      name,
      external_id: typeof body.external_id === "string" ? body.external_id : null,
    });
    return c.json(serializeOrganization(organization), 201);
  });

  app.get("/organizations/:id", (c) => {
    const organization = ws().organizations.findOneBy("workos_id", c.req.param("id"));
    if (!organization) return workosError(c, 404, "entity_not_found", "Organization not found.");
    return c.json(serializeOrganization(organization));
  });

  app.put("/organizations/:id", async (c) => {
    const organization = ws().organizations.findOneBy("workos_id", c.req.param("id"));
    if (!organization) return workosError(c, 404, "entity_not_found", "Organization not found.");
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const updated = ws().organizations.update(organization.id, {
      name: typeof body.name === "string" && body.name ? body.name : organization.name,
    })!;
    return c.json(serializeOrganization(updated));
  });

  app.delete("/organizations/:id", (c) => {
    const organization = ws().organizations.findOneBy("workos_id", c.req.param("id"));
    if (!organization) return workosError(c, 404, "entity_not_found", "Organization not found.");
    // Real WorkOS cascades org deletion to its memberships, so a listing for a
    // deleted org comes back empty and members lose access.
    for (const membership of ws().memberships.findBy("organization_id", organization.workos_id)) {
      ws().memberships.delete(membership.id);
    }
    ws().organizations.delete(organization.id);
    return c.body(null, 204);
  });

  // Organization roles. The legacy path is `/organizations/:id/roles`; the
  // WorkOS Node SDK v10 (`authorization.listOrganizationRoles`) calls the
  // Authorization-API path `/authorization/organizations/:id/roles`. Serve
  // both from one handler so either SDK generation resolves.
  const organizationRoles = (c: Context) => {
    const organization = ws().organizations.findOneBy("workos_id", c.req.param("id"));
    if (!organization) return workosError(c, 404, "entity_not_found", "Organization not found.");
    const now = new Date().toISOString();
    const role = (slug: string, name: string) => ({
      object: "role",
      id: `role_${slug}`,
      name,
      slug,
      description: null,
      permissions: [],
      resource_type_slug: "organization",
      type: "OrganizationRole",
      created_at: now,
      updated_at: now,
    });
    return c.json(listEnvelope([role("admin", "Admin"), role("member", "Member")]));
  };
  app.get("/organizations/:id/roles", organizationRoles);
  app.get("/authorization/organizations/:id/roles", organizationRoles);

  // Domain-verification portal link (cloud's org routes call this).
  app.post("/portal/generate_link", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const organization = String(body.organization ?? "");
    return c.json({ link: `${baseUrl}/_portal/${organization}?intent=${body.intent ?? ""}` });
  });

  app.get("/organization_domains/:id", (c) =>
    c.json({
      object: "organization_domain",
      id: c.req.param("id"),
      organization_id: "org_unknown",
      domain: "example.com",
      state: "verified",
      verification_strategy: "dns",
      verification_token: "token",
    }),
  );

  app.delete("/organization_domains/:id", (c) => c.body(null, 204));
}
