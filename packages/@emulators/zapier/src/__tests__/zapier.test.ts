import { createHash, randomBytes } from "crypto";
import { createServer as createNet, type AddressInfo } from "net";
import { afterEach, describe, expect, it } from "vitest";
import { Client as LegacyClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport as LegacyTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  Client as ModernClient,
  StreamableHTTPClientTransport as ModernTransport,
  discoverOAuthServerInfo,
} from "@modelcontextprotocol/client";
import { createServer, serve } from "@emulators/core";
import { zapierPlugin, seedFromConfig, type ZapierSeedConfig } from "../index.js";
import { regenerateConnectionToken } from "../oauth.js";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const servers: Array<ReturnType<typeof serve>> = [];
const closers: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((f) => f().catch(() => {})));
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
});

async function freePort(): Promise<number> {
  const s = createNet();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const port = (s.address() as AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

const ADA = "ada@example.com";
const BOB = "bob@example.com";

async function start(seed: ZapierSeedConfig = {}) {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const emulator = createServer(zapierPlugin, { baseUrl: base });
  seedFromConfig(emulator.store, base, {
    accounts: [
      { email: ADA, name: "Ada", tools: { count: 3000 } },
      { email: BOB, name: "Bob", tools: { count: 40 } },
    ],
    ...seed,
  });
  const http = serve({ fetch: emulator.app.fetch, port });
  servers.push(http);
  await new Promise<void>((r) => (http.listening ? r() : http.once("listening", () => r())));
  const url = new URL(`${base}/api/v1/connect`);
  // One connection token per account: regenerating one revokes the last, as Zapier documents.
  const tokens = new Map<string, string>();
  const tokenFor = (email: string) => {
    if (!tokens.has(email)) tokens.set(email, regenerateConnectionToken(emulator.store, email).access_token);
    return tokens.get(email)!;
  };
  const legacy = async (email: string, version?: string) => {
    const client = new LegacyClient({ name: "legacy-test", version: "1.0.0" });
    const transport = new LegacyTransport(url, {
      requestInit: { headers: { Authorization: `Bearer ${tokenFor(email)}` } },
    });
    if (version)
      (client as unknown as { _supportedProtocolVersions?: string[] })._supportedProtocolVersions = [version];
    await client.connect(transport);
    closers.push(() => client.close());
    return client;
  };
  const modern = async (email: string, options: Record<string, unknown> = {}) => {
    const tok = tokenFor(email);
    const client = new ModernClient(
      { name: "modern-test", version: "1.0.0" },
      { versionNegotiation: { mode: { pin: "2026-07-28" } }, ...options },
    );
    const transport = new ModernTransport(url, { authProvider: { token: async () => tok } });
    await client.connect(transport);
    closers.push(() => client.close());
    return client;
  };
  const control = (path: string, body?: unknown) =>
    fetch(`${base}/_emulate/zapier${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  /** A raw modern request, headers mirrored from the body. */
  const rawModern = (token: string, method: string, params: Json = {}, overrides: Record<string, string> = {}) =>
    fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2026-07-28",
        "mcp-method": method,
        ...(method === "tools/call" ? { "mcp-name": String(params.name) } : {}),
        ...overrides,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method,
        params: {
          ...params,
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      }),
    });
  return { ...emulator, base, url, tokenFor, legacy, modern, control, rawModern };
}

async function listAll(client: {
  listTools: (p?: { cursor?: string }) => Promise<{ tools: Array<{ name: string }>; nextCursor?: string }>;
}) {
  const names: string[] = [];
  let cursor: string | undefined;
  let pages = 0;
  do {
    const page = await client.listTools(cursor ? { cursor } : undefined);
    names.push(...page.tools.map((t) => t.name));
    cursor = page.nextCursor;
    pages++;
  } while (cursor);
  return { names, pages };
}

describe("OAuth discovery and sign-in as Zapier publishes them", () => {
  it("answers an unauthenticated call with 401 and the resource metadata the SDK discovers", async () => {
    const { url, base } = await start();
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(
      `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/api/v1/connect"`,
    );
    expect((await fetch(`${base}/.well-known/oauth-protected-resource`)).status).toBe(404);
    const info = await discoverOAuthServerInfo(url);
    expect(info.authorizationServerUrl.replace(/\/$/, "")).toBe(base);
    expect(info.authorizationServerMetadata).toMatchObject({
      registration_endpoint: `${base}/api/v1/oauth/register`,
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
    });
  });

  it("registers a public client, signs a person in with S256 PKCE, and rotates refresh tokens", async () => {
    const { base, url } = await start();
    const reg = (await (
      await fetch(`${base}/api/v1/oauth/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_name: "test",
          redirect_uris: ["http://localhost:9/cb"],
          token_endpoint_auth_method: "none",
        }),
      })
    ).json()) as Json;
    expect(reg.client_secret).toBeUndefined();
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const params = {
      response_type: "code",
      client_id: reg.client_id,
      redirect_uri: "http://localhost:9/cb",
      scope: "openid profile email",
      state: "s",
      code_challenge: challenge,
      code_challenge_method: "S256",
      resource: url.toString(),
    };
    const page = await fetch(`${base}/oauth/authorize?${new URLSearchParams(params)}`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain(ADA);
    const approve = await fetch(`${base}/oauth/authorize`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ ...params, login: BOB }),
    });
    const code = new URL(approve.headers.get("location")!).searchParams.get("code")!;
    const tok = (await (
      await fetch(`${base}/api/v1/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: params.redirect_uri,
          code_verifier: verifier,
          client_id: reg.client_id,
        }),
      })
    ).json()) as Json;
    expect(tok).toMatchObject({ token_type: "Bearer", expires_in: 3600 });
    const client = new ModernClient(
      { name: "t", version: "1" },
      { versionNegotiation: { mode: { pin: "2026-07-28" } } },
    );
    await client.connect(new ModernTransport(url, { authProvider: { token: async () => tok.access_token } }));
    closers.push(() => client.close());
    expect((await client.listTools()).tools.length).toBe(40); // Bob's list
    const refreshed = (await (
      await fetch(`${base}/api/v1/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: tok.refresh_token,
          client_id: reg.client_id,
        }),
      })
    ).json()) as Json;
    expect(refreshed.access_token).not.toBe(tok.access_token);
    const replay = await fetch(`${base}/api/v1/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: tok.refresh_token,
        client_id: reg.client_id,
      }),
    });
    expect(replay.status).toBe(400);
  });
});

