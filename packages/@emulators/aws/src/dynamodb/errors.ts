import type { ContentfulStatusCode } from "@emulators/core";
import type { DynamoDbItem } from "../entities.js";
import type { JsonMap } from "./types.js";

export class DynamoDbLocalError extends Error {
  item?: DynamoDbItem;
  cancellationReasons?: JsonMap[];

  constructor(
    readonly code: string,
    message: string,
    readonly status: ContentfulStatusCode = 400,
  ) {
    super(message);
  }
}

export function conditionalFailure(item?: DynamoDbItem, returnValues?: string): DynamoDbLocalError {
  const error = new DynamoDbLocalError("ConditionalCheckFailedException", "The conditional request failed");
  if (item && returnValues === "ALL_OLD") error.item = item;
  return error;
}

export function validation(message: string): DynamoDbLocalError {
  return new DynamoDbLocalError("ValidationException", message);
}

export function transactionCanceled(reasons: JsonMap[]): DynamoDbLocalError {
  const error = new DynamoDbLocalError("TransactionCanceledException", "Transaction cancelled, please refer cancellation reasons for specific reasons.");
  error.cancellationReasons = reasons;
  return error;
}
