import { createHash, createHmac, randomBytes } from "crypto";
import { createServer as createHttpServer, type IncomingHttpHeaders, type Server } from "http";
import { afterEach, describe, expect, it } from "vitest";
import { EmulatorDurableObject } from "../durable-object.js";

/** In-memory Durable Object state that counts writes, like the host tests' own helper. */
function makeState() {
  const storage = new Map<string, unknown>();
  const puts: string[] = [];
  const clone = <T>(value: T): T => (value === undefined ? value : JSON.parse(JSON.stringify(value)));
  return {
    storage,
    puts,
    state: {
      storage: {
        async get<T>(key: string): Promise<T | undefined> {
          return clone(storage.get(key) as T | undefined);
        },
        async put(key: string, value: unknown): Promise<void> {
          const size = new TextEncoder().encode(JSON.stringify(value)).length;
          if (size > 128 * 1024) throw new Error(`Values cannot be larger than 131072 bytes (got ${size}).`);
          puts.push(key);
          storage.set(key, clone(value));
        },
        async delete(key: string | string[]): Promise<boolean | number> {
          if (Array.isArray(key)) return key.filter((k) => storage.delete(k)).length;
          return storage.delete(key);
        },
        async list<T>(options?: { prefix?: string }): Promise<Map<string, T>> {
          const out = new Map<string, T>();
          for (const [key, value] of storage) {
            if (!options?.prefix || key.startsWith(options.prefix)) out.set(key, clone(value) as T);
          }
          return out;
        },
      },
      async blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T> {
        return fn();
      },
    },
  };
}

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const DEV = "1000000000000000001";
const ALICE = "1000000000000000002";
const SECRET = "hosted-secret";

function hosted(base: string, instance: string) {
  const env = makeState();
  const headers = { "x-emulator-service": "x", "x-emulator-instance": instance, "x-emulator-base-url": base };
  let object = new EmulatorDurableObject(env.state, {});
  const request = (path: string, init: RequestInit = {}) =>
    object.fetch(
      new Request(`${new URL(base).origin}${path}`, { ...init, headers: { ...headers, ...(init.headers as object) } }),
    );
  return {
    ...env,
    request,
    /** Drop the in-memory instance, as Cloudflare does when it evicts the object. */
    evict() {
      object = new EmulatorDurableObject(env.state, {});
    },
    async seed(config: Json) {
      const res = await request("/__seed", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ x: config }),
      });
      expect(res.status).toBe(200);
    },
    /** A user-context token for `userId`, through the real authorize and token routes. */
    async userToken(userId: string, scope = "dm.read dm.write tweet.read users.read media.write") {
      const verifier = randomBytes(40).toString("base64url");
      const challenge = createHash("sha256").update(verifier).digest("base64url");
      const consent = await request("/2/oauth2/authorize/consent", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          user_id: userId,
          client_id: "hosted-app",
          redirect_uri: "https://app.example.test/callback",
          scope,
          state: "s",
          code_challenge: challenge,
          code_challenge_method: "S256",
        }).toString(),
      });
      const code = new URL(consent.headers.get("location")!).searchParams.get("code")!;
      const token = await request("/2/oauth2/token", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          authorization: "Basic " + Buffer.from(`hosted-app:${SECRET}`).toString("base64"),
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: "https://app.example.test/callback",
          code_verifier: verifier,
        }).toString(),
      });
      expect(token.status).toBe(200);
      return ((await token.json()) as Json).access_token as string;
    },
  };
}

const baseSeed = {
  users: [
    { username: "dmowner", user_id: DEV },
    { username: "alice", user_id: ALICE },
  ],
  oauth_clients: [
    {
      client_id: "hosted-app",
      client_secret: SECRET,
      client_type: "confidential",
      redirect_uris: ["https://app.example.test/callback"],
    },
  ],
};

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

