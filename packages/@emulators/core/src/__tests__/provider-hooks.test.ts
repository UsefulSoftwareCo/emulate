import { createServer as createHttpServer, type Server } from "http";
import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "../server.js";
import { WebhookDispatcher } from "../webhooks.js";
import type { ServicePlugin } from "../plugin.js";

function plugin(extra: Partial<ServicePlugin> = {}): ServicePlugin {
  return {
    name: "probe",
    register(app) {
      app.get("/thing", (c) => c.json({ ok: true }));
      app.get("/blob", (c) => {
        c.set("ledgerOmitResponseBody", true);
        return new Response("binary bytes", { headers: { "content-type": "application/octet-stream" } });
      });
      app.get(
        "/plain-blob",
        () => new Response("binary bytes", { headers: { "content-type": "application/octet-stream" } }),
      );
    },
    ...extra,
  };
}

describe("shared rate limiter", () => {
  it("keeps the GitHub-shaped headers for a plugin that does not opt out", async () => {
    const { app } = createServer(plugin());
    const res = await app.request("http://localhost:4000/thing");
    expect(res.headers.get("X-RateLimit-Limit")).toBe("5000");
    expect(res.headers.get("X-RateLimit-Remaining")).toBe("4999");
    expect(res.headers.get("X-RateLimit-Resource")).toBe("core");
  });

  it("is off for a plugin that installs its own limiter", async () => {
    const { app } = createServer(plugin({ rateLimit: "provider" }));
    const res = await app.request("http://localhost:4000/thing");
    expect(res.status).toBe(200);
    expect(res.headers.get("X-RateLimit-Limit")).toBeNull();
    expect(res.headers.get("X-RateLimit-Resource")).toBeNull();
  });
});

describe("ledger body omission", () => {
  it("records a placeholder only when the handler asks, and reads the body otherwise", async () => {
    const { app, ledger } = createServer(plugin());
    await app.request("http://localhost:4000/blob");
    await app.request("http://localhost:4000/plain-blob");
    const [plain, omitted] = ledger.list();
    expect(omitted!.response.body).toBe("<binary body omitted>");
    expect(plain!.response.body).toBe("binary bytes");
  });
});

describe("WebhookDispatcher.deliver", () => {
  const servers: Server[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
  });

  it("sends the exact headers and body and records the delivery", async () => {
    const got: Array<{ headers: Record<string, unknown>; body: string }> = [];
    const server = createHttpServer((req, res) => {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        got.push({ headers: req.headers, body });
        res.writeHead(202);
        res.end();
      });
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/hook`;
    const dispatcher = new WebhookDispatcher();
    const body = '{"a":1}';
    const delivery = await dispatcher.deliver({
      hookRef: "1234567890123456789",
      event: "probe.event",
      url,
      headers: { "content-type": "application/json", "x-probe-signature": "sig" },
      body,
    });
    expect(got).toEqual([{ headers: expect.objectContaining({ "x-probe-signature": "sig" }), body }]);
    expect(delivery).toMatchObject({
      event: "probe.event",
      status_code: 202,
      success: true,
      hook_ref: "1234567890123456789",
      url,
    });
    expect(delivery.payload).toEqual({ a: 1 });
    expect(dispatcher.getDeliveries()).toHaveLength(1);
  });

  it("records an unreachable address as a failed delivery without throwing", async () => {
    const dispatcher = new WebhookDispatcher();
    const delivery = await dispatcher.deliver({ event: "e", url: "http://127.0.0.1:9/", headers: {}, body: "x" });
    expect(delivery).toMatchObject({ success: false, status_code: null, payload: "x" });
  });
});

describe("Store.requestPersist", () => {
  it("is off until a plugin asks, and each request is taken once", async () => {
    const { Store } = await import("../store.js");
    const store = new Store();
    expect(store.takePersistRequest()).toBe(false);
    store.requestPersist();
    expect(store.takePersistRequest()).toBe(true);
    expect(store.takePersistRequest()).toBe(false);
  });
});
