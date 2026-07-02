import type { Context, RouteContext } from "@emulators/core";
import { recordSideEffect } from "@emulators/core";
import {
  accessDenied,
  authScopes,
  bumpDriveItemTags,
  createEventRecord,
  createDriveItemRecord,
  createMessageRecord,
  defaultCalendar,
  defaultDrive,
  decodeDriveContent,
  encodeDriveContent,
  formatCalendar,
  formatDrive,
  formatDriveItem,
  formatEvent,
  formatMessage,
  formatUser,
  graphError,
  hasGraphScope,
  listMessages,
  mimeTypeForName,
  parseEventInput,
  parseMessageInput,
  requireAnyGraphToken,
  requireDelegatedUser,
  requireGraphScope,
  rootDriveItem,
  unauthorized,
} from "../helpers.js";
import type { MicrosoftCalendar, MicrosoftDrive, MicrosoftDriveItem, MicrosoftEvent } from "../entities.js";
import { getMicrosoftStore } from "../store.js";

type GraphCollection = {
  "@odata.context": string;
  "@odata.nextLink"?: string;
  value: Record<string, unknown>[];
};

function parseJsonBody(c: Context): Promise<unknown> {
  return c.req.json().catch(() => ({}));
}

function pageParams(c: Context): { top: number; skip: number } {
  const url = new URL(c.req.url);
  const top = Math.min(Math.max(Number.parseInt(url.searchParams.get("$top") ?? "50", 10) || 50, 1), 999);
  const skip = Math.max(Number.parseInt(url.searchParams.get("$skip") ?? "0", 10) || 0, 0);
  return { top, skip };
}

function odataCollection(
  baseUrl: string,
  metadataPath: string,
  requestPath: string,
  values: Record<string, unknown>[],
  c: Context,
): GraphCollection {
  const { top, skip } = pageParams(c);
  const page = values.slice(skip, skip + top);
  const body: GraphCollection = {
    "@odata.context": `${baseUrl}/v1.0/$metadata#${metadataPath}`,
    value: page,
  };
  if (skip + top < values.length) {
    const next = new URL(`${baseUrl}${requestPath}`);
    next.searchParams.set("$skip", String(skip + top));
    next.searchParams.set("$top", String(top));
    body["@odata.nextLink"] = next.toString();
  }
  return body;
}

function isResponse(value: unknown): value is Response {
  return value instanceof Response;
}

function graphUserScope(c: Context): Response | undefined {
  return requireGraphScope(c, ["User.Read", "User.Read.All", "User.ReadBasic.All"]);
}

function mailReadScope(c: Context): Response | undefined {
  return requireGraphScope(c, ["Mail.Read", "Mail.ReadWrite"]);
}

function calendarReadScope(c: Context): Response | undefined {
  return requireGraphScope(c, ["Calendars.Read", "Calendars.ReadWrite"]);
}

function filesReadScope(c: Context): Response | undefined {
  return requireGraphScope(c, ["Files.Read", "Files.Read.All", "Files.ReadWrite", "Files.ReadWrite.All"]);
}

function findEvent(events: MicrosoftEvent[], eventId: string): MicrosoftEvent | undefined {
  return events.find((event) => event.graph_id === eventId);
}

function getUserCalendar(ms: ReturnType<typeof getMicrosoftStore>, userEmail: string): MicrosoftCalendar | undefined {
  return defaultCalendar(ms, userEmail);
}

function getUserDrive(ms: ReturnType<typeof getMicrosoftStore>, userEmail: string): MicrosoftDrive | undefined {
  return defaultDrive(ms, userEmail);
}

function getDriveRoot(ms: ReturnType<typeof getMicrosoftStore>, drive: MicrosoftDrive): MicrosoftDriveItem | undefined {
  return rootDriveItem(ms, drive);
}

function getVisibleDriveItems(ms: ReturnType<typeof getMicrosoftStore>, drive: MicrosoftDrive): MicrosoftDriveItem[] {
  return ms.driveItems.findBy("drive_id", drive.graph_id).filter((item) => !item.deleted);
}

function itemNotFound(c: Context): Response {
  return graphError(c, 404, "itemNotFound", "The resource could not be found.");
}

/**
 * Real Outlook event ids are long base64url-ish opaque strings. When the id is
 * clearly not a valid Outlook id, Graph returns 400 ErrorInvalidIdMalformed
 * (Outlook style: no innerError) rather than a 404. We treat short ids that
 * lack the structure of a real Outlook id as malformed.
 */
function isMalformedEventId(eventId: string): boolean {
  return !/^[A-Za-z0-9_-]{40,}=*$/.test(eventId);
}

function malformedEventId(c: Context, eventId: string): Response | undefined {
  if (!isMalformedEventId(eventId)) return undefined;
  return c.json({ error: { code: "ErrorInvalidIdMalformed", message: "The Id is invalid." } }, 400);
}

/**
 * Real OneDrive item ids contain a "!" segment (e.g. "545D8DF03C777341!s...").
 * A GET for an id that lacks that structure returns 400 invalidRequest rather
 * than 404 itemNotFound. "root" is always a valid alias.
 */
