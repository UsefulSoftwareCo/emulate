import { createHash } from "crypto";
import type { Duplex } from "stream";
import type { WebSocketPeer, WebSocketSession } from "./websocket.js";

// The server side of RFC 6455 for Node's `upgrade` event: the opening handshake,
// client frames (always masked; fragmented messages reassembled), ping/pong, and
// the closing handshake. Enough for the emulator's own WebSocket controls.

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
/** The largest message accepted; a bigger one closes the connection with 1009. */
export const MAX_WEBSOCKET_MESSAGE_BYTES = 1024 * 1024;

const OP = { continuation: 0x0, text: 0x1, binary: 0x2, close: 0x8, ping: 0x9, pong: 0xa } as const;

function frame(opcode: number, payload: Uint8Array): Buffer {
  const len = payload.length;
  const head = len < 126 ? Buffer.alloc(2) : len < 65536 ? Buffer.alloc(4) : Buffer.alloc(10);
  head[0] = 0x80 | opcode;
  if (len < 126) head[1] = len;
  else if (len < 65536) {
    head[1] = 126;
    head.writeUInt16BE(len, 2);
  } else {
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([head, payload]);
}

function closePayload(code: number, reason: string): Buffer {
  const text = Buffer.from(reason, "utf8").subarray(0, 123);
  const out = Buffer.alloc(2 + text.length);
  out.writeUInt16BE(code, 0);
  text.copy(out, 2);
  return out;
}

/** Complete the opening handshake on `socket` and run `session`; false when the request is not a valid upgrade. */
export function acceptNodeWebSocket(
  headers: Record<string, string | string[] | undefined>,
  socket: Duplex,
  head: Buffer,
  session: WebSocketSession,
): boolean {
  const key = headers["sec-websocket-key"];
  if (typeof key !== "string" || headers["sec-websocket-version"] !== "13") return false;
  const accept = createHash("sha1")
    .update(key + GUID)
    .digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );

  let buffer: Buffer = head.length ? Buffer.from(head) : Buffer.alloc(0);
  let fragments: Buffer[] = [];
  let fragmentOpcode = 0;
  let fragmentBytes = 0;
  let closeSent = false;
  let finished = false;

  const finish = (code: number, reason: string) => {
    if (finished) return;
    finished = true;
    session.close?.(code, reason);
  };
  const peer: WebSocketPeer = {
    send(data) {
      if (closeSent || socket.destroyed) return;
      socket.write(typeof data === "string" ? frame(OP.text, Buffer.from(data, "utf8")) : frame(OP.binary, data));
    },
    close(code = 1000, reason = "") {
      if (closeSent || socket.destroyed) return;
      closeSent = true;
      socket.write(frame(OP.close, closePayload(code, reason)));
      finish(code, reason);
      // The client answers with its own close frame and ends the connection; end ours after a grace period.
      setTimeout(() => socket.destroy(), 2000).unref?.();
    },
  };

  const fail = (code: number, reason: string) => {
    peer.close(code, reason);
  };

  socket.on("data", (chunk: Buffer) => {
    buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
    for (;;) {
      if (buffer.length < 2) return;
      const fin = (buffer[0]! & 0x80) !== 0;
      const opcode = buffer[0]! & 0x0f;
      const masked = (buffer[1]! & 0x80) !== 0;
      let len = buffer[1]! & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (buffer.length < 4) return;
        len = buffer.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (buffer.length < 10) return;
        const big = buffer.readBigUInt64BE(2);
        if (big > BigInt(MAX_WEBSOCKET_MESSAGE_BYTES)) return fail(1009, "message too big");
        len = Number(big);
        offset = 10;
      }
      if (!masked) return fail(1002, "client frames must be masked");
      if (len > MAX_WEBSOCKET_MESSAGE_BYTES) return fail(1009, "message too big");
      if (buffer.length < offset + 4 + len) return;
      const mask = buffer.subarray(offset, offset + 4);
      const payload = Buffer.from(buffer.subarray(offset + 4, offset + 4 + len));
      for (let i = 0; i < payload.length; i++) payload[i]! ^= mask[i & 3]!;
      buffer = buffer.subarray(offset + 4 + len);

      if (opcode === OP.close) {
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
        const reason = payload.length > 2 ? payload.subarray(2).toString("utf8") : "";
        if (!closeSent) {
          closeSent = true;
          // Echo the code, as the closing handshake asks (1005 means none was given: answer 1000).
          socket.write(frame(OP.close, payload.length >= 2 ? payload.subarray(0, 2) : closePayload(1000, "")));
        }
        finish(code, reason);
        socket.end();
        return;
      }
      if (opcode === OP.ping) {
        if (!closeSent) socket.write(frame(OP.pong, payload));
        continue;
      }
      if (opcode === OP.pong) continue;
      if (opcode === OP.text || opcode === OP.binary) {
        if (fragments.length) return fail(1002, "new message before the last one finished");
        if (fin) {
          session.message?.(peer, opcode === OP.text ? payload.toString("utf8") : new Uint8Array(payload));
        } else {
          fragments = [payload];
          fragmentOpcode = opcode;
          fragmentBytes = payload.length;
        }
        continue;
      }
      if (opcode === OP.continuation) {
        if (!fragments.length) return fail(1002, "continuation without a message");
        fragments.push(payload);
        fragmentBytes += payload.length;
        if (fragmentBytes > MAX_WEBSOCKET_MESSAGE_BYTES) return fail(1009, "message too big");
        if (fin) {
          const whole = Buffer.concat(fragments);
          fragments = [];
          session.message?.(peer, fragmentOpcode === OP.text ? whole.toString("utf8") : new Uint8Array(whole));
        }
        continue;
      }
      return fail(1002, `unknown opcode ${opcode}`);
    }
  });
  socket.on("close", () => finish(1006, ""));
  socket.on("error", () => socket.destroy());
  session.open?.(peer);
  return true;
}