describe("tools/list and tools/call through the official SDKs, both protocol eras", () => {
  it("pages 3,000 tools with the 2025-11-25 SDK client and the 2026-07-28 client alike", async () => {
    const { legacy, modern } = await start();
    const l = await legacy(ADA);
    expect(l.getServerVersion()).toMatchObject({ name: "Zapier MCP (emulated)" });
    const a = await listAll(l);
    expect(a.names).toHaveLength(3000);
    expect(new Set(a.names).size).toBe(3000);
    expect(a.pages).toBe(30);
    const m = await modern(ADA);
    const b = await listAll(m);
    expect(b.names).toEqual(a.names);
    const first = await m.listTools();
    expect(first.tools[0]).toMatchObject({ inputSchema: { type: "object", required: ["instructions"] } });
  });

  it("speaks 2025-06-18 when a handshake-era client asks for it", async () => {
    const { legacy } = await start();
    const client = await legacy(BOB, "2025-06-18");
    expect((await client.listTools()).tools).toHaveLength(40);
  });

  it("answers calls deterministically, in both eras, and refuses another account's tool as unknown", async () => {
    const { legacy, modern } = await start();
    const bobTools = (await (await modern(BOB)).listTools()).tools;
    const adaFirstPage = (await (await modern(ADA)).listTools()).tools;
    const own = bobTools[0]!.name;
    const args = { instructions: "do it" };
    const l = await legacy(BOB);
    const m = await modern(BOB);
    const r1 = await l.callTool({ name: own, arguments: args });
    const r2 = await m.callTool({ name: own, arguments: args });
    expect(r1.isError).toBe(false);
    expect(r1.structuredContent).toEqual(r2.structuredContent);
    const foreign = adaFirstPage.find((t) => !bobTools.some((b) => b.name === t.name))!.name;
    await expect(m.callTool({ name: foreign, arguments: args })).rejects.toThrow(/Unknown tool/);
    await expect(l.callTool({ name: foreign, arguments: args })).rejects.toThrow(/Unknown tool/);
  });

  it("gives the same tools, schemas and results on two separate instances from the same seed", async () => {
    const one = await start();
    const two = await start();
    const toolsOne = (await (await one.modern(ADA)).listTools()).tools;
    const toolsTwo = (await (await two.modern(ADA)).listTools()).tools;
    expect(toolsTwo).toEqual(toolsOne);
    const call = async (s: Awaited<ReturnType<typeof start>>) =>
      (await (await s.modern(ADA)).callTool({ name: toolsOne[5]!.name, arguments: { instructions: "x" } }))
        .structuredContent;
    expect(await call(two)).toEqual(await call(one));
  });

  it("gives an unpaged request the first page and a cursor, or the whole list when page_size is 0", async () => {
    const { rawModern, tokenFor, control } = await start();
    const first = (await (await rawModern(tokenFor(ADA), "tools/list")).json()) as Json;
    expect(first.result.tools).toHaveLength(100);
    expect(typeof first.result.nextCursor).toBe("string");
    expect(first.result).toMatchObject({ resultType: "complete", cacheScope: "private" });
    await control("/settings", { page_size: 0 });
    const res = await rawModern(tokenFor(ADA), "tools/list");
    const all = (await res.json()) as Json;
    expect(all.result.tools).toHaveLength(3000);
    expect(all.result.nextCursor).toBeUndefined();
  });
});

