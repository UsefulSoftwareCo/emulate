#!/usr/bin/env node
import { writeFile } from "node:fs/promises";

const PREFIX = "parity-probe-";

function usage() {
  return [
    "Usage:",
    "  node tools/parity/ms-run.mjs --base <url> --token <bearer> --out <results.json>",
    "",
    "Runs self-contained Microsoft Graph v1.0 probes against a Graph-shaped API base URL.",
  ].join("\n");
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg === "--base") args.base = argv[++i];
    else if (arg === "--token") args.token = argv[++i];
    else if (arg === "--out") args.out = argv[++i];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function toBase64(bytes) {
  return Buffer.from(bytes).toString("base64");
}

function jsonBody(value) {
  return {
    body: JSON.stringify(value),
    headers: { "Content-Type": "application/json" },
  };
}

function byteBody(value, contentType = "application/octet-stream") {
  return {
    body: Buffer.from(value),
    headers: { "Content-Type": contentType },
  };
}

function withQuery(path, entries) {
  const params = new URLSearchParams();
  for (const [key, value] of entries) {
    if (value === undefined || value === null || value === "") continue;
    params.append(key, String(value));
  }
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}

function getObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function responseObject(record) {
  return getObject(record.response);
}

function responseId(record) {
  const body = responseObject(record);
  return typeof body?.id === "string" ? body.id : null;
}

function collectionFirstId(record) {
  const body = responseObject(record);
  const values = Array.isArray(body?.value) ? body.value : [];
  return typeof values[0]?.id === "string" ? values[0].id : null;
}

function collectionHasId(record, id) {
  const body = responseObject(record);
  const values = Array.isArray(body?.value) ? body.value : [];
  return values.some((item) => item?.id === id);
}

function binaryResponseBytes(record) {
  const body = responseObject(record);
  if (!body?.__binary || typeof body.bytesBase64 !== "string") return null;
  return Buffer.from(body.bytesBase64, "base64");
}

function requireValue(value, reason) {
  return value ? null : reason;
}

function request(path, body, options = {}) {
  return {
    urlPath: path,
    body: body?.body,
    headers: body?.headers ?? {},
    expectBinary: options.expectBinary ?? false,
    auth: options.auth ?? true,
    authToken: options.authToken,
    redirect: options.redirect,
  };
}

function step(definition) {
  return definition;
}

function addCreated(ctx, kind, id) {
  if (!id) return;
  if (!ctx.created[kind].includes(id)) ctx.created[kind].push(id);
}

function removeCreated(ctx, kind, id) {
  ctx.created[kind] = ctx.created[kind].filter((candidate) => candidate !== id);
}

function makeContext(args) {
  const runId = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const start = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);
  start.setUTCMinutes(0, 0, 0);
  const end = new Date(start.getTime() + 30 * 60 * 1000);
  return {
    base: args.base.replace(/\/+$/, ""),
    token: args.token,
    runId,
    email: null,
    userId: null,
    created: {
      driveItems: [],
      events: [],
    },
    mail: {},
    calendar: {
      start: start.toISOString(),
      end: end.toISOString(),
    },
    drive: {
      folderName: `${PREFIX}folder-${runId}`,
      pathFileName: `${PREFIX}content.bin`,
      scopedFileName: `${PREFIX}scoped.csv`,
      renamedFileName: `${PREFIX}renamed.txt`,
      pathBytes: Buffer.from([0, 1, 2, 3, 250, 251, 252, 253, 254, 255]),
      replacementBytes: Buffer.from(`replacement ${runId}`, "utf8"),
      scopedBytes: Buffer.from(`a,b\n${runId},2\n`, "utf8"),
    },
  };
}

function requireEmail(ctx) {
  return requireValue(ctx.email, "requires /me mail or userPrincipalName");
}

