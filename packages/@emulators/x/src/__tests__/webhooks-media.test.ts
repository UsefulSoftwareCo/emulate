import { createHmac, randomBytes } from "crypto";
import { createServer as createHttpServer, type IncomingHttpHeaders, type Server } from "http";
import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "@emulators/core";
import { xPlugin, seedFromConfig, getXStore, type XSeedConfig } from "../index.js";

const base = "http://localhost:4000";
const DEV = "1000000000000000001";
const ALICE = "1000000000000000002";
const SECRET = "dm-app-secret";
type Json = Record<string, any>;

const sign = (secret: string, msg: string) => "sha256=" + createHmac("sha256", secret).update(msg).digest("base64");

interface Received {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
}

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

/** A webhook receiver on 127.0.0.1 that answers CRCs with `crcSecret` and records every request. */
async function receiver(crcSecret: string | null): Promise<{ url: string; received: Received[] }> {
  const received: Received[] = [];
  const server = createHttpServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      received.push({ method: req.method!, url: req.url!, headers: req.headers, body });
      const u = new URL(req.url!, "http://x");
      const token = u.searchParams.get("crc_token");
      if (req.method === "GET" && token && crcSecret) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ response_token: sign(crcSecret, token) }));
        return;
      }
      res.writeHead(200);
      res.end();
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}/webhooks/x`, received };
}

function setup(extra: Partial<XSeedConfig> = {}) {
  const server = createServer(xPlugin, { baseUrl: base });
  seedFromConfig(server.store, base, {
    users: [
      { username: "developer", name: "Developer", user_id: DEV },
      { username: "alice", name: "Alice", user_id: ALICE },
      { username: "bob", name: "Bob", user_id: "1000000000000000003" },
    ],
    oauth_clients: [{ client_id: "dm-app", client_secret: SECRET, client_type: "confidential" }],
    ...extra,
  });
  const xs = getXStore(server.store);
  const mint = (userId: string | null, scopes = ["dm.read", "dm.write", "tweet.read", "users.read", "media.write"]) => {
    const token = `tok_${randomBytes(12).toString("hex")}`;
    xs.accessTokens.insert({
      token,
      client_id: "dm-app",
      user_id: userId,
      scopes,
      app_only: userId === null,
      expires: 0,
    });
    return token;
  };
  const call = (path: string, token?: string, init: RequestInit = {}) =>
    server.app.request(`${base}${path}`, {
      ...init,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(typeof init.body === "string" ? { "Content-Type": "application/json" } : {}),
      },
    });
  const control = (path: string, body?: unknown) =>
    server.app.request(`${base}/_emulate/x${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  return { ...server, xs, mint, call, control };
}

