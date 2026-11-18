import { describe, expect, it } from "vitest";
import { createServer } from "../server.js";
import { FaultRegistry } from "../faults.js";
import type { ServicePlugin } from "../plugin.js";

const plugin: ServicePlugin = {
  name: "demo",
  register(app) {
    app.get("/things", (c) => c.json({ things: [] }));
  },
};

const fault = {
  match: { method: "get", pathPattern: "/things" },
  response: { status: 503, body: { error: "planned" } },
};

type Armed = { id: string; remaining: number; idempotencyKey?: string };

function setup() {
  const server = createServer(plugin, {
    baseUrl: "https://demo.instance.emulators.dev",
    reset() {
      server.ledger.clear();
    },
  });
  const { app } = server;
  const arm = async (body: Record<string, unknown>) => {
    const res = await app.request("/_emulate/faults", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as { fault: Armed; replayed?: boolean; error?: string } };
  };
  const list = async () =>
    (await (await app.request("/_emulate/faults")).json()) as { faults: Armed[]; idempotencyKeys?: boolean };
  const things = async () => (await app.request("/things")).status;
  return { server, app, arm, list, things };
}

describe("fault idempotency keys", () => {
  it("returns the fault first stored for a key to a second arm sent after it, and stores nothing", async () => {
    const { arm, list, things } = setup();
    const first = await arm({ ...fault, idempotencyKey: "arm-1" });
    const second = await arm({ ...fault, idempotencyKey: "arm-1" });
    expect(first.status).toBe(200);
    expect(first.body.replayed).toBe(false);
    expect(second.status).toBe(200);
    expect(second.body.replayed).toBe(true);
    expect(second.body.fault.id).toBe(first.body.fault.id);
    expect(second.body.fault.idempotencyKey).toBe("arm-1");
    expect((await list()).faults.map((f) => f.id)).toEqual([first.body.fault.id]);
    expect(await things()).toBe(503);
    expect(await things()).toBe(200);
  });

  it("stores one fault for two arms with one key sent at once", async () => {
    const { arm, list } = setup();
    const both = await Promise.all([
      arm({ ...fault, idempotencyKey: "arm-1" }),
      arm({ ...fault, idempotencyKey: "arm-1" }),
    ]);
    expect(both.map((r) => r.status)).toEqual([200, 200]);
    expect(new Set(both.map((r) => r.body.fault.id)).size).toBe(1);
    expect(both.map((r) => r.body.replayed).sort()).toEqual([false, true]);
    expect((await list()).faults).toHaveLength(1);
  });

  it("does not re-arm when a late copy arrives after its fault was consumed, removed, cleared or reset", async () => {
    const { app, arm, list, things } = setup();
    // Consumed.
    const consumed = await arm({ ...fault, idempotencyKey: "consumed" });
    expect(await things()).toBe(503);
    const lateConsumed = await arm({ ...fault, idempotencyKey: "consumed" });
    expect(lateConsumed.body.replayed).toBe(true);
    expect(lateConsumed.body.fault).toMatchObject({ id: consumed.body.fault.id, remaining: 0 });
    expect((await list()).faults).toEqual([]);
    expect(await things()).toBe(200);

    // Removed by id.
    const removed = await arm({ ...fault, idempotencyKey: "removed" });
    await app.request(`/_emulate/faults/${removed.body.fault.id}`, { method: "DELETE" });
    const lateRemoved = await arm({ ...fault, idempotencyKey: "removed" });
    expect(lateRemoved.body).toMatchObject({ replayed: true, fault: { id: removed.body.fault.id, remaining: 0 } });
    expect((await list()).faults).toEqual([]);
    expect(await things()).toBe(200);

    // Every fault cleared, then the instance reset.
    await arm({ ...fault, idempotencyKey: "cleared" });
    await app.request("/_emulate/faults", { method: "DELETE" });
    await arm({ ...fault, idempotencyKey: "reset" });
    await app.request("/_emulate/reset", { method: "POST" });
    expect((await arm({ ...fault, idempotencyKey: "cleared" })).body.replayed).toBe(true);
    expect((await arm({ ...fault, idempotencyKey: "reset" })).body.replayed).toBe(true);
    expect((await list()).faults).toEqual([]);
    expect(await things()).toBe(200);
  });

  it("refuses a key used again for a different fault, and keeps the first", async () => {
    const { arm, list } = setup();
    const first = await arm({ ...fault, idempotencyKey: "arm-1" });
    const other = await arm({ ...fault, times: 2, idempotencyKey: "arm-1" });
    expect(other.status).toBe(409);
    expect(other.body.error).toBe("idempotency_key_conflict");
    const otherStatus = await arm({ ...fault, response: { status: 500 }, idempotencyKey: "arm-1" });
    expect(otherStatus.status).toBe(409);
    expect((await list()).faults.map((f) => f.id)).toEqual([first.body.fault.id]);
    // The same fault written differently (method case, key order, `times` defaulted) is the same fault.
    const same = await arm({
      response: { body: { error: "planned" }, status: 503 },
      match: { pathPattern: "/things", method: "GET" },
      times: 1,
      idempotencyKey: "arm-1",
    });
    expect(same.status).toBe(200);
    expect(same.body.fault.id).toBe(first.body.fault.id);
    expect((await arm({ ...fault, idempotencyKey: "" })).status).toBe(400);
  });

  it("stores every arm without a key as before, and says it honors keys", async () => {
    const { arm, list } = setup();
    const keyed = await arm({ ...fault, idempotencyKey: "arm-1" });
    const a = await arm(fault);
    const b = await arm(fault);
    expect(a.body).not.toHaveProperty("replayed");
    expect(a.body.fault).not.toHaveProperty("idempotencyKey");
    expect(new Set([keyed.body.fault.id, a.body.fault.id, b.body.fault.id]).size).toBe(3);
    const listed = await list();
    expect(listed.faults).toHaveLength(3);
    expect(listed.idempotencyKeys).toBe(true);
  });

  it("keeps the record of keys through a snapshot and restore, consumed faults included", () => {
    const registry = new FaultRegistry();
    const live = registry.arm({ ...fault, idempotencyKey: "live" });
    const spent = registry.arm({ ...fault, idempotencyKey: "spent" });
    registry.clear(spent.id);
    const restored = new FaultRegistry();
    restored.restore(JSON.parse(JSON.stringify(registry.serialize())));
    expect(restored.armOnce({ ...fault, idempotencyKey: "live" })).toMatchObject({
      replayed: true,
      fault: { id: live.id, remaining: 1 },
    });
    expect(restored.armOnce({ ...fault, idempotencyKey: "spent" })).toMatchObject({
      replayed: true,
      fault: { id: spent.id, remaining: 0 },
    });
    expect(restored.list().map((f) => f.id)).toEqual([live.id]);
    expect(() => restored.armOnce({ ...fault, times: 3, idempotencyKey: "spent" })).toThrow(/different fault/);
    // A snapshot stored before keys existed restores with none.
    const old = new FaultRegistry();
    old.restore({ counter: 4, faults: [] });
    expect(old.arm(fault).id).toBe("fault_4");
  });
});
