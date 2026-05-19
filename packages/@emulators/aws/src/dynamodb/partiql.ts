import type { DynamoDbAttributeValue, DynamoDbItem, DynamoDbTable } from "../entities.js";
import { DynamoDbLocalError, validation } from "./errors.js";
import { evaluateExpression, splitAssignment, splitTopLevel, splitTopLevelWord } from "./items.js";
import type { JsonMap } from "./types.js";

export type PartiQlValue = { kind: "parameter"; index: number } | { kind: "literal"; value: unknown };
export type ParsedPartiQlStatement =
  | { kind: "select"; tableName: string; where?: PartiQlExpression; limit?: number }
  | { kind: "insert"; tableName: string; value: PartiQlValue }
  | {
      kind: "update";
      tableName: string;
      assignments: Array<{ path: string; value: PartiQlValue }>;
      where: PartiQlExpression;
    }
  | { kind: "delete"; tableName: string; where: PartiQlExpression };

export interface PartiQlExpression {
  text: string;
  parameterIndexes: number[];
}

export function partiqlWhereMatches(
  where: PartiQlExpression | undefined,
  item: DynamoDbItem,
  parameters: DynamoDbAttributeValue[],
): boolean {
  if (!where) return true;
  const values = Object.fromEntries(
    where.parameterIndexes.map((parameterIndex, i) => [`:p${i}`, parameters[parameterIndex]]),
  );
  return evaluateExpression(where.text, item, values);
}

export function validatePartiQlPrimaryKeyPredicate(table: DynamoDbTable, where: PartiQlExpression | undefined): void {
  if (!where) throw validation("PartiQL update and delete statements require primary key predicates.");
  for (const schema of table.key_schema) {
    if (!predicateEqualsAttribute(where.text, schema.AttributeName))
      throw validation("PartiQL update and delete statements require primary key predicates.");
  }
}

export function partiQlStatementKind(statement: string): "read" | "write" {
  if (parsePartiQlStatement(statement).kind === "select") return "read";
  return "write";
}

export function wrapPartiQl(fn: () => JsonMap): JsonMap {
  try {
    return fn();
  } catch (error) {
    if (error instanceof DynamoDbLocalError) return { Error: { Code: error.code, Message: error.message } };
    throw error;
  }
}

export function parsePartiQlStatement(statement: string): ParsedPartiQlStatement {
  const source = stripStatementTerminator(String(statement ?? "").trim());
  if (!source) throw validation("Unsupported PartiQL statement.");
  if (startsWithKeyword(source, 0, "SELECT")) return parseSelect(source);
  if (startsWithKeyword(source, 0, "INSERT")) return parseInsert(source);
  if (startsWithKeyword(source, 0, "UPDATE")) return parseUpdate(source);
  if (startsWithKeyword(source, 0, "DELETE")) return parseDelete(source);
  throw validation("Unsupported PartiQL statement.");
}

function parseSelect(source: string): ParsedPartiQlStatement {
  const fromIndex = findTopLevelKeyword(source, "FROM", "SELECT".length);
  if (fromIndex < 0) throw validation("Unsupported PartiQL SELECT statement.");
  if (!source.slice("SELECT".length, fromIndex).trim()) throw validation("Unsupported PartiQL SELECT statement.");
  const afterFrom = readIdentifier(source, fromIndex + "FROM".length);
  const restStart = skipWhitespace(source, afterFrom.end);
  const rest = source.slice(restStart).trim();
  const whereIndex = findTopLevelKeyword(rest, "WHERE");
  const limitIndex = findTopLevelKeyword(rest, "LIMIT");
  if (rest && whereIndex !== 0 && limitIndex !== 0) throw validation("Unsupported PartiQL SELECT statement.");

  const where =
    whereIndex >= 0
      ? parameterizeExpression(
          source.slice(
            restStart + whereIndex + "WHERE".length,
            limitIndex > whereIndex ? restStart + limitIndex : source.length,
          ),
          countParameters(source.slice(0, restStart + whereIndex)),
        )
      : undefined;
  const limit = limitIndex >= 0 ? parseLimit(rest.slice(limitIndex + "LIMIT".length)) : undefined;
  return { kind: "select", tableName: afterFrom.identifier, where, limit };
}

