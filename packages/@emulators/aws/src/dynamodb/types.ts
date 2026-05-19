import type { DynamoDbAttributeValue } from "../entities.js";

export type JsonMap = Record<string, any>;
export type ExpressionValues = Record<string, DynamoDbAttributeValue>;
export type QueryTarget = { keySchema: JsonMap[]; index?: JsonMap; indexType?: "local" | "global" };
export type RequestValidator = (input: JsonMap) => void;
