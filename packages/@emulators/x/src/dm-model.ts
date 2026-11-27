import type { Store } from "@emulators/core";
import { getXStore } from "./store.js";
import type { XDmConversation, XDmEvent, XMedia, XUser } from "./entities.js";

/** X's snowflake epoch (2010-11-04T01:42:54.657Z). */
const X_EPOCH = 1288834974657n;
/** Snowflake worker id reserved for events stored at runtime (sent, arrived, seeded explicitly). */
const STORED_WORKER = 1023;
/** Largest conversation ordinal usable for generated history (worker ids 1 to 1022). */
export const MAX_GENERATED_CONVERSATIONS = 1022;
/** X returns DM events from the last 30 days only (Direct Messages lookup, "Data retention"). */
export const DM_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const SEQUENCE_KEY = "x.dm_snowflake";

export type DmEventType = "MessageCreate" | "ParticipantsJoin" | "ParticipantsLeave";
export const DM_EVENT_TYPES: DmEventType[] = ["MessageCreate", "ParticipantsJoin", "ParticipantsLeave"];

/** A DM event as the model sees it, whether stored or computed from generated history. */
export interface DmEventView {
  id: string;
  idn: bigint;
  event_type: DmEventType;
  text: string | null;
  sender_id: string | null;
  dm_conversation_id: string;
  participant_ids: string[] | null;
  media_keys: string[];
  created_at_ms: number;
  generated: boolean;
}

/** Media as the model sees it, whether uploaded or derived from a generated event. */
export interface MediaView {
  media_id: string;
  media_key: string;
  type: "photo" | "animated_gif" | "video";
  media_type: string;
  size: number;
  width: number | null;
  height: number | null;
  owner_id: string;
  additional_owners: string[];
  source: "uploaded" | "seeded" | "generated";
  state: "uploading" | "succeeded";
}

export function snowflake(ms: number, worker: number, sequence: number): string {
  return (((BigInt(ms) - X_EPOCH) << 22n) | (BigInt(worker & 1023) << 12n) | BigInt(sequence & 4095)).toString();
}

export function decodeSnowflake(id: string): { ms: number; worker: number; sequence: number } | null {
  if (!/^[0-9]{1,19}$/.test(id)) return null;
  const n = BigInt(id);
  return {
    ms: Number((n >> 22n) + X_EPOCH),
    worker: Number((n >> 12n) & 1023n),
    sequence: Number(n & 4095n),
  };
}

/** A fresh, strictly increasing id for a stored event or uploaded media. */
export function nextStoredId(store: Store, at = Date.now()): string {
  const prev = store.getData<{ ms: number; seq: number }>(SEQUENCE_KEY) ?? { ms: 0, seq: 0 };
  let ms = Math.max(at, prev.ms);
  let seq = ms === prev.ms ? prev.seq + 1 : 0;
  if (seq > 4095) {
    ms += 1;
    seq = 0;
  }
  store.setData(SEQUENCE_KEY, { ms, seq });
  return snowflake(ms, STORED_WORKER, seq);
}

/** One-to-one conversation id: `{smaller_user_id}-{larger_user_id}`. */
export function oneToOneConversationId(a: string, b: string): string {
  const [x, y] = BigInt(a) <= BigInt(b) ? [a, b] : [b, a];
  return `${x}-${y}`;
}

export function mediaTypeForKey(key: string): MediaView["type"] {
  if (key.startsWith("16_")) return "animated_gif";
  if (key.startsWith("7_")) return "video";
  return "photo";
}

export function mediaKeyPrefix(category: string, mediaType: string): string {
  if (category.endsWith("_gif") || mediaType === "image/gif") return "16_";
  if (category.endsWith("_video") || mediaType.startsWith("video/")) return "7_";
  return "3_";
}

// ---------------------------------------------------------------------------
// Generated history

function generatedEventAt(conv: XDmConversation, i: number): DmEventView {
  const g = conv.generated!;
  const ms = g.start_ms + i * g.interval_ms;
  const id = snowflake(ms, conv.ordinal, i);
  const hasMedia = g.attachment_every > 0 && (i + 1) % g.attachment_every === 0;
  return {
    id,
    idn: BigInt(id),
    event_type: "MessageCreate",
    text: `${g.text_prefix} ${i + 1}`,
    sender_id: conv.participant_ids[i % conv.participant_ids.length]!,
    dm_conversation_id: conv.conversation_id,
    participant_ids: null,
    media_keys: hasMedia ? [`${mediaKeyPrefix("dm_image", g.attachment_media_type)}${id}`] : [],
    created_at_ms: ms,
    generated: true,
  };
}