describe("X webhooks and the CRC", () => {
  it("challenges the address at creation and registers the webhook when the answer is right", async () => {
    const r = await receiver(SECRET);
    const { call, mint } = setup();
    const app = mint(null);
    const res = await call("/2/webhooks", app, { method: "POST", body: JSON.stringify({ url: r.url }) });
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as Json;
    expect(data).toMatchObject({ url: r.url, valid: true });
    expect(data.id).toMatch(/^[0-9]{19}$/);
    expect(r.received).toHaveLength(1);
    expect(r.received[0]!.method).toBe("GET");
    expect(new URL(r.received[0]!.url, "http://x").searchParams.get("crc_token")).toBeTruthy();
    const list = (await (await call("/2/webhooks", app)).json()) as Json;
    expect(list).toEqual({ data: [data], meta: { result_count: 1 } });
    // PUT re-runs the CRC.
    expect(await (await call(`/2/webhooks/${data.id}`, app, { method: "PUT" })).json()).toEqual({
      data: { valid: true },
    });
    expect(r.received).toHaveLength(2);
    const dup = await call("/2/webhooks", app, { method: "POST", body: JSON.stringify({ url: r.url }) });
    expect(((await dup.json()) as Json).errors[0].message).toBe("DuplicateUrlFailed");
  });

  it("refuses the webhook when the CRC answer is wrong or the address is unreachable", async () => {
    const wrong = await receiver("not-the-secret");
    const { call, mint } = setup();
    const app = mint(null);
    const res = await call("/2/webhooks", app, { method: "POST", body: JSON.stringify({ url: wrong.url }) });
    expect(res.status).toBe(400);
    expect(((await res.json()) as Json).errors[0].message).toBe("CrcValidationFailed");
    const gone = await call("/2/webhooks", app, {
      method: "POST",
      body: JSON.stringify({ url: "http://127.0.0.1:9/unreachable" }),
    });
    expect(((await gone.json()) as Json).errors[0].message).toBe("CrcValidationFailed");
    expect(((await (await call("/2/webhooks", app)).json()) as Json).meta.result_count).toBe(0);
  });

  it("holds the challenge for the test in the emulator's control mode", async () => {
    const { call, mint, control } = setup();
    expect(await (await control("/webhooks/crc-delivery", { mode: "control" })).json()).toEqual({ mode: "control" });
    const app = mint(null);
    const url = "https://receiver.example.test/webhooks/x";
    const created = (await (
      await call("/2/webhooks", app, { method: "POST", body: JSON.stringify({ url }) })
    ).json()) as Json;
    expect(created.data.valid).toBe(true);
    const challenge = (await (await control(`/webhooks/${created.data.id}/challenge`)).json()) as Json;
    expect(challenge.method).toBe("GET");
    expect(challenge.url).toBe(`${url}?crc_token=${encodeURIComponent(challenge.crc_token)}`);
    expect(challenge.expected_response_tokens).toEqual([sign(SECRET, challenge.crc_token)]);
    // The test's app answers wrongly: the webhook is marked invalid, as X would.
    const wrong = (await (
      await control(`/webhooks/${created.data.id}/challenge`, { response_token: "sha256=nope" })
    ).json()) as Json;
    expect(wrong.valid).toBe(false);
    expect(((await (await call("/2/webhooks", app)).json()) as Json).data[0].valid).toBe(false);
    // PUT holds a fresh challenge; a right answer re-enables it.
    await call(`/2/webhooks/${created.data.id}`, app, { method: "PUT" });
    const fresh = (await (await control(`/webhooks/${created.data.id}/challenge`)).json()) as Json;
    expect(fresh.crc_token).not.toBe(challenge.crc_token);
    const right = (await (
      await control(`/webhooks/${created.data.id}/challenge`, {
        response: { response_token: sign(SECRET, fresh.crc_token) },
      })
    ).json()) as Json;
    expect(right.valid).toBe(true);
  });

  it("enforces X's https and no-port rules on an https instance", async () => {
    const server = createServer(xPlugin, { baseUrl: "https://x.example.test" });
    seedFromConfig(server.store, "https://x.example.test", {
      oauth_clients: [{ client_id: "dm-app", client_secret: SECRET, client_type: "confidential" }],
    });
    getXStore(server.store).accessTokens.insert({
      token: "apptok",
      client_id: "dm-app",
      user_id: null,
      scopes: [],
      app_only: true,
      expires: 0,
    });
    for (const url of ["http://receiver.example.test/hook", "https://receiver.example.test:8443/hook"]) {
      const res = await server.app.request("https://x.example.test/2/webhooks", {
        method: "POST",
        headers: { Authorization: "Bearer apptok", "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      expect(((await res.json()) as Json).errors[0].message, url).toBe("UrlValidationFailed");
    }
  });
});

describe("webhook addresses in each CRC mode on an https instance", () => {
  function httpsInstance(mode: "outbound" | "control") {
    const host = "https://x.example.test";
    const server = createServer(xPlugin, { baseUrl: host });
    seedFromConfig(server.store, host, {
      users: [
        { username: "developer", user_id: DEV },
        { username: "alice", user_id: ALICE },
      ],
      oauth_clients: [{ client_id: "dm-app", client_secret: SECRET, client_type: "confidential" }],
      webhook_crc_delivery: mode,
    });
    const xs = getXStore(server.store);
    const token = (user: string | null) => {
      const t = `tok_${randomBytes(8).toString("hex")}`;
      xs.accessTokens.insert({
        token: t,
        client_id: "dm-app",
        user_id: user,
        scopes: user ? ["dm.read", "dm.write", "tweet.read", "users.read"] : [],
        app_only: user === null,
        expires: 0,
      });
      return t;
    };
    const post = (path: string, t: string, body: unknown) =>
      server.app.request(`${host}${path}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    return { token, post };
  }
  const local = ["http://localhost:3000/webhooks/x", "https://app.example.test:8443/webhooks/x"];

  it("keeps X's rule in outbound mode: no http address, no port", async () => {
    const { token, post } = httpsInstance("outbound");
    const app = token(null);
    for (const url of local) {
      const res = await post("/2/webhooks", app, { url });
      expect(((await res.json()) as Json).errors[0].message, url).toBe("UrlValidationFailed");
    }
  });

  it("accepts a local http address with a port in control mode, with subscriptions and previews", async () => {
    const { token, post } = httpsInstance("control");
    const app = token(null);
    const dev = token(DEV);
    const ids: string[] = [];
    for (const url of local) {
      const res = await post("/2/webhooks", app, { url });
      expect(res.status, url).toBe(200);
      ids.push(((await res.json()) as Json).data.id);
    }
    const sub = await post("/2/activity/subscriptions", dev, {
      event_type: "dm.received",
      filter: { user_id: DEV },
      webhook_id: ids[0],
    });
    expect(sub.status).toBe(200);
    const arrived = (await (
      await post("/_emulate/x/dm/arrive", app, { to: "developer", from: "alice", text: "hi" })
    ).json()) as Json;
    const preview = (await (
      await post("/_emulate/x/dm/preview-delivery", app, { dm_event_id: arrived.dm_event_id, include_invalid: true })
    ).json()) as Json;
    expect(preview.deliveries.map((d: Json) => d.url)).toEqual([local[0]]);
    expect(preview.deliveries[0].headers["x-twitter-webhooks-signature-oauth2"]).toBe(
      sign(SECRET, preview.deliveries[0].body),
    );
  });
});

describe("deliveries go only to an address whose owner answered the challenge", () => {
  const answer = async (control: (path: string, body?: unknown) => Promise<Response>, id: string) => {
    const challenge = (await (await control(`/webhooks/${id}/challenge`)).json()) as Json;
    return (await (
      await control(`/webhooks/${id}/challenge`, { response_token: sign(SECRET, challenge.crc_token) })
    ).json()) as Json;
  };

  it("never calls an address accepted only through control mode's relaxation, even once answered", async () => {
    const r = await receiver(SECRET); // http://127.0.0.1:<port>: http and a port
    const host = "https://x.example.test";
    const server = createServer(xPlugin, { baseUrl: host });
    seedFromConfig(server.store, host, {
      users: [
        { username: "developer", user_id: DEV },
        { username: "alice", user_id: ALICE },
      ],
      oauth_clients: [{ client_id: "dm-app", client_secret: SECRET, client_type: "confidential" }],
      webhook_crc_delivery: "control",
    });
    const xs = getXStore(server.store);
    for (const [t, user] of [
      ["app", null],
      ["dev", DEV],
      ["alice", ALICE],
    ] as const) {
      xs.accessTokens.insert({
        token: t,
        client_id: "dm-app",
        user_id: user,
        scopes: ["dm.read", "dm.write", "tweet.read", "users.read"],
        app_only: !user,
        expires: 0,
      });
    }
    const req = (path: string, token: string | null, body?: unknown) =>
      server.app.request(`${host}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    const control = (path: string, body?: unknown) => req(`/_emulate/x${path}`, null, body);
    const hook = ((await (await req("/2/webhooks", "app", { url: r.url })).json()) as Json).data;
    await req("/2/activity/subscriptions", "dev", {
      event_type: "dm.received",
      filter: { user_id: DEV },
      webhook_id: hook.id,
    });
    expect((await answer(control, hook.id)).valid).toBe(true);

    const arrived = (await (
      await control("/dm/arrive", { to: "developer", from: "alice", text: "hi" })
    ).json()) as Json;
    expect(arrived.deliveries).toHaveLength(1);
    expect(arrived.deliveries[0].held).toMatch(/never calls such an address/);
    expect(arrived.deliveries[0].success).toBe(false);
    expect(r.received).toHaveLength(0);
    const preview = (await (
      await control("/dm/preview-delivery", { dm_event_id: arrived.dm_event_id })
    ).json()) as Json;
    expect(preview.deliveries[0].url).toBe(r.url);
    expect(preview.deliveries[0].headers["x-twitter-webhooks-signature-oauth2"]).toBe(
      sign(SECRET, preview.deliveries[0].body),
    );
    // A DM sent through X's own route is on the ledger, with the held delivery.
    const sent = await req(`/2/dm_conversations/with/${DEV}/messages`, "alice", { text: "via the API" });
    expect(sent.status).toBe(201);
    expect(r.received).toHaveLength(0);
    const entry = server.ledger.list().find((e) => e.method === "POST" && e.path.endsWith("/messages"))!;
    expect(entry.summary).toBeDefined();
    expect(entry.sideEffects.find((e) => e.collection === "x.dm_events")!.summary).toMatch(
      /0 webhook deliveries sent, 1 held/,
    );
    expect(
      entry.sideEffects.some((e) => e.collection === "x.webhook_deliveries" && /never calls/.test(e.summary ?? "")),
    ).toBe(true);
  });

  it("holds deliveries in control mode until the test answers the challenge, then sends them", async () => {
    const r = await receiver(SECRET);
    const { call, mint, control } = setup({ webhook_crc_delivery: "control" });
    const hook = (
      (await (
        await call("/2/webhooks", mint(null), { method: "POST", body: JSON.stringify({ url: r.url }) })
      ).json()) as Json
    ).data;
    await call("/2/activity/subscriptions", mint(DEV), {
      method: "POST",
      body: JSON.stringify({ event_type: "dm.received", filter: { user_id: DEV }, webhook_id: hook.id }),
    });
    const before = (await (
      await control("/dm/arrive", { to: "developer", from: "alice", text: "one" })
    ).json()) as Json;
    expect(before.deliveries[0].held).toMatch(/no challenge has been answered/);
    expect(r.received).toHaveLength(0);

    expect((await answer(control, hook.id)).valid).toBe(true);
    const after = (await (await control("/dm/arrive", { to: "developer", from: "alice", text: "two" })).json()) as Json;
    expect(after.deliveries[0]).toMatchObject({ success: true });
    expect(after.deliveries[0].held).toBeUndefined();
    expect(r.received.filter((x) => x.method === "POST")).toHaveLength(1);
  });

  it("holds deliveries to a seeded webhook until PUT passes X's CRC", async () => {
    const r = await receiver(SECRET);
    const { call, mint, control } = setup({
      webhooks: [{ client_id: "dm-app", url: r.url }],
      activity_subscriptions: [{ event_type: "dm.received", user: "developer", webhook: r.url }],
    });
    const before = (await (
      await control("/dm/arrive", { to: "developer", from: "alice", text: "one" })
    ).json()) as Json;
    expect(before.deliveries[0].held).toMatch(/no challenge has been answered/);
    const hooks = (await (await call("/2/webhooks", mint(null))).json()) as Json;
    expect((await call(`/2/webhooks/${hooks.data[0].id}`, mint(null), { method: "PUT" })).status).toBe(200);
    const after = (await (await control("/dm/arrive", { to: "developer", from: "alice", text: "two" })).json()) as Json;
    expect(after.deliveries[0].success).toBe(true);
    expect(r.received.filter((x) => x.method === "POST")).toHaveLength(1);
  });
});

describe("X Activity API DM deliveries", () => {
  async function subscribed(extra: Partial<XSeedConfig> = {}) {
    const r = await receiver(SECRET);
    const env = setup(extra);
    const app = env.mint(null);
    const hook = (await (
      await env.call("/2/webhooks", app, { method: "POST", body: JSON.stringify({ url: r.url }) })
    ).json()) as Json;
    const dev = env.mint(DEV);
    const alice = env.mint(ALICE);
    const subs: Json = {};
    for (const [token, user, type] of [
      [dev, DEV, "dm.received"],
      [dev, DEV, "dm.sent"],
      [alice, ALICE, "dm.received"],
    ] as const) {
      const res = await env.call("/2/activity/subscriptions", token, {
        method: "POST",
        body: JSON.stringify({
          event_type: type,
          filter: { user_id: user },
          webhook_id: hook.data.id,
          tag: `${user}-${type}`,
        }),
      });
      expect(res.status).toBe(200);
      subs[`${user}:${type}`] = ((await res.json()) as Json).data.subscription;
    }
    r.received.length = 0;
    return { ...env, r, hook: hook.data, dev, alice, app, subs };
  }

  it("creates, lists, updates and deletes subscriptions in the documented shapes", async () => {
    const { call, app, dev, subs, hook } = await subscribed();
    const s = subs[`${DEV}:dm.received`];
    expect(s).toMatchObject({
      event_type: "dm.received",
      filter: { user_id: DEV },
      webhook_id: hook.id,
      tag: `${DEV}-dm.received`,
    });
    expect(s.subscription_id).toMatch(/^[0-9]{19}$/);
    expect(Date.parse(s.created_at)).not.toBeNaN();
    const mine = (await (await call(`/2/activity/subscriptions?user_id=${DEV}`, dev)).json()) as Json;
    expect(mine.data).toHaveLength(2);
    expect((await call(`/2/activity/subscriptions?user_id=${ALICE}`, dev)).status).toBe(403);
    const put = (await (
      await call(`/2/activity/subscriptions/${s.subscription_id}`, app, {
        method: "PUT",
        body: JSON.stringify({ tag: "inbox" }),
      })
    ).json()) as Json;
    expect(put.data.subscription.tag).toBe("inbox");
    expect(
      await (await call(`/2/activity/subscriptions/${s.subscription_id}`, app, { method: "DELETE" })).json(),
    ).toEqual({
      data: { deleted: true },
    });
    expect(((await (await call("/2/activity/subscriptions", app)).json()) as Json).data).toHaveLength(2);
  });

  it("refuses subscriptions for users who have not authorized the app, and event types it does not emulate", async () => {
    const { call, app, hook, xs } = await subscribed();
    xs.users.insert({
      ...xs.users.findOneBy("user_id", DEV)!,
      id: 0,
      user_id: "1000000000000000009",
      username: "stranger",
    });
    const stranger = await call("/2/activity/subscriptions", app, {
      method: "POST",
      body: JSON.stringify({
        event_type: "dm.received",
        filter: { user_id: "1000000000000000009" },
        webhook_id: hook.id,
      }),
    });
    expect(stranger.status).toBe(403);
    const posts = await call("/2/activity/subscriptions", app, {
      method: "POST",
      body: JSON.stringify({ event_type: "post.create", filter: { user_id: DEV }, webhook_id: hook.id }),
    });
    expect(posts.status).toBe(400);
  });

  it("delivers dm.sent and dm.received, signed with the client secret, when a DM is sent", async () => {
    const { call, dev, r } = await subscribed();
    const sent = (await (
      await call(`/2/dm_conversations/with/${ALICE}/messages`, dev, {
        method: "POST",
        body: JSON.stringify({ text: "hello!" }),
      })
    ).json()) as Json;
    const posts = r.received.filter((x) => x.method === "POST");
    expect(posts).toHaveLength(2);
    for (const p of posts) {
      expect(p.headers["content-type"]).toBe("application/json");
      expect(p.headers["x-twitter-webhooks-signature-oauth2"]).toBe(sign(SECRET, p.body));
      expect(p.headers["x-twitter-webhooks-signature"]).toBeUndefined();
    }
    const bodies = posts.map((p) => JSON.parse(p.body) as Json);
    const received = bodies.find((b) => b.data.event_type === "dm.received")!;
    const sentEv = bodies.find((b) => b.data.event_type === "dm.sent")!;
    expect(received.data.filter).toEqual({ user_id: ALICE });
    expect(sentEv.data.filter).toEqual({ user_id: DEV });
    expect(received.data.tag).toBe(`${ALICE}-dm.received`);
    expect(received.data.event_uuid).toMatch(/^-?[0-9]+$/);
    const ev = received.data.payload.direct_message_events[0];
    expect(ev).toMatchObject({
      type: "message_create",
      id: sent.data.dm_event_id,
      message_create: {
        target: { recipient_id: ALICE },
        sender_id: DEV,
        message_data: { text: "hello!", entities: { hashtags: [], symbols: [], user_mentions: [], urls: [] } },
      },
    });
    expect(ev.created_timestamp).toMatch(/^[0-9]{13}$/);
    expect(received.data.payload.users[DEV].data).toMatchObject({ id: DEV, username: "developer", name: "Developer" });
  });

  it("makes a message arrive through the control plane, delivers it, and previews the same bytes", async () => {
    const { control, r, call, dev } = await subscribed();
    const arrived = (await (
      await control("/dm/arrive", { to: "developer", from: "alice", text: "incoming" })
    ).json()) as Json;
    // Developer subscribes to dm.received; Alice (the sender) has no dm.sent subscription.
    expect(arrived.deliveries.map((d: Json) => [d.event_type, d.for_user_id, d.success])).toEqual([
      ["dm.received", DEV, true],
    ]);
    const delivered = r.received.find(
      (x) => x.method === "POST" && JSON.parse(x.body).data.event_type === "dm.received",
    )!;
    const preview = (await (
      await control("/dm/preview-delivery", { dm_event_id: arrived.dm_event_id, for_user_id: "developer" })
    ).json()) as Json;
    expect(preview.deliveries).toHaveLength(1);
    expect(preview.deliveries[0].body).toBe(delivered.body);
    expect(preview.deliveries[0].headers["x-twitter-webhooks-signature-oauth2"]).toBe(sign(SECRET, delivered.body));
    expect(preview.deliveries[0].url).toBe(r.url);
    // The arrival is in the recipient's reads.
    const read = (await (await call("/2/dm_events", dev)).json()) as Json;
    expect(read.data[0]).toMatchObject({ id: arrived.dm_event_id, text: "incoming" });
  });

  it("adds the legacy signature header only when a consumer secret is seeded", async () => {
    const { call, dev, r } = await subscribed({
      oauth_clients: [
        { client_id: "dm-app", client_secret: SECRET, client_type: "confidential", consumer_secret: "legacy-secret" },
      ],
    });
    await call(`/2/dm_conversations/with/${ALICE}/messages`, dev, {
      method: "POST",
      body: JSON.stringify({ text: "x" }),
    });
    const p = r.received.find((x) => x.method === "POST")!;
    expect(p.headers["x-twitter-webhooks-signature"]).toBe(sign("legacy-secret", p.body));
    expect(p.headers["x-twitter-webhooks-signature-oauth2"]).toBe(sign(SECRET, p.body));
  });

  it("stops delivering to an invalid webhook", async () => {
    const { call, dev, r, xs, hook } = await subscribed();
    const row = xs.webhooks.findOneBy("webhook_id", hook.id)!;
    xs.webhooks.update(row.id, { valid: false });
    await call(`/2/dm_conversations/with/${ALICE}/messages`, dev, {
      method: "POST",
      body: JSON.stringify({ text: "x" }),
    });
    expect(r.received).toHaveLength(0);
  });

  it("records deliveries in the logs and correlates them onto the send's ledger entry", async () => {
    const { call, dev, ledger, webhooks } = await subscribed();
    await call(`/2/dm_conversations/with/${ALICE}/messages`, dev, {
      method: "POST",
      body: JSON.stringify({ text: "x" }),
    });
    const entry = ledger.list()[0]!;
    expect(entry.operationId).toBe("createDirectMessagesByParticipantId");
    expect(entry.webhookDeliveries.map((d) => d.event).sort()).toEqual(["dm.received", "dm.sent"]);
    expect(webhooks.getDeliveries().filter((d) => d.event.startsWith("dm.")).length).toBe(2);
  });
});

describe("X media", () => {
  async function drain(res: Response): Promise<Buffer> {
    return Buffer.from(await res.arrayBuffer());
  }

  it("uploads in one request, attaches the media to a DM and lets both participants download it", async () => {
    const { call, mint } = setup({ rate_limits: { enabled: false } });
    const dev = mint(DEV);
    const bytes = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), randomBytes(5000)]);
    const up = await call("/2/media/upload", dev, {
      method: "POST",
      body: JSON.stringify({ media: bytes.toString("base64"), media_category: "dm_image" }),
    });
    expect(up.status).toBe(200);
    const media = ((await up.json()) as Json).data;
    expect(media).toMatchObject({ size: bytes.length, image: { image_type: "image/jpeg" } });
    expect(media.media_key).toBe(`3_${media.id}`);
    const sent = (await (
      await call(`/2/dm_conversations/with/${ALICE}/messages`, dev, {
        method: "POST",
        body: JSON.stringify({ text: "photo", attachments: [{ media_id: media.id }] }),
      })
    ).json()) as Json;
    const alice = mint(ALICE);
    const read = (await (
      await call(`/2/dm_events?expansions=attachments.media_keys&media.fields=url,type`, alice)
    ).json()) as Json;
    expect(read.data[0].attachments).toEqual({ media_keys: [media.media_key] });
    const url = new URL(read.includes.media[0].url);
    expect(url.pathname).toBe(`/2/dm_conversations/media/${sent.data.dm_event_id}/${media.media_key}/${media.id}`);
    const dl = await call(url.pathname, alice);
    expect(dl.status).toBe(200);
    expect(dl.headers.get("content-type")).toBe("application/octet-stream");
    expect(dl.headers.get("content-length")).toBe(String(bytes.length));
    expect((await drain(dl)).equals(bytes)).toBe(true);
    // Not a participant, or without dm.read: refused.
    expect((await call(url.pathname, mint("1000000000000000003", ["dm.read"]))).status).toBe(404);
    expect((await call(url.pathname, mint(ALICE, ["tweet.read"]))).status).toBe(403);
  });

  it("uploads several megabytes in chunks and streams them back intact", async () => {
    const { call, mint, store } = setup({ rate_limits: { enabled: false } });
    const dev = mint(DEV);
    const file = randomBytes(6 * 1024 * 1024 + 123);
    const init = (await (
      await call("/2/media/upload/initialize", dev, {
        method: "POST",
        body: JSON.stringify({ media_category: "dm_video", media_type: "video/mp4", total_bytes: file.length }),
      })
    ).json()) as Json;
    expect(init.data.media_key).toBe(`7_${init.data.id}`);
    const seg = 4 * 1024 * 1024;
    for (let i = 0; i * seg < file.length; i++) {
      const form = new FormData();
      form.set("segment_index", String(i));
      form.set("media", new Blob([file.subarray(i * seg, (i + 1) * seg)]));
      const res = await call(`/2/media/upload/${init.data.id}/append`, dev, { method: "POST", body: form });
      expect(res.status).toBe(200);
    }
    const fin = (await (
      await call(`/2/media/upload/${init.data.id}/finalize`, dev, { method: "POST" })
    ).json()) as Json;
    expect(fin.data).toMatchObject({ size: file.length, processing_info: { state: "succeeded" } });
    const status = (await (await call(`/2/media/upload?command=STATUS&media_id=${init.data.id}`, dev)).json()) as Json;
    expect(status.data.processing_info.state).toBe("succeeded");
    // No stored part exceeds what a Durable Object value can hold.
    const parts = getXStore(store).mediaChunks.findBy("media_id", init.data.id);
    expect(Math.max(...parts.map((p) => p.data_b64.length))).toBeLessThan(128 * 1024);
    const sent = (await (
      await call(`/2/dm_conversations/with/${ALICE}/messages`, dev, {
        method: "POST",
        body: JSON.stringify({ attachments: [{ media_id: init.data.id }] }),
      })
    ).json()) as Json;
    const dl = await call(
      `/2/dm_conversations/media/${sent.data.dm_event_id}/${init.data.media_key}/${init.data.id}`,
      mint(ALICE),
    );
    expect(dl.headers.get("content-length")).toBe(String(file.length));
    expect((await drain(dl)).equals(file)).toBe(true);
  });

  it("streams a large seeded attachment without storing its bytes, and keeps it out of the ledger", async () => {
    const { call, mint, store, ledger } = setup({
      dm_conversations: [
        {
          participants: ["developer", "alice"],
          messages: [{ from: "alice", text: "big", attachment: { bytes: 8 * 1024 * 1024, media_type: "image/png" } }],
        },
      ],
    });
    const dev = mint(DEV);
    const read = (await (
      await call(`/2/dm_events?expansions=attachments.media_keys&media.fields=url`, dev)
    ).json()) as Json;
    const path = new URL(read.includes.media[0].url).pathname;
    const dl = await call(path, dev);
    expect(dl.headers.get("content-length")).toBe(String(8 * 1024 * 1024));
    const reader = dl.body!.getReader();
    let total = 0;
    let chunks = 0;
    let first: Uint8Array | undefined;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      first ??= value;
      total += value.length;
      chunks++;
    }
    expect(total).toBe(8 * 1024 * 1024);
    expect(chunks).toBeGreaterThan(100);
    expect([...first!.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(getXStore(store).mediaChunks.all()).toHaveLength(0);
    const entry = ledger.list()[0]!;
    expect(entry.operationId).toBe("dmConversationsMediaDownload");
    expect(entry.response.body).toBe("<binary body omitted>");
    expect(entry.identity.user?.externalId).toBe(DEV);
  });

  it("refuses uploads without media.write and attachments the sender does not own", async () => {
    const { call, mint } = setup();
    const noScope = await call("/2/media/upload", mint(DEV, ["dm.write", "tweet.read", "users.read"]), {
      method: "POST",
      body: JSON.stringify({ media: "AAAA", media_category: "dm_image" }),
    });
    expect(noScope.status).toBe(403);
    const up = (
      (await (
        await call("/2/media/upload", mint(ALICE), {
          method: "POST",
          body: JSON.stringify({ media: "AAAA", media_category: "dm_image" }),
        })
      ).json()) as Json
    ).data;
    const steal = await call(`/2/dm_conversations/with/${ALICE}/messages`, mint(DEV), {
      method: "POST",
      body: JSON.stringify({ attachments: [{ media_id: up.id }] }),
    });
    expect(steal.status).toBe(400);
    expect(((await steal.json()) as Json).type).toBe("https://api.x.com/2/problems/dm-bad-media");
  });
});
