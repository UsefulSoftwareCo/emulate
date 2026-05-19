import { describe, it, expect, beforeEach } from "vitest";
import type { AppEnv, Hono } from "@emulators/core";
import { DYNAMODB_MODEL, DYNAMODB_OPERATION_NAMES } from "../dynamodb-model.js";
import { dynamodbHandlersForTest } from "../routes/dynamodb.js";
import { createTestApp, testAuthHeaders as authHeaders, testBaseUrl as base } from "./helpers.js";

async function dynamodb(app: Hono<AppEnv>, operation: string, body: Record<string, unknown> = {}) {
  return app.request(`${base}/dynamodb/`, {
    method: "POST",
    headers: {
      ...authHeaders(),
      "content-type": "application/x-amz-json-1.0",
      "x-amz-target": `${DYNAMODB_MODEL.targetPrefix}.${operation}`,
    },
    body: JSON.stringify(body),
  });
}

function tableSchema(hash = "id") {
  return {
    AttributeDefinitions: [{ AttributeName: hash, AttributeType: "S" }],
    KeySchema: [{ AttributeName: hash, KeyType: "HASH" }],
    BillingMode: "PAY_PER_REQUEST",
  };
}

describe("AWS plugin - DynamoDB JSON protocol", () => {
  let app: Hono<AppEnv>;

  beforeEach(() => {
    app = createTestApp().app;
  });

  it("keeps a handler registered for every Botocore DynamoDB operation", () => {
    expect(DYNAMODB_MODEL.jsonVersion).toBe("1.0");
    expect(DYNAMODB_MODEL.targetPrefix).toBe("DynamoDB_20120810");
    expect(DYNAMODB_OPERATION_NAMES).toHaveLength(57);
    expect(Object.keys(dynamodbHandlersForTest()).sort()).toEqual([...DYNAMODB_OPERATION_NAMES].sort());
  });

  it("rejects missing target, malformed JSON, missing required fields, and unknown operations", async () => {
    const missingTarget = await app.request(`${base}/dynamodb/`, {
      method: "POST",
      headers: { ...authHeaders(), "content-type": "application/x-amz-json-1.0" },
      body: "{}",
    });
    expect(missingTarget.status).toBe(400);
    expect(await missingTarget.json()).toMatchObject({ __type: expect.stringContaining("MissingAuthenticationToken") });

    const malformed = await app.request(`${base}/dynamodb/`, {
      method: "POST",
      headers: {
        ...authHeaders(),
        "content-type": "application/x-amz-json-1.0",
        "x-amz-target": `${DYNAMODB_MODEL.targetPrefix}.ListTables`,
      },
      body: "{",
    });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({ __type: expect.stringContaining("SerializationException") });

    const missingField = await dynamodb(app, "PutItem", { TableName: "emulate-default" });
    expect(missingField.status).toBe(400);
    expect(await missingField.json()).toMatchObject({ __type: expect.stringContaining("ValidationException") });

    const unknown = await app.request(`${base}/dynamodb/`, {
      method: "POST",
      headers: {
        ...authHeaders(),
        "content-type": "application/x-amz-json-1.0",
        "x-amz-target": `${DYNAMODB_MODEL.targetPrefix}.Nope`,
      },
      body: "{}",
    });
    expect(unknown.status).toBe(400);
    expect(await unknown.json()).toMatchObject({ __type: expect.stringContaining("UnknownOperationException") });
  });

  it("supports table lifecycle and deletion protection", async () => {
    const create = await dynamodb(app, "CreateTable", {
      TableName: "users",
      AttributeDefinitions: [
        { AttributeName: "tenant", AttributeType: "S" },
        { AttributeName: "id", AttributeType: "S" },
      ],
      KeySchema: [
        { AttributeName: "tenant", KeyType: "HASH" },
        { AttributeName: "id", KeyType: "RANGE" },
      ],
      BillingMode: "PAY_PER_REQUEST",
      DeletionProtectionEnabled: true,
      Tags: [{ Key: "env", Value: "test" }],
    });
    expect(create.status).toBe(200);
    expect(await create.json()).toMatchObject({ TableDescription: { TableName: "users", TableStatus: "ACTIVE" } });

    const list = await dynamodb(app, "ListTables");
    expect(await list.json()).toMatchObject({ TableNames: expect.arrayContaining(["emulate-default", "users"]) });

    const blocked = await dynamodb(app, "DeleteTable", { TableName: "users" });
    expect(blocked.status).toBe(400);
    expect(await blocked.json()).toMatchObject({ __type: expect.stringContaining("ValidationException") });

    await dynamodb(app, "UpdateTable", { TableName: "users", DeletionProtectionEnabled: false });
    const deleted = await dynamodb(app, "DeleteTable", { TableName: "users" });
    expect(deleted.status).toBe(200);
  });

  it("supports put, get, update, query, scan, batch, and transaction item paths", async () => {
    await dynamodb(app, "CreateTable", {
      TableName: "items",
      AttributeDefinitions: [
        { AttributeName: "pk", AttributeType: "S" },
        { AttributeName: "sk", AttributeType: "S" },
      ],
      KeySchema: [
        { AttributeName: "pk", KeyType: "HASH" },
        { AttributeName: "sk", KeyType: "RANGE" },
      ],
      BillingMode: "PAY_PER_REQUEST",
    });

    const put = await dynamodb(app, "PutItem", {
      TableName: "items",
      Item: { pk: { S: "a" }, sk: { S: "1" }, count: { N: "1" }, nested: { M: { label: { S: "first" } } } },
      ConditionExpression: "attribute_not_exists(pk)",
    });
    expect(put.status).toBe(200);

    const duplicate = await dynamodb(app, "PutItem", {
      TableName: "items",
      Item: { pk: { S: "a" }, sk: { S: "1" } },
      ConditionExpression: "attribute_not_exists(pk)",
    });
    expect(duplicate.status).toBe(400);
    expect(await duplicate.json()).toMatchObject({
      __type: expect.stringContaining("ConditionalCheckFailedException"),
    });

    const update = await dynamodb(app, "UpdateItem", {
      TableName: "items",
      Key: { pk: { S: "a" }, sk: { S: "1" } },
      UpdateExpression: "SET #count = #count + :one, nested.extra = :extra",
      ExpressionAttributeNames: { "#count": "count" },
      ExpressionAttributeValues: { ":one": { N: "2" }, ":extra": { S: "ok" } },
      ReturnValues: "ALL_NEW",
    });
    expect(await update.json()).toMatchObject({
      Attributes: { count: { N: "3" }, nested: { M: { label: { S: "first" }, extra: { S: "ok" } } } },
    });

    const updatedOld = await dynamodb(app, "UpdateItem", {
      TableName: "items",
      Key: { pk: { S: "a" }, sk: { S: "1" } },
      UpdateExpression: "SET #count = #count + :one",
      ExpressionAttributeNames: { "#count": "count" },
      ExpressionAttributeValues: { ":one": { N: "1" } },
      ReturnValues: "UPDATED_OLD",
    });
    expect(await updatedOld.json()).toMatchObject({ Attributes: { count: { N: "3" } } });

    const invalidPutReturnValues = await dynamodb(app, "PutItem", {
      TableName: "items",
      Item: { pk: { S: "bad" }, sk: { S: "1" } },
      ReturnValues: "ALL_NEW",
    });
    expect(invalidPutReturnValues.status).toBe(400);

    const get = await dynamodb(app, "GetItem", {
      TableName: "items",
      Key: { pk: { S: "a" }, sk: { S: "1" } },
      ProjectionExpression: "pk, nested.extra",
    });
    expect(await get.json()).toEqual({ Item: { pk: { S: "a" }, nested: { M: { extra: { S: "ok" } } } } });

    await dynamodb(app, "BatchWriteItem", {
      RequestItems: {
        items: [
          { PutRequest: { Item: { pk: { S: "a" }, sk: { S: "2" }, count: { N: "5" } } } },
          { PutRequest: { Item: { pk: { S: "b" }, sk: { S: "1" }, count: { N: "8" } } } },
        ],
      },
    });

    const query = await dynamodb(app, "Query", {
      TableName: "items",
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
      ExpressionAttributeValues: { ":pk": { S: "a" }, ":prefix": { S: "" } },
    });
    expect(await query.json()).toMatchObject({ Count: 2 });

    const scan = await dynamodb(app, "Scan", {
      TableName: "items",
      FilterExpression: "#count >= :min",
      ExpressionAttributeNames: { "#count": "count" },
      ExpressionAttributeValues: { ":min": { N: "5" } },
    });
    expect(await scan.json()).toMatchObject({ Count: 2 });

    const batch = await dynamodb(app, "BatchGetItem", {
      RequestItems: { items: { Keys: [{ pk: { S: "a" }, sk: { S: "1" } }] } },
    });
    expect(await batch.json()).toMatchObject({ Responses: { items: [{ pk: { S: "a" } }] } });

    const transaction = await dynamodb(app, "TransactWriteItems", {
      TransactItems: [
        {
          Put: {
            TableName: "items",
            Item: { pk: { S: "tx" }, sk: { S: "1" } },
            ConditionExpression: "attribute_not_exists(pk)",
          },
        },
      ],
    });
    expect(transaction.status).toBe(200);
  });

  it("rejects invalid AttributeValue maps in item requests", async () => {
    await dynamodb(app, "CreateTable", { TableName: "attribute-values", ...tableSchema("pk") });

    const emptyAttribute = await dynamodb(app, "PutItem", {
      TableName: "attribute-values",
      Item: { pk: {} },
    });
    expect(emptyAttribute.status).toBe(400);
    expect(await emptyAttribute.json()).toMatchObject({ __type: expect.stringContaining("ValidationException") });

    const multiTypeAttribute = await dynamodb(app, "PutItem", {
      TableName: "attribute-values",
      Item: { pk: { S: "a", N: "1" } },
    });
    expect(multiTypeAttribute.status).toBe(400);
    expect(await multiTypeAttribute.json()).toMatchObject({ __type: expect.stringContaining("ValidationException") });
  });

  it("paginates query and scan results using evaluated items before filters", async () => {
    await dynamodb(app, "CreateTable", {
      TableName: "pagination",
      AttributeDefinitions: [
        { AttributeName: "pk", AttributeType: "S" },
        { AttributeName: "sk", AttributeType: "S" },
      ],
      KeySchema: [
        { AttributeName: "pk", KeyType: "HASH" },
        { AttributeName: "sk", KeyType: "RANGE" },
      ],
      BillingMode: "PAY_PER_REQUEST",
    });
    await dynamodb(app, "BatchWriteItem", {
      RequestItems: {
        pagination: [
          { PutRequest: { Item: { pk: { S: "tenant" }, sk: { S: "1" }, visible: { BOOL: false } } } },
          { PutRequest: { Item: { pk: { S: "tenant" }, sk: { S: "2" }, visible: { BOOL: true } } } },
          { PutRequest: { Item: { pk: { S: "tenant" }, sk: { S: "3" }, visible: { BOOL: true } } } },
        ],
      },
    });

    const firstQueryPage = (await (
      await dynamodb(app, "Query", {
        TableName: "pagination",
        KeyConditionExpression: "pk = :pk",
        FilterExpression: "visible = :visible",
        ExpressionAttributeValues: { ":pk": { S: "tenant" }, ":visible": { BOOL: true } },
        Limit: 1,
      })
    ).json()) as { Count: number; ScannedCount: number; Items: unknown[]; LastEvaluatedKey: Record<string, unknown> };
    expect(firstQueryPage).toMatchObject({
      Count: 0,
      ScannedCount: 1,
      Items: [],
      LastEvaluatedKey: { pk: { S: "tenant" }, sk: { S: "1" } },
    });

    const secondQueryPage = await dynamodb(app, "Query", {
      TableName: "pagination",
      KeyConditionExpression: "pk = :pk",
      FilterExpression: "visible = :visible",
      ExpressionAttributeValues: { ":pk": { S: "tenant" }, ":visible": { BOOL: true } },
      ExclusiveStartKey: firstQueryPage.LastEvaluatedKey,
      Limit: 1,
    });
    expect(await secondQueryPage.json()).toMatchObject({
      Count: 1,
      ScannedCount: 1,
      Items: [{ sk: { S: "2" } }],
      LastEvaluatedKey: { pk: { S: "tenant" }, sk: { S: "2" } },
    });

    const firstScanPage = await dynamodb(app, "Scan", {
      TableName: "pagination",
      FilterExpression: "visible = :visible",
      ExpressionAttributeValues: { ":visible": { BOOL: true } },
      Limit: 1,
    });
    expect(await firstScanPage.json()).toMatchObject({
      Count: 0,
      ScannedCount: 1,
      Items: [],
      LastEvaluatedKey: { pk: { S: "tenant" }, sk: { S: "1" } },
    });
  });

  it("applies update expression functions and set arithmetic", async () => {
    await dynamodb(app, "CreateTable", { TableName: "updates", ...tableSchema("pk") });
    await dynamodb(app, "PutItem", {
      TableName: "updates",
      Item: {
        pk: { S: "item" },
        count: { N: "1" },
        tags: { SS: ["red", "blue"] },
        nums: { NS: ["1", "2"] },
        events: { L: [{ S: "created" }] },
        obsolete: { S: "remove" },
      },
    });

    const updated = await dynamodb(app, "UpdateItem", {
      TableName: "updates",
      Key: { pk: { S: "item" } },
      UpdateExpression:
        "SET createdAt = if_not_exists(createdAt, :createdAt), events = list_append(events, :events) REMOVE obsolete ADD count :inc, tags :newTags, nums :newNums DELETE tags :removeTags, nums :removeNums",
      ExpressionAttributeValues: {
        ":createdAt": { S: "now" },
        ":events": { L: [{ S: "updated" }] },
        ":inc": { N: "4" },
        ":newTags": { SS: ["green", "red"] },
        ":newNums": { NS: ["2", "3"] },
        ":removeTags": { SS: ["blue"] },
        ":removeNums": { NS: ["1"] },
      },
      ReturnValues: "ALL_NEW",
    });
    expect(await updated.json()).toMatchObject({
      Attributes: {
        count: { N: "5" },
        createdAt: { S: "now" },
        events: { L: [{ S: "created" }, { S: "updated" }] },
        tags: { SS: ["red", "green"] },
        nums: { NS: ["2", "3"] },
      },
    });

    const got = await dynamodb(app, "GetItem", { TableName: "updates", Key: { pk: { S: "item" } } });
    const body = (await got.json()) as { Item: Record<string, unknown> };
    expect(body.Item).not.toHaveProperty("obsolete");
  });

  it("rejects invalid update expressions without mutating the item", async () => {
    await dynamodb(app, "CreateTable", { TableName: "expression-validation", ...tableSchema("pk") });
    await dynamodb(app, "PutItem", {
      TableName: "expression-validation",
      Item: { pk: { S: "item" }, count: { N: "1" }, label: { S: "original" } },
    });

    const missingToken = await dynamodb(app, "UpdateItem", {
      TableName: "expression-validation",
      Key: { pk: { S: "item" } },
      UpdateExpression: "SET label = :missing",
    });
    expect(missingToken.status).toBe(400);

    const invalidOperand = await dynamodb(app, "UpdateItem", {
      TableName: "expression-validation",
      Key: { pk: { S: "item" } },
      UpdateExpression: "SET count = count + :text",
      ExpressionAttributeValues: { ":text": { S: "bad" } },
    });
    expect(invalidOperand.status).toBe(400);

    const got = await dynamodb(app, "GetItem", {
      TableName: "expression-validation",
      Key: { pk: { S: "item" } },
    });
    expect(await got.json()).toMatchObject({ Item: { count: { N: "1" }, label: { S: "original" } } });
  });

  it("validates batch and transaction duplicate item access limits", async () => {
    await dynamodb(app, "CreateTable", { TableName: "bulk-validation", ...tableSchema("pk") });
    await dynamodb(app, "PutItem", { TableName: "bulk-validation", Item: { pk: { S: "dup" } } });

    const duplicateBatchGet = await dynamodb(app, "BatchGetItem", {
      RequestItems: {
        "bulk-validation": {
          Keys: [{ pk: { S: "dup" } }, { pk: { S: "dup" } }],
        },
      },
    });
    expect(duplicateBatchGet.status).toBe(400);

    const tooManyBatchWrites = await dynamodb(app, "BatchWriteItem", {
      RequestItems: {
        "bulk-validation": Array.from({ length: 26 }, (_, index) => ({
          PutRequest: { Item: { pk: { S: `item-${index}` } } },
        })),
      },
    });
    expect(tooManyBatchWrites.status).toBe(400);

    const duplicateTransaction = await dynamodb(app, "TransactWriteItems", {
      TransactItems: [
        {
          ConditionCheck: {
            TableName: "bulk-validation",
            Key: { pk: { S: "dup" } },
            ConditionExpression: "attribute_exists(pk)",
          },
        },
        {
          Update: {
            TableName: "bulk-validation",
            Key: { pk: { S: "dup" } },
            UpdateExpression: "SET touched = :yes",
            ExpressionAttributeValues: { ":yes": { BOOL: true } },
          },
        },
      ],
    });
    expect(duplicateTransaction.status).toBe(400);
  });

  it("returns ordered transaction cancellation reasons and rolls back mixed write failures", async () => {
    await dynamodb(app, "CreateTable", {
      TableName: "transactions",
      AttributeDefinitions: [
        { AttributeName: "pk", AttributeType: "S" },
        { AttributeName: "sk", AttributeType: "S" },
      ],
      KeySchema: [
        { AttributeName: "pk", KeyType: "HASH" },
        { AttributeName: "sk", KeyType: "RANGE" },
      ],
      BillingMode: "PAY_PER_REQUEST",
    });
    await dynamodb(app, "PutItem", {
      TableName: "transactions",
      Item: { pk: { S: "existing" }, sk: { S: "1" }, count: { N: "1" } },
    });

    const conditionFailure = await dynamodb(app, "TransactWriteItems", {
      TransactItems: [
        {
          Put: {
            TableName: "transactions",
            Item: { pk: { S: "condition-before" }, sk: { S: "1" } },
          },
        },
        {
          ConditionCheck: {
            TableName: "transactions",
            Key: { pk: { S: "existing" }, sk: { S: "1" } },
            ConditionExpression: "attribute_not_exists(pk)",
          },
        },
        {
          Put: {
            TableName: "transactions",
            Item: { pk: { S: "condition-after" }, sk: { S: "1" } },
          },
        },
      ],
    });
    expect(conditionFailure.status).toBe(400);
    expect(await conditionFailure.json()).toMatchObject({
      __type: expect.stringContaining("TransactionCanceledException"),
      CancellationReasons: [
        { Code: "None" },
        { Code: "ConditionalCheckFailed", Message: "The conditional request failed" },
        { Code: "None" },
      ],
    });
    expect(
      await (
        await dynamodb(app, "GetItem", {
          TableName: "transactions",
          Key: { pk: { S: "condition-before" }, sk: { S: "1" } },
        })
      ).json(),
    ).toEqual({});
    expect(
      await (
        await dynamodb(app, "GetItem", {
          TableName: "transactions",
          Key: { pk: { S: "condition-after" }, sk: { S: "1" } },
        })
      ).json(),
    ).toEqual({});

    const missingItemFailure = await dynamodb(app, "TransactWriteItems", {
      TransactItems: [
        {
          Put: {
            TableName: "transactions",
            Item: { pk: { S: "missing-before" }, sk: { S: "1" } },
          },
        },
        {
          ConditionCheck: {
            TableName: "transactions",
            Key: { pk: { S: "missing" }, sk: { S: "1" } },
            ConditionExpression: "attribute_exists(pk)",
          },
        },
        {
          Delete: {
            TableName: "transactions",
            Key: { pk: { S: "existing" }, sk: { S: "1" } },
          },
        },
      ],
    });
    expect(missingItemFailure.status).toBe(400);
    expect(await missingItemFailure.json()).toMatchObject({
      __type: expect.stringContaining("TransactionCanceledException"),
      CancellationReasons: [
        { Code: "None" },
        { Code: "ConditionalCheckFailed", Message: "The conditional request failed" },
        { Code: "None" },
      ],
    });
    expect(
      await (
        await dynamodb(app, "GetItem", {
          TableName: "transactions",
          Key: { pk: { S: "missing-before" }, sk: { S: "1" } },
        })
      ).json(),
    ).toEqual({});
    expect(
      await (
        await dynamodb(app, "GetItem", { TableName: "transactions", Key: { pk: { S: "existing" }, sk: { S: "1" } } })
      ).json(),
    ).toMatchObject({ Item: { count: { N: "1" } } });

    const validationFailure = await dynamodb(app, "TransactWriteItems", {
      TransactItems: [
        {
          Put: {
            TableName: "transactions",
            Item: { pk: { S: "validation-before" }, sk: { S: "1" } },
          },
        },
        {
          Update: {
            TableName: "transactions",
            Key: { pk: { S: "existing" }, sk: { S: "1" } },
            UpdateExpression: "SET pk = :next",
            ExpressionAttributeValues: { ":next": { S: "changed" } },
          },
        },
        {
          Put: {
            TableName: "transactions",
            Item: { pk: { S: "validation-after" }, sk: { S: "1" } },
          },
        },
      ],
    });
    expect(validationFailure.status).toBe(400);
    expect(await validationFailure.json()).toMatchObject({
      __type: expect.stringContaining("TransactionCanceledException"),
      CancellationReasons: [
        { Code: "None" },
        {
          Code: "ValidationError",
          Message: "One or more parameter values were invalid: Cannot update attribute used in the key schema",
        },
        { Code: "None" },
      ],
    });
    expect(
      await (
        await dynamodb(app, "GetItem", {
          TableName: "transactions",
          Key: { pk: { S: "validation-before" }, sk: { S: "1" } },
        })
      ).json(),
    ).toEqual({});
    expect(
      await (
        await dynamodb(app, "GetItem", { TableName: "transactions", Key: { pk: { S: "existing" }, sk: { S: "1" } } })
      ).json(),
    ).toMatchObject({ Item: { count: { N: "1" } } });
  });

  it("stores local metadata for TTL, PITR, backups, exports, imports, resource policies, global tables, and Kinesis", async () => {
    await dynamodb(app, "CreateTable", { TableName: "meta", ...tableSchema() });
    const describe = await dynamodb(app, "DescribeTable", { TableName: "meta" });
    const tableArn = ((await describe.json()) as { Table: { TableArn: string } }).Table.TableArn;

    await dynamodb(app, "UpdateTimeToLive", {
      TableName: "meta",
      TimeToLiveSpecification: { AttributeName: "expires_at", Enabled: true },
    });
    expect(await (await dynamodb(app, "DescribeTimeToLive", { TableName: "meta" })).json()).toMatchObject({
      TimeToLiveDescription: { AttributeName: "expires_at", TimeToLiveStatus: "ENABLED" },
    });

    await dynamodb(app, "UpdateContinuousBackups", {
      TableName: "meta",
      PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
    });
    expect(await (await dynamodb(app, "DescribeContinuousBackups", { TableName: "meta" })).json()).toMatchObject({
      ContinuousBackupsDescription: { PointInTimeRecoveryDescription: { PointInTimeRecoveryStatus: "ENABLED" } },
    });

    await dynamodb(app, "PutResourcePolicy", { ResourceArn: tableArn, Policy: '{"Version":"2012-10-17"}' });
    const policy = await (await dynamodb(app, "GetResourcePolicy", { ResourceArn: tableArn })).json();
    expect(policy).toMatchObject({
      Policy: '{"Version":"2012-10-17"}',
    });
    const badPolicyRevision = await dynamodb(app, "DeleteResourcePolicy", {
      ResourceArn: tableArn,
      ExpectedRevisionId: "stale",
    });
    expect(badPolicyRevision.status).toBe(400);
    await dynamodb(app, "DeleteResourcePolicy", {
      ResourceArn: tableArn,
      ExpectedRevisionId: (policy as { RevisionId: string }).RevisionId,
    });

    await dynamodb(app, "EnableKinesisStreamingDestination", {
      TableName: "meta",
      StreamArn: "arn:aws:kinesis:us-east-1:123456789012:stream/local",
    });
    expect(
      await (await dynamodb(app, "DescribeKinesisStreamingDestination", { TableName: "meta" })).json(),
    ).toMatchObject({
      KinesisDataStreamDestinations: [{ DestinationStatus: "ACTIVE" }],
    });

    const backup = await dynamodb(app, "CreateBackup", { TableName: "meta", BackupName: "snapshot" });
    const backupArn = ((await backup.json()) as { BackupDetails: { BackupArn: string } }).BackupDetails.BackupArn;
    const exportResult = await dynamodb(app, "ExportTableToPointInTime", { TableArn: tableArn, S3Bucket: "exports" });
    expect(await exportResult.json()).toMatchObject({ ExportDescription: { ExportStatus: "COMPLETED" } });

    await dynamodb(app, "UpdateTable", { TableName: "meta", DeletionProtectionEnabled: false });
    const deleting = await dynamodb(app, "DeleteTable", { TableName: "meta" });
    expect(await deleting.json()).toMatchObject({ TableDescription: { TableStatus: "DELETING" } });
    expect(await (await dynamodb(app, "DescribeTable", { TableName: "meta" })).json()).toMatchObject({
      Table: { TableStatus: "DELETING" },
    });
    expect(await (await dynamodb(app, "ListTables")).json()).not.toMatchObject({
      TableNames: expect.arrayContaining(["meta"]),
    });
    await dynamodb(app, "RestoreTableFromBackup", { TargetTableName: "meta-restored", BackupArn: backupArn });
    expect(await (await dynamodb(app, "DescribeTable", { TableName: "meta-restored" })).json()).toMatchObject({
      Table: { TableName: "meta-restored" },
    });

    const importResult = await dynamodb(app, "ImportTable", {
      S3BucketSource: { S3Bucket: "imports" },
      InputFormat: "DYNAMODB_JSON",
      TableCreationParameters: { TableName: "imported", ...tableSchema() },
    });
    expect(await importResult.json()).toMatchObject({ ImportTableDescription: { ImportStatus: "COMPLETED" } });

    await dynamodb(app, "CreateGlobalTable", {
      GlobalTableName: "global",
      ReplicationGroup: [{ RegionName: "us-east-1" }],
    });
    expect(await (await dynamodb(app, "DescribeGlobalTable", { GlobalTableName: "global" })).json()).toMatchObject({
      GlobalTableDescription: { GlobalTableStatus: "ACTIVE" },
    });
    expect(
      await (await dynamodb(app, "DescribeGlobalTableSettings", { GlobalTableName: "global" })).json(),
    ).toMatchObject({
      ReplicaSettings: [{ RegionName: "us-east-1", ReplicaStatus: "ACTIVE" }],
    });
  });

  it("returns modeled DynamoDB admin response shapes", async () => {
    await dynamodb(app, "CreateTable", {
      TableName: "admin-shapes",
      AttributeDefinitions: [
        { AttributeName: "id", AttributeType: "S" },
        { AttributeName: "gsi_pk", AttributeType: "S" },
      ],
      KeySchema: [{ AttributeName: "id", KeyType: "HASH" }],
      GlobalSecondaryIndexes: [
        {
          IndexName: "by-gsi",
          KeySchema: [{ AttributeName: "gsi_pk", KeyType: "HASH" }],
          Projection: { ProjectionType: "ALL" },
        },
      ],
      BillingMode: "PAY_PER_REQUEST",
    });

    expect(
      await (
        await dynamodb(app, "UpdateContributorInsights", {
          TableName: "admin-shapes",
          ContributorInsightsAction: "ENABLE",
          ContributorInsightsMode: "THROTTLED_KEYS",
        })
      ).json(),
    ).toEqual({
      TableName: "admin-shapes",
      ContributorInsightsStatus: "ENABLED",
      ContributorInsightsMode: "THROTTLED_KEYS",
    });
    expect(
      await (
        await dynamodb(app, "UpdateContributorInsights", {
          TableName: "admin-shapes",
          IndexName: "by-gsi",
          ContributorInsightsAction: "ENABLE",
          ContributorInsightsMode: "ACCESSED_AND_THROTTLED_KEYS",
        })
      ).json(),
    ).toEqual({
      TableName: "admin-shapes",
      IndexName: "by-gsi",
      ContributorInsightsStatus: "ENABLED",
      ContributorInsightsMode: "ACCESSED_AND_THROTTLED_KEYS",
    });
    expect(
      await (
        await dynamodb(app, "DescribeContributorInsights", { TableName: "admin-shapes", IndexName: "by-gsi" })
      ).json(),
    ).toMatchObject({
      TableName: "admin-shapes",
      IndexName: "by-gsi",
      ContributorInsightsRuleList: [],
      ContributorInsightsStatus: "ENABLED",
      ContributorInsightsMode: "ACCESSED_AND_THROTTLED_KEYS",
    });
    expect(await (await dynamodb(app, "ListContributorInsights", { TableName: "admin-shapes" })).json()).toMatchObject({
      ContributorInsightsSummaries: expect.arrayContaining([
        {
          TableName: "admin-shapes",
          ContributorInsightsStatus: "ENABLED",
          ContributorInsightsMode: "THROTTLED_KEYS",
        },
        {
          TableName: "admin-shapes",
          IndexName: "by-gsi",
          ContributorInsightsStatus: "ENABLED",
          ContributorInsightsMode: "ACCESSED_AND_THROTTLED_KEYS",
        },
      ]),
    });

    const streamArn = "arn:aws:kinesis:us-east-1:123456789012:stream/admin-shapes";
    expect(
      await (
        await dynamodb(app, "EnableKinesisStreamingDestination", {
          TableName: "admin-shapes",
          StreamArn: streamArn,
          EnableKinesisStreamingConfiguration: { ApproximateCreationDateTimePrecision: "MICROSECOND" },
        })
      ).json(),
    ).toMatchObject({
      TableName: "admin-shapes",
      StreamArn: streamArn,
      DestinationStatus: "ACTIVE",
      EnableKinesisStreamingConfiguration: { ApproximateCreationDateTimePrecision: "MICROSECOND" },
    });
    expect(
      await (
        await dynamodb(app, "UpdateKinesisStreamingDestination", {
          TableName: "admin-shapes",
          StreamArn: streamArn,
          UpdateKinesisStreamingConfiguration: { ApproximateCreationDateTimePrecision: "MILLISECOND" },
        })
      ).json(),
    ).toMatchObject({
      TableName: "admin-shapes",
      StreamArn: streamArn,
      DestinationStatus: "ACTIVE",
      UpdateKinesisStreamingConfiguration: { ApproximateCreationDateTimePrecision: "MILLISECOND" },
    });
    expect(
      await (await dynamodb(app, "DescribeKinesisStreamingDestination", { TableName: "admin-shapes" })).json(),
    ).toMatchObject({
      TableName: "admin-shapes",
      KinesisDataStreamDestinations: [
        {
          StreamArn: streamArn,
          DestinationStatus: "ACTIVE",
          ApproximateCreationDateTimePrecision: "MILLISECOND",
        },
      ],
    });

    const autoScalingUpdate = {
      MinimumUnits: 1,
      MaximumUnits: 10,
      ScalingPolicyUpdate: {
        PolicyName: "target",
        TargetTrackingScalingPolicyConfiguration: { TargetValue: 70 },
      },
    };
    await dynamodb(app, "CreateGlobalTable", {
      GlobalTableName: "global-shapes",
      ReplicationGroup: [{ RegionName: "us-east-1" }],
    });
    expect(
      await (
        await dynamodb(app, "UpdateGlobalTableSettings", {
          GlobalTableName: "global-shapes",
          GlobalTableBillingMode: "PROVISIONED",
          GlobalTableProvisionedWriteCapacityUnits: 7,
          GlobalTableProvisionedWriteCapacityAutoScalingSettingsUpdate: autoScalingUpdate,
          GlobalTableGlobalSecondaryIndexSettingsUpdate: [
            {
              IndexName: "global-index",
              ProvisionedWriteCapacityUnits: 5,
              ProvisionedWriteCapacityAutoScalingSettingsUpdate: autoScalingUpdate,
            },
          ],
          ReplicaSettingsUpdate: [
            {
              RegionName: "us-east-1",
              ReplicaProvisionedReadCapacityUnits: 3,
              ReplicaProvisionedReadCapacityAutoScalingSettingsUpdate: autoScalingUpdate,
              ReplicaGlobalSecondaryIndexSettingsUpdate: [
                {
                  IndexName: "global-index",
                  ProvisionedReadCapacityUnits: 4,
                  ProvisionedReadCapacityAutoScalingSettingsUpdate: autoScalingUpdate,
                },
              ],
              ReplicaTableClass: "STANDARD_INFREQUENT_ACCESS",
            },
          ],
        })
      ).json(),
    ).toMatchObject({
      GlobalTableName: "global-shapes",
      ReplicaSettings: [
        {
          RegionName: "us-east-1",
          ReplicaStatus: "ACTIVE",
          ReplicaBillingModeSummary: { BillingMode: "PROVISIONED" },
          ReplicaProvisionedReadCapacityUnits: 3,
          ReplicaProvisionedReadCapacityAutoScalingSettings: {
            MinimumUnits: 1,
            MaximumUnits: 10,
            ScalingPolicies: [{ PolicyName: "target" }],
          },
          ReplicaProvisionedWriteCapacityUnits: 7,
          ReplicaProvisionedWriteCapacityAutoScalingSettings: {
            MinimumUnits: 1,
            MaximumUnits: 10,
            ScalingPolicies: [{ PolicyName: "target" }],
          },
          ReplicaGlobalSecondaryIndexSettings: [
            {
              IndexName: "global-index",
              IndexStatus: "ACTIVE",
              ProvisionedReadCapacityUnits: 4,
              ProvisionedReadCapacityAutoScalingSettings: { ScalingPolicies: [{ PolicyName: "target" }] },
              ProvisionedWriteCapacityUnits: 5,
              ProvisionedWriteCapacityAutoScalingSettings: { ScalingPolicies: [{ PolicyName: "target" }] },
            },
          ],
          ReplicaTableClassSummary: { TableClass: "STANDARD_INFREQUENT_ACCESS" },
        },
      ],
    });

    const replicaAutoScaling = await dynamodb(app, "UpdateTableReplicaAutoScaling", {
      TableName: "admin-shapes",
      ReplicaUpdates: [
        {
          RegionName: "us-east-1",
          ReplicaProvisionedReadCapacityAutoScalingUpdate: autoScalingUpdate,
          ReplicaGlobalSecondaryIndexUpdates: [
            {
              IndexName: "by-gsi",
              ProvisionedReadCapacityAutoScalingUpdate: autoScalingUpdate,
            },
          ],
        },
      ],
    });
    expect(await replicaAutoScaling.json()).toMatchObject({
      TableAutoScalingDescription: {
        TableName: "admin-shapes",
        TableStatus: "ACTIVE",
        Replicas: [
          {
            RegionName: "us-east-1",
            ReplicaStatus: "ACTIVE",
            ReplicaProvisionedReadCapacityAutoScalingSettings: { ScalingPolicies: [{ PolicyName: "target" }] },
            GlobalSecondaryIndexes: [
              {
                IndexName: "by-gsi",
                IndexStatus: "ACTIVE",
                ProvisionedReadCapacityAutoScalingSettings: { ScalingPolicies: [{ PolicyName: "target" }] },
              },
            ],
          },
        ],
      },
    });
    expect(
      await (await dynamodb(app, "DescribeTableReplicaAutoScaling", { TableName: "admin-shapes" })).json(),
    ).toMatchObject({
      TableAutoScalingDescription: {
        TableName: "admin-shapes",
        Replicas: [
          {
            RegionName: "us-east-1",
            ReplicaProvisionedReadCapacityAutoScalingSettings: { ScalingPolicies: [{ PolicyName: "target" }] },
          },
        ],
      },
    });
  });

  it("supports basic PartiQL statements", async () => {
    await dynamodb(app, "CreateTable", { TableName: "partiql", ...tableSchema() });
    await dynamodb(app, "ExecuteStatement", {
      Statement: "INSERT INTO partiql VALUE ?",
      Parameters: [{ id: { S: "one" }, name: { S: "First" } }],
    });

    const select = await dynamodb(app, "ExecuteStatement", {
      Statement: "SELECT * FROM partiql WHERE id = ?",
      Parameters: [{ S: "one" }],
    });
    expect(await select.json()).toMatchObject({ Items: [{ name: { S: "First" } }] });

    await dynamodb(app, "BatchExecuteStatement", {
      Statements: [
        {
          Statement: "UPDATE partiql SET name = ? WHERE id = ?",
          Parameters: [{ S: "Updated" }, { S: "one" }],
        },
      ],
    });
    expect(
      await (
        await dynamodb(app, "ExecuteTransaction", {
          TransactStatements: [{ Statement: "DELETE FROM partiql WHERE id = ?", Parameters: [{ S: "one" }] }],
        })
      ).json(),
    ).toEqual({});
  });

  it("parses DynamoDB PartiQL statements without regex drift", async () => {
    await dynamodb(app, "CreateTable", {
      TableName: "quoted-table",
      AttributeDefinitions: [
        { AttributeName: "tenant-id", AttributeType: "S" },
        { AttributeName: "sort-id", AttributeType: "S" },
      ],
      KeySchema: [
        { AttributeName: "tenant-id", KeyType: "HASH" },
        { AttributeName: "sort-id", KeyType: "RANGE" },
      ],
      BillingMode: "PAY_PER_REQUEST",
    });
    await dynamodb(app, "ExecuteStatement", {
      Statement: 'INSERT INTO "quoted-table" VALUE ?',
      Parameters: [{ "tenant-id": { S: "tenant" }, "sort-id": { S: "one" }, label: { S: "First" } }],
    });
    await dynamodb(app, "ExecuteStatement", {
      Statement: 'INSERT INTO "quoted-table" VALUE ?',
      Parameters: [{ "tenant-id": { S: "tenant" }, "sort-id": { S: "two" }, label: { S: "Second" } }],
    });

    const selected = await dynamodb(app, "ExecuteStatement", {
      Statement: 'SELECT * FROM "quoted-table" WHERE "tenant-id" = ? AND "sort-id" = ? LIMIT 1',
      Parameters: [{ S: "tenant" }, { S: "one" }],
    });
    expect(await selected.json()).toMatchObject({ Items: [{ label: { S: "First" } }] });

    await dynamodb(app, "BatchExecuteStatement", {
      Statements: [
        {
          Statement: 'UPDATE "quoted-table" SET label = ? WHERE "tenant-id" = ? AND "sort-id" = ?',
          Parameters: [{ S: "Updated" }, { S: "tenant" }, { S: "one" }],
        },
      ],
    });
    expect(
      await (
        await dynamodb(app, "ExecuteStatement", {
          Statement: 'SELECT * FROM "quoted-table" WHERE "tenant-id" = ? AND "sort-id" = ?',
          Parameters: [{ S: "tenant" }, { S: "one" }],
        })
      ).json(),
    ).toMatchObject({ Items: [{ label: { S: "Updated" } }] });

    const firstPage = (await (
      await dynamodb(app, "ExecuteStatement", {
        Statement: 'SELECT * FROM "quoted-table" WHERE "tenant-id" = ? LIMIT 1',
        Parameters: [{ S: "tenant" }],
      })
    ).json()) as { Items: unknown[]; NextToken?: string };
    expect(firstPage.Items).toHaveLength(1);
    expect(firstPage.NextToken).toBeDefined();
    const secondPage = await dynamodb(app, "ExecuteStatement", {
      Statement: 'SELECT * FROM "quoted-table" WHERE "tenant-id" = ? LIMIT 1',
      Parameters: [{ S: "tenant" }],
      NextToken: firstPage.NextToken,
    });
    const secondPageBody = (await secondPage.json()) as { Items: Array<{ "sort-id": { S: string } }> };
    expect(secondPageBody.Items).toHaveLength(1);
    expect(secondPageBody.Items[0]["sort-id"].S).not.toBe(
      (firstPage.Items[0] as { "sort-id": { S: string } })["sort-id"].S,
    );

    const missingKeyPredicate = await dynamodb(app, "ExecuteStatement", {
      Statement: 'DELETE FROM "quoted-table" WHERE "tenant-id" = ?',
      Parameters: [{ S: "tenant" }],
    });
    expect(missingKeyPredicate.status).toBe(400);

    const malformed = await dynamodb(app, "ExecuteStatement", {
      Statement: 'SELECT FROM "quoted-table" WHERE "tenant-id" = ?',
      Parameters: [{ S: "tenant" }],
    });
    expect(malformed.status).toBe(400);
  });

  it("validates DynamoDB query key condition grammar", async () => {
    await dynamodb(app, "CreateTable", {
      TableName: "query-grammar",
      AttributeDefinitions: [
        { AttributeName: "pk", AttributeType: "S" },
        { AttributeName: "sk", AttributeType: "S" },
      ],
      KeySchema: [
        { AttributeName: "pk", KeyType: "HASH" },
        { AttributeName: "sk", KeyType: "RANGE" },
      ],
      BillingMode: "PAY_PER_REQUEST",
    });
    await dynamodb(app, "PutItem", {
      TableName: "query-grammar",
      Item: { pk: { S: "a" }, sk: { S: "1" }, other: { S: "value" } },
    });

    const expressionNonKey = await dynamodb(app, "Query", {
      TableName: "query-grammar",
      KeyConditionExpression: "pk = :pk AND other = :other",
      ExpressionAttributeValues: { ":pk": { S: "a" }, ":other": { S: "value" } },
    });
    expect(expressionNonKey.status).toBe(400);

    const expressionInvalidSortOperator = await dynamodb(app, "Query", {
      TableName: "query-grammar",
      KeyConditionExpression: "pk = :pk AND sk <> :sk",
      ExpressionAttributeValues: { ":pk": { S: "a" }, ":sk": { S: "1" } },
    });
    expect(expressionInvalidSortOperator.status).toBe(400);

    const expressionInvalidHashOperator = await dynamodb(app, "Query", {
      TableName: "query-grammar",
      KeyConditionExpression: "begins_with(pk, :pk)",
      ExpressionAttributeValues: { ":pk": { S: "a" } },
    });
    expect(expressionInvalidHashOperator.status).toBe(400);

    const legacyNonKey = await dynamodb(app, "Query", {
      TableName: "query-grammar",
      KeyConditions: {
        pk: { ComparisonOperator: "EQ", AttributeValueList: [{ S: "a" }] },
        other: { ComparisonOperator: "EQ", AttributeValueList: [{ S: "value" }] },
      },
    });
    expect(legacyNonKey.status).toBe(400);

    const legacyInvalidHashOperator = await dynamodb(app, "Query", {
      TableName: "query-grammar",
      KeyConditions: {
        pk: { ComparisonOperator: "BEGINS_WITH", AttributeValueList: [{ S: "a" }] },
      },
    });
    expect(legacyInvalidHashOperator.status).toBe(400);

    const legacyInvalidSortOperator = await dynamodb(app, "Query", {
      TableName: "query-grammar",
      KeyConditions: {
        pk: { ComparisonOperator: "EQ", AttributeValueList: [{ S: "a" }] },
        sk: { ComparisonOperator: "CONTAINS", AttributeValueList: [{ S: "1" }] },
      },
    });
    expect(legacyInvalidSortOperator.status).toBe(400);

    const validLegacyQuery = await dynamodb(app, "Query", {
      TableName: "query-grammar",
      KeyConditions: {
        pk: { ComparisonOperator: "EQ", AttributeValueList: [{ S: "a" }] },
        sk: { ComparisonOperator: "BEGINS_WITH", AttributeValueList: [{ S: "1" }] },
      },
    });
    expect(await validLegacyQuery.json()).toMatchObject({ Count: 1 });
  });

  it("rejects invalid table and secondary index schemas", async () => {
    const duplicateTableKeys = await dynamodb(app, "CreateTable", {
      TableName: "duplicate-table-keys",
      AttributeDefinitions: [{ AttributeName: "pk", AttributeType: "S" }],
      KeySchema: [
        { AttributeName: "pk", KeyType: "HASH" },
        { AttributeName: "pk", KeyType: "RANGE" },
      ],
      BillingMode: "PAY_PER_REQUEST",
    });
    expect(duplicateTableKeys.status).toBe(400);

    const missingIndexAttribute = await dynamodb(app, "CreateTable", {
      TableName: "missing-index-attribute",
      AttributeDefinitions: [{ AttributeName: "pk", AttributeType: "S" }],
      KeySchema: [{ AttributeName: "pk", KeyType: "HASH" }],
      GlobalSecondaryIndexes: [
        {
          IndexName: "by-missing",
          KeySchema: [{ AttributeName: "gsi", KeyType: "HASH" }],
          Projection: { ProjectionType: "ALL" },
        },
      ],
      BillingMode: "PAY_PER_REQUEST",
    });
    expect(missingIndexAttribute.status).toBe(400);

    const duplicateIndexNames = await dynamodb(app, "CreateTable", {
      TableName: "duplicate-indexes",
      AttributeDefinitions: [
        { AttributeName: "pk", AttributeType: "S" },
        { AttributeName: "gsi", AttributeType: "S" },
      ],
      KeySchema: [{ AttributeName: "pk", KeyType: "HASH" }],
      GlobalSecondaryIndexes: [
        {
          IndexName: "by-gsi",
          KeySchema: [{ AttributeName: "gsi", KeyType: "HASH" }],
          Projection: { ProjectionType: "ALL" },
        },
        {
          IndexName: "by-gsi",
          KeySchema: [{ AttributeName: "gsi", KeyType: "HASH" }],
          Projection: { ProjectionType: "ALL" },
        },
      ],
      BillingMode: "PAY_PER_REQUEST",
    });
    expect(duplicateIndexNames.status).toBe(400);

    const includeWithoutAttributes = await dynamodb(app, "CreateTable", {
      TableName: "bad-include",
      AttributeDefinitions: [
        { AttributeName: "pk", AttributeType: "S" },
        { AttributeName: "gsi", AttributeType: "S" },
      ],
      KeySchema: [{ AttributeName: "pk", KeyType: "HASH" }],
      GlobalSecondaryIndexes: [
        {
          IndexName: "by-gsi",
          KeySchema: [{ AttributeName: "gsi", KeyType: "HASH" }],
          Projection: { ProjectionType: "INCLUDE" },
        },
      ],
      BillingMode: "PAY_PER_REQUEST",
    });
    expect(includeWithoutAttributes.status).toBe(400);

    const keysOnlyWithAttributes = await dynamodb(app, "CreateTable", {
      TableName: "bad-keys-only",
      AttributeDefinitions: [
        { AttributeName: "pk", AttributeType: "S" },
        { AttributeName: "gsi", AttributeType: "S" },
      ],
      KeySchema: [{ AttributeName: "pk", KeyType: "HASH" }],
      GlobalSecondaryIndexes: [
        {
          IndexName: "by-gsi",
          KeySchema: [{ AttributeName: "gsi", KeyType: "HASH" }],
          Projection: { ProjectionType: "KEYS_ONLY", NonKeyAttributes: ["extra"] },
        },
      ],
      BillingMode: "PAY_PER_REQUEST",
    });
    expect(keysOnlyWithAttributes.status).toBe(400);
  });

  it("returns transact get item responses", async () => {
    await dynamodb(app, "CreateTable", { TableName: "transact-get", ...tableSchema("pk") });
    await dynamodb(app, "PutItem", {
      TableName: "transact-get",
      Item: { pk: { S: "one" }, value: { S: "first" }, hidden: { S: "no" } },
    });

    const result = await dynamodb(app, "TransactGetItems", {
      TransactItems: [
        {
          Get: {
            TableName: "transact-get",
            Key: { pk: { S: "one" } },
            ProjectionExpression: "pk, #value",
            ExpressionAttributeNames: { "#value": "value" },
          },
        },
        {
          Get: {
            TableName: "transact-get",
            Key: { pk: { S: "missing" } },
          },
        },
      ],
    });
    expect(await result.json()).toEqual({
      Responses: [{ Item: { pk: { S: "one" }, value: { S: "first" } } }, {}],
    });
  });

  it("rejects compatibility drift cases for lifecycle, keys, query, batch, transactions, and PartiQL", async () => {
    const invalidCreate = await dynamodb(app, "CreateTable", { TableName: "invalid" });
    expect(invalidCreate.status).toBe(400);
    expect(await invalidCreate.json()).toMatchObject({ __type: expect.stringContaining("ValidationException") });

    await dynamodb(app, "CreateTable", {
      TableName: "strict",
      AttributeDefinitions: [
        { AttributeName: "pk", AttributeType: "S" },
        { AttributeName: "sk", AttributeType: "S" },
      ],
      KeySchema: [
        { AttributeName: "pk", KeyType: "HASH" },
        { AttributeName: "sk", KeyType: "RANGE" },
      ],
      BillingMode: "PAY_PER_REQUEST",
    });
    await dynamodb(app, "PutItem", { TableName: "strict", Item: { pk: { S: "a" }, sk: { S: "1" }, n: { N: "1" } } });

    const badKey = await dynamodb(app, "GetItem", { TableName: "strict", Key: { pk: { N: "1" }, sk: { S: "1" } } });
    expect(badKey.status).toBe(400);

    const primaryKeyUpdate = await dynamodb(app, "UpdateItem", {
      TableName: "strict",
      Key: { pk: { S: "a" }, sk: { S: "1" } },
      UpdateExpression: "SET pk = :next",
      ExpressionAttributeValues: { ":next": { S: "b" } },
    });
    expect(primaryKeyUpdate.status).toBe(400);

    const queryWithoutKey = await dynamodb(app, "Query", { TableName: "strict" });
    expect(queryWithoutKey.status).toBe(400);

    const duplicateBatch = await dynamodb(app, "BatchWriteItem", {
      RequestItems: {
        strict: [
          { PutRequest: { Item: { pk: { S: "dup" }, sk: { S: "1" } } } },
          { DeleteRequest: { Key: { pk: { S: "dup" }, sk: { S: "1" } } } },
        ],
      },
    });
    expect(duplicateBatch.status).toBe(400);

    const transaction = await dynamodb(app, "TransactWriteItems", {
      TransactItems: [
        {
          ConditionCheck: {
            TableName: "strict",
            Key: { pk: { S: "a" }, sk: { S: "1" } },
            ConditionExpression: "attribute_not_exists(pk)",
          },
        },
      ],
    });
    expect(transaction.status).toBe(400);
    expect(await transaction.json()).toMatchObject({
      __type: expect.stringContaining("TransactionCanceledException"),
      CancellationReasons: [{ Code: "ConditionalCheckFailed" }],
    });

    const duplicateInsert = await dynamodb(app, "ExecuteStatement", {
      Statement: "INSERT INTO strict VALUE ?",
      Parameters: [{ pk: { S: "a" }, sk: { S: "1" } }],
    });
    expect(duplicateInsert.status).toBe(400);

    const describe = await dynamodb(app, "DescribeTable", { TableName: "strict" });
    const tableArn = ((await describe.json()) as { Table: { TableArn: string } }).Table.TableArn;
    const arnGet = await dynamodb(app, "GetItem", {
      TableName: tableArn,
      Key: { pk: { S: "a" }, sk: { S: "1" } },
    });
    expect(await arnGet.json()).toMatchObject({ Item: { n: { N: "1" } } });

    const missingNested = await dynamodb(app, "UpdateTimeToLive", {
      TableName: "strict",
      TimeToLiveSpecification: { Enabled: true },
    });
    expect(missingNested.status).toBe(400);
    expect(await missingNested.json()).toMatchObject({ __type: expect.stringContaining("ValidationException") });
  });

  it("models DynamoDB import lifecycle metadata", async () => {
    const tableCreationParameters = {
      TableName: "import-lifecycle",
      ...tableSchema("pk"),
      OnDemandThroughput: { MaxReadRequestUnits: 100, MaxWriteRequestUnits: 200 },
      TableClass: "STANDARD_INFREQUENT_ACCESS",
    };
    const importResult = await dynamodb(app, "ImportTable", {
      S3BucketSource: { S3Bucket: "imports", S3BucketOwner: "123456789012", S3KeyPrefix: "snapshots/" },
      InputFormat: "CSV",
      InputFormatOptions: { Csv: { Delimiter: "|", HeaderList: ["pk"] } },
      InputCompressionType: "GZIP",
      TableCreationParameters: tableCreationParameters,
    });
    const imported = (await importResult.json()) as {
      ImportTableDescription: { ImportArn: string; TableArn: string; StartTime: number; EndTime: number };
    };

    expect(imported).toMatchObject({
      ImportTableDescription: {
        ImportArn: expect.any(String),
        ImportStatus: "COMPLETED",
        TableArn: expect.stringContaining(":table/import-lifecycle"),
        TableId: expect.any(String),
        S3BucketSource: { S3Bucket: "imports", S3BucketOwner: "123456789012", S3KeyPrefix: "snapshots/" },
        InputFormat: "CSV",
        InputFormatOptions: { Csv: { Delimiter: "|", HeaderList: ["pk"] } },
        InputCompressionType: "GZIP",
        TableCreationParameters: tableCreationParameters,
        StartTime: expect.any(Number),
        EndTime: expect.any(Number),
        ProcessedSizeBytes: 0,
        ProcessedItemCount: 0,
        ImportedItemCount: 0,
        ErrorCount: 0,
      },
    });

    const described = await (
      await dynamodb(app, "DescribeImport", { ImportArn: imported.ImportTableDescription.ImportArn })
    ).json();
    expect(described).toMatchObject({
      ImportTableDescription: {
        InputCompressionType: "GZIP",
        InputFormatOptions: { Csv: { Delimiter: "|", HeaderList: ["pk"] } },
        TableCreationParameters: tableCreationParameters,
        StartTime: imported.ImportTableDescription.StartTime,
        EndTime: imported.ImportTableDescription.EndTime,
        ProcessedItemCount: 0,
        ImportedItemCount: 0,
        ErrorCount: 0,
      },
    });

    const listed = await (
      await dynamodb(app, "ListImports", { TableArn: imported.ImportTableDescription.TableArn })
    ).json();
    expect(listed).toMatchObject({
      ImportSummaryList: [
        {
          ImportArn: imported.ImportTableDescription.ImportArn,
          ImportStatus: "COMPLETED",
          TableArn: imported.ImportTableDescription.TableArn,
          S3BucketSource: { S3Bucket: "imports", S3BucketOwner: "123456789012", S3KeyPrefix: "snapshots/" },
          InputFormat: "CSV",
          StartTime: imported.ImportTableDescription.StartTime,
          EndTime: imported.ImportTableDescription.EndTime,
        },
      ],
    });
  });

  it("rejects modeled DynamoDB request shape mismatches", async () => {
    const invalidCreateTableList = await dynamodb(app, "CreateTable", {
      TableName: "bad-create-list",
      AttributeDefinitions: { AttributeName: "id", AttributeType: "S" },
      KeySchema: [{ AttributeName: "id", KeyType: "HASH" }],
    });
    expect(invalidCreateTableList.status).toBe(400);
    expect(await invalidCreateTableList.json()).toMatchObject({
      __type: expect.stringContaining("ValidationException"),
    });

    const invalidCreateTableEnum = await dynamodb(app, "CreateTable", {
      TableName: "bad-create-enum",
      AttributeDefinitions: [{ AttributeName: "id", AttributeType: "STRING" }],
      KeySchema: [{ AttributeName: "id", KeyType: "HASH" }],
    });
    expect(invalidCreateTableEnum.status).toBe(400);

    const invalidImport = await dynamodb(app, "ImportTable", {
      S3BucketSource: { S3Bucket: 123 },
      InputFormat: "JSON",
      TableCreationParameters: { TableName: "bad-import", ...tableSchema() },
    });
    expect(invalidImport.status).toBe(400);
    expect(await invalidImport.json()).toMatchObject({ __type: expect.stringContaining("ValidationException") });

    await dynamodb(app, "CreateTable", { TableName: "modeled", ...tableSchema("pk") });

    const invalidItemAttribute = await dynamodb(app, "PutItem", {
      TableName: "modeled",
      Item: { pk: { S: 123 } },
    });
    expect(invalidItemAttribute.status).toBe(400);

    const invalidItemList = await dynamodb(app, "PutItem", {
      TableName: "modeled",
      Item: { pk: { S: "a" }, values: { L: [{ S: "ok" }, "bad"] } },
    });
    expect(invalidItemList.status).toBe(400);

    const invalidReturnConsumedCapacity = await dynamodb(app, "PutItem", {
      TableName: "modeled",
      Item: { pk: { S: "a" } },
      ReturnConsumedCapacity: "VERBOSE",
    });
    expect(invalidReturnConsumedCapacity.status).toBe(400);

    const invalidTransactionAction = await dynamodb(app, "TransactWriteItems", {
      TransactItems: [
        {
          Put: { TableName: "modeled", Item: { pk: { S: "tx" } } },
          Delete: { TableName: "modeled", Key: { pk: { S: "tx" } } },
        },
      ],
    });
    expect(invalidTransactionAction.status).toBe(400);

    const invalidTransactionKey = await dynamodb(app, "TransactGetItems", {
      TransactItems: [{ Get: { TableName: "modeled", Key: { pk: { BOOL: "true" } } } }],
    });
    expect(invalidTransactionKey.status).toBe(400);

    const invalidTtl = await dynamodb(app, "UpdateTimeToLive", {
      TableName: "modeled",
      TimeToLiveSpecification: { AttributeName: "expires_at", Enabled: "true" },
    });
    expect(invalidTtl.status).toBe(400);

    const invalidContributorInsights = await dynamodb(app, "UpdateContributorInsights", {
      TableName: "modeled",
      ContributorInsightsAction: "START",
    });
    expect(invalidContributorInsights.status).toBe(400);

    const invalidTags = await dynamodb(app, "TagResource", {
      ResourceArn: "arn:aws:dynamodb:us-east-1:123456789012:table/modeled",
      Tags: [{ Key: "env", Value: 1 }],
    });
    expect(invalidTags.status).toBe(400);
  });

  it("models DynamoDB export lifecycle metadata", async () => {
    await dynamodb(app, "CreateTable", { TableName: "exports-source", ...tableSchema() });
    const tableArn = (
      (await (await dynamodb(app, "DescribeTable", { TableName: "exports-source" })).json()) as {
        Table: { TableArn: string };
      }
    ).Table.TableArn;
    await dynamodb(app, "PutItem", { TableName: "exports-source", Item: { id: { S: "a" }, name: { S: "Ada" } } });
    await dynamodb(app, "PutItem", { TableName: "exports-source", Item: { id: { S: "b" }, name: { S: "Bert" } } });

    const created = (await (
      await dynamodb(app, "ExportTableToPointInTime", {
        TableArn: tableArn,
        S3Bucket: "exports",
        S3Prefix: "snapshots/full",
        S3SseAlgorithm: "KMS",
        S3SseKmsKeyId: "arn:aws:kms:us-east-1:123456789012:key/local",
        ExportFormat: "ION",
        ExportType: "FULL_EXPORT",
      })
    ).json()) as { ExportDescription: { ExportArn: string; StartTime: number; EndTime: number } };

    expect(created).toMatchObject({
      ExportDescription: {
        ExportArn: expect.any(String),
        ExportStatus: "COMPLETED",
        ExportType: "FULL_EXPORT",
        TableArn: tableArn,
        S3Bucket: "exports",
        S3Prefix: "snapshots/full",
        S3SseAlgorithm: "KMS",
        S3SseKmsKeyId: "arn:aws:kms:us-east-1:123456789012:key/local",
        ExportFormat: "ION",
        ExportTime: expect.any(Number),
        StartTime: expect.any(Number),
        EndTime: expect.any(Number),
        BilledSizeBytes: 21,
        ItemCount: 2,
      },
    });
    expect(created.ExportDescription.EndTime).toBeGreaterThanOrEqual(created.ExportDescription.StartTime);
    expect(created.ExportDescription).not.toHaveProperty("FailureCode");
    expect(created.ExportDescription).not.toHaveProperty("FailureMessage");

    const described = await (
      await dynamodb(app, "DescribeExport", { ExportArn: created.ExportDescription.ExportArn })
    ).json();
    expect(described).toMatchObject(created);

    const listed = await (await dynamodb(app, "ListExports", { TableArn: tableArn })).json();
    expect(listed).toMatchObject({
      ExportSummaries: [
        {
          ExportArn: created.ExportDescription.ExportArn,
          ExportStatus: "COMPLETED",
          ExportType: "FULL_EXPORT",
        },
      ],
    });
  });

  it("filters and paginates DynamoDB metadata list APIs", async () => {
    await dynamodb(app, "CreateTable", { TableName: "page-a", ...tableSchema() });
    await dynamodb(app, "CreateTable", { TableName: "page-b", ...tableSchema() });
    const firstBackup = await dynamodb(app, "CreateBackup", { TableName: "page-a", BackupName: "backup-a" });
    await dynamodb(app, "CreateBackup", { TableName: "page-b", BackupName: "backup-b" });

    const backupPage = await (await dynamodb(app, "ListBackups", { Limit: 1 })).json();
    expect(backupPage).toMatchObject({ BackupSummaries: [expect.objectContaining({ BackupArn: expect.any(String) })] });
    expect((backupPage as { LastEvaluatedBackupArn?: string }).LastEvaluatedBackupArn).toBeDefined();
    const filteredBackups = await (await dynamodb(app, "ListBackups", { TableName: "page-a" })).json();
    expect(filteredBackups).toMatchObject({ BackupSummaries: [expect.objectContaining({ TableName: "page-a" })] });

    const tableArn = (
      (await (await dynamodb(app, "DescribeTable", { TableName: "page-a" })).json()) as { Table: { TableArn: string } }
    ).Table.TableArn;
    await dynamodb(app, "ExportTableToPointInTime", { TableArn: tableArn, S3Bucket: "exports" });
    const exportPage = await (await dynamodb(app, "ListExports", { TableArn: tableArn, MaxResults: 1 })).json();
    expect(exportPage).toMatchObject({
      ExportSummaries: [expect.objectContaining({ ExportArn: expect.any(String), ExportType: "FULL_EXPORT" })],
    });

    await dynamodb(app, "ImportTable", {
      S3BucketSource: { S3Bucket: "imports" },
      InputFormat: "DYNAMODB_JSON",
      TableCreationParameters: { TableName: "page-import", ...tableSchema() },
    });
    const imports = await (
      await dynamodb(app, "ListImports", { TableArnPrefix: tableArn.replace(/page-a$/, ""), PageSize: 1 })
    ).json();
    expect(imports).toMatchObject({ ImportSummaryList: [expect.objectContaining({ ImportArn: expect.any(String) })] });

    const backupArn = ((await firstBackup.json()) as { BackupDetails: { BackupArn: string } }).BackupDetails.BackupArn;
    await dynamodb(app, "DeleteBackup", { BackupArn: backupArn });
    const afterDelete = await (await dynamodb(app, "ListBackups", { TableName: "page-a" })).json();
    expect(afterDelete).toMatchObject({ BackupSummaries: [] });
  });

  it("applies restore overrides to restored table metadata", async () => {
    await dynamodb(app, "CreateTable", {
      TableName: "restore-source",
      AttributeDefinitions: [
        { AttributeName: "id", AttributeType: "S" },
        { AttributeName: "gsi", AttributeType: "S" },
      ],
      KeySchema: [{ AttributeName: "id", KeyType: "HASH" }],
      GlobalSecondaryIndexes: [
        {
          IndexName: "source-index",
          KeySchema: [{ AttributeName: "gsi", KeyType: "HASH" }],
          Projection: { ProjectionType: "ALL" },
        },
      ],
      BillingMode: "PAY_PER_REQUEST",
      TableClass: "STANDARD_INFREQUENT_ACCESS",
    });
    const backup = await dynamodb(app, "CreateBackup", {
      TableName: "restore-source",
      BackupName: "restore-source-backup",
    });
    const backupArn = ((await backup.json()) as { BackupDetails: { BackupArn: string } }).BackupDetails.BackupArn;

    await dynamodb(app, "RestoreTableFromBackup", {
      TargetTableName: "restore-target",
      BackupArn: backupArn,
      BillingModeOverride: "PROVISIONED",
      ProvisionedThroughputOverride: { ReadCapacityUnits: 5, WriteCapacityUnits: 6 },
      GlobalSecondaryIndexOverride: [],
      SSESpecificationOverride: { SSEType: "AES256" },
    });
    const restored = await (await dynamodb(app, "DescribeTable", { TableName: "restore-target" })).json();
    expect(restored).toMatchObject({
      Table: {
        BillingModeSummary: { BillingMode: "PROVISIONED" },
        ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 6 },
        SSEDescription: { SSEType: "AES256" },
        RestoreSummary: { SourceBackupArn: backupArn, RestoreInProgress: false },
      },
    });
    expect((restored as { Table: { GlobalSecondaryIndexes?: unknown } }).Table.GlobalSecondaryIndexes).toBeUndefined();
  });

  it("applies secondary index consistency, sparsity, projection, and consumed-capacity behavior", async () => {
    await dynamodb(app, "CreateTable", {
      TableName: "indexed",
      AttributeDefinitions: [
        { AttributeName: "pk", AttributeType: "S" },
        { AttributeName: "sk", AttributeType: "S" },
        { AttributeName: "lsi", AttributeType: "S" },
        { AttributeName: "gsi", AttributeType: "S" },
      ],
      KeySchema: [
        { AttributeName: "pk", KeyType: "HASH" },
        { AttributeName: "sk", KeyType: "RANGE" },
      ],
      LocalSecondaryIndexes: [
        {
          IndexName: "by-lsi",
          KeySchema: [
            { AttributeName: "pk", KeyType: "HASH" },
            { AttributeName: "lsi", KeyType: "RANGE" },
          ],
          Projection: { ProjectionType: "INCLUDE", NonKeyAttributes: ["included"] },
        },
      ],
      GlobalSecondaryIndexes: [
        {
          IndexName: "by-gsi",
          KeySchema: [{ AttributeName: "gsi", KeyType: "HASH" }],
          Projection: { ProjectionType: "KEYS_ONLY" },
        },
      ],
      BillingMode: "PAY_PER_REQUEST",
    });

    await dynamodb(app, "BatchWriteItem", {
      RequestItems: {
        indexed: [
          {
            PutRequest: {
              Item: {
                pk: { S: "a" },
                sk: { S: "1" },
                lsi: { S: "b" },
                gsi: { S: "x" },
                included: { S: "yes" },
                hidden: { S: "no" },
              },
            },
          },
          {
            PutRequest: {
              Item: { pk: { S: "a" }, sk: { S: "2" }, lsi: { S: "c" }, included: { S: "yes" }, hidden: { S: "no" } },
            },
          },
        ],
      },
    });

    const gsi = await dynamodb(app, "Query", {
      TableName: "indexed",
      IndexName: "by-gsi",
      KeyConditionExpression: "gsi = :gsi",
      ExpressionAttributeValues: { ":gsi": { S: "x" } },
      ReturnConsumedCapacity: "INDEXES",
    });
    expect(await gsi.json()).toMatchObject({
      Count: 1,
      Items: [{ pk: { S: "a" }, sk: { S: "1" }, gsi: { S: "x" } }],
      ConsumedCapacity: { TableName: "indexed", CapacityUnits: 1 },
    });

    const gsiConsistent = await dynamodb(app, "Query", {
      TableName: "indexed",
      IndexName: "by-gsi",
      KeyConditionExpression: "gsi = :gsi",
      ExpressionAttributeValues: { ":gsi": { S: "x" } },
      ConsistentRead: true,
    });
    expect(gsiConsistent.status).toBe(400);

    const lsi = await dynamodb(app, "Query", {
      TableName: "indexed",
      IndexName: "by-lsi",
      KeyConditionExpression: "pk = :pk",
      ExpressionAttributeValues: { ":pk": { S: "a" } },
      ConsistentRead: true,
    });
    expect(await lsi.json()).toMatchObject({
      Count: 2,
      Items: [
        { pk: { S: "a" }, sk: { S: "1" }, lsi: { S: "b" }, included: { S: "yes" } },
        { pk: { S: "a" }, sk: { S: "2" }, lsi: { S: "c" }, included: { S: "yes" } },
      ],
    });
    const lsiBody = (await (
      await dynamodb(app, "Query", {
        TableName: "indexed",
        IndexName: "by-lsi",
        KeyConditionExpression: "pk = :pk",
        ExpressionAttributeValues: { ":pk": { S: "a" } },
        ConsistentRead: true,
      })
    ).json()) as { Items: Array<Record<string, unknown>> };
    expect(lsiBody.Items[0]).not.toHaveProperty("hidden");
  });
});
