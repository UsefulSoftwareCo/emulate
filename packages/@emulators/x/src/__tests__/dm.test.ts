import { createHash, randomBytes } from "crypto";
import { describe, expect, it } from "vitest";
import { createServer } from "@emulators/core";
import { xPlugin, seedFromConfig, getXStore, type XSeedConfig } from "../index.js";

const base = "http://localhost:4000";
const DEV = "1000000000000000001";
const ALICE = "1000000000000000002";
const BOB = "1000000000000000003";
const ALL_DM = ["dm.read", "dm.write", "tweet.read", "users.read", "media.write", "offline.access"];

function setup(extra: Partial<XSeedConfig> = {}) {
  const server = createServer(xPlugin, { baseUrl: base });
  seedFromConfig(server.store, base, {
    users: [
      { username: "developer", name: "Developer", user_id: DEV },
      { username: "alice", name: "Alice", user_id: ALICE },
      { username: "bob", name: "Bob", user_id: BOB },
    ],
    oauth_clients: [
      {
        client_id: "dm-app",
        client_secret: "dm-app-secret",
        client_type: "confidential",
        redirect_uris: ["http://localhost:3000/callback"],
      },
    ],
    ...extra,
  });
  const xs = getXStore(server.store);
  const mint = (userId: string | null, scopes: string[] = ALL_DM) => {
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
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...(init.headers as Record<string, string> | undefined),
      },
    });
  return { ...server, xs, mint, call };
}

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

