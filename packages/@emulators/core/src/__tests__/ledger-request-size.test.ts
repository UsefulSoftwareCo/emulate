import { describe, expect, it } from "vitest";
import { createServer } from "../server.js";
import type { ServicePlugin } from "../plugin.js";

const plugin: ServicePlugin = {
  name: "probe",
  register(app) {
    app.post("/plain", async (c) => c.json({ got: (await c.req.json()) as unknown }));
    app.post("/sized", async (c) => {
      const raw = await c.req.text();
      c.set("ledgerRequestBodyBytes", Buffer.byteLength(raw));
      return c.json({ bytes: raw.length });
    });
  },
};

describe("ledger request body recording", () => {
  it("records request bodies as before unless the handler asks for size only", async () => {
    const { app, ledger } = createServer(plugin);
    const body = JSON.stringify({ note: "content" });
    await app.request("http://localhost:4000/plain", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    await app.request("http://localhost:4000/sized", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    const [sized, plain] = ledger.list();
    expect(plain!.request.body).toEqual({ note: "content" });
    expect(plain!.request.bodyBytes).toBeUndefined();
    expect(sized!.request.body).toBe(`<request body omitted: ${body.length} bytes>`);
    expect(sized!.request.bodyBytes).toBe(body.length);
  });
});
