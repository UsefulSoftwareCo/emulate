import { createServer as createHttpServer, type IncomingHttpHeaders, type Server } from "http";
import { afterEach, describe, expect, it } from "vitest";
import { createRemoteJWKSet, customFetch, jwtVerify } from "jose";
import { createServer, type TokenMap } from "@emulators/core";
import { googlePlugin, seedFromConfig, type GoogleSeedConfig } from "../index.js";
import { buildRawMessage } from "../helpers.js";

const base = "http://localhost:4000";
const USER = "inbox@example.com";
type Json = Record<string, any>;

function setup(extra: Partial<GoogleSeedConfig> = {}) {
  const server = createServer(googlePlugin, {
    baseUrl: base,
    tokens: { "user-token": { login: USER, id: 1, scopes: ["https://www.googleapis.com/auth/gmail.modify"] } },
  });
  googlePlugin.seed?.(server.store, base);
  seedFromConfig(server.store, base, {
    users: [{ email: USER, name: "Inbox User" }],
    oauth_clients: [
      {
        client_id: "gmail-client",
        client_secret: "gmail-secret/with+chars",
        redirect_uris: ["http://localhost:3000/callback"],
      },
    ],
    ...extra,
  });
  (server.tokenMap as TokenMap).set("user-token", { login: USER, id: 1, scopes: [] });
  const call = (path: string, init: RequestInit = {}) =>
    server.app.request(`${base}${path}`, {
      ...init,
      headers: {
        Authorization: "Bearer user-token",
        ...(typeof init.body === "string" ? { "Content-Type": "application/json" } : {}),
        ...(init.headers as Record<string, string> | undefined),
      },
    });
  const control = (path: string, body?: unknown) =>
    server.app.request(`${base}/_emulate/google${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  return { ...server, call, control };
}

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

async function receiver(): Promise<{ url: string; received: Array<{ headers: IncomingHttpHeaders; body: string }> }> {
  const received: Array<{ headers: IncomingHttpHeaders; body: string }> = [];
  const server = createHttpServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      received.push({ headers: req.headers, body });
      res.writeHead(204);
      res.end();
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}/push`, received };
}

describe("users.getProfile", () => {
  it("returns the mailbox address, totals and current historyId", async () => {
    const { call } = setup({
      messages: [
        { user_email: USER, from: "a@example.com", to: USER, subject: "one", thread_id: "t1" },
        { user_email: USER, from: "a@example.com", to: USER, subject: "two", thread_id: "t1" },
        { user_email: USER, from: "b@example.com", to: USER, subject: "three" },
      ],
    });
    const res = await call("/gmail/v1/users/me/profile");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Json;
    expect(body).toMatchObject({ emailAddress: USER, messagesTotal: 3, threadsTotal: 2 });
    expect(body.historyId).toMatch(/^[0-9]+$/);
    expect((await call("/gmail/v1/users/someone-else@example.com/profile")).status).toBe(404);
  });
});

describe("message headers", () => {
  const listHeaders = [
    { name: "List-Id", value: "Weekly News <news.lists.example.com>" },
    { name: "List-Unsubscribe", value: "<mailto:unsubscribe@example.com>, <https://example.com/unsub>" },
    { name: "List-Unsubscribe-Post", value: "List-Unsubscribe=One-Click" },
  ];

  it("returns List-Id and List-Unsubscribe in full and metadata for a raw-imported message", async () => {
    const raw = Buffer.from(
      [
        "From: News <news@example.com>",
        `To: ${USER}`,
        "Subject: This week",
        ...listHeaders.map((h) => `${h.name}: ${h.value}`),
        "MIME-Version: 1.0",
        "Content-Type: text/plain; charset=utf-8",
        "",
        "Hello",
      ].join("\r\n"),
    ).toString("base64url");
    const { call } = setup();
    const inserted = (await (
      await call("/gmail/v1/users/me/messages/import", { method: "POST", body: JSON.stringify({ raw }) })
    ).json()) as Json;
    const full = (await (await call(`/gmail/v1/users/me/messages/${inserted.id}?format=full`)).json()) as Json;
    for (const h of listHeaders) expect(full.payload.headers).toContainEqual(h);
    const meta = (await (
      await call(
        `/gmail/v1/users/me/messages/${inserted.id}?format=metadata&metadataHeaders=List-Unsubscribe&metadataHeaders=subject`,
      )
    ).json()) as Json;
    expect(meta.payload.headers).toEqual([
      { name: "Subject", value: "This week" },
      { name: "List-Unsubscribe", value: listHeaders[1]!.value },
    ]);
  });

  it("writes seeded headers into the raw message and finds the mail with list:", async () => {
    const { call } = setup({
      messages: [
        { user_email: USER, from: "news@example.com", to: USER, subject: "list mail", headers: listHeaders },
        { user_email: USER, from: "friend@example.com", to: USER, subject: "personal" },
      ],
    });
    const found = (await (
      await call(`/gmail/v1/users/me/messages?q=${encodeURIComponent("list:news.lists.example.com")}`)
    ).json()) as Json;
    expect(found.messages).toHaveLength(1);
    const msg = (await (await call(`/gmail/v1/users/me/messages/${found.messages[0].id}?format=raw`)).json()) as Json;
    const decoded = Buffer.from(msg.raw, "base64url").toString("utf8");
    expect(decoded).toContain("List-Id: Weekly News <news.lists.example.com>");
    const none = (await (
      await call(`/gmail/v1/users/me/messages?q=${encodeURIComponent("list:other.example.com")}`)
    ).json()) as Json;
    expect(none.messages ?? []).toHaveLength(0);
    // buildRawMessage stays usable without extra headers.
    expect(buildRawMessage({ from: "a", to: "b", subject: "s" })).toBeTruthy();
  });
});

