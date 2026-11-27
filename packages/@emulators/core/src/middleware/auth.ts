import type { Context, Next } from "../http.js";
import { jwtVerify, importPKCS8 } from "jose";
import { debug } from "../debug.js";

export interface AuthUser {
  login: string;
  id: number;
  scopes: string[];
  /**
   * True when this user was synthesized from the configured fallback because
   * the presented token was not a known minted credential. Services that model
   * strict token validation (e.g. Microsoft Graph) can reject these.
   */
  fallback?: boolean;
  /**
   * The provider's own identifier for the user when it is not a small integer
   * (for example X's 19-digit user ids, which a JavaScript number cannot hold).
   * Recorded on ledger entries next to `id`.
   */
  externalId?: string;
}

export interface AuthApp {
  appId: number;
  slug: string;
  name: string;
}

export interface AuthInstallation {
  installationId: number;
  appId: number;
  permissions: Record<string, string>;
  repositoryIds: number[];
  repositorySelection: "all" | "selected";
}

export type TokenMap = Map<string, AuthUser>;

export interface TokenEntry {
  token: string;
  login: string;
  id: number;
  scopes: string[];
  externalId?: string;
}

/** One issued token as a storable record. */
export function tokenEntry(token: string, user: AuthUser): TokenEntry {
  return {
    token,
    login: user.login,
    id: user.id,
    scopes: user.scopes,
    ...(user.externalId !== undefined ? { externalId: user.externalId } : {}),
  };
}

/** The identity a stored token record stands for. */
export function tokenUser(entry: TokenEntry): AuthUser {
  return {
    login: entry.login,
    id: entry.id,
    scopes: entry.scopes ?? [],
    ...(entry.externalId !== undefined ? { externalId: entry.externalId } : {}),
  };
}

export function serializeTokenMap(tokenMap: TokenMap): TokenEntry[] {
  return [...tokenMap.entries()].map(([token, user]) => tokenEntry(token, user));
}

export function restoreTokenMap(tokenMap: TokenMap, tokens: TokenEntry[]): void {
  tokenMap.clear();
  for (const t of tokens) tokenMap.set(t.token, tokenUser(t));
}

export type AppEnv = {
  Variables: {
    authUser?: AuthUser;
    authApp?: AuthApp;
    authToken?: string;
    authScopes?: string[];
    docsUrl?: string;
    /** Correlation id for the active request, set by the ledger middleware. */
    correlationId?: string;
    /** Provider operation id a handler can advertise for the ledger. */
    operationId?: string;
    /** One-shot fault marker set by the shared fault injection middleware. */
    fault?: import("../faults.js").FaultLedgerMarker;
    /** Side effects a handler records onto the active request's ledger entry. */
    ledgerEffects?: import("../ledger.js").LedgerSideEffect[];
    /**
     * Set by a handler that streams a large binary body so the ledger records a
     * placeholder instead of reading the body. Unset by default.
     */
    ledgerOmitResponseBody?: boolean;
    /**
     * Set by a handler to have the ledger record the request body's size in
     * bytes instead of its content (for example a request of several megabytes).
     * Unset by default, so every other request is recorded as before.
     */
    ledgerRequestBodyBytes?: number;
  };
};

export interface AppKeyResolver {
  (appId: number): { privateKey: string; slug: string; name: string } | null;
}

export interface AuthFallback {
  login: string;
  id: number;
  scopes: string[];
}

export function authMiddleware(
  tokens: TokenMap,
  appKeyResolver?: AppKeyResolver,
  fallbackUser?: AuthFallback,
  isRevoked: (token: string) => boolean = () => false,
) {
  return async (c: Context, next: Next) => {
    const authHeader = c.req.header("Authorization");
    if (authHeader) {
      const token = authHeader.replace(/^(Bearer|token)\s+/i, "").trim();

      if (token.startsWith("eyJ") && appKeyResolver) {
        try {
          const [, payloadB64] = token.split(".");
          const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString());
          const appId = typeof payload.iss === "string" ? parseInt(payload.iss, 10) : payload.iss;

          if (typeof appId === "number" && !isNaN(appId)) {
            const appInfo = appKeyResolver(appId);
            if (appInfo) {
              const key = await importPKCS8(appInfo.privateKey, "RS256");
              await jwtVerify(token, key, { algorithms: ["RS256"] });
              c.set("authApp", {
                appId,
                slug: appInfo.slug,
                name: appInfo.name,
              } satisfies AuthApp);
            }
          }
        } catch {
          // JWT verification failed
        }
      } else {
        // A revoked token is refused even where unknown tokens fall back to a default user.
        const revoked = isRevoked(token);
        let user = revoked ? undefined : tokens.get(token);
        if (!user && !revoked && fallbackUser && token.length > 0) {
          debug("auth", "fallback user for unknown token", { login: fallbackUser.login, id: fallbackUser.id });
          user = { login: fallbackUser.login, id: fallbackUser.id, scopes: fallbackUser.scopes, fallback: true };
        }
        if (user) {
          c.set("authUser", user);
          c.set("authToken", token);
          c.set("authScopes", user.scopes);
        }
      }
    }
    await next();
  };
}

export function requireAuth() {
  return async (c: Context, next: Next) => {
    if (!c.get("authUser")) {
      const docsUrl = (c.get("docsUrl") as string | undefined) ?? "https://emulate.dev";
      return c.json(
        {
          message: "Requires authentication",
          documentation_url: docsUrl,
        },
        401,
      );
    }
    await next();
  };
}

export function requireAppAuth() {
  return async (c: Context, next: Next) => {
    if (!c.get("authApp")) {
      const docsUrl = (c.get("docsUrl") as string | undefined) ?? "https://emulate.dev";
      return c.json(
        {
          message: "A JSON web token could not be decoded",
          documentation_url: docsUrl,
        },
        401,
      );
    }
    await next();
  };
}
