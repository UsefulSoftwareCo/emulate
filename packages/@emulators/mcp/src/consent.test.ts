import { describe, expect, it } from "vitest";
import { Hono, Store, WebhookDispatcher, type TokenMap } from "@emulators/core";
import type { McpAuthMode } from "./auth.js";
import { mcpPlugin, seedFromConfig } from "./index.js";

const base = "http://localhost:4000";
const redirectUri = "http://localhost:3000/callback";

function createApp(auth?: McpAuthMode) {
  const store = new Store();
  const tokenMap: TokenMap = new Map();
  const app = new Hono();
  mcpPlugin.register(app as never, store, new WebhookDispatcher(), base, tokenMap);
  mcpPlugin.seed?.(store, base);
  if (auth) seedFromConfig(store, base, { auth });
  return app;
}

async function consentPage(app: Hono, state: string): Promise<string> {
  const registered = await app.request("/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      redirect_uris: [redirectUri],
      client_name: "Consent test",
      token_endpoint_auth_method: "none",
    }),
  });
  const { client_id } = (await registered.json()) as { client_id: string };
  const params = new URLSearchParams({ client_id, redirect_uri: redirectUri, response_type: "code", state });
  const page = await app.request(`/authorize?${params}`);
  expect(page.status).toBe(200);
  return page.text();
}

// What a browser sends: exactly the fields inside the chosen user's form.
function firstUserForm(html: string): { action: string; fields: URLSearchParams } {
  const form = /<form class="user-form" method="post" action="([^"]+)">([\s\S]*?)<\/form>/.exec(html);
  expect(form).not.toBeNull();
  const fields = new URLSearchParams();
  for (const input of form![2].matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)"\/>/g))
    fields.set(input[1], input[2].replaceAll("&amp;", "&"));
  return { action: form![1], fields };
}

describe("consent page", () => {
  it("approving as a user submits that user and returns a code", async () => {
    const app = createApp();
    const { action, fields } = firstUserForm(await consentPage(app, "chosen-user"));
    expect(fields.get("login")).toBeTruthy();
    const approved = await app.request(new URL(action).pathname, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: fields.toString(),
    });
    expect(approved.status).toBe(302);
    const returned = new URL(approved.headers.get("location")!);
    expect(returned.searchParams.get("code")).toBeTruthy();
    expect(returned.searchParams.get("state")).toBe("chosen-user");
  });

  it("Deny returns access_denied with the state and no code", async () => {
    const app = createApp();
    const href = /class="deny-btn" href="([^"]+)"/
      .exec(await consentPage(app, "declined"))?.[1]
      ?.replaceAll("&amp;", "&");
    const denied = new URL(href!);
    expect(`${denied.origin}${denied.pathname}`).toBe(redirectUri);
    expect(denied.searchParams.get("error")).toBe("access_denied");
    expect(denied.searchParams.get("state")).toBe("declined");
    expect(denied.searchParams.has("code")).toBe(false);
  });
});

describe("auth: none", () => {
  const list = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} };
  const post = (app: Hono) =>
    app.request("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(list),
    });

  it("serves the tools with no sign-in", async () => {
    const response = await post(createApp("none"));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { result: { tools: Array<{ name: string }> } };
    expect(body.result.tools.map((tool) => tool.name)).toContain("get_me");
  });

  it("still asks for sign-in in the default mode", async () => {
    expect((await post(createApp())).status).toBe(401);
  });
});
