import { randomUUID } from "crypto";
import type { Context } from "@emulators/core";
import type {
  MicrosoftCalendar,
  MicrosoftDrive,
  MicrosoftDriveItem,
  MicrosoftEmailAddress,
  MicrosoftEvent,
  MicrosoftEventAttendee,
  MicrosoftMessage,
  MicrosoftUser,
} from "./entities.js";
import type { MicrosoftStore } from "./store.js";

/** Default tenant ID used when none is configured */
export const DEFAULT_TENANT_ID = "9188040d-6c67-4c5b-b112-36a304b66dad";

/**
 * Generate a Microsoft-style object ID (UUID v4 format).
 */
export function generateOid(): string {
  return randomUUID();
}

export function generateGraphId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "")}`;
}

export function graphError(c: Context, status: 400 | 401 | 403 | 404 | 409, code: string, message: string): Response {
  return c.json(
    {
      error: {
        code,
        message,
        innerError: {
          date: new Date().toISOString().slice(0, 19),
          "request-id": randomUUID(),
          "client-request-id": randomUUID(),
        },
      },
    },
    status,
  );
}

export function unauthorized(c: Context): Response {
  return graphError(c, 401, "InvalidAuthenticationToken", "Access token is empty or invalid.");
}

export function accessDenied(c: Context, message = "Access is denied. Check credentials and try again."): Response {
  return graphError(c, 403, "ErrorAccessDenied", message);
}

export function authScopes(c: Context): string[] {
  return c.get("authScopes") ?? [];
}

export function hasGraphScope(scopes: string[], accepted: string[]): boolean {
  return scopes.some((scope) => {
    if (scope === ".default" || scope === "https://graph.microsoft.com/.default") return true;
    if (accepted.includes(scope)) return true;
    if (scope.startsWith("https://graph.microsoft.com/")) {
      return accepted.includes(scope.replace("https://graph.microsoft.com/", ""));
    }
    return false;
  });
}

export function requireGraphScope(c: Context, accepted: string[]): Response | undefined {
  if (!c.get("authUser")) return unauthorized(c);
  if (!hasGraphScope(authScopes(c), accepted)) {
    return accessDenied(c, `Missing required Graph scope. Expected one of: ${accepted.join(", ")}.`);
  }
  return undefined;
}

export function requireDelegatedUser(c: Context, ms: MicrosoftStore): MicrosoftUser | Response {
  const authUser = c.get("authUser");
  if (!authUser) return unauthorized(c);
  if (authUser.id === 0) {
    return accessDenied(c, "/me requests require a delegated user token.");
  }

  const user = ms.users.findOneBy("email", authUser.login as MicrosoftUser["email"]);
  if (!user) {
    return graphError(c, 404, "Request_ResourceNotFound", "User not found.");
  }
  return user;
}

export function requireAnyGraphToken(c: Context): Response | undefined {
  const authUser = c.get("authUser");
  if (!authUser) return unauthorized(c);
  return undefined;
}

export function formatUser(baseUrl: string, user: MicrosoftUser): Record<string, unknown> {
  return {
    "@odata.context": `${baseUrl}/v1.0/$metadata#users/$entity`,
    businessPhones: [],
    displayName: user.name,
    givenName: user.given_name,
    jobTitle: null,
    mail: user.email,
    mobilePhone: null,
    officeLocation: null,
    preferredLanguage: null,
    surname: user.family_name,
    userPrincipalName: user.preferred_username,
    id: user.oid,
  };
}

export function emailAddress(address: string, name?: string | null): MicrosoftEmailAddress {
  return {
    emailAddress: {
      address,
      ...(name !== undefined ? { name } : {}),
    },
  };
}

export function parseEmailAddress(value: unknown): MicrosoftEmailAddress | null {
  if (!value || typeof value !== "object") return null;
  const outer = value as Record<string, unknown>;
  const email = outer.emailAddress;
  if (!email || typeof email !== "object") return null;
  const record = email as Record<string, unknown>;
  const address = typeof record.address === "string" ? record.address : "";
  if (!address) return null;
  return emailAddress(address, typeof record.name === "string" ? record.name : null);
}

export function parseEmailAddressList(value: unknown): MicrosoftEmailAddress[] {
  if (!Array.isArray(value)) return [];
  return value.map(parseEmailAddress).filter((entry): entry is MicrosoftEmailAddress => entry !== null);
}

function textPreview(value: string): string {
  return value
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 255);
}

