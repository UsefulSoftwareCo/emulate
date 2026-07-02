import type { RouteContext } from "@emulators/core";
import type { Context } from "@emulators/core";
import {
  createDriveItemRecord,
  deleteDriveItemRecord,
  formatDriveItemResource,
  getDriveItemById,
  listDriveItems,
  parseDriveMultipartUpload,
  updateDriveItemRecord,
} from "../drive-helpers.js";
import { googleApiError } from "../helpers.js";
import {
  getRecord,
  getString,
  parseDriveItemInputFromBody,
  parseGoogleBody,
  requireGoogleAuth,
} from "../route-helpers.js";
import { getGoogleStore } from "../store.js";

export function driveRoutes({ app, store }: RouteContext): void {
  const gs = getGoogleStore(store);

  const createHandler = async (c: Context) => {
    const authEmail = requireGoogleAuth(c);
    if (authEmail instanceof Response) return authEmail;

    const contentType = c.req.header("Content-Type") ?? "";
    const uploadType = new URL(c.req.url).searchParams.get("uploadType");
    let requestBody: Record<string, unknown> = {};
    let media: { mimeType: string; body: Buffer } | undefined;

    if (uploadType === "media") {
      media = {
        mimeType: getUploadMimeType(contentType),
        body: Buffer.from(await c.req.raw.arrayBuffer()),
      };
    } else if (uploadType === "multipart" || contentType.toLowerCase().includes("multipart/related")) {
      const rawBody = Buffer.from(await c.req.raw.arrayBuffer());
      const parsed = parseDriveMultipartUpload(contentType, rawBody);
      if (parsed.malformed) return driveMalformedMultipartError(c);
      requestBody = parsed.requestBody;
      media = parsed.media;
    } else {
      const body = await parseGoogleBody(c);
      requestBody = getRecord(body, "requestBody") ?? body;
    }

    const item = createDriveItemRecord(gs, {
      user_email: authEmail,
      ...parseDriveItemInputFromBody(requestBody, {
        mimeType: media?.mimeType,
      }),
      size: media ? media.body.length : null,
      data: media ? media.body.toString("base64url") : null,
    });
    return c.json(formatDriveItemResource(item, new URL(c.req.url).searchParams.get("fields")));
  };

  app.get("/drive/v3/files", (c) => {
    const authEmail = requireGoogleAuth(c);
    if (authEmail instanceof Response) return authEmail;

    const url = new URL(c.req.url);
    const response = listDriveItems(gs, authEmail, {
      q: url.searchParams.get("q"),
      pageSize: url.searchParams.get("pageSize"),
      pageToken: url.searchParams.get("pageToken"),
      orderBy: url.searchParams.get("orderBy"),
    });

    return c.json({
      kind: "drive#fileList",
      incompleteSearch: false,
      files: response.files.map((item) => formatDriveItemResource(item, url.searchParams.get("fields"))),
      nextPageToken: response.nextPageToken,
    });
  });

  app.post("/drive/v3/files", createHandler);
  app.post("/upload/drive/v3/files", createHandler);

  app.get("/drive/v3/files/:fileId", (c) => {
    const authEmail = requireGoogleAuth(c);
    if (authEmail instanceof Response) return authEmail;

    const item = getDriveItemById(gs, authEmail, c.req.param("fileId"));
    if (!item) {
      return googleApiError(c, 404, "Requested entity was not found.", "notFound", "NOT_FOUND");
    }

    const url = new URL(c.req.url);
    if (url.searchParams.get("alt") === "media") {
      return new Response(item.data ? Buffer.from(item.data, "base64url") : Buffer.alloc(0), {
        status: 200,
        headers: {
          "Content-Type": item.mime_type,
        },
      });
    }

    return c.json(formatDriveItemResource(item, url.searchParams.get("fields")));
  });

  const updateHandler = async (c: Context) => {
    const authEmail = requireGoogleAuth(c);
    if (authEmail instanceof Response) return authEmail;

    const url = new URL(c.req.url);
    const item = getDriveItemById(gs, authEmail, c.req.param("fileId")!);
    if (!item) {
      return googleApiError(c, 404, "Requested entity was not found.", "notFound", "NOT_FOUND");
    }

    const contentType = c.req.header("Content-Type") ?? "";
    const uploadType = url.searchParams.get("uploadType");
    let requestBody: Record<string, unknown> = {};
    let media: { mimeType: string; body: Buffer } | undefined;

    if (uploadType === "media") {
      media = {
        mimeType: getUploadMimeType(contentType),
        body: Buffer.from(await c.req.raw.arrayBuffer()),
      };
    } else if (uploadType === "multipart" || contentType.toLowerCase().includes("multipart/related")) {
      const rawBody = Buffer.from(await c.req.raw.arrayBuffer());
      const parsed = parseDriveMultipartUpload(contentType, rawBody);
      if (parsed.malformed) return driveMalformedMultipartError(c);
      requestBody = parsed.requestBody;
      media = parsed.media;
    } else {
      const body = await parseGoogleBody(c);
      requestBody = getRecord(body, "requestBody") ?? body;
    }

    const addParents = (url.searchParams.get("addParents") ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    const removeParents = (url.searchParams.get("removeParents") ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);

    const updated = updateDriveItemRecord(gs, item, {
      addParents,
      removeParents,
      name: getString(requestBody, "name"),
      mimeType: media?.mimeType,
      size: media ? media.body.length : undefined,
      data: media ? media.body.toString("base64url") : undefined,
      trashed: typeof requestBody.trashed === "boolean" ? requestBody.trashed : undefined,
    });

    return c.json(formatDriveItemResource(updated, url.searchParams.get("fields")));
  };

  app.patch("/drive/v3/files/:fileId", updateHandler);
  app.put("/drive/v3/files/:fileId", updateHandler);
  app.patch("/upload/drive/v3/files/:fileId", updateHandler);
  app.put("/upload/drive/v3/files/:fileId", updateHandler);

  app.delete("/drive/v3/files/:fileId", (c) => {
    const authEmail = requireGoogleAuth(c);
    if (authEmail instanceof Response) return authEmail;

    const item = getDriveItemById(gs, authEmail, c.req.param("fileId"));
    if (!item) {
      return googleApiError(c, 404, "Requested entity was not found.", "notFound", "NOT_FOUND");
    }

    deleteDriveItemRecord(gs, item);
    return c.body(null, 204);
  });
}

function getUploadMimeType(contentType: string): string {
  return contentType.split(";")[0]?.trim() || "application/octet-stream";
}

function driveMalformedMultipartError(c: Context) {
  return googleApiError(c, 400, "Malformed multipart body.", "badContent", "INVALID_ARGUMENT");
}
