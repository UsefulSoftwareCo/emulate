import type { RouteContext } from "@emulators/core";

// OpenAPI 3.1 document for this MongoDB Atlas emulator instance, pointed at
// itself. Real Atlas authenticates the Admin API with HTTP digest (API key
// pair) or a service-account OAuth bearer token; this emulator accepts a plain
// bearer token instead (mint one at POST /_emulate/credentials). Covers the
// hand-authored surface (see manifest.ts); unsupported operations are omitted
// so OpenAPI-aware clients only see what actually works.
export function openapiRoutes({ app, baseUrl }: RouteContext): void {
  app.get("/openapi.json", (c) => c.json(buildSpec(baseUrl)));
}

const ok = (description: string) => ({
  description,
  content: { "application/json": { schema: { type: "object" } } },
});
const deleted = { description: "Deleted (no content)." };
const groupId = { name: "groupId", in: "path", required: true, schema: { type: "string" } };
const clusterName = { name: "clusterName", in: "path", required: true, schema: { type: "string" } };
const username = { name: "username", in: "path", required: true, schema: { type: "string" } };
const databaseName = { name: "databaseName", in: "path", required: true, schema: { type: "string" } };
const jsonBody = (properties: Record<string, unknown>, required: readonly string[], description: string) => ({
  required: true,
  description,
  content: {
    "application/json": {
      schema: { type: "object", properties, required: [...required] },
    },
  },
});
const dataApiTarget = {
  dataSource: { type: "string", description: "Cluster name, e.g. Cluster0." },
  database: { type: "string" },
  collection: { type: "string" },
};
const filter = { type: "object", description: "MongoDB query filter." };