function createdDateTime(entity: { created_at: string }): string {
  return entity.created_at;
}

function updatedDateTime(entity: { updated_at: string }): string {
  return entity.updated_at;
}

export function formatMessage(baseUrl: string, message: MicrosoftMessage): Record<string, unknown> {
  return {
    "@odata.etag": `W/"${message.graph_id}"`,
    id: message.graph_id,
    createdDateTime: createdDateTime(message),
    lastModifiedDateTime: updatedDateTime(message),
    changeKey: message.graph_id,
    categories: message.categories,
    receivedDateTime: message.received_date_time,
    sentDateTime: message.sent_date_time,
    hasAttachments: message.has_attachments,
    internetMessageId: message.internet_message_id,
    subject: message.subject,
    bodyPreview: message.body_preview,
    importance: message.importance,
    parentFolderId: message.parent_folder_id,
    conversationId: message.conversation_id,
    conversationIndex: null,
    isDeliveryReceiptRequested: null,
    isReadReceiptRequested: false,
    isRead: message.is_read,
    isDraft: message.is_draft,
    webLink: message.web_link ?? `${baseUrl}/mail/${message.graph_id}`,
    inferenceClassification: "focused",
    body: {
      contentType: message.body_content_type,
      content: message.body_content,
    },
    sender: emailAddress(message.sender_address, message.sender_name),
    from: emailAddress(message.from_address, message.from_name),
    toRecipients: message.to_recipients,
    ccRecipients: message.cc_recipients,
    bccRecipients: message.bcc_recipients,
    replyTo: message.reply_to,
    flag: {
      flagStatus: "notFlagged",
    },
  };
}

export function createMessageRecord(
  ms: MicrosoftStore,
  input: {
    graph_id?: string;
    user_email: string;
    parent_folder_id?: string;
    conversation_id?: string;
    subject?: string;
    body_content_type?: "text" | "html";
    body_content?: string;
    body_preview?: string;
    from_name?: string | null;
    from_address?: string;
    sender_name?: string | null;
    sender_address?: string;
    to_recipients?: MicrosoftEmailAddress[];
    cc_recipients?: MicrosoftEmailAddress[];
    bcc_recipients?: MicrosoftEmailAddress[];
    reply_to?: MicrosoftEmailAddress[];
    received_date_time?: string;
    sent_date_time?: string;
    internet_message_id?: string;
    is_read?: boolean;
    is_draft?: boolean;
    importance?: "low" | "normal" | "high";
    categories?: string[];
    web_link?: string | null;
    has_attachments?: boolean;
  },
): MicrosoftMessage {
  const now = new Date().toISOString();
  const fromAddress = input.from_address ?? input.user_email;
  const senderAddress = input.sender_address ?? fromAddress;
  const bodyContent = input.body_content ?? "";
  const graphId = input.graph_id ?? generateGraphId("msg");
  return ms.messages.insert({
    graph_id: graphId,
    user_email: input.user_email,
    parent_folder_id: input.parent_folder_id ?? "inbox",
    conversation_id: input.conversation_id ?? generateGraphId("conv"),
    subject: input.subject ?? "",
    body_preview: input.body_preview ?? textPreview(bodyContent),
    body_content_type: input.body_content_type ?? "text",
    body_content: bodyContent,
    from_name: input.from_name ?? null,
    from_address: fromAddress,
    sender_name: input.sender_name ?? input.from_name ?? null,
    sender_address: senderAddress,
    to_recipients: input.to_recipients ?? [],
    cc_recipients: input.cc_recipients ?? [],
    bcc_recipients: input.bcc_recipients ?? [],
    reply_to: input.reply_to ?? [],
    received_date_time: input.received_date_time ?? now,
    sent_date_time: input.sent_date_time ?? now,
    internet_message_id: input.internet_message_id ?? `<${graphId}@emulators.dev>`,
    is_read: input.is_read ?? false,
    is_draft: input.is_draft ?? false,
    importance: input.importance ?? "normal",
    categories: input.categories ?? [],
    web_link: input.web_link ?? null,
    has_attachments: input.has_attachments ?? false,
  });
}

export function listMessages(ms: MicrosoftStore, userEmail: string): MicrosoftMessage[] {
  return ms.messages
    .findBy("user_email", userEmail)
    .sort((a, b) => b.received_date_time.localeCompare(a.received_date_time));
}

