/**
 * Server-side WebSockets for emulator routes, on two hosts with one interface:
 *
 * - Cloudflare Workers (and Durable Objects): a `WebSocketPair`, answered with a 101.
 * - Node (`serve` in http.ts): the route answers with a marker header; the server's
 *   `upgrade` handler finds the session by it and speaks RFC 6455 on the socket.
 *
 * A route builds a `WebSocketSession` and returns `upgradeWebSocket(request, session)`.
 */

export interface WebSocketPeer {
  send(data: string | Uint8Array): void;
  /** Close with a status code (1000, normal, by default). */
  close(code?: number, reason?: string): void;
}

export interface WebSocketSession {
  open?(peer: WebSocketPeer): void;
  message?(peer: WebSocketPeer, data: string | Uint8Array): void;
  /** The connection closed, by either side; `code` is the close code received or sent. */
  close?(code: number, reason: string): void;
}

/** Header a Node route response carries so `serve` can find the session to attach. */
export const WEBSOCKET_SESSION_HEADER = "x-emulate-websocket-session";

const pending = new Map<string, { session: WebSocketSession; expires: number }>();

/** True when the request asks to upgrade to a WebSocket. */
export function isWebSocketUpgrade(request: Request): boolean {
  return (request.headers.get("upgrade") ?? "").toLowerCase() === "websocket";
}

interface WorkersWebSocket {
  accept(): void;
  send(data: string | ArrayBuffer | Uint8Array): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "message", fn: (event: { data: string | ArrayBuffer | Blob }) => void): void;
  addEventListener(type: "close", fn: (event: { code: number; reason: string }) => void): void;
  addEventListener(type: "error", fn: () => void): void;
}

/** Accept the upgrade and run `session` on the connection. A request that is not an upgrade gets a 426. */
export function upgradeWebSocket(request: Request, session: WebSocketSession): Response {
  if (!isWebSocketUpgrade(request)) {
    return new Response("Expected a WebSocket upgrade (Upgrade: websocket).", {
      status: 426,
      headers: { upgrade: "websocket", "content-type": "text/plain; charset=utf-8" },
    });
  }
  const Pair = (globalThis as { WebSocketPair?: new () => Record<string, WorkersWebSocket> }).WebSocketPair;
  if (Pair) {
    const pair = new Pair();
    const [client, server] = [pair[0]!, pair[1]!];
    server.accept();
    let closed = false;
    const peer: WebSocketPeer = {
      send: (data) => {
        // Binary goes out as its own ArrayBuffer, which the runtime takes over.
        if (!closed) server.send(typeof data === "string" ? data : data.slice().buffer);
      },
      close: (code = 1000, reason = "") => {
        if (closed) return;
        closed = true;
        server.close(code, reason);
        session.close?.(code, reason);
      },
    };
    // Binary messages can arrive as a Blob (the default binaryType in some runtimes),
    // which is read asynchronously; a queue keeps messages in the order they came.
    try {
      (server as { binaryType?: string }).binaryType = "arraybuffer";
    } catch {
      // not supported: Blobs are read below
    }
    let queue: Promise<void> = Promise.resolve();
    server.addEventListener("message", (event) => {
      const data = event.data as string | ArrayBuffer | Blob;
      queue = queue.then(async () => {
        const message =
          typeof data === "string"
            ? data
            : data instanceof ArrayBuffer
              ? new Uint8Array(data).slice()
              : new Uint8Array(await data.arrayBuffer());
        session.message?.(peer, message);
      });
    });
    server.addEventListener("close", (event) => {
      if (closed) return;
      closed = true;
      // Answer the client's close with the same code, completing the closing handshake.
      try {
        server.close(event.code === 1005 ? 1000 : event.code, event.reason);
      } catch {
        // already closed
      }
      session.close?.(event.code, event.reason);
    });
    server.addEventListener("error", () => peer.close(1011, "error"));
    session.open?.(peer);
    return new Response(null, { status: 101, webSocket: client } as ResponseInit);
  }
  const now = Date.now();
  for (const [id, entry] of pending) if (entry.expires < now) pending.delete(id);
  const id = crypto.randomUUID();
  pending.set(id, { session, expires: now + 30_000 });
  return new Response(null, { status: 200, headers: { [WEBSOCKET_SESSION_HEADER]: id } });
}

/** The session a Node route response named, once; used by `serve`'s upgrade handler. */
export function takeWebSocketSession(response: Response): WebSocketSession | undefined {
  const id = response.headers.get(WEBSOCKET_SESSION_HEADER);
  if (!id) return undefined;
  const entry = pending.get(id);
  pending.delete(id);
  return entry?.session;
}