function generatedIdAt(conv: XDmConversation, i: number): bigint {
  const g = conv.generated!;
  return BigInt(snowflake(g.start_ms + i * g.interval_ms, conv.ordinal, i));
}

/** Smallest index whose id is greater than `bound` (count when none is). */
function firstIndexAbove(conv: XDmConversation, bound: bigint): number {
  let lo = 0;
  let hi = conv.generated!.count;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (generatedIdAt(conv, mid) > bound) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/** Find a generated event by id, if the id names one that exists and was not deleted. */
export function findGeneratedEvent(store: Store, id: string): { conv: XDmConversation; index: number } | null {
  const d = decodeSnowflake(id);
  if (!d || d.worker === STORED_WORKER || d.worker === 0) return null;
  const conv = getXStore(store).dmConversations.findOneBy("ordinal", d.worker);
  const g = conv?.generated;
  if (!conv || !g) return null;
  const offset = d.ms - g.start_ms;
  if (offset < 0 || offset % g.interval_ms !== 0) return null;
  const index = offset / g.interval_ms;
  if (index >= g.count || (index & 4095) !== d.sequence) return null;
  if (g.deleted.includes(index)) return null;
  return { conv, index };
}

export function storedEventView(e: XDmEvent): DmEventView {
  return {
    id: e.event_id,
    idn: BigInt(e.event_id),
    event_type: e.event_type,
    text: e.text,
    sender_id: e.sender_id,
    dm_conversation_id: e.dm_conversation_id,
    participant_ids: e.participant_ids,
    media_keys: e.media_keys,
    created_at_ms: e.created_at_ms,
    generated: false,
  };
}

/** Look up any DM event by id (stored or generated), ignoring retention. */
export function findEvent(store: Store, id: string): { view: DmEventView; conv: XDmConversation } | null {
  const xs = getXStore(store);
  const stored = xs.dmEvents.findOneBy("event_id", id);
  if (stored) {
    const conv = xs.dmConversations.findOneBy("conversation_id", stored.dm_conversation_id);
    return conv ? { view: storedEventView(stored), conv } : null;
  }
  const gen = findGeneratedEvent(store, id);
  return gen ? { view: generatedEventAt(gen.conv, gen.index), conv: gen.conv } : null;
}

// ---------------------------------------------------------------------------
// Listing

export interface DmCursor {
  /** Return events strictly older than this id (next page). */
  before?: bigint;
  /** Return events strictly newer than this id (previous page). */
  after?: bigint;
}

export interface DmPage {
  events: DmEventView[];
  hasOlder: boolean;
  hasNewer: boolean;
}

/**
 * Page through the events of `conversations`, newest first, the way the v2 DM
 * lookup endpoints do. Only the candidates a page can use are computed from
 * generated history, so a conversation with thousands of events costs a binary
 * search per page, not a scan.
 */
export function listEvents(
  store: Store,
  conversations: XDmConversation[],
  options: { limit: number; cursor: DmCursor; eventTypes: DmEventType[]; now?: number },
): DmPage {
  const xs = getXStore(store);
  const now = options.now ?? Date.now();
  const oldestMs = now - DM_RETENTION_MS;
  const types = new Set(options.eventTypes);
  const want = options.limit + 1;
  const goingNewer = options.cursor.after !== undefined && options.cursor.before === undefined;
  const upper = options.cursor.before;
  const lower = options.cursor.after;
  const candidates: DmEventView[] = [];

  for (const conv of conversations) {
    for (const e of xs.dmEvents.findBy("dm_conversation_id", conv.conversation_id)) {
      const v = storedEventView(e);
      if (!types.has(v.event_type) || v.created_at_ms < oldestMs) continue;
      if (upper !== undefined && v.idn >= upper) continue;
      if (lower !== undefined && v.idn <= lower) continue;
      candidates.push(v);
    }
    const g = conv.generated;
    if (!g || g.count === 0 || !types.has("MessageCreate")) continue;
    const deleted = new Set(g.deleted);
    const minIndex = Math.max(
      lower !== undefined ? firstIndexAbove(conv, lower) : 0,
      g.start_ms >= oldestMs ? 0 : Math.ceil((oldestMs - g.start_ms) / g.interval_ms),
    );
    const maxIndex = (upper !== undefined ? firstIndexAbove(conv, upper - 1n) : g.count) - 1;
    let taken = 0;
    if (goingNewer) {
      for (let i = minIndex; i <= maxIndex && taken < want; i++) {
        if (deleted.has(i)) continue;
        candidates.push(generatedEventAt(conv, i));
        taken++;
      }
    } else {
      for (let i = maxIndex; i >= minIndex && taken < want; i--) {
        if (deleted.has(i)) continue;
        candidates.push(generatedEventAt(conv, i));
        taken++;
      }
    }
  }

  if (goingNewer) {
    candidates.sort((a, b) => (a.idn < b.idn ? -1 : a.idn > b.idn ? 1 : 0));
    const page = candidates.slice(0, options.limit);
    return { events: page.reverse(), hasOlder: true, hasNewer: candidates.length > options.limit };
  }
  candidates.sort((a, b) => (a.idn > b.idn ? -1 : a.idn < b.idn ? 1 : 0));
  return {
    events: candidates.slice(0, options.limit),
    hasOlder: candidates.length > options.limit,
    hasNewer: upper !== undefined,
  };
}

const BASE32HEX = "0123456789ABCDEFGHIJKLMNOPQRSTUV";

function base32hex(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += BASE32HEX[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32HEX[(value << (5 - bits)) & 31];
  return out;
}

function fromBase32hex(text: string): Uint8Array | null {
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const ch of text.toUpperCase()) {
    const v = BASE32HEX.indexOf(ch);
    if (v < 0) return null;
    value = ((value << 5) | v) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

/**
 * Pagination tokens are opaque base32hex strings of 16 characters, the form X's
 * spec describes for its tokens (minLength 16): a direction byte, the boundary
 * event id as 8 bytes, and a check byte.
 */
export function encodeCursor(direction: "before" | "after", id: string): string {
  const bytes = new Uint8Array(10);
  bytes[0] = direction === "before" ? 0x42 : 0x41;
  new DataView(bytes.buffer).setBigUint64(1, BigInt(id));
  bytes[9] = bytes.slice(0, 9).reduce((a, b) => a ^ b, 0x5a);
  return base32hex(bytes);
}

export function decodeCursor(token: string): DmCursor | null {
  if (token.length !== 16) return null;
  const bytes = fromBase32hex(token);
  if (!bytes || bytes.length !== 10) return null;
  if (bytes.slice(0, 9).reduce((a, b) => a ^ b, 0x5a) !== bytes[9]) return null;
  const id = new DataView(bytes.buffer).getBigUint64(1);
  if (bytes[0] === 0x42) return { before: id };
  if (bytes[0] === 0x41) return { after: id };
  return null;
}

/** Conversations the user participates in. */
export function conversationsFor(store: Store, userId: string): XDmConversation[] {
  return getXStore(store)
    .dmConversations.all()
    .filter((c) => c.participant_ids.includes(userId));
}

// ---------------------------------------------------------------------------
// Media

function mediaFromRow(m: XMedia): MediaView {
  return {
    media_id: m.media_id,
    media_key: m.media_key,
    type: mediaTypeForKey(m.media_key),
    media_type: m.media_type,
    size: m.size,
    width: m.width,
    height: m.height,
    owner_id: m.owner_id,
    additional_owners: m.additional_owners,
    source: m.source,
    state: m.state,
  };
}

/** Resolve a media key: uploaded or seeded media first, then media of a generated event. */
export function findMediaByKey(store: Store, key: string): MediaView | null {
  const row = getXStore(store).media.findOneBy("media_key", key);
  if (row) return mediaFromRow(row);
  const m = /^(3|7|16)_([0-9]{1,19})$/.exec(key);
  if (!m) return null;
  const gen = findGeneratedEvent(store, m[2]!);
  if (!gen) return null;
  const view = generatedEventAt(gen.conv, gen.index);
  if (!view.media_keys.includes(key)) return null;
  const g = gen.conv.generated!;
  return {
    media_id: m[2]!,
    media_key: key,
    type: mediaTypeForKey(key),
    media_type: g.attachment_media_type,
    size: g.attachment_bytes,
    width: 1200,
    height: 800,
    owner_id: view.sender_id!,
    additional_owners: [],
    source: "generated",
    state: "succeeded",
  };
}

export function findMediaById(store: Store, mediaId: string): MediaView | null {
  const row = getXStore(store).media.findOneBy("media_id", mediaId);
  return row ? mediaFromRow(row) : null;
}

const PART_BYTES = 64 * 1024;

/** Deterministic placeholder content of `size` bytes, starting with a signature that matches the type. */
function placeholderPart(media: MediaView, offset: number, length: number): Uint8Array {
  const out = new Uint8Array(length);
  const seed = Number(BigInt(media.media_id) % 251n);
  for (let k = 0; k < length; k++) out[k] = ((offset + k) * 31 + seed) & 255;
  const sig =
    media.media_type === "image/png"
      ? [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
      : media.media_type === "image/gif"
        ? [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]
        : media.media_type === "image/jpeg"
          ? [0xff, 0xd8, 0xff, 0xe0]
          : [];
  for (let k = 0; k < sig.length; k++) {
    const pos = k - offset;
    if (pos >= 0 && pos < length) out[pos] = sig[k]!;
  }
  return out;
}

/**
 * The media's bytes as a stream, produced a part at a time: uploaded media is
 * read chunk by chunk from the store and seeded or generated media is computed,
 * so a file of several megabytes is never held in memory whole.
 */
export function mediaStream(store: Store, media: MediaView): ReadableStream<Uint8Array> {
  if (media.source === "uploaded") {
    const chunks = getXStore(store)
      .mediaChunks.findBy("media_id", media.media_id)
      .sort((a, b) => a.segment_index - b.segment_index || a.part - b.part)
      .map((c) => c.id);
    let i = 0;
    return new ReadableStream<Uint8Array>({
      pull(controller) {
        if (i >= chunks.length) {
          controller.close();
          return;
        }
        const row = getXStore(store).mediaChunks.get(chunks[i++]!);
        if (row) controller.enqueue(new Uint8Array(Buffer.from(row.data_b64, "base64")));
      },
    });
  }
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= media.size) {
        controller.close();
        return;
      }
      const length = Math.min(PART_BYTES, media.size - offset);
      controller.enqueue(placeholderPart(media, offset, length));
      offset += length;
    },
  });
}