export function parseMessageInput(
  body: unknown,
  fallbackFrom: MicrosoftUser,
): Parameters<typeof createMessageRecord>[1] {
  const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const message =
    record.message && typeof record.message === "object" ? (record.message as Record<string, unknown>) : record;
  const bodyValue = message.body && typeof message.body === "object" ? (message.body as Record<string, unknown>) : {};
  const from = parseEmailAddress(message.from) ?? emailAddress(fallbackFrom.email, fallbackFrom.name);
  const sender = parseEmailAddress(message.sender) ?? from;
  const contentType = bodyValue.contentType === "html" ? "html" : "text";
  const content = typeof bodyValue.content === "string" ? bodyValue.content : "";
  return {
    user_email: fallbackFrom.email,
    parent_folder_id: "sentitems",
    subject: typeof message.subject === "string" ? message.subject : "",
    body_content_type: contentType,
    body_content: content,
    body_preview: textPreview(content),
    from_name: from.emailAddress.name ?? fallbackFrom.name,
    from_address: from.emailAddress.address,
    sender_name: sender.emailAddress.name ?? from.emailAddress.name ?? fallbackFrom.name,
    sender_address: sender.emailAddress.address,
    to_recipients: parseEmailAddressList(message.toRecipients),
    cc_recipients: parseEmailAddressList(message.ccRecipients),
    bcc_recipients: parseEmailAddressList(message.bccRecipients),
    reply_to: parseEmailAddressList(message.replyTo),
    is_read: true,
  };
}

export function formatCalendar(baseUrl: string, calendar: MicrosoftCalendar): Record<string, unknown> {
  return {
    id: calendar.graph_id,
    name: calendar.name,
    color: calendar.color,
    hexColor: "",
    isDefaultCalendar: calendar.is_default,
    changeKey: calendar.change_key,
    canShare: calendar.can_share,
    canViewPrivateItems: calendar.can_view_private_items,
    canEdit: calendar.can_edit,
    allowedOnlineMeetingProviders: ["teamsForBusiness"],
    defaultOnlineMeetingProvider: "teamsForBusiness",
    isTallyingResponses: true,
    isRemovable: !calendar.is_default,
    owner: {
      name: calendar.name,
      address: calendar.user_email,
    },
    webLink: `${baseUrl}/calendar/${calendar.graph_id}`,
  };
}

export function defaultCalendar(ms: MicrosoftStore, userEmail: string): MicrosoftCalendar | undefined {
  return (
    ms.calendars.findBy("user_email", userEmail).find((calendar) => calendar.is_default) ??
    ms.calendars.findBy("user_email", userEmail)[0]
  );
}

export function createCalendarRecord(
  ms: MicrosoftStore,
  input: {
    graph_id?: string;
    user_email: string;
    name: string;
    color?: string;
    is_default?: boolean;
  },
): MicrosoftCalendar {
  return ms.calendars.insert({
    graph_id: input.graph_id ?? generateGraphId("cal"),
    user_email: input.user_email,
    name: input.name,
    color: input.color ?? "auto",
    change_key: generateGraphId("ck"),
    can_edit: true,
    can_share: true,
    can_view_private_items: true,
    is_default: input.is_default ?? false,
  });
}

export function formatEvent(baseUrl: string, event: MicrosoftEvent): Record<string, unknown> {
  return {
    "@odata.etag": `W/"${event.graph_id}"`,
    id: event.graph_id,
    createdDateTime: createdDateTime(event),
    lastModifiedDateTime: updatedDateTime(event),
    changeKey: event.graph_id,
    categories: [],
    transactionId: null,
    originalStartTimeZone: event.start_time_zone,
    originalEndTimeZone: event.end_time_zone,
    iCalUId: `${event.graph_id}@emulators.dev`,
    uid: `${event.graph_id}@emulators.dev`,
    reminderMinutesBeforeStart: 15,
    isReminderOn: true,
    hasAttachments: false,
    subject: event.subject,
    bodyPreview: event.body_preview,
    importance: "normal",
    sensitivity: "normal",
    isAllDay: false,
    isCancelled: event.is_cancelled,
    isOrganizer: true,
    responseRequested: true,
    seriesMasterId: null,
    showAs: event.show_as,
    type: "singleInstance",
    webLink: event.web_link ?? `${baseUrl}/calendar/events/${event.graph_id}`,
    onlineMeetingUrl: null,
    isOnlineMeeting: false,
    onlineMeetingProvider: "unknown",
    allowNewTimeProposals: true,
    occurrenceId: null,
    isDraft: false,
    hideAttendees: false,
    responseStatus: { response: "organizer", time: "0001-01-01T00:00:00Z" },
    body: {
      contentType: event.body_content_type,
      content: event.body_content,
    },
    start: {
      dateTime: event.start_date_time,
      timeZone: event.start_time_zone,
    },
    end: {
      dateTime: event.end_date_time,
      timeZone: event.end_time_zone,
    },
    location: {
      displayName: event.location ?? "",
      locationType: "default",
      uniqueId: event.location ?? "",
      uniqueIdType: "private",
    },
    locations: event.location
      ? [
          {
            displayName: event.location,
            locationType: "default",
            uniqueId: event.location,
            uniqueIdType: "private",
          },
        ]
      : [],
    attendees: event.attendees.map((attendee) => ({
      ...attendee,
      status: { response: "none", time: "0001-01-01T00:00:00Z" },
      type: attendee.type ?? "required",
    })),
    organizer: emailAddress(event.organizer_address, event.organizer_name),
    onlineMeeting: null,
  };
}

