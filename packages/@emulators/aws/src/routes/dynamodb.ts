import type { Context, RouteContext } from "@emulators/core";
import { DYNAMODB_MODEL, DYNAMODB_OPERATION_NAMES, type DynamoDbOperationName } from "../dynamodb-model.js";
import { compact } from "../dynamodb/common.js";
import { DynamoDbLocalError } from "../dynamodb/errors.js";
import { createDynamoDbHandler } from "../dynamodb/handler.js";
import { jsonError, validateDynamoDbAuth, validateNestedRequiredFields } from "../dynamodb/protocol.js";

type JsonMap = Record<string, any>;

const HANDLERS = Object.fromEntries(DYNAMODB_OPERATION_NAMES.map((name) => [name, true])) as Record<
  DynamoDbOperationName,
  true
>;

export function dynamodbRoutes(ctx: RouteContext): void {
  const { app, store, baseUrl } = ctx;
  const handle = createDynamoDbHandler({ store, baseUrl });

  app.post("/", (c) => dispatch(c));
  app.post("/dynamodb/", (c) => dispatch(c));

  async function dispatch(c: Context) {
    const target = c.req.header("x-amz-target") ?? c.req.header("X-Amz-Target") ?? "";
    if (!target) return jsonError(c, "MissingAuthenticationToken", "Missing X-Amz-Target header.", 400);
    const authFailure = validateDynamoDbAuth(c);
    if (authFailure) return authFailure;

    const [prefix, operation] = target.split(".");
    if (prefix !== DYNAMODB_MODEL.targetPrefix || !operation) {
      return jsonError(c, "UnknownOperationException", `Unsupported DynamoDB target ${target}.`, 400);
    }
    if (!isOperationName(operation)) {
      return jsonError(c, "UnknownOperationException", `Unknown operation ${operation}.`, 400);
    }

    let input: JsonMap;
    try {
      const text = await c.req.text();
      input = text ? JSON.parse(text) : {};
    } catch {
      return jsonError(c, "SerializationException", "Could not parse request body into json.", 400);
    }

    for (const field of DYNAMODB_MODEL.operations[operation]) {
      if (input[field] === undefined || input[field] === null) {
        return jsonError(c, "ValidationException", `Missing required field ${field}.`, 400);
      }
    }

    try {
      validateNestedRequiredFields(operation, input);
      return c.json(handle(operation, input));
    } catch (error) {
      if (error instanceof DynamoDbLocalError) {
        const body = { __type: `com.amazonaws.dynamodb.v20120810#${error.code}`, message: error.message, Message: error.message };
        return c.json(compact({ ...body, Item: error.item, CancellationReasons: error.cancellationReasons }), error.status, { "x-amzn-errortype": error.code });
      }
      throw error;
    }
  }
}

export function dynamodbHandlersForTest(): Record<DynamoDbOperationName, true> {
  return HANDLERS;
}

function isOperationName(value: string): value is DynamoDbOperationName {
  return DYNAMODB_OPERATION_NAMES.includes(value as DynamoDbOperationName);
}