describe("X direct messages: scopes", () => {
  it("authorize accepts dm.read, dm.write and media.write and the token carries them", async () => {
    const { app } = setup();
    const verifier = randomBytes(40).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const scope = "dm.read dm.write media.write tweet.read users.read";
    const authorize = await app.request(
      `${base}/2/oauth2/authorize?response_type=code&client_id=dm-app&redirect_uri=${encodeURIComponent(
        "http://localhost:3000/callback",
      )}&scope=${encodeURIComponent(scope)}&state=s&code_challenge=${challenge}&code_challenge_method=S256`,
    );
    expect(authorize.status).toBe(200);
    const consent = await app.request(`${base}/2/oauth2/authorize/consent`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        user_id: DEV,
        client_id: "dm-app",
        redirect_uri: "http://localhost:3000/callback",
        scope,
        state: "s",
        code_challenge: challenge,
        code_challenge_method: "S256",
      }),
    });
    const code = new URL(consent.headers.get("Location")!).searchParams.get("code")!;
    const tokenRes = await app.request(`${base}/2/oauth2/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: "Basic " + Buffer.from("dm-app:dm-app-secret").toString("base64"),
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: "http://localhost:3000/callback",
        code_verifier: verifier,
      }),
    });
    const body = (await tokenRes.json()) as Json;
    expect(tokenRes.status).toBe(200);
    expect(body.scope.split(" ").sort()).toEqual(["dm.read", "dm.write", "media.write", "tweet.read", "users.read"]);
    const read = await app.request(`${base}/2/dm_events`, {
      headers: { Authorization: `Bearer ${body.access_token}` },
    });
    expect(read.status).toBe(200);
  });

  it("refuses reads without dm.read, sends without dm.write, app-only tokens and missing tokens", async () => {
    const { call, mint } = setup();
    expect((await call("/2/dm_events")).status).toBe(401);
    expect((await call("/2/dm_events", mint(null))).status).toBe(403);
    const noRead = await call("/2/dm_events", mint(DEV, ["tweet.read", "users.read", "dm.write"]));
    expect(noRead.status).toBe(403);
    expect(((await noRead.json()) as Json).detail).toContain("dm.read");
    const noWrite = await call(
      `/2/dm_conversations/with/${ALICE}/messages`,
      mint(DEV, ["dm.read", "tweet.read", "users.read"]),
      {
        method: "POST",
        body: JSON.stringify({ text: "hi" }),
      },
    );
    expect(noWrite.status).toBe(403);
    // The spec also requires tweet.read and users.read alongside dm.read.
    expect((await call("/2/dm_events", mint(DEV, ["dm.read"]))).status).toBe(403);
  });
});

describe("X direct messages: send and read", () => {
  it("sends to a participant and reads it back through all three lookups", async () => {
    const { call, mint } = setup();
    const dev = mint(DEV);
    const alice = mint(ALICE);
    const sent = await call(`/2/dm_conversations/with/${ALICE}/messages`, dev, {
      method: "POST",
      body: JSON.stringify({ text: "Hello Alice #launch" }),
    });
    expect(sent.status).toBe(201);
    const { data } = (await sent.json()) as Json;
    expect(data.dm_conversation_id).toBe(`${DEV}-${ALICE}`);
    expect(data.dm_event_id).toMatch(/^[0-9]{19}$/);

    const byParticipant = (await (await call(`/2/dm_conversations/with/${DEV}/dm_events`, alice)).json()) as Json;
    expect(byParticipant.data).toEqual([
      { id: data.dm_event_id, event_type: "MessageCreate", text: "Hello Alice #launch" },
    ]);
    expect(byParticipant.meta).toEqual({ result_count: 1 });

    const byId = (await (
      await call(
        `/2/dm_conversations/${data.dm_conversation_id}/dm_events?dm_event.fields=created_at,sender_id,dm_conversation_id,entities`,
        dev,
      )
    ).json()) as Json;
    expect(byId.data[0]).toMatchObject({
      id: data.dm_event_id,
      sender_id: DEV,
      dm_conversation_id: `${DEV}-${ALICE}`,
      entities: { hashtags: [{ start: 12, end: 19, tag: "launch" }] },
    });
    expect(Date.parse(byId.data[0].created_at)).not.toBeNaN();

    const all = (await (await call(`/2/dm_events?expansions=sender_id&user.fields=username`, alice)).json()) as Json;
    expect(all.data[0].sender_id).toBe(DEV);
    expect(all.includes.users).toEqual([{ id: DEV, name: "Developer", username: "developer" }]);

    // A user outside the conversation sees nothing of it.
    const bob = mint(BOB);
    expect(((await (await call("/2/dm_events", bob)).json()) as Json).meta.result_count).toBe(0);
    const foreign = (await (await call(`/2/dm_conversations/${DEV}-${ALICE}/dm_events`, bob)).json()) as Json;
    expect(foreign.errors[0].type).toBe("https://api.x.com/2/problems/resource-not-found");
    expect(foreign.data).toBeUndefined();
  });

  it("sends to a conversation by id and refuses non-participants, unknown conversations and bad bodies", async () => {
    const { call, mint } = setup();
    const dev = mint(DEV);
    await call(`/2/dm_conversations/with/${ALICE}/messages`, dev, {
      method: "POST",
      body: JSON.stringify({ text: "1" }),
    });
    const ok = await call(`/2/dm_conversations/${DEV}-${ALICE}/messages`, mint(ALICE), {
      method: "POST",
      body: JSON.stringify({ text: "reply" }),
    });
    expect(ok.status).toBe(201);
    const outsider = await call(`/2/dm_conversations/${DEV}-${ALICE}/messages`, mint(BOB), {
      method: "POST",
      body: JSON.stringify({ text: "let me in" }),
    });
    expect(outsider.status).toBe(403);
    expect(((await outsider.json()) as Json).type).toBe("https://api.x.com/2/problems/dm-sender-not-in-conversation");
    const unknown = await call(`/2/dm_conversations/1234567890123456789/messages`, dev, {
      method: "POST",
      body: JSON.stringify({ text: "x" }),
    });
    expect(unknown.status).toBe(404);
    const empty = await call(`/2/dm_conversations/with/${BOB}/messages`, dev, {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(empty.status).toBe(400);
    expect(((await empty.json()) as Json).type).toBe("https://api.x.com/2/problems/dm-text-empty");
    const extra = await call(`/2/dm_conversations/with/${BOB}/messages`, dev, {
      method: "POST",
      body: JSON.stringify({ text: "x", reply_to: "1" }),
    });
    expect(extra.status).toBe(400);
    const badMedia = await call(`/2/dm_conversations/with/${BOB}/messages`, dev, {
      method: "POST",
      body: JSON.stringify({ attachments: [{ media_id: "123" }] }),
    });
    expect(badMedia.status).toBe(400);
    // Rejected sends to Bob created no conversation.
    expect(((await (await call("/2/dm_events", mint(BOB))).json()) as Json).meta.result_count).toBe(0);
  });

  it("creates a group conversation and lets its members read it", async () => {
    const { call, mint } = setup();
    const res = await call("/2/dm_conversations", mint(DEV), {
      method: "POST",
      body: JSON.stringify({
        conversation_type: "Group",
        participant_ids: [ALICE, BOB],
        message: { text: "all hands" },
      }),
    });
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as Json;
    expect(data.dm_conversation_id).toMatch(/^[0-9]{19}$/);
    const read = (await (
      await call(`/2/dm_conversations/${data.dm_conversation_id}/dm_events`, mint(BOB))
    ).json()) as Json;
    expect(read.data.map((e: Json) => e.text)).toEqual(["all hands"]);
  });

  it("gets one event by id and lets only the sender delete it", async () => {
    const { call, mint } = setup();
    const dev = mint(DEV);
    const sent = (await (
      await call(`/2/dm_conversations/with/${ALICE}/messages`, dev, {
        method: "POST",
        body: JSON.stringify({ text: "bye" }),
      })
    ).json()) as Json;
    const id = sent.data.dm_event_id;
    const one = (await (await call(`/2/dm_events/${id}?dm_event.fields=sender_id`, mint(ALICE))).json()) as Json;
    expect(one.data).toEqual({ id, event_type: "MessageCreate", text: "bye", sender_id: DEV });
    const notMine = await call(`/2/dm_events/${id}`, mint(ALICE), { method: "DELETE" });
    expect(notMine.status).toBe(403);
    const del = await call(`/2/dm_events/${id}`, dev, { method: "DELETE" });
    expect(await del.json()).toEqual({ data: { deleted: true } });
    expect(((await (await call("/2/dm_events", dev)).json()) as Json).meta.result_count).toBe(0);
  });

  it("validates max_results, pagination_token and field names", async () => {
    const { call, mint } = setup();
    const dev = mint(DEV);
    for (const q of [
      "max_results=0",
      "max_results=101",
      "pagination_token=short",
      "pagination_token=AAAAAAAAAAAAAAAAAAAA",
      "dm_event.fields=nope",
      "expansions=nope",
      "event_types=Nope",
    ]) {
      const res = await call(`/2/dm_events?${q}`, dev);
      expect(res.status, q).toBe(400);
      expect(((await res.json()) as Json).type).toBe("https://api.x.com/2/problems/invalid-request");
    }
  });
});

describe("X direct messages: seeded history and paging", () => {
  it("pages through thousands of generated events newest first with no gaps or repeats", async () => {
    const { call, mint, store } = setup({
      dm_conversations: [
        { participants: ["developer", "alice"], generate: { count: 2500, interval_seconds: 30 } },
        {
          participants: ["developer", "bob"],
          messages: [{ from: "bob", text: "explicit seeded message" }],
          generate: { count: 120, interval_seconds: 600 },
        },
      ],
      // A backfill this size needs 27 reads; X allows 15 per 15 minutes.
      rate_limits: { enabled: false },
    });
    // Generated history is computed, not stored: one stored event in all.
    expect(getXStore(store).dmEvents.all()).toHaveLength(1);
    const dev = mint(DEV);
    const seen: string[] = [];
    let token: string | undefined;
    let pages = 0;
    do {
      const res = await call(`/2/dm_events?max_results=100${token ? `&pagination_token=${token}` : ""}`, dev);
      const body = (await res.json()) as Json;
      expect(res.status).toBe(200);
      for (const e of body.data ?? []) seen.push(e.id);
      token = body.meta.next_token;
      if (token) expect(token.length).toBeGreaterThanOrEqual(16);
      pages++;
    } while (token);
    expect(seen).toHaveLength(2500 + 120 + 1);
    expect(new Set(seen).size).toBe(seen.length);
    const sorted = [...seen].sort((a, b) => (BigInt(b) > BigInt(a) ? 1 : -1));
    expect(seen).toEqual(sorted);
    expect(pages).toBe(27);

    // previous_token returns the page before.
    const first = (await (
      await call(`/2/dm_conversations/with/${ALICE}/dm_events?max_results=50`, dev)
    ).json()) as Json;
    const second = (await (
      await call(
        `/2/dm_conversations/with/${ALICE}/dm_events?max_results=50&pagination_token=${first.meta.next_token}`,
        dev,
      )
    ).json()) as Json;
    expect(second.meta.previous_token).toBeDefined();
    const back = (await (
      await call(
        `/2/dm_conversations/with/${ALICE}/dm_events?max_results=50&pagination_token=${second.meta.previous_token}`,
        dev,
      )
    ).json()) as Json;
    expect(back.data.map((e: Json) => e.id)).toEqual(first.data.map((e: Json) => e.id));
  });

  it("seeds many conversations for one user with dm_bulk", async () => {
    const { call, mint } = setup({
      dm_bulk: { user: "developer", conversations: 40, events_per_conversation: 250 },
      rate_limits: { enabled: false },
    });
    let total = 0;
    let token: string | undefined;
    do {
      const body = (await (
        await call(`/2/dm_events?max_results=100${token ? `&pagination_token=${token}` : ""}`, mint(DEV))
      ).json()) as Json;
      total += body.meta.result_count;
      token = body.meta.next_token;
    } while (token);
    expect(total).toBe(40 * 250);
  });

  it("returns attachments with media includes for generated messages", async () => {
    const { call, mint } = setup({
      dm_conversations: [
        { participants: ["developer", "alice"], generate: { count: 10, attachment_every: 5, attachment_bytes: 4096 } },
      ],
    });
    const body = (await (
      await call(`/2/dm_events?expansions=attachments.media_keys&media.fields=url,type,width,height`, mint(DEV))
    ).json()) as Json;
    const withMedia = body.data.filter((e: Json) => e.attachments);
    expect(withMedia).toHaveLength(2);
    expect(body.includes.media).toHaveLength(2);
    const m = body.includes.media[0];
    expect(m.type).toBe("photo");
    expect(m.media_key).toMatch(/^3_[0-9]+$/);
    expect(m.url).toMatch(new RegExp(`^${base}/2/dm_conversations/media/[0-9]+/3_[0-9]+/[0-9]+$`));
  });

  it("hides events older than X's 30-day retention", async () => {
    const { call, mint } = setup({
      dm_conversations: [
        {
          participants: ["developer", "alice"],
          generate: {
            count: 10,
            start: new Date(Date.now() - 39.5 * 86400000).toISOString(),
            interval_seconds: 86400 * 2,
          },
        },
      ],
    });
    const body = (await (await call(`/2/dm_events`, mint(DEV))).json()) as Json;
    // Events at days -39.5, -37.5, ... -21.5: inside 30 days are -29.5, -27.5, -25.5, -23.5, -21.5.
    expect(body.meta.result_count).toBe(5);
  });
});

describe("X direct messages: control plane arrivals", () => {
  it("makes a message arrive that then appears in reads", async () => {
    const { app, call, mint } = setup();
    const res = await app.request(`${base}/_emulate/x/dm/arrive`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to: "developer", from: "alice", text: "incoming" }),
    });
    expect(res.status).toBe(200);
    const arrived = (await res.json()) as Json;
    expect(arrived.dm_conversation_id).toBe(`${DEV}-${ALICE}`);
    expect(arrived.deliveries).toEqual([]);
    const read = (await (await call(`/2/dm_events?dm_event.fields=sender_id`, mint(DEV))).json()) as Json;
    expect(read.data).toEqual([
      { id: arrived.dm_event_id, event_type: "MessageCreate", text: "incoming", sender_id: ALICE },
    ]);
  });
});

describe("X rate limits", () => {
  it("sends x-rate-limit headers and a 429 with code 88 after 15 DM reads per user", async () => {
    const { call, mint } = setup();
    const dev = mint(DEV);
    const before = Math.floor(Date.now() / 1000);
    for (let i = 1; i <= 15; i++) {
      const res = await call("/2/dm_events", dev);
      expect(res.status).toBe(200);
      expect(res.headers.get("x-rate-limit-limit")).toBe("15");
      expect(res.headers.get("x-rate-limit-remaining")).toBe(String(15 - i));
      const reset = Number(res.headers.get("x-rate-limit-reset"));
      expect(reset).toBeGreaterThanOrEqual(before + 900);
      expect(reset).toBeLessThanOrEqual(before + 902);
    }
    const spent = await call("/2/dm_events", dev);
    expect(spent.status).toBe(429);
    expect(await spent.json()).toEqual({ errors: [{ code: 88, message: "Rate limit exceeded" }] });
    expect(spent.headers.get("x-rate-limit-remaining")).toBe("0");
    // Another user, and another endpoint, have their own windows.
    expect((await call("/2/dm_events", mint(ALICE))).status).toBe(200);
    expect((await call(`/2/dm_conversations/with/${ALICE}/dm_events`, dev)).headers.get("x-rate-limit-remaining")).toBe(
      "14",
    );
    // The GitHub-shaped core limiter is off for X.
    expect(spent.headers.get("X-RateLimit-Resource")).toBeNull();
  });

  it("reports the tighter of the 15-minute and 24-hour windows on sends", async () => {
    const { call, mint } = setup();
    const res = await call(`/2/dm_conversations/with/${ALICE}/messages`, mint(DEV), {
      method: "POST",
      body: JSON.stringify({ text: "hi" }),
    });
    expect(res.headers.get("x-rate-limit-limit")).toBe("15");
    expect(res.headers.get("x-rate-limit-remaining")).toBe("14");
  });

  it("takes a per-instance limit and window from the seed and the control plane", async () => {
    const { app, call, mint } = setup({ rate_limits: { default: { limit: 3, window_seconds: 1 } } });
    const dev = mint(DEV);
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) statuses.push((await call("/2/dm_events", dev)).status);
    expect(statuses).toEqual([200, 200, 200, 429]);
    await new Promise((r) => setTimeout(r, 1100));
    expect((await call("/2/dm_events", dev)).status).toBe(200);

    const set = await app.request(`${base}/_emulate/x/rate-limits`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoints: { getDirectMessagesEvents: { limit: 2, window_seconds: 5 } } }),
    });
    expect(set.status).toBe(200);
    const after: number[] = [];
    for (let i = 0; i < 3; i++) after.push((await call("/2/dm_events", dev)).status);
    expect(after).toEqual([200, 200, 429]);
    const state = (await (await app.request(`${base}/_emulate/x/rate-limits`)).json()) as Json;
    expect(state.windows[0]).toMatchObject({ limit: 2, used: 2, remaining: 0 });

    const bad = await app.request(`${base}/_emulate/x/rate-limits`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoints: { notAnOperation: { limit: 1, window_seconds: 1 } } }),
    });
    expect(bad.status).toBe(400);
  });
});

describe("X request ledger", () => {
  it("records DM requests with operation id, status and the authenticated user, including 429s", async () => {
    const { call, mint, ledger } = setup({ rate_limits: { default: { limit: 2, window_seconds: 60 } } });
    const dev = mint(DEV);
    for (let i = 0; i < 3; i++) await call("/2/dm_events", dev);
    await call(`/2/dm_conversations/with/${ALICE}/messages`, dev, {
      method: "POST",
      body: JSON.stringify({ text: "x" }),
    });
    const entries = ledger.list().reverse();
    expect(entries.map((e) => [e.operationId, e.response.status])).toEqual([
      ["getDirectMessagesEvents", 200],
      ["getDirectMessagesEvents", 200],
      ["getDirectMessagesEvents", 429],
      ["createDirectMessagesByParticipantId", 201],
    ]);
    for (const e of entries) {
      expect(e.identity.user).toMatchObject({ login: "developer", externalId: DEV });
      expect(e.identity.app).toMatchObject({ slug: "dm-app" });
      expect(e.request.headers.authorization).toBe("[redacted]");
    }
    expect(entries[2]!.response.headers["x-rate-limit-remaining"]).toBe("0");
    const reads = entries.filter((e) => e.operationId === "getDirectMessagesEvents" && e.response.status === 200);
    expect(reads).toHaveLength(2);
  });
});
