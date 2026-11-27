import type { Context, RouteContext, Store, WebhookDispatcher } from "@emulators/core";
import { recordSideEffect } from "@emulators/core";
import { getXStore } from "../store.js";
import type { XDmConversation, XUser } from "../entities.js";
import { requireUserContext } from "./auth.js";
import { PROBLEM, enumListParam, invalidRequest, listParam, problem } from "./problems.js";
import {
  DM_EVENT_FIELDS,
  DM_EVENT_TYPES,
  DM_EXPANSIONS,
  MEDIA_FIELDS,
  USER_FIELDS,
  conversationsFor,
  decodeCursor,
  encodeCursor,
  findEvent,
  findGeneratedEvent,
  findMediaById,
  findMediaByKey,
  formatEvent,
  formatIncludedMedia,
  formatIncludedUser,
  listEvents,
  nextStoredId,
  oneToOneConversationId,
  storedEventView,
  type DmEventType,
  type DmEventView,
} from "../dm-model.js";
import { prepareDmDeliveries, sendDeliveries, type DeliveryResult } from "../activity.js";

/** Scopes from the `security` blocks of the v2 OpenAPI spec (2.175). */
export const DM_READ_SCOPES = ["dm.read", "tweet.read", "users.read"];
export const DM_WRITE_SCOPES = ["dm.write", "tweet.read", "users.read"];
export const DM_DELETE_SCOPES = ["dm.read", "dm.write"];

const MAX_TEXT = 10000;

interface ReadOptions {
  limit: number;
  token?: string;
  eventTypes: DmEventType[];
  fields: Set<string>;
  expansions: Set<string>;
  userFields: Set<string>;
  mediaFields: Set<string>;
}

function parseReadOptions(c: Context, paged: boolean): ReadOptions | { response: Response } {
  let limit = 100;
  let token: string | undefined;
  let eventTypes: DmEventType[] = [...DM_EVENT_TYPES];
  if (paged) {
    const raw = c.req.query("max_results");
    if (raw !== undefined) {
      const n = Number(raw);
      if (!/^[0-9]+$/.test(raw) || n < 1 || n > 100) {
        return {
          response: invalidRequest(
            c,
            "max_results",
            raw,
            `The \`max_results\` query parameter value [${raw}] is not between 1 and 100`,
          ),
        };
      }
      limit = n;
    }
    token = c.req.query("pagination_token");
    if (token !== undefined && (token.length < 16 || !decodeCursor(token))) {
      return {
        response: invalidRequest(
          c,
          "pagination_token",
          token,
          `The \`pagination_token\` query parameter value [${token}] is not valid`,
        ),
      };
    }
    const types = enumListParam(c, "event_types", new Set(DM_EVENT_TYPES));
    if ("response" in types) return types;
    if (types.values.size > 0) eventTypes = [...types.values] as DmEventType[];
  }
  const fields = enumListParam(c, "dm_event.fields", DM_EVENT_FIELDS);
  if ("response" in fields) return fields;
  const expansions = enumListParam(c, "expansions", DM_EXPANSIONS);
  if ("response" in expansions) return expansions;
  const userFields = enumListParam(c, "user.fields", USER_FIELDS);
  if ("response" in userFields) return userFields;
  const mediaFields = enumListParam(c, "media.fields", MEDIA_FIELDS);
  if ("response" in mediaFields) return mediaFields;
  // Asking for an expansion returns the id field it expands.
  const f = new Set(fields.values);
  if (expansions.values.has("sender_id")) f.add("sender_id");
  if (expansions.values.has("participant_ids")) f.add("participant_ids");
  if (expansions.values.has("attachments.media_keys")) f.add("attachments");
  // post.fields is accepted (referenced Posts are never present in emulated DMs).
  listParam(c, "post.fields");
  return {
    limit,
    token,
    eventTypes,
    fields: f,
    expansions: expansions.values,
    userFields: userFields.values,
    mediaFields: mediaFields.values,
  };
}

