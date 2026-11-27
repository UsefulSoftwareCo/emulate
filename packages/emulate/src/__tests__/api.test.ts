import { describe, it, expect } from "vitest";
import { createEmulator } from "../api.js";

describe("createEmulator", () => {
  // The first test in the suite pays the cold-start plugin import cost, which
  // can exceed the default 5s on CI runners (it hit 2.9s on a green run).
  it("starts github and returns a url", { timeout: 15000 }, async () => {
    const github = await createEmulator({ service: "github", port: 0 });

    expect(github.port).toBeGreaterThan(0);
    expect(github.url).toBe(`http://localhost:${github.port}`);

    const res = await fetch(`${github.url}/user`, {
      headers: { Authorization: "token test_token_admin" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { login: string };
    expect(body.login).toBe("admin");

    await github.close();
  });

  it("starts github with the MCP OAuth metadata surface", async () => {
    const github = await createEmulator({ service: "github", port: 0 });

    const resource = await fetch(`${github.url}/.well-known/oauth-protected-resource/mcp`);
    expect(resource.status).toBe(200);
    const resourceBody = (await resource.json()) as {
      resource: string;
      authorization_servers: string[];
    };
    expect(resourceBody).toMatchObject({
      resource: `${github.url}/mcp`,
      authorization_servers: [github.url],
    });

    const metadata = await fetch(`${github.url}/.well-known/oauth-authorization-server`);
    expect(metadata.status).toBe(200);
    const metadataBody = (await metadata.json()) as {
      authorization_grant_profiles_supported?: string[];
    };
    expect(metadataBody.authorization_grant_profiles_supported).toContain("urn:ietf:params:oauth:grant-profile:id-jag");

    await github.close();
  });

  it("starts the standalone MCP emulator", async () => {
    const mcp = await createEmulator({ service: "mcp", port: 0 });

    const res = await fetch(`${mcp.url}/.well-known/oauth-authorization-server`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { registration_endpoint?: string };
    expect(body.registration_endpoint).toBe(`${mcp.url}/register`);

    await mcp.close();
  });

  it("starts multiple services independently", async () => {
    const [github, vercel] = await Promise.all([
      createEmulator({ service: "github", port: 0 }),
      createEmulator({ service: "vercel", port: 0 }),
    ]);

    expect(github.port).toBeGreaterThan(0);
    expect(github.url).toBe(`http://localhost:${github.port}`);
    expect(vercel.port).toBeGreaterThan(0);
    expect(vercel.url).toBe(`http://localhost:${vercel.port}`);

    await Promise.all([github.close(), vercel.close()]);
  });

  it("reset wipes and re-seeds stores", async () => {
    const github = await createEmulator({
      service: "github",
      port: 0,
      seed: { github: { users: [{ login: "test-user" }] } },
    });

    const createRes = await fetch(`${github.url}/user/repos`, {
      method: "POST",
      headers: {
        Authorization: "token test_token_admin",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: "my-repo", private: false }),
    });
    expect(createRes.status).toBe(201);

    github.reset();

    const listRes = await fetch(`${github.url}/user/repos`, {
      headers: { Authorization: "token test_token_admin" },
    });
    expect(listRes.status).toBe(200);
    const repos = (await listRes.json()) as unknown[];
    expect(repos).toHaveLength(0);

    await github.close();
  });

  it("does not grant Slack fallback scopes in strict mode", async () => {
    const slack = await createEmulator({
      service: "slack",
      port: 0,
      seed: { slack: { strict_scopes: true } },
    });

    const res = await fetch(`${slack.url}/api/chat.postMessage`, {
      method: "POST",
      headers: {
        Authorization: "Bearer arbitrary-slack-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ channel: "C000000001", text: "strict fallback" }),
    });
    const body = (await res.json()) as { ok: boolean; error: string; needed: string; provided: string };
    expect(body).toMatchObject({
      ok: false,
      error: "missing_scope",
      needed: "chat:write",
      provided: "",
    });

    await slack.close();
  });

  it("creates GitHub bearer credentials through the control plane", async () => {
    const github = await createEmulator({ service: "github", port: 0 });

    const credentialRes = await fetch(`${github.url}/_emulate/credentials`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "bearer-token", login: "agent-user", scopes: ["repo", "user"] }),
    });
    expect(credentialRes.status).toBe(200);
    const credentialBody = (await credentialRes.json()) as { credential: { token: string } };

    const userRes = await fetch(`${github.url}/user`, {
      headers: { Authorization: `Bearer ${credentialBody.credential.token}` },
    });
    expect(userRes.status).toBe(200);
    const user = (await userRes.json()) as { login: string };
    expect(user.login).toBe("agent-user");

    await github.close();
  });

  it("creates Spotify client credentials and exchanges them for an app token", async () => {
    const spotify = await createEmulator({ service: "spotify", port: 0 });

    const credentialRes = await fetch(`${spotify.url}/_emulate/credentials`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "oauth-client-credentials", name: "Catalog Test" }),
    });
    expect(credentialRes.status).toBe(200);
    const credentialBody = (await credentialRes.json()) as {
      credential: { client_id: string; client_secret: string; token_url: string };
    };

    const basic = Buffer.from(
      `${credentialBody.credential.client_id}:${credentialBody.credential.client_secret}`,
    ).toString("base64");
    const tokenRes = await fetch(credentialBody.credential.token_url, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
    });
    expect(tokenRes.status).toBe(200);
    const token = (await tokenRes.json()) as { access_token: string; token_type: string };
    expect(token.access_token).toBeTruthy();
    expect(token.token_type).toBe("Bearer");

    await spotify.close();
  });

  it("injects a one-shot fault into a real service emulator", async () => {
    const spotify = await createEmulator({ service: "spotify", port: 0 });

    const credential = await spotify.credentials.mint({ type: "oauth-client-credentials", name: "Fault Test" });
    const basic = Buffer.from(`${credential.client_id}:${credential.client_secret}`).toString("base64");
    const tokenRes = await fetch(`${spotify.url}/api/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
    });
    const token = (await tokenRes.json()) as { access_token: string };

    const fault = await spotify.faults.arm({
      match: { operationId: "search" },
      response: { status: 503, body: { error: { message: "planned outage" } } },
    });
    expect((await spotify.faults.list()).map((f) => f.id)).toContain(fault.id);

    const searchUrl = `${spotify.url}/v1/search?q=daft&type=artist`;
    const faulted = await fetch(searchUrl, { headers: { Authorization: `Bearer ${token.access_token}` } });
    expect(faulted.status).toBe(503);
    expect(await faulted.json()).toEqual({ error: { message: "planned outage" } });

    const ledger = await spotify.ledger.list();
    expect(ledger[0]).toMatchObject({
      path: "/v1/search",
      operationId: "search",
      response: { status: 503 },
      faulted: true,
      faultId: fault.id,
    });

    const normal = await fetch(searchUrl, { headers: { Authorization: `Bearer ${token.access_token}` } });
    expect(normal.status).toBe(200);
    const normalBody = (await normal.json()) as { artists: { items: unknown[] } };
    expect(normalBody.artists.items.length).toBeGreaterThan(0);
    expect(await spotify.faults.list()).toHaveLength(0);

    const cleared = await spotify.faults.arm({
      match: { method: "GET", pathPattern: "/v1/search" },
      response: { status: 429 },
    });
    await spotify.faults.clear(cleared.id);
    expect(await spotify.faults.list()).toHaveLength(0);

    await spotify.faults.arm({ match: { method: "GET", pathPattern: "/v1/*" }, response: { status: 500 } });
    await spotify.faults.clear();
    expect(await spotify.faults.list()).toHaveLength(0);

    await spotify.close();
  });

  it("creates Microsoft OAuth client credentials and exchanges them for a Graph app token", async () => {
    const microsoft = await createEmulator({ service: "microsoft", port: 0 });

    const credentialRes = await fetch(`${microsoft.url}/_emulate/credentials`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "oauth-client-credentials", name: "Graph App" }),
    });
    expect(credentialRes.status).toBe(200);
    const credentialBody = (await credentialRes.json()) as {
      credential: { client_id: string; client_secret: string; token_url: string };
    };

    const tokenRes = await fetch(credentialBody.credential.token_url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: credentialBody.credential.client_id,
        client_secret: credentialBody.credential.client_secret,
        scope: "https://graph.microsoft.com/.default",
      }),
    });
    expect(tokenRes.status).toBe(200);
    const token = (await tokenRes.json()) as { access_token: string; token_type: string; scope: string };
    expect(token.access_token).toBeTruthy();
    expect(token.token_type).toBe("Bearer");
    expect(token.scope).toBe("https://graph.microsoft.com/.default");

    const usersRes = await fetch(`${microsoft.url}/v1.0/users`, {
      headers: { Authorization: `Bearer ${token.access_token}` },
    });
    expect(usersRes.status).toBe(200);

    const meRes = await fetch(`${microsoft.url}/v1.0/me`, {
      headers: { Authorization: `Bearer ${token.access_token}` },
    });
    expect(meRes.status).toBe(403);

    await microsoft.close();
  });

  it("creates AWS-style access keys through the control plane", async () => {
    const aws = await createEmulator({ service: "aws", port: 0 });

    const credentialRes = await fetch(`${aws.url}/_emulate/credentials`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ login: "ci-user" }),
    });
    expect(credentialRes.status).toBe(200);
    const credentialBody = (await credentialRes.json()) as {
      credential: { type: string; access_key_id: string; secret_access_key: string; region: string };
    };
    expect(credentialBody.credential).toMatchObject({
      type: "provider-specific",
      region: "us-east-1",
    });
    expect(credentialBody.credential.access_key_id).toMatch(/^AKIA/);
    expect(credentialBody.credential.secret_access_key).toBeTruthy();

    await aws.close();
  });

  it("listens on a free loopback port and reports it", async () => {
    const [first, second] = await Promise.all([
      createEmulator({ service: "github", port: 0, hostname: "127.0.0.1" }),
      createEmulator({ service: "github", port: 0, hostname: "127.0.0.1" }),
    ]);

    expect(first.port).toBeGreaterThan(0);
    expect(first.port).not.toBe(second.port);
    expect(first.url).toBe(`http://127.0.0.1:${first.port}`);

    // Listening as soon as createEmulator resolves, with no retry.
    const res = await fetch(`${first.url}/user`, { headers: { Authorization: "token test_token_admin" } });
    expect(res.status).toBe(200);

    // Seeded URLs use the bound port, not 0.
    const metadata = await fetch(`${first.url}/.well-known/oauth-authorization-server`);
    expect(((await metadata.json()) as { issuer: string }).issuer).toBe(first.url);

    await Promise.all([first.close(), second.close()]);
  });

  it("names an IPv6 listen address in brackets", async () => {
    const github = await createEmulator({ service: "github", port: 0, hostname: "::1" });
    expect(github.url).toBe(`http://[::1]:${github.port}`);
    const res = await fetch(`${github.url}/user`, { headers: { Authorization: "token test_token_admin" } });
    expect(res.status).toBe(200);
    await github.close();
  });

  it("keeps localhost in the URL when listening on every interface", async () => {
    const github = await createEmulator({ service: "github", port: 0, hostname: "0.0.0.0" });
    expect(github.url).toBe(`http://localhost:${github.port}`);
    await github.close();
  });

  it("binds only the address asked for", async () => {
    const github = await createEmulator({ service: "github", port: 0, hostname: "127.0.0.1" });
    await expect(fetch(`http://[::1]:${github.port}/user`)).rejects.toThrow();
    await github.close();
  });

  it("keeps an explicit baseUrl with port 0", async () => {
    const github = await createEmulator({ service: "github", port: 0, baseUrl: "https://github.example.test" });
    expect(github.url).toBe("https://github.example.test");
    expect(github.port).toBeGreaterThan(0);
    await github.close();
  });

  it("rejects when the port is taken, instead of failing after it resolves", async () => {
    const held = await createEmulator({ service: "github", port: 0, hostname: "127.0.0.1" });
    await expect(createEmulator({ service: "github", port: held.port, hostname: "127.0.0.1" })).rejects.toThrow(
      /EADDRINUSE/,
    );
    await held.close();
  });

  it("releases the port when setup fails", async () => {
    const probe = await createEmulator({ service: "github", port: 0, hostname: "127.0.0.1" });
    const port = probe.port;
    await probe.close();
    await expect(
      createEmulator({
        service: "github",
        port,
        hostname: "127.0.0.1",
        seed: { github: { users: 5 } },
      }),
    ).rejects.toThrow();
    const again = await createEmulator({ service: "github", port, hostname: "127.0.0.1" });
    await again.close();
  });

  it("tells in-process listeners about each handled provider request", async () => {
    const resend = await createEmulator({ service: "resend", port: 0, hostname: "127.0.0.1" });
    const seen: Array<{ method: string; path: string; status: number }> = [];
    const stop = resend.onRequest((entry) =>
      seen.push({ method: entry.method, path: entry.path, status: entry.response.status }),
    );

    const sent = await fetch(`${resend.url}/emails`, {
      method: "POST",
      headers: { Authorization: "Bearer re_test", "Content-Type": "application/json" },
      body: JSON.stringify({ from: "a@example.com", to: ["b@example.com"], subject: "Hi", text: "Hello" }),
    });
    expect(sent.status).toBe(200);
    expect(seen).toEqual([{ method: "POST", path: "/emails", status: 200 }]);

    // State is visible by the time the listener runs; control-plane calls are not reported.
    const state = (await resend.state()) as { collections: Record<string, { items: unknown[] }> };
    expect(state.collections["resend.emails"]?.items).toHaveLength(1);
    expect(seen).toHaveLength(1);

    stop();
    await fetch(`${resend.url}/emails`, { headers: { Authorization: "Bearer re_test" } });
    expect(seen).toHaveLength(1);

    await resend.close();
  });

  it("throws on unknown service", async () => {
    // @ts-expect-error testing invalid service name
    await expect(createEmulator({ service: "unknown-svc" })).rejects.toThrow("Unknown service");
  });
});
