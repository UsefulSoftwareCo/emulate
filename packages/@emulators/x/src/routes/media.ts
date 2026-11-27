import type { Context, RouteContext, Store } from "@emulators/core";
import { recordSideEffect } from "@emulators/core";
import { getXStore } from "../store.js";
import type { XMedia, XUser } from "../entities.js";
import { requireUserContext } from "./auth.js";
import { PROBLEM, invalidRequest, problem } from "./problems.js";
import {
  findEvent,
  findMediaByKey,
  mediaKeyPrefix,
  mediaStream,
  nextStoredId,
  storeSegment,
  storedMediaBytes,
} from "../dm-model.js";

/**
 * Media upload (v2) and DM media download, per the v2 OpenAPI spec (2.175) and
 * https://docs.x.com/x-api/media/introduction:
 *   - POST /2/media/upload: one request, base64 `media` in JSON or raw bytes in multipart;
 *   - POST /2/media/upload/initialize, /{id}/append (segment_index, up to 8 MB a segment),
 *     /{id}/finalize: chunked upload;
 *   - GET /2/media/upload?command=STATUS&media_id=...;
 *   - GET /2/dm_conversations/media/{dm_id}/{media_id}/{resource_id}: the bytes of a DM
 *     attachment, for a participant, with `dm.read`.
 * Upload routes need `media.write`. Content is stored as given and never decoded
 * or transcoded, so processing always reports `succeeded` at once.
 */

const MEDIA_CATEGORIES = new Set([
  "amplify_video",
  "tweet_gif",
  "tweet_image",
  "tweet_video",
  "dm_gif",
  "dm_image",
  "dm_video",
  "subtitles",
]);
const SIMPLE_CATEGORIES = new Set([
  "tweet_image",
  "tweet_video",
  "tweet_gif",
  "dm_image",
  "dm_video",
  "dm_gif",
  "subtitles",
]);
const MB = 1024 * 1024;
/** Size limits from https://docs.x.com/x-api/media/introduction (non-Premium). */
function maxBytes(category: string): number {
  if (category.endsWith("_image")) return 5 * MB;
  if (category.endsWith("_gif")) return 15 * MB;
  if (category === "dm_video") return 512 * MB;
  return 512 * MB;
}
const MAX_SEGMENT = 8 * MB;

type FixedLengthStreamCtor = new (length: number) => TransformStream<Uint8Array, Uint8Array>;

/**
 * Workers drop a Content-Length set on a streamed body unless the stream is a
 * FixedLengthStream (a Workers runtime global); wrap it there so the download
 * keeps its length. Elsewhere the header is sent as set.
 */
function withLength(stream: ReadableStream<Uint8Array>, length: number): ReadableStream<Uint8Array> {
  const Fixed = (globalThis as { FixedLengthStream?: FixedLengthStreamCtor }).FixedLengthStream;
  if (!Fixed) return stream;
  const { readable, writable } = new Fixed(length);
  void stream.pipeTo(writable).catch(() => {});
  return readable;
}
const UPLOAD_TTL_SECS = 24 * 60 * 60;

interface UploadFields {
  media?: Uint8Array;
  media_category?: string;
  media_type?: string;
  segment_index?: number;
  additional_owners?: string[];
  total_bytes?: number;
}

function sniffType(bytes: Uint8Array): string | null {
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return "image/png";
  if (bytes[0] === 0x47 && bytes[1] === 0x49) return "image/gif";
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[8] === 0x57) return "image/webp";
  return null;
}

function ownersOf(raw: unknown): string[] | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  const list = Array.isArray(raw) ? raw.map(String) : String(raw).split(",");
  return list.map((s) => s.trim()).filter((s) => /^[0-9]{1,19}$/.test(s));
}

/** Read an upload body: JSON with base64 `media`, or multipart with raw bytes. */
async function readUploadFields(c: Context): Promise<UploadFields | { error: string }> {
  const type = (c.req.header("Content-Type") ?? "").toLowerCase();
  if (type.includes("multipart/form-data") || type.includes("application/x-www-form-urlencoded")) {
    const form = await c.req.raw.formData().catch(() => null);
    if (!form) return { error: "The multipart body could not be read." };
    const out: UploadFields = {};
    const media = form.get("media");
    if (media !== null) {
      out.media =
        typeof media === "string"
          ? new Uint8Array(Buffer.from(media, "base64"))
          : new Uint8Array(await media.arrayBuffer());
    }
    const str = (k: string) => {
      const v = form.get(k);
      return typeof v === "string" ? v : undefined;
    };
    out.media_category = str("media_category");
    out.media_type = str("media_type");
    if (str("segment_index") !== undefined) out.segment_index = Number(str("segment_index"));
    if (str("total_bytes") !== undefined) out.total_bytes = Number(str("total_bytes"));
    out.additional_owners = ownersOf(str("additional_owners"));
    return out;
  }
  const body = (await c.req.json().catch(() => undefined)) as Record<string, unknown> | undefined;
  if (!body || typeof body !== "object") return { error: "The request body must be JSON or multipart." };
  const out: UploadFields = {};
  if (typeof body.media === "string") out.media = new Uint8Array(Buffer.from(body.media, "base64"));
  if (typeof body.media_category === "string") out.media_category = body.media_category;
  if (typeof body.media_type === "string") out.media_type = body.media_type;
  if (body.segment_index !== undefined) out.segment_index = Number(body.segment_index);
  if (body.total_bytes !== undefined) out.total_bytes = Number(body.total_bytes);
  out.additional_owners = ownersOf(body.additional_owners);
  return out;
}

