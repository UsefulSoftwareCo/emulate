import type { DynamoDbItem, DynamoDbTable } from "../entities.js";
import { clone } from "./common.js";
import { validation } from "./errors.js";
import { attributeCompare, canonicalJson, getPath, projectItem, projectKey, resolveNames, setPath } from "./items.js";
import { withConsumedCapacity } from "./tables.js";
import type { JsonMap, QueryTarget } from "./types.js";

const HASH = "HASH";
const RANGE = "RANGE";
const ATTRIBUTE_PATH = String.raw`[A-Za-z0-9_.-]+`;
const VALUE_TOKEN = String.raw`:[A-Za-z0-9_]+`;
const LEGACY_RANGE_OPERATORS = new Set(["EQ", "LE", "LT", "GE", "GT", "BEGINS_WITH", "BETWEEN"]);

export function pageItems(
  table: DynamoDbTable,
  entries: Array<{ item: DynamoDbItem }>,
  input: JsonMap,
  filter?: (entry: { item: DynamoDbItem }) => boolean,
  target?: QueryTarget,
): JsonMap {
  const startKey = input.ExclusiveStartKey ? canonicalJson(input.ExclusiveStartKey) : undefined;
  const startIndex = startKey ? entries.findIndex((entry) => canonicalJson(projectKey(table, entry.item)) === startKey) + 1 : 0;
  const limit = input.Limit ?? entries.length;
  const evaluated = entries.slice(startIndex, startIndex + limit);
  const page = filter ? evaluated.filter(filter) : evaluated;
  const hasMore = startIndex + limit < entries.length;
  const items = page.map((entry) => projectIndexItem(table, entry.item, input, target));
  const result: JsonMap = { Count: page.length, ScannedCount: evaluated.length };
  if (input.Select === "COUNT") {
    if (hasMore && evaluated.length) result.LastEvaluatedKey = projectKey(table, evaluated.at(-1)!.item);
    return withConsumedCapacity(result, input, table, undefined, target?.index);
  }
  result.Items = items;
  if (hasMore && evaluated.length) result.LastEvaluatedKey = projectKey(table, evaluated.at(-1)!.item);
  return withConsumedCapacity(result, input, table, undefined, target?.index);
}

export function queryTarget(table: DynamoDbTable, indexName?: string): QueryTarget {
  if (!indexName) return { keySchema: table.key_schema };
  const local = table.local_secondary_indexes.find((candidate) => candidate.IndexName === indexName);
  if (local) return { keySchema: local.KeySchema as JsonMap[], index: local, indexType: "local" };
  const global = table.global_secondary_indexes.find((candidate) => candidate.IndexName === indexName);
  if (global) return { keySchema: global.KeySchema as JsonMap[], index: global, indexType: "global" };
  throw validation(`The table does not have the specified index: ${indexName}`);
}

export function validateQueryInput(input: JsonMap, target: QueryTarget): void {
  if (!input.KeyConditionExpression && !input.KeyConditions) throw validation("Either KeyConditions or KeyConditionExpression must be specified.");
  if (input.ConsistentRead && target.indexType === "global") throw validation("Consistent reads are not supported on global secondary indexes.");
  const keySchema = target.keySchema;
  const hashName = keySchema.find((schema) => schema.KeyType === HASH)?.AttributeName;
  const rangeName = keySchema.find((schema) => schema.KeyType === RANGE)?.AttributeName;
  if (!hashName) throw validation("Query condition missed key schema element.");
  if (input.KeyConditionExpression) validateKeyConditionExpression(input, hashName, rangeName);
  if (input.KeyConditions) validateLegacyKeyConditions(input.KeyConditions, hashName, rangeName);
}

function validateKeyConditionExpression(input: JsonMap, hashName: string, rangeName?: string): void {
  const expression = resolveNames(input.KeyConditionExpression, input.ExpressionAttributeNames);
  let hasHash = false;
  let hasRange = false;
  for (const clause of splitKeyConditionClauses(expression)) {
    const parsed = parseKeyConditionClause(clause);
    if (!parsed) throw validation("Invalid operator used in KeyConditionExpression.");
    if (parsed.attribute !== hashName && parsed.attribute !== rangeName) throw validation("Query key condition not supported.");
    if (parsed.attribute === hashName) {
      if (parsed.operator !== "=" || hasHash) throw validation("Query key condition not supported.");
      hasHash = true;
    } else {
      if (!rangeName || hasRange) throw validation("Query key condition not supported.");
      hasRange = true;
    }
  }
  if (!hasHash) throw validation("Query condition missed key schema element.");
}

