import type { Context, RouteContext } from "@emulators/core";
import { recordSideEffect } from "@emulators/core";
import type { MicrosoftFileAttachment, MicrosoftMessage, MicrosoftUser } from "../entities.js";
import {
  createMessageRecord,
  emailAddress,
  formatMessage,
  generateGraphId,
  graphError,
  parseEmailAddress,
  parseMessageInput,
  requireDelegatedUser,
  requireGraphScope,
} from "../helpers.js";
import { getMicrosoftStore, type MicrosoftStore } from "../store.js";

type AttachmentInput = Omit<MicrosoftFileAttachment, "id" | "created_at" | "updated_at" | "graph_id" | "message_id">;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function badRequest(c: Context, message: string): Response {
  return graphError(c, 400, "ErrorInvalidRequest", message);
}

async function jsonBody(c: Context, allowEmpty = false): Promise<Record<string, unknown> | Response> {
  const text = await c.req.text();
  if (!text && allowEmpty) return {};
  if (!c.req.header("Content-Type")?.toLowerCase().startsWith("application/json")) {
    return badRequest(c, "This emulator supports JSON mail requests only.");
  }
  try {
    const body: unknown = JSON.parse(text);
    return isRecord(body) ? body : badRequest(c, "A JSON object is required.");
  } catch {
    return badRequest(c, "Invalid JSON request body.");
  }
}

function validateMessage(c: Context, body: Record<string, unknown>): Response | undefined {
  if (body.subject !== undefined && typeof body.subject !== "string") return badRequest(c, "subject must be a string.");
  if (body.body !== undefined) {
    if (
      !isRecord(body.body) ||
      typeof body.body.content !== "string" ||
      (body.body.contentType !== undefined &&
        (typeof body.body.contentType !== "string" || !["text", "html"].includes(body.body.contentType.toLowerCase())))
    ) {
      return badRequest(c, "body must contain content and a text or html contentType.");
    }
  }
  for (const field of ["toRecipients", "ccRecipients", "bccRecipients", "replyTo"]) {
    if (
      body[field] !== undefined &&
      (!Array.isArray(body[field]) || !body[field].every((value) => parseEmailAddress(value)))
    ) {
      return badRequest(c, `${field} must be an array of email recipients.`);
    }
  }
  for (const field of ["from", "sender"]) {
    if (body[field] !== undefined && !parseEmailAddress(body[field]))
      return badRequest(c, `${field} must be an email recipient.`);
  }
  const supported = [
    "subject",
    "body",
    "toRecipients",
    "ccRecipients",
    "bccRecipients",
    "replyTo",
    "from",
    "sender",
    "attachments",
    "@odata.type",
  ];
  const unsupported = Object.keys(body).find((field) => !supported.includes(field));
  if (unsupported) return badRequest(c, `Draft property '${unsupported}' is not supported by this emulator.`);
}

function parseAttachment(c: Context, value: unknown): AttachmentInput | Response {
  if (!isRecord(value) || value["@odata.type"] !== "#microsoft.graph.fileAttachment") {
    return badRequest(c, "Only microsoft.graph.fileAttachment is supported.");
  }
  if (typeof value.contentBytes === "string" && value.contentBytes.length > 4 * 1024 * 1024) {
    return badRequest(c, "File attachments must be smaller than 3 MB; upload sessions are not supported.");
  }
  if (
    typeof value.name !== "string" ||
    typeof value.contentBytes !== "string" ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(value.contentBytes) ||
    Buffer.from(value.contentBytes, "base64").toString("base64") !== value.contentBytes
  ) {
    return badRequest(c, "File attachments require a name and valid base64 contentBytes.");
  }
  const size = Buffer.from(value.contentBytes, "base64").byteLength;
  if (size >= 3 * 1024 * 1024)
    return badRequest(c, "File attachments must be smaller than 3 MB; upload sessions are not supported.");
  if (
    (value.contentType !== undefined && typeof value.contentType !== "string") ||
    (value.isInline !== undefined && typeof value.isInline !== "boolean") ||
    (value.contentId !== undefined && value.contentId !== null && typeof value.contentId !== "string")
  ) {
    return badRequest(c, "Invalid file attachment metadata.");
  }
  return {
    name: value.name,
    content_type: typeof value.contentType === "string" ? value.contentType : "application/octet-stream",
    content_bytes: value.contentBytes,
    size,
    is_inline: value.isInline === true,
    content_id: typeof value.contentId === "string" ? value.contentId : null,
  };
}

function parseAttachments(c: Context, value: unknown): AttachmentInput[] | Response {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return badRequest(c, "attachments must be an array.");
  const attachments: AttachmentInput[] = [];
  for (const item of value) {
    const attachment = parseAttachment(c, item);
    if (attachment instanceof Response) return attachment;
    attachments.push(attachment);
  }
  return attachments;
}