describe("the 2026-07-28 binding's rules", () => {
  it("serves server/discover and rejects mismatched headers and unsupported versions", async () => {
    const { rawModern, tokenFor, modern } = await start();
    const tok = tokenFor(BOB);
    const discover = (await (await rawModern(tok, "server/discover")).json()) as Json;
    expect(discover.result).toMatchObject({
      resultType: "complete",
      supportedVersions: ["2026-07-28", "2025-11-25", "2025-06-18"],
    });
    expect((await (await modern(BOB)).discover()).supportedVersions).toContain("2026-07-28");
    const mismatch = await rawModern(tok, "tools/list", {}, { "mcp-method": "tools/call" });
    expect(mismatch.status).toBe(400);
    expect(((await mismatch.json()) as Json).error.code).toBe(-32020);
    const name = await rawModern(tok, "tools/call", { name: "a" }, { "mcp-name": "b" });
    expect(((await name.json()) as Json).error.code).toBe(-32020);
    const version = await rawModern(tok, "tools/list", {}, { "mcp-protocol-version": "1999-01-01" });
    expect(version.status).toBe(400);
    expect(((await version.json()) as Json).error).toMatchObject({ code: -32022, data: { requested: "1999-01-01" } });
    const unknown = await rawModern(tok, "resources/list");
    expect(unknown.status).toBe(404);
  });
});