export function createEventRecord(
  ms: MicrosoftStore,
  input: {
    graph_id?: string;
    user_email: string;
    calendar_id: string;
    subject?: string;
    body_content_type?: "text" | "html";
    body_content?: string;
    start_date_time: string;
    start_time_zone?: string;
    end_date_time: string;
    end_time_zone?: string;
    location?: string | null;
    attendees?: MicrosoftEventAttendee[];
    organizer_name?: string | null;
    organizer_address?: string;
    show_as?: MicrosoftEvent["show_as"];
  },
): MicrosoftEvent {
  const bodyContent = input.body_content ?? "";
  return ms.events.insert({
    graph_id: input.graph_id ?? generateGraphId("evt"),
    user_email: input.user_email,
    calendar_id: input.calendar_id,
    subject: input.subject ?? "",
    body_preview: textPreview(bodyContent),
    body_content_type: input.body_content_type ?? "text",
    body_content: bodyContent,
    start_date_time: input.start_date_time,
    start_time_zone: input.start_time_zone ?? "UTC",
    end_date_time: input.end_date_time,
    end_time_zone: input.end_time_zone ?? "UTC",
    location: input.location ?? null,
    attendees: input.attendees ?? [],
    organizer_name: input.organizer_name ?? null,
    organizer_address: input.organizer_address ?? input.user_email,
    is_cancelled: false,
    show_as: input.show_as ?? "busy",
    web_link: null,
  });
}

