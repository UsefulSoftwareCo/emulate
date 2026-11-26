import { createHash, randomBytes } from "crypto";
import { describe, expect, it } from "vitest";
import { createEmulator, type Emulator, type ServiceName } from "../api.js";

const REDIRECT = "http://127.0.0.1:9/callback";
const STATE = "state-from-the-client";

// Every service whose OAuth consent page lists users to approve as.
const consentPages: ReadonlyArray<{ service: ServiceName; scope: string; path?: string }> = [
  { service: "github", scope: "read:user" },
  { service: "google", scope: "openid email" },
  { service: "apple", scope: "openid email" },
  { service: "microsoft", scope: "openid email" },
  { service: "okta", scope: "openid email" },
  { service: "slack", scope: "openid email" },
  { service: "vercel", scope: "openid email" },
  { service: "clerk", scope: "openid email" },
  { service: "x", scope: "users.read" },
  { service: "posthog", scope: "openid email" },
  { service: "planetscale", scope: "email" },
  { service: "miro", scope: "boards:read" },
  { service: "mcp", scope: "", path: "/authorize" },
  { service: "workos", scope: "", path: "/user_management/authorize" },
];

async function clientFor(emulator: Emulator, service: ServiceName): Promise<{ clientId: string; authorize: string }> {
  if (service === "mcp") {
    const registered = await fetch(`${emulator.url}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "Consent test",
        redirect_uris: [REDIRECT],
        token_endpoint_auth_method: "none",
      }),
    });
    const body = (await registered.json()) as { client_id: string };
    return { clientId: body.client_id, authorize: `${emulator.url}/authorize` };
  }
  if (service === "workos")
    return { clientId: "client_consent_test", authorize: `${emulator.url}/user_management/authorize` };
  const issued = await emulator.credentials.mint({ type: "oauth-authorization-code", redirect_uris: [REDIRECT] });
  return { clientId: issued.client_id ?? "", authorize: issued.authorization_url ?? "" };
}

function consentQuery(clientId: string, scope: string): URLSearchParams {
  const verifier = randomBytes(32).toString("base64url");
  return new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT,
    response_type: "code",
    ...(scope ? { scope } : {}),
    state: STATE,
    nonce: "consent-nonce",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    provider: "authkit",
  });
}

describe("OAuth consent pages", () => {
  for (const { service, scope } of consentPages) {
    it(`${service}: Deny sends the person back with access_denied and the state, and no code`, async () => {
      const emulator = await createEmulator({ service, port: 0, hostname: "127.0.0.1" });
      try {
        const { clientId, authorize } = await clientFor(emulator, service);
        const page = await fetch(`${authorize}?${consentQuery(clientId, scope)}`);
        expect(page.status).toBe(200);
        const href = /class="deny-btn" href="([^"]+)"/.exec(await page.text())?.[1]?.replaceAll("&amp;", "&");
        expect(href).toBeDefined();
        const denied = new URL(href ?? "");
        expect(`${denied.origin}${denied.pathname}`).toBe(REDIRECT);
        expect(denied.searchParams.get("error")).toBe("access_denied");
        expect(denied.searchParams.get("state")).toBe(STATE);
        expect(denied.searchParams.has("code")).toBe(false);
      } finally {
        await emulator.close();
      }
    });
  }

  it("Deny answers in form_post when the request asked for it", async () => {
    const emulator = await createEmulator({ service: "apple", port: 0, hostname: "127.0.0.1" });
    try {
      const { clientId, authorize } = await clientFor(emulator, "apple");
      const query = consentQuery(clientId, "openid email");
      query.set("response_mode", "form_post");
      const html = await (await fetch(`${authorize}?${query}`)).text();
      expect(html).toContain(`class="deny-form" method="post" action="${REDIRECT}"`);
      expect(html).toContain('name="error" value="access_denied"');
      expect(html).toContain(`name="state" value="${STATE}"`);
    } finally {
      await emulator.close();
    }
  });
});

describe("strict", () => {
  it("refuses a token the emulator never issued, and keeps the default permissive", async () => {
    const strict = await createEmulator({ service: "github", port: 0, hostname: "127.0.0.1", strict: true });
    const permissive = await createEmulator({ service: "github", port: 0, hostname: "127.0.0.1" });
    try {
      const unknown = { Authorization: "Bearer gho_never_issued" };
      expect((await fetch(`${strict.url}/user`, { headers: unknown })).status).toBe(401);
      expect((await fetch(`${permissive.url}/user`, { headers: unknown })).status).toBe(200);
      const minted = await strict.credentials.mint({ login: "admin" });
      const known = await fetch(`${strict.url}/user`, { headers: { Authorization: `Bearer ${minted.token}` } });
      expect(known.status).toBe(200);
      expect(((await known.json()) as { login: string }).login).toBe("admin");
    } finally {
      await strict.close();
      await permissive.close();
    }
  });
});