describe("token endpoint client authentication", () => {
  async function code(app: ReturnType<typeof setup>["app"]) {
    const res = await app.request(`${base}/o/oauth2/v2/auth/callback`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        email: USER,
        redirect_uri: "http://localhost:3000/callback",
        scope: "openid email",
        client_id: "gmail-client",
      }).toString(),
    });
    return new URL(res.headers.get("Location")!).searchParams.get("code")!;
  }
  const form = (body: Record<string, string>, headers: Record<string, string> = {}) => ({
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams(body).toString(),
  });
  const basic = (id: string, secret: string) =>
    "Basic " + Buffer.from(`${encodeURIComponent(id)}:${encodeURIComponent(secret)}`).toString("base64");

  it("accepts client_secret_basic, as the discovery document advertises", async () => {
    const { app } = setup();
    const discovery = (await (await app.request(`${base}/.well-known/openid-configuration`)).json()) as Json;
    expect(discovery.token_endpoint_auth_methods_supported).toContain("client_secret_basic");
    const res = await app.request(
      `${base}/oauth2/token`,
      form(
        { grant_type: "authorization_code", code: await code(app), redirect_uri: "http://localhost:3000/callback" },
        { Authorization: basic("gmail-client", "gmail-secret/with+chars") },
      ),
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as Json).access_token).toBeTruthy();
  });

  it("still accepts client_secret_post and refuses a wrong Basic secret", async () => {
    const { app } = setup();
    const post = await app.request(
      `${base}/oauth2/token`,
      form({
        grant_type: "authorization_code",
        code: await code(app),
        redirect_uri: "http://localhost:3000/callback",
        client_id: "gmail-client",
        client_secret: "gmail-secret/with+chars",
      }),
    );
    expect(post.status).toBe(200);
    const wrong = await app.request(
      `${base}/oauth2/token`,
      form(
        { grant_type: "authorization_code", code: await code(app), redirect_uri: "http://localhost:3000/callback" },
        { Authorization: basic("gmail-client", "nope") },
      ),
    );
    expect(wrong.status).toBe(401);
  });
});