const steps = [
  step({
    name: "graph.me.get",
    method: "GET",
    path: "/v1.0/me",
    request: () => request("/v1.0/me"),
    after: (ctx, record) => {
      const body = responseObject(record);
      if (typeof body?.mail === "string" && body.mail.includes("@")) ctx.email = body.mail;
      else if (typeof body?.userPrincipalName === "string") ctx.email = body.userPrincipalName;
      if (typeof body?.id === "string") ctx.userId = body.id;
      return { me_has_identity: Boolean(ctx.email && ctx.userId) };
    },
  }),
  step({
    name: "graph.users.list.scopeLimited",
    method: "GET",
    path: "/v1.0/users",
    scopeLimited: true,
    request: () => request("/v1.0/users"),
  }),
  step({
    name: "drive.me.get",
    method: "GET",
    path: "/v1.0/me/drive",
    request: () => request("/v1.0/me/drive"),
    after: (ctx, record) => {
      const body = responseObject(record);
      ctx.drive.id = typeof body?.id === "string" ? body.id : null;
      return { drive_has_id: Boolean(ctx.drive.id) };
    },
  }),
  step({
    name: "drive.root.get",
    method: "GET",
    path: "/v1.0/me/drive/root",
    request: () => request("/v1.0/me/drive/root"),
    after: (ctx, record) => {
      ctx.drive.rootId = responseId(record);
    },
  }),
  step({
    name: "drive.root.children.list.initial",
    method: "GET",
    path: "/v1.0/me/drive/root/children",
    request: () => request("/v1.0/me/drive/root/children"),
  }),
  step({
    name: "drive.root.children.createFolder",
    method: "POST",
    path: "/v1.0/me/drive/root/children",
    request: (ctx) =>
      request(
        "/v1.0/me/drive/root/children",
        jsonBody({
          name: ctx.drive.folderName,
          folder: {},
          "@microsoft.graph.conflictBehavior": "rename",
        }),
      ),
    after: (ctx, record) => {
      ctx.drive.folderId = responseId(record);
      addCreated(ctx, "driveItems", ctx.drive.folderId);
    },
  }),
  step({
    name: "drive.folder.children.list.empty",
    method: "GET",
    path: "/v1.0/me/drive/items/{folderId}/children",
    skip: (ctx) => requireValue(ctx.drive.folderId, "requires drive folder id"),
    request: (ctx) => request(`/v1.0/me/drive/items/${encodeURIComponent(ctx.drive.folderId)}/children`),
  }),
  step({
    name: "drive.content.put.path",
    method: "PUT",
    path: "/v1.0/me/drive/root:/{folder}/{file}:/content",
    skip: (ctx) => requireValue(ctx.drive.folderName, "requires drive folder name"),
    request: (ctx) =>
      request(
        `/v1.0/me/drive/root:/${encodeURIComponent(ctx.drive.folderName)}/${encodeURIComponent(
          ctx.drive.pathFileName,
        )}:/content`,
        byteBody(ctx.drive.pathBytes, "text/plain"),
      ),
    after: (ctx, record) => {
      ctx.drive.fileId = responseId(record);
      addCreated(ctx, "driveItems", ctx.drive.fileId);
      const body = responseObject(record);
      return { drive_path_put_extension_mime: body?.file?.mimeType === "application/octet-stream" };
    },
  }),
  step({
    name: "drive.content.get.redirect",
    method: "GET",
    path: "/v1.0/me/drive/items/{fileId}/content",
    skip: (ctx) => requireValue(ctx.drive.fileId, "requires drive file id"),
    request: (ctx) =>
      request(`/v1.0/me/drive/items/${encodeURIComponent(ctx.drive.fileId)}/content`, null, { redirect: "manual" }),
    after: (ctx, record) => {
      ctx.drive.downloadUrl = typeof record.headers?.location === "string" ? record.headers.location : null;
      return { drive_content_redirect_has_location: Boolean(ctx.drive.downloadUrl) };
    },
  }),
  step({
    name: "drive.content.download.follow",
    method: "GET",
    path: "{driveDownloadUrl}",
    skip: (ctx) => requireValue(ctx.drive.downloadUrl, "requires drive download url"),
    request: (ctx) => request(ctx.drive.downloadUrl, null, { auth: false, expectBinary: true }),
    after: (ctx, record) => {
      const bytes = binaryResponseBytes(record);
      return { drive_path_download_roundtrip: Boolean(bytes && Buffer.compare(bytes, ctx.drive.pathBytes) === 0) };
    },
  }),
  step({
    name: "drive.content.put.item",
    method: "PUT",
    path: "/v1.0/me/drive/items/{fileId}/content",
    skip: (ctx) => requireValue(ctx.drive.fileId, "requires drive file id"),
    request: (ctx) =>
      request(
        `/v1.0/me/drive/items/${encodeURIComponent(ctx.drive.fileId)}/content`,
        byteBody(ctx.drive.replacementBytes, "application/pdf"),
      ),
    after: (_ctx, record) => {
      const body = responseObject(record);
      return { drive_item_put_preserves_name: typeof body?.name === "string" && body.name.endsWith(".bin") };
    },
  }),
  step({
    name: "drive.items.patch.rename",
    method: "PATCH",
    path: "/v1.0/me/drive/items/{fileId}",
    skip: (ctx) => requireValue(ctx.drive.fileId, "requires drive file id"),
    request: (ctx) =>
      request(
        `/v1.0/me/drive/items/${encodeURIComponent(ctx.drive.fileId)}`,
        jsonBody({ name: ctx.drive.renamedFileName }),
      ),
  }),
  step({
    name: "drive.folder.children.list.afterFile",
    method: "GET",
    path: "/v1.0/me/drive/items/{folderId}/children",
    skip: (ctx) => requireValue(ctx.drive.folderId && ctx.drive.fileId, "requires drive folder and file ids"),
    request: (ctx) => request(`/v1.0/me/drive/items/${encodeURIComponent(ctx.drive.folderId)}/children`),
    after: (ctx, record) => ({ drive_folder_contains_file: collectionHasId(record, ctx.drive.fileId) }),
  }),
  step({
    name: "drive.items.get.notFound",
    method: "GET",
    path: "/v1.0/me/drive/items/{missingId}",
    request: () => request(`/v1.0/me/drive/items/${PREFIX}missing`),
  }),
  step({
    name: "drive.byId.get",
    method: "GET",
    path: "/v1.0/drives/{driveId}",
    skip: (ctx) => requireValue(ctx.drive.id, "requires drive id"),
    request: (ctx) => request(`/v1.0/drives/${encodeURIComponent(ctx.drive.id)}`),
  }),
  step({
    name: "drive.byId.root.get",
    method: "GET",
    path: "/v1.0/drives/{driveId}/root",
    skip: (ctx) => requireValue(ctx.drive.id, "requires drive id"),
    request: (ctx) => request(`/v1.0/drives/${encodeURIComponent(ctx.drive.id)}/root`),
  }),
  step({
    name: "drive.byId.root.children.list",
    method: "GET",
    path: "/v1.0/drives/{driveId}/root/children",
    skip: (ctx) => requireValue(ctx.drive.id, "requires drive id"),
    request: (ctx) => request(`/v1.0/drives/${encodeURIComponent(ctx.drive.id)}/root/children`),
  }),
  step({
    name: "drive.byId.items.get",
    method: "GET",
    path: "/v1.0/drives/{driveId}/items/{fileId}",
    skip: (ctx) => requireValue(ctx.drive.id && ctx.drive.fileId, "requires drive and file ids"),
    request: (ctx) =>
      request(`/v1.0/drives/${encodeURIComponent(ctx.drive.id)}/items/${encodeURIComponent(ctx.drive.fileId)}`),
  }),
  step({
    name: "drive.byId.content.put.item",
    method: "PUT",
    path: "/v1.0/drives/{driveId}/items/{fileId}/content",
    skip: (ctx) => requireValue(ctx.drive.id && ctx.drive.fileId, "requires drive and file ids"),
    request: (ctx) =>
      request(
        `/v1.0/drives/${encodeURIComponent(ctx.drive.id)}/items/${encodeURIComponent(ctx.drive.fileId)}/content`,
        byteBody(ctx.drive.pathBytes, "application/octet-stream"),
      ),
  }),
  step({
    name: "drive.byId.content.get.redirect",
    method: "GET",
    path: "/v1.0/drives/{driveId}/items/{fileId}/content",
    skip: (ctx) => requireValue(ctx.drive.id && ctx.drive.fileId, "requires drive and file ids"),
    request: (ctx) =>
      request(
        `/v1.0/drives/${encodeURIComponent(ctx.drive.id)}/items/${encodeURIComponent(ctx.drive.fileId)}/content`,
        null,
        {
          redirect: "manual",
        },
      ),
    after: (ctx, record) => {
      ctx.drive.driveScopedDownloadUrl = typeof record.headers?.location === "string" ? record.headers.location : null;
      return { drive_scoped_content_redirect_has_location: Boolean(ctx.drive.driveScopedDownloadUrl) };
    },
  }),
  step({
    name: "drive.byId.content.download.follow",
    method: "GET",
    path: "{driveScopedDownloadUrl}",
    skip: (ctx) => requireValue(ctx.drive.driveScopedDownloadUrl, "requires drive scoped download url"),
    request: (ctx) => request(ctx.drive.driveScopedDownloadUrl, null, { auth: false, expectBinary: true }),
    after: (ctx, record) => {
      const bytes = binaryResponseBytes(record);
      return { drive_scoped_download_roundtrip: Boolean(bytes && Buffer.compare(bytes, ctx.drive.pathBytes) === 0) };
    },
  }),
  step({
    name: "drive.byId.content.put.path",
    method: "PUT",
    path: "/v1.0/drives/{driveId}/items/root:/{file}:/content",
    skip: (ctx) => requireValue(ctx.drive.id, "requires drive id"),
    request: (ctx) =>
      request(
        `/v1.0/drives/${encodeURIComponent(ctx.drive.id)}/items/root:/${encodeURIComponent(
          ctx.drive.scopedFileName,
        )}:/content`,
        byteBody(ctx.drive.scopedBytes, "text/plain"),
      ),
    after: (ctx, record) => {
      ctx.drive.scopedFileId = responseId(record);
      addCreated(ctx, "driveItems", ctx.drive.scopedFileId);
    },
  }),
  step({
    name: "mail.messages.list",
    method: "GET",
    path: "/v1.0/me/messages?$top=5",
    request: () => request(withQuery("/v1.0/me/messages", [["$top", "5"]])),
    after: (ctx, record) => {
      ctx.mail.firstMessageId = collectionFirstId(record);
    },
  }),
  step({
    name: "mail.messages.get.first",
    method: "GET",
    path: "/v1.0/me/messages/{messageId}",
    skip: (ctx) => requireValue(ctx.mail.firstMessageId, "requires a message id from list"),
    request: (ctx) => request(`/v1.0/me/messages/${encodeURIComponent(ctx.mail.firstMessageId)}`),
  }),
  step({
    name: "mail.sendMail",
    method: "POST",
    path: "/v1.0/me/sendMail",
    skip: requireEmail,
    request: (ctx) =>
      request(
        "/v1.0/me/sendMail",
        jsonBody({
          message: {
            subject: `${PREFIX}send-${ctx.runId}`,
            body: { contentType: "text", content: "Microsoft Graph parity probe." },
            toRecipients: [{ emailAddress: { address: ctx.email } }],
          },
          saveToSentItems: false,
        }),
      ),
  }),
  step({
    name: "calendar.default.get",
    method: "GET",
    path: "/v1.0/me/calendar",
    request: () => request("/v1.0/me/calendar"),
  }),
  step({
    name: "calendar.calendars.list",
    method: "GET",
    path: "/v1.0/me/calendars",
    request: () => request("/v1.0/me/calendars"),
  }),
  step({
    name: "calendar.events.list",
    method: "GET",
    path: "/v1.0/me/events?$top=5",
    request: () => request(withQuery("/v1.0/me/events", [["$top", "5"]])),
  }),
  step({
    name: "calendar.events.create",
    method: "POST",
    path: "/v1.0/me/events",
    skip: requireEmail,
    request: (ctx) =>
      request(
        "/v1.0/me/events",
        jsonBody({
          subject: `${PREFIX}event-${ctx.runId}`,
          body: { contentType: "text", content: "Microsoft Graph parity probe event." },
          start: { dateTime: ctx.calendar.start, timeZone: "UTC" },
          end: { dateTime: ctx.calendar.end, timeZone: "UTC" },
          attendees: [{ emailAddress: { address: ctx.email, name: ctx.email }, type: "required" }],
        }),
      ),
    after: (ctx, record) => {
      ctx.calendar.eventId = responseId(record);
      addCreated(ctx, "events", ctx.calendar.eventId);
    },
  }),
  step({
    name: "calendar.events.get",
    method: "GET",
    path: "/v1.0/me/events/{eventId}",
    skip: (ctx) => requireValue(ctx.calendar.eventId, "requires event id"),
    request: (ctx) => request(`/v1.0/me/events/${encodeURIComponent(ctx.calendar.eventId)}`),
  }),
  step({
    name: "calendar.events.delete",
    method: "DELETE",
    path: "/v1.0/me/events/{eventId}",
    skip: (ctx) => requireValue(ctx.calendar.eventId, "requires event id"),
    request: (ctx) => request(`/v1.0/me/events/${encodeURIComponent(ctx.calendar.eventId)}`),
    after: (ctx) => {
      removeCreated(ctx, "events", ctx.calendar.eventId);
    },
  }),
  step({
    name: "calendar.events.get.notFound",
    method: "GET",
    path: "/v1.0/me/events/{missingId}",
    request: () => request(`/v1.0/me/events/${PREFIX}missing`),
  }),
  step({
    name: "auth.badToken.me",
    method: "GET",
    path: "/v1.0/me",
    request: () => request("/v1.0/me", null, { authToken: `${PREFIX}bad-token` }),
  }),
  step({
    name: "errors.nonexistentRoute",
    method: "GET",
    path: "/v1.0/parity-probe-not-implemented",
    request: () => request("/v1.0/parity-probe-not-implemented"),
  }),
  step({
    name: "drive.cleanup.delete.scopedFile",
    method: "DELETE",
    path: "/v1.0/me/drive/items/{scopedFileId}",
    skip: (ctx) => requireValue(ctx.drive.scopedFileId, "requires scoped drive file id"),
    request: (ctx) => request(`/v1.0/me/drive/items/${encodeURIComponent(ctx.drive.scopedFileId)}`),
    after: (ctx) => removeCreated(ctx, "driveItems", ctx.drive.scopedFileId),
  }),
  step({
    name: "drive.cleanup.delete.file",
    method: "DELETE",
    path: "/v1.0/me/drive/items/{fileId}",
    skip: (ctx) => requireValue(ctx.drive.fileId, "requires drive file id"),
    request: (ctx) => request(`/v1.0/me/drive/items/${encodeURIComponent(ctx.drive.fileId)}`),
    after: (ctx) => removeCreated(ctx, "driveItems", ctx.drive.fileId),
  }),
  step({
    name: "drive.cleanup.delete.folder",
    method: "DELETE",
    path: "/v1.0/me/drive/items/{folderId}",
    skip: (ctx) => requireValue(ctx.drive.folderId, "requires drive folder id"),
    request: (ctx) => request(`/v1.0/me/drive/items/${encodeURIComponent(ctx.drive.folderId)}`),
    after: (ctx) => removeCreated(ctx, "driveItems", ctx.drive.folderId),
  }),
  step({
    name: "calendar.cleanup.delete.created",
    method: "DELETE",
    path: "/v1.0/me/events/{eventId}",
    skip: (ctx) => requireValue(ctx.created.events[0], "no created calendar event remains"),
    request: (ctx) => request(`/v1.0/me/events/${encodeURIComponent(ctx.created.events[0])}`),
    after: (ctx) => removeCreated(ctx, "events", ctx.created.events[0]),
  }),
];

