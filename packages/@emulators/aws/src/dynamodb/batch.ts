import type { DynamoDbTable } from "../entities.js";
import { itemKey, storageKey, validateKey } from "./items.js";
import { validation } from "./errors.js";
import type { JsonMap } from "./types.js";

export function validateBatchGet(input: JsonMap, requireTableByName: (name: string) => DynamoDbTable): void {
  let count = 0;
  for (const [tableName, request] of Object.entries<JsonMap>(input.RequestItems)) {
    const table = requireTableByName(tableName);
    const seen = new Set<string>();
    for (const key of request.Keys ?? []) {
      count++;
      validateKey(table, key);
      const canonical = storageKey(table, key);
      if (seen.has(canonical)) throw validation("Provided list of item keys contains duplicates");
      seen.add(canonical);
    }
  }
  if (count > 100) throw validation("Too many items requested for the BatchGetItem call.");
}

export function validateBatchWrite(input: JsonMap, requireTableByName: (name: string) => DynamoDbTable): void {
  let count = 0;
  const seen = new Set<string>();
  for (const [tableName, requests] of Object.entries<JsonMap[]>(input.RequestItems)) {
    const table = requireTableByName(tableName);
    for (const request of requests) {
      count++;
      const key = request.PutRequest ? itemKey(table, request.PutRequest.Item) : request.DeleteRequest?.Key;
      validateKey(table, key);
      const canonical = storageKey(table, key);
      if (seen.has(canonical)) throw validation("Provided list of item keys contains duplicates");
      seen.add(canonical);
    }
  }
  if (count > 25) throw validation("Too many items requested for the BatchWriteItem call.");
}

export function validateTransactionItems(items: JsonMap[], allowed: string[], requireTableByName: (name: string) => DynamoDbTable): void {
  if (!Array.isArray(items) || items.length === 0 || items.length > 100) throw validation("TransactItems must contain between 1 and 100 items.");
  const seen = new Set<string>();
  for (const entry of items) {
    const actions = allowed.filter((action) => entry[action]);
    if (actions.length !== 1) throw validation("TransactItems must contain exactly one action.");
    const action = actions[0];
    const request = entry[action];
    const tableName = request.TableName;
    const table = requireTableByName(tableName);
    const key = action === "Put" ? itemKey(table, request.Item) : request.Key;
    validateKey(table, key);
    const canonical = storageKey(table, key);
    if (seen.has(canonical)) throw validation("Transaction request cannot include multiple operations on one item.");
    seen.add(canonical);
  }
}