function parseInsert(source: string): ParsedPartiQlStatement {
  const intoIndex = findTopLevelKeyword(source, "INTO", "INSERT".length);
  if (intoIndex < 0) throw validation("Unsupported PartiQL INSERT statement.");
  const table = readIdentifier(source, intoIndex + "INTO".length);
  const valueIndex = findTopLevelKeyword(source, "VALUE", table.end);
  if (valueIndex < 0 || source.slice(table.end, valueIndex).trim())
    throw validation("Unsupported PartiQL INSERT statement.");
  const rawValue = source.slice(valueIndex + "VALUE".length).trim();
  if (!rawValue) throw validation("Unsupported PartiQL INSERT statement.");
  return {
    kind: "insert",
    tableName: table.identifier,
    value: parseValue(rawValue, countParameters(source.slice(0, valueIndex))),
  };
}

function parseUpdate(source: string): ParsedPartiQlStatement {
  const table = readIdentifier(source, "UPDATE".length);
  const setIndex = findTopLevelKeyword(source, "SET", table.end);
  const whereIndex = findTopLevelKeyword(source, "WHERE", table.end);
  if (setIndex < 0 || whereIndex < 0 || whereIndex < setIndex || source.slice(table.end, setIndex).trim()) {
    throw validation("Unsupported PartiQL UPDATE statement.");
  }
  const setText = source.slice(setIndex + "SET".length, whereIndex).trim();
  let parameterOffset = countParameters(source.slice(0, setIndex + "SET".length));
  const assignments = splitTopLevel(setText, ",").map((assignment) => {
    const [rawPath, rawValue] = splitAssignment(assignment);
    const parsed = { path: normalizeIdentifierPath(rawPath), value: parseValue(rawValue, parameterOffset) };
    parameterOffset += countParameters(assignment);
    return parsed;
  });
  if (!assignments.length) throw validation("Unsupported PartiQL UPDATE statement.");
  return {
    kind: "update",
    tableName: table.identifier,
    assignments,
    where: parameterizeExpression(
      source.slice(whereIndex + "WHERE".length),
      countParameters(source.slice(0, whereIndex)),
    ),
  };
}

function parseDelete(source: string): ParsedPartiQlStatement {
  const fromIndex = findTopLevelKeyword(source, "FROM", "DELETE".length);
  if (fromIndex < 0 || source.slice("DELETE".length, fromIndex).trim())
    throw validation("Unsupported PartiQL DELETE statement.");
  const table = readIdentifier(source, fromIndex + "FROM".length);
  const whereIndex = findTopLevelKeyword(source, "WHERE", table.end);
  if (whereIndex < 0 || source.slice(table.end, whereIndex).trim())
    throw validation("Unsupported PartiQL DELETE statement.");
  return {
    kind: "delete",
    tableName: table.identifier,
    where: parameterizeExpression(
      source.slice(whereIndex + "WHERE".length),
      countParameters(source.slice(0, whereIndex)),
    ),
  };
}

function parseValue(rawValue: string, parameterOffset: number): PartiQlValue {
  if (rawValue === "?") return { kind: "parameter", index: parameterOffset };
  try {
    return { kind: "literal", value: JSON.parse(rawValue) };
  } catch {
    throw validation("Unsupported PartiQL value.");
  }
}

function parameterizeExpression(rawExpression: string, parameterOffset: number): PartiQlExpression {
  let nextParameter = parameterOffset;
  const parameterIndexes: number[] = [];
  const normalized = normalizeIdentifierPath(rawExpression.trim());
  const text = replaceQuestionMarks(normalized, () => {
    const name = `:p${parameterIndexes.length}`;
    parameterIndexes.push(nextParameter++);
    return name;
  });
  if (!text) throw validation("Unsupported PartiQL statement.");
  return { text, parameterIndexes };
}