function isMalformedDriveItemId(itemId: string): boolean {
  return itemId !== "root" && !itemId.includes("!");
}

function malformedDriveItemId(c: Context, itemId: string): Response | undefined {
  if (!isMalformedDriveItemId(itemId)) return undefined;
  return graphError(c, 400, "invalidRequest", "Invalid request");
}

function calendarAssociationLinks(baseUrl: string, userEmail: string, calendarId: string): Record<string, string> {
  const calendarRef = `${baseUrl}/v1.0/users('${userEmail}')/calendars('${calendarId}')`;
  return {
    "calendar@odata.associationLink": `${calendarRef}/$ref`,
    "calendar@odata.navigationLink": calendarRef,
  };
}

function getDriveById(
  ms: ReturnType<typeof getMicrosoftStore>,
  driveId: string,
  userEmail: string,
): MicrosoftDrive | undefined {
  const drive = ms.drives.findOneBy("graph_id", driveId);
  return drive && drive.user_email === userEmail ? drive : undefined;
}

function getDriveItemById(
  ms: ReturnType<typeof getMicrosoftStore>,
  drive: MicrosoftDrive,
  itemId: string,
): MicrosoftDriveItem | undefined {
  const item = itemId === "root" ? rootDriveItem(ms, drive) : ms.driveItems.findOneBy("graph_id", itemId);
  return item && item.drive_id === drive.graph_id && !item.deleted ? item : undefined;
}

function visibleChildByName(
  ms: ReturnType<typeof getMicrosoftStore>,
  drive: MicrosoftDrive,
  parentId: string,
  name: string,
): MicrosoftDriveItem | undefined {
  return ms.driveItems
    .findBy("parent_id", parentId)
    .find((item) => item.drive_id === drive.graph_id && !item.deleted && item.name === name);
}

function updateFolderChildCount(ms: ReturnType<typeof getMicrosoftStore>, parentId: string | null): void {
  if (!parentId) return;
  const parent = ms.driveItems.findOneBy("graph_id", parentId);
  if (!parent || parent.folder_child_count === null) return;
  const childCount = ms.driveItems.findBy("parent_id", parent.graph_id).filter((item) => !item.deleted).length;
  ms.driveItems.update(parent.id, { folder_child_count: childCount });
}

function downloadUrl(baseUrl: string, item: MicrosoftDriveItem): string {
  return `${baseUrl}/v1.0/_content/${encodeURIComponent(item.graph_id)}`;
}

function driveItemEntity(
  baseUrl: string,
  ms: ReturnType<typeof getMicrosoftStore>,
  item: MicrosoftDriveItem,
  metadataPath = "drive/items/$entity",
): Record<string, unknown> {
  return {
    "@odata.context": `${baseUrl}/v1.0/$metadata#${metadataPath}`,
    ...formatDriveItem(baseUrl, item, ms),
  };
}

function parseRootContentPath(pathname: string, prefix: string): string[] | null {
  if (!pathname.startsWith(prefix) || !pathname.endsWith(":/content")) return null;
  const encodedPath = pathname.slice(prefix.length, -":/content".length);
  const parts = encodedPath
    .split("/")
    .filter(Boolean)
    .map((part) => decodeURIComponent(part));
  return parts.length > 0 && parts.every((part) => part.length > 0) ? parts : null;
}

function uniqueChildName(
  ms: ReturnType<typeof getMicrosoftStore>,
  drive: MicrosoftDrive,
  parentId: string,
  wantedName: string,
): string {
  if (!visibleChildByName(ms, drive, parentId, wantedName)) return wantedName;
  const dot = wantedName.lastIndexOf(".");
  const stem = dot > 0 ? wantedName.slice(0, dot) : wantedName;
  const extension = dot > 0 ? wantedName.slice(dot) : "";
  for (let index = 1; index < 1000; index += 1) {
    const candidate = `${stem} ${index}${extension}`;
    if (!visibleChildByName(ms, drive, parentId, candidate)) return candidate;
  }
  return `${stem} ${Date.now()}${extension}`;
}

function createFolder(
  ms: ReturnType<typeof getMicrosoftStore>,
  drive: MicrosoftDrive,
  userEmail: string,
  parent: MicrosoftDriveItem,
  name: string,
): MicrosoftDriveItem {
  const folder = createDriveItemRecord(ms, {
    user_email: userEmail,
    drive_id: drive.graph_id,
    name,
    parent_id: parent.graph_id,
    folder_child_count: 0,
  });
  updateFolderChildCount(ms, parent.graph_id);
  return folder;
}

function ensurePathParent(
  c: Context,
  ms: ReturnType<typeof getMicrosoftStore>,
  drive: MicrosoftDrive,
  userEmail: string,
  root: MicrosoftDriveItem,
  pathParts: string[],
): MicrosoftDriveItem | Response {
  let parent = root;
  for (const folderName of pathParts.slice(0, -1)) {
    const existing = visibleChildByName(ms, drive, parent.graph_id, folderName);
    if (existing) {
      if (existing.folder_child_count === null) {
        return graphError(c, 409, "nameAlreadyExists", "A file already exists with the requested folder name.");
      }
      parent = existing;
      continue;
    }
    parent = createFolder(ms, drive, userEmail, parent, folderName);
  }
  return parent;
}