function formatAttachment(attachment: MicrosoftFileAttachment): Record<string, unknown> {
  return {
    "@odata.type": "#microsoft.graph.fileAttachment",
    id: attachment.graph_id,
    lastModifiedDateTime: attachment.updated_at,
    name: attachment.name,
    contentType: attachment.content_type,
    size: attachment.size,
    isInline: attachment.is_inline,
    contentId: attachment.content_id,
    contentBytes: attachment.content_bytes,
  };
}

function saveAttachment(
  c: Context,
  ms: MicrosoftStore,
  messageId: string,
  input: AttachmentInput,
): MicrosoftFileAttachment {
  const attachment = ms.attachments.insert({ ...input, graph_id: generateGraphId("att"), message_id: messageId });
  recordSideEffect(c, {
    type: "create",
    collection: "microsoft.attachments",
    id: attachment.graph_id,
    summary: `Attached '${attachment.name}'`,
  });
  return attachment;
}

function mailbox(c: Context, ms: MicrosoftStore, scopes: string[]): MicrosoftUser | Response {
  return requireGraphScope(c, scopes) ?? requireDelegatedUser(c, ms);
}

function ownedMessage(c: Context, ms: MicrosoftStore, user: MicrosoftUser): MicrosoftMessage | Response {
  const message = ms.messages.findOneBy("graph_id", c.req.param("id"));
  return message?.user_email === user.email
    ? message
    : graphError(c, 404, "ErrorItemNotFound", "The specified object was not found in the store.");
}

function requireDraft(c: Context, message: MicrosoftMessage): Response | undefined {
  if (!message.is_draft) return graphError(c, 400, "ErrorInvalidOperation", "This operation requires a draft message.");
}

