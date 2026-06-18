import { SignJWT, exportJWK, generateKeyPair, jwtVerify, type JWTPayload } from "jose";

// One RS256 keypair per process; served from BOTH JWKS surfaces the WorkOS
// stack reads: /sso/jwks/:clientId (the node SDK's sealed-session verify) and
// /oauth2/jwks (AuthKit-domain consumers, e.g. MCP resource servers).
const keyPairPromise = generateKeyPair("RS256", { extractable: true });
export const KID = "emulate-workos-1";

export async function jwksResponse(): Promise<{ keys: Record<string, unknown>[] }> {
  const { publicKey } = await keyPairPromise;
  const jwk = await exportJWK(publicKey);
  return { keys: [{ ...jwk, kid: KID, use: "sig", alg: "RS256" }] };
}

export interface AccessTokenClaims {
  sub: string; // user id
  sid: string; // session id
  org_id?: string;
  role?: string;
  permissions?: string[];
  [key: string]: unknown;
}

export async function signAccessToken(
  claims: AccessTokenClaims,
  options: { issuer: string; audience?: string; expiresIn?: string },
): Promise<string> {
  const { privateKey } = await keyPairPromise;
  let jwt = new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: KID, typ: "JWT" })
    .setIssuer(options.issuer)
    .setIssuedAt()
    .setJti(`jti_${Math.random().toString(36).slice(2)}`)
    .setExpirationTime(options.expiresIn ?? "1h");
  if (options.audience) jwt = jwt.setAudience(options.audience);
  return jwt.sign(privateKey);
}

export async function verifyAccessToken(
  token: string,
  options: { issuer: string },
): Promise<{ payload: JWTPayload & AccessTokenClaims }> {
  const { publicKey } = await keyPairPromise;
  const { payload } = await jwtVerify(token, publicKey, { issuer: options.issuer });
  return { payload: payload as JWTPayload & AccessTokenClaims };
}

export interface IdentityAssertionClaims {
  sub: string;
  email?: string;
  preferred_username?: string;
  resource?: string;
  client_id?: string;
  scope?: string;
  org_id?: string;
  [key: string]: unknown;
}

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
    .setJti(`idjag_${Math.random().toString(36).slice(2)}`)
    .setExpirationTime(options.expiresIn ?? "5m")
    .sign(privateKey);
}
