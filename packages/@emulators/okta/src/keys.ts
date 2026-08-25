import { randomUUID } from "node:crypto";
import { SignJWT, exportJWK, generateKeyPair, jwtVerify, type JWTPayload } from "jose";

// One RS256 keypair per process, served from both JWKS surfaces the Okta stack
// exposes: /oauth2/v1/keys (org authorization server) and
// /oauth2/:authServerId/v1/keys (custom authorization servers). The same key
// signs ID tokens and Identity Assertion JWT Authorization Grants (ID-JAGs).
const keyPairPromise = generateKeyPair("RS256");
export const KID = "emulate-okta-1";

export async function jwksResponse(): Promise<{ keys: Record<string, unknown>[] }> {
  const { publicKey } = await keyPairPromise;
  const jwk = await exportJWK(publicKey);
  return { keys: [{ ...jwk, kid: KID, use: "sig", alg: "RS256" }] };
}

export async function signIdToken(
  claims: Record<string, unknown>,
  options: { issuer: string; audience: string; issuedAt: number; expiresIn?: string },
): Promise<string> {
  const { privateKey } = await keyPairPromise;
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: KID, typ: "JWT" })
    .setIssuer(options.issuer)
    .setAudience(options.audience)
    .setIssuedAt(options.issuedAt)
    .setExpirationTime(options.expiresIn ?? "1h")
    .sign(privateKey);
}

/**
 * Verify an ID token this emulator issued. The `typ` constraint keeps an ID-JAG
 * (typ `oauth-id-jag+jwt`) from being replayed as an Identity Assertion.
 */
export async function verifyIdToken(token: string, options: { issuer: string }): Promise<JWTPayload> {
  const { publicKey } = await keyPairPromise;
  const { payload } = await jwtVerify(token, publicKey, { issuer: options.issuer, typ: "JWT" });
  return payload;
}

export interface IdentityAssertionClaims {
  sub: string;
  client_id: string;
  email?: string;
  resource?: string;
  scope?: string;
  [key: string]: unknown;
}

/**
 * Mint an Identity Assertion JWT Authorization Grant, the token exchange output
 * of draft-ietf-oauth-identity-assertion-authz-grant-04 section 3.1.
 */
export async function signIdentityAssertion(
  claims: IdentityAssertionClaims,
  options: { issuer: string; audience: string; expiresIn?: string },
): Promise<string> {
  const { privateKey } = await keyPairPromise;
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: KID, typ: "oauth-id-jag+jwt" })
    .setIssuer(options.issuer)
    .setAudience(options.audience)
    .setIssuedAt()
    .setJti(`idjag_${randomUUID().replace(/-/g, "")}`)
    .setExpirationTime(options.expiresIn ?? "5m")
    .sign(privateKey);
}
