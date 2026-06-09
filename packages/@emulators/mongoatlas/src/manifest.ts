import type { ServiceManifest } from "@emulators/core";

/**
 * MongoDB Atlas's machine-readable service manifest. This is the single source of
 * truth for the Atlas emulator's surfaces, auth, specs, seed shape, and copyable
 * connection snippets, consumed by the CLI registry, the Cloudflare host, and the
 * console.
 */
export const manifest: ServiceManifest = {
  id: "mongoatlas",
  name: "MongoDB Atlas",
  description: "Stateful MongoDB Atlas emulator for the Atlas Administration API v2 and the Atlas Data API v1.",
  docsUrl: "https://docs.emulators.dev/mongoatlas",
  surfaces: [
    { id: "admin", kind: "rest", title: "Atlas Admin API", status: "partial", basePath: "/api/atlas/v2" },
    { id: "data-api", kind: "rest", title: "Atlas Data API", status: "partial", basePath: "/api/data/v1" },
  ],
  auth: [{ id: "api-key", title: "Atlas API key bearer", type: "api-key", status: "partial" }],
  specs: [
    {
      kind: "openapi",
      title: "Atlas Administration API v2 subset",
      coverage: "hand-authored",
      operations: [
        { operationId: "listProjects", method: "GET", path: "/api/atlas/v2/groups", status: "hand-authored" },
        { operationId: "getProject", method: "GET", path: "/api/atlas/v2/groups/:groupId", status: "hand-authored" },
        { operationId: "createProject", method: "POST", path: "/api/atlas/v2/groups", status: "hand-authored" },
        {
          operationId: "deleteProject",
          method: "DELETE",
          path: "/api/atlas/v2/groups/:groupId",
          status: "hand-authored",
        },
        {
          operationId: "listClusters",
          method: "GET",
          path: "/api/atlas/v2/groups/:groupId/clusters",
          status: "hand-authored",
        },
        {
          operationId: "getCluster",
          method: "GET",
          path: "/api/atlas/v2/groups/:groupId/clusters/:clusterName",
          status: "hand-authored",
        },
        {
          operationId: "createCluster",
          method: "POST",
          path: "/api/atlas/v2/groups/:groupId/clusters",
          status: "hand-authored",
        },
        {
          operationId: "updateCluster",
          method: "PATCH",
          path: "/api/atlas/v2/groups/:groupId/clusters/:clusterName",
          status: "partial",
        },
        {
          operationId: "deleteCluster",
          method: "DELETE",
          path: "/api/atlas/v2/groups/:groupId/clusters/:clusterName",
          status: "hand-authored",
        },
        {
          operationId: "listDatabaseUsers",
          method: "GET",
          path: "/api/atlas/v2/groups/:groupId/databaseUsers",
          status: "hand-authored",
        },
        {
          operationId: "getDatabaseUser",
          method: "GET",
          path: "/api/atlas/v2/groups/:groupId/databaseUsers/admin/:username",
          status: "hand-authored",
        },
        {
          operationId: "createDatabaseUser",
          method: "POST",
          path: "/api/atlas/v2/groups/:groupId/databaseUsers",
          status: "hand-authored",
        },
        {
          operationId: "deleteDatabaseUser",
          method: "DELETE",
          path: "/api/atlas/v2/groups/:groupId/databaseUsers/admin/:username",
          status: "hand-authored",
        },
        {
          operationId: "listDatabases",
          method: "GET",
          path: "/api/atlas/v2/groups/:groupId/clusters/:clusterName/databases",
          status: "hand-authored",
        },
        {
          operationId: "listCollections",
          method: "GET",
          path: "/api/atlas/v2/groups/:groupId/clusters/:clusterName/databases/:databaseName/collections",
          status: "hand-authored",
        },
      ],
    },
    {
      kind: "openapi",
      title: "Atlas Data API v1 subset",
      coverage: "hand-authored",
      operations: [
        { operationId: "findOne", method: "POST", path: "/app/data-api/v1/action/findOne", status: "hand-authored" },
        { operationId: "find", method: "POST", path: "/app/data-api/v1/action/find", status: "hand-authored" },
        {
          operationId: "insertOne",
          method: "POST",
          path: "/app/data-api/v1/action/insertOne",
          status: "hand-authored",
        },
        {
          operationId: "insertMany",
          method: "POST",
          path: "/app/data-api/v1/action/insertMany",
          status: "hand-authored",
        },
        {
          operationId: "updateOne",
          method: "POST",
          path: "/app/data-api/v1/action/updateOne",
          status: "hand-authored",
        },
        {
          operationId: "updateMany",
          method: "POST",
          path: "/app/data-api/v1/action/updateMany",
          status: "hand-authored",
        },
        {
          operationId: "deleteOne",
          method: "POST",
          path: "/app/data-api/v1/action/deleteOne",
          status: "hand-authored",
        },
        {
          operationId: "deleteMany",
          method: "POST",
          path: "/app/data-api/v1/action/deleteMany",
          status: "hand-authored",
        },
        {
          operationId: "aggregate",
          method: "POST",
          path: "/app/data-api/v1/action/aggregate",
          status: "partial",
          summary: "Supports a subset of pipeline stages: $match, $limit, $skip, $sort, $project, $count.",
        },
      ],
    },
  ],
  seedSchema: {
    description: "Seed projects, clusters, database users, and databases with collections.",
    fields: [
      {
        key: "projects",
        title: "Projects",
        description: "Atlas projects (groups) addressable by name.",
        example: [{ name: "Project0", org_id: "default_org" }],
      },
      {
        key: "clusters",
        title: "Clusters",
        description: "Clusters attached to a project by name.",
        example: [
          { name: "Cluster0", project: "Project0", provider: "AWS", instance_size: "M10", region: "US_EAST_1" },
        ],
      },
      {
        key: "database_users",
        title: "Database users",
        description: "Database users scoped to a project.",
        example: [
          { username: "admin", project: "Project0", roles: [{ database_name: "admin", role_name: "atlasAdmin" }] },
        ],
      },
      {
        key: "databases",
        title: "Databases",
        description: "Databases on a cluster with their collections.",
        example: [{ cluster: "Cluster0", name: "test", collections: ["items"] }],
      },
    ],
    example: {
      projects: [{ name: "Project0" }],
      clusters: [{ name: "Cluster0", project: "Project0" }],
      database_users: [{ username: "admin", project: "Project0" }],
      databases: [{ cluster: "Cluster0", name: "test", collections: ["items"] }],
    },
  },
  stateModel: {
    description: "Entities mutated by Atlas Admin and Data API calls.",
    collections: [
      { name: "mongoatlas.projects" },
      { name: "mongoatlas.clusters" },
      { name: "mongoatlas.users" },
      { name: "mongoatlas.databases" },
      { name: "mongoatlas.collections" },
      { name: "mongoatlas.documents" },
    ],
  },
  connections: [
    {
      id: "atlas-admin-sdk",
      title: "Atlas Admin API client (TypeScript)",
      kind: "sdk",
      language: "typescript",
      description: "Use the Atlas Digest authentication client (atlas-api-client) pointed at the emulator base URL.",
      template:
        'import { AtlasClient } from "atlas-api-client";\n\nconst client = new AtlasClient({\n  baseUrl: "{{baseUrl}}/api/atlas/v2",\n  publicKey: "{{clientId}}",\n  privateKey: "{{clientSecret}}",\n});',
    },
    {
      id: "data-api-fetch",
      title: "Atlas Data API (fetch)",
      kind: "sdk",
      language: "typescript",
      description: "The Atlas Data API is a plain HTTPS surface; call it with fetch against the emulator base URL.",
      template:
        'const res = await fetch("{{baseUrl}}/app/data-api/v1/action/findOne", {\n  method: "POST",\n  headers: {\n    "content-type": "application/json",\n    apiKey: "{{token}}",\n  },\n  body: JSON.stringify({\n    dataSource: "Cluster0",\n    database: "test",\n    collection: "items",\n    filter: {},\n  }),\n});\nconst { document } = await res.json();',
    },
    {
      id: "atlas-env",
      title: "Atlas base URL (env)",
      kind: "env",
      language: "bash",
      description: "Point your Atlas client or scripts at the emulator instead of cloud.mongodb.com.",
      template: "MONGODB_ATLAS_BASE_URL={{baseUrl}}\nMONGODB_ATLAS_API_KEY={{token}}",
    },
    {
      id: "curl-admin",
      title: "curl (Admin API)",
      kind: "curl",
      language: "bash",
      description: "List projects via the Atlas Administration API.",
      template: 'curl -s {{baseUrl}}/api/atlas/v2/groups -H "authorization: Bearer {{token}}"',
    },
    {
      id: "curl-data-api",
      title: "curl (Data API)",
      kind: "curl",
      language: "bash",
      description: "Find a document via the Atlas Data API.",
      template:
        'curl -s -X POST {{baseUrl}}/app/data-api/v1/action/findOne \\\n  -H "content-type: application/json" \\\n  -H "apiKey: {{token}}" \\\n  -d \'{"dataSource":"Cluster0","database":"test","collection":"items","filter":{}}\'',
    },
  ],
};