/** Store an appended segment as parts small enough for a Durable Object value. */
export function storeSegment(store: Store, mediaId: string, segmentIndex: number, bytes: Uint8Array): void {
  const xs = getXStore(store);
  for (const old of xs.mediaChunks.findBy("media_id", mediaId)) {
    if (old.segment_index === segmentIndex) xs.mediaChunks.delete(old.id);
  }
  let part = 0;
  for (let off = 0; off < bytes.length; off += PART_BYTES, part++) {
    const slice = bytes.subarray(off, Math.min(bytes.length, off + PART_BYTES));
    xs.mediaChunks.insert({
      media_id: mediaId,
      segment_index: segmentIndex,
      part,
      data_b64: Buffer.from(slice).toString("base64"),
      byte_length: slice.length,
    });
  }
}

export function storedMediaBytes(store: Store, mediaId: string): number {
  return getXStore(store)
    .mediaChunks.findBy("media_id", mediaId)
    .reduce((n, c) => n + c.byte_length, 0);
}

// ---------------------------------------------------------------------------
// Formatting

export const DM_EVENT_FIELDS = new Set([
  "attachments",
  "created_at",
  "dm_conversation_id",
  "entities",
  "event_type",
  "id",
  "text",
  // Not in the spec's enum but documented as fields (and used in X's own examples).
  "sender_id",
  "participant_ids",
  "referenced_tweets",
  "referenced_posts",
]);
export const DM_EXPANSIONS = new Set([
  "attachments.media_keys",
  "sender_id",
  "participant_ids",
  "referenced_posts",
  "referenced_tweets.id",
]);
export const USER_FIELDS = new Set([
  "created_at",
  "description",
  "entities",
  "id",
  "location",
  "name",
  "pinned_tweet_id",
  "profile_image_url",
  "protected",
  "public_metrics",
  "url",
  "username",
  "verified",
  "verified_type",
  "withheld",
]);
export const MEDIA_FIELDS = new Set([
  "alt_text",
  "duration_ms",
  "height",
  "media_key",
  "non_public_metrics",
  "organic_metrics",
  "preview_image_url",
  "promoted_metrics",
  "public_metrics",
  "type",
  "url",
  "variants",
  "width",
]);