function parseLimit(rawLimit: string): number {
  const trimmed = rawLimit.trim();
  if (!/^\d+$/.test(trimmed)) throw validation("Unsupported PartiQL SELECT statement.");
  return Number(trimmed);
}

function readIdentifier(source: string, start: number): { identifier: string; end: number } {
  let index = skipWhitespace(source, start);
  const quote = source[index];
  if (quote === '"' || quote === "'") {
    let value = "";
    index++;
    while (index < source.length) {
      const char = source[index++];
      if (char === quote) return { identifier: value, end: index };
      if (char === "\\" && index < source.length) value += source[index++];
      else value += char;
    }
    throw validation("Unsupported PartiQL statement.");
  }
  const match = source.slice(index).match(/^[A-Za-z0-9_.:-]+/);
  if (!match) throw validation("Unsupported PartiQL statement.");
  return { identifier: match[0], end: index + match[0].length };
}

function stripStatementTerminator(source: string): string {
  return source.endsWith(";") ? source.slice(0, -1).trimEnd() : source;
}

function skipWhitespace(source: string, index: number): number {
  while (/\s/.test(source[index] ?? "")) index++;
  return index;
}

function startsWithKeyword(source: string, index: number, keyword: string): boolean {
  return (
    source.slice(index, index + keyword.length).toUpperCase() === keyword &&
    isKeywordBoundary(source[index + keyword.length])
  );
}

function findTopLevelKeyword(source: string, keyword: string, start = 0): number {
  let depth = 0;
  let quote: string | undefined;
  for (let i = start; i < source.length; i++) {
    const char = source[i];
    if (quote) {
      if (char === "\\") i++;
      else if (char === quote) quote = undefined;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === "(" || char === "[" || char === "{") depth++;
    if (char === ")" || char === "]" || char === "}") depth--;
    if (
      depth === 0 &&
      source.slice(i, i + keyword.length).toUpperCase() === keyword &&
      isKeywordBoundary(source[i - 1]) &&
      isKeywordBoundary(source[i + keyword.length])
    ) {
      return i;
    }
  }
  return -1;
}

function isKeywordBoundary(char: string | undefined): boolean {
  return !char || !/[A-Za-z0-9_]/.test(char);
}

function normalizeIdentifierPath(value: string): string {
  let normalized = "";
  let quote: string | undefined;
  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    if (quote) {
      if (char === "\\") {
        normalized += char + (value[++i] ?? "");
      } else if (char === quote) {
        if (quote === "'") normalized += char;
        quote = undefined;
      } else {
        normalized += char;
      }
      continue;
    }
    if (char === '"') {
      quote = char;
      continue;
    }
    if (char === "'") {
      quote = char;
      normalized += char;
      continue;
    }
    normalized += char;
  }
  return normalized;
}

function replaceQuestionMarks(value: string, replacement: () => string): string {
  let output = "";
  let quote: string | undefined;
  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    if (quote) {
      output += char;
      if (char === "\\") output += value[++i] ?? "";
      else if (char === quote) quote = undefined;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      output += char;
      continue;
    }
    output += char === "?" ? replacement() : char;
  }
  return output;
}

function countParameters(value: string): number {
  let count = 0;
  replaceQuestionMarks(value, () => {
    count++;
    return "?";
  });
  return count;
}

function predicateEqualsAttribute(expression: string, attributeName: string): boolean {
  const parts = splitTopLevelWord(expression, "AND");
  const predicates = parts.length ? parts : [expression];
  return predicates.some((part) => {
    const comparison = part.trim().match(/^(.+?)\s*=\s*(.+)$/);
    return comparison ? normalizeIdentifierPath(comparison[1].trim()) === attributeName : false;
  });
}
