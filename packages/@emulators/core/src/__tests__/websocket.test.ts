import { afterEach, describe, expect, it } from "vitest";
import { upgradeWebSocket } from "../websocket.js";

type Listener = (event: Record<string, unknown>) => void;

/** A stand-in for the Workers runtime's WebSocketPair: records what the server end does. */
class FakeSocket {
  sent: Array<string | ArrayBuffer> = [];
  closedWith: [number, string] | null = null;
  accepted = false;
  private listeners = new Map<string, Listener[]>();
  accept() {
    this.accepted = true;
  }
  send(data: string | ArrayBuffer) {
    this.sent.push(data);
  }
  close(code: number, reason: string) {
    this.closedWith = [code, reason];
  }
  addEventListener(type: string, fn: Listener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  emit(type: string, event: Record<string, unknown>) {
    for (const fn of this.listeners.get(type) ?? []) fn(event);
  }
}

let server: FakeSocket;
const g = globalThis as Record<string, unknown>;
const original = g.WebSocketPair;
const RealResponse = Response;
afterEach(() => {
  g.WebSocketPair = original;
  g.Response = RealResponse;
});
function installPair() {
  // Node's Response refuses status 101; the Workers runtime allows it with a webSocket.
  g.Response = class extends RealResponse {
    constructor(body?: ConstructorParameters<typeof Response>[0], init?: ResponseInit) {
      super(body, init?.status === 101 ? { ...init, status: 200 } : init);
      if (init?.status === 101) Object.defineProperty(this, "status", { value: 101 });
    }
  };
  (globalThis as Record<string, unknown>).WebSocketPair = class {
    0 = new FakeSocket();
    1 = (server = new FakeSocket());
  };
}

const upgrade = () => new Request("https://emulators.dev/x", { headers: { upgrade: "websocket" } });

describe("upgradeWebSocket on the Workers runtime", () => {
  it("answers 101, reads Blob messages in order, sends binary as its own buffer, and echoes the client's close", async () => {
    installPair();
    const got: Array<string | Uint8Array> = [];
    const closes: number[] = [];
    const res = upgradeWebSocket(upgrade(), {
      message: (peer, data) => {
        got.push(data);
        peer.send(data);
      },
      close: (code) => closes.push(code),
    });
    expect(res.status).toBe(101);
    expect(server.accepted).toBe(true);
    server.emit("message", { data: new Blob([new Uint8Array([1, 2, 3])]) });
    server.emit("message", { data: "after" });
    server.emit("message", { data: new Uint8Array([9]).buffer });
    await new Promise((r) => setTimeout(r, 20));
    expect(got.map((d) => (typeof d === "string" ? d : [...d]))).toEqual([[1, 2, 3], "after", [9]]);
    expect(server.sent[0]).toBeInstanceOf(ArrayBuffer);
    expect([...new Uint8Array(server.sent[0] as ArrayBuffer)]).toEqual([1, 2, 3]);
    server.emit("close", { code: 1000, reason: "bye" });
    expect(server.closedWith).toEqual([1000, "bye"]);
    expect(closes).toEqual([1000]);
  });

  it("answers a close without a code with 1000, and a plain request with 426", () => {
    installPair();
    upgradeWebSocket(upgrade(), {});
    server.emit("close", { code: 1005, reason: "" });
    expect(server.closedWith).toEqual([1000, ""]);
    expect(upgradeWebSocket(new Request("https://emulators.dev/x"), {}).status).toBe(426);
  });
});
