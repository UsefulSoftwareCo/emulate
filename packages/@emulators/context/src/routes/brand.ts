import type { RouteContext } from "@emulators/core";
import type { ContextBrand } from "../entities.js";
import { getContextStore } from "../store.js";
import { domainFromEmail, isPersonalDomain, normalizeDomain } from "../helpers.js";

interface RetrieveBody {
  type?: unknown;
  email?: unknown;
  domain?: unknown;
}

function contextError(status: 400 | 404 | 422, code: string, message: string) {
  return { body: { error: { type: code, message } }, status } as const;
}

/** Serializes a stored brand into Context's `brand/retrieve` response shape. */
function present(brand: ContextBrand) {
  return {
    domain: brand.domain,
    title: brand.title ?? undefined,
    description: brand.description ?? undefined,
    logos: brand.logos,
    colors: brand.colors,
  };
}

export function brandRoutes(ctx: RouteContext): void {
  const { app, store } = ctx;
  const cs = () => getContextStore(store);

  app.post("/v1/brand/retrieve", async (c) => {
    let body: RetrieveBody;
    try {
      body = (await c.req.json()) as RetrieveBody;
    } catch {
      const { body: payload, status } = contextError(422, "invalid_request", "Request body must be JSON");
      return c.json(payload, status);
    }

    const type = typeof body.type === "string" ? body.type : "by_domain";
    let domain: string | null = null;

    if (type === "by_email") {
      if (typeof body.email !== "string") {
        const { body: payload, status } = contextError(422, "invalid_request", "email is required for by_email");
        return c.json(payload, status);
      }
      domain = domainFromEmail(body.email);
      if (domain === null) {
        const { body: payload, status } = contextError(422, "invalid_request", "email is not a valid address");
        return c.json(payload, status);
      }
      // Context resolves companies, not people: a free or disposable mailbox
      // domain is never a brand, so it is rejected before any lookup.
      if (isPersonalDomain(domain)) {
        const { body: payload, status } = contextError(404, "not_found", "No brand for a personal email domain");
        return c.json(payload, status);
      }
    } else if (type === "by_domain") {
      if (typeof body.domain !== "string") {
        const { body: payload, status } = contextError(422, "invalid_request", "domain is required for by_domain");
        return c.json(payload, status);
      }
      domain = normalizeDomain(body.domain);
    } else {
      const { body: payload, status } = contextError(422, "invalid_request", `Unsupported type: ${type}`);
      return c.json(payload, status);
    }

    const brand = cs().brands.findOneBy("domain", domain);
    if (!brand) {
      const { body: payload, status } = contextError(404, "not_found", `No brand found for ${domain}`);
      return c.json(payload, status);
    }

    // A partial brand means enrichment has not finished. Context still answers
    // 200 with the flag set so the caller retries instead of caching a miss.
    if (brand.partial) return c.json({ partial: true, brand: present(brand) });
    return c.json({ partial: false, brand: present(brand) });
  });
}
