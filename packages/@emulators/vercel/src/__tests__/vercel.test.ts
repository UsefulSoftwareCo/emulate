import { describe, it, expect, beforeEach } from "vitest";
import type { AddressInfo } from "node:net";
import { createServer, serve, type LedgerEntry } from "@emulators/core";
import { vercelPlugin, seedFromConfig } from "../index.js";
import { manifest } from "../manifest.js";

const base = "http://localhost:4000";

function createTestServer() {
  const server = createServer(vercelPlugin, {
    baseUrl: base,
    tokens: { "test-token": { login: "testuser", id: 1, scopes: ["user"] } },
    manifest,
  });
  const { store } = server;
  vercelPlugin.seed?.(store, base);
  seedFromConfig(store, base, {
    users: [{ username: "testuser", email: "testuser@example.com" }],
  });

  return server;
}

function authHeaders(): Record<string, string> {
  return { Authorization: "Bearer test-token" };
}

async function startHttpServer(app: ReturnType<typeof createTestServer>["app"]) {
  const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
  await new Promise<void>((resolve, reject) => {
    server.once("listening", () => resolve());
    server.once("error", reject);
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
        server.closeAllConnections();
      }),
  };
}

async function createDeployment(app: ReturnType<typeof createTestServer>["app"], name = `it-project-${Date.now()}`) {
  const res = await app.request(`${base}/v13/deployments`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as { id: string; projectId: string; url: string };
}

async function readRuntimeLogRows(res: Response, minRows: number): Promise<Array<Record<string, unknown>>> {
  expect(res.body).toBeTruthy();
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const rows: Array<Record<string, unknown>> = [];
  let buffer = "";
  let timeout: ReturnType<typeof setTimeout> | undefined;

  const deadline = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error("Timed out waiting for runtime log rows")), 2000);
  });

  try {
    while (rows.length < minRows) {
      const result = await Promise.race([reader.read(), deadline]);
      if (result.done) break;
      buffer += decoder.decode(result.value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim()) rows.push(JSON.parse(line) as Record<string, unknown>);
      }
    }
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    void reader.cancel().catch(() => {});
  }

  return rows;
}

describe("Vercel plugin integration", () => {
  let app: ReturnType<typeof createTestServer>["app"];

  beforeEach(() => {
    app = createTestServer().app;
  });

  it("GET /v2/user returns the current user", async () => {
    const res = await app.request(`${base}/v2/user`, { headers: authHeaders() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: { username: string; email: string } };
    expect(body.user).toBeDefined();
    expect(body.user.username).toBe("testuser");
    expect(body.user.email).toBe("testuser@example.com");
  });

  it("GET /v10/projects lists projects for the authenticated account", async () => {
    const res = await app.request(`${base}/v10/projects`, { headers: authHeaders() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { projects: unknown[]; pagination: unknown };
    expect(Array.isArray(body.projects)).toBe(true);
    expect(body.pagination).toBeDefined();
  });

  it("POST /v11/projects creates a project", async () => {
    const name = `it-project-${Date.now()}`;
    const res = await app.request(`${base}/v11/projects`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    expect([200, 201]).toContain(res.status);
    const body = (await res.json()) as { name: string; id: string };
    expect(body.name).toBe(name);
    expect(body.id).toBeDefined();
  });

  it("GET /v6/deployments returns deployments for the account", async () => {
    const res = await app.request(`${base}/v6/deployments`, { headers: authHeaders() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { deployments: unknown[]; pagination: unknown };
    expect(Array.isArray(body.deployments)).toBe(true);
    expect(body.pagination).toBeDefined();
  });

  it("GET /v1/projects/:projectId/deployments/:deploymentId/runtime-logs requires auth", async () => {
    const res = await app.request(`${base}/v1/projects/prj_missing/deployments/dpl_missing/runtime-logs`);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("not_authenticated");
  });

  it("GET /v1/projects/:projectId/deployments/:deploymentId/runtime-logs returns 404 for a bogus deployment", async () => {
    const deployment = await createDeployment(app);
    const res = await app.request(`${base}/v1/projects/${deployment.projectId}/deployments/dpl_missing/runtime-logs`, {
      headers: authHeaders(),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("not_found");
  });

  it("GET /v1/projects/:projectId/deployments/:deploymentId/runtime-logs streams runtime rows and records the ledger", async () => {
    const deployment = await createDeployment(app);
    const http = await startHttpServer(app);
    const abort = new AbortController();

    try {
      const res = await fetch(
        `${http.url}/v1/projects/${deployment.projectId}/deployments/${deployment.id}/runtime-logs`,
        {
          signal: abort.signal,
          headers: authHeaders(),
        },
      );

      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("application/stream+json");

      const rows = await readRuntimeLogRows(res, 3);
      expect(rows.length).toBeGreaterThanOrEqual(3);
      for (const row of rows.slice(0, 3)) {
        expect(row).toMatchObject({
          messageTruncated: false,
          source: "request",
          domain: deployment.url,
          requestMethod: "GET",
        });
        expect(typeof row.rowId).toBe("string");
        expect(typeof row.timestampInMs).toBe("number");
        expect(["info", "error", "warning", "debug", "trace", "fatal"]).toContain(row.level);
        expect(typeof row.message).toBe("string");
        expect(typeof row.requestPath).toBe("string");
        expect(typeof row.responseStatusCode).toBe("number");
      }
    } finally {
      abort.abort();
      await http.close();
    }

    const ledgerRes = await app.request(`${base}/_emulate/ledger`);
    const ledger = (await ledgerRes.json()) as { entries: LedgerEntry[] };
    const entry = ledger.entries.find((item) => item.path.endsWith("/runtime-logs"));
    expect(entry).toBeDefined();
    expect(entry?.response.status).toBe(200);
    expect(entry?.response.body).toBe("<streaming body omitted>");
  });
});
