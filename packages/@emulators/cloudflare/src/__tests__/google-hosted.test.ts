import { createServer as createHttpServer, type IncomingHttpHeaders, type Server } from "http";
import { afterEach, describe, expect, it } from "vitest";
import { EmulatorDurableObject } from "../durable-object.js";

function makeState() {
  const storage = new Map<string, unknown>();
  const clone = <T>(value: T): T => (value === undefined ? value : JSON.parse(JSON.stringify(value)));
  return {
    storage,
    state: {
      storage: {
        async get<T>(key: string): Promise<T | undefined> {
          return clone(storage.get(key) as T | undefined);
        },
        async put(key: string, value: unknown): Promise<void> {
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
const base = "https://emulators.dev/google/push-run";
const USER = "inbox@example.test";
const REDIRECT = "https://app.example.test/callback";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

async function receiver() {
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

describe("Gmail on the Cloudflare host", () => {
  it("watches, pushes a verifiable notification, previews it, and answers getProfile across eviction", async () => {
    const r = await receiver();
    const env = makeState();
    const headers = { "x-emulator-service": "google", "x-emulator-instance": "push-run", "x-emulator-base-url": base };
    let object = new EmulatorDurableObject(env.state, {});
    const evict = () => (object = new EmulatorDurableObject(env.state, {}));
    const request = (path: string, init: RequestInit = {}) =>
      object.fetch(
        new Request(`https://emulators.dev${path}`, { ...init, headers: { ...headers, ...(init.headers as object) } }),
      );
    const json = (path: string, body: unknown, extra: Record<string, string> = {}) =>
      request(path, {
        method: "POST",
        headers: { "content-type": "application/json", ...extra },
        body: JSON.stringify(body),
      });

    const seeded = await json("/__seed", {
      google: {
        users: [{ email: USER, name: "Inbox" }],
        oauth_clients: [{ client_id: "push-client", client_secret: "push-secret", redirect_uris: [REDIRECT] }],
        pubsub_push_subscriptions: [
          { name: "projects/demo/subscriptions/gmail", topic: "projects/demo/topics/gmail", push_endpoint: r.url },
        ],
      },
    });
    expect(seeded.status).toBe(200);

    // Sign in with client_secret_basic, the method discovery advertises.
    const authorized = await request("/o/oauth2/v2/auth/callback", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        email: USER,
        redirect_uri: REDIRECT,
        scope: "openid email https://www.googleapis.com/auth/gmail.modify",
        client_id: "push-client",
      }).toString(),
    });
    const code = new URL(authorized.headers.get("location")!).searchParams.get("code")!;
    const tokenRes = await request("/oauth2/token", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: "Basic " + Buffer.from("push-client:push-secret").toString("base64"),
      },
      body: new URLSearchParams({ code, grant_type: "authorization_code", redirect_uri: REDIRECT }).toString(),
    });
    expect(tokenRes.status).toBe(200);
    const auth = { authorization: `Bearer ${((await tokenRes.json()) as Json).access_token}` };

    evict();
    const watch = await json(
      "/gmail/v1/users/me/watch",
      { topicName: "projects/demo/topics/gmail", labelIds: ["INBOX"] },
      auth,
    );
    expect(watch.status).toBe(200);

    evict();
    const arrived = (await (
      await json("/_emulate/google/gmail/arrive", {
        to: USER,
        from: "news@example.com",
        subject: "Weekly",
        text: "hello",
        headers: [{ name: "List-Id", value: "Weekly <weekly.example.com>" }],
      })
    ).json()) as Json;
    expect(arrived.pushes).toEqual([expect.objectContaining({ acknowledged: true, status_code: 204 })]);
    const push = r.received[0]!;
    const body = JSON.parse(push.body) as Json;
    expect(JSON.parse(Buffer.from(body.message.data, "base64").toString())).toEqual({
      emailAddress: USER,
      historyId: arrived.historyId,
    });
    // Verify as a receiver would, with the keys the instance publishes at /oauth2/v3/certs.
    evict();
    const keys = ((await (await request("/oauth2/v3/certs")).json()) as { keys: Array<Json> }).keys;
    const token = String(push.headers.authorization).replace(/^Bearer /, "");
    const [h64, p64, s64] = token.split(".") as [string, string, string];
    const header = JSON.parse(Buffer.from(h64, "base64url").toString()) as Json;
    expect(header.alg).toBe("RS256");
    const jwk = keys.find((k) => k.kid === header.kid)!;
    const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, [
      "verify",
    ]);
    const valid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      Buffer.from(s64, "base64url"),
      new TextEncoder().encode(`${h64}.${p64}`),
    );
    expect(valid).toBe(true);
    const payload = JSON.parse(Buffer.from(p64, "base64url").toString()) as Json;
    expect(payload).toMatchObject({ iss: base, aud: r.url, email_verified: true });
    expect(payload.exp).toBeGreaterThan(Date.now() / 1000);
    expect(payload.email).toBe("gmail-push@demo.iam.gserviceaccount.com");

    evict();
    const preview = (await (await json("/_emulate/google/gmail/preview-push", { email: USER })).json()) as Json;
    expect(preview.pushes[0].url).toBe(r.url);
    expect(r.received).toHaveLength(1);

    const profile = (await (await request("/gmail/v1/users/me/profile", { headers: auth })).json()) as Json;
    expect(profile).toMatchObject({ emailAddress: USER, messagesTotal: 1, historyId: arrived.historyId });
    const listed = (await (
      await request(`/gmail/v1/users/me/messages?q=${encodeURIComponent("list:weekly.example.com")}`, { headers: auth })
    ).json()) as Json;
    expect(listed.messages).toHaveLength(1);
  });

  it("names the token route that exists in issued credentials", async () => {
    const env = makeState();
    const object = new EmulatorDurableObject(env.state, {});
    const headers = { "x-emulator-service": "google", "x-emulator-instance": "cred", "x-emulator-base-url": base };
    const res = await object.fetch(
      new Request("https://emulators.dev/_emulate/credentials", {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ type: "oauth-authorization-code", redirect_uris: [REDIRECT] }),
      }),
    );
    const { credential } = (await res.json()) as Json;
    expect(credential.token_url).toBe(`${base}/oauth2/token`);
  });
});
