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
import {
  SQSClient,
  ListQueuesCommand,
  CreateQueueCommand as CreateSQSQueueCommand,
  GetQueueUrlCommand,
  GetQueueAttributesCommand,
  SendMessageCommand,
  ReceiveMessageCommand,
  DeleteMessageCommand,
  PurgeQueueCommand,
  DeleteQueueCommand as DeleteSQSQueueCommand,
} from "@aws-sdk/client-sqs";
import { createPresignedPost } from "@aws-sdk/s3-presigned-post";
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

const describeExternalSqsE2E = process.env.AWS_EMULATOR_E2E_URL ? describe : describe.skip;

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

describeExternalSqsE2E("AWS plugin - real @aws-sdk/client-sqs E2E", () => {
  let emulator: EmulatorHandle;
  let sqs: SQSClient;

  beforeAll(async () => {
    emulator = await startEmulator();
    sqs = new SQSClient({
      endpoint: `${emulator.url.replace(/\/$/, "")}/sqs/`,
      region: "us-east-1",
      credentials: { accessKeyId: "AKIA", secretAccessKey: "secret" },
    });
  });

  afterAll(async () => {
    sqs.destroy();
    await emulator.close();
  });

  it("ListQueues returns the seeded default queue", async () => {
    const res = await sqs.send(new ListQueuesCommand({}));
    expect(res.QueueUrls ?? []).toEqual(expect.arrayContaining([expect.stringContaining("emulate-default-queue")]));
  });

  it("CreateQueue, GetQueueUrl, GetQueueAttributes, and DeleteQueue roundtrip", async () => {
    const created = await sqs.send(
      new CreateSQSQueueCommand({
        QueueName: "sdk-e2e-queue",
        Attributes: { VisibilityTimeout: "45" },
      }),
    );
    expect(created.QueueUrl).toContain("sdk-e2e-queue");

    const byName = await sqs.send(new GetQueueUrlCommand({ QueueName: "sdk-e2e-queue" }));
    expect(byName.QueueUrl).toBe(created.QueueUrl);

    const attrs = await sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: created.QueueUrl,
        AttributeNames: ["All"],
      }),
    );
    expect(attrs.Attributes?.QueueArn).toContain("sdk-e2e-queue");
    expect(attrs.Attributes?.VisibilityTimeout).toBe("45");

    const listed = await sqs.send(new ListQueuesCommand({ QueueNamePrefix: "sdk-e2e-" }));
    expect(listed.QueueUrls ?? []).toContain(created.QueueUrl);

    await sqs.send(new DeleteSQSQueueCommand({ QueueUrl: created.QueueUrl }));
    const afterDelete = await sqs.send(new ListQueuesCommand({ QueueNamePrefix: "sdk-e2e-queue" }));
    expect(afterDelete.QueueUrls ?? []).not.toContain(created.QueueUrl);
  });

  it("SendMessage, ReceiveMessage, and DeleteMessage roundtrip", async () => {
    const { QueueUrl } = await sqs.send(new CreateSQSQueueCommand({ QueueName: "sdk-e2e-messages" }));
    expect(QueueUrl).toBeTruthy();

    const sent = await sqs.send(
      new SendMessageCommand({
        QueueUrl,
        MessageBody: "hello from sqs sdk",
        MessageAttributes: { color: { DataType: "String", StringValue: "blue" } },
      }),
    );
    expect(sent.MessageId).toBeTruthy();
    expect(sent.MD5OfMessageBody).toBeTruthy();
    expect(sent.MD5OfMessageAttributes).toBeTruthy();

    const received = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl,
        MaxNumberOfMessages: 1,
        MessageAttributeNames: ["All"],
        MessageSystemAttributeNames: ["All"],
      }),
    );
    expect(received.Messages).toHaveLength(1);
    expect(received.Messages?.[0]?.Body).toBe("hello from sqs sdk");
    expect(received.Messages?.[0]?.ReceiptHandle).toBeTruthy();
    expect(received.Messages?.[0]?.Attributes?.SenderId).toBe("123456789012");
    expect(received.Messages?.[0]?.MD5OfMessageAttributes).toBe(sent.MD5OfMessageAttributes);
    expect(received.Messages?.[0]?.MessageAttributes?.color?.StringValue).toBe("blue");

    await sqs.send(new DeleteMessageCommand({ QueueUrl, ReceiptHandle: received.Messages?.[0]?.ReceiptHandle }));
    const afterDelete = await sqs.send(new ReceiveMessageCommand({ QueueUrl, MaxNumberOfMessages: 1 }));
    expect(afterDelete.Messages ?? []).toHaveLength(0);

    await sqs.send(new DeleteSQSQueueCommand({ QueueUrl }));
  });

  it("SendMessage DelaySeconds keeps a message hidden initially", async () => {
    const { QueueUrl } = await sqs.send(new CreateSQSQueueCommand({ QueueName: "sdk-e2e-delay" }));
    expect(QueueUrl).toBeTruthy();

    await sqs.send(new SendMessageCommand({ QueueUrl, MessageBody: "not yet", DelaySeconds: 5 }));

    const received = await sqs.send(new ReceiveMessageCommand({ QueueUrl, MaxNumberOfMessages: 1 }));
    expect(received.Messages ?? []).toHaveLength(0);

    await sqs.send(new DeleteSQSQueueCommand({ QueueUrl }));
  });

  it("PurgeQueue removes visible messages", async () => {
    const { QueueUrl } = await sqs.send(new CreateSQSQueueCommand({ QueueName: "sdk-e2e-purge" }));
    expect(QueueUrl).toBeTruthy();

    await sqs.send(new SendMessageCommand({ QueueUrl, MessageBody: "one" }));
    await sqs.send(new SendMessageCommand({ QueueUrl, MessageBody: "two" }));
    await sqs.send(new PurgeQueueCommand({ QueueUrl }));

    const received = await sqs.send(new ReceiveMessageCommand({ QueueUrl, MaxNumberOfMessages: 10 }));
    expect(received.Messages ?? []).toHaveLength(0);

    await sqs.send(new DeleteSQSQueueCommand({ QueueUrl }));
  });
});
