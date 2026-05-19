import type { JsonMap } from "./types.js";

export function compact(value: JsonMap): JsonMap {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

export function epochSeconds(value: string): number {
  return Math.floor(new Date(value).getTime() / 1000);
}

export function clone<T>(value: T): T {
  return value === undefined ? value : JSON.parse(JSON.stringify(value));
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function paginate<T>(
  values: T[],
  options: { cursor?: string; limit?: number; cursorValue: (value: T) => string },
): { items: T[]; nextToken?: string } {
  const start = options.cursor ? values.findIndex((value) => options.cursorValue(value) === options.cursor) + 1 : 0;
  const limit = Math.min(options.limit ?? values.length, values.length || options.limit || 0);
  const items = values.slice(start, start + limit);
  const nextToken = start + limit < values.length && items.length ? options.cursorValue(items.at(-1)!) : undefined;
  return { items, nextToken };
}

export function assertNever(value: never): never {
  throw new Error(`Unhandled DynamoDB operation ${value}`);
}
