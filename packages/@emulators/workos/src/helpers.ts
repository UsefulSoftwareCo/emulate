import type { Context } from "@emulators/core";

import type {
  WorkosApiKey,
  WorkosInvitation,
  WorkosMembership,
  WorkosOrganization,
  WorkosUser,
  WorkosVaultObject,
} from "./entities.js";

let counter = 0;
/** WorkOS-shaped ids: prefix + monotonic + entropy (readable in ledgers/tests). */
export function workosId(prefix: string): string {
  counter += 1;
  return `${prefix}_${String(counter).padStart(4, "0")}${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

export function randomToken(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
}

/** WorkOS error envelope. */
export function workosError(c: Context, status: number, code: string, message: string): Response {
  return c.json({ code, message, error: code, error_description: message }, status as 404);
}

/** Single-page WorkOS list envelope. */
export function listEnvelope<T>(data: T[]): {
  object: "list";
  data: T[];
  list_metadata: { before: null; after: null };
  listMetadata: { before: null; after: null };
} {
  return {
    object: "list",
    data,
    list_metadata: { before: null, after: null },
    // Some SDK paths read the camelCase variant on raw responses.
    listMetadata: { before: null, after: null },
  };
}

// --- serializers: store entities → WorkOS wire shapes (snake_case) ---------

export function serializeUser(user: WorkosUser): Record<string, unknown> {
  return {
    object: "user",
    id: user.workos_id,
    email: user.email,
    email_verified: user.email_verified,
    first_name: user.first_name,
    last_name: user.last_name,
    profile_picture_url: user.profile_picture_url,
    last_sign_in_at: user.updated_at,
    external_id: null,
    metadata: {},
    created_at: user.created_at,
    updated_at: user.updated_at,
  };
}

export function serializeOrganization(org: WorkosOrganization): Record<string, unknown> {
  return {
    object: "organization",
    id: org.workos_id,
    name: org.name,
    allow_profiles_outside_organization: false,
    domains: [],
    stripe_customer_id: null,
    external_id: org.external_id,
    metadata: {},
    created_at: org.created_at,
    updated_at: org.updated_at,
  };
}

export function serializeMembership(membership: WorkosMembership, organizationName: string): Record<string, unknown> {
  return {
    object: "organization_membership",
    id: membership.workos_id,
    user_id: membership.user_id,
    organization_id: membership.organization_id,
    organization_name: organizationName,
    status: membership.status,
    role: { slug: membership.role_slug },
    created_at: membership.created_at,
    updated_at: membership.updated_at,
  };
}

export function serializeInvitation(invitation: WorkosInvitation): Record<string, unknown> {
  return {
    object: "invitation",
    id: invitation.workos_id,
    email: invitation.email,
    state: invitation.state,
    organization_id: invitation.organization_id,
    inviter_user_id: invitation.inviter_user_id,
    accepted_user_id: null,
    token: invitation.token,
    accept_invitation_url: `https://example.invalid/invite/${invitation.token}`,
    expires_at: invitation.expires_at,
    created_at: invitation.created_at,
    updated_at: invitation.updated_at,
  };
}

export function serializeApiKey(key: WorkosApiKey, options: { includeValue?: boolean } = {}): Record<string, unknown> {
  return {
    object: "api_key",
    id: key.workos_id,
    name: key.name,
    obfuscated_value: `${key.value.slice(0, 7)}…${key.value.slice(-4)}`,
    owner: { type: "user", id: key.user_id, organization_id: key.organization_id },
    last_used_at: key.last_used_at,
    created_at: key.created_at,
    updated_at: key.updated_at,
    ...(options.includeValue ? { value: key.value } : {}),
  };
}

export function serializeVaultMetadata(object: WorkosVaultObject): Record<string, unknown> {
  return {
    id: object.workos_id,
    context: object.key_context,
    environment_id: "environment_emulate",
    key_id: "key_emulate",
    updated_at: object.updated_at,
    updated_by: { id: "key_emulate", name: "emulate" },
    version_id: object.version_id,
  };
}

export function serializeVaultObject(object: WorkosVaultObject): Record<string, unknown> {
  return {
    id: object.workos_id,
    name: object.name,
    value: object.value,
    metadata: serializeVaultMetadata(object),
  };
}

/** Parse `statuses` from repeated params, comma lists, or bracket arrays. */
export function parseStatuses(c: Context): string[] {
  const repeated = c.req.queries("statuses") ?? [];
  const bracketed = c.req.queries("statuses[]") ?? [];
  return [...repeated, ...bracketed].flatMap((value) => value.split(",")).filter(Boolean);
}