function buildBody(
  store: Store,
  baseUrl: string,
  events: DmEventView[],
  o: ReadOptions,
): { data?: unknown; includes?: Record<string, unknown> } {
  const xs = getXStore(store);
  const out: { data?: unknown; includes?: Record<string, unknown> } = {};
  if (events.length > 0) out.data = events.map((e) => formatEvent(store, e, o.fields));
  const includes: Record<string, unknown[]> = {};
  const userIds = new Set<string>();
  if (o.expansions.has("sender_id")) for (const e of events) if (e.sender_id) userIds.add(e.sender_id);
  if (o.expansions.has("participant_ids")) {
    for (const e of events) for (const p of e.participant_ids ?? []) userIds.add(p);
  }
  if (userIds.size > 0) {
    includes.users = [...userIds]
      .map((id) => xs.users.findOneBy("user_id", id))
      .filter((u): u is XUser => !!u)
      .map((u) => formatIncludedUser(u, o.userFields));
  }
  if (o.expansions.has("attachments.media_keys")) {
    const seen = new Set<string>();
    const media: unknown[] = [];
    for (const e of events) {
      for (const key of e.media_keys) {
        if (seen.has(key)) continue;
        seen.add(key);
        const m = findMediaByKey(store, key);
        if (m) media.push(formatIncludedMedia(baseUrl, e.id, m, o.mediaFields));
      }
    }
    if (media.length > 0) includes.media = media;
  }
  if (Object.keys(includes).length > 0) out.includes = includes;
  return out;
}

function listResponse(c: Context, store: Store, baseUrl: string, convs: XDmConversation[], o: ReadOptions) {
  const cursor = o.token ? decodeCursor(o.token)! : {};
  const page = listEvents(store, convs, { limit: o.limit, cursor, eventTypes: o.eventTypes });
  const body: Record<string, unknown> = buildBody(store, baseUrl, page.events, o);
  const meta: Record<string, unknown> = { result_count: page.events.length };
  const first = page.events[0];
  const last = page.events[page.events.length - 1];
  if (last && page.hasOlder) meta.next_token = encodeCursor("before", last.id);
  if (first && page.hasNewer) meta.previous_token = encodeCursor("after", first.id);
  body.meta = meta;
  return c.json(body);
}

function visibleConversation(store: Store, id: string, userId: string): XDmConversation | null {
  const conv = getXStore(store).dmConversations.findOneBy("conversation_id", id);
  return conv && conv.participant_ids.includes(userId) ? conv : null;
}

function notFoundBody(c: Context, resourceType: string, parameter: string, value: string) {
  return c.json({
    errors: [
      {
        value,
        detail: `Could not find ${resourceType} with ${parameter}: [${value}].`,
        title: "Not Found Error",
        resource_type: resourceType,
        parameter,
        resource_id: value,
        type: PROBLEM.resourceNotFound,
      },
    ],
  });
}

export interface SendInput {
  sender: XUser;
  conv: XDmConversation;
  text: string | null;
  mediaKeys: string[];
  at?: number;
}

/** Store a new MessageCreate event and deliver it to every subscribed participant. */
export async function storeAndDeliverMessage(
  store: Store,
  baseUrl: string,
  dispatcher: WebhookDispatcher,
  input: SendInput,
): Promise<{ view: DmEventView; deliveries: DeliveryResult[] }> {
  const xs = getXStore(store);
  const at = input.at ?? Date.now();
  const row = xs.dmEvents.insert({
    event_id: nextStoredId(store, at),
    dm_conversation_id: input.conv.conversation_id,
    event_type: "MessageCreate",
    sender_id: input.sender.user_id,
    text: input.text,
    participant_ids: null,
    media_keys: input.mediaKeys,
    created_at_ms: at,
  });
  const view = storedEventView(row);
  const prepared = prepareDmDeliveries(store, baseUrl, view, input.conv.participant_ids);
  const deliveries = await sendDeliveries(dispatcher, prepared);
  return { view, deliveries };
}

/** Put each held delivery on the request's ledger entry, with the reason it was held. */
export function recordHeldDeliveries(c: Context, deliveries: DeliveryResult[]): void {
  for (const d of deliveries) {
    if (!d.held) continue;
    recordSideEffect(c, {
      type: "custom",
      collection: "x.webhook_deliveries",
      id: d.webhook_id,
      summary: `${d.event_type} for ${d.for_user_id} to ${d.url} ${d.held}`,
    });
  }
}

