import type { DynamoDbAttributeValue, DynamoDbItem, DynamoDbTable } from "../entities.js";
import { clone } from "./common.js";
import { DynamoDbLocalError, validation } from "./errors.js";
import type { ExpressionValues, JsonMap } from "./types.js";

export function itemKey(table: DynamoDbTable, item: DynamoDbItem): DynamoDbItem {
  validateItemKeyAttributes(table, item);
  const key: DynamoDbItem = {};
  for (const schema of table.key_schema) {
    const name = schema.AttributeName;
    if (!item[name]) throw new DynamoDbLocalError("ValidationException", "The provided key element does not match the schema");
    key[name] = item[name];
  }
  return key;
}

export function validateItem(table: DynamoDbTable, item: DynamoDbItem): void {
  validateItemKeyAttributes(table, item);
}

export function validateKey(table: DynamoDbTable, key: DynamoDbItem): void {
  if (!key || typeof key !== "object") throw validation("The provided key element does not match the schema");
  const schemaNames = new Set(table.key_schema.map((schema) => schema.AttributeName));
  const keyNames = Object.keys(key);
  if (keyNames.length !== schemaNames.size || keyNames.some((name) => !schemaNames.has(name))) {
    throw validation("The provided key element does not match the schema");
  }
  validateItemKeyAttributes(table, key);
}

export function validateItemKeyAttributes(table: DynamoDbTable, item: DynamoDbItem): void {
  if (!item || typeof item !== "object") throw validation("The provided key element does not match the schema");
  const attributes = new Map(table.attribute_definitions.map((attribute) => [attribute.AttributeName, attribute.AttributeType]));
  for (const schema of table.key_schema) {
    const value = item[schema.AttributeName];
    if (!value) throw validation("The provided key element does not match the schema");
    const expectedType = attributes.get(schema.AttributeName);
    if (expectedType && value[expectedType as string] === undefined) throw validation("The provided key element does not match the schema");
  }
}

export function validatePrimaryKeyUnchanged(table: DynamoDbTable, originalKey: DynamoDbItem, item: DynamoDbItem): void {
  const nextKey = itemKey(table, item);
  if (canonicalJson(originalKey) !== canonicalJson(nextKey)) throw validation("One or more parameter values were invalid: Cannot update attribute used in the key schema");
}

