import type { Context } from "@emulators/core";

/** Problem type URIs as the v2 OpenAPI spec (2.175) names them. */
export const PROBLEM = {
  invalidRequest: "https://api.x.com/2/problems/invalid-request",
  resourceNotFound: "https://api.x.com/2/problems/resource-not-found",
  notAuthorizedForResource: "https://api.x.com/2/problems/not-authorized-for-resource",
  dmConversationNotFound: "https://api.x.com/2/problems/dm-conversation-not-found",
  dmNotFound: "https://api.x.com/2/problems/dm-not-found",
  dmNotOwner: "https://api.x.com/2/problems/dm-not-owner",
  dmSenderNotInConversation: "https://api.x.com/2/problems/dm-sender-not-in-conversation",
  dmTextEmpty: "https://api.x.com/2/problems/dm-text-empty",
  dmTextTooLong: "https://api.x.com/2/problems/dm-text-too-long",
  dmBadMedia: "https://api.x.com/2/problems/dm-bad-media",
  dmRecipientNotFound: "https://api.x.com/2/problems/dm-recipient-not-found",
} as const;

/** The v2 400 envelope for a parameter X rejects. */
export function invalidRequest(c: Context, parameter: string, value: unknown, message: string) {
  return c.json(
    {
      errors: [{ parameters: { [parameter]: [value === undefined ? "" : String(value)] }, message }],
      title: "Invalid Request",
      detail: "One or more parameters to your request was invalid.",
      type: PROBLEM.invalidRequest,
    },
    400,
  );
}

/** A single problem object as the top-level body (used for DM send failures). */
export function problem(c: Context, status: 400 | 403 | 404, type: string, title: string, detail: string) {
  return c.json({ title, detail, type, status }, status);
}

/** Split a comma-separated (style=form, explode=false) query parameter. */
export function listParam(c: Context, name: string): string[] | undefined {
  const raw = c.req.query(name);
  if (raw === undefined) return undefined;
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Validate a list parameter against its enum; returns the set or a 400 response. */
export function enumListParam(
  c: Context,
  name: string,
  allowed: Set<string>,
): { values: Set<string> } | { response: Response } {
  const values = listParam(c, name) ?? [];
  for (const v of values) {
    if (!allowed.has(v)) {
      return {
        response: invalidRequest(
          c,
          name,
          v,
          `The \`${name}\` query parameter value [${v}] is not one of [${[...allowed].join(",")}]`,
        ),
      };
    }
  }
  return { values: new Set(values) };
}