/** Find or create the one-to-one conversation between two users. */
export function ensureOneToOne(store: Store, a: string, b: string): XDmConversation {
  const xs = getXStore(store);
  const id = oneToOneConversationId(a, b);
  const existing = xs.dmConversations.findOneBy("conversation_id", id);
  if (existing) return existing;
  return xs.dmConversations.insert({
    conversation_id: id,
    conversation_type: "OneToOne",
    participant_ids: a === b ? [a] : [a, b],
    ordinal: 0,
    generated: null,
  });
}

/**
 * Validate a send body (`text` and/or `attachments: [{media_id}]`, nothing else),
 * returning the text and the attached media keys or the error X gives.
 */
function parseSendBody(
  c: Context,
  store: Store,
  sender: XUser,
  body: unknown,
): { text: string | null; mediaKeys: string[] } | { response: Response } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { response: invalidRequest(c, "body", "", "The request body must be a JSON object.") };
  }
  const b = body as Record<string, unknown>;
  for (const key of Object.keys(b)) {
    if (key !== "text" && key !== "attachments") {
      return { response: invalidRequest(c, key, "", `[${key}] is not a valid field for this request.`) };
    }
  }
  const text = typeof b.text === "string" ? b.text : null;
  if (b.text !== undefined && typeof b.text !== "string") {
    return { response: invalidRequest(c, "text", "", "`text` must be a string.") };
  }
  const attachments = b.attachments;
  if (attachments !== undefined && !Array.isArray(attachments)) {
    return { response: invalidRequest(c, "attachments", "", "`attachments` must be an array.") };
  }
  const list = (attachments ?? []) as unknown[];
  if ((text === null || text.length === 0) && list.length === 0) {
    return {
      response: problem(
        c,
        400,
        PROBLEM.dmTextEmpty,
        "Invalid Request",
        "At least one of text or attachments is required.",
      ),
    };
  }
  if (text !== null && text.length > MAX_TEXT) {
    return {
      response: problem(
        c,
        400,
        PROBLEM.dmTextTooLong,
        "Invalid Request",
        `Text is longer than ${MAX_TEXT} characters.`,
      ),
    };
  }
  if (list.length > 1) {
    return { response: invalidRequest(c, "attachments", list.length, "Only one attachment is allowed per message.") };
  }
  const mediaKeys: string[] = [];
  for (const a of list) {
    const mediaId = a && typeof a === "object" ? (a as Record<string, unknown>).media_id : undefined;
    if (typeof mediaId !== "string" || !/^[0-9]{1,19}$/.test(mediaId)) {
      return { response: invalidRequest(c, "attachments.media_id", mediaId, "`media_id` must be a numeric string.") };
    }
    const media = findMediaById(store, mediaId);
    const owned = media && (media.owner_id === sender.user_id || media.additional_owners.includes(sender.user_id));
    if (!media || !owned) {
      return {
        response: problem(
          c,
          400,
          PROBLEM.dmBadMedia,
          "Invalid Request",
          `Media ${mediaId} was not found for this user.`,
        ),
      };
    }
    if (media.state !== "succeeded") {
      return {
        response: problem(
          c,
          400,
          PROBLEM.dmBadMedia,
          "Invalid Request",
          `Media ${mediaId} has not finished uploading.`,
        ),
      };
    }
    mediaKeys.push(media.media_key);
  }
  return { text: text && text.length > 0 ? text : null, mediaKeys };
}

