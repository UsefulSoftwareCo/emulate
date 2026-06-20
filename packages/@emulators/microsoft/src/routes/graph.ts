import type { Context, RouteContext } from "@emulators/core";
import { recordSideEffect } from "@emulators/core";
import {
  accessDenied,
  authScopes,
  createEventRecord,
  createMessageRecord,
  defaultCalendar,
  defaultDrive,
  formatCalendar,
  formatDrive,
  formatDriveItem,
  formatEvent,
  formatMessage,
  formatUser,
  graphError,
  hasGraphScope,
  listMessages,
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
    const values = events.map((event) => formatEvent(baseUrl, event));
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
    return c.json(formatEvent(baseUrl, event), 201);
  });

  app.get("/v1.0/me/events/:id", (c) => {
    c.set("operationId", "event_Get");
    const scopeError = calendarReadScope(c);
    if (scopeError) return scopeError;
    const user = requireDelegatedUser(c, ms);
    if (isResponse(user)) return user;
    const event = findEvent(ms.events.findBy("user_email", user.email), c.req.param("id"));
    if (!event) return graphError(c, 404, "ErrorItemNotFound", "The specified object was not found in the store.");
    return c.json({ "@odata.context": `${baseUrl}/v1.0/$metadata#me/events/$entity`, ...formatEvent(baseUrl, event) });
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

  app.get("/v1.0/me/drive", (c) => {
    c.set("operationId", "drive_GetMyDrive");
    const scopeError = filesReadScope(c);
    if (scopeError) return scopeError;
    const user = requireDelegatedUser(c, ms);
    if (isResponse(user)) return user;
    const drive = getUserDrive(ms, user.email);
    if (!drive) return graphError(c, 404, "itemNotFound", "Drive not found.");
    return c.json({
      "@odata.context": `${baseUrl}/v1.0/$metadata#drives/$entity`,
      ...formatDrive(baseUrl, drive, user),
    });
  });

  app.get("/v1.0/me/drive/root", (c) => {
    c.set("operationId", "driveItem_GetRoot");
    const scopeError = filesReadScope(c);
    if (scopeError) return scopeError;
    const user = requireDelegatedUser(c, ms);
    if (isResponse(user)) return user;
    const drive = getUserDrive(ms, user.email);
    if (!drive) return graphError(c, 404, "itemNotFound", "Drive not found.");
    const root = getDriveRoot(ms, drive);
    if (!root) return graphError(c, 404, "itemNotFound", "Root item not found.");
    return c.json({
      "@odata.context": `${baseUrl}/v1.0/$metadata#drive/root/$entity`,
      ...formatDriveItem(baseUrl, root),
    });
  });

  app.get("/v1.0/me/drive/root/children", (c) => {
    c.set("operationId", "driveItem_ListRootChildren");
    const scopeError = filesReadScope(c);
    if (scopeError) return scopeError;
    const user = requireDelegatedUser(c, ms);
    if (isResponse(user)) return user;
    const drive = getUserDrive(ms, user.email);
    if (!drive) return graphError(c, 404, "itemNotFound", "Drive not found.");
    const root = getDriveRoot(ms, drive);
    if (!root) return graphError(c, 404, "itemNotFound", "Root item not found.");
    const values = getVisibleDriveItems(ms, drive)
      .filter((item) => item.parent_id === root.graph_id)
      .map((item) => formatDriveItem(baseUrl, item));
    return c.json(odataCollection(baseUrl, "drive/root/children", "/v1.0/me/drive/root/children", values, c));
  });

  app.get("/v1.0/me/drive/items/:id", (c) => {
    c.set("operationId", "driveItem_Get");
    const scopeError = filesReadScope(c);
    if (scopeError) return scopeError;
    const user = requireDelegatedUser(c, ms);
    if (isResponse(user)) return user;
    const item = ms.driveItems.findOneBy("graph_id", c.req.param("id"));
    if (!item || item.user_email !== user.email || item.deleted) {
      return graphError(c, 404, "itemNotFound", "The resource could not be found.");
    }
    return c.json({
      "@odata.context": `${baseUrl}/v1.0/$metadata#drive/items/$entity`,
      ...formatDriveItem(baseUrl, item),
    });
  });

  app.get("/v1.0/me/drive/items/:id/children", (c) => {
    c.set("operationId", "driveItem_ListChildren");
    const scopeError = filesReadScope(c);
    if (scopeError) return scopeError;
    const user = requireDelegatedUser(c, ms);
    if (isResponse(user)) return user;
    const parent = ms.driveItems.findOneBy("graph_id", c.req.param("id"));
    if (!parent || parent.user_email !== user.email || parent.deleted || parent.folder_child_count === null) {
      return graphError(c, 404, "itemNotFound", "The resource could not be found.");
    }
    const values = ms.driveItems
      .findBy("parent_id", parent.graph_id)
      .filter((item) => !item.deleted)
      .map((item) => formatDriveItem(baseUrl, item));
    return c.json(
      odataCollection(baseUrl, "drive/items/children", `/v1.0/me/drive/items/${parent.graph_id}/children`, values, c),
    );
  });

  app.patch("/v1.0/me/drive/items/:id", async (c) => {
    c.set("operationId", "driveItem_Update");
    const scopeError = requireGraphScope(c, ["Files.ReadWrite", "Files.ReadWrite.All"]);
    if (scopeError) return scopeError;
    const user = requireDelegatedUser(c, ms);
    if (isResponse(user)) return user;
    const item = ms.driveItems.findOneBy("graph_id", c.req.param("id"));
    if (!item || item.user_email !== user.email || item.deleted) {
      return graphError(c, 404, "itemNotFound", "The resource could not be found.");
    }
    const body = await parseJsonBody(c);
    const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const updated = ms.driveItems.update(item.id, {
      name: typeof record.name === "string" && record.name.length > 0 ? record.name : item.name,
    });
    if (!updated) return graphError(c, 404, "itemNotFound", "The resource could not be found.");
    recordSideEffect(c, {
      type: "update",
      collection: "microsoft.drive_items",
      id: updated.graph_id,
      summary: `Updated drive item '${updated.name}'`,
    });
    return c.json(formatDriveItem(baseUrl, updated));
  });

  app.delete("/v1.0/me/drive/items/:id", (c) => {
    c.set("operationId", "driveItem_Delete");
    const scopeError = requireGraphScope(c, ["Files.ReadWrite", "Files.ReadWrite.All"]);
    if (scopeError) return scopeError;
    const user = requireDelegatedUser(c, ms);
    if (isResponse(user)) return user;
    const item = ms.driveItems.findOneBy("graph_id", c.req.param("id"));
    if (!item || item.user_email !== user.email || item.deleted) {
      return graphError(c, 404, "itemNotFound", "The resource could not be found.");
    }
    ms.driveItems.update(item.id, { deleted: true });
    recordSideEffect(c, {
      type: "delete",
      collection: "microsoft.drive_items",
      id: item.graph_id,
      summary: `Deleted drive item '${item.name}'`,
    });
    return c.body(null, 204);
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
      ...formatDriveItem(baseUrl, root),
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
    return graphError(c, 404, "UnknownError", "This Microsoft Graph endpoint is not implemented by the emulator.");
  };
  for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
    app.on(method, "/v1.0/*", notImplemented);
  }
}