function buildSpec(baseUrl: string): Record<string, unknown> {
  return {
    openapi: "3.1.0",
    info: {
      title: "MongoDB Atlas Administration API (Emulated)",
      version: "1.0.0",
      description:
        "Emulated subset of the MongoDB Atlas Administration API v2 and Atlas Data API v1. Real Atlas uses HTTP digest (API key pair) or service-account bearer tokens; the emulator accepts `Authorization: Bearer <token>` for every surface (mint a token at POST /_emulate/credentials).",
    },
    servers: [{ url: baseUrl }],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          description:
            "Atlas API token, sent as `Authorization: Bearer emu_mongoatlas_…`. Stands in for Atlas digest or service-account auth.",
        },
      },
    },
    security: [{ bearerAuth: [] }],
    paths: {
      "/api/atlas/v2/groups": {
        get: {
          operationId: "listProjects",
          tags: ["projects"],
          summary: "List projects",
          responses: { "200": ok("Project list.") },
        },
        post: {
          operationId: "createProject",
          tags: ["projects"],
          summary: "Create a project",
          requestBody: jsonBody(
            { name: { type: "string" }, orgId: { type: "string" } },
            ["name"],
            "The project to create.",
          ),
          responses: { "201": ok("The created project."), "409": ok("Duplicate project name.") },
        },
      },
      "/api/atlas/v2/groups/{groupId}": {
        get: {
          operationId: "getProject",
          tags: ["projects"],
          summary: "Retrieve a project",
          parameters: [groupId],
          responses: { "200": ok("The project."), "404": ok("Not found.") },
        },
        delete: {
          operationId: "deleteProject",
          tags: ["projects"],
          summary: "Delete a project and its clusters",
          parameters: [groupId],
          responses: { "204": deleted, "404": ok("Not found.") },
        },
      },
      "/api/atlas/v2/groups/{groupId}/clusters": {
        get: {
          operationId: "listClusters",
          tags: ["clusters"],
          summary: "List clusters in a project",
          parameters: [groupId],
          responses: { "200": ok("Cluster list."), "404": ok("Project not found.") },
        },
        post: {
          operationId: "createCluster",
          tags: ["clusters"],
          summary: "Create a cluster",
          parameters: [groupId],
          requestBody: jsonBody(
            {
              name: { type: "string" },
              clusterType: { type: "string", enum: ["REPLICASET", "SHARDED"] },
              providerSettings: {
                type: "object",
                properties: {
                  providerName: { type: "string" },
                  instanceSizeName: { type: "string" },
                  regionName: { type: "string" },
                },
              },
              diskSizeGB: { type: "number" },
              mongoDBMajorVersion: { type: "string" },
            },
            ["name"],
            "The cluster to create.",
          ),
          responses: {
            "201": ok("The created cluster."),
            "404": ok("Project not found."),
            "409": ok("Duplicate cluster name."),
          },
        },
      },
      "/api/atlas/v2/groups/{groupId}/clusters/{clusterName}": {
        get: {
          operationId: "getCluster",
          tags: ["clusters"],
          summary: "Retrieve a cluster",
          parameters: [groupId, clusterName],
          responses: { "200": ok("The cluster."), "404": ok("Not found.") },
        },
        patch: {
          operationId: "updateCluster",
          tags: ["clusters"],
          summary: "Update a cluster (instance size, region, disk size)",
          parameters: [groupId, clusterName],
          requestBody: jsonBody(
            {
              providerSettings: {
                type: "object",
                properties: {
                  instanceSizeName: { type: "string" },
                  regionName: { type: "string" },
                },
              },
              diskSizeGB: { type: "number" },
            },
            [],
            "Fields to update; other cluster fields are immutable in the emulator.",
          ),
          responses: { "200": ok("The updated cluster."), "404": ok("Not found.") },
        },
        delete: {
          operationId: "deleteCluster",
          tags: ["clusters"],
          summary: "Delete a cluster and its data",
          parameters: [groupId, clusterName],
          responses: { "204": deleted, "404": ok("Not found.") },
        },
      },
      "/api/atlas/v2/groups/{groupId}/databaseUsers": {
        get: {
          operationId: "listDatabaseUsers",
          tags: ["database-users"],
          summary: "List database users in a project",
          parameters: [groupId],
          responses: { "200": ok("Database user list.") },
        },
        post: {
          operationId: "createDatabaseUser",
          tags: ["database-users"],
          summary: "Create a database user",
          parameters: [groupId],
          requestBody: jsonBody(
            {
              username: { type: "string" },
              password: { type: "string" },
              databaseName: { type: "string" },
              roles: {
                type: "array",
                items: {
                  type: "object",
                  properties: { databaseName: { type: "string" }, roleName: { type: "string" } },
                },
              },
            },
            ["username"],
            "The database user to create.",
          ),
          responses: { "201": ok("The created database user."), "409": ok("Duplicate username.") },
        },
      },
      "/api/atlas/v2/groups/{groupId}/databaseUsers/admin/{username}": {
        get: {
          operationId: "getDatabaseUser",
          tags: ["database-users"],
          summary: "Retrieve a database user",
          parameters: [groupId, username],
          responses: { "200": ok("The database user."), "404": ok("Not found.") },
        },
        delete: {
          operationId: "deleteDatabaseUser",
          tags: ["database-users"],
          summary: "Delete a database user",
          parameters: [groupId, username],
          responses: { "204": deleted, "404": ok("Not found.") },
        },
      },
      "/api/atlas/v2/groups/{groupId}/clusters/{clusterName}/databases": {
        get: {
          operationId: "listDatabases",
          tags: ["databases"],
          summary: "List databases in a cluster",
          parameters: [groupId, clusterName],
          responses: { "200": ok("Database list."), "404": ok("Cluster not found.") },
        },
      },
      "/api/atlas/v2/groups/{groupId}/clusters/{clusterName}/databases/{databaseName}/collections": {
        get: {
          operationId: "listCollections",
          tags: ["databases"],
          summary: "List collections in a database",
          parameters: [groupId, clusterName, databaseName],
          responses: { "200": ok("Collection list."), "404": ok("Cluster not found.") },
        },
      },
      "/app/data-api/v1/action/findOne": {
        post: {
          operationId: "findOne",
          tags: ["data-api"],
          summary: "Find a single document",
          requestBody: jsonBody(
            { ...dataApiTarget, filter, projection: { type: "object" } },
            ["dataSource", "database", "collection"],
            "Where to look and what to match.",
          ),
          responses: { "200": ok("`{ document }` (null when nothing matches)."), "404": ok("Cluster not found.") },
        },
      },
      "/app/data-api/v1/action/find": {
        post: {
          operationId: "find",
          tags: ["data-api"],
          summary: "Find multiple documents",
          requestBody: jsonBody(
            {
              ...dataApiTarget,
              filter,
              projection: { type: "object" },
              sort: { type: "object" },
              limit: { type: "integer" },
              skip: { type: "integer" },
            },
            ["dataSource", "database", "collection"],
            "Where to look, what to match, and how to page.",
          ),
          responses: { "200": ok("`{ documents }`."), "404": ok("Cluster not found.") },
        },
      },
      "/app/data-api/v1/action/insertOne": {
        post: {
          operationId: "insertOne",
          tags: ["data-api"],
          summary: "Insert a single document",
          requestBody: jsonBody(
            { ...dataApiTarget, document: { type: "object" } },
            ["dataSource", "database", "collection", "document"],
            "The document to insert.",
          ),
          responses: { "201": ok("`{ insertedId }`."), "404": ok("Cluster not found.") },
        },
      },
      "/app/data-api/v1/action/insertMany": {
        post: {
          operationId: "insertMany",
          tags: ["data-api"],
          summary: "Insert multiple documents",
          requestBody: jsonBody(
            { ...dataApiTarget, documents: { type: "array", items: { type: "object" } } },
            ["dataSource", "database", "collection", "documents"],
            "The documents to insert.",
          ),
          responses: { "201": ok("`{ insertedIds }`."), "404": ok("Cluster not found.") },
        },
      },
      "/app/data-api/v1/action/updateOne": {
        post: {
          operationId: "updateOne",
          tags: ["data-api"],
          summary: "Update a single document",
          requestBody: jsonBody(
            { ...dataApiTarget, filter, update: { type: "object" }, upsert: { type: "boolean" } },
            ["dataSource", "database", "collection", "update"],
            "What to match and how to update it ($set, $unset, $inc, $push, $pull, $rename, or replacement).",
          ),
          responses: {
            "200": ok("`{ matchedCount, modifiedCount }` (plus `upsertedId` on upsert)."),
            "404": ok("Cluster not found."),
          },
        },
      },
      "/app/data-api/v1/action/updateMany": {
        post: {
          operationId: "updateMany",
          tags: ["data-api"],
          summary: "Update multiple documents",
          requestBody: jsonBody(
            { ...dataApiTarget, filter, update: { type: "object" }, upsert: { type: "boolean" } },
            ["dataSource", "database", "collection", "update"],
            "What to match and how to update it ($set, $unset, $inc, $push, $pull, $rename, or replacement).",
          ),
          responses: {
            "200": ok("`{ matchedCount, modifiedCount }` (plus `upsertedId` on upsert)."),
            "404": ok("Cluster not found."),
          },
        },
      },
      "/app/data-api/v1/action/deleteOne": {
        post: {
          operationId: "deleteOne",
          tags: ["data-api"],
          summary: "Delete a single document",
          requestBody: jsonBody(
            { ...dataApiTarget, filter },
            ["dataSource", "database", "collection"],
            "What to match.",
          ),
          responses: { "200": ok("`{ deletedCount }`."), "404": ok("Cluster not found.") },
        },
      },
      "/app/data-api/v1/action/deleteMany": {
        post: {
          operationId: "deleteMany",
          tags: ["data-api"],
          summary: "Delete multiple documents",
          requestBody: jsonBody(
            { ...dataApiTarget, filter },
            ["dataSource", "database", "collection"],
            "What to match.",
          ),
          responses: { "200": ok("`{ deletedCount }`."), "404": ok("Cluster not found.") },
        },
      },
      "/app/data-api/v1/action/aggregate": {
        post: {
          operationId: "aggregate",
          tags: ["data-api"],
          summary: "Run an aggregation pipeline (subset: $match, $limit, $skip, $sort, $project, $count)",
          requestBody: jsonBody(
            { ...dataApiTarget, pipeline: { type: "array", items: { type: "object" } } },
            ["dataSource", "database", "collection"],
            "The pipeline to run; unsupported stages are ignored.",
          ),
          responses: { "200": ok("`{ documents }`."), "404": ok("Cluster not found.") },
        },
      },
    },
  };
}
