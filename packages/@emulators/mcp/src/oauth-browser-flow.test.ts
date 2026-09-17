import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, serve } from "@emulators/core";
import { mcpPlugin, seedFromConfig } from "./index.js";

const PORT = 41885;
const BASE_URL = `http://localhost:${PORT}`;
const REDIRECT_URI = "http://127.0.0.1:9/callback";

let server: ReturnType<typeof serve>;

beforeAll(() => {
  const mcp = createServer(mcpPlugin, {
    port: PORT,
    baseUrl: BASE_URL,
    fallbackUser: { login: "admin", id: 1, scopes: [] },
  });
  seedFromConfig(mcp.store, BASE_URL, {
    auth: "oauth",
    users: [{ login: "admin", name: "Administrator" }],
  });
  server = serve({ fetch: mcp.app.fetch, port: PORT });
});

afterAll(
  () =>
    new Promise<void>((resolve) => {
      server.close(() => resolve());
    }),
);

const hiddenFields = (html: string) =>
  Object.fromEntries(
    [...html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)"\/>/gu)].map(([, name, value]) => [
      name!,
      value!,
    ]),
  );

const authorizePage = async () => {
  const registration = await fetch(`${BASE_URL}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "Executor test",
      redirect_uris: [REDIRECT_URI],
    }),
  });
  expect(registration.status).toBe(201);
  const client = (await registration.json()) as { client_id: string };

  const authorize = new URL(`${BASE_URL}/authorize`);
  authorize.searchParams.set("client_id", client.client_id);
  authorize.searchParams.set("redirect_uri", REDIRECT_URI);
  authorize.searchParams.set("state", "browser-state");
  const response = await fetch(authorize);
  expect(response.status).toBe(200);
  return response.text();
};

const submitSelection = (fields: Record<string, string>) =>
  fetch(`${BASE_URL}/authorize/approve`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields),
    redirect: "manual",
  });

describe("MCP OAuth browser user selection", () => {
  it("submits the selected login and redirects to the client", async () => {
    const fields = hiddenFields(await authorizePage());
    expect(fields.login).toBe("admin");

    const approval = await submitSelection(fields);
    expect(approval.status).toBe(302);
    const callback = new URL(approval.headers.get("location") ?? "");
    expect(callback.origin + callback.pathname).toBe(REDIRECT_URI);
    expect(callback.searchParams.get("state")).toBe("browser-state");
    expect(callback.searchParams.get("code")).toBeTruthy();
  });

  it("keeps recovery user buttons submittable after an unknown login", async () => {
    const fields = hiddenFields(await authorizePage());
    const rejected = await submitSelection({ ...fields, login: "missing'; touch /tmp/not-safe; #" });
    expect(rejected.status).toBe(400);

    const recoveryHtml = await rejected.text();
    expect(recoveryHtml).toContain("missing'\\''; touch /tmp/not-safe; #");
    const recoveryFields = hiddenFields(recoveryHtml);
    expect(recoveryFields.login).toBe("admin");
    const approval = await submitSelection(recoveryFields);
    expect(approval.status).toBe(302);
  });
});
