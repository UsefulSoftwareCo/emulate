import type { RouteContext } from "@emulators/core";

import { operations } from "../manifest.js";

export function openapiRoutes({ app, baseUrl }: RouteContext): void {
  app.get("/openapi.json", (c) => c.json(buildSpec(baseUrl)));
}

function buildSpec(baseUrl: string): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const operation of operations) {
    if (!operation.path || !operation.method) continue;
    const method = operation.method.toLowerCase();
    const success =
      operation.operationId === "subscriptions:revoke"
        ? "200"
        : method === "post"
          ? operation.operationId.endsWith(":create")
            ? "201"
            : "200"
          : method === "delete"
            ? "204"
            : "200";
    paths[operation.path] ??= {};
    paths[operation.path]![method] = {
      operationId: operation.operationId,
      summary: operation.operationId.replaceAll(":", " "),
      responses: {
        [success]: { description: "Successful response" },
        "401": { description: "Unauthorized" },
        "404": { description: "Resource not found" },
        "422": { description: "Request validation error" },
      },
    };
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "Polar API (Emulated)",
      version: "0.49.0",
      description: "Hand-authored Polar subscription and usage billing subset implemented by the Polar emulator.",
    },
    servers: [{ url: baseUrl }],
    security: [{ bearerAuth: [] }],
    components: {
      securitySchemes: { bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "polar_oat_..." } },
      schemas: {
        ResourceNotFound: {
          type: "object",
          required: ["error", "detail"],
          properties: { error: { const: "ResourceNotFound" }, detail: { type: "string" } },
        },
        RequestValidationError: {
          type: "object",
          required: ["error", "detail"],
          properties: { error: { const: "RequestValidationError" }, detail: { type: "array" } },
        },
      },
    },
    paths,
  };
}
