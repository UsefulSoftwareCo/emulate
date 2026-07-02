import type { RouteContext } from "@emulators/core";

export function openapiRoutes({ app, baseUrl }: RouteContext): void {
  app.get("/openapi.json", (c) => c.json(buildSpec(baseUrl)));
}

const jsonResponse = (description: string) => ({
  description,
  content: { "application/json": { schema: { type: "object" } } },
});

const emptyResponse = (description: string) => ({ description });

const bearerErrors = {
  "401": jsonResponse("Authentication is required."),
  "403": jsonResponse("The access token does not include the required Graph scope."),
};

const idPathParameter = { name: "id", in: "path", required: true, schema: { type: "string" } };
const driveIdPathParameter = { name: "driveId", in: "path", required: true, schema: { type: "string" } };
const itemIdPathParameter = { name: "itemId", in: "path", required: true, schema: { type: "string" } };
const drivePathParameter = { name: "path", in: "path", required: true, schema: { type: "string" } };

function getOperation(
  operationId: string,
  summary: string,
  scopes: string[],
  responses: Record<string, unknown> = { "200": jsonResponse("Successful response.") },
): Record<string, unknown> {
  return {
    operationId,
    summary,
    security: [{ azureAdDelegated: scopes }],
    responses: { ...responses, ...bearerErrors },
  };
}