describe("list changes", () => {
  it("changes one account's list silently by default, invalidates old cursors, and records the change in the ledger", async () => {
    const { modern, control, ledger } = await start();
    const m = await modern(BOB);
    const before = (await m.listTools()).tools.map((t) => t.name);
    const res = (await (
      await control(`/accounts/${encodeURIComponent(BOB)}/tools`, {
        add: 2,
        remove: [before[0]],
        rename: { [before[1]!]: "renamed_tool" },
      })
    ).json()) as Json;
    expect(res).toMatchObject({ tools: 41, notified_streams: 0 });
    const after = (await m.listTools()).tools.map((t) => t.name);
    expect(after).not.toContain(before[0]);
    expect(after).toContain("renamed_tool");
    expect(after).toHaveLength(41);
    await expect(m.callTool({ name: before[1]!, arguments: {} })).rejects.toThrow(/Unknown tool/);
    const entry = ledger.list().find((e) => e.operationId === "zapier.control.tools.change")!;
    expect(entry.identity.user?.login).toBe(BOB);
    expect(entry.summary).toContain("+3 -2 renamed 1");
  });

  it("refuses a cursor issued before a change", async () => {
    const { rawModern, tokenFor, control } = await start();
    const tok = tokenFor(ADA);
    const first = (await (await rawModern(tok, "tools/list")).json()) as Json;
    await control(`/accounts/${encodeURIComponent(ADA)}/tools`, { add: 1 });
    const stale = (await (await rawModern(tok, "tools/list", { cursor: first.result.nextCursor })).json()) as Json;
    expect(stale.error).toMatchObject({ code: -32602 });
  });

  it("announces a change on a 2026-07-28 listen stream and on a 2025-11-25 stream when the emulator switch is on", async () => {
    const { modern, legacy, control } = await start({ settings: { list_changed: true } });
    const m = await modern(BOB);
    const seen: string[] = [];
    const sub = await m.listen({ toolsListChanged: true });
    expect(sub.honoredFilter).toEqual({ toolsListChanged: true });
    m.setNotificationHandler("notifications/tools/list_changed", async () => {
      seen.push("modern");
    });
    const l = await legacy(BOB);
    l.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
      seen.push("legacy");
    });
    await new Promise((r) => setTimeout(r, 300));
    const res = (await (await control(`/accounts/${encodeURIComponent(BOB)}/tools`, { add: 1 })).json()) as Json;
    expect(res.notified_streams).toBeGreaterThanOrEqual(2);
    await new Promise((r) => setTimeout(r, 300));
    expect(seen.sort()).toEqual(["legacy", "modern"]);
    await sub.close();
  });

  it("acknowledges a listen with an empty filter and ends it when the switch is off", async () => {
    const { modern } = await start();
    const sub = await (await modern(BOB)).listen({ toolsListChanged: true });
    expect(sub.honoredFilter).toEqual({});
  });
});

describe("tool behaviours, limits and the ledger", () => {
  it("makes a tool slow, fail, or return a large result", async () => {
    const { modern, control } = await start();
    const m = await modern(BOB);
    const [slow, failing, broken, big] = (await m.listTools()).tools.map((t) => t.name);
    const set = (tool: string, b: Json) => control(`/accounts/${encodeURIComponent(BOB)}/behaviors`, { tool, ...b });
    await set(slow!, { delay_ms: 400 });
    await set(failing!, { fail: "tool" });
    await set(broken!, { fail: "protocol" });
    await set(big!, { result_bytes: 2 * 1024 * 1024 });
    const t0 = Date.now();
    await m.callTool({ name: slow!, arguments: {} });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(390);
    expect((await m.callTool({ name: failing!, arguments: {} })).isError).toBe(true);
    await expect(m.callTool({ name: broken!, arguments: {} })).rejects.toThrow(/Internal error/);
    const large = await m.callTool({ name: big!, arguments: {} });
    expect(String((large.structuredContent as Json).data)).toHaveLength(2 * 1024 * 1024);
  });

  it("limits one account with a 429 and Retry-After while another goes on (emulator control)", async () => {
    const { rawModern, tokenFor, control, ledger } = await start();
    const set = (await (
      await control("/settings", { rate_limit: { requests: 2, window_seconds: 60 } })
    ).json()) as Json;
    expect(set.note).toMatch(/emulator control/);
    const ada = tokenFor(ADA);
    expect((await rawModern(ada, "tools/list")).status).toBe(200);
    expect((await rawModern(ada, "tools/list")).status).toBe(200);
    const limited = await rawModern(ada, "tools/list");
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await rawModern(tokenFor(BOB), "tools/list")).status).toBe(200);
    const lists = ledger
      .list()
      .reverse()
      .filter((e) => e.operationId === "zapier.mcp.tools/list")
      .map((e) => [e.identity.user?.login, e.response.status]);
    expect(lists).toEqual([
      [ADA, 200],
      [ADA, 200],
      [ADA, 429],
      [BOB, 200],
    ]);
  });

  it("records which account listed and called what", async () => {
    const { modern, ledger, control } = await start();
    const m = await modern(BOB);
    const name = (await m.listTools()).tools[3]!.name;
    await m.callTool({ name, arguments: { instructions: "go" } });
    const call = ledger.list().find((e) => e.operationId === "zapier.mcp.tools/call")!;
    expect(call.identity.user?.login).toBe(BOB);
    expect(call.sideEffects.map((s) => s.summary)).toEqual([`tools/call ${name} -> result`]);
    const usage = (await (await control("/usage")).json()) as Json;
    expect(usage.accounts[BOB].calls[name]).toBe(1);
  });
});