function defaultType(category: string): string {
  if (category.endsWith("_gif")) return "image/gif";
  if (category.endsWith("_video")) return "video/mp4";
  if (category === "subtitles") return "text/srt";
  return "image/jpeg";
}

function uploadData(m: XMedia, withProcessing: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: m.media_id,
    media_key: m.media_key,
    size: m.size,
    expires_after_secs: Math.max(0, Math.floor((m.expires_at_ms - Date.now()) / 1000)),
  };
  if (m.media_type.startsWith("image/")) {
    out.image = { image_type: m.media_type, w: m.width ?? 0, h: m.height ?? 0 };
  } else if (m.media_type.startsWith("video/")) {
    out.video = { video_type: m.media_type };
  }
  if (withProcessing && m.media_type.startsWith("video/")) {
    out.processing_info = { state: "succeeded", progress_percent: 100 };
  }
  return out;
}

function ownMedia(store: Store, id: string, user: XUser): XMedia | undefined {
  const m = getXStore(store).media.findOneBy("media_id", id);
  return m && m.owner_id === user.user_id && m.source === "uploaded" ? m : undefined;
}

export function mediaRoutes({ app, store }: RouteContext): void {
  const xs = getXStore(store);

  function create(user: XUser, f: UploadFields, category: string, mediaType: string, state: XMedia["state"]): XMedia {
    const mediaId = nextStoredId(store);
    return xs.media.insert({
      media_id: mediaId,
      media_key: `${mediaKeyPrefix(category, mediaType)}${mediaId}`,
      owner_id: user.user_id,
      additional_owners: f.additional_owners ?? [],
      media_category: category,
      media_type: mediaType,
      size: f.total_bytes ?? 0,
      state,
      source: "uploaded",
      // Dimensions are not decoded from the bytes.
      width: mediaType.startsWith("image/") ? 1200 : null,
      height: mediaType.startsWith("image/") ? 800 : null,
      created_at_ms: Date.now(),
      expires_at_ms: Date.now() + UPLOAD_TTL_SECS * 1000,
    });
  }

  // POST /2/media/upload: the whole file in one request.
  app.post("/2/media/upload", async (c) => {
    const auth = requireUserContext(store, c, ["media.write"]);
    if ("response" in auth) return auth.response;
    const f = await readUploadFields(c);
    if ("error" in f) return invalidRequest(c, "media", "", f.error);
    if (!f.media) return invalidRequest(c, "media", "", "`media` is required.");
    const category = f.media_category ?? "";
    if (!SIMPLE_CATEGORIES.has(category)) {
      return invalidRequest(
        c,
        "media_category",
        category,
        "`media_category` is required and must be a known category.",
      );
    }
    if (f.media.length > maxBytes(category)) {
      return invalidRequest(c, "media", f.media.length, `The file is larger than ${maxBytes(category)} bytes.`);
    }
    const mediaType = f.media_type ?? sniffType(f.media) ?? defaultType(category);
    const m = create(auth.user, { ...f, total_bytes: f.media.length }, category, mediaType, "succeeded");
    storeSegment(store, m.media_id, 0, f.media);
    recordSideEffect(c, { type: "create", collection: "x.media", id: m.media_id, summary: `${f.media.length} bytes` });
    return c.json({ data: uploadData(m, true) });
  });

  // POST /2/media/upload/initialize: start a chunked upload.
  app.post("/2/media/upload/initialize", async (c) => {
    const auth = requireUserContext(store, c, ["media.write"]);
    if ("response" in auth) return auth.response;
    const body = (await c.req.json().catch(() => undefined)) as Record<string, unknown> | undefined;
    if (!body || typeof body !== "object") return invalidRequest(c, "body", "", "The request body must be JSON.");
    const category = typeof body.media_category === "string" ? body.media_category : "tweet_image";
    if (!MEDIA_CATEGORIES.has(category)) {
      return invalidRequest(c, "media_category", category, "`media_category` is not a known category.");
    }
    const mediaType = typeof body.media_type === "string" ? body.media_type : defaultType(category);
    const total = body.total_bytes === undefined ? undefined : Number(body.total_bytes);
    if (total !== undefined && (!Number.isInteger(total) || total < 0 || total > maxBytes(category))) {
      return invalidRequest(c, "total_bytes", body.total_bytes, `\`total_bytes\` must be 0 to ${maxBytes(category)}.`);
    }
    const m = create(
      auth.user,
      { total_bytes: total, additional_owners: ownersOf(body.additional_owners) },
      category,
      mediaType,
      "uploading",
    );
    recordSideEffect(c, { type: "create", collection: "x.media", id: m.media_id, summary: "upload initialized" });
    return c.json({ data: { id: m.media_id, media_key: m.media_key, expires_after_secs: UPLOAD_TTL_SECS } });
  });

  // POST /2/media/upload/:id/append: one segment of the file.
  app.post("/2/media/upload/:id/append", async (c) => {
    const auth = requireUserContext(store, c, ["media.write"]);
    if ("response" in auth) return auth.response;
    const m = ownMedia(store, c.req.param("id"), auth.user);
    if (!m || m.state !== "uploading") {
      return invalidRequest(c, "id", c.req.param("id"), "No upload in progress with this id.");
    }
    const f = await readUploadFields(c);
    if ("error" in f) return invalidRequest(c, "media", "", f.error);
    if (!f.media) return invalidRequest(c, "media", "", "`media` is required.");
    const index = f.segment_index;
    if (index === undefined || !Number.isInteger(index) || index < 0 || index > 9999) {
      return invalidRequest(c, "segment_index", index, "`segment_index` must be an integer from 0 to 9999.");
    }
    if (f.media.length > MAX_SEGMENT) {
      return invalidRequest(c, "media", f.media.length, `A segment can be at most ${MAX_SEGMENT} bytes.`);
    }
    storeSegment(store, m.media_id, index, f.media);
    return c.json({ data: { expires_at: Math.floor(m.expires_at_ms / 1000) } });
  });

  // POST /2/media/upload/:id/finalize: complete a chunked upload.
  app.post("/2/media/upload/:id/finalize", (c) => {
    const auth = requireUserContext(store, c, ["media.write"]);
    if ("response" in auth) return auth.response;
    const m = ownMedia(store, c.req.param("id"), auth.user);
    if (!m) return invalidRequest(c, "id", c.req.param("id"), "No upload with this id.");
    const stored = storedMediaBytes(store, m.media_id);
    if (stored === 0) return invalidRequest(c, "id", m.media_id, "No segments were appended.");
    if (m.state === "uploading" && m.size > 0 && stored !== m.size) {
      return invalidRequest(c, "total_bytes", m.size, `Expected ${m.size} bytes, received ${stored}.`);
    }
    if (stored > maxBytes(m.media_category)) {
      return invalidRequest(c, "media", stored, `The file is larger than ${maxBytes(m.media_category)} bytes.`);
    }
    const done = xs.media.update(m.id, { state: "succeeded", size: stored })!;
    recordSideEffect(c, {
      type: "update",
      collection: "x.media",
      id: m.media_id,
      summary: `finalized ${stored} bytes`,
    });
    return c.json({ data: uploadData(done, true) });
  });

  // GET /2/media/upload?command=STATUS&media_id=...: processing status.
  app.get("/2/media/upload", (c) => {
    const auth = requireUserContext(store, c, ["media.write"]);
    if ("response" in auth) return auth.response;
    const id = c.req.query("media_id") ?? "";
    const m = ownMedia(store, id, auth.user);
    if (!m) return invalidRequest(c, "media_id", id, "No media with this id.");
    const data = uploadData(m, false);
    data.processing_info =
      m.state === "succeeded"
        ? { state: "succeeded", progress_percent: 100 }
        : { state: "pending", check_after_secs: 1 };
    return c.json({ data });
  });

  // GET /2/dm_conversations/media/:dm_id/:media_id/:resource_id: a DM attachment's bytes.
  app.get("/2/dm_conversations/media/:dm_id/:media_id/:resource_id", (c) => {
    const auth = requireUserContext(store, c, ["dm.read"]);
    if ("response" in auth) return auth.response;
    const dmId = c.req.param("dm_id");
    const key = c.req.param("media_id");
    const resourceId = c.req.param("resource_id");
    const found = findEvent(store, dmId);
    const media = found ? findMediaByKey(store, key) : null;
    if (
      !found ||
      !found.conv.participant_ids.includes(auth.user.user_id) ||
      !found.view.media_keys.includes(key) ||
      !media ||
      media.media_id !== resourceId
    ) {
      return problem(c, 404, PROBLEM.resourceNotFound, "Not Found Error", "Could not find this DM media.");
    }
    c.set("ledgerOmitResponseBody", true);
    recordSideEffect(c, { type: "custom", collection: "x.media", id: media.media_key, summary: `${media.size} bytes` });
    return new Response(withLength(mediaStream(store, media), media.size), {
      status: 200,
      headers: {
        // The spec declares the body as application/octet-stream.
        "content-type": "application/octet-stream",
        "content-length": String(media.size),
      },
    });
  });
}
