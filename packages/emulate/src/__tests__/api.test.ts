import { describe, it, expect } from "vitest";
import { createEmulator } from "../api.js";

describe("createEmulator", () => {
  it("starts github and returns a url", async () => {
    const github = await createEmulator({ service: "github", port: 14000 });

    expect(github.url).toBe("http://localhost:14000");

    const res = await fetch(`${github.url}/user`, {
      headers: { Authorization: "token test_token_admin" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { login: string };
    expect(body.login).toBe("admin");

    await github.close();
  });

  it("starts github with the MCP OAuth metadata surface", async () => {
    const github = await createEmulator({ service: "github", port: 14001 });

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
    expect(metadataBody.authorization_grant_profiles_supported).toContain(
      "urn:ietf:params:oauth:grant-profile:id-jag",
    );

    await github.close();
  });

  it("starts the standalone MCP emulator", async () => {
    const mcp = await createEmulator({ service: "mcp", port: 14002 });

    const res = await fetch(`${mcp.url}/.well-known/oauth-authorization-server`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { registration_endpoint?: string };
    expect(body.registration_endpoint).toBe(`${mcp.url}/register`);

    await mcp.close();
  });

  it("starts multiple services independently", async () => {
    const [github, vercel] = await Promise.all([
      createEmulator({ service: "github", port: 14010 }),
      createEmulator({ service: "vercel", port: 14011 }),
    ]);

    expect(github.url).toBe("http://localhost:14010");
    expect(vercel.url).toBe("http://localhost:14011");

    await Promise.all([github.close(), vercel.close()]);
  });

  it("reset wipes and re-seeds stores", async () => {
    const github = await createEmulator({
      service: "github",
      port: 14020,
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
      port: 14030,
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
    const github = await createEmulator({ service: "github", port: 14040 });

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
    const spotify = await createEmulator({ service: "spotify", port: 14050 });

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

  it("creates AWS-style access keys through the control plane", async () => {
    const aws = await createEmulator({ service: "aws", port: 14060 });

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

  it("throws on unknown service", async () => {
    // @ts-expect-error testing invalid service name
    await expect(createEmulator({ service: "unknown-svc" })).rejects.toThrow("Unknown service");
  });
});
