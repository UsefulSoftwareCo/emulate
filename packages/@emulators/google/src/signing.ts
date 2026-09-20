import { exportJWK, generateKeyPair, importJWK, SignJWT, type JWK, type JWTPayload } from "jose";
import type { Store } from "@emulators/core";
import { randomBytes } from "node:crypto";

interface SigningKeys {
  kid: string;
  publicKey: JWK;
  privateKey: JWK;
}

/** Persist each instance's signing material so published keys survive hosted eviction. */
export function googleSigning(store: Store) {
  let pending: Promise<SigningKeys> | undefined;
  const keys = (): Promise<SigningKeys> => {
    const saved = store.getData<SigningKeys>("google.oauth.signingKeys");
    if (saved) return Promise.resolve(saved);
    if (pending) return pending;
    pending = (async () => {
      const pair = await generateKeyPair("RS256", { extractable: true });
      const value = {
        kid: randomBytes(16).toString("hex"),
        publicKey: await exportJWK(pair.publicKey),
        privateKey: await exportJWK(pair.privateKey),
      };
      store.setData("google.oauth.signingKeys", value);
      return value;
    })().finally(() => {
      pending = undefined;
    });
    return pending;
  };
  return {
    async jwks() {
      const value = await keys();
      return { keys: [{ ...value.publicKey, kid: value.kid, alg: "RS256", use: "sig" }] };
    },
    async sign(payload: JWTPayload, issuer: string, audience: string) {
      const value = await keys();
      return new SignJWT(payload)
        .setProtectedHeader({ alg: "RS256", typ: "JWT", kid: value.kid })
        .setIssuer(issuer)
        .setAudience(audience)
        .setIssuedAt()
        .setExpirationTime("1h")
        .sign(await importJWK(value.privateKey, "RS256"));
    },
  };
}