export function draftMailRoutes({ app, store, baseUrl }: RouteContext): void {
  const ms = getMicrosoftStore(store);
  const entity = (message: MicrosoftMessage) => ({
    "@odata.context": `${baseUrl}/v1.0/$metadata#me/messages/$entity`,
    ...formatMessage(baseUrl, message),
  });

  const createDraft = (c: Context, user: MicrosoftUser, body: Record<string, unknown>, conversationId?: string) => {
    const invalid = validateMessage(c, body);
    if (invalid) return invalid;
    const attachments = parseAttachments(c, body.attachments);
    if (attachments instanceof Response) return attachments;
    const message = createMessageRecord(ms, {
      ...parseMessageInput(body, user),
      parent_folder_id: "drafts",
      is_draft: true,
      conversation_id: conversationId,
      has_attachments: attachments.some((attachment) => !attachment.is_inline),
    });
    recordSideEffect(c, {
      type: "create",
      collection: "microsoft.messages",
      id: message.graph_id,
      summary: `Created draft '${message.subject}'`,
    });
    for (const attachment of attachments) saveAttachment(c, ms, message.graph_id, attachment);
    c.header("Location", `${baseUrl}/v1.0/me/messages/${message.graph_id}`);
    return c.json(entity(message), 201);
  };

  app.post("/v1.0/me/messages", async (c) => {
    c.set("operationId", "message_Create");
    const user = mailbox(c, ms, ["Mail.ReadWrite"]);
    if (user instanceof Response) return user;
    const body = await jsonBody(c);
    if (body instanceof Response) return body;
    return createDraft(c, user, body);
  });

  app.post("/v1.0/me/messages/:id/createReply", async (c) => {
    c.set("operationId", "message_CreateReply");
    const user = mailbox(c, ms, ["Mail.ReadWrite"]);
    if (user instanceof Response) return user;
    const original = ownedMessage(c, ms, user);
    if (original instanceof Response) return original;
    const body = await jsonBody(c, true);
    if (body instanceof Response) return body;
    if (
      (body.comment !== undefined && typeof body.comment !== "string") ||
      (body.message !== undefined && !isRecord(body.message))
    ) {
      return badRequest(c, "createReply accepts a comment string or a message object.");
    }
    const message = isRecord(body.message) ? body.message : {};
    if (body.comment !== undefined && message.body !== undefined)
      return badRequest(c, "Specify comment or message.body, not both.");
    if (Object.keys(body).some((key) => !["comment", "message"].includes(key)))
      return badRequest(c, "Unsupported createReply property.");
    return createDraft(
      c,
      user,
      {
        subject: /^re:/i.test(original.subject) ? original.subject : `RE: ${original.subject}`,
        toRecipients: original.reply_to.length
          ? original.reply_to
          : [emailAddress(original.from_address, original.from_name)],
        body: { contentType: "text", content: body.comment ?? "" },
        ...message,
      },
      original.conversation_id,
    );
  });

  app.patch("/v1.0/me/messages/:id", async (c) => {
    c.set("operationId", "message_Update");
    const user = mailbox(c, ms, ["Mail.ReadWrite"]);
    if (user instanceof Response) return user;
    const body = await jsonBody(c);
    if (body instanceof Response) return body;
    const message = ownedMessage(c, ms, user);
    if (message instanceof Response) return message;
    const notDraft = requireDraft(c, message);
    if (notDraft) return notDraft;
    if (body.attachments !== undefined) return badRequest(c, "Use the attachments endpoint to add attachments.");
    const invalid = validateMessage(c, body);
    if (invalid) return invalid;
    const {
      user_email: _userEmail,
      parent_folder_id: _folder,
      ...changes
    } = parseMessageInput({ ...formatMessage(baseUrl, message), ...body }, user);
    const updated = ms.messages.update(message.id, changes)!;
    recordSideEffect(c, {
      type: "update",
      collection: "microsoft.messages",
      id: message.graph_id,
      summary: `Updated draft '${updated.subject}'`,
    });
    return c.json(entity(updated));
  });

  app.post("/v1.0/me/messages/:id/send", (c) => {
    c.set("operationId", "message_Send");
    const user = mailbox(c, ms, ["Mail.Send"]);
    if (user instanceof Response) return user;
    const message = ownedMessage(c, ms, user);
    if (message instanceof Response) return message;
    const notDraft = requireDraft(c, message);
    if (notDraft) return notDraft;
    if (!message.to_recipients.length && !message.cc_recipients.length && !message.bcc_recipients.length) {
      return graphError(c, 400, "ErrorInvalidRecipients", "At least one recipient is required.");
    }
    ms.messages.update(message.id, {
      is_draft: false,
      parent_folder_id: "sentitems",
      sent_date_time: new Date().toISOString(),
    });
    recordSideEffect(c, {
      type: "update",
      collection: "microsoft.messages",
      id: message.graph_id,
      summary: `Sent draft '${message.subject}'`,
    });
    return c.body(null, 202);
  });

  app.post("/v1.0/me/messages/:id/attachments", async (c) => {
    c.set("operationId", "attachment_Create");
    const user = mailbox(c, ms, ["Mail.ReadWrite"]);
    if (user instanceof Response) return user;
    const body = await jsonBody(c);
    if (body instanceof Response) return body;
    const message = ownedMessage(c, ms, user);
    if (message instanceof Response) return message;
    const notDraft = requireDraft(c, message);
    if (notDraft) return notDraft;
    const input = parseAttachment(c, body);
    if (input instanceof Response) return input;
    const attachment = saveAttachment(c, ms, message.graph_id, input);
    ms.messages.update(message.id, { has_attachments: message.has_attachments || !attachment.is_inline });
    recordSideEffect(c, {
      type: "update",
      collection: "microsoft.messages",
      id: message.graph_id,
      summary: "Updated draft attachments",
    });
    return c.json(
      {
        "@odata.context": `${baseUrl}/v1.0/$metadata#me/messages('${message.graph_id}')/attachments/$entity`,
        ...formatAttachment(attachment),
      },
      201,
    );
  });

  app.get("/v1.0/me/messages/:id/attachments", (c) => {
    c.set("operationId", "attachment_List");
    const user = mailbox(c, ms, ["Mail.Read", "Mail.ReadWrite"]);
    if (user instanceof Response) return user;
    const message = ownedMessage(c, ms, user);
    if (message instanceof Response) return message;
    return c.json({
      "@odata.context": `${baseUrl}/v1.0/$metadata#me/messages('${message.graph_id}')/attachments`,
      value: ms.attachments.findBy("message_id", message.graph_id).map(formatAttachment),
    });
  });

  const getAttachment = (c: Context, raw: boolean) => {
    c.set("operationId", raw ? "attachment_GetContent" : "attachment_Get");
    const user = mailbox(c, ms, ["Mail.Read", "Mail.ReadWrite"]);
    if (user instanceof Response) return user;
    const message = ownedMessage(c, ms, user);
    if (message instanceof Response) return message;
    const attachment = ms.attachments.findOneBy("graph_id", c.req.param("attachmentId"));
    if (!attachment || attachment.message_id !== message.graph_id)
      return graphError(c, 404, "ErrorItemNotFound", "Attachment not found.");
    if (raw)
      return new Response(Buffer.from(attachment.content_bytes, "base64"), {
        headers: { "Content-Type": "application/octet-stream" },
      });
    return c.json({
      "@odata.context": `${baseUrl}/v1.0/$metadata#me/messages('${message.graph_id}')/attachments/$entity`,
      ...formatAttachment(attachment),
    });
  };
  app.get("/v1.0/me/messages/:id/attachments/:attachmentId", (c) => getAttachment(c, false));
  app.get("/v1.0/me/messages/:id/attachments/:attachmentId/$value", (c) => getAttachment(c, true));
}