function extractHeaders(response) {
  const headers = {};
  for (const name of ["content-type", "location"]) {
    const value = response.headers.get(name);
    if (value) headers[name] = value;
  }
  return headers;
}

async function performRequest(ctx, method, req) {
  const url = req.urlPath.startsWith("http")
    ? req.urlPath
    : `${ctx.base}${req.urlPath.startsWith("/") ? "" : "/"}${req.urlPath}`;
  const headers = { ...req.headers };
  if (req.auth !== false) {
    headers.Authorization = `Bearer ${req.authToken ?? ctx.token}`;
  }

  const response = await fetch(url, {
    method,
    headers,
    body: method === "GET" || method === "HEAD" ? undefined : req.body,
    redirect: req.redirect ?? "follow",
  });
  const bytes = Buffer.from(await response.arrayBuffer());
  return {
    status: response.status,
    headers: extractHeaders(response),
    response: parseResponseBody(response, bytes, req.expectBinary),
  };
}

function parseResponseBody(response, bytes, expectBinary) {
  if (expectBinary) return { __binary: true, bytesBase64: toBase64(bytes) };
  if (bytes.length === 0) return null;

  const contentType = response.headers.get("content-type") ?? "";
  const text = bytes.toString("utf8");
  if (contentType.includes("application/json") || text.trim().startsWith("{") || text.trim().startsWith("[")) {
    try {
      return JSON.parse(text);
    } catch {
      return { __text: text };
    }
  }
  return { __text: text };
}

