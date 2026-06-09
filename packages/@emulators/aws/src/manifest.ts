import type { ServiceManifest } from "@emulators/core";

/**
 * AWS's machine-readable service manifest. This is the single source of truth
 * for the AWS emulator's surfaces, auth, specs, seed shape, and copyable
 * connection snippets, consumed by the CLI registry, the Cloudflare host, and
 * the console.
 *
 * AWS exposes XML and Query protocol APIs rather than OpenAPI, so the implemented
 * operations are tracked under a hand-authored "manual" spec keyed by their AWS
 * action names (S3 verbs, SQS/IAM/STS Query actions).
 */
export const manifest: ServiceManifest = {
  id: "aws",
  name: "AWS",
  description: "Stateful AWS emulator for S3, SQS, IAM, and STS using AWS SDK-compatible request flows.",
  docsUrl: "https://docs.emulators.dev/aws",
  surfaces: [
    { id: "s3", kind: "provider-specific", title: "S3-compatible API", status: "partial", basePath: "/" },
    { id: "sqs", kind: "provider-specific", title: "SQS Query API", status: "partial", basePath: "/" },
    { id: "iam", kind: "provider-specific", title: "IAM Query API", status: "partial", basePath: "/iam" },
    { id: "sts", kind: "provider-specific", title: "STS Query API", status: "partial", basePath: "/sts" },
    { id: "inspector", kind: "ui", title: "Inspector UI", status: "supported", basePath: "/_inspector" },
  ],
  auth: [
    {
      id: "aws-credentials",
      title: "AWS SDK credentials",
      type: "provider-specific",
      status: "partial",
      notes:
        "The emulator accepts AWS SDK-style requests and seeded IAM access keys, but does not fully validate SigV4.",
    },
  ],
  specs: [
    {
      kind: "manual",
      title: "AWS S3, SQS, IAM, and STS subset",
      coverage: "hand-authored",
      notes: "AWS APIs use XML and Query protocols rather than OpenAPI. Operations are keyed by AWS action name.",
      operations: [
        // S3 (REST verbs)
        { operationId: "s3:ListBuckets", method: "GET", path: "/", status: "hand-authored" },
        { operationId: "s3:CreateBucket", method: "PUT", path: "/:bucket", status: "hand-authored" },
        { operationId: "s3:DeleteBucket", method: "DELETE", path: "/:bucket", status: "hand-authored" },
        { operationId: "s3:HeadBucket", method: "HEAD", path: "/:bucket", status: "hand-authored" },
        { operationId: "s3:ListObjectsV2", method: "GET", path: "/:bucket", status: "hand-authored" },
        { operationId: "s3:CreatePresignedPost", method: "POST", path: "/:bucket", status: "partial" },
        { operationId: "s3:PutObject", method: "PUT", path: "/:bucket/:key", status: "hand-authored" },
        { operationId: "s3:GetObject", method: "GET", path: "/:bucket/:key", status: "hand-authored" },
        { operationId: "s3:HeadObject", method: "HEAD", path: "/:bucket/:key", status: "hand-authored" },
        { operationId: "s3:DeleteObject", method: "DELETE", path: "/:bucket/:key", status: "hand-authored" },
        // SQS (Query API)
        { operationId: "sqs:CreateQueue", method: "POST", path: "/", status: "hand-authored" },
        { operationId: "sqs:DeleteQueue", method: "POST", path: "/", status: "hand-authored" },
        { operationId: "sqs:ListQueues", method: "POST", path: "/", status: "hand-authored" },
        { operationId: "sqs:GetQueueUrl", method: "POST", path: "/", status: "hand-authored" },
        { operationId: "sqs:GetQueueAttributes", method: "POST", path: "/", status: "hand-authored" },
        { operationId: "sqs:SendMessage", method: "POST", path: "/", status: "hand-authored" },
        { operationId: "sqs:ReceiveMessage", method: "POST", path: "/", status: "hand-authored" },
        { operationId: "sqs:DeleteMessage", method: "POST", path: "/", status: "hand-authored" },
        { operationId: "sqs:PurgeQueue", method: "POST", path: "/", status: "hand-authored" },
        // IAM (Query API)
        { operationId: "iam:CreateUser", method: "POST", path: "/iam", status: "hand-authored" },
        { operationId: "iam:GetUser", method: "POST", path: "/iam", status: "hand-authored" },
        { operationId: "iam:DeleteUser", method: "POST", path: "/iam", status: "hand-authored" },
        { operationId: "iam:ListUsers", method: "POST", path: "/iam", status: "hand-authored" },
        { operationId: "iam:CreateAccessKey", method: "POST", path: "/iam", status: "hand-authored" },
        { operationId: "iam:ListAccessKeys", method: "POST", path: "/iam", status: "hand-authored" },
        { operationId: "iam:DeleteAccessKey", method: "POST", path: "/iam", status: "hand-authored" },
        { operationId: "iam:CreateRole", method: "POST", path: "/iam", status: "hand-authored" },
        { operationId: "iam:GetRole", method: "POST", path: "/iam", status: "hand-authored" },
        { operationId: "iam:DeleteRole", method: "POST", path: "/iam", status: "hand-authored" },
        { operationId: "iam:ListRoles", method: "POST", path: "/iam", status: "hand-authored" },
        // STS (Query API)
        { operationId: "sts:GetCallerIdentity", method: "POST", path: "/sts", status: "hand-authored" },
        { operationId: "sts:AssumeRole", method: "POST", path: "/sts", status: "partial" },
      ],
    },
  ],
  seedSchema: {
    description: "Seed S3 buckets, SQS queues, and IAM users and roles, plus the account region.",
    fields: [
      {
        key: "region",
        title: "Default region",
        description: "Region applied to seeded resources.",
        example: "us-east-1",
      },
      { key: "account_id", title: "Account id", description: "AWS account id used in ARNs." },
      {
        key: "s3",
        title: "S3 buckets",
        description: "Buckets to create under the instance.",
        example: { buckets: [{ name: "my-app-bucket" }] },
      },
      {
        key: "sqs",
        title: "SQS queues",
        description: "Queues to create. FIFO is inferred from a .fifo suffix unless set.",
        example: { queues: [{ name: "my-app-events" }] },
      },
      {
        key: "iam",
        title: "IAM users and roles",
        description: "Users (optionally with an access key) and roles to provision.",
        example: {
          users: [{ user_name: "developer", create_access_key: true }],
          roles: [{ role_name: "lambda-execution-role", description: "Role for Lambda function execution" }],
        },
      },
    ],
    example: {
      region: "us-east-1",
      s3: { buckets: [{ name: "my-app-bucket" }, { name: "my-app-uploads" }] },
      sqs: { queues: [{ name: "my-app-events" }, { name: "my-app-dlq" }] },
      iam: {
        users: [{ user_name: "developer", create_access_key: true }],
        roles: [{ role_name: "lambda-execution-role", description: "Role for Lambda function execution" }],
      },
    },
  },
  stateModel: {
    description: "Entities mutated by AWS provider calls.",
    collections: [
      { name: "aws.s3_buckets" },
      { name: "aws.s3_objects" },
      { name: "aws.sqs_queues" },
      { name: "aws.sqs_messages" },
      { name: "aws.iam_users" },
      { name: "aws.iam_roles" },
    ],
  },
  connections: [
    {
      id: "s3-client",
      title: "AWS SDK v3 S3Client (TypeScript)",
      kind: "sdk",
      language: "typescript",
      description: "Point the S3 client at the emulator. forcePathStyle keeps bucket names in the path.",
      template:
        'import { S3Client } from "@aws-sdk/client-s3";\n\nconst s3 = new S3Client({\n  endpoint: "{{baseUrl}}",\n  region: "us-east-1",\n  forcePathStyle: true,\n  credentials: {\n    accessKeyId: "{{clientId}}",\n    secretAccessKey: "{{clientSecret}}",\n  },\n});',
    },
    {
      id: "sqs-client",
      title: "AWS SDK v3 SQSClient (TypeScript)",
      kind: "sdk",
      language: "typescript",
      description: "Point the SQS client at the emulator.",
      template:
        'import { SQSClient } from "@aws-sdk/client-sqs";\n\nconst sqs = new SQSClient({\n  endpoint: "{{baseUrl}}",\n  region: "us-east-1",\n  credentials: {\n    accessKeyId: "{{clientId}}",\n    secretAccessKey: "{{clientSecret}}",\n  },\n});',
    },
    {
      id: "aws-env",
      title: "AWS endpoint and credentials (env)",
      kind: "env",
      language: "bash",
      description: "The AWS SDK and CLI honor AWS_ENDPOINT_URL and the standard credential variables.",
      template:
        "AWS_ENDPOINT_URL={{baseUrl}}\nAWS_REGION=us-east-1\nAWS_ACCESS_KEY_ID={{clientId}}\nAWS_SECRET_ACCESS_KEY={{clientSecret}}",
    },
    {
      id: "curl",
      title: "curl",
      kind: "curl",
      language: "bash",
      description: "List S3 buckets directly against the emulator.",
      template: "curl -s {{baseUrl}}/",
    },
  ],
};
