import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { serve } from "@emulators/core";
import type { AddressInfo } from "node:net";
import {
  S3Client,
  ListBucketsCommand,
  HeadBucketCommand,
  CreateBucketCommand,
  DeleteBucketCommand,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  CopyObjectCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import { createPresignedPost } from "@aws-sdk/s3-presigned-post";
import {
  DynamoDBClient,
  BatchGetItemCommand,
  BatchWriteItemCommand,
  CreateBackupCommand,
  CreateTableCommand,
  DeleteItemCommand,
  DescribeContinuousBackupsCommand,
  DescribeTableCommand,
  DescribeTimeToLiveCommand,
  ExecuteStatementCommand,
  GetItemCommand,
  ListTablesCommand,
  PutItemCommand,
  QueryCommand,
  RestoreTableFromBackupCommand,
  ScanCommand,
  TagResourceCommand,
  TransactWriteItemsCommand,
  UpdateContinuousBackupsCommand,
  UpdateItemCommand,
  UpdateTimeToLiveCommand,
} from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { createTestApp } from "./helpers.js";

type EmulatorHandle = { url: string; close: () => Promise<void> };

async function startEmulator(): Promise<EmulatorHandle> {
  const override = process.env.AWS_EMULATOR_E2E_URL;
  if (override) {
    return { url: override, close: async () => {} };
  }

  const { app } = createTestApp();
  const server = serve({ fetch: app.fetch, port: 0 });
  await new Promise<void>((resolve, reject) => {
    server.once("listening", () => resolve());
    server.once("error", reject);
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

async function streamToString(stream: unknown): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream as AsyncIterable<Uint8Array>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString();
}

describe("AWS plugin - real @aws-sdk/client-s3 E2E", () => {
  let emulator: EmulatorHandle;
  let s3: S3Client;

  beforeAll(async () => {
    emulator = await startEmulator();
    s3 = new S3Client({
      endpoint: emulator.url,
      region: "us-east-1",
      forcePathStyle: true,
      credentials: { accessKeyId: "AKIA", secretAccessKey: "secret" },
    });
  });

  afterAll(async () => {
    s3.destroy();
    await emulator.close();
  });

  it("ListBuckets returns the seeded default bucket", async () => {
    const res = await s3.send(new ListBucketsCommand({}));
    const names = (res.Buckets ?? []).map((b) => b.Name);
    expect(names).toContain("emulate-default");
  });

  it("HeadBucket succeeds for an existing bucket", async () => {
    await expect(s3.send(new HeadBucketCommand({ Bucket: "emulate-default" }))).resolves.toBeDefined();
  });

  it("CreateBucket and DeleteBucket roundtrip", async () => {
    await s3.send(new CreateBucketCommand({ Bucket: "sdk-e2e-create" }));
    const after = await s3.send(new ListBucketsCommand({}));
    expect((after.Buckets ?? []).map((b) => b.Name)).toContain("sdk-e2e-create");
    await s3.send(new DeleteBucketCommand({ Bucket: "sdk-e2e-create" }));
    const final = await s3.send(new ListBucketsCommand({}));
    expect((final.Buckets ?? []).map((b) => b.Name)).not.toContain("sdk-e2e-create");
  });

  it("PutObject / GetObject / HeadObject roundtrip with correct Last-Modified", async () => {
    await s3.send(
      new PutObjectCommand({
        Bucket: "emulate-default",
        Key: "e2e/put-get.txt",
        Body: "hello via sdk",
        ContentType: "text/plain",
      }),
    );

    const get = await s3.send(new GetObjectCommand({ Bucket: "emulate-default", Key: "e2e/put-get.txt" }));
    expect(get.ContentType).toBe("text/plain");
    expect(get.LastModified).toBeInstanceOf(Date);
    expect(await streamToString(get.Body)).toBe("hello via sdk");

    const head = await s3.send(new HeadObjectCommand({ Bucket: "emulate-default", Key: "e2e/put-get.txt" }));
    expect(head.ContentType).toBe("text/plain");
    expect(head.LastModified).toBeInstanceOf(Date);
  });

  it("CopyObject preserves body and returns a parseable response", async () => {
    await s3.send(
      new PutObjectCommand({
        Bucket: "emulate-default",
        Key: "e2e/copy-src.txt",
        Body: "copy me",
        ContentType: "text/plain",
      }),
    );

    const copy = await s3.send(
      new CopyObjectCommand({
        Bucket: "emulate-default",
        Key: "e2e/copy-dst.txt",
        CopySource: "/emulate-default/e2e/copy-src.txt",
      }),
    );
    expect(copy.CopyObjectResult).toBeDefined();

    const get = await s3.send(new GetObjectCommand({ Bucket: "emulate-default", Key: "e2e/copy-dst.txt" }));
    expect(await streamToString(get.Body)).toBe("copy me");
  });

  it("DeleteObject removes the object", async () => {
    await s3.send(
      new PutObjectCommand({
        Bucket: "emulate-default",
        Key: "e2e/to-delete.txt",
        Body: "bye",
        ContentType: "text/plain",
      }),
    );
    await s3.send(new DeleteObjectCommand({ Bucket: "emulate-default", Key: "e2e/to-delete.txt" }));
    await expect(
      s3.send(new GetObjectCommand({ Bucket: "emulate-default", Key: "e2e/to-delete.txt" })),
    ).rejects.toMatchObject({ name: "NoSuchKey" });
  });

  it("ListObjectsV2 paginates with MaxKeys and ContinuationToken", async () => {
    await s3.send(new CreateBucketCommand({ Bucket: "sdk-e2e-pages" }));
    await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        s3.send(
          new PutObjectCommand({
            Bucket: "sdk-e2e-pages",
            Key: `page-${String(i).padStart(2, "0")}.txt`,
            Body: String(i),
          }),
        ),
      ),
    );

    const page1 = await s3.send(new ListObjectsV2Command({ Bucket: "sdk-e2e-pages", MaxKeys: 2 }));
    expect(page1.IsTruncated).toBe(true);
    expect(page1.Contents).toHaveLength(2);
    expect(page1.NextContinuationToken).toBeTruthy();

    const page2 = await s3.send(
      new ListObjectsV2Command({
        Bucket: "sdk-e2e-pages",
        MaxKeys: 2,
        ContinuationToken: page1.NextContinuationToken,
      }),
    );
    expect(page2.Contents).toHaveLength(2);

    const page3 = await s3.send(
      new ListObjectsV2Command({
        Bucket: "sdk-e2e-pages",
        MaxKeys: 2,
        ContinuationToken: page2.NextContinuationToken,
      }),
    );
    expect(page3.IsTruncated).toBe(false);
    expect(page3.Contents).toHaveLength(1);
  });

  it("ListObjectsV2 honors StartAfter", async () => {
    const res = await s3.send(
      new ListObjectsV2Command({
        Bucket: "sdk-e2e-pages",
        Prefix: "page-",
        StartAfter: "page-02.txt",
      }),
    );
    const keys = (res.Contents ?? []).map((o) => o.Key);
    expect(keys).not.toContain("page-00.txt");
    expect(keys).not.toContain("page-01.txt");
    expect(keys).not.toContain("page-02.txt");
    expect(keys).toContain("page-03.txt");
    expect(keys).toContain("page-04.txt");
  });

  it("createPresignedPost uploads a file", async () => {
    const post = await createPresignedPost(s3, {
      Bucket: "emulate-default",
      Key: "e2e/presigned-upload.txt",
      Conditions: [
        ["content-length-range", 0, 1024],
        ["starts-with", "$Content-Type", "text/"],
      ],
      Expires: 60,
    });

    const form = new FormData();
    for (const [k, v] of Object.entries(post.fields)) {
      form.append(k, v);
    }
    form.append("Content-Type", "text/plain");
    form.append("file", new Blob(["hello from presigned post"], { type: "text/plain" }), "upload.txt");

    const res = await fetch(post.url, { method: "POST", body: form });
    expect(res.status).toBe(204);

    const get = await s3.send(new GetObjectCommand({ Bucket: "emulate-default", Key: "e2e/presigned-upload.txt" }));
    expect(await streamToString(get.Body)).toBe("hello from presigned post");
  });

  it("createPresignedPost enforces content-length-range", async () => {
    const post = await createPresignedPost(s3, {
      Bucket: "emulate-default",
      Key: "e2e/too-big.bin",
      Conditions: [["content-length-range", 0, 5]],
      Expires: 60,
    });

    const form = new FormData();
    for (const [k, v] of Object.entries(post.fields)) {
      form.append(k, v);
    }
    form.append("file", new Blob(["this payload is definitely larger than five bytes"]));

    const res = await fetch(post.url, { method: "POST", body: form });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("EntityTooLarge");
  });
});

describe("AWS plugin - real @aws-sdk/client-dynamodb E2E", () => {
  let emulator: EmulatorHandle;
  let dynamodb: DynamoDBClient;
  let documentClient: DynamoDBDocumentClient;

  beforeAll(async () => {
    emulator = await startEmulator();
    dynamodb = new DynamoDBClient({
      endpoint: emulator.url,
      region: "us-east-1",
      credentials: { accessKeyId: "AKIA", secretAccessKey: "secret" },
    });
    documentClient = DynamoDBDocumentClient.from(dynamodb);
  });

  afterAll(async () => {
    dynamodb.destroy();
    await emulator.close();
  });

  it("creates, lists, and describes a table", async () => {
    await dynamodb.send(
      new CreateTableCommand({
        TableName: "sdk-users",
        AttributeDefinitions: [
          { AttributeName: "pk", AttributeType: "S" },
          { AttributeName: "sk", AttributeType: "S" },
        ],
        KeySchema: [
          { AttributeName: "pk", KeyType: "HASH" },
          { AttributeName: "sk", KeyType: "RANGE" },
        ],
        BillingMode: "PAY_PER_REQUEST",
      }),
    );

    const list = await dynamodb.send(new ListTablesCommand({}));
    expect(list.TableNames).toContain("sdk-users");

    const description = await dynamodb.send(new DescribeTableCommand({ TableName: "sdk-users" }));
    expect(description.Table?.TableArn).toContain(":table/sdk-users");
  });

  it("roundtrips low-level and document client items", async () => {
    await dynamodb.send(
      new PutItemCommand({
        TableName: "sdk-users",
        Item: { pk: { S: "tenant-a" }, sk: { S: "one" }, count: { N: "1" } },
        ConditionExpression: "attribute_not_exists(pk)",
      }),
    );

    const updated = await dynamodb.send(
      new UpdateItemCommand({
        TableName: "sdk-users",
        Key: { pk: { S: "tenant-a" }, sk: { S: "one" } },
        UpdateExpression: "SET #count = #count + :inc",
        ExpressionAttributeNames: { "#count": "count" },
        ExpressionAttributeValues: { ":inc": { N: "4" } },
        ReturnValues: "ALL_NEW",
      }),
    );
    expect(updated.Attributes?.count?.N).toBe("5");

    const got = await dynamodb.send(
      new GetItemCommand({
        TableName: "sdk-users",
        Key: { pk: { S: "tenant-a" }, sk: { S: "one" } },
      }),
    );
    expect(got.Item?.count?.N).toBe("5");

    const documentClientForTest = documentClient as { send(command: unknown): Promise<{ Item?: Record<string, unknown> }> };
    await documentClientForTest.send(
      new PutCommand({ TableName: "sdk-users", Item: { pk: "tenant-a", sk: "doc", name: "Doc" } }) as never,
    );
    const doc = await documentClientForTest.send(
      new GetCommand({ TableName: "sdk-users", Key: { pk: "tenant-a", sk: "doc" } }) as never,
    );
    expect(doc.Item).toMatchObject({ name: "Doc" });

    await dynamodb.send(
      new DeleteItemCommand({
        TableName: "sdk-users",
        Key: { pk: { S: "tenant-a" }, sk: { S: "one" } },
      }),
    );
    const deleted = await dynamodb.send(
      new GetItemCommand({
        TableName: "sdk-users",
        Key: { pk: { S: "tenant-a" }, sk: { S: "one" } },
      }),
    );
    expect(deleted.Item).toBeUndefined();
  });

  it("roundtrips DocumentClient marshalling edge cases", async () => {
    const documentClientForTest = documentClient as { send(command: unknown): Promise<{ Item?: Record<string, unknown> }> };

    await documentClientForTest.send(
      new PutCommand({
        TableName: "sdk-users",
        Item: { pk: "tenant-a", sk: "doc-undefined", omitted: undefined },
      }) as never,
    );
    const undefinedResult = await documentClientForTest.send(
      new GetCommand({ TableName: "sdk-users", Key: { pk: "tenant-a", sk: "doc-undefined" } }) as never,
    );
    expect(undefinedResult.Item).not.toHaveProperty("omitted");

    const removingUndefinedClient = DynamoDBDocumentClient.from(dynamodb, {
      marshallOptions: { removeUndefinedValues: true },
    }) as { send(command: unknown): Promise<{ Item?: Record<string, unknown> }> };

    await removingUndefinedClient.send(
      new PutCommand({
        TableName: "sdk-users",
        Item: {
          pk: "tenant-a",
          sk: "doc-types",
          empty: "",
          nil: null,
          binary: new Uint8Array([1, 2, 3]),
          stringSet: new Set(["red", "blue"]),
          numberSet: new Set([1, 2]),
          nested: { list: ["x", null, { ok: true }], omitted: undefined },
        },
      }) as never,
    );

    const result = await removingUndefinedClient.send(
      new GetCommand({ TableName: "sdk-users", Key: { pk: "tenant-a", sk: "doc-types" } }) as never,
    );
    const item = result.Item!;
    expect(item.empty).toBe("");
    expect(item.nil).toBeNull();
    expect(Array.from(item.binary as Uint8Array)).toEqual([1, 2, 3]);
    expect(Array.from(item.stringSet as Set<string>).sort()).toEqual(["blue", "red"]);
    expect(Array.from(item.numberSet as Set<number>).sort()).toEqual([1, 2]);
    expect(item.nested).toEqual({ list: ["x", null, { ok: true }] });
    expect(item).not.toHaveProperty("omitted");
  });

  it("roundtrips low-level AttributeValue edge cases", async () => {
    await dynamodb.send(
      new CreateTableCommand({
        TableName: "sdk-attribute-values",
        AttributeDefinitions: [{ AttributeName: "pk", AttributeType: "S" }],
        KeySchema: [{ AttributeName: "pk", KeyType: "HASH" }],
        BillingMode: "PAY_PER_REQUEST",
      }),
    );

    await dynamodb.send(
      new PutItemCommand({
        TableName: "sdk-attribute-values",
        Item: {
          pk: { S: "types" },
          binary: { B: new Uint8Array([1, 2, 3]) },
          binarySet: { BS: [new Uint8Array([4, 5]), new Uint8Array([6])] },
          bool: { BOOL: true },
          nil: { NULL: true },
          strings: { SS: ["red", "blue"] },
          numbers: { NS: ["1", "2.5"] },
          nested: {
            M: {
              list: { L: [{ S: "x" }, { N: "7" }, { BOOL: false }] },
            },
          },
        },
      }),
    );

    const got = await dynamodb.send(
      new GetItemCommand({
        TableName: "sdk-attribute-values",
        Key: { pk: { S: "types" } },
      }),
    );
    expect(Array.from(got.Item?.binary?.B as Uint8Array)).toEqual([1, 2, 3]);
    expect((got.Item?.binarySet?.BS ?? []).map((value) => Array.from(value as Uint8Array))).toEqual([[4, 5], [6]]);
    expect(got.Item?.bool?.BOOL).toBe(true);
    expect(got.Item?.nil?.NULL).toBe(true);
    expect(got.Item?.strings?.SS?.sort()).toEqual(["blue", "red"]);
    expect(got.Item?.numbers?.NS?.sort()).toEqual(["1", "2.5"]);
    expect(got.Item?.nested?.M?.list?.L).toMatchObject([{ S: "x" }, { N: "7" }, { BOOL: false }]);
  });

  it("supports query, scan, batch, transactions, PartiQL, tags, TTL, PITR, and backup restore", async () => {
    await dynamodb.send(
      new BatchWriteItemCommand({
        RequestItems: {
          "sdk-users": [
            { PutRequest: { Item: { pk: { S: "tenant-b" }, sk: { S: "one" }, score: { N: "10" } } } },
            { PutRequest: { Item: { pk: { S: "tenant-b" }, sk: { S: "two" }, score: { N: "20" } } } },
          ],
        },
      }),
    );

    const query = await dynamodb.send(
      new QueryCommand({
        TableName: "sdk-users",
        KeyConditionExpression: "pk = :pk",
        ExpressionAttributeValues: { ":pk": { S: "tenant-b" } },
      }),
    );
    expect(query.Count).toBe(2);

    const scan = await dynamodb.send(
      new ScanCommand({
        TableName: "sdk-users",
        FilterExpression: "score >= :score",
        ExpressionAttributeValues: { ":score": { N: "20" } },
      }),
    );
    expect(scan.Count).toBe(1);

    const batch = await dynamodb.send(
      new BatchGetItemCommand({
        RequestItems: {
          "sdk-users": { Keys: [{ pk: { S: "tenant-b" }, sk: { S: "one" } }] },
        },
      }),
    );
    expect(batch.Responses?.["sdk-users"]).toHaveLength(1);

    await dynamodb.send(
      new TransactWriteItemsCommand({
        TransactItems: [
          {
            Put: {
              TableName: "sdk-users",
              Item: { pk: { S: "tenant-c" }, sk: { S: "tx" } },
              ConditionExpression: "attribute_not_exists(pk)",
            },
          },
        ],
      }),
    );

    const partiql = await dynamodb.send(
      new ExecuteStatementCommand({
        Statement: 'SELECT * FROM "sdk-users" WHERE pk = ?',
        Parameters: [{ S: "tenant-b" }],
      }),
    );
    expect(partiql.Items).toHaveLength(2);

    const described = await dynamodb.send(new DescribeTableCommand({ TableName: "sdk-users" }));
    await dynamodb.send(new TagResourceCommand({ ResourceArn: described.Table!.TableArn!, Tags: [{ Key: "suite", Value: "e2e" }] }));

    await dynamodb.send(
      new UpdateTimeToLiveCommand({
        TableName: "sdk-users",
        TimeToLiveSpecification: { AttributeName: "expiresAt", Enabled: true },
      }),
    );
    const ttl = await dynamodb.send(new DescribeTimeToLiveCommand({ TableName: "sdk-users" }));
    expect(ttl.TimeToLiveDescription?.TimeToLiveStatus).toBe("ENABLED");

    await dynamodb.send(
      new UpdateContinuousBackupsCommand({
        TableName: "sdk-users",
        PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
      }),
    );
    const backups = await dynamodb.send(new DescribeContinuousBackupsCommand({ TableName: "sdk-users" }));
    expect(backups.ContinuousBackupsDescription?.PointInTimeRecoveryDescription?.PointInTimeRecoveryStatus).toBe("ENABLED");

    const backup = await dynamodb.send(new CreateBackupCommand({ TableName: "sdk-users", BackupName: "sdk-users-backup" }));
    await dynamodb.send(
      new RestoreTableFromBackupCommand({
        BackupArn: backup.BackupDetails!.BackupArn!,
        TargetTableName: "sdk-users-restored",
      }),
    );
    const restored = await dynamodb.send(new DescribeTableCommand({ TableName: "sdk-users-restored" }));
    expect(restored.Table?.TableName).toBe("sdk-users-restored");
  });
});