async function runStep(ctx, definition) {
  const record = {
    name: definition.name,
    method: definition.method,
    path: definition.path,
  };
  if (definition.scopeLimited) record.scopeLimited = true;

  if (definition.skipped) {
    record.skipped = definition.skipped;
    console.log(`skip ${definition.name}: ${definition.skipped}`);
    return record;
  }

  try {
    const skipReason = definition.skip?.(ctx);
    if (skipReason) {
      record.skipped = skipReason;
      console.log(`skip ${definition.name}: ${skipReason}`);
      return record;
    }

    console.log(`run ${definition.name}`);
    const req = definition.request(ctx);
    const result = await performRequest(ctx, definition.method, req);
    record.status = result.status;
    record.headers = result.headers;
    record.response = result.response;

    if (definition.after) {
      const checks = await definition.after(ctx, record);
      if (checks && Object.keys(checks).length > 0) record.checks = checks;
    }
  } catch (error) {
    record.failure = error instanceof Error ? error.message : String(error);
  }

  return record;
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(usage());
    process.exitCode = 2;
    return;
  }

  if (args.help) {
    console.log(usage());
    return;
  }

  if (!args.base || !args.token || !args.out) {
    console.error(usage());
    process.exitCode = 2;
    return;
  }

  const ctx = makeContext(args);
  const startedAt = new Date().toISOString();
  const probes = [];
  for (const definition of steps) {
    probes.push(await runStep(ctx, definition));
  }

  const result = {
    tool: "microsoft-graph-parity",
    version: 1,
    base: ctx.base,
    runId: ctx.runId,
    startedAt,
    endedAt: new Date().toISOString(),
    probeCount: probes.length,
    probes,
  };

  await writeFile(args.out, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  console.log(`wrote ${args.out}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