describe("Gmail push notifications", () => {
  async function watched(extra: Partial<GoogleSeedConfig> = {}) {
    const r = await receiver();
    const env = setup({
      pubsub_push_subscriptions: [
        {
          name: "projects/demo/subscriptions/gmail-push",
          topic: "projects/demo/topics/gmail",
          push_endpoint: r.url,
          audience: "https://app.example.test/push",
        },
      ],
      ...extra,
    });
    const watch = await env.call("/gmail/v1/users/me/watch", {
      method: "POST",
      body: JSON.stringify({
        topicName: "projects/demo/topics/gmail",
        labelIds: ["INBOX"],
        labelFilterBehavior: "INCLUDE",
      }),
    });
    const w = (await watch.json()) as Json;
    expect(Number(w.expiration) - Date.now()).toBeGreaterThan(6 * 24 * 3600 * 1000);
    return { ...env, r, watch: w };
  }

  async function verify(app: ReturnType<typeof setup>["app"], token: string, audience: string) {
    const jwks = createRemoteJWKSet(new URL(`${base}/oauth2/v3/certs`), {
      [customFetch]: async (url) => app.request(String(url)),
    });
    return jwtVerify(token, jwks, { issuer: base, audience, algorithms: ["RS256"] });
  }

  it("pushes the Pub/Sub-wrapped notification with a signed OIDC token when mail arrives", async () => {
    const { app, control, r, watch } = await watched();
    const arrived = (await (
      await control("/gmail/arrive", { to: USER, from: "sender@example.com", subject: "hi", text: "hello" })
    ).json()) as Json;
    expect(arrived.pushes).toHaveLength(1);
    expect(arrived.pushes[0]).toMatchObject({ acknowledged: true, status_code: 204 });
    expect(r.received).toHaveLength(1);
    const { headers, body } = r.received[0]!;
    const parsed = JSON.parse(body) as Json;
    expect(parsed.subscription).toBe("projects/demo/subscriptions/gmail-push");
    expect(parsed.message.messageId).toBe(parsed.message.message_id);
    expect(parsed.message.publishTime).toBe(parsed.message.publish_time);
    const data = JSON.parse(Buffer.from(parsed.message.data, "base64").toString("utf8")) as Json;
    expect(data).toEqual({ emailAddress: USER, historyId: arrived.historyId });
    expect(BigInt(data.historyId) > BigInt(watch.historyId)).toBe(true);
    const token = String(headers.authorization).replace(/^Bearer /, "");
    const { payload, protectedHeader } = await verify(app, token, "https://app.example.test/push");
    expect(protectedHeader.alg).toBe("RS256");
    expect(payload).toMatchObject({ email: "gmail-push@demo.iam.gserviceaccount.com", email_verified: true });
    expect(payload.sub).toBe(payload.azp);
  });

  it("pushes after an ordinary API change and skips changes outside the watched labels", async () => {
    const { call, r } = await watched();
    // A message inserted without INBOX does not match labelIds [INBOX] with INCLUDE.
    await call("/gmail/v1/users/me/messages", {
      method: "POST",
      body: JSON.stringify({
        raw: buildRawMessage({ from: "a@example.com", to: USER, subject: "x" }),
        labelIds: ["STARRED"],
      }),
    });
    expect(r.received).toHaveLength(0);
    await call("/gmail/v1/users/me/messages", {
      method: "POST",
      body: JSON.stringify({
        raw: buildRawMessage({ from: "a@example.com", to: USER, subject: "y" }),
        labelIds: ["INBOX"],
      }),
    });
    expect(r.received).toHaveLength(1);
  });

  it("drops a second notification within a second, as Gmail does", async () => {
    const { control, r } = await watched();
    await control("/gmail/arrive", { to: USER, subject: "1" });
    const second = (await (await control("/gmail/arrive", { to: USER, subject: "2" })).json()) as Json;
    expect(second.pushes).toEqual([]);
    expect(r.received).toHaveLength(1);
    await new Promise((res) => setTimeout(res, 1050));
    await control("/gmail/arrive", { to: USER, subject: "3" });
    expect(r.received).toHaveLength(2);
  });

  it("previews the exact push without sending it, and stops after users.stop", async () => {
    const { app, call, control, r } = await watched();
    const preview = (await (await control("/gmail/preview-push", { email: USER })).json()) as Json;
    expect(r.received).toHaveLength(0);
    expect(preview.verify).toMatchObject({ jwks_uri: `${base}/oauth2/v3/certs`, issuer: base });
    const push = preview.pushes[0];
    expect(push.url).toBe(r.url);
    expect(push.method).toBe("POST");
    const parsed = JSON.parse(push.body) as Json;
    expect(JSON.parse(Buffer.from(parsed.message.data, "base64").toString())).toEqual(push.data);
    await verify(app, push.headers.authorization.replace(/^Bearer /, ""), "https://app.example.test/push");

    expect((await call("/gmail/v1/users/me/stop", { method: "POST" })).status).toBe(204);
    await control("/gmail/arrive", { to: USER, subject: "after stop" });
    expect(r.received).toHaveLength(0);
    expect((await control("/gmail/preview-push", { email: USER })).status).toBe(404);
  });

  it("records pushes in the deliveries log and on the request's ledger entry", async () => {
    const { call, control, ledger } = await watched();
    await call("/gmail/v1/users/me/messages", {
      method: "POST",
      body: JSON.stringify({
        raw: buildRawMessage({ from: "a@example.com", to: USER, subject: "y" }),
        labelIds: ["INBOX"],
      }),
    });
    const entry = ledger.list()[0]!;
    expect(entry.sideEffects.some((e) => e.collection === "google.pubsub.deliveries")).toBe(true);
    const log = (await (await control("/pubsub/deliveries")).json()) as Json;
    expect(log.deliveries).toHaveLength(1);
    expect(log.deliveries[0]).toMatchObject({ email: USER, acknowledged: true });
  });
});