export function parseEventInput(
  body: unknown,
  user: MicrosoftUser,
  calendar: MicrosoftCalendar,
): Parameters<typeof createEventRecord>[1] | Response {
  const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const bodyValue = record.body && typeof record.body === "object" ? (record.body as Record<string, unknown>) : {};
  const start = record.start && typeof record.start === "object" ? (record.start as Record<string, unknown>) : {};
  const end = record.end && typeof record.end === "object" ? (record.end as Record<string, unknown>) : {};
  const startDateTime = typeof start.dateTime === "string" ? start.dateTime : "";
  const endDateTime = typeof end.dateTime === "string" ? end.dateTime : "";
  if (!startDateTime || !endDateTime) {
    return new Response(
      JSON.stringify({
        error: {
          code: "Request_BadRequest",
          message: "Event start.dateTime and end.dateTime are required.",
        },
      }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }
  const location =
    record.location && typeof record.location === "object"
      ? (record.location as Record<string, unknown>).displayName
      : null;
  const contentType = bodyValue.contentType === "html" ? "html" : "text";
  return {
    user_email: user.email,
    calendar_id: calendar.graph_id,
    subject: typeof record.subject === "string" ? record.subject : "",
    body_content_type: contentType,
    body_content: typeof bodyValue.content === "string" ? bodyValue.content : "",
    start_date_time: startDateTime,
    start_time_zone: typeof start.timeZone === "string" ? start.timeZone : "UTC",
    end_date_time: endDateTime,
    end_time_zone: typeof end.timeZone === "string" ? end.timeZone : "UTC",
    location: typeof location === "string" ? location : null,
    attendees: Array.isArray(record.attendees)
      ? record.attendees.filter((attendee): attendee is MicrosoftEventAttendee => {
          return Boolean(parseEmailAddress(attendee));
        })
      : [],
    organizer_name: user.name,
    organizer_address: user.email,
  };
}

export function createDriveRecord(
  ms: MicrosoftStore,
  input: {
    graph_id?: string;
    user_email: string;
    name: string;
    owner_id: string;
    drive_type?: MicrosoftDrive["drive_type"];
  },
): MicrosoftDrive {
  return ms.drives.insert({
    graph_id: input.graph_id ?? generateGraphId("drv"),
    user_email: input.user_email,
    name: input.name,
    drive_type: input.drive_type ?? "personal",
    owner_id: input.owner_id,
  });
}

const MIME_BY_EXTENSION: Record<string, string> = {
  txt: "text/plain",
  md: "text/markdown",
  json: "application/json",
  csv: "text/csv",
  html: "text/html",
  htm: "text/html",
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  zip: "application/zip",
  bin: "application/octet-stream",
};

export function mimeTypeForName(name: string): string {
  const extension = name.includes(".") ? name.split(".").pop()?.toLowerCase() : "";
  return (extension && MIME_BY_EXTENSION[extension]) || "application/octet-stream";
}

export function encodeDriveContent(value: string | Uint8Array): string {
  return Buffer.from(value).toString("base64");
}

export function decodeDriveContent(item: MicrosoftDriveItem): Uint8Array {
  if (!item.content) return new Uint8Array();
  return Buffer.from(item.content, "base64");
}

function contentByteLength(contentBase64: string | null | undefined): number {
  if (!contentBase64) return 0;
  return Buffer.from(contentBase64, "base64").byteLength;
}

function oneDriveTag(id: string, version: number): string {
  return `"{${id}},${version}"`;
}

function oneDriveCTag(id: string, version: number): string {
  return `"c:{${id}},${version}"`;
}

export function bumpDriveItemTags(item: MicrosoftDriveItem): Pick<MicrosoftDriveItem, "etag_version" | "ctag_version"> {
  return {
    etag_version: item.etag_version + 1,
    ctag_version: item.ctag_version + 1,
  };
}

export function quickXorHash(bytes: Uint8Array): string {
  const widthInBits = 160;
  const shift = 11;
  const hash = Buffer.alloc(widthInBits / 8);

  for (let index = 0; index < bytes.length; index += 1) {
    const bitOffset = (index * shift) % widthInBits;
    const byteOffset = Math.floor(bitOffset / 8);
    const offsetInByte = bitOffset % 8;
    hash[byteOffset] ^= (bytes[index] << offsetInByte) & 0xff;
    hash[(byteOffset + 1) % hash.length] ^= bytes[index] >> (8 - offsetInByte);
  }

  const lengthBytes = Buffer.alloc(8);
  lengthBytes.writeBigUInt64LE(BigInt(bytes.length));
  for (let index = 0; index < lengthBytes.length; index += 1) {
    hash[hash.length - lengthBytes.length + index] ^= lengthBytes[index];
  }

  return hash.toString("base64");
}

export function createDriveItemRecord(
  ms: MicrosoftStore,
  input: {
    graph_id?: string;
    user_email: string;
    drive_id: string;
    name: string;
    parent_id?: string | null;
    folder_child_count?: number | null;
    file_mime_type?: string | null;
    size?: number;
    content_b64?: string | null;
    content?: string | null;
    web_url?: string | null;
  },
): MicrosoftDriveItem {
  const graphId = input.graph_id ?? generateGraphId("item");
  const contentBase64 =
    input.content_b64 !== undefined
      ? input.content_b64
      : input.content !== undefined && input.content !== null
        ? encodeDriveContent(input.content)
        : null;
  const fileMimeType = input.file_mime_type ?? (contentBase64 !== null ? mimeTypeForName(input.name) : null);
  return ms.driveItems.insert({
    graph_id: graphId,
    user_email: input.user_email,
    drive_id: input.drive_id,
    name: input.name,
    parent_id: input.parent_id ?? null,
    folder_child_count: input.folder_child_count ?? null,
    file_mime_type: fileMimeType,
    size: input.size ?? contentByteLength(contentBase64),
    web_url: input.web_url ?? null,
    download_url: null,
    etag_id: randomUUID(),
    etag_version: 1,
    ctag_id: randomUUID(),
    ctag_version: 1,
    content: contentBase64,
    deleted: false,
  });
}

export function formatDrive(baseUrl: string, drive: MicrosoftDrive, owner: MicrosoftUser): Record<string, unknown> {
  return {
    id: drive.graph_id,
    driveType: drive.drive_type,
    name: drive.name,
    owner: {
      user: {
        displayName: owner.name,
        id: owner.oid,
        email: owner.email,
      },
    },
    quota: {
      deleted: 0,
      remaining: 1024 * 1024 * 1024,
      state: "normal",
      total: 1024 * 1024 * 1024,
      used: 0,
    },
    webUrl: `${baseUrl}/drive/${drive.graph_id}`,
  };
}

function driveItemOwner(ms: MicrosoftStore | undefined, item: MicrosoftDriveItem): MicrosoftUser | undefined {
  return ms?.users.findOneBy("email", item.user_email);
}

function driveForItem(ms: MicrosoftStore | undefined, item: MicrosoftDriveItem): MicrosoftDrive | undefined {
  return ms?.drives.findOneBy("graph_id", item.drive_id);
}

function parentForItem(ms: MicrosoftStore | undefined, item: MicrosoftDriveItem): MicrosoftDriveItem | undefined {
  return item.parent_id ? ms?.driveItems.findOneBy("graph_id", item.parent_id) : undefined;
}

export function driveItemPath(ms: MicrosoftStore, item: MicrosoftDriveItem): string {
  if (item.parent_id === null) return "/drive/root:";
  const names: string[] = [];
  let current: MicrosoftDriveItem | undefined = item;
  while (current && current.parent_id !== null) {
    names.unshift(current.name);
    current = ms.driveItems.findOneBy("graph_id", current.parent_id);
  }
  return names.length > 0 ? `/drive/root:/${names.map(encodeURIComponent).join("/")}` : "/drive/root:";
}

function driveItemPrincipal(user: MicrosoftUser | undefined, item: MicrosoftDriveItem): Record<string, unknown> {
  return {
    application: {
      id: "emulate-microsoft",
      displayName: "Microsoft emulator",
    },
    user: {
      id: user?.oid ?? item.user_email,
      displayName: user?.name ?? item.user_email,
    },
  };
}

export function formatDriveItem(
  baseUrl: string,
  item: MicrosoftDriveItem,
  ms?: MicrosoftStore,
): Record<string, unknown> {
  const isFolder = item.folder_child_count !== null;
  const user = driveItemOwner(ms, item);
  const drive = driveForItem(ms, item);
  const parent = parentForItem(ms, item);
  const parentPath = ms && parent ? driveItemPath(ms, parent) : "/drive/root:";
  const principal = driveItemPrincipal(user, item);
  return {
    "@odata.etag": oneDriveTag(item.etag_id, item.etag_version),
    createdDateTime: item.created_at,
    eTag: oneDriveTag(item.etag_id, item.etag_version),
    id: item.graph_id,
    lastModifiedDateTime: item.updated_at,
    name: item.name,
    webUrl: item.web_url ?? `${baseUrl}/drive/items/${item.graph_id}`,
    cTag: oneDriveCTag(item.ctag_id, item.ctag_version),
    size: item.size,
    createdBy: principal,
    lastModifiedBy: principal,
    parentReference: {
      driveType: drive?.drive_type ?? "personal",
      driveId: item.drive_id,
      id: item.parent_id,
      name: parent?.name ?? (item.parent_id === null ? null : "root"),
      path: parentPath,
      siteId: item.drive_id,
    },
    fileSystemInfo: {
      createdDateTime: item.created_at,
      lastModifiedDateTime: item.updated_at,
    },
    ...(isFolder ? { folder: { childCount: item.folder_child_count ?? 0 } } : {}),
    ...(item.file_mime_type
      ? {
          file: {
            mimeType: item.file_mime_type,
            hashes: {
              quickXorHash: quickXorHash(decodeDriveContent(item)),
            },
          },
        }
      : {}),
    ...(item.file_mime_type ? { "@microsoft.graph.downloadUrl": `${baseUrl}/v1.0/_content/${item.graph_id}` } : {}),
  };
}

export function defaultDrive(ms: MicrosoftStore, userEmail: string): MicrosoftDrive | undefined {
  return ms.drives.findBy("user_email", userEmail)[0];
}

export function rootDriveItem(ms: MicrosoftStore, drive: MicrosoftDrive): MicrosoftDriveItem | undefined {
  return ms.driveItems.findBy("drive_id", drive.graph_id).find((item) => item.parent_id === null && !item.deleted);
}
