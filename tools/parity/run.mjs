#!/usr/bin/env node
import { writeFile } from "node:fs/promises";

const PREFIX = "parity-probe-";
const FOLDER_MIME = "application/vnd.google-apps.folder";
const TEXT_MIME = "text/plain";

function usage() {
  return [
    "Usage:",
    "  node tools/parity/run.mjs --base <url> --token <bearer> --out <results.json>",
    "",
    "Runs self-contained Google API probes against a Google-shaped API base URL.",
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

function base64Url(value) {
  return Buffer.from(value, "utf8").toString("base64url");
}

function bytesBase64Url(bytes) {
  return Buffer.from(bytes).toString("base64url");
}

function decodeBase64Url(value) {
  return Buffer.from(value ?? "", "base64url");
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

function textBody(value, contentType = TEXT_MIME) {
  return {
    body: value,
    headers: { "Content-Type": contentType },
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
    if (Array.isArray(value)) {
      for (const item of value) params.append(key, item);
    } else {
      params.append(key, String(value));
    }
  }
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}

function makeRawMessage({ from, to, subject, body, messageId, inReplyTo, references, attachments = [] }) {
  const headers = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    `Message-ID: ${messageId}`,
    ...(inReplyTo ? [`In-Reply-To: ${inReplyTo}`] : []),
    ...(references ? [`References: ${references}`] : []),
    `Date: ${new Date().toUTCString()}`,
    "MIME-Version: 1.0",
  ];

  if (!attachments.length) {
    headers.push("Content-Type: text/plain; charset=utf-8");
    return base64Url(`${headers.join("\r\n")}\r\n\r\n${body}\r\n`);
  }

  const boundary = `${PREFIX}mixed-${Math.random().toString(16).slice(2)}`;
  headers.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
  const parts = [`--${boundary}`, "Content-Type: text/plain; charset=utf-8", "", body];
  for (const attachment of attachments) {
    parts.push(
      `--${boundary}`,
      `Content-Type: ${attachment.mimeType}; name="${attachment.filename}"`,
      `Content-Disposition: attachment; filename="${attachment.filename}"`,
      "Content-Transfer-Encoding: base64",
      "",
      Buffer.from(attachment.content).toString("base64"),
    );
  }
  parts.push(`--${boundary}--`, "");
  return base64Url(`${headers.join("\r\n")}\r\n\r\n${parts.join("\r\n")}`);
}

function driveMultipartBody(metadata, content, contentType = TEXT_MIME) {
  const boundary = `${PREFIX}drive-${Math.random().toString(16).slice(2)}`;
  return {
    body: Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(
          metadata,
        )}\r\n--${boundary}\r\nContent-Type: ${contentType}\r\n\r\n`,
        "utf8",
      ),
      Buffer.from(content),
      Buffer.from(`\r\n--${boundary}--\r\n`, "utf8"),
    ]),
    headers: { "Content-Type": `multipart/related; boundary="${boundary}"` },
  };
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

function messageLabelIds(record) {
  const body = responseObject(record);
  return Array.isArray(body?.labelIds) ? body.labelIds.filter((id) => typeof id === "string") : [];
}

function extractHeaders(message) {
  const headers = message?.payload?.headers;
  return Array.isArray(headers) ? headers : [];
}

function headerValue(message, name) {
  const wanted = name.toLowerCase();
  const header = extractHeaders(message).find((entry) => String(entry?.name ?? "").toLowerCase() === wanted);
  return typeof header?.value === "string" ? header.value : null;
}

function findAttachmentId(part) {
  if (!part || typeof part !== "object") return null;
  const id = part.body && typeof part.body.attachmentId === "string" ? part.body.attachmentId : null;
  if (id) return id;
  if (!Array.isArray(part.parts)) return null;
  for (const child of part.parts) {
    const found = findAttachmentId(child);
    if (found) return found;
  }
  return null;
}

function historyHas(historyBody, key) {
  const entries = Array.isArray(historyBody?.history) ? historyBody.history : [];
  return entries.some((entry) => Array.isArray(entry?.[key]) && entry[key].length > 0);
}

function eventListHasId(record, id) {
  const body = responseObject(record);
  const items = Array.isArray(body?.items) ? body.items : [];
  return items.some((item) => item?.id === id);
}

function listFirstId(record, collectionKey) {
  const body = responseObject(record);
  const items = Array.isArray(body?.[collectionKey]) ? body[collectionKey] : [];
  return typeof items[0]?.id === "string" ? items[0].id : null;
}

function binaryResponseBytes(record) {
  const body = responseObject(record);
  if (!body?.__binary || typeof body.bytesBase64 !== "string") return null;
  return Buffer.from(body.bytesBase64, "base64");
}

function addCreated(ctx, kind, id) {
  if (!id) return;
  if (!ctx.created[kind].includes(id)) ctx.created[kind].push(id);
}

function makeContext(args) {
  const runId = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const start = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);
  start.setUTCMinutes(0, 0, 0);
  const end = new Date(start.getTime() + 30 * 60 * 1000);
  const windowStart = new Date(start.getTime() - 30 * 60 * 1000);
  const windowEnd = new Date(end.getTime() + 30 * 60 * 1000);

  return {
    base: args.base.replace(/\/+$/, ""),
    token: args.token,
    runId,
    email: null,
    created: {
      labels: [],
      messages: [],
      drafts: [],
      driveFiles: [],
      calendarEvents: [],
    },
    labels: {},
    messages: {},
    drafts: {},
    threads: {},
    drive: {},
    calendar: {
      start: start.toISOString(),
      end: end.toISOString(),
      windowStart: windowStart.toISOString(),
      windowEnd: windowEnd.toISOString(),
    },
  };
}

function subject(ctx, name) {
  return `${PREFIX}${name}-${ctx.runId}`;
}

function messageId(ctx, name) {
  return `<${PREFIX}${name}-${ctx.runId}@example.com>`;
}

function raw(ctx, name, overrides = {}) {
  const subj = overrides.subject ?? subject(ctx, name);
  return makeRawMessage({
    from: ctx.email,
    to: ctx.email,
    subject: subj,
    body: overrides.body ?? `${subj}\n`,
    messageId: overrides.messageId ?? messageId(ctx, name),
    inReplyTo: overrides.inReplyTo,
    references: overrides.references,
    attachments: overrides.attachments,
  });
}

function requireEmail(ctx) {
  return ctx.email ? null : "requires userinfo email";
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
  };
}

function step(definition) {
  return definition;
}

const steps = [
  step({
    name: "userinfo.get",
    method: "GET",
    path: "/oauth2/v2/userinfo",
    request: () => request("/oauth2/v2/userinfo"),
    after: (ctx, record) => {
      const body = responseObject(record);
      if (typeof body?.email === "string") ctx.email = body.email;
      return { userinfo_has_email: typeof body?.email === "string" && body.email.includes("@") };
    },
  }),
  step({
    name: "gmail.labels.list.initial",
    method: "GET",
    path: "/gmail/v1/users/me/labels",
    skip: requireEmail,
    request: () => request("/gmail/v1/users/me/labels"),
  }),
  step({
    name: "gmail.labels.create.lifecycle",
    method: "POST",
    path: "/gmail/v1/users/me/labels",
    skip: requireEmail,
    request: (ctx) =>
      request(
        "/gmail/v1/users/me/labels",
        jsonBody({
          name: subject(ctx, "label-lifecycle"),
          messageListVisibility: "show",
          labelListVisibility: "labelShow",
          color: { backgroundColor: "#16a765", textColor: "#000000" },
        }),
      ),
    after: (ctx, record) => {
      ctx.labels.lifecycle = responseId(record);
      addCreated(ctx, "labels", ctx.labels.lifecycle);
    },
  }),
  step({
    name: "gmail.labels.get.lifecycle",
    method: "GET",
    path: "/gmail/v1/users/me/labels/{labelId}",
    skip: (ctx) => requireValue(ctx.labels.lifecycle, "requires lifecycle label id"),
    request: (ctx) => request(`/gmail/v1/users/me/labels/${encodeURIComponent(ctx.labels.lifecycle)}`),
  }),
  step({
    name: "gmail.labels.put.lifecycle",
    method: "PUT",
    path: "/gmail/v1/users/me/labels/{labelId}",
    skip: (ctx) => requireValue(ctx.labels.lifecycle, "requires lifecycle label id"),
    request: (ctx) =>
      request(
        `/gmail/v1/users/me/labels/${encodeURIComponent(ctx.labels.lifecycle)}`,
        jsonBody({
          name: subject(ctx, "label-lifecycle-put"),
          messageListVisibility: "show",
          labelListVisibility: "labelShow",
          color: { backgroundColor: "#16a765", textColor: "#000000" },
        }),
      ),
  }),
  step({
    name: "gmail.labels.patch.lifecycle",
    method: "PATCH",
    path: "/gmail/v1/users/me/labels/{labelId}",
    skip: (ctx) => requireValue(ctx.labels.lifecycle, "requires lifecycle label id"),
    request: (ctx) =>
      request(
        `/gmail/v1/users/me/labels/${encodeURIComponent(ctx.labels.lifecycle)}`,
        jsonBody({
          name: subject(ctx, "label-lifecycle-patch"),
          color: { backgroundColor: "#16a765", textColor: "#000000" },
        }),
      ),
  }),
  step({
    name: "gmail.labels.create.duplicate",
    method: "POST",
    path: "/gmail/v1/users/me/labels",
    skip: (ctx) => requireValue(ctx.labels.lifecycle, "requires lifecycle label id"),
    request: (ctx) =>
      request(
        "/gmail/v1/users/me/labels",
        jsonBody({
          name: subject(ctx, "label-lifecycle-patch"),
          color: { backgroundColor: "#16a765", textColor: "#000000" },
        }),
      ),
  }),
  step({
    name: "gmail.labels.delete.lifecycle",
    method: "DELETE",
    path: "/gmail/v1/users/me/labels/{labelId}",
    skip: (ctx) => requireValue(ctx.labels.lifecycle, "requires lifecycle label id"),
    request: (ctx) => request(`/gmail/v1/users/me/labels/${encodeURIComponent(ctx.labels.lifecycle)}`),
  }),
  step({
    name: "gmail.labels.get.afterDelete",
    method: "GET",
    path: "/gmail/v1/users/me/labels/{labelId}",
    skip: (ctx) => requireValue(ctx.labels.lifecycle, "requires lifecycle label id"),
    request: (ctx) => request(`/gmail/v1/users/me/labels/${encodeURIComponent(ctx.labels.lifecycle)}`),
  }),
  ...["message", "batch", "thread", "filter"].map((key) =>
    step({
      name: `gmail.labels.create.${key}`,
      method: "POST",
      path: "/gmail/v1/users/me/labels",
      skip: requireEmail,
      request: (ctx) =>
        request(
          "/gmail/v1/users/me/labels",
          jsonBody({
            name: subject(ctx, `label-${key}`),
            messageListVisibility: "show",
            labelListVisibility: "labelShow",
            color: { backgroundColor: "#16a765", textColor: "#000000" },
          }),
        ),
      after: (ctx, record) => {
        ctx.labels[key] = responseId(record);
        addCreated(ctx, "labels", ctx.labels[key]);
      },
    }),
  ),
  step({
    name: "gmail.messages.insert",
    method: "POST",
    path: "/gmail/v1/users/me/messages",
    skip: requireEmail,
    request: (ctx) =>
      request("/gmail/v1/users/me/messages", jsonBody({ raw: raw(ctx, "message-insert"), labelIds: ["INBOX"] })),
    after: (ctx, record) => {
      const body = responseObject(record);
      ctx.messages.main = body?.id;
      ctx.messages.mainThread = body?.threadId;
      if (typeof body?.historyId === "string") ctx.messages.mainHistory = body.historyId;
      addCreated(ctx, "messages", ctx.messages.main);
    },
  }),
  ...["a", "b"].map((suffix) =>
    step({
      name: `gmail.messages.import.page.${suffix}`,
      method: "POST",
      path: "/gmail/v1/users/me/messages/import",
      skip: requireEmail,
      request: (ctx) =>
        request(
          "/gmail/v1/users/me/messages/import",
          jsonBody({
            raw: raw(ctx, `message-page-${suffix}`, {
              subject: subject(ctx, "gmail-page"),
              body: `${subject(ctx, "gmail-page")} ${suffix}\n`,
              messageId: messageId(ctx, `message-page-${suffix}`),
            }),
            labelIds: ["INBOX"],
          }),
        ),
      after: async (ctx, record) => {
        ctx.messages[`page${suffix.toUpperCase()}`] = responseId(record);
        addCreated(ctx, "messages", ctx.messages[`page${suffix.toUpperCase()}`]);
        if (suffix === "b" && ctx.labels.batch && ctx.messages.pageA && ctx.messages.pageB) {
          for (const messageId of [ctx.messages.pageA, ctx.messages.pageB]) {
            await performRequest(
              ctx,
              "POST",
              request(
                `/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}/modify`,
                jsonBody({ addLabelIds: [ctx.labels.batch], removeLabelIds: ["SPAM"] }),
              ),
            );
          }
        }
      },
    }),
  ),
  step({
    name: "gmail.messages.send",
    method: "POST",
    path: "/gmail/v1/users/me/messages/send",
    skip: requireEmail,
    request: (ctx) => request("/gmail/v1/users/me/messages/send", jsonBody({ raw: raw(ctx, "message-send") })),
    after: (ctx, record) => {
      ctx.messages.sent = responseId(record);
      addCreated(ctx, "messages", ctx.messages.sent);
      return { sent_message_has_sent_label: messageLabelIds(record).includes("SENT") };
    },
  }),
  ...["full", "metadata", "raw", "minimal"].map((format) =>
    step({
      name: `gmail.messages.get.${format}`,
      method: "GET",
      path:
        format === "metadata"
          ? "/gmail/v1/users/me/messages/{messageId}?format=metadata&metadataHeaders=Subject"
          : `/gmail/v1/users/me/messages/{messageId}?format=${format}`,
      skip: (ctx) => requireValue(ctx.messages.main, "requires main message id"),
      request: (ctx) =>
        request(
          withQuery(`/gmail/v1/users/me/messages/${encodeURIComponent(ctx.messages.main)}`, [
            ["format", format],
            ...(format === "metadata" ? [["metadataHeaders", "Subject"]] : []),
          ]),
        ),
      after:
        format === "minimal"
          ? (ctx, record) => {
              const body = responseObject(record);
              if (typeof body?.historyId === "string") ctx.messages.mainHistory = body.historyId;
            }
          : undefined,
    }),
  ),
  step({
    name: "gmail.messages.list.page1",
    method: "GET",
    path: "/gmail/v1/users/me/messages?maxResults=1&labelIds={paginationLabel}",
    skip: (ctx) => requireValue(ctx.email && ctx.labels.batch, "requires email and pagination label"),
    request: (ctx) =>
      request(
        withQuery("/gmail/v1/users/me/messages", [
          ["maxResults", "1"],
          ["labelIds", ctx.labels.batch],
        ]),
      ),
    after: (ctx, record) => {
      const body = responseObject(record);
      ctx.messages.pageToken = typeof body?.nextPageToken === "string" ? body.nextPageToken : null;
      ctx.messages.page1First = listFirstId(record, "messages");
      const expectedMore = [ctx.messages.pageA, ctx.messages.pageB].filter(Boolean).length > 1;
      return {
        gmail_list_next_token_when_more_than_one: expectedMore ? Boolean(ctx.messages.pageToken) : "not-applicable",
      };
    },
  }),
  step({
    name: "gmail.messages.list.page2",
    method: "GET",
    path: "/gmail/v1/users/me/messages?maxResults=1&labelIds={paginationLabel}&pageToken={pageToken}",
    skip: (ctx) => requireValue(ctx.messages.pageToken, "requires Gmail list nextPageToken"),
    request: (ctx) =>
      request(
        withQuery("/gmail/v1/users/me/messages", [
          ["maxResults", "1"],
          ["labelIds", ctx.labels.batch],
          ["pageToken", ctx.messages.pageToken],
        ]),
      ),
    after: (ctx, record) => ({
      gmail_list_page_two_different_item: Boolean(
        ctx.messages.page1First &&
        listFirstId(record, "messages") &&
        ctx.messages.page1First !== listFirstId(record, "messages"),
      ),
    }),
  }),
  step({
    name: "gmail.messages.modify.addLabel",
    method: "POST",
    path: "/gmail/v1/users/me/messages/{messageId}/modify",
    skip: (ctx) => requireValue(ctx.messages.main && ctx.labels.message, "requires main message and message label"),
    request: (ctx) =>
      request(
        `/gmail/v1/users/me/messages/${encodeURIComponent(ctx.messages.main)}/modify`,
        jsonBody({ addLabelIds: [ctx.labels.message] }),
      ),
    after: (ctx, record) => ({ modify_add_response_has_label: messageLabelIds(record).includes(ctx.labels.message) }),
  }),
  step({
    name: "gmail.messages.get.afterModifyAdd",
    method: "GET",
    path: "/gmail/v1/users/me/messages/{messageId}?format=full",
    skip: (ctx) => requireValue(ctx.messages.main && ctx.labels.message, "requires main message and message label"),
    request: (ctx) =>
      request(withQuery(`/gmail/v1/users/me/messages/${encodeURIComponent(ctx.messages.main)}`, [["format", "full"]])),
    after: (ctx, record) => ({
      gmail_label_add_reflected_in_get: messageLabelIds(record).includes(ctx.labels.message),
    }),
  }),
  step({
    name: "gmail.history.list.afterLabelMutation",
    method: "GET",
    path: "/gmail/v1/users/me/history?startHistoryId={historyId}",
    skip: (ctx) => requireValue(ctx.messages.mainHistory, "requires main message history id"),
    request: (ctx) => request(withQuery("/gmail/v1/users/me/history", [["startHistoryId", ctx.messages.mainHistory]])),
    after: (_ctx, record) => ({
      history_includes_label_added_or_message_added:
        historyHas(responseObject(record), "labelsAdded") || historyHas(responseObject(record), "messagesAdded"),
    }),
  }),
  step({
    name: "gmail.history.list.labelAdded",
    method: "GET",
    path: "/gmail/v1/users/me/history?startHistoryId={historyId}&historyTypes=labelAdded",
    skip: (ctx) => requireValue(ctx.messages.mainHistory, "requires main message history id"),
    request: (ctx) =>
      request(
        withQuery("/gmail/v1/users/me/history", [
          ["startHistoryId", ctx.messages.mainHistory],
          ["historyTypes", "labelAdded"],
        ]),
      ),
    after: (_ctx, record) => ({
      history_type_filter_includes_label_added: historyHas(responseObject(record), "labelsAdded"),
    }),
  }),
  step({
    name: "gmail.messages.modify.removeLabel",
    method: "POST",
    path: "/gmail/v1/users/me/messages/{messageId}/modify",
    skip: (ctx) => requireValue(ctx.messages.main && ctx.labels.message, "requires main message and message label"),
    request: (ctx) =>
      request(
        `/gmail/v1/users/me/messages/${encodeURIComponent(ctx.messages.main)}/modify`,
        jsonBody({ removeLabelIds: [ctx.labels.message] }),
      ),
  }),
  step({
    name: "gmail.messages.get.afterModifyRemove",
    method: "GET",
    path: "/gmail/v1/users/me/messages/{messageId}?format=full",
    skip: (ctx) => requireValue(ctx.messages.main && ctx.labels.message, "requires main message and message label"),
    request: (ctx) =>
      request(withQuery(`/gmail/v1/users/me/messages/${encodeURIComponent(ctx.messages.main)}`, [["format", "full"]])),
    after: (ctx, record) => ({
      gmail_label_remove_reflected_in_get: !messageLabelIds(record).includes(ctx.labels.message),
    }),
  }),
  step({
    name: "gmail.messages.trash",
    method: "POST",
    path: "/gmail/v1/users/me/messages/{messageId}/trash",
    skip: (ctx) => requireValue(ctx.messages.main, "requires main message id"),
    request: (ctx) => request(`/gmail/v1/users/me/messages/${encodeURIComponent(ctx.messages.main)}/trash`),
    after: (_ctx, record) => ({ trash_adds_trash_label: messageLabelIds(record).includes("TRASH") }),
  }),
  step({
    name: "gmail.messages.untrash",
    method: "POST",
    path: "/gmail/v1/users/me/messages/{messageId}/untrash",
    skip: (ctx) => requireValue(ctx.messages.main, "requires main message id"),
    request: (ctx) => request(`/gmail/v1/users/me/messages/${encodeURIComponent(ctx.messages.main)}/untrash`),
    after: (_ctx, record) => ({ untrash_removes_trash_label: !messageLabelIds(record).includes("TRASH") }),
  }),
  step({
    name: "gmail.messages.batchModify",
    method: "POST",
    path: "/gmail/v1/users/me/messages/batchModify",
    skip: (ctx) =>
      requireValue(ctx.messages.pageA && ctx.messages.pageB && ctx.labels.batch, "requires batch messages and label"),
    request: (ctx) =>
      request(
        "/gmail/v1/users/me/messages/batchModify",
        jsonBody({ ids: [ctx.messages.pageA, ctx.messages.pageB], addLabelIds: [ctx.labels.batch] }),
      ),
  }),
  step({
    name: "gmail.messages.send.attachment",
    method: "POST",
    path: "/gmail/v1/users/me/messages/send",
    skip: requireEmail,
    request: (ctx) => {
      ctx.messages.attachmentBytes = Buffer.from(`attachment ${ctx.runId}`, "utf8");
      return request(
        "/gmail/v1/users/me/messages/send",
        jsonBody({
          raw: raw(ctx, "message-attachment", {
            attachments: [
              {
                filename: `${PREFIX}attachment.txt`,
                mimeType: TEXT_MIME,
                content: ctx.messages.attachmentBytes,
              },
            ],
          }),
        }),
      );
    },
    after: async (ctx, record) => {
      const body = responseObject(record);
      ctx.messages.attachment = body?.id;
      addCreated(ctx, "messages", ctx.messages.attachment);
      if (ctx.messages.attachment) {
        const full = await performRequest(
          ctx,
          "GET",
          request(
            withQuery(`/gmail/v1/users/me/messages/${encodeURIComponent(ctx.messages.attachment)}`, [
              ["format", "full"],
            ]),
          ),
        );
        ctx.messages.attachmentPart = findAttachmentId(getObject(full.response)?.payload);
      }
    },
  }),
  step({
    name: "gmail.messages.attachments.get",
    method: "GET",
    path: "/gmail/v1/users/me/messages/{messageId}/attachments/{attachmentId}",
    skip: (ctx) =>
      requireValue(
        ctx.messages.attachment && ctx.messages.attachmentPart,
        "requires sent attachment message and attachment id",
      ),
    request: (ctx) =>
      request(
        `/gmail/v1/users/me/messages/${encodeURIComponent(ctx.messages.attachment)}/attachments/${encodeURIComponent(
          ctx.messages.attachmentPart,
        )}`,
      ),
    after: (ctx, record) => {
      const body = responseObject(record);
      const data = typeof body?.data === "string" ? decodeBase64Url(body.data) : null;
      return { attachment_bytes_match: Boolean(data && Buffer.compare(data, ctx.messages.attachmentBytes) === 0) };
    },
  }),
  step({
    name: "gmail.messages.insert.deleteFixture",
    method: "POST",
    path: "/gmail/v1/users/me/messages",
    skip: requireEmail,
    request: (ctx) => request("/gmail/v1/users/me/messages", jsonBody({ raw: raw(ctx, "message-delete-fixture") })),
    after: (ctx, record) => {
      ctx.messages.deleteFixture = responseId(record);
      addCreated(ctx, "messages", ctx.messages.deleteFixture);
    },
  }),
  step({
    name: "gmail.messages.delete.scopeLimited",
    method: "DELETE",
    path: "/gmail/v1/users/me/messages/{messageId}",
    scopeLimited: true,
    skip: (ctx) => requireValue(ctx.messages.deleteFixture, "requires delete fixture message id"),
    request: (ctx) => request(`/gmail/v1/users/me/messages/${encodeURIComponent(ctx.messages.deleteFixture)}`),
  }),
  ...["a", "b"].map((suffix) =>
    step({
      name: `gmail.messages.insert.batchDeleteFixture.${suffix}`,
      method: "POST",
      path: "/gmail/v1/users/me/messages",
      skip: requireEmail,
      request: (ctx) =>
        request("/gmail/v1/users/me/messages", jsonBody({ raw: raw(ctx, `message-batch-delete-${suffix}`) })),
      after: (ctx, record) => {
        ctx.messages[`batchDelete${suffix.toUpperCase()}`] = responseId(record);
        addCreated(ctx, "messages", ctx.messages[`batchDelete${suffix.toUpperCase()}`]);
      },
    }),
  ),
  step({
    name: "gmail.messages.batchDelete.scopeLimited",
    method: "POST",
    path: "/gmail/v1/users/me/messages/batchDelete",
    scopeLimited: true,
    skip: (ctx) =>
      requireValue(ctx.messages.batchDeleteA && ctx.messages.batchDeleteB, "requires batch delete fixture ids"),
    request: (ctx) =>
      request(
        "/gmail/v1/users/me/messages/batchDelete",
        jsonBody({ ids: [ctx.messages.batchDeleteA, ctx.messages.batchDeleteB] }),
      ),
  }),
  step({
    name: "gmail.drafts.create",
    method: "POST",
    path: "/gmail/v1/users/me/drafts",
    skip: requireEmail,
    request: (ctx) => request("/gmail/v1/users/me/drafts", jsonBody({ message: { raw: raw(ctx, "draft-create") } })),
    after: (ctx, record) => {
      const body = responseObject(record);
      ctx.drafts.main = body?.id;
      addCreated(ctx, "drafts", ctx.drafts.main);
    },
  }),
  step({
    name: "gmail.drafts.list",
    method: "GET",
    path: "/gmail/v1/users/me/drafts",
    skip: requireEmail,
    request: () => request("/gmail/v1/users/me/drafts"),
  }),
  ...["full", "raw"].map((format) =>
    step({
      name: `gmail.drafts.get.${format}`,
      method: "GET",
      path: `/gmail/v1/users/me/drafts/{draftId}?format=${format}`,
      skip: (ctx) => requireValue(ctx.drafts.main, "requires draft id"),
      request: (ctx) =>
        request(withQuery(`/gmail/v1/users/me/drafts/${encodeURIComponent(ctx.drafts.main)}`, [["format", format]])),
    }),
  ),
  step({
    name: "gmail.drafts.update",
    method: "PUT",
    path: "/gmail/v1/users/me/drafts/{draftId}",
    skip: (ctx) => requireValue(ctx.drafts.main, "requires draft id"),
    request: (ctx) => {
      ctx.drafts.updatedSubject = subject(ctx, "draft-updated");
      return request(
        `/gmail/v1/users/me/drafts/${encodeURIComponent(ctx.drafts.main)}`,
        jsonBody({ message: { raw: raw(ctx, "draft-updated", { subject: ctx.drafts.updatedSubject }) } }),
      );
    },
  }),
  step({
    name: "gmail.drafts.get.afterUpdate",
    method: "GET",
    path: "/gmail/v1/users/me/drafts/{draftId}?format=full",
    skip: (ctx) => requireValue(ctx.drafts.main, "requires draft id"),
    request: (ctx) =>
      request(withQuery(`/gmail/v1/users/me/drafts/${encodeURIComponent(ctx.drafts.main)}`, [["format", "full"]])),
    after: (ctx, record) => {
      const body = responseObject(record);
      return { draft_update_replaces_subject: headerValue(body?.message, "Subject") === ctx.drafts.updatedSubject };
    },
  }),
  step({
    name: "gmail.drafts.send",
    method: "POST",
    path: "/gmail/v1/users/me/drafts/send",
    skip: (ctx) => requireValue(ctx.drafts.main, "requires draft id"),
    request: (ctx) => request("/gmail/v1/users/me/drafts/send", jsonBody({ id: ctx.drafts.main })),
    after: (ctx, record) => {
      ctx.messages.draftSent = responseId(record);
      addCreated(ctx, "messages", ctx.messages.draftSent);
      return { draft_send_message_has_sent_label: messageLabelIds(record).includes("SENT") };
    },
  }),
  step({
    name: "gmail.drafts.create.deleteFixture",
    method: "POST",
    path: "/gmail/v1/users/me/drafts",
    skip: requireEmail,
    request: (ctx) =>
      request("/gmail/v1/users/me/drafts", jsonBody({ message: { raw: raw(ctx, "draft-delete-fixture") } })),
    after: (ctx, record) => {
      ctx.drafts.deleteFixture = responseId(record);
      addCreated(ctx, "drafts", ctx.drafts.deleteFixture);
    },
  }),
  step({
    name: "gmail.drafts.delete",
    method: "DELETE",
    path: "/gmail/v1/users/me/drafts/{draftId}",
    skip: (ctx) => requireValue(ctx.drafts.deleteFixture, "requires draft delete fixture id"),
    request: (ctx) => request(`/gmail/v1/users/me/drafts/${encodeURIComponent(ctx.drafts.deleteFixture)}`),
  }),
  step({
    name: "gmail.messages.insert.threadRoot",
    method: "POST",
    path: "/gmail/v1/users/me/messages",
    skip: requireEmail,
    request: (ctx) =>
      request(
        "/gmail/v1/users/me/messages",
        jsonBody({
          raw: raw(ctx, "thread-root", { subject: subject(ctx, "thread") }),
          labelIds: ["INBOX"],
        }),
      ),
    after: (ctx, record) => {
      const body = responseObject(record);
      ctx.threads.rootMessage = body?.id;
      ctx.threads.id = body?.threadId;
      ctx.threads.rootMessageIdHeader = messageId(ctx, "thread-root");
      addCreated(ctx, "messages", ctx.threads.rootMessage);
    },
  }),
  step({
    name: "gmail.messages.insert.threadReply",
    method: "POST",
    path: "/gmail/v1/users/me/messages",
    skip: (ctx) => requireValue(ctx.threads.id, "requires thread id"),
    request: (ctx) =>
      request(
        "/gmail/v1/users/me/messages",
        jsonBody({
          raw: raw(ctx, "thread-reply", {
            subject: `Re: ${subject(ctx, "thread")}`,
            inReplyTo: ctx.threads.rootMessageIdHeader,
            references: ctx.threads.rootMessageIdHeader,
          }),
          threadId: ctx.threads.id,
          labelIds: ["INBOX"],
        }),
      ),
    after: (ctx, record) => {
      ctx.threads.replyMessage = responseId(record);
      addCreated(ctx, "messages", ctx.threads.replyMessage);
    },
  }),
  step({
    name: "gmail.threads.list",
    method: "GET",
    path: "/gmail/v1/users/me/threads?maxResults=10&labelIds=INBOX&q={probe}",
    skip: requireEmail,
    request: (ctx) =>
      request(
        withQuery("/gmail/v1/users/me/threads", [
          ["maxResults", "10"],
          ["labelIds", "INBOX"],
          ["q", subject(ctx, "thread")],
        ]),
      ),
  }),
  ...["full", "metadata"].map((format) =>
    step({
      name: `gmail.threads.get.${format}`,
      method: "GET",
      path:
        format === "metadata"
          ? "/gmail/v1/users/me/threads/{threadId}?format=metadata&metadataHeaders=Subject"
          : `/gmail/v1/users/me/threads/{threadId}?format=${format}`,
      skip: (ctx) => requireValue(ctx.threads.id, "requires thread id"),
      request: (ctx) =>
        request(
          withQuery(`/gmail/v1/users/me/threads/${encodeURIComponent(ctx.threads.id)}`, [
            ["format", format],
            ...(format === "metadata" ? [["metadataHeaders", "Subject"]] : []),
          ]),
        ),
    }),
  ),
  step({
    name: "gmail.threads.modify",
    method: "POST",
    path: "/gmail/v1/users/me/threads/{threadId}/modify",
    skip: (ctx) => requireValue(ctx.threads.id && ctx.labels.thread, "requires thread id and label"),
    request: (ctx) =>
      request(
        `/gmail/v1/users/me/threads/${encodeURIComponent(ctx.threads.id)}/modify`,
        jsonBody({ addLabelIds: [ctx.labels.thread] }),
      ),
    after: (ctx, record) => {
      const messages = Array.isArray(responseObject(record)?.messages) ? responseObject(record).messages : [];
      return {
        thread_modify_applies_label_to_all_messages:
          messages.length > 0 && messages.every((m) => m?.labelIds?.includes(ctx.labels.thread)),
      };
    },
  }),
  step({
    name: "gmail.threads.trash",
    method: "POST",
    path: "/gmail/v1/users/me/threads/{threadId}/trash",
    skip: (ctx) => requireValue(ctx.threads.id, "requires thread id"),
    request: (ctx) => request(`/gmail/v1/users/me/threads/${encodeURIComponent(ctx.threads.id)}/trash`),
  }),
  step({
    name: "gmail.threads.untrash",
    method: "POST",
    path: "/gmail/v1/users/me/threads/{threadId}/untrash",
    skip: (ctx) => requireValue(ctx.threads.id, "requires thread id"),
    request: (ctx) => request(`/gmail/v1/users/me/threads/${encodeURIComponent(ctx.threads.id)}/untrash`),
  }),
  step({
    name: "gmail.messages.insert.threadDeleteFixture",
    method: "POST",
    path: "/gmail/v1/users/me/messages",
    skip: requireEmail,
    request: (ctx) =>
      request("/gmail/v1/users/me/messages", jsonBody({ raw: raw(ctx, "thread-delete-fixture"), labelIds: ["INBOX"] })),
    after: (ctx, record) => {
      const body = responseObject(record);
      ctx.threads.deleteFixture = body?.threadId;
      ctx.messages.threadDeleteFixture = body?.id;
      addCreated(ctx, "messages", ctx.messages.threadDeleteFixture);
    },
  }),
  step({
    name: "gmail.threads.delete.scopeLimited",
    method: "DELETE",
    path: "/gmail/v1/users/me/threads/{threadId}",
    scopeLimited: true,
    skip: (ctx) => requireValue(ctx.threads.deleteFixture, "requires thread delete fixture id"),
    request: (ctx) => request(`/gmail/v1/users/me/threads/${encodeURIComponent(ctx.threads.deleteFixture)}`),
  }),
  step({
    name: "gmail.settings.filters.list",
    method: "GET",
    path: "/gmail/v1/users/me/settings/filters",
    skip: requireEmail,
    request: () => request("/gmail/v1/users/me/settings/filters"),
  }),
  step({
    name: "gmail.settings.filters.create",
    method: "POST",
    path: "/gmail/v1/users/me/settings/filters",
    skip: (ctx) => requireValue(ctx.email && ctx.labels.filter, "requires email and filter label"),
    request: (ctx) =>
      request(
        "/gmail/v1/users/me/settings/filters",
        jsonBody({ criteria: { from: ctx.email }, action: { addLabelIds: [ctx.labels.filter] } }),
      ),
    after: (ctx, record) => {
      ctx.labels.filterId = responseId(record);
    },
  }),
  step({
    name: "gmail.settings.filters.delete",
    method: "DELETE",
    path: "/gmail/v1/users/me/settings/filters/{filterId}",
    skip: (ctx) => requireValue(ctx.labels.filterId, "requires filter id"),
    request: (ctx) => request(`/gmail/v1/users/me/settings/filters/${encodeURIComponent(ctx.labels.filterId)}`),
  }),
  step({
    name: "gmail.settings.forwardingAddresses.list",
    method: "GET",
    path: "/gmail/v1/users/me/settings/forwardingAddresses",
    skip: requireEmail,
    request: () => request("/gmail/v1/users/me/settings/forwardingAddresses"),
  }),
  step({
    name: "gmail.settings.sendAs.list",
    method: "GET",
    path: "/gmail/v1/users/me/settings/sendAs",
    skip: requireEmail,
    request: () => request("/gmail/v1/users/me/settings/sendAs"),
  }),
  step({
    name: "gmail.watch.skipped",
    method: "POST",
    path: "/gmail/v1/users/me/watch",
    skipped: "requires pubsub topic",
  }),
  step({
    name: "gmail.stop",
    method: "POST",
    path: "/gmail/v1/users/me/stop",
    skip: requireEmail,
    request: () => request("/gmail/v1/users/me/stop"),
  }),
  step({
    name: "calendar.calendarList.list",
    method: "GET",
    path: "/calendar/v3/users/me/calendarList",
    skip: requireEmail,
    request: () => request("/calendar/v3/users/me/calendarList"),
  }),
  step({
    name: "calendar.events.insert",
    method: "POST",
    path: "/calendar/v3/calendars/primary/events",
    skip: requireEmail,
    request: (ctx) => {
      ctx.calendar.summary = subject(ctx, "calendar-event");
      return request(
        "/calendar/v3/calendars/primary/events",
        jsonBody({
          summary: ctx.calendar.summary,
          description: subject(ctx, "calendar-description"),
          start: { dateTime: ctx.calendar.start, timeZone: "UTC" },
          end: { dateTime: ctx.calendar.end, timeZone: "UTC" },
          attendees: [{ email: ctx.email, displayName: ctx.email }],
        }),
      );
    },
    after: (ctx, record) => {
      ctx.calendar.eventId = responseId(record);
      addCreated(ctx, "calendarEvents", ctx.calendar.eventId);
    },
  }),
  step({
    name: "calendar.events.list.filtered",
    method: "GET",
    path: "/calendar/v3/calendars/primary/events?timeMin={timeMin}&timeMax={timeMax}&q={probe}&orderBy=startTime&singleEvents=true",
    skip: (ctx) => requireValue(ctx.calendar.eventId, "requires calendar event id"),
    request: (ctx) =>
      request(
        withQuery("/calendar/v3/calendars/primary/events", [
          ["timeMin", ctx.calendar.windowStart],
          ["timeMax", ctx.calendar.windowEnd],
          ["q", ctx.calendar.summary],
          ["orderBy", "startTime"],
          ["singleEvents", "true"],
        ]),
      ),
    after: (ctx, record) => ({
      calendar_created_event_appears_in_filtered_list: eventListHasId(record, ctx.calendar.eventId),
    }),
  }),
  step({
    name: "calendar.freeBusy.query",
    method: "POST",
    path: "/calendar/v3/freeBusy",
    skip: (ctx) => requireValue(ctx.calendar.eventId, "requires calendar event id"),
    request: (ctx) =>
      request(
        "/calendar/v3/freeBusy",
        jsonBody({
          timeMin: ctx.calendar.windowStart,
          timeMax: ctx.calendar.windowEnd,
          items: [{ id: "primary" }],
        }),
      ),
  }),
  step({
    name: "calendar.events.delete",
    method: "DELETE",
    path: "/calendar/v3/calendars/primary/events/{eventId}",
    skip: (ctx) => requireValue(ctx.calendar.eventId, "requires calendar event id"),
    request: (ctx) => request(`/calendar/v3/calendars/primary/events/${encodeURIComponent(ctx.calendar.eventId)}`),
  }),
  step({
    name: "calendar.events.list.afterDelete",
    method: "GET",
    path: "/calendar/v3/calendars/primary/events?timeMin={timeMin}&timeMax={timeMax}&q={probe}&orderBy=startTime&singleEvents=true",
    skip: (ctx) => requireValue(ctx.calendar.eventId, "requires calendar event id"),
    request: (ctx) =>
      request(
        withQuery("/calendar/v3/calendars/primary/events", [
          ["timeMin", ctx.calendar.windowStart],
          ["timeMax", ctx.calendar.windowEnd],
          ["q", ctx.calendar.summary],
          ["orderBy", "startTime"],
          ["singleEvents", "true"],
        ]),
      ),
    after: (ctx, record) => ({
      calendar_deleted_event_no_longer_appears: !eventListHasId(record, ctx.calendar.eventId),
    }),
  }),
  step({
    name: "drive.files.create.folder",
    method: "POST",
    path: "/drive/v3/files",
    skip: requireEmail,
    request: (ctx) =>
      request(
        "/drive/v3/files",
        jsonBody({
          name: subject(ctx, "drive-folder"),
          mimeType: FOLDER_MIME,
        }),
      ),
    after: (ctx, record) => {
      ctx.drive.folder = responseId(record);
      addCreated(ctx, "driveFiles", ctx.drive.folder);
    },
  }),
  step({
    name: "drive.files.create.childMetadata",
    method: "POST",
    path: "/drive/v3/files",
    skip: (ctx) => requireValue(ctx.drive.folder, "requires Drive folder id"),
    request: (ctx) =>
      request(
        "/drive/v3/files",
        jsonBody({
          name: subject(ctx, "drive-child-metadata"),
          mimeType: TEXT_MIME,
          parents: [ctx.drive.folder],
        }),
      ),
    after: async (ctx, record) => {
      ctx.drive.child = responseId(record);
      addCreated(ctx, "driveFiles", ctx.drive.child);
      if (ctx.drive.folder) {
        const extra = await performRequest(
          ctx,
          "POST",
          request(
            "/drive/v3/files",
            jsonBody({
              name: subject(ctx, "drive-child-metadata-extra"),
              mimeType: TEXT_MIME,
              parents: [ctx.drive.folder],
            }),
          ),
        );
        ctx.drive.childExtra = responseId({ response: extra.response });
      }
    },
  }),
  step({
    name: "drive.files.create.media",
    method: "POST",
    path: "/upload/drive/v3/files?uploadType=media",
    skip: requireEmail,
    request: (ctx) => {
      ctx.drive.mediaBytes = Buffer.from(`drive media ${ctx.runId}`, "utf8");
      return request(
        withQuery("/upload/drive/v3/files", [["uploadType", "media"]]),
        byteBody(ctx.drive.mediaBytes, "application/octet-stream"),
      );
    },
    after: (ctx, record) => {
      ctx.drive.media = responseId(record);
      addCreated(ctx, "driveFiles", ctx.drive.media);
    },
  }),
  step({
    name: "drive.files.update.mediaName",
    method: "PATCH",
    path: "/drive/v3/files/{fileId}",
    skip: (ctx) => requireValue(ctx.drive.media, "requires Drive media file id"),
    request: (ctx) =>
      request(
        `/drive/v3/files/${encodeURIComponent(ctx.drive.media)}`,
        jsonBody({ name: subject(ctx, "drive-media") }),
      ),
  }),
  step({
    name: "drive.files.create.multipart",
    method: "POST",
    path: "/upload/drive/v3/files?uploadType=multipart",
    skip: (ctx) => requireValue(ctx.drive.folder, "requires Drive folder id"),
    request: (ctx) => {
      ctx.drive.multipartBytes = Buffer.from(`drive multipart ${ctx.runId}`, "utf8");
      return request(
        withQuery("/upload/drive/v3/files", [["uploadType", "multipart"]]),
        driveMultipartBody(
          {
            name: subject(ctx, "drive-multipart"),
            mimeType: TEXT_MIME,
            parents: [ctx.drive.folder],
          },
          ctx.drive.multipartBytes,
        ),
      );
    },
    after: (ctx, record) => {
      ctx.drive.multipart = responseId(record);
      addCreated(ctx, "driveFiles", ctx.drive.multipart);
    },
  }),
  step({
    name: "drive.files.list.page1",
    method: "GET",
    path: "/drive/v3/files?q='{folderId}' in parents and trashed = false&pageSize=1&orderBy=name",
    skip: (ctx) => requireValue(ctx.drive.folder, "requires Drive folder id"),
    request: (ctx) =>
      request(
        withQuery("/drive/v3/files", [
          ["q", `'${ctx.drive.folder}' in parents and trashed = false`],
          ["pageSize", "1"],
          ["orderBy", "name"],
        ]),
      ),
    after: (ctx, record) => {
      const body = responseObject(record);
      ctx.drive.pageToken = typeof body?.nextPageToken === "string" ? body.nextPageToken : null;
      ctx.drive.page1First = listFirstId(record, "files");
      const expectedMore = [ctx.drive.child, ctx.drive.childExtra, ctx.drive.multipart].filter(Boolean).length > 1;
      return {
        drive_list_next_token_when_more_than_one: expectedMore ? Boolean(ctx.drive.pageToken) : "not-applicable",
      };
    },
  }),
  step({
    name: "drive.files.list.page2",
    method: "GET",
    path: "/drive/v3/files?q='{folderId}' in parents and trashed = false&pageSize=1&orderBy=name&pageToken={pageToken}",
    skip: (ctx) => requireValue(ctx.drive.folder && ctx.drive.pageToken, "requires Drive folder id and nextPageToken"),
    request: (ctx) =>
      request(
        withQuery("/drive/v3/files", [
          ["q", `'${ctx.drive.folder}' in parents and trashed = false`],
          ["pageSize", "1"],
          ["orderBy", "name"],
          ["pageToken", ctx.drive.pageToken],
        ]),
      ),
    after: (ctx, record) => ({
      drive_list_page_two_different_item: Boolean(
        ctx.drive.page1First && listFirstId(record, "files") && ctx.drive.page1First !== listFirstId(record, "files"),
      ),
    }),
  }),
  step({
    name: "drive.files.get.metadata",
    method: "GET",
    path: "/drive/v3/files/{fileId}",
    skip: (ctx) => requireValue(ctx.drive.child, "requires Drive child file id"),
    request: (ctx) => request(`/drive/v3/files/${encodeURIComponent(ctx.drive.child)}`),
  }),
  step({
    name: "drive.files.get.media",
    method: "GET",
    path: "/drive/v3/files/{fileId}?alt=media",
    skip: (ctx) => requireValue(ctx.drive.media, "requires Drive media file id"),
    request: (ctx) =>
      request(withQuery(`/drive/v3/files/${encodeURIComponent(ctx.drive.media)}`, [["alt", "media"]]), null, {
        expectBinary: true,
      }),
    after: (ctx, record) => {
      const bytes = binaryResponseBytes(record);
      return { drive_media_roundtrip: Boolean(bytes && Buffer.compare(bytes, ctx.drive.mediaBytes) === 0) };
    },
  }),
  step({
    name: "drive.files.update.rename",
    method: "PATCH",
    path: "/drive/v3/files/{fileId}",
    skip: (ctx) => requireValue(ctx.drive.child, "requires Drive child file id"),
    request: (ctx) =>
      request(
        `/drive/v3/files/${encodeURIComponent(ctx.drive.child)}`,
        jsonBody({ name: subject(ctx, "drive-child-renamed") }),
      ),
  }),
  step({
    name: "drive.files.update.parents",
    method: "PATCH",
    path: "/drive/v3/files/{fileId}?addParents=root&removeParents={folderId}",
    skip: (ctx) => requireValue(ctx.drive.child && ctx.drive.folder, "requires Drive child and folder ids"),
    request: (ctx) =>
      request(
        withQuery(`/drive/v3/files/${encodeURIComponent(ctx.drive.child)}`, [
          ["addParents", "root"],
          ["removeParents", ctx.drive.folder],
        ]),
        jsonBody({}),
      ),
  }),
  step({
    name: "drive.files.update.media",
    method: "PATCH",
    path: "/upload/drive/v3/files/{fileId}?uploadType=media",
    skip: (ctx) => requireValue(ctx.drive.media, "requires Drive media file id"),
    request: (ctx) => {
      ctx.drive.mediaReplacementBytes = Buffer.from(`drive media replacement ${ctx.runId}`, "utf8");
      return request(
        withQuery(`/upload/drive/v3/files/${encodeURIComponent(ctx.drive.media)}`, [["uploadType", "media"]]),
        byteBody(ctx.drive.mediaReplacementBytes, "application/octet-stream"),
      );
    },
  }),
  step({
    name: "drive.files.get.media.afterReplace",
    method: "GET",
    path: "/drive/v3/files/{fileId}?alt=media",
    skip: (ctx) => requireValue(ctx.drive.media, "requires Drive media file id"),
    request: (ctx) =>
      request(withQuery(`/drive/v3/files/${encodeURIComponent(ctx.drive.media)}`, [["alt", "media"]]), null, {
        expectBinary: true,
      }),
    after: (ctx, record) => {
      const bytes = binaryResponseBytes(record);
      return {
        drive_media_replace_roundtrip: Boolean(bytes && Buffer.compare(bytes, ctx.drive.mediaReplacementBytes) === 0),
      };
    },
  }),
  ...[
    ["child", "drive.cleanup.trash.child"],
    ["media", "drive.cleanup.trash.media"],
    ["multipart", "drive.cleanup.trash.multipart"],
    ["folder", "drive.cleanup.trash.folder"],
  ].map(([key, name]) =>
    step({
      name,
      method: "PATCH",
      path: "/drive/v3/files/{fileId}",
      skip: (ctx) => requireValue(ctx.drive[key], `requires Drive ${key} id`),
      request: (ctx) => request(`/drive/v3/files/${encodeURIComponent(ctx.drive[key])}`, jsonBody({ trashed: true })),
    }),
  ),
  ...[
    ["child", "drive.files.delete.child"],
    ["media", "drive.files.delete.media"],
    ["multipart", "drive.files.delete.multipart"],
    ["folder", "drive.files.delete.folder"],
  ].map(([key, name]) =>
    step({
      name,
      method: "DELETE",
      path: "/drive/v3/files/{fileId}",
      skip: (ctx) => requireValue(ctx.drive[key], `requires Drive ${key} id`),
      request: (ctx) => request(`/drive/v3/files/${encodeURIComponent(ctx.drive[key])}`),
    }),
  ),
  ...[
    ["main", "gmail.cleanup.trash.main"],
    ["pageA", "gmail.cleanup.trash.pageA"],
    ["pageB", "gmail.cleanup.trash.pageB"],
    ["sent", "gmail.cleanup.trash.sent"],
    ["attachment", "gmail.cleanup.trash.attachment"],
    ["draftSent", "gmail.cleanup.trash.draftSent"],
    ["rootMessage", "gmail.cleanup.trash.threadRoot", "threads"],
    ["replyMessage", "gmail.cleanup.trash.threadReply", "threads"],
  ].map(([key, name, bucket = "messages"]) =>
    step({
      name,
      method: "POST",
      path: "/gmail/v1/users/me/messages/{messageId}/trash",
      skip: (ctx) => requireValue(ctx[bucket][key], `requires ${key} message id`),
      request: (ctx) => request(`/gmail/v1/users/me/messages/${encodeURIComponent(ctx[bucket][key])}/trash`),
    }),
  ),
  ...[
    ["deleteFixture", "gmail.cleanup.trash.deleteFixture.scopeLimited"],
    ["batchDeleteA", "gmail.cleanup.trash.batchDeleteA.scopeLimited"],
    ["batchDeleteB", "gmail.cleanup.trash.batchDeleteB.scopeLimited"],
    ["threadDeleteFixture", "gmail.cleanup.trash.threadDeleteFixture.scopeLimited"],
  ].map(([key, name]) =>
    step({
      name,
      method: "POST",
      path: "/gmail/v1/users/me/messages/{messageId}/trash",
      scopeLimited: true,
      skip: (ctx) => requireValue(ctx.messages[key], `requires ${key} message id`),
      request: (ctx) => request(`/gmail/v1/users/me/messages/${encodeURIComponent(ctx.messages[key])}/trash`),
    }),
  ),
  ...["message", "batch", "thread", "filter"].map((key) =>
    step({
      name: `gmail.cleanup.labels.delete.${key}`,
      method: "DELETE",
      path: "/gmail/v1/users/me/labels/{labelId}",
      skip: (ctx) => requireValue(ctx.labels[key], `requires ${key} label id`),
      request: (ctx) => request(`/gmail/v1/users/me/labels/${encodeURIComponent(ctx.labels[key])}`),
    }),
  ),
];

async function performRequest(ctx, method, req) {
  const url = `${ctx.base}${req.urlPath.startsWith("/") ? "" : "/"}${req.urlPath}`;
  const headers = {
    Authorization: `Bearer ${ctx.token}`,
    ...req.headers,
  };
  const response = await fetch(url, {
    method,
    headers,
    body: method === "GET" || method === "HEAD" ? undefined : req.body,
  });
  const bytes = Buffer.from(await response.arrayBuffer());
  return {
    status: response.status,
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
    tool: "google-api-parity",
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
