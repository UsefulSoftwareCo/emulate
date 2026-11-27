import { afterEach, describe, expect, it } from "vitest";
import { createServer, serveOnFreePort, type FreePortServer } from "@emulators/core";
import { openaiPlugin } from "../index.js";

const servers: FreePortServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

async function start() {
  const http = await serveOnFreePort({ hostname: "127.0.0.1" });
  servers.push(http);
  const base = `127.0.0.1:${http.port}`;
  const emulator = createServer(openaiPlugin, { baseUrl: `http://${base}` });
  http.use(emulator.app.fetch);
  return { base, emulator };
}

/** Open a socket with Node's own WebSocket client and collect what arrives. */
function connect(url: string) {
  const ws = new WebSocket(url);
  ws.binaryType = "arraybuffer";
  const received: Array<{ data: string | ArrayBuffer; at: number }> = [];
  const opened = new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve());
    ws.addEventListener("error", () => reject(new Error("socket error")));
  });
  const closed = new Promise<{ code: number; wasClean: boolean }>((resolve) =>
    ws.addEventListener("close", (e) => resolve(e as unknown as { code: number; wasClean: boolean })),
  );
  ws.addEventListener("message", (e) => received.push({ data: (e as MessageEvent).data, at: Date.now() }));
  const until = async (n: number, ms = 5000) => {
    const end = Date.now() + ms;
    while (received.length < n && Date.now() < end) await new Promise((r) => setTimeout(r, 5));
    return received;
  };
  return { ws, received, opened, closed, until };
}

describe("emulator WebSocket control", () => {
  it("echoes text and binary messages and closes cleanly with the client's code", async () => {
    const { base } = await start();
    const c = connect(`ws://${base}/_emulate/openai/websocket`);
    await c.opened;
    c.ws.send("hello");
    c.ws.send(new Uint8Array([0, 1, 2, 255]));
    const long = "x".repeat(70_000); // a 64-bit length frame
    c.ws.send(long);
    const got = await c.until(3);
    expect(got[0]!.data).toBe("hello");
    expect([...new Uint8Array(got[1]!.data as ArrayBuffer)]).toEqual([0, 1, 2, 255]);
    expect(got[2]!.data).toBe(long);
    c.ws.close(1000, "done");
    const e = await c.closed;
    expect([e.code, e.wasClean]).toEqual([1000, true]);
  });

  it("sends the asked number of messages, interval apart, then stays open until closed", async () => {
    const { base } = await start();
    const c = connect(`ws://${base}/_emulate/openai/websocket?chunks=4&interval_ms=60`);
    await c.opened;
    const t0 = Date.now();
    const got = await c.until(4);
    expect(got.map((m) => JSON.parse(m.data as string).n)).toEqual([1, 2, 3, 4]);
    expect(got.every((m) => JSON.parse(m.data as string).of === 4)).toBe(true);
    expect(got[3]!.at - t0).toBeGreaterThanOrEqual(4 * 60 - 15);
    for (let i = 1; i < 4; i++) expect(got[i]!.at - got[i - 1]!.at).toBeGreaterThanOrEqual(45);
    // Still open and still echoing after the paced messages.
    await new Promise((r) => setTimeout(r, 150));
    expect(c.received).toHaveLength(4);
    c.ws.send("still here");
    expect((await c.until(5))[4]!.data).toBe("still here");
    c.ws.close();
    const e = await c.closed;
    expect(e.wasClean).toBe(true);
  });

  it("answers a plain GET with 426 and refuses bad pacing values", async () => {
    const { base } = await start();
    const plain = await fetch(`http://${base}/_emulate/openai/websocket`);
    expect(plain.status).toBe(426);
    expect(plain.headers.get("upgrade")).toBe("websocket");
    expect((await fetch(`http://${base}/_emulate/openai/websocket?chunks=-1`)).status).toBe(400);
    const bad = connect(`ws://${base}/_emulate/openai/websocket?interval_ms=60001`);
    await expect(bad.opened).rejects.toThrow();
  });
});
