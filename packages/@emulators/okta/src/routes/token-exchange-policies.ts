import { parsePagination, recordSideEffect, setLinkHeader, type RouteContext } from "@emulators/core";
import { generateOktaId } from "../helpers.js";
import {
  findTokenExchangePolicyByRef,
  oktaError,
  readJsonObject,
  requireManagementAuth,
  tokenExchangePolicyResponse,
} from "../route-helpers.js";
import { getOktaStore } from "../store.js";
import { normalizePolicyEffect } from "../token-exchange-policy.js";

function optionalString(value: unknown, fallback: string | null): string | null {
  if (value === undefined) return fallback;
  if (value === null) return null;
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function scopeList(value: unknown, fallback: string[]): string[] {
  if (value === undefined) return fallback;
  if (typeof value === "string") {
    return value.split(/\s+/).filter(Boolean);
  }
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === "string");
  }
  return fallback;
}

/**
 * Administrator control plane for the token exchange policy table used by MCP
 * Enterprise-Managed Authorization. Okta has no public API for this, so these
 * routes are an emulator extension, shaped like the rest of the management API
 * and gated by the same SSWS token.
 */
export function tokenExchangePolicyRoutes({ app, store, baseUrl, tokenMap }: RouteContext): void {
  const oktaStore = getOktaStore(store);

  app.get("/api/v1/tokenExchangePolicies", (c) => {
    const auth = requireManagementAuth(c, tokenMap);
    if (auth instanceof Response) return auth;

    const policies = oktaStore.tokenExchangePolicies.all();
    const { page, per_page } = parsePagination(c);
    const total = policies.length;
    const start = (page - 1) * per_page;
    const paged = policies.slice(start, start + per_page);
    setLinkHeader(c, total, page, per_page);
    c.header("X-Total-Count", String(total));

    return c.json(paged.map((policy) => tokenExchangePolicyResponse(baseUrl, policy)));
  });

  app.post("/api/v1/tokenExchangePolicies", async (c) => {
    const auth = requireManagementAuth(c, tokenMap);
    if (auth instanceof Response) return auth;

    const body = await readJsonObject(c);
    const policyId = typeof body.id === "string" && body.id.trim() ? body.id.trim() : generateOktaId("00p");
    if (oktaStore.tokenExchangePolicies.findOneBy("policy_id", policyId)) {
      return oktaError(c, 400, "E0000001", `Token exchange policy '${policyId}' already exists`);
    }

    const created = oktaStore.tokenExchangePolicies.insert({
      policy_id: policyId,
      name: typeof body.name === "string" && body.name.trim() ? body.name.trim() : policyId,
      user_okta_id: optionalString(body.user_okta_id, null),
      client_id: optionalString(body.client_id, null),
      audience: optionalString(body.audience, null),
      resource: optionalString(body.resource, null),
      scopes: scopeList(body.scopes, []),
      effect: normalizePolicyEffect(typeof body.effect === "string" ? body.effect : undefined, "ALLOW"),
    });

    recordSideEffect(c, {
      type: "create",
      collection: "okta.token_exchange_policies",
      id: created.id,
      summary: `Created token exchange policy ${created.policy_id}`,
    });

    return c.json(tokenExchangePolicyResponse(baseUrl, created), 201);
  });

  app.get("/api/v1/tokenExchangePolicies/:policyId", (c) => {
    const auth = requireManagementAuth(c, tokenMap);
    if (auth instanceof Response) return auth;

    const policy = findTokenExchangePolicyByRef(oktaStore, c.req.param("policyId"));
    if (!policy) return oktaError(c, 404, "E0000007", "Not found: token exchange policy");
    return c.json(tokenExchangePolicyResponse(baseUrl, policy));
  });

  app.put("/api/v1/tokenExchangePolicies/:policyId", async (c) => {
    const auth = requireManagementAuth(c, tokenMap);
    if (auth instanceof Response) return auth;

    const policy = findTokenExchangePolicyByRef(oktaStore, c.req.param("policyId"));
    if (!policy) return oktaError(c, 404, "E0000007", "Not found: token exchange policy");

    const body = await readJsonObject(c);
    const updated = oktaStore.tokenExchangePolicies.update(policy.id, {
      name: typeof body.name === "string" && body.name.trim() ? body.name.trim() : policy.name,
      user_okta_id: optionalString(body.user_okta_id, policy.user_okta_id),
      client_id: optionalString(body.client_id, policy.client_id),
      audience: optionalString(body.audience, policy.audience),
      resource: optionalString(body.resource, policy.resource),
      scopes: scopeList(body.scopes, policy.scopes),
      effect: normalizePolicyEffect(typeof body.effect === "string" ? body.effect : undefined, policy.effect),
    });
    return c.json(tokenExchangePolicyResponse(baseUrl, updated ?? policy));
  });

  app.delete("/api/v1/tokenExchangePolicies/:policyId", (c) => {
    const auth = requireManagementAuth(c, tokenMap);
    if (auth instanceof Response) return auth;

    const policy = findTokenExchangePolicyByRef(oktaStore, c.req.param("policyId"));
    if (!policy) return oktaError(c, 404, "E0000007", "Not found: token exchange policy");

    oktaStore.tokenExchangePolicies.delete(policy.id);
    recordSideEffect(c, {
      type: "delete",
      collection: "okta.token_exchange_policies",
      id: policy.id,
      summary: `Deleted token exchange policy ${policy.policy_id}`,
    });
    return new Response(null, { status: 204 });
  });
}