function parseKeyConditionClause(clause: string): { attribute: string; operator: string } | undefined {
  const beginsWith = clause.match(new RegExp(String.raw`^begins_with\s*\(\s*(${ATTRIBUTE_PATH})\s*,\s*${VALUE_TOKEN}\s*\)$`, "i"));
  if (beginsWith) return { attribute: beginsWith[1], operator: "begins_with" };

  const between = clause.match(new RegExp(String.raw`^(${ATTRIBUTE_PATH})\s+BETWEEN\s+${VALUE_TOKEN}\s+AND\s+${VALUE_TOKEN}$`, "i"));
  if (between) return { attribute: between[1], operator: "BETWEEN" };

  const comparison = clause.match(new RegExp(String.raw`^(${ATTRIBUTE_PATH})\s*(<>|<=|>=|=|<|>)\s*${VALUE_TOKEN}$`, "i"));
  if (!comparison || comparison[2] === "<>") return undefined;
  return { attribute: comparison[1], operator: comparison[2] };
}

function splitKeyConditionClauses(expression: string): string[] {
  const clauses: string[] = [];
  let start = 0;
  const andWord = /\bAND\b/gi;
  let match: RegExpExecArray | null;
  while ((match = andWord.exec(expression))) {
    if (depthAt(expression, match.index) !== 0) continue;
    const current = expression.slice(start, match.index).trim();
    if (/\bBETWEEN\b/i.test(current) && !/\bBETWEEN\b.+\bAND\b/i.test(current)) continue;
    clauses.push(current);
    start = match.index + match[0].length;
  }
  clauses.push(expression.slice(start).trim());
  return clauses.filter(Boolean);
}

function depthAt(value: string, index: number): number {
  let depth = 0;
  for (let i = 0; i < index; i++) {
    const char = value[i];
    if (char === "(" || char === "[") depth++;
    if (char === ")" || char === "]") depth--;
  }
  return depth;
}

function validateLegacyKeyConditions(conditions: JsonMap, hashName: string, rangeName?: string): void {
  const hash = conditions[hashName];
  if (!hash || hash.ComparisonOperator !== "EQ") throw validation("Query condition missed key schema element.");
  for (const [name, condition] of Object.entries<JsonMap>(conditions)) {
    if (name !== hashName && name !== rangeName) throw validation("Query key condition not supported.");
    const operator = condition.ComparisonOperator;
    if (name === hashName && operator !== "EQ") throw validation("Query key condition not supported.");
    if (name === rangeName && !LEGACY_RANGE_OPERATORS.has(operator)) throw validation("Query key condition not supported.");
    validateLegacyKeyConditionValueCount(operator, condition.AttributeValueList ?? []);
  }
}

function validateLegacyKeyConditionValueCount(operator: string, values: unknown[]): void {
  const expected = operator === "BETWEEN" ? 2 : 1;
  if (values.length !== expected) throw validation("Query key condition not supported.");
}

export function indexContainsItem(target: QueryTarget, item: DynamoDbItem): boolean {
  return target.keySchema.every((schema) => item[schema.AttributeName] !== undefined);
}

export function projectIndexItem(table: DynamoDbTable, item: DynamoDbItem, input: JsonMap, target?: QueryTarget): DynamoDbItem {
  if (!target?.index || input.ProjectionExpression || input.AttributesToGet) return projectItem(item, input);
  const projection = target.index.Projection ?? {};
  if (projection.ProjectionType === "ALL") return clone(item);
  const projectedNames = new Set<string>();
  for (const schema of table.key_schema) projectedNames.add(schema.AttributeName);
  for (const schema of target.keySchema) projectedNames.add(schema.AttributeName);
  if (projection.ProjectionType === "INCLUDE") {
    for (const name of projection.NonKeyAttributes ?? []) projectedNames.add(name);
  }
  const projected: DynamoDbItem = {};
  for (const name of projectedNames) {
    const value = getPath(item, name);
    if (value !== undefined) setPath(projected, name, value);
  }
  return projected;
}

export function compareByKeySchema(schema: JsonMap[], left: DynamoDbItem, right: DynamoDbItem): number {
  for (const key of schema) {
    const comparison = attributeCompare(left[key.AttributeName], right[key.AttributeName]);
    if (comparison !== 0) return comparison;
  }
  return 0;
}