function buildSpec(baseUrl: string): Record<string, unknown> {
  const scopes = {
    openid: "Sign users in.",
    email: "View users' email address.",
    profile: "View users' basic profile.",
    offline_access: "Maintain access to data you have given it access to.",
    "User.Read": "Sign in and read user profile.",
    "User.Read.All": "Read all users' full profiles.",
    "Mail.Read": "Read user mail.",
    "Mail.ReadWrite": "Read and write user mail.",
    "Mail.Send": "Send mail as a user.",
    "Calendars.Read": "Read user calendars.",
    "Calendars.ReadWrite": "Read and write user calendars.",
    "Files.Read": "Read user files.",
    "Files.Read.All": "Read all files that the user can access.",
    "Files.ReadWrite": "Read and write user files.",
    "Files.ReadWrite.All": "Read and write all files that the user can access.",
    "https://graph.microsoft.com/.default": "Use application permissions granted to the client.",
  };

  return {
    openapi: "3.0.3",
    info: {
      title: "Microsoft Graph REST API v1.0 (Emulated)",
      version: "1.0.0",
      description:
        "Emulated subset of Microsoft Graph v1.0. The OAuth security scheme points at this emulator instance and supports delegated authorization code plus client credentials token grants.",
    },
    servers: [{ url: baseUrl }],
    components: {
      securitySchemes: {
        azureAdDelegated: {
          type: "oauth2",
          description: "Microsoft identity platform OAuth 2.0 flows.",
          flows: {
            authorizationCode: {
              authorizationUrl: `${baseUrl}/oauth2/v2.0/authorize`,
              tokenUrl: `${baseUrl}/oauth2/v2.0/token`,
              scopes,
            },
            clientCredentials: {
              tokenUrl: `${baseUrl}/oauth2/v2.0/token`,
              scopes: {
                "https://graph.microsoft.com/.default": scopes["https://graph.microsoft.com/.default"],
              },
            },
          },
        },
      },
    },
    security: [{ azureAdDelegated: ["User.Read"] }],
    paths: {
      "/v1.0/me": {
        get: getOperation("graphUser_GetMyProfile", "Get the signed-in user", ["User.Read"], {
          "200": jsonResponse("Graph user profile."),
        }),
      },
      "/v1.0/users": {
        get: getOperation("graphUser_List", "List users", ["User.Read.All"], {
          "200": jsonResponse("Graph user collection."),
        }),
      },
      "/v1.0/users/{id}": {
        get: {
          ...getOperation("graphUser_GetById", "Get a user by id or user principal name", ["User.Read.All"], {
            "200": jsonResponse("Graph user profile."),
            "404": jsonResponse("User not found."),
          }),
          parameters: [idPathParameter],
        },
      },
      "/v1.0/me/messages": {
        get: getOperation("message_List", "List messages", ["Mail.Read"], {
          "200": jsonResponse("Mail message collection."),
        }),
      },
      "/v1.0/me/messages/{id}": {
        get: {
          ...getOperation("message_Get", "Get a message", ["Mail.Read"], {
            "200": jsonResponse("Mail message."),
            "404": jsonResponse("Message not found."),
          }),
          parameters: [idPathParameter],
        },
      },
      "/v1.0/me/sendMail": {
        post: getOperation("message_SendMail", "Send mail", ["Mail.Send"], {
          "202": emptyResponse("Mail accepted for delivery."),
        }),
      },
      "/v1.0/me/calendar": {
        get: getOperation("calendar_GetDefaultCalendar", "Get default calendar", ["Calendars.Read"], {
          "200": jsonResponse("Calendar."),
        }),
      },
      "/v1.0/me/calendars": {
        get: getOperation("calendar_List", "List calendars", ["Calendars.Read"], {
          "200": jsonResponse("Calendar collection."),
        }),
      },
      "/v1.0/me/events": {
        get: getOperation("event_List", "List events", ["Calendars.Read"], {
          "200": jsonResponse("Event collection."),
        }),
        post: getOperation("event_Create", "Create an event", ["Calendars.ReadWrite"], {
          "201": jsonResponse("Created event."),
        }),
      },
      "/v1.0/me/events/{id}": {
        get: {
          ...getOperation("event_Get", "Get an event", ["Calendars.Read"], {
            "200": jsonResponse("Event."),
            "404": jsonResponse("Event not found."),
          }),
          parameters: [idPathParameter],
        },
        delete: {
          ...getOperation("event_Delete", "Delete an event", ["Calendars.ReadWrite"], {
            "204": emptyResponse("Deleted event."),
            "404": jsonResponse("Event not found."),
          }),
          parameters: [idPathParameter],
        },
      },
      "/v1.0/me/calendar/events": {
        get: getOperation("event_ListCalendarView", "List default calendar events", ["Calendars.Read"], {
          "200": jsonResponse("Event collection."),
        }),
      },
      "/v1.0/me/drive": {
        get: getOperation("drive_GetMyDrive", "Get the signed-in user's OneDrive", ["Files.Read"], {
          "200": jsonResponse("Drive."),
        }),
      },
      "/v1.0/me/drive/root": {
        get: getOperation("driveItem_GetRoot", "Get the root drive item", ["Files.Read"], {
          "200": jsonResponse("Drive item."),
        }),
      },
      "/v1.0/me/drive/root/children": {
        get: getOperation("driveItem_ListRootChildren", "List root children", ["Files.Read"], {
          "200": jsonResponse("Drive item collection."),
        }),
        post: getOperation("driveItem_CreateRootChild", "Create a folder under the root", ["Files.ReadWrite"], {
          "201": jsonResponse("Created drive folder."),
          "409": jsonResponse("Drive item name conflict."),
        }),
      },
      "/v1.0/me/drive/root:/{path}:/content": {
        put: {
          ...getOperation("driveItem_PutPathContent", "Create or replace file content by path", ["Files.ReadWrite"], {
            "200": jsonResponse("Replaced drive item."),
            "201": jsonResponse("Created drive item."),
          }),
          parameters: [drivePathParameter],
        },
      },
      "/v1.0/me/drive/items/{id}": {
        get: {
          ...getOperation("driveItem_Get", "Get a drive item", ["Files.Read"], {
            "200": jsonResponse("Drive item."),
            "404": jsonResponse("Drive item not found."),
          }),
          parameters: [idPathParameter],
        },
        patch: {
          ...getOperation("driveItem_Update", "Update a drive item", ["Files.ReadWrite"], {
            "200": jsonResponse("Updated drive item."),
            "404": jsonResponse("Drive item not found."),
          }),
          parameters: [idPathParameter],
        },
        delete: {
          ...getOperation("driveItem_Delete", "Delete a drive item", ["Files.ReadWrite"], {
            "204": emptyResponse("Deleted drive item."),
            "404": jsonResponse("Drive item not found."),
          }),
          parameters: [idPathParameter],
        },
      },
      "/v1.0/me/drive/items/{id}/content": {
        get: {
          ...getOperation("driveItem_GetContent", "Redirect to file content", ["Files.Read"], {
            "302": emptyResponse("Redirect to preauthenticated content URL."),
            "404": jsonResponse("Drive item not found."),
          }),
          parameters: [idPathParameter],
        },
        put: {
          ...getOperation("driveItem_PutContent", "Replace file content by item id", ["Files.ReadWrite"], {
            "200": jsonResponse("Updated drive item."),
            "404": jsonResponse("Drive item not found."),
          }),
          parameters: [idPathParameter],
        },
      },
      "/v1.0/me/drive/items/{id}/children": {
        get: {
          ...getOperation("driveItem_ListChildren", "List drive item children", ["Files.Read"], {
            "200": jsonResponse("Drive item collection."),
            "404": jsonResponse("Drive item not found."),
          }),
          parameters: [idPathParameter],
        },
      },
      "/v1.0/drives/{driveId}": {
        get: {
          ...getOperation("drive_Get", "Get a drive by id", ["Files.Read"], {
            "200": jsonResponse("Drive."),
            "404": jsonResponse("Drive not found."),
          }),
          parameters: [driveIdPathParameter],
        },
      },
      "/v1.0/drives/{driveId}/root": {
        get: {
          ...getOperation("driveItem_GetDriveRoot", "Get a drive root by drive id", ["Files.Read"], {
            "200": jsonResponse("Drive item."),
            "404": jsonResponse("Drive not found."),
          }),
          parameters: [driveIdPathParameter],
        },
      },
      "/v1.0/drives/{driveId}/root/children": {
        get: {
          ...getOperation("driveItem_ListDriveRootChildren", "List drive root children by drive id", ["Files.Read"], {
            "200": jsonResponse("Drive item collection."),
            "404": jsonResponse("Drive not found."),
          }),
          parameters: [driveIdPathParameter],
        },
        post: {
          ...getOperation("driveItem_CreateDriveRootChild", "Create a folder under a drive root", ["Files.ReadWrite"], {
            "201": jsonResponse("Created drive folder."),
            "409": jsonResponse("Drive item name conflict."),
          }),
          parameters: [driveIdPathParameter],
        },
      },
      "/v1.0/drives/{driveId}/items/{itemId}": {
        get: {
          ...getOperation("driveItem_GetDriveItem", "Get a drive item by drive id", ["Files.Read"], {
            "200": jsonResponse("Drive item."),
            "404": jsonResponse("Drive item not found."),
          }),
          parameters: [driveIdPathParameter, itemIdPathParameter],
        },
        patch: {
          ...getOperation("driveItem_UpdateDriveItem", "Update a drive item by drive id", ["Files.ReadWrite"], {
            "200": jsonResponse("Updated drive item."),
            "404": jsonResponse("Drive item not found."),
          }),
          parameters: [driveIdPathParameter, itemIdPathParameter],
        },
        delete: {
          ...getOperation("driveItem_DeleteDriveItem", "Delete a drive item by drive id", ["Files.ReadWrite"], {
            "204": emptyResponse("Deleted drive item."),
            "404": jsonResponse("Drive item not found."),
          }),
          parameters: [driveIdPathParameter, itemIdPathParameter],
        },
      },
      "/v1.0/drives/{driveId}/items/{itemId}/children": {
        get: {
          ...getOperation("driveItem_ListDriveChildren", "List drive item children by drive id", ["Files.Read"], {
            "200": jsonResponse("Drive item collection."),
            "404": jsonResponse("Drive item not found."),
          }),
          parameters: [driveIdPathParameter, itemIdPathParameter],
        },
      },
      "/v1.0/drives/{driveId}/items/{itemId}/content": {
        get: {
          ...getOperation("driveItem_GetDriveContent", "Redirect to file content by drive id", ["Files.Read"], {
            "302": emptyResponse("Redirect to preauthenticated content URL."),
            "404": jsonResponse("Drive item not found."),
          }),
          parameters: [driveIdPathParameter, itemIdPathParameter],
        },
        put: {
          ...getOperation("driveItem_PutDriveContent", "Replace file content by drive id", ["Files.ReadWrite"], {
            "200": jsonResponse("Updated drive item."),
            "404": jsonResponse("Drive item not found."),
          }),
          parameters: [driveIdPathParameter, itemIdPathParameter],
        },
      },
      "/v1.0/drives/{driveId}/items/root:/{path}:/content": {
        put: {
          ...getOperation(
            "driveItem_PutDrivePathContent",
            "Create or replace file content by drive path",
            ["Files.ReadWrite"],
            {
              "200": jsonResponse("Replaced drive item."),
              "201": jsonResponse("Created drive item."),
            },
          ),
          parameters: [driveIdPathParameter, drivePathParameter],
        },
      },
    },
  };
}