async function requestBytes(c: Context): Promise<Uint8Array> {
  return new Uint8Array(await c.req.arrayBuffer());
}

function updateExistingFileContent(
  ms: ReturnType<typeof getMicrosoftStore>,
  item: MicrosoftDriveItem,
  bytes: Uint8Array,
): MicrosoftDriveItem | undefined {
  return ms.driveItems.update(item.id, {
    file_mime_type: mimeTypeForName(item.name),
    size: bytes.byteLength,
    content: encodeDriveContent(bytes),
    ...bumpDriveItemTags(item),
  });
}

export function graphRoutes({ app, store, baseUrl }: RouteContext): void {
  const ms = getMicrosoftStore(store);

  app.get("/v1.0/me", (c) => {
    c.set("operationId", "graphUser_GetMyProfile");
    const userScope = graphUserScope(c);
    if (userScope) return userScope;
    const user = requireDelegatedUser(c, ms);
    if (isResponse(user)) return user;
    return c.json(formatUser(baseUrl, user));
  });

  app.get("/v1.0/users", (c) => {
    c.set("operationId", "graphUser_List");
    const authError = requireAnyGraphToken(c);
    if (authError) return authError;
    const userScope = graphUserScope(c);
    if (userScope) return userScope;
    const values = ms.users.all().map((user) => formatUser(baseUrl, user));
    return c.json(odataCollection(baseUrl, "users", "/v1.0/users", values, c));
  });

  app.get("/v1.0/users/:id", (c) => {
    c.set("operationId", "graphUser_GetById");
    const authError = requireAnyGraphToken(c);
    if (authError) return authError;
    const userScope = graphUserScope(c);
    if (userScope) return userScope;

    const userId = c.req.param("id");
    const user = ms.users.findOneBy("oid", userId) ?? ms.users.findOneBy("email", userId);
    if (!user) {
      return graphError(
        c,
        404,
        "Request_ResourceNotFound",
        `Resource '${userId}' does not exist or one of its queried reference-property objects are not present.`,
      );
    }

    return c.json(formatUser(baseUrl, user));
  });

  app.get("/v1.0/me/messages", (c) => {
    c.set("operationId", "message_List");
    const scopeError = mailReadScope(c);
    if (scopeError) return scopeError;
    const user = requireDelegatedUser(c, ms);
    if (isResponse(user)) return user;
    const values = listMessages(ms, user.email).map((message) => formatMessage(baseUrl, message));
    return c.json(odataCollection(baseUrl, "me/messages", "/v1.0/me/messages", values, c));
  });

  app.get("/v1.0/me/messages/:id", (c) => {
    c.set("operationId", "message_Get");
    const scopeError = mailReadScope(c);
    if (scopeError) return scopeError;
    const user = requireDelegatedUser(c, ms);
    if (isResponse(user)) return user;
    const message = ms.messages.findOneBy("graph_id", c.req.param("id"));
    if (!message || message.user_email !== user.email) {
      return graphError(c, 404, "ErrorItemNotFound", "The specified object was not found in the store.");
    }
    return c.json({
      "@odata.context": `${baseUrl}/v1.0/$metadata#me/messages/$entity`,
      ...formatMessage(baseUrl, message),
    });
  });

  app.post("/v1.0/me/sendMail", async (c) => {
    c.set("operationId", "message_SendMail");
    const scopeError = requireGraphScope(c, ["Mail.Send"]);
    if (scopeError) return scopeError;
    const user = requireDelegatedUser(c, ms);
    if (isResponse(user)) return user;
    const body = await parseJsonBody(c);
    const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const saveToSentItems = record.saveToSentItems !== false;
    if (saveToSentItems) {
      const message = createMessageRecord(ms, parseMessageInput(body, user));
      recordSideEffect(c, {
        type: "create",
        collection: "microsoft.messages",
        id: message.graph_id,
        summary: `Sent mail '${message.subject}'`,
      });
    }
    return c.body(null, 202);
  });

  app.get("/v1.0/me/calendar", (c) => {
    c.set("operationId", "calendar_GetDefaultCalendar");
    const scopeError = calendarReadScope(c);
    if (scopeError) return scopeError;
    const user = requireDelegatedUser(c, ms);
    if (isResponse(user)) return user;
    const calendar = getUserCalendar(ms, user.email);
    if (!calendar) return graphError(c, 404, "ErrorItemNotFound", "Calendar not found.");
    return c.json({
      "@odata.context": `${baseUrl}/v1.0/$metadata#me/calendar/$entity`,
      ...formatCalendar(baseUrl, calendar),
    });
  });

  app.get("/v1.0/me/calendars", (c) => {
    c.set("operationId", "calendar_List");
    const scopeError = calendarReadScope(c);
    if (scopeError) return scopeError;
    const user = requireDelegatedUser(c, ms);
    if (isResponse(user)) return user;
    const values = ms.calendars.findBy("user_email", user.email).map((calendar) => formatCalendar(baseUrl, calendar));
    return c.json(odataCollection(baseUrl, "me/calendars", "/v1.0/me/calendars", values, c));
  });

  const listEvents = (c: Context, calendarId?: string) => {
    c.set("operationId", calendarId ? "event_ListCalendarView" : "event_List");
    const scopeError = calendarReadScope(c);
    if (scopeError) return scopeError;
    const user = requireDelegatedUser(c, ms);
    if (isResponse(user)) return user;
    const events = ms.events
      .findBy("user_email", user.email)
      .filter((event) => !calendarId || event.calendar_id === calendarId)
      .sort((a, b) => a.start_date_time.localeCompare(b.start_date_time));
    const values = events.map((event) => ({
      ...formatEvent(baseUrl, event),
      ...calendarAssociationLinks(baseUrl, user.email, event.calendar_id),
    }));
    const path = calendarId ? "/v1.0/me/calendar/events" : "/v1.0/me/events";
    return c.json(odataCollection(baseUrl, "me/events", path, values, c));
  };

  app.get("/v1.0/me/events", (c) => listEvents(c));

  app.get("/v1.0/me/calendar/events", (c) => {
    const user = requireDelegatedUser(c, ms);
    if (isResponse(user)) return user;
    const calendar = getUserCalendar(ms, user.email);
    if (!calendar) return graphError(c, 404, "ErrorItemNotFound", "Calendar not found.");
    return listEvents(c, calendar.graph_id);
  });

  app.post("/v1.0/me/events", async (c) => {
    c.set("operationId", "event_Create");
    const scopeError = requireGraphScope(c, ["Calendars.ReadWrite"]);
    if (scopeError) return scopeError;
    const user = requireDelegatedUser(c, ms);
    if (isResponse(user)) return user;
    const calendar = getUserCalendar(ms, user.email);
    if (!calendar) return graphError(c, 404, "ErrorItemNotFound", "Calendar not found.");
    const body = await parseJsonBody(c);
    const input = parseEventInput(body, user, calendar);
    if (isResponse(input)) return input;
    const event = createEventRecord(ms, input);
    recordSideEffect(c, {
      type: "create",
      collection: "microsoft.events",
      id: event.graph_id,
      summary: `Created event '${event.subject}'`,
    });
    c.header(
      "Location",
      `${baseUrl}/v1.0/users('${user.email}')/events('${event.graph_id}')`,
    );
    return c.json(
      {
        "@odata.context": `${baseUrl}/v1.0/$metadata#users('${encodeURIComponent(user.email)}')/events/$entity`,
        ...formatEvent(baseUrl, event),
      },
      201,
    );
  });

  app.get("/v1.0/me/events/:id", (c) => {
    c.set("operationId", "event_Get");
    const scopeError = calendarReadScope(c);
    if (scopeError) return scopeError;
    const user = requireDelegatedUser(c, ms);
    if (isResponse(user)) return user;
    const eventId = c.req.param("id");
    const event = findEvent(ms.events.findBy("user_email", user.email), eventId);
    if (!event) {
      return malformedEventId(c, eventId) ?? graphError(c, 404, "ErrorItemNotFound", "The specified object was not found in the store.");
    }
    const calendarRef = ms.calendars.findOneBy("graph_id", event.calendar_id);
    return c.json({
      "@odata.context": `${baseUrl}/v1.0/$metadata#me/events/$entity`,
      ...formatEvent(baseUrl, event),
      ...calendarAssociationLinks(baseUrl, user.email, calendarRef?.graph_id ?? event.calendar_id),
    });
  });

  app.delete("/v1.0/me/events/:id", (c) => {
    c.set("operationId", "event_Delete");
    const scopeError = requireGraphScope(c, ["Calendars.ReadWrite"]);
    if (scopeError) return scopeError;
    const user = requireDelegatedUser(c, ms);
    if (isResponse(user)) return user;
    const event = findEvent(ms.events.findBy("user_email", user.email), c.req.param("id"));
    if (!event) return graphError(c, 404, "ErrorItemNotFound", "The specified object was not found in the store.");
    ms.events.delete(event.id);
    recordSideEffect(c, {
      type: "delete",
      collection: "microsoft.events",
      id: event.graph_id,
      summary: `Deleted event '${event.subject}'`,
    });
    return c.body(null, 204);
  });

  app.get("/v1.0/_content/:id", (c) => {
    c.set("operationId", "driveItem_DownloadContent");
    const item = ms.driveItems.findOneBy("graph_id", c.req.param("id"));
    if (!item || item.deleted || !item.file_mime_type) return itemNotFound(c);
    return new Response(decodeDriveContent(item), {
      status: 200,
      headers: {
        "Content-Type": item.file_mime_type,
        "Content-Length": String(item.size),
      },
    });
  });

  const requireDriveReadUser = (c: Context) => {
    const scopeError = filesReadScope(c);
    if (scopeError) return scopeError;
    return requireDelegatedUser(c, ms);
  };

  const requireDriveWriteUser = (c: Context) => {
    const scopeError = requireGraphScope(c, ["Files.ReadWrite", "Files.ReadWrite.All"]);
    if (scopeError) return scopeError;
    return requireDelegatedUser(c, ms);
  };

  const getDefaultDrive = (c: Context, userEmail: string): MicrosoftDrive | Response => {
    const drive = getUserDrive(ms, userEmail);
    return drive ?? graphError(c, 404, "itemNotFound", "Drive not found.");
  };

  const getRequestedDrive = (c: Context, driveId: string, userEmail: string): MicrosoftDrive | Response => {
    const drive = getDriveById(ms, driveId, userEmail);
    return drive ?? graphError(c, 404, "itemNotFound", "Drive not found.");
  };

  const getRequestedRoot = (c: Context, drive: MicrosoftDrive): MicrosoftDriveItem | Response => {
    const root = getDriveRoot(ms, drive);
    return root ?? graphError(c, 404, "itemNotFound", "Root item not found.");
  };

  const listDriveChildren = (
    c: Context,
    drive: MicrosoftDrive,
    parent: MicrosoftDriveItem,
    metadataPath: string,
    requestPath: string,
  ) => {
    if (parent.folder_child_count === null) return itemNotFound(c);
    const values = getVisibleDriveItems(ms, drive)
      .filter((item) => item.parent_id === parent.graph_id)
      .map((item) => formatDriveItem(baseUrl, item, ms));
    return c.json(odataCollection(baseUrl, metadataPath, requestPath, values, c));
  };

  const createChildFolder = async (
    c: Context,
    drive: MicrosoftDrive,
    parent: MicrosoftDriveItem,
    userEmail: string,
    metadataPath: string,
  ) => {
    if (parent.folder_child_count === null) return itemNotFound(c);
    const body = await parseJsonBody(c);
    const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const folder = record.folder && typeof record.folder === "object" ? record.folder : null;
    const requestedName = typeof record.name === "string" ? record.name.trim() : "";
    if (!requestedName || !folder) {
      return graphError(c, 400, "invalidRequest", "Folder creation requires name and folder fields.");
    }

    const conflictBehavior =
      typeof record["@microsoft.graph.conflictBehavior"] === "string"
        ? record["@microsoft.graph.conflictBehavior"]
        : "fail";
    const existing = visibleChildByName(ms, drive, parent.graph_id, requestedName);
    if (existing) {
      if (conflictBehavior === "rename") {
        const renamed = createFolder(
          ms,
          drive,
          userEmail,
          parent,
          uniqueChildName(ms, drive, parent.graph_id, requestedName),
        );
        recordSideEffect(c, {
          type: "create",
          collection: "microsoft.drive_items",
          id: renamed.graph_id,
          summary: `Created drive folder '${renamed.name}'`,
        });
        return c.json(driveItemEntity(baseUrl, ms, renamed, metadataPath), 201);
      }
      if (conflictBehavior === "replace" && existing.folder_child_count !== null) {
        return c.json(driveItemEntity(baseUrl, ms, existing, metadataPath), 200);
      }
      return graphError(c, 409, "nameAlreadyExists", "An item with the same name already exists.");
    }

    const created = createFolder(ms, drive, userEmail, parent, requestedName);
    recordSideEffect(c, {
      type: "create",
      collection: "microsoft.drive_items",
      id: created.graph_id,
      summary: `Created drive folder '${created.name}'`,
    });
    return c.json(driveItemEntity(baseUrl, ms, created, metadataPath), 201);
  };

  const getDriveItem = (c: Context, drive: MicrosoftDrive, itemId: string): Response => {
    const item = getDriveItemById(ms, drive, itemId);
    if (!item) return malformedDriveItemId(c, itemId) ?? itemNotFound(c);
    return c.json(driveItemEntity(baseUrl, ms, item));
  };

  const patchDriveItem = async (c: Context, drive: MicrosoftDrive, itemId: string): Promise<Response> => {
    const item = getDriveItemById(ms, drive, itemId);
    if (!item) return itemNotFound(c);
    const body = await parseJsonBody(c);
    const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const name = typeof record.name === "string" && record.name.length > 0 ? record.name : item.name;
    const updated = ms.driveItems.update(item.id, {
      name,
      file_mime_type: item.file_mime_type ? mimeTypeForName(name) : item.file_mime_type,
    });
    if (!updated) return itemNotFound(c);
    recordSideEffect(c, {
      type: "update",
      collection: "microsoft.drive_items",
      id: updated.graph_id,
      summary: `Updated drive item '${updated.name}'`,
    });
    return c.json(driveItemEntity(baseUrl, ms, updated));
  };

  const deleteDriveItem = (c: Context, drive: MicrosoftDrive, itemId: string): Response => {
    const item = getDriveItemById(ms, drive, itemId);
    if (!item) return itemNotFound(c);
    ms.driveItems.update(item.id, { deleted: true });
    updateFolderChildCount(ms, item.parent_id);
    recordSideEffect(c, {
      type: "delete",
      collection: "microsoft.drive_items",
      id: item.graph_id,
      summary: `Deleted drive item '${item.name}'`,
    });
    return c.body(null, 204);
  };

  const redirectDriveContent = (c: Context, drive: MicrosoftDrive, itemId: string): Response => {
    const item = getDriveItemById(ms, drive, itemId);
    if (!item || !item.file_mime_type) return itemNotFound(c);
    return new Response(null, { status: 302, headers: { Location: downloadUrl(baseUrl, item) } });
  };

  const putDriveItemContent = async (c: Context, drive: MicrosoftDrive, itemId: string): Promise<Response> => {
    const item = getDriveItemById(ms, drive, itemId);
    if (!item || item.folder_child_count !== null) return itemNotFound(c);
    const updated = updateExistingFileContent(ms, item, await requestBytes(c));
    if (!updated) return itemNotFound(c);
    recordSideEffect(c, {
      type: "update",
      collection: "microsoft.drive_items",
      id: updated.graph_id,
      summary: `Updated drive item '${updated.name}' content`,
    });
    return c.json(driveItemEntity(baseUrl, ms, updated), 200);
  };

  const putPathContent = async (
    c: Context,
    drive: MicrosoftDrive,
    root: MicrosoftDriveItem,
    userEmail: string,
    pathParts: string[],
  ): Promise<Response> => {
    const parent = ensurePathParent(c, ms, drive, userEmail, root, pathParts);
    if (isResponse(parent)) return parent;
    const name = pathParts[pathParts.length - 1];
    const bytes = await requestBytes(c);
    const existing = visibleChildByName(ms, drive, parent.graph_id, name);
    if (existing) {
      if (existing.folder_child_count !== null) {
        return graphError(c, 409, "nameAlreadyExists", "A folder already exists with the requested file name.");
      }
      const updated = updateExistingFileContent(ms, existing, bytes);
      if (!updated) return itemNotFound(c);
      recordSideEffect(c, {
        type: "update",
        collection: "microsoft.drive_items",
        id: updated.graph_id,
        summary: `Updated drive item '${updated.name}' content`,
      });
      return c.json(driveItemEntity(baseUrl, ms, updated), 200);
    }

    const created = createDriveItemRecord(ms, {
      user_email: userEmail,
      drive_id: drive.graph_id,
      name,
      parent_id: parent.graph_id,
      file_mime_type: mimeTypeForName(name),
      content_b64: encodeDriveContent(bytes),
    });
    updateFolderChildCount(ms, parent.graph_id);
    recordSideEffect(c, {
      type: "create",
      collection: "microsoft.drive_items",
      id: created.graph_id,
      summary: `Created drive item '${created.name}' content`,
    });
    return c.json(driveItemEntity(baseUrl, ms, created), 201);
  };

  app.get("/v1.0/me/drive", (c) => {
    c.set("operationId", "drive_GetMyDrive");
    const user = requireDriveReadUser(c);
    if (isResponse(user)) return user;
    const drive = getDefaultDrive(c, user.email);
    if (isResponse(drive)) return drive;
    return c.json({
      "@odata.context": `${baseUrl}/v1.0/$metadata#drives/$entity`,
      ...formatDrive(baseUrl, drive, user),
    });
  });

  app.get("/v1.0/drives/:driveId", (c) => {
    c.set("operationId", "drive_Get");
    const user = requireDriveReadUser(c);
    if (isResponse(user)) return user;
    const drive = getRequestedDrive(c, c.req.param("driveId"), user.email);
    if (isResponse(drive)) return drive;
    return c.json({
      "@odata.context": `${baseUrl}/v1.0/$metadata#drives/$entity`,
      ...formatDrive(baseUrl, drive, user),
    });
  });

  app.get("/v1.0/me/drive/root", (c) => {
    c.set("operationId", "driveItem_GetRoot");
    const user = requireDriveReadUser(c);
    if (isResponse(user)) return user;
    const drive = getDefaultDrive(c, user.email);
    if (isResponse(drive)) return drive;
    const root = getRequestedRoot(c, drive);
    if (isResponse(root)) return root;
    return c.json(driveItemEntity(baseUrl, ms, root, "drive/root/$entity"));
  });

  app.get("/v1.0/drives/:driveId/root", (c) => {
    c.set("operationId", "driveItem_GetDriveRoot");
    const user = requireDriveReadUser(c);
    if (isResponse(user)) return user;
    const drive = getRequestedDrive(c, c.req.param("driveId"), user.email);
    if (isResponse(drive)) return drive;
    const root = getRequestedRoot(c, drive);
    if (isResponse(root)) return root;
    return c.json(driveItemEntity(baseUrl, ms, root, "drives/root/$entity"));
  });

  app.get("/v1.0/me/drive/root/children", (c) => {
    c.set("operationId", "driveItem_ListRootChildren");
    const user = requireDriveReadUser(c);
    if (isResponse(user)) return user;
    const drive = getDefaultDrive(c, user.email);
    if (isResponse(drive)) return drive;
    const root = getRequestedRoot(c, drive);
    if (isResponse(root)) return root;
    return listDriveChildren(c, drive, root, "drive/root/children", "/v1.0/me/drive/root/children");
  });

  app.post("/v1.0/me/drive/root/children", async (c) => {
    c.set("operationId", "driveItem_CreateRootChild");
    const user = requireDriveWriteUser(c);
    if (isResponse(user)) return user;
    const drive = getDefaultDrive(c, user.email);
    if (isResponse(drive)) return drive;
    const root = getRequestedRoot(c, drive);
    if (isResponse(root)) return root;
    return createChildFolder(c, drive, root, user.email, "drive/root/children/$entity");
  });

  app.get("/v1.0/drives/:driveId/root/children", (c) => {
    c.set("operationId", "driveItem_ListDriveRootChildren");
    const user = requireDriveReadUser(c);
    if (isResponse(user)) return user;
    const drive = getRequestedDrive(c, c.req.param("driveId"), user.email);
    if (isResponse(drive)) return drive;
    const root = getRequestedRoot(c, drive);
    if (isResponse(root)) return root;
    return listDriveChildren(c, drive, root, "drive/root/children", `/v1.0/drives/${drive.graph_id}/root/children`);
  });

  app.post("/v1.0/drives/:driveId/root/children", async (c) => {
    c.set("operationId", "driveItem_CreateDriveRootChild");
    const user = requireDriveWriteUser(c);
    if (isResponse(user)) return user;
    const drive = getRequestedDrive(c, c.req.param("driveId"), user.email);
    if (isResponse(drive)) return drive;
    const root = getRequestedRoot(c, drive);
    if (isResponse(root)) return root;
    return createChildFolder(c, drive, root, user.email, "drive/root/children/$entity");
  });

  app.get("/v1.0/me/drive/items/:id/content", (c) => {
    c.set("operationId", "driveItem_GetContent");
    const user = requireDriveReadUser(c);
    if (isResponse(user)) return user;
    const drive = getDefaultDrive(c, user.email);
    if (isResponse(drive)) return drive;
    return redirectDriveContent(c, drive, c.req.param("id"));
  });

  app.put("/v1.0/me/drive/items/:id/content", async (c) => {
    c.set("operationId", "driveItem_PutContent");
    const user = requireDriveWriteUser(c);
    if (isResponse(user)) return user;
    const drive = getDefaultDrive(c, user.email);
    if (isResponse(drive)) return drive;
    return putDriveItemContent(c, drive, c.req.param("id"));
  });

  app.get("/v1.0/drives/:driveId/items/:itemId/content", (c) => {
    c.set("operationId", "driveItem_GetDriveContent");
    const user = requireDriveReadUser(c);
    if (isResponse(user)) return user;
    const drive = getRequestedDrive(c, c.req.param("driveId"), user.email);
    if (isResponse(drive)) return drive;
    return redirectDriveContent(c, drive, c.req.param("itemId"));
  });

  app.put("/v1.0/drives/:driveId/items/:itemId/content", async (c) => {
    c.set("operationId", "driveItem_PutDriveContent");
    const user = requireDriveWriteUser(c);
    if (isResponse(user)) return user;
    const drive = getRequestedDrive(c, c.req.param("driveId"), user.email);
    if (isResponse(drive)) return drive;
    return putDriveItemContent(c, drive, c.req.param("itemId"));
  });

  app.get("/v1.0/me/drive/items/:id", (c) => {
    c.set("operationId", "driveItem_Get");
    const user = requireDriveReadUser(c);
    if (isResponse(user)) return user;
    const drive = getDefaultDrive(c, user.email);
    if (isResponse(drive)) return drive;
    return getDriveItem(c, drive, c.req.param("id"));
  });

  app.get("/v1.0/drives/:driveId/items/:itemId", (c) => {
    c.set("operationId", "driveItem_GetDriveItem");
    const user = requireDriveReadUser(c);
    if (isResponse(user)) return user;
    const drive = getRequestedDrive(c, c.req.param("driveId"), user.email);
    if (isResponse(drive)) return drive;
    return getDriveItem(c, drive, c.req.param("itemId"));
  });

  app.get("/v1.0/me/drive/items/:id/children", (c) => {
    c.set("operationId", "driveItem_ListChildren");
    const user = requireDriveReadUser(c);
    if (isResponse(user)) return user;
    const drive = getDefaultDrive(c, user.email);
    if (isResponse(drive)) return drive;
    const parent = getDriveItemById(ms, drive, c.req.param("id"));
    if (!parent) return itemNotFound(c);
    return listDriveChildren(
      c,
      drive,
      parent,
      "drive/items/children",
      `/v1.0/me/drive/items/${parent.graph_id}/children`,
    );
  });

  app.get("/v1.0/drives/:driveId/items/:itemId/children", (c) => {
    c.set("operationId", "driveItem_ListDriveChildren");
    const user = requireDriveReadUser(c);
    if (isResponse(user)) return user;
    const drive = getRequestedDrive(c, c.req.param("driveId"), user.email);
    if (isResponse(drive)) return drive;
    const parent = getDriveItemById(ms, drive, c.req.param("itemId"));
    if (!parent) return itemNotFound(c);
    return listDriveChildren(
      c,
      drive,
      parent,
      "drive/items/children",
      `/v1.0/drives/${drive.graph_id}/items/${parent.graph_id}/children`,
    );
  });

  app.patch("/v1.0/me/drive/items/:id", async (c) => {
    c.set("operationId", "driveItem_Update");
    const user = requireDriveWriteUser(c);
    if (isResponse(user)) return user;
    const drive = getDefaultDrive(c, user.email);
    if (isResponse(drive)) return drive;
    return patchDriveItem(c, drive, c.req.param("id"));
  });

  app.patch("/v1.0/drives/:driveId/items/:itemId", async (c) => {
    c.set("operationId", "driveItem_UpdateDriveItem");
    const user = requireDriveWriteUser(c);
    if (isResponse(user)) return user;
    const drive = getRequestedDrive(c, c.req.param("driveId"), user.email);
    if (isResponse(drive)) return drive;
    return patchDriveItem(c, drive, c.req.param("itemId"));
  });

  app.delete("/v1.0/me/drive/items/:id", (c) => {
    c.set("operationId", "driveItem_Delete");
    const user = requireDriveWriteUser(c);
    if (isResponse(user)) return user;
    const drive = getDefaultDrive(c, user.email);
    if (isResponse(drive)) return drive;
    return deleteDriveItem(c, drive, c.req.param("id"));
  });

  app.delete("/v1.0/drives/:driveId/items/:itemId", (c) => {
    c.set("operationId", "driveItem_DeleteDriveItem");
    const user = requireDriveWriteUser(c);
    if (isResponse(user)) return user;
    const drive = getRequestedDrive(c, c.req.param("driveId"), user.email);
    if (isResponse(drive)) return drive;
    return deleteDriveItem(c, drive, c.req.param("itemId"));
  });

  app.put("/v1.0/me/drive/*", async (c) => {
    c.set("operationId", "driveItem_PutPathContent");
    const pathParts = parseRootContentPath(new URL(c.req.url).pathname, "/v1.0/me/drive/root:/");
    if (!pathParts)
      return graphError(c, 404, "UnknownError", "This Microsoft Graph endpoint is not implemented by the emulator.");
    const user = requireDriveWriteUser(c);
    if (isResponse(user)) return user;
    const drive = getDefaultDrive(c, user.email);
    if (isResponse(drive)) return drive;
    const root = getRequestedRoot(c, drive);
    if (isResponse(root)) return root;
    return putPathContent(c, drive, root, user.email, pathParts);
  });

  app.put("/v1.0/drives/:driveId/*", async (c) => {
    c.set("operationId", "driveItem_PutDrivePathContent");
    const pathname = new URL(c.req.url).pathname;
    const prefix = `/v1.0/drives/${c.req.param("driveId")}/items/root:/`;
    const pathParts = parseRootContentPath(pathname, prefix);
    if (!pathParts)
      return graphError(c, 404, "UnknownError", "This Microsoft Graph endpoint is not implemented by the emulator.");
    const user = requireDriveWriteUser(c);
    if (isResponse(user)) return user;
    const drive = getRequestedDrive(c, c.req.param("driveId"), user.email);
    if (isResponse(drive)) return drive;
    const root = getRequestedRoot(c, drive);
    if (isResponse(root)) return root;
    return putPathContent(c, drive, root, user.email, pathParts);
  });

  app.get("/v1.0/me/drive/special/:name", (c) => {
    c.set("operationId", "driveItem_GetSpecial");
    const scopeError = filesReadScope(c);
    if (scopeError) return scopeError;
    const user = requireDelegatedUser(c, ms);
    if (isResponse(user)) return user;
    const drive = getUserDrive(ms, user.email);
    if (!drive) return graphError(c, 404, "itemNotFound", "Drive not found.");
    const root = getDriveRoot(ms, drive);
    if (!root) return graphError(c, 404, "itemNotFound", "Root item not found.");
    if (c.req.param("name") !== "documents") {
      return graphError(c, 404, "itemNotFound", "Special folder not found.");
    }
    return c.json({
      "@odata.context": `${baseUrl}/v1.0/$metadata#drive/special/$entity`,
      ...formatDriveItem(baseUrl, root, ms),
    });
  });

  app.get("/v1.0/me/memberOf", (c) => {
    c.set("operationId", "directoryObject_ListMemberOf");
    if (!hasGraphScope(authScopes(c), ["User.Read", "Directory.Read.All"])) {
      return accessDenied(c, "Missing required Graph scope. Expected one of: User.Read, Directory.Read.All.");
    }
    const user = requireDelegatedUser(c, ms);
    if (isResponse(user)) return user;
    return c.json(odataCollection(baseUrl, "directoryObjects", "/v1.0/me/memberOf", [], c));
  });

  const notImplemented = (c: Context) => {
    if (!c.get("authUser")) return unauthorized(c);
    const pathname = new URL(c.req.url).pathname;
    const segments = pathname.split("/").filter(Boolean);
    // Drop the leading "v1.0" version segment; the first remaining segment is
    // the one Graph reports as unresolved.
    const firstSegment = segments[0] === "v1.0" ? segments[1] : segments[0];
    return graphError(c, 400, "BadRequest", `Resource not found for the segment '${firstSegment ?? ""}'.`);
  };
  for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
    app.on(method, "/v1.0/*", notImplemented);
  }
}
