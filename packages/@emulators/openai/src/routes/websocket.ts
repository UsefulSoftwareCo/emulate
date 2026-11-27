import type { RouteContext, WebSocketSession } from "@emulators/core";
import { upgradeWebSocket } from "@emulators/core";
import { MAX_CHUNKS, MAX_INTERVAL_MS } from "../answers.js";

/**
 * GET /_emulate/openai/websocket: an emulator control, not OpenAI's Realtime or
 * WebSocket protocol. It accepts the upgrade and echoes each message it receives,
 * text or binary, as it was. With `?chunks=N&interval_ms=M` (the paced-answer
 * controls) it also sends N messages of its own, M ms apart, then stays open, so a
 * client can hold a busy connection or an idle one. Either side may close; a close
 * from the client is answered with the same code.
 */
export function websocketRoutes({ app }: RouteContext): void {
  app.get("/_emulate/openai/websocket", (c) => {
    const chunks = c.req.query("chunks") ?? "0";
    const interval = c.req.query("interval_ms") ?? "0";
    const n = Number(chunks);
    const ms = Number(interval);
    if (!Number.isInteger(n) || n < 0 || n > MAX_CHUNKS) {
      return c.json({ error: "invalid_request", message: `chunks must be an integer from 0 to ${MAX_CHUNKS}.` }, 400);
    }
    if (!Number.isInteger(ms) || ms < 0 || ms > MAX_INTERVAL_MS) {
      return c.json(
        { error: "invalid_request", message: `interval_ms must be an integer from 0 to ${MAX_INTERVAL_MS}.` },
        400,
      );
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const session: WebSocketSession = {
      open(peer) {
        let sent = 0;
        const tick = () => {
          if (sent >= n) return;
          sent++;
          peer.send(JSON.stringify({ type: "emulate.message", n: sent, of: n, at: new Date().toISOString() }));
          if (sent < n) timer = setTimeout(tick, ms);
        };
        if (n > 0) timer = setTimeout(tick, ms);
      },
      message(peer, data) {
        peer.send(data);
      },
      close() {
        if (timer) clearTimeout(timer);
      },
    };
    return upgradeWebSocket(c.req.raw, session);
  });
}