export function storageKey(table: DynamoDbTable, key: DynamoDbItem): string {
  return `${table.table_name}:${canonicalJson(key)}`;
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as JsonMap)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as JsonMap)[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function validateReturnValues(operation: "PutItem" | "UpdateItem" | "DeleteItem", mode: string | undefined): void {
  if (!mode || mode === "NONE") return;
  const allowed: Record<typeof operation, string[]> = {
    PutItem: ["ALL_OLD"],
    UpdateItem: ["ALL_OLD", "ALL_NEW", "UPDATED_OLD", "UPDATED_NEW"],
    DeleteItem: ["ALL_OLD"],
  };
  if (!allowed[operation].includes(mode)) throw validation(`Invalid ReturnValues value ${mode} for ${operation}.`);
}

export function returnValues(
  mode: string | undefined,
  updatedNewAttributes: DynamoDbItem | undefined,
  updatedOldAttributes?: DynamoDbItem,
  oldItem?: DynamoDbItem,
  newItem?: DynamoDbItem,
): JsonMap {
  switch (mode ?? "NONE") {
    case "ALL_OLD":
      return oldItem ? { Attributes: oldItem } : {};
    case "ALL_NEW":
      return newItem ? { Attributes: newItem } : {};
    case "UPDATED_OLD":
      return updatedOldAttributes ? { Attributes: updatedOldAttributes } : {};
    case "UPDATED_NEW":
      return updatedNewAttributes ? { Attributes: updatedNewAttributes } : {};
    case "NONE":
      return {};
    default:
      throw validation(`Invalid ReturnValues value ${mode}.`);
  }
}

export function projectKey(table: DynamoDbTable, item: DynamoDbItem): DynamoDbItem {
  const key: DynamoDbItem = {};
  for (const schema of table.key_schema) key[schema.AttributeName] = item[schema.AttributeName];
  return key;
}

export function projectItem(item: DynamoDbItem, input: JsonMap): DynamoDbItem {
  const expression = input.ProjectionExpression;
  const attributes = input.AttributesToGet;
  if (!expression && !attributes) return clone(item);
  const names = expression ? splitTopLevel(expression, ",").map((path) => resolvePathNames(path.trim(), input.ExpressionAttributeNames)) : attributes;
  const projected: DynamoDbItem = {};
  for (const name of names) {
    const value = getPath(item, name);
    if (value !== undefined) setPath(projected, name, value);
  }
  return projected;
}

export function conditionMatches(expression: string | undefined, item: DynamoDbItem | undefined, input: JsonMap): boolean {
  if (!expression) return true;
  return evaluateExpression(resolveNames(expression, input.ExpressionAttributeNames), item ?? {}, input.ExpressionAttributeValues ?? {});
}

export function legacyConditionsMatch(expected: JsonMap | undefined, item: DynamoDbItem | undefined, operator = "AND"): boolean {
  if (!expected) return true;
  const checks = Object.entries<JsonMap>(expected).map(([name, condition]) => legacyCondition(name, condition, item));
  return operator === "OR" ? checks.some(Boolean) : checks.every(Boolean);
}

export function legacyQueryConditionsMatch(expected: JsonMap | undefined, item: DynamoDbItem, operator = "AND"): boolean {
  if (!expected) return true;
  const checks = Object.entries<JsonMap>(expected).map(([name, condition]) => {
    const values = condition.AttributeValueList ?? [];
    const comparison = condition.ComparisonOperator ?? "EQ";
    return compareCondition(getPath(item, name), comparison, values);
  });
  return operator === "OR" ? checks.some(Boolean) : checks.every(Boolean);
}

export function legacyCondition(name: string, condition: JsonMap, item: DynamoDbItem | undefined): boolean {
  const actual = getPath(item ?? {}, name);
  if (condition.Exists === false) return actual === undefined;
  if (condition.Exists === true && actual === undefined) return false;
  if (condition.Value !== undefined) return attributeCompare(actual, condition.Value) === 0;
  if (condition.AttributeValueList) return compareCondition(actual, condition.ComparisonOperator ?? "EQ", condition.AttributeValueList);
  return true;
}

export function evaluateExpression(expression: string, item: DynamoDbItem, values: ExpressionValues): boolean {
  const trimmed = stripOuter(expression.trim());
  for (const op of ["OR", "AND"]) {
    const parts = splitTopLevelWord(trimmed, op);
    if (parts.length > 1) return op === "OR" ? parts.some((part) => evaluateExpression(part, item, values)) : parts.every((part) => evaluateExpression(part, item, values));
  }
  if (/^NOT\s+/i.test(trimmed)) return !evaluateExpression(trimmed.replace(/^NOT\s+/i, ""), item, values);

  const fn = trimmed.match(/^(attribute_exists|attribute_not_exists|begins_with|contains|size)\s*\((.*)\)$/i);
  if (fn) {
    const name = fn[1].toLowerCase();
    const args = splitTopLevel(fn[2], ",").map((arg) => arg.trim());
    if (name === "attribute_exists") return getPath(item, args[0]) !== undefined;
    if (name === "attribute_not_exists") return getPath(item, args[0]) === undefined;
    if (name === "begins_with") return String(attributeScalar(getPath(item, args[0])) ?? "").startsWith(String(attributeScalar(resolveOperand(args[1], item, values)) ?? ""));
    if (name === "contains") {
      const actual = getPath(item, args[0]);
      const expected = attributeScalar(resolveOperand(args[1], item, values));
      if (actual?.SS) return (actual.SS as unknown[]).includes(expected);
      if (actual?.NS) return (actual.NS as unknown[]).includes(String(expected));
      if (actual?.L) return (actual.L as unknown[]).some((v) => attributeCompare(v as DynamoDbAttributeValue, resolveOperand(args[1], item, values)) === 0);
      return String(attributeScalar(actual) ?? "").includes(String(expected ?? ""));
    }
    if (name === "size") return Number(attributeSize(getPath(item, args[0]))) > 0;
  }

  const between = trimmed.match(/^(.+?)\s+BETWEEN\s+(.+?)\s+AND\s+(.+)$/i);
  if (between) {
    const actual = resolveOperand(between[1], item, values);
    return attributeCompare(actual, resolveOperand(between[2], item, values)) >= 0 && attributeCompare(actual, resolveOperand(between[3], item, values)) <= 0;
  }

  const inMatch = trimmed.match(/^(.+?)\s+IN\s*\((.+)\)$/i);
  if (inMatch) {
    const actual = resolveOperand(inMatch[1], item, values);
    return splitTopLevel(inMatch[2], ",").some((candidate) => attributeCompare(actual, resolveOperand(candidate.trim(), item, values)) === 0);
  }

  const comparison = trimmed.match(/^(.+?)\s*(<>|<=|>=|=|<|>)\s*(.+)$/);
  if (comparison) {
    const cmp = attributeCompare(resolveOperand(comparison[1], item, values), resolveOperand(comparison[3], item, values));
    switch (comparison[2]) {
      case "=":
        return cmp === 0;
      case "<>":
        return cmp !== 0;
      case "<":
        return cmp < 0;
      case "<=":
        return cmp <= 0;
      case ">":
        return cmp > 0;
      case ">=":
        return cmp >= 0;
    }
  }

  throw validation(`Unsupported expression syntax: ${expression}`);
}

export function compareCondition(actual: DynamoDbAttributeValue | undefined, operator: string, values: DynamoDbAttributeValue[]): boolean {
  switch (operator) {
    case "EQ":
      return attributeCompare(actual, values[0]) === 0;
    case "NE":
      return attributeCompare(actual, values[0]) !== 0;
    case "LE":
      return attributeCompare(actual, values[0]) <= 0;
    case "LT":
      return attributeCompare(actual, values[0]) < 0;
    case "GE":
      return attributeCompare(actual, values[0]) >= 0;
    case "GT":
      return attributeCompare(actual, values[0]) > 0;
    case "BETWEEN":
      return attributeCompare(actual, values[0]) >= 0 && attributeCompare(actual, values[1]) <= 0;
    case "BEGINS_WITH":
      return String(attributeScalar(actual) ?? "").startsWith(String(attributeScalar(values[0]) ?? ""));
    case "NULL":
      return actual === undefined;
    case "NOT_NULL":
      return actual !== undefined;
    case "CONTAINS":
      return evaluateExpression(`contains(a, :v)`, { a: actual as DynamoDbAttributeValue }, { ":v": values[0] });
    case "NOT_CONTAINS":
      return !evaluateExpression(`contains(a, :v)`, { a: actual as DynamoDbAttributeValue }, { ":v": values[0] });
    default:
      throw validation(`Unsupported comparison operator ${operator}.`);
  }
}

export function resolveOperand(token: string, item: DynamoDbItem, values: ExpressionValues): DynamoDbAttributeValue | undefined {
  const trimmed = token.trim();
  if (trimmed.startsWith(":")) return values[trimmed];
  const size = trimmed.match(/^size\s*\((.+)\)$/i);
  if (size) return { N: String(attributeSize(getPath(item, size[1].trim()))) };
  return getPath(item, trimmed);
}

export function applyUpdateExpression(item: DynamoDbItem, expression: string, input: JsonMap): void {
  const names = input.ExpressionAttributeNames;
  const values = input.ExpressionAttributeValues ?? {};
  const clauses = expressionClauses(resolveNames(expression, names));
  for (const assignment of clauses.SET ?? []) {
    const [rawPath, rawValue] = splitAssignment(assignment);
    const current = getPath(item, rawPath);
    const value = evaluateUpdateValue(rawValue, item, values, current);
    setPath(item, rawPath, value);
  }
  for (const path of clauses.REMOVE ?? []) deletePath(item, path.trim());
  for (const assignment of clauses.ADD ?? []) {
    const [path, valueToken] = splitFirstWhitespace(assignment);
    const current = getPath(item, path);
    const value = requireResolvedOperand(valueToken, item, values);
    if (value.N !== undefined) {
      if (current && current.N === undefined) throw validation("Invalid update expression operand type.");
      setPath(item, path, { N: String(Number(current?.N ?? 0) + Number(value.N)) });
    } else if (value.SS !== undefined) {
      if (current && current.SS === undefined) throw validation("Invalid update expression operand type.");
      setPath(item, path, { SS: [...new Set([...stringArray(current?.SS), ...stringArray(value.SS)])] });
    } else if (value.NS !== undefined) {
      if (current && current.NS === undefined) throw validation("Invalid update expression operand type.");
      setPath(item, path, { NS: [...new Set([...stringArray(current?.NS), ...stringArray(value.NS)])] });
    } else if (value.BS !== undefined) {
      if (current && current.BS === undefined) throw validation("Invalid update expression operand type.");
      setPath(item, path, { BS: [...stringArray(current?.BS), ...stringArray(value.BS)] });
    } else throw validation("Invalid update expression operand type.");
  }
  for (const assignment of clauses.DELETE ?? []) {
    const [path, valueToken] = splitFirstWhitespace(assignment);
    const current = getPath(item, path);
    const value = requireResolvedOperand(valueToken, item, values);
    if (value.SS === undefined && value.NS === undefined && value.BS === undefined) {
      throw validation("Invalid update expression operand type.");
    }
    if (current?.SS && value.SS) setPath(item, path, { SS: stringArray(current.SS).filter((v) => !stringArray(value.SS).includes(v)) });
    if (current?.NS && value.NS) setPath(item, path, { NS: stringArray(current.NS).filter((v) => !stringArray(value.NS).includes(v)) });
    if (current?.BS && value.BS) setPath(item, path, { BS: stringArray(current.BS).filter((v) => !stringArray(value.BS).includes(v)) });
  }
}

export function evaluateUpdateValue(raw: string, item: DynamoDbItem, values: ExpressionValues, current: DynamoDbAttributeValue | undefined): DynamoDbAttributeValue {
  const value = raw.trim();
  const ifNotExists = value.match(/^if_not_exists\s*\((.+),(.+)\)$/i);
  if (ifNotExists) return current ?? requireResolvedOperand(ifNotExists[2].trim(), item, values);
  const listAppend = value.match(/^list_append\s*\((.+),(.+)\)$/i);
  if (listAppend) {
    const leftValue = requireResolvedOperand(listAppend[1].trim(), item, values);
    const rightValue = requireResolvedOperand(listAppend[2].trim(), item, values);
    if (!leftValue.L || !rightValue.L) throw validation("Invalid update expression operand type.");
    const left = attributeList(leftValue.L);
    const right = attributeList(rightValue.L);
    return { L: [...left, ...right] };
  }
  const arithmetic = value.match(/^(.+?)\s*([+-])\s*(.+)$/);
  if (arithmetic) {
    const leftOperand = requireResolvedOperand(arithmetic[1], item, values);
    const rightOperand = requireResolvedOperand(arithmetic[3], item, values);
    if (leftOperand.N === undefined || rightOperand.N === undefined) {
      throw validation("Invalid update expression operand type.");
    }
    const left = Number(leftOperand.N);
    const right = Number(rightOperand.N);
    return { N: String(arithmetic[2] === "+" ? left + right : left - right) };
  }
  return requireResolvedOperand(value, item, values);
}

function requireResolvedOperand(token: string, item: DynamoDbItem, values: ExpressionValues): DynamoDbAttributeValue {
  const value = resolveOperand(token, item, values);
  if (value === undefined) throw validation(`Expression attribute value ${token.trim()} was not provided.`);
  return value;
}

export function applyLegacyAttributeUpdates(item: DynamoDbItem, updates: JsonMap): void {
  for (const [name, update] of Object.entries<JsonMap>(updates)) {
    const action = update.Action ?? "PUT";
    if (action === "DELETE") deletePath(item, name);
    if (action === "PUT") setPath(item, name, update.Value);
    if (action === "ADD") {
      const current = getPath(item, name);
      if (current?.N || update.Value?.N) setPath(item, name, { N: String(Number(current?.N ?? 0) + Number(update.Value.N ?? 0)) });
      else setPath(item, name, update.Value);
    }
  }
}

export function expressionClauses(expression: string): Record<string, string[]> {
  const matches = [...expression.matchAll(/\b(SET|REMOVE|ADD|DELETE)\b/g)];
  const clauses: Record<string, string[]> = {};
  for (let i = 0; i < matches.length; i++) {
    const action = matches[i][1];
    const start = matches[i].index! + action.length;
    const end = matches[i + 1]?.index ?? expression.length;
    clauses[action] = splitTopLevel(expression.slice(start, end).trim(), ",").filter(Boolean);
  }
  return clauses;
}

export function splitAssignment(value: string): [string, string] {
  const parts = splitTopLevel(value, "=");
  if (parts.length < 2) throw validation("Invalid update expression.");
  return [parts[0].trim(), parts.slice(1).join("=").trim()];
}

export function splitFirstWhitespace(value: string): [string, string] {
  const match = value.trim().match(/^(\S+)\s+(.+)$/);
  if (!match) throw validation("Invalid update expression.");
  return [match[1], match[2]];
}

export function getPath(item: DynamoDbItem, rawPath: string): DynamoDbAttributeValue | undefined {
  const parts = pathParts(rawPath);
  let current: any = item;
  for (const part of parts) {
    if (current === undefined) return undefined;
    if (typeof part === "number") current = current?.L?.[part] ?? current?.[part];
    else current = current?.M?.[part] ?? current?.[part];
  }
  return current;
}

export function setPath(item: DynamoDbItem, rawPath: string, value: DynamoDbAttributeValue): void {
  const parts = pathParts(rawPath);
  let current: any = item;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    const next = parts[i + 1];
    if (typeof part === "number") {
      current.L ??= [];
      current.L[part] ??= typeof next === "number" ? { L: [] } : { M: {} };
      current = current.L[part];
    } else {
      current[part] ??= typeof next === "number" ? { L: [] } : { M: {} };
      current = current[part].M ?? current[part];
    }
  }
  const last = parts.at(-1)!;
  if (typeof last === "number") {
    current.L ??= [];
    current.L[last] = value;
  } else current[last] = value;
}

