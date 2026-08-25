import type { OktaPolicyEffect, OktaTokenExchangePolicy } from "./entities.js";

export interface TokenExchangeRequest {
  userOktaId: string;
  clientId: string;
  audience: string;
  resource: string | null;
  requestedScopes: string[];
}

export type TokenExchangeDecision =
  | { allowed: true; scopes: string[]; matched: OktaTokenExchangePolicy[] }
  | { allowed: false; reason: "denied" | "no_match" | "no_permitted_scope"; matched: OktaTokenExchangePolicy[] };

function conditionMatches(condition: string | null, value: string | null): boolean {
  if (condition === null) return true;
  return condition === value;
}

export function policyMatches(policy: OktaTokenExchangePolicy, request: TokenExchangeRequest): boolean {
  return (
    conditionMatches(policy.user_okta_id, request.userOktaId) &&
    conditionMatches(policy.client_id, request.clientId) &&
    conditionMatches(policy.audience, request.audience) &&
    conditionMatches(policy.resource, request.resource)
  );
}

export function normalizePolicyEffect(effect: string | undefined, fallback: OktaPolicyEffect): OktaPolicyEffect {
  if (effect === "ALLOW" || effect === "DENY") return effect;
  return fallback;
}

/**
 * Evaluate the administrator policy table for a token exchange request.
 *
 * With an empty table every exchange is allowed with the scopes it asked for,
 * matching how this emulator already treats unconfigured OAuth clients: seed a
 * table to turn enforcement on. Once any policy exists the table is an
 * allowlist, so an unmatched request is denied. An explicit DENY always beats a
 * matching ALLOW.
 *
 * A matching ALLOW with a non-empty `scopes` list narrows the request to the
 * intersection; an ALLOW with an empty list grants whatever was requested.
 */
export function evaluateTokenExchangePolicy(
  policies: OktaTokenExchangePolicy[],
  request: TokenExchangeRequest,
): TokenExchangeDecision {
  if (policies.length === 0) {
    return { allowed: true, scopes: request.requestedScopes, matched: [] };
  }

  const matched = policies.filter((policy) => policyMatches(policy, request));
  if (matched.some((policy) => policy.effect === "DENY")) {
    return { allowed: false, reason: "denied", matched };
  }

  const allows = matched.filter((policy) => policy.effect === "ALLOW");
  if (allows.length === 0) {
    return { allowed: false, reason: "no_match", matched };
  }

  const unrestricted = allows.some((policy) => policy.scopes.length === 0);
  if (unrestricted) {
    return { allowed: true, scopes: request.requestedScopes, matched: allows };
  }

  const permitted = new Set(allows.flatMap((policy) => policy.scopes));
  const granted = request.requestedScopes.filter((scope) => permitted.has(scope));
  if (request.requestedScopes.length > 0 && granted.length === 0) {
    return { allowed: false, reason: "no_permitted_scope", matched: allows };
  }
  return { allowed: true, scopes: granted, matched: allows };
}
