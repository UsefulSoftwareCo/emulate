import { describe, it, expect } from "vitest";
import { Hono, Store, WebhookDispatcher, type TokenMap } from "@emulators/core";
import { mcpPlugin, setMcpScopeConfig, type McpScopeSource } from "./index.js";

const base = "http://localhost:4000";

// A registered MCP surface seeded with github defaults (the `admin` user is
// authorizable) and the default scope advertising, optionally overridden.
function createApp(scope?: { scopes?: string[]; scopeSource?: McpScopeSource }) {
  const store = new Store();
  const webhooks = new WebhookDispatcher();
  const tokenMap: TokenMap = new Map();
  const app = new Hono();
  mcpPlugin.register(app as never, store, webhooks, base, tokenMap);
  mcpPlugin.seed?.(store, base);
  if (scope) setMcpScopeConfig(store, scope);
  return { app, store, tokenMap };
}

async function getJson(app: Hono, path: string): Promise<Record<string, unknown>> {
  const res = await app.request(path);
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

const PR_PATHS = ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"];
const AS_PATHS = ["/.well-known/oauth-authorization-server", "/.well-known/oauth-authorization-server/mcp"];

describe("MCP OAuth scope discovery metadata", () => {
  it("defaults to advertising github scopes in both documents", async () => {
    const { app } = createApp();
    for (const path of PR_PATHS) {
      expect((await getJson(app, path)).scopes_supported).toEqual(["repo", "read:user"]);
    }
    for (const path of AS_PATHS) {
      expect((await getJson(app, path)).scopes_supported).toEqual(["repo", "read:user"]);
    }
  });

  it('source "resource": only the protected-resource metadata advertises scopes', async () => {
    const scopes = ["channels:history", "users:read"];
    const { app } = createApp({ scopes, scopeSource: "resource" });
    for (const path of PR_PATHS) {
      expect((await getJson(app, path)).scopes_supported).toEqual(scopes);
    }
    // The authorization-server metadata stays silent — the field is absent, not [].
    for (const path of AS_PATHS) {
      expect(await getJson(app, path)).not.toHaveProperty("scopes_supported");
    }
  });

  it('source "authorization-server": resource is silent, forcing the RFC 8414 fallback', async () => {
    const scopes = ["channels:history", "users:read"];
    const { app } = createApp({ scopes, scopeSource: "authorization-server" });
    // A discovering client reads the resource first; it must find no scopes here
    // and fall back to the authorization servers it names.
    for (const path of PR_PATHS) {
      expect(await getJson(app, path)).not.toHaveProperty("scopes_supported");
    }
    for (const path of AS_PATHS) {
      expect((await getJson(app, path)).scopes_supported).toEqual(scopes);
    }
    // The resource still names the authorization server the fallback reads.
    expect((await getJson(app, PR_PATHS[0])).authorization_servers).toEqual([base]);
  });

  it('source "none": neither document advertises scopes', async () => {
    const { app } = createApp({ scopes: ["repo"], scopeSource: "none" });
    for (const path of [...PR_PATHS, ...AS_PATHS]) {
      expect(await getJson(app, path)).not.toHaveProperty("scopes_supported");
    }
  });

  it("advertises an empty scope set as a present-but-empty list (authoritative, not silent)", async () => {
    const { app } = createApp({ scopes: [], scopeSource: "resource" });
    for (const path of PR_PATHS) {
      const body = await getJson(app, path);
      expect(body).toHaveProperty("scopes_supported");
      expect(body.scopes_supported).toEqual([]);
    }
  });
});

describe("MCP OAuth token honors the configured scopes", () => {
  it("falls back to the configured scopes when the client requested none", async () => {
    const scopes = ["channels:history", "users:read"];
    const { app } = createApp({ scopes, scopeSource: "authorization-server" });
    const redirectUri = "http://localhost:3000/cb";

    // Register a public client (no auth method -> PKCE-less, no client_secret).
    const reg = await app.request("/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: [redirectUri], client_name: "Test MCP client" }),
    });
    expect(reg.status).toBe(201);
    const clientId = ((await reg.json()) as { client_id: string }).client_id;

    // Approve as the seeded `admin` user, requesting NO scopes (the client
    // discovered them from metadata rather than baking them into the request).
    const approve = await app.request("/authorize/approve", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        state: "xyz",
        scope: "",
        login: "admin",
      }).toString(),
    });
    expect(approve.status).toBe(302);
    const code = new URL(approve.headers.get("location") ?? "").searchParams.get("code");
    expect(code).toBeTruthy();

    const token = await app.request("/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: code ?? "",
        redirect_uri: redirectUri,
        client_id: clientId,
      }).toString(),
    });
    expect(token.status).toBe(200);
    const body = (await token.json()) as { access_token: string; scope: string };
    expect(body.access_token).toMatch(/^mcp_/);
    expect(body.scope).toBe(scopes.join(" "));
  });
});