export function deletePath(item: DynamoDbItem, rawPath: string): void {
  const parts = pathParts(rawPath);
  let current: any = item;
  for (let i = 0; i < parts.length - 1; i++) current = typeof parts[i] === "number" ? current?.L?.[parts[i] as number] : current?.[parts[i] as string]?.M ?? current?.[parts[i] as string];
  const last = parts.at(-1)!;
  if (typeof last === "number") current?.L?.splice(last, 1);
  else delete current?.[last];
}

export function pathParts(path: string): Array<string | number> {
  return path
    .replace(/\[(\d+)\]/g, ".$1")
    .split(".")
    .filter(Boolean)
    .map((part) => (/^\d+$/.test(part) ? Number(part) : part));
}

export function resolveNames(expression: string, names?: Record<string, string>): string {
  if (!names) return expression;
  return expression.replace(/#[A-Za-z0-9_]+/g, (token) => names[token] ?? token);
}

export function resolvePathNames(path: string, names?: Record<string, string>): string {
  if (!names) return path;
  return path.replace(/#[A-Za-z0-9_]+/g, (token) => names[token] ?? token);
}

export function splitTopLevel(value: string, delimiter: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    if (char === "(" || char === "[") depth++;
    if (char === ")" || char === "]") depth--;
    if (depth === 0 && value.slice(i, i + delimiter.length) === delimiter) {
      parts.push(value.slice(start, i).trim());
      start = i + delimiter.length;
      i += delimiter.length - 1;
    }
  }
  parts.push(value.slice(start).trim());
  return parts.filter((part) => part.length > 0);
}

export function splitTopLevelWord(value: string, word: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  const regex = new RegExp(`\\b${word}\\b`, "gi");
  let match: RegExpExecArray | null;
  while ((match = regex.exec(value))) {
    depth = depthAt(value, match.index);
    if (depth === 0) {
      parts.push(value.slice(start, match.index).trim());
      start = match.index + word.length;
    }
  }
  if (parts.length) parts.push(value.slice(start).trim());
  return parts.filter(Boolean);
}

export function depthAt(value: string, index: number): number {
  let depth = 0;
  for (let i = 0; i < index; i++) {
    if (value[i] === "(" || value[i] === "[") depth++;
    if (value[i] === ")" || value[i] === "]") depth--;
  }
  return depth;
}

export function stripOuter(value: string): string {
  if (!value.startsWith("(") || !value.endsWith(")")) return value;
  let depth = 0;
  for (let i = 0; i < value.length; i++) {
    if (value[i] === "(") depth++;
    if (value[i] === ")") depth--;
    if (depth === 0 && i < value.length - 1) return value;
  }
  return stripOuter(value.slice(1, -1).trim());
}

export function attributeCompare(left: DynamoDbAttributeValue | undefined, right: DynamoDbAttributeValue | undefined): number {
  if (left === undefined && right === undefined) return 0;
  if (left === undefined) return -1;
  if (right === undefined) return 1;
  const l = attributeScalar(left);
  const r = attributeScalar(right);
  if (typeof l === "number" && typeof r === "number") return l === r ? 0 : l < r ? -1 : 1;
  const ls = canonicalJson(left);
  const rs = canonicalJson(right);
  return ls === rs ? 0 : ls < rs ? -1 : 1;
}

export function attributeScalar(value: DynamoDbAttributeValue | undefined): unknown {
  if (!value) return undefined;
  if (value.S !== undefined) return value.S;
  if (value.N !== undefined) return Number(value.N);
  if (value.BOOL !== undefined) return value.BOOL;
  if (value.NULL !== undefined) return null;
  if (value.SS !== undefined) return value.SS;
  if (value.NS !== undefined) return value.NS;
  return value;
}

export function attributeSize(value: DynamoDbAttributeValue | undefined): number {
  if (!value) return 0;
  const scalar = attributeScalar(value);
  if (typeof scalar === "string" || Array.isArray(scalar)) return scalar.length;
  if (value.M) return Object.keys(value.M as JsonMap).length;
  if (value.L) return (value.L as unknown[]).length;
  return 0;
}

export function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

export function attributeList(value: unknown): DynamoDbAttributeValue[] {
  return Array.isArray(value) ? (value as DynamoDbAttributeValue[]) : [];
}

export function nativeToAttributeValue(value: unknown): DynamoDbAttributeValue {
  if (value === null) return { NULL: true };
  if (typeof value === "string") return { S: value };
  if (typeof value === "number") return { N: String(value) };
  if (typeof value === "boolean") return { BOOL: value };
  if (Array.isArray(value)) return { L: value.map(nativeToAttributeValue) };
  if (typeof value === "object") return { M: Object.fromEntries(Object.entries(value as JsonMap).map(([key, val]) => [key, nativeToAttributeValue(val)])) };
  throw validation("Unsupported PartiQL value.");
}

export function changedAttributes(oldItem: DynamoDbItem, newItem: DynamoDbItem): DynamoDbItem {
  const changed: DynamoDbItem = {};
  for (const [name, value] of Object.entries(newItem)) {
    if (canonicalJson(oldItem[name]) !== canonicalJson(value)) changed[name] = value;
  }
  return changed;
}