interface TextEntity {
  start: number;
  end: number;
}

/** Hashtags, cashtags, mentions and URLs found in DM text, in the v2 DmEventEntities shape. */
export function textEntities(store: Store, text: string): Record<string, unknown> | undefined {
  const out: Record<string, Array<TextEntity & Record<string, unknown>>> = {};
  const add = (key: string, e: TextEntity & Record<string, unknown>) => (out[key] ??= []).push(e);
  for (const m of text.matchAll(/(^|[^\w])#(\w+)/g)) {
    const start = m.index! + m[1]!.length;
    add("hashtags", { start, end: start + 1 + m[2]!.length, tag: m[2]! });
  }
  for (const m of text.matchAll(/(^|[^\w])\$([A-Za-z]{1,6})\b/g)) {
    const start = m.index! + m[1]!.length;
    add("cashtags", { start, end: start + 1 + m[2]!.length, tag: m[2]! });
  }
  for (const m of text.matchAll(/(^|[^\w])@(\w{1,15})/g)) {
    const start = m.index! + m[1]!.length;
    const user = getXStore(store).users.findOneBy("username", m[2]!.toLowerCase());
    add("mentions", { start, end: start + 1 + m[2]!.length, username: m[2]!, ...(user ? { id: user.user_id } : {}) });
  }
  for (const m of text.matchAll(/https?:\/\/[^\s]+/g)) {
    const url = m[0];
    add("urls", {
      start: m.index!,
      end: m.index! + url.length,
      url,
      expanded_url: url,
      display_url: url.replace(/^https?:\/\//, ""),
    });
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function formatEvent(store: Store, e: DmEventView, fields: Set<string>): Record<string, unknown> {
  const out: Record<string, unknown> = { id: e.id, event_type: e.event_type };
  if (e.event_type === "MessageCreate") out.text = e.text ?? "";
  else out.participant_ids = e.participant_ids ?? [];
  if (fields.has("created_at")) out.created_at = new Date(e.created_at_ms).toISOString();
  if (fields.has("dm_conversation_id")) out.dm_conversation_id = e.dm_conversation_id;
  if (fields.has("sender_id") && e.sender_id) out.sender_id = e.sender_id;
  if (fields.has("participant_ids") && e.participant_ids) out.participant_ids = e.participant_ids;
  if (fields.has("attachments") && e.media_keys.length > 0) out.attachments = { media_keys: e.media_keys };
  if (fields.has("entities") && e.text) {
    const entities = textEntities(store, e.text);
    if (entities) out.entities = entities;
  }
  return out;
}

export function formatIncludedUser(u: XUser, fields: Set<string>): Record<string, unknown> {
  const all: Record<string, unknown> = {
    created_at: u.created_at_x,
    description: u.description,
    location: u.location ?? undefined,
    url: u.url ?? undefined,
    protected: u.protected,
    verified: u.verified,
    profile_image_url: u.profile_image_url ?? undefined,
    public_metrics: {
      followers_count: u.followers_count,
      following_count: u.following_count,
      tweet_count: u.tweet_count,
      listed_count: u.listed_count,
    },
  };
  const out: Record<string, unknown> = { id: u.user_id, name: u.name, username: u.username };
  for (const f of fields) if (all[f] !== undefined) out[f] = all[f];
  return out;
}

/** The address a participant downloads DM media from (GET /2/dm_conversations/media/...). */
export function dmMediaUrl(baseUrl: string, eventId: string, media: MediaView): string {
  return `${baseUrl}/2/dm_conversations/media/${eventId}/${media.media_key}/${media.media_id}`;
}

export function formatIncludedMedia(
  baseUrl: string,
  eventId: string,
  media: MediaView,
  fields: Set<string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { media_key: media.media_key, type: media.type };
  if (fields.has("url") && media.type === "photo") out.url = dmMediaUrl(baseUrl, eventId, media);
  if (fields.has("preview_image_url") && media.type !== "photo") {
    out.preview_image_url = dmMediaUrl(baseUrl, eventId, media);
  }
  if (fields.has("width") && media.width !== null) out.width = media.width;
  if (fields.has("height") && media.height !== null) out.height = media.height;
  if (fields.has("variants") && media.type !== "photo") {
    out.variants = [{ content_type: media.media_type, url: dmMediaUrl(baseUrl, eventId, media) }];
  }
  return out;
}