export function dmRoutes({ app, store, baseUrl, webhooks }: RouteContext): void {
  const xs = getXStore(store);

  // GET /2/dm_events: recent DM events across all of the user's conversations.
  app.get("/2/dm_events", (c) => {
    const auth = requireUserContext(store, c, DM_READ_SCOPES);
    if ("response" in auth) return auth.response;
    const o = parseReadOptions(c, true);
    if ("response" in o) return o.response;
    return listResponse(c, store, baseUrl, conversationsFor(store, auth.user.user_id), o);
  });

  // GET /2/dm_conversations/with/:participant_id/dm_events: the one-to-one conversation.
  app.get("/2/dm_conversations/with/:participant_id/dm_events", (c) => {
    const auth = requireUserContext(store, c, DM_READ_SCOPES);
    if ("response" in auth) return auth.response;
    const participant = c.req.param("participant_id");
    if (!/^[0-9]{1,19}$/.test(participant)) {
      return invalidRequest(c, "participant_id", participant, "`participant_id` must be a numeric user id.");
    }
    const o = parseReadOptions(c, true);
    if ("response" in o) return o.response;
    const conv = visibleConversation(store, oneToOneConversationId(auth.user.user_id, participant), auth.user.user_id);
    return listResponse(c, store, baseUrl, conv ? [conv] : [], o);
  });

  // GET /2/dm_conversations/:id/dm_events: a conversation by id (one-to-one or group).
  app.get("/2/dm_conversations/:id/dm_events", (c) => {
    const auth = requireUserContext(store, c, DM_READ_SCOPES);
    if ("response" in auth) return auth.response;
    const id = c.req.param("id");
    if (!/^([0-9]{1,19}-[0-9]{1,19}|[0-9]{15,19})$/.test(id)) {
      return invalidRequest(c, "id", id, `The \`id\` path parameter value [${id}] is not a valid conversation id`);
    }
    const o = parseReadOptions(c, true);
    if ("response" in o) return o.response;
    const conv = visibleConversation(store, id, auth.user.user_id);
    if (!conv) return notFoundBody(c, "dm_conversation", "id", id);
    return listResponse(c, store, baseUrl, [conv], o);
  });

  // GET /2/dm_events/:event_id: one event the user can see.
  app.get("/2/dm_events/:event_id", (c) => {
    const auth = requireUserContext(store, c, DM_READ_SCOPES);
    if ("response" in auth) return auth.response;
    const id = c.req.param("event_id");
    if (!/^[0-9]{1,19}$/.test(id)) return invalidRequest(c, "event_id", id, "`event_id` must be numeric.");
    const o = parseReadOptions(c, false);
    if ("response" in o) return o.response;
    const found = findEvent(store, id);
    if (!found || !found.conv.participant_ids.includes(auth.user.user_id)) {
      return notFoundBody(c, "dm_event", "event_id", id);
    }
    const body = buildBody(store, baseUrl, [found.view], o);
    return c.json({ ...body, data: (body.data as unknown[])[0] });
  });

  // DELETE /2/dm_events/:event_id: the sender deletes their own message.
  app.delete("/2/dm_events/:event_id", (c) => {
    const auth = requireUserContext(store, c, DM_DELETE_SCOPES);
    if ("response" in auth) return auth.response;
    const id = c.req.param("event_id");
    const found = findEvent(store, id);
    if (!found || !found.conv.participant_ids.includes(auth.user.user_id)) {
      return problem(c, 404, PROBLEM.dmNotFound, "Not Found Error", `Could not find DM event with id: [${id}].`);
    }
    if (found.view.sender_id !== auth.user.user_id) {
      return problem(c, 403, PROBLEM.dmNotOwner, "Forbidden", "You can only delete Direct Messages you sent.");
    }
    if (found.view.generated) {
      const gen = findGeneratedEvent(store, id)!;
      xs.dmConversations.update(gen.conv.id, {
        generated: { ...gen.conv.generated!, deleted: [...gen.conv.generated!.deleted, gen.index] },
      });
    } else {
      const row = xs.dmEvents.findOneBy("event_id", id)!;
      xs.dmEvents.delete(row.id);
    }
    recordSideEffect(c, { type: "delete", collection: "x.dm_events", id, summary: "DM event deleted" });
    return c.json({ data: { deleted: true } });
  });

  async function send(
    c: Context,
    sender: XUser,
    conv: XDmConversation,
    parsed: { text: string | null; mediaKeys: string[] },
  ) {
    const { view, deliveries } = await storeAndDeliverMessage(store, baseUrl, webhooks, {
      sender,
      conv,
      text: parsed.text,
      mediaKeys: parsed.mediaKeys,
    });
    const held = deliveries.filter((d) => d.held).length;
    recordSideEffect(c, {
      type: "create",
      collection: "x.dm_events",
      id: view.id,
      summary: `DM sent in ${conv.conversation_id}; ${deliveries.length - held} webhook deliveries sent, ${held} held`,
    });
    recordHeldDeliveries(c, deliveries);
    return c.json({ data: { dm_conversation_id: conv.conversation_id, dm_event_id: view.id } }, 201);
  }

  // POST /2/dm_conversations/with/:participant_id/messages: send one-to-one.
  app.post("/2/dm_conversations/with/:participant_id/messages", async (c) => {
    const auth = requireUserContext(store, c, DM_WRITE_SCOPES);
    if ("response" in auth) return auth.response;
    const participantId = c.req.param("participant_id");
    if (!/^[0-9]{1,19}$/.test(participantId)) {
      return invalidRequest(c, "participant_id", participantId, "`participant_id` must be a numeric user id.");
    }
    const participant = xs.users.findOneBy("user_id", participantId);
    if (!participant) {
      return problem(
        c,
        400,
        PROBLEM.dmRecipientNotFound,
        "Invalid Request",
        `Could not find user with id: [${participantId}].`,
      );
    }
    // Validate before creating the conversation so a rejected send leaves no trace.
    const parsed = parseSendBody(c, store, auth.user, await c.req.json().catch(() => undefined));
    if ("response" in parsed) return parsed.response;
    const conv = ensureOneToOne(store, auth.user.user_id, participantId);
    return send(c, auth.user, conv, parsed);
  });

  // POST /2/dm_conversations/:dm_conversation_id/messages: send to an existing conversation.
  app.post("/2/dm_conversations/:dm_conversation_id/messages", async (c) => {
    const auth = requireUserContext(store, c, DM_WRITE_SCOPES);
    if ("response" in auth) return auth.response;
    const id = c.req.param("dm_conversation_id");
    const conv = xs.dmConversations.findOneBy("conversation_id", id);
    if (!conv) {
      return problem(c, 404, PROBLEM.dmConversationNotFound, "Not Found Error", `Could not find conversation [${id}].`);
    }
    if (!conv.participant_ids.includes(auth.user.user_id)) {
      return problem(
        c,
        403,
        PROBLEM.dmSenderNotInConversation,
        "Forbidden",
        "You are not a participant in this conversation.",
      );
    }
    const parsed = parseSendBody(c, store, auth.user, await c.req.json().catch(() => undefined));
    if ("response" in parsed) return parsed.response;
    return send(c, auth.user, conv, parsed);
  });

  // POST /2/dm_conversations: create a group conversation with an initial message.
  app.post("/2/dm_conversations", async (c) => {
    const auth = requireUserContext(store, c, DM_WRITE_SCOPES);
    if ("response" in auth) return auth.response;
    const body = (await c.req.json().catch(() => undefined)) as Record<string, unknown> | undefined;
    if (!body || body.conversation_type !== "Group") {
      return invalidRequest(c, "conversation_type", body?.conversation_type, "`conversation_type` must be Group.");
    }
    const ids = Array.isArray(body.participant_ids) ? (body.participant_ids as unknown[]) : [];
    if (ids.length < 2 || ids.length > 49 || ids.some((p) => typeof p !== "string" || !/^[0-9]{1,19}$/.test(p))) {
      return invalidRequest(
        c,
        "participant_ids",
        ids.join(","),
        "`participant_ids` must list 2 to 49 numeric user ids.",
      );
    }
    for (const p of ids as string[]) {
      if (!xs.users.findOneBy("user_id", p)) {
        return problem(c, 400, PROBLEM.dmRecipientNotFound, "Invalid Request", `Could not find user with id: [${p}].`);
      }
    }
    const parsed = parseSendBody(c, store, auth.user, body.message);
    if ("response" in parsed) return parsed.response;
    const conv = xs.dmConversations.insert({
      conversation_id: nextStoredId(store),
      conversation_type: "Group",
      participant_ids: [...new Set([auth.user.user_id, ...(ids as string[])])],
      ordinal: 0,
      generated: null,
    });
    const { view } = await storeAndDeliverMessage(store, baseUrl, webhooks, {
      sender: auth.user,
      conv,
      text: parsed.text,
      mediaKeys: parsed.mediaKeys,
    });
    recordSideEffect(c, { type: "create", collection: "x.dm_conversations", id: conv.conversation_id });
    return c.json({ data: { dm_conversation_id: conv.conversation_id, dm_event_id: view.id } }, 201);
  });
}
