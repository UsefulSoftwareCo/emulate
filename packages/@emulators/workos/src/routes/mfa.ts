import type { RouteContext } from "@emulators/core";
import { Secret, TOTP } from "otpauth";
import { toDataURL } from "qrcode";
import { getWorkosStore } from "../store.js";
import type { WorkosMfaFactor, WorkosMfaChallenge } from "../entities.js";
import { listEnvelope, workosError, workosId } from "../helpers.js";

const factorJson = (factor: WorkosMfaFactor) => ({
  object: "authentication_factor",
  id: factor.workos_id,
  created_at: factor.created_at,
  updated_at: factor.updated_at,
  type: "totp",
  user_id: factor.user_id,
  totp: { issuer: factor.issuer, user: factor.label },
});
const challengeJson = (challenge: WorkosMfaChallenge) => ({
  object: "authentication_challenge",
  id: challenge.workos_id,
  created_at: challenge.created_at,
  updated_at: challenge.updated_at,
  authentication_factor_id: challenge.factor_id,
});
const totpFor = (factor: WorkosMfaFactor) =>
  new TOTP({
    issuer: factor.issuer,
    label: factor.label,
    secret: factor.secret,
    algorithm: "SHA1",
    digits: 6,
    period: 30,
  });

/** AuthKit TOTP enrollment and MFA challenge endpoints, including one-use verification. */
export function mfaRoutes({ app, store }: RouteContext): void {
  const ws = getWorkosStore(store);
  const challengeFor = (factorId: string) =>
    ws.mfaChallenges.insert({
      workos_id: workosId("auth_challenge"),
      factor_id: factorId,
      verified: false,
    });

  app.post("/user_management/users/:id/auth_factors", async (c) => {
    const user = ws.users.findOneBy("workos_id", c.req.param("id"));
    if (!user) return workosError(c, 404, "user_not_found", "User not found");
    const body: unknown = await c.req.json();
    if (typeof body !== "object" || body === null || !("type" in body) || body.type !== "totp") {
      return workosError(c, 400, "invalid_request", "Only TOTP factors are supported");
    }
    const issuer = "totp_issuer" in body && typeof body.totp_issuer === "string" ? body.totp_issuer : "WorkOS";
    const label = "totp_user" in body && typeof body.totp_user === "string" ? body.totp_user : user.email;
    const secret =
      "totp_secret" in body && typeof body.totp_secret === "string"
        ? body.totp_secret
        : new Secret({ size: 20 }).base32;
    if (!/^[A-Z2-7]{16,}={0,6}$/i.test(secret)) return workosError(c, 400, "invalid_request", "Invalid TOTP secret");
    const factor = ws.mfaFactors.insert({
      workos_id: workosId("auth_factor"),
      user_id: user.workos_id,
      issuer,
      label,
      secret,
      verified: false,
    });
    const totp = totpFor(factor);
    return c.json({
      authentication_factor: {
        ...factorJson(factor),
        totp: { issuer, user: label, secret, uri: totp.toString(), qr_code: await toDataURL(totp.toString()) },
      },
      authentication_challenge: challengeJson(challengeFor(factor.workos_id)),
    });
  });

  app.get("/user_management/users/:id/auth_factors", (c) => {
    const user = ws.users.findOneBy("workos_id", c.req.param("id"));
    if (!user) return workosError(c, 404, "user_not_found", "User not found");
    // AuthKit excludes unfinished enrollments from the active-factor list.
    return c.json(
      listEnvelope(
        ws.mfaFactors
          .findBy("user_id", user.workos_id)
          .filter((factor) => factor.verified)
          .map(factorJson),
      ),
    );
  });

  app.post("/auth/factors/:id/challenge", (c) => {
    const factor = ws.mfaFactors.findOneBy("workos_id", c.req.param("id"));
    if (!factor) return workosError(c, 404, "authentication_factor_not_found", "Factor not found");
    return c.json(challengeJson(challengeFor(factor.workos_id)));
  });

  app.post("/auth/challenges/:id/verify", async (c) => {
    const challenge = ws.mfaChallenges.findOneBy("workos_id", c.req.param("id"));
    if (!challenge) return workosError(c, 404, "authentication_challenge_not_found", "Challenge not found");
    if (challenge.verified)
      return workosError(c, 422, "authentication_challenge_previously_verified", "Challenge already verified");
    const factor = ws.mfaFactors.findOneBy("workos_id", challenge.factor_id);
    if (!factor) return workosError(c, 404, "authentication_factor_not_found", "Factor not found");
    const body: unknown = await c.req.json();
    const code =
      typeof body === "object" && body !== null && "code" in body && typeof body.code === "string" ? body.code : "";
    const valid = /^\d{6}$/.test(code) && totpFor(factor).validate({ token: code, window: 1 }) !== null;
    if (valid) {
      ws.mfaChallenges.update(challenge.id, { verified: true });
      ws.mfaFactors.update(factor.id, { verified: true });
    }
    return c.json({ valid, challenge: challengeJson(challenge) });
  });

  app.get("/auth/factors/:id", (c) => {
    const factor = ws.mfaFactors.findOneBy("workos_id", c.req.param("id"));
    return factor
      ? c.json(factorJson(factor))
      : workosError(c, 404, "authentication_factor_not_found", "Factor not found");
  });
  app.delete("/auth/factors/:id", (c) => {
    const factor = ws.mfaFactors.findOneBy("workos_id", c.req.param("id"));
    if (!factor) return workosError(c, 404, "authentication_factor_not_found", "Factor not found");
    ws.mfaFactors.delete(factor.id);
    return c.body(null, 204);
  });
}