async function receiver() {
  const received: Array<{ method: string; headers: IncomingHttpHeaders; body: string; url: string }> = [];
  const server = createHttpServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      received.push({ method: req.method!, headers: req.headers, body, url: req.url! });
      const token = new URL(req.url!, "http://x").searchParams.get("crc_token");
      if (req.method === "GET" && token) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({ response_token: "sha256=" + createHmac("sha256", SECRET).update(token).digest("base64") }),
        );
        return;
      }
      res.writeHead(200);
      res.end();
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}/hook`, received };
}

describe("X on the Cloudflare host", () => {
  it("keeps rate-limit windows and read ledger entries across eviction between GETs", async () => {
    const h = hosted("https://emulators.dev/x/limits", "limits");
    await h.seed({ ...baseSeed, rate_limits: { default: { limit: 3, window_seconds: 300 } } });
    const token = await h.userToken(DEV);
    const read = () => h.request("/2/dm_events", { headers: { authorization: `Bearer ${token}` } });

    const before = h.puts.length;
    const first = await read();
    expect(first.headers.get("x-rate-limit-remaining")).toBe("2");
    // What a read costs a hosted X instance: the ledger entry, the ledger index,
    // and the rate-limit window, written as separate storage values.
    const written = h.puts.slice(before);
    expect(written.some((k) => k.startsWith("ledger:"))).toBe(true);
    expect(written.length).toBeLessThanOrEqual(4);

    expect((await read()).headers.get("x-rate-limit-remaining")).toBe("1");
    h.evict();
    expect((await read()).headers.get("x-rate-limit-remaining")).toBe("0");
    h.evict();
    const spent = await read();
    expect(spent.status).toBe(429);

    h.evict();
    const ledger = (await (await h.request("/_emulate/ledger")).json()) as Json;
    const reads = (ledger.entries as Json[]).filter((e) => e.operationId === "getDirectMessagesEvents");
    expect(reads.map((e) => e.response.status).reverse()).toEqual([200, 200, 200, 429]);
    expect(reads.every((e) => e.identity.user.externalId === DEV)).toBe(true);
  });

  it("leaves other services' reads unwritten", async () => {
    const env = makeState();
    const object = new EmulatorDurableObject(env.state, {});
    const headers = {
      "x-emulator-service": "github",
      "x-emulator-instance": "gh",
      "x-emulator-base-url": "https://emulators.dev/github/gh",
    };
    await object.fetch(new Request("https://emulators.dev/_emulate/manifest", { headers }));
    const before = env.puts.length;
    await object.fetch(new Request("https://emulators.dev/repos/acme/widget", { headers }));
    expect(env.puts.length).toBe(before);
  });

  it("streams a large DM attachment from the hosted object without storing its bytes", async () => {
    const h = hosted("https://emulators.dev/x/media", "media");
    await h.seed({
      ...baseSeed,
      dm_conversations: [
        {
          participants: ["dmowner", "alice"],
          messages: [{ from: "alice", text: "big", attachment: { bytes: 8 * 1024 * 1024, media_type: "image/jpeg" } }],
        },
      ],
    });
    const token = await h.userToken(DEV);
    const auth = { authorization: `Bearer ${token}` };
    const list = (await (
      await h.request("/2/dm_events?expansions=attachments.media_keys&media.fields=url", { headers: auth })
    ).json()) as Json;
    const url = new URL(list.includes.media[0].url);
    expect(url.origin + url.pathname).toMatch(/^https:\/\/emulators\.dev\/x\/media\/2\/dm_conversations\/media\//);
    const dl = await h.request(url.pathname.replace("/x/media", ""), { headers: auth });
    expect(dl.status).toBe(200);
    expect(dl.headers.get("content-length")).toBe(String(8 * 1024 * 1024));
    let total = 0;
    const reader = dl.body!.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
    }
    expect(total).toBe(8 * 1024 * 1024);
    expect([...h.storage.keys()].some((k) => k.includes("x.media_chunks"))).toBe(false);
  });

  it("uploads several megabytes in chunks that fit Durable Object values, across eviction", async () => {
    const h = hosted("https://emulators.dev/x/upload", "upload");
    await h.seed(baseSeed);
    const token = await h.userToken(DEV);
    const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const file = randomBytes(5 * 1024 * 1024);
    const init = (await (
      await h.request("/2/media/upload/initialize", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ media_category: "dm_image", media_type: "image/jpeg", total_bytes: file.length }),
      })
    ).json()) as Json;
    for (let i = 0; i * 2 * 1024 * 1024 < file.length; i++) {
      const res = await h.request(`/2/media/upload/${init.data.id}/append`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({
          segment_index: i,
          media: file.subarray(i * 2 * 1024 * 1024, (i + 1) * 2 * 1024 * 1024).toString("base64"),
        }),
      });
      expect(res.status).toBe(200);
    }
    h.evict();
    expect(
      (await h.request(`/2/media/upload/${init.data.id}/finalize`, { method: "POST", headers: auth })).status,
    ).toBe(200);
    const sent = (await (
      await h.request(`/2/dm_conversations/with/${ALICE}/messages`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ attachments: [{ media_id: init.data.id }] }),
      })
    ).json()) as Json;
    h.evict();
    const aliceToken = await h.userToken(ALICE);
    const dl = await h.request(
      `/2/dm_conversations/media/${sent.data.dm_event_id}/${init.data.media_key}/${init.data.id}`,
      { headers: { authorization: `Bearer ${aliceToken}` } },
    );
    expect(Buffer.from(await dl.arrayBuffer()).equals(file)).toBe(true);
  });

  it("runs the CRC and delivers signed DM events to a webhook from the hosted object", async () => {
    const r = await receiver();
    // An http base address relaxes X's https-only rule so the local receiver can register.
    const h = hosted("http://127.0.0.1:8787/x/hooks", "hooks");
    await h.seed(baseSeed);
    const dev = await h.userToken(DEV);
    const alice = await h.userToken(ALICE);
    const app = (await (
      await h.request("/2/oauth2/token", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          authorization: "Basic " + Buffer.from(`hosted-app:${SECRET}`).toString("base64"),
        },
        body: "grant_type=client_credentials",
      })
    ).json()) as Json;
    const created = await h.request("/2/webhooks", {
      method: "POST",
      headers: { authorization: `Bearer ${app.access_token}`, "content-type": "application/json" },
      body: JSON.stringify({ url: r.url }),
    });
    expect(created.status).toBe(200);
    const hook = ((await created.json()) as Json).data;
    expect(r.received[0]!.method).toBe("GET");
    h.evict();
    const sub = await h.request("/2/activity/subscriptions", {
      method: "POST",
      headers: { authorization: `Bearer ${alice}`, "content-type": "application/json" },
      body: JSON.stringify({ event_type: "dm.received", filter: { user_id: ALICE }, webhook_id: hook.id }),
    });
    expect(sub.status).toBe(200);
    h.evict();
    await h.request(`/2/dm_conversations/with/${ALICE}/messages`, {
      method: "POST",
      headers: { authorization: `Bearer ${dev}`, "content-type": "application/json" },
      body: JSON.stringify({ text: "hello from the host" }),
    });
    const post = r.received.find((x) => x.method === "POST")!;
    expect(post.headers["x-twitter-webhooks-signature-oauth2"]).toBe(
      "sha256=" + createHmac("sha256", SECRET).update(post.body).digest("base64"),
    );
    expect(JSON.parse(post.body).data.event_type).toBe("dm.received");

    // The arrival and preview control calls work on the host too.
    const arrived = (await (
      await h.request("/_emulate/x/dm/arrive", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ to: "alice", from: "dmowner", text: "second" }),
      })
    ).json()) as Json;
    expect(arrived.deliveries).toHaveLength(1);
    h.evict();
    const preview = (await (
      await h.request("/_emulate/x/dm/preview-delivery", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ dm_event_id: arrived.dm_event_id }),
      })
    ).json()) as Json;
    const delivered = r.received.filter((x) => x.method === "POST").at(-1)!;
    expect(preview.deliveries[0].body).toBe(delivered.body);
  });
});
