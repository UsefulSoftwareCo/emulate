import type { Store } from "@emulators/core";
import { getXStore, xNumericId } from "./store.js";
import type { XDmConversation } from "./entities.js";
import {
  DM_RETENTION_MS,
  MAX_GENERATED_CONVERSATIONS,
  mediaKeyPrefix,
  nextStoredId,
  oneToOneConversationId,
} from "./dm-model.js";

export interface XSeedAttachment {
  /** Size of the placeholder file served for this attachment. */
  bytes?: number;
  media_type?: string;
  media_category?: string;
  width?: number;
  height?: number;
}

export interface XSeedDmConversation {
  /** Usernames or user ids. Two participants make a one-to-one conversation; more make a group. */
  participants: string[];
  /** Group conversations only; one-to-one ids are always `{smaller}-{larger}`. */
  conversation_id?: string;
  messages?: Array<{ from: string; text?: string; created_at?: string; attachment?: XSeedAttachment }>;
  /** Computed history: `count` messages alternating between participants, never stored. */
  generate?: {
    count: number;
    /** ISO time of the oldest message. Defaults so the newest lands a minute before seeding. */
    start?: string;
    interval_seconds?: number;
    /** Every Nth message carries a photo attachment (0 or absent for none). */
    attachment_every?: number;
    attachment_bytes?: number;
    attachment_media_type?: string;
    text_prefix?: string;
  };
}

/** Many conversations for one user in one line: `conversations` partners, each with generated history. */
export interface XSeedDmBulk {
  user: string;
  conversations: number;
  events_per_conversation: number;
  interval_seconds?: number;
  attachment_every?: number;
  attachment_bytes?: number;
  /** Partner usernames are `${partner_prefix}${n}` (default `dm_partner_`). */
  partner_prefix?: string;
}

function resolveUserId(store: Store, ref: string): string | null {
  const xs = getXStore(store);
  const byId = xs.users.findOneBy("user_id", ref);
  if (byId) return byId.user_id;
  const byName = xs.users.findOneBy("username", ref.toLowerCase().replace(/^@/, ""));
  return byName ? byName.user_id : null;
}

function nextOrdinal(store: Store): number {
  const used = getXStore(store)
    .dmConversations.all()
    .reduce((m, c) => Math.max(m, c.ordinal), 0);
  if (used >= MAX_GENERATED_CONVERSATIONS) {
    throw new Error(`At most ${MAX_GENERATED_CONVERSATIONS} conversations can have generated history.`);
  }
  return used + 1;
}

function positiveInt(v: unknown, name: string, min = 0): number {
  if (!Number.isInteger(v) || (v as number) < min) throw new Error(`${name} must be an integer >= ${min}.`);
  return v as number;
}

export function seedDmConversation(store: Store, spec: XSeedDmConversation, now = Date.now()): XDmConversation | null {
  const xs = getXStore(store);
  const ids: string[] = [];
  for (const ref of spec.participants ?? []) {
    const id = resolveUserId(store, ref);
    if (!id) throw new Error(`dm_conversations: unknown participant ${ref}; seed the user first.`);
    if (!ids.includes(id)) ids.push(id);
  }
  if (ids.length < 2) throw new Error("dm_conversations: a conversation needs at least two participants.");
  const type = ids.length === 2 && !spec.conversation_id ? "OneToOne" : "Group";
  const conversationId =
    type === "OneToOne" ? oneToOneConversationId(ids[0]!, ids[1]!) : (spec.conversation_id ?? xNumericId());
  if (xs.dmConversations.findOneBy("conversation_id", conversationId)) return null;

  let generated: XDmConversation["generated"] = null;
  let ordinal = 0;
  if (spec.generate) {
    const g = spec.generate;
    const count = positiveInt(g.count, "generate.count");
    const requested =
      g.interval_seconds !== undefined ? positiveInt(g.interval_seconds, "generate.interval_seconds", 1) * 1000 : 60000;
    // Fit the default history inside X's 30-day retention window.
    const interval = g.start
      ? requested
      : Math.max(1, Math.min(requested, Math.floor((DM_RETENTION_MS - 3600000) / Math.max(1, count))));
    const start = g.start ? Date.parse(g.start) : now - 60000 - Math.max(0, count - 1) * interval;
    if (Number.isNaN(start)) throw new Error("generate.start must be an ISO date.");
    ordinal = nextOrdinal(store);
    generated = {
      count,
      start_ms: start,
      interval_ms: interval,
      attachment_every: g.attachment_every ?? 0,
      attachment_bytes: g.attachment_bytes ?? 256 * 1024,
      attachment_media_type: g.attachment_media_type ?? "image/jpeg",
      text_prefix: g.text_prefix ?? "Message",
      deleted: [],
    };
  }
  const conv = xs.dmConversations.insert({
    conversation_id: conversationId,
    conversation_type: type,
    participant_ids: ids,
    ordinal,
    generated,
  });

  for (const m of spec.messages ?? []) {
    const sender = resolveUserId(store, m.from);
    if (!sender || !ids.includes(sender)) throw new Error(`dm_conversations: ${m.from} is not a participant.`);
    const at = m.created_at ? Date.parse(m.created_at) : now;
    const mediaKeys: string[] = [];
    if (m.attachment) {
      const a = m.attachment;
      const mediaType = a.media_type ?? "image/jpeg";
      const category =
        a.media_category ??
        (mediaType === "image/gif" ? "dm_gif" : mediaType.startsWith("video/") ? "dm_video" : "dm_image");
      const mediaId = nextStoredId(store, at);
      const key = `${mediaKeyPrefix(category, mediaType)}${mediaId}`;
      xs.media.insert({
        media_id: mediaId,
        media_key: key,
        owner_id: sender,
        additional_owners: [],
        media_category: category,
        media_type: mediaType,
        size: a.bytes ?? 256 * 1024,
        state: "succeeded",
        source: "seeded",
        width: a.width ?? 1200,
        height: a.height ?? 800,
        created_at_ms: at,
        expires_at_ms: at + 24 * 3600 * 1000,
      });
      mediaKeys.push(key);
    }
    xs.dmEvents.insert({
      event_id: nextStoredId(store, at),
      dm_conversation_id: conversationId,
      event_type: "MessageCreate",
      sender_id: sender,
      text: m.text ?? null,
      participant_ids: null,
      media_keys: mediaKeys,
      created_at_ms: at,
    });
  }
  return conv;
}

export function seedDmBulk(store: Store, bulk: XSeedDmBulk, ensureUser: (username: string) => void): void {
  const owner = resolveUserId(store, bulk.user);
  if (!owner) throw new Error(`dm_bulk: unknown user ${bulk.user}.`);
  const n = positiveInt(bulk.conversations, "dm_bulk.conversations", 1);
  const per = positiveInt(bulk.events_per_conversation, "dm_bulk.events_per_conversation");
  const prefix = bulk.partner_prefix ?? "dm_partner_";
  for (let i = 1; i <= n; i++) {
    const username = `${prefix}${i}`;
    ensureUser(username);
    seedDmConversation(store, {
      participants: [owner, username],
      generate: {
        count: per,
        interval_seconds: bulk.interval_seconds,
        attachment_every: bulk.attachment_every,
        attachment_bytes: bulk.attachment_bytes,
      },
    });
  }
}
