import type { Context, RouteContext } from "@emulators/core";

import { getWorkosStore } from "../store.js";
import {
  listEnvelope,
  randomToken,
  serializeOrganization,
  serializeOrganizationDomain,
  workosError,
  workosId,
} from "../helpers.js";

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
    const domains = ws().organizationDomains.findBy("organization_id", organization.workos_id);
    return c.json(serializeOrganization(organization, domains));
  });

  app.put("/organizations/:id", async (c) => {
    const organization = ws().organizations.findOneBy("workos_id", c.req.param("id"));
    if (!organization) return workosError(c, 404, "entity_not_found", "Organization not found.");
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const updated = ws().organizations.update(organization.id, {
      name: typeof body.name === "string" && body.name ? body.name : organization.name,
    })!;
    const domains = ws().organizationDomains.findBy("organization_id", organization.workos_id);
    return c.json(serializeOrganization(updated, domains));
  });

  app.delete("/organizations/:id", (c) => {
    const organization = ws().organizations.findOneBy("workos_id", c.req.param("id"));
    if (!organization) return workosError(c, 404, "entity_not_found", "Organization not found.");
    // Real WorkOS cascades org deletion to its memberships, so a listing for a
    // deleted org comes back empty and members lose access.
    for (const membership of ws().memberships.findBy("organization_id", organization.workos_id)) {
      ws().memberships.delete(membership.id);
    }
    for (const domain of ws().organizationDomains.findBy("organization_id", organization.workos_id)) {
      ws().organizationDomains.delete(domain.id);
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

  app.post("/organization_domains", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const organizationId = typeof body.organization_id === "string" ? body.organization_id : "";
    const domainName = typeof body.domain === "string" ? body.domain.trim().toLowerCase() : "";
    if (!organizationId) return workosError(c, 422, "invalid_request", "organization_id is required");
    if (!domainName) return workosError(c, 422, "invalid_request", "domain is required");
    if (!ws().organizations.findOneBy("workos_id", organizationId)) {
      return workosError(c, 404, "entity_not_found", "Organization not found.");
    }
    if (ws().organizationDomains.findOneBy("domain", domainName)) {
      return workosError(c, 409, "conflict", "Domain already exists.");
    }
    const domain = ws().organizationDomains.insert({
      workos_id: workosId("org_domain"),
      organization_id: organizationId,
      domain: domainName,
      state: "pending",
      verification_strategy: "dns",
      verification_token: randomToken("verification"),
      verification_prefix: "workos-domain-verification",
    });
    return c.json(serializeOrganizationDomain(domain), 201);
  });

  app.get("/organization_domains/:id", (c) => {
    const domain = ws().organizationDomains.findOneBy("workos_id", c.req.param("id"));
    if (!domain) return workosError(c, 404, "entity_not_found", "Organization domain not found.");
    return c.json(serializeOrganizationDomain(domain));
  });

  app.delete("/organization_domains/:id", (c) => {
    const domain = ws().organizationDomains.findOneBy("workos_id", c.req.param("id"));
    if (!domain) return workosError(c, 404, "entity_not_found", "Organization domain not found.");
    ws().organizationDomains.delete(domain.id);
    return c.body(null, 204);
  });

  app.post("/_emulate/organization_domains/:id/verify", (c) => {
    const domain = ws().organizationDomains.findOneBy("workos_id", c.req.param("id"));
    if (!domain) return workosError(c, 404, "entity_not_found", "Organization domain not found.");
    const verified = ws().organizationDomains.update(domain.id, {
      state: "verified",
      verification_token: null,
      verification_prefix: null,
    });
    if (!verified) return workosError(c, 404, "entity_not_found", "Organization domain not found.");
    return c.json(serializeOrganizationDomain(verified));
  });
}
