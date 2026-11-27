// Durable Object storage refuses a single value larger than 128 KiB. Emulated state
// is not bounded that way (an 8 MB issue body, a large seeded document), so values
// over the limit are split: the key holds a marker with the part count and each part
// is a string under `<key>|chunk:<n>`. Reads reassemble them; deletes remove the parts.

export interface DurableObjectStorage {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string | string[]): Promise<boolean | number>;
  list<T = unknown>(options?: { prefix?: string }): Promise<Map<string, T>>;
}

export const STORAGE_VALUE_LIMIT = 128 * 1024;
// 16K UTF-16 units stay under the limit however a value is measured: at most 48 KiB as
// UTF-8, and 96 KiB even if every unit were a control character escaped as \u00XX.
const PART_CHARS = 16 * 1024;
const PART_SEP = "|chunk:";
const MARK = "__emulateChunkedValue";
const BATCH = 64;

interface ChunkMarker {
  [MARK]: number;
}
const isMarker = (value: unknown): value is ChunkMarker =>
  typeof value === "object" && value !== null && typeof (value as Record<string, unknown>)[MARK] === "number";
const partKey = (key: string, n: number) => `${key}${PART_SEP}${n}`;
const isPartKey = (key: string) => key.includes(PART_SEP);
const utf8Length = (text: string) => new TextEncoder().encode(text).length;

async function inBatches<T>(items: readonly T[], run: (item: T) => Promise<unknown>): Promise<void> {
  for (let i = 0; i < items.length; i += BATCH) await Promise.all(items.slice(i, i + BATCH).map(run));
}

export class ChunkedStorage implements DurableObjectStorage {
  // Number of parts each split key has in storage, learned from every read and write.
  private readonly parts = new Map<string, number>();

  constructor(private readonly inner: DurableObjectStorage) {}

  async get<T = unknown>(key: string): Promise<T | undefined> {
    const value = await this.inner.get(key);
    if (!isMarker(value)) return value as T | undefined;
    const count = value[MARK];
    this.parts.set(key, count);
    const parts: string[] = [];
    for (let n = 0; n < count; n++) parts.push((await this.inner.get<string>(partKey(key, n))) ?? "");
    return JSON.parse(parts.join("")) as T;
  }

  async put(key: string, value: unknown): Promise<void> {
    const json = JSON.stringify(value);
    const previous = this.parts.get(key) ?? 0;
    if (json === undefined || utf8Length(json) <= STORAGE_VALUE_LIMIT) {
      await this.inner.put(key, value);
      await this.dropParts(key, 0, previous);
      return;
    }
    const pieces: string[] = [];
    for (let i = 0; i < json.length; i += PART_CHARS) pieces.push(json.slice(i, i + PART_CHARS));
    await inBatches(
      pieces.map((piece, n) => ({ piece, n })),
      ({ piece, n }) => this.inner.put(partKey(key, n), piece),
    );
    await this.inner.put(key, { [MARK]: pieces.length } satisfies ChunkMarker);
    await this.dropParts(key, pieces.length, previous);
    this.parts.set(key, pieces.length);
  }

  async delete(key: string | string[]): Promise<boolean | number> {
    const keys = Array.isArray(key) ? key : [key];
    const all: string[] = [];
    for (const k of keys) {
      all.push(k);
      const count = this.parts.get(k) ?? 0;
      for (let n = 0; n < count; n++) all.push(partKey(k, n));
      this.parts.delete(k);
    }
    let deleted = 0;
    for (let i = 0; i < all.length; i += BATCH) {
      const result = await this.inner.delete(all.slice(i, i + BATCH));
      deleted += typeof result === "number" ? result : result ? 1 : 0;
    }
    return Array.isArray(key) ? deleted : deleted > 0;
  }

  async list<T = unknown>(options?: { prefix?: string }): Promise<Map<string, T>> {
    const raw = await this.inner.list(options);
    const out = new Map<string, T>();
    for (const [key, value] of raw) {
      if (isPartKey(key)) continue;
      if (!isMarker(value)) {
        out.set(key, value as T);
        continue;
      }
      const count = value[MARK];
      this.parts.set(key, count);
      const parts: string[] = [];
      for (let n = 0; n < count; n++) {
        const k = partKey(key, n);
        parts.push(((raw.has(k) ? raw.get(k) : await this.inner.get<string>(k)) as string | undefined) ?? "");
      }
      out.set(key, JSON.parse(parts.join("")) as T);
    }
    return out;
  }

  private async dropParts(key: string, from: number, to: number): Promise<void> {
    if (to <= from) return;
    const stale: string[] = [];
    for (let n = from; n < to; n++) stale.push(partKey(key, n));
    for (let i = 0; i < stale.length; i += BATCH) await this.inner.delete(stale.slice(i, i + BATCH));
    if (from === 0) this.parts.delete(key);
  }
}
