import type { Store } from "@emulators/core";

/**
 * How a DM attachment's download is paced: exactly `chunks` pieces, `interval_ms`
 * apart, the same controls the OpenAI emulator has for a paced answer. An emulator
 * control, not X behaviour; unpaced (the default) sends the file as fast as it goes.
 */
export interface MediaPacing {
  chunks: number;
  interval_ms: number;
}

export const MAX_PACING_CHUNKS = 10000;
export const MAX_PACING_INTERVAL_MS = 60000;
const PACING_KEY = "x.media_pacing";

function pacingMap(store: Store): Map<string, MediaPacing> {
  let map = store.getData<Map<string, MediaPacing>>(PACING_KEY);
  if (!map) {
    map = new Map();
    store.setData(PACING_KEY, map);
  }
  return map;
}

/** Validate `{ chunks, interval_ms }`; throws with the field at fault. */
export function parseMediaPacing(value: unknown, where = "stream"): MediaPacing {
  const v = value as Record<string, unknown> | null;
  if (!v || typeof v !== "object") throw new Error(`${where} must be { chunks, interval_ms }.`);
  const chunks = v.chunks;
  const interval = v.interval_ms ?? 0;
  if (!Number.isInteger(chunks) || (chunks as number) < 1 || (chunks as number) > MAX_PACING_CHUNKS) {
    throw new Error(`${where}.chunks must be an integer from 1 to ${MAX_PACING_CHUNKS}.`);
  }
  if (!Number.isInteger(interval) || (interval as number) < 0 || (interval as number) > MAX_PACING_INTERVAL_MS) {
    throw new Error(`${where}.interval_ms must be an integer from 0 to ${MAX_PACING_INTERVAL_MS}.`);
  }
  return { chunks: chunks as number, interval_ms: interval as number };
}

export function getMediaPacing(store: Store, mediaKey: string): MediaPacing | null {
  return pacingMap(store).get(mediaKey) ?? null;
}

export function setMediaPacing(store: Store, mediaKey: string, pacing: MediaPacing | null): void {
  if (pacing) pacingMap(store).set(mediaKey, pacing);
  else pacingMap(store).delete(mediaKey);
}

/**
 * Re-chunk `source` (exactly `size` bytes) into `pacing.chunks` pieces of equal size
 * (the last one shorter), waiting `interval_ms` between pieces. Holds at most one
 * piece in memory. Cancelling the response stops it.
 */
export function pacedStream(
  source: ReadableStream<Uint8Array>,
  size: number,
  pacing: MediaPacing,
): ReadableStream<Uint8Array> {
  const chunks = Math.max(1, Math.min(pacing.chunks, size || 1));
  const pieceBytes = Math.max(1, Math.ceil(size / chunks));
  const reader = source.getReader();
  let pending: Uint8Array = new Uint8Array(0);
  let sent = 0;
  let pieces = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (sent >= size) {
        controller.close();
        return;
      }
      if (pieces > 0 && pacing.interval_ms > 0) {
        await new Promise<void>((resolve) => (timer = setTimeout(resolve, pacing.interval_ms)));
      }
      const want = Math.min(pieceBytes, size - sent);
      const piece = new Uint8Array(want);
      let filled = 0;
      while (filled < want) {
        if (pending.length === 0) {
          const { done, value } = await reader.read();
          if (done) break;
          pending = value;
        }
        const take = Math.min(want - filled, pending.length);
        piece.set(pending.subarray(0, take), filled);
        pending = pending.subarray(take);
        filled += take;
      }
      if (filled === 0) {
        controller.close();
        return;
      }
      controller.enqueue(filled === want ? piece : piece.subarray(0, filled));
      sent += filled;
      pieces++;
    },
    cancel(reason) {
      if (timer) clearTimeout(timer);
      return reader.cancel(reason);
    },
  });
}
