import type { Hono } from "@emulators/core";
import type { ServicePlugin, Store, WebhookDispatcher, TokenMap, AppEnv, RouteContext } from "@emulators/core";
import { getAwsStore } from "./store.js";
import { getAccountId, getDefaultRegion, generateAwsId } from "./helpers.js";
import { s3Routes } from "./routes/s3.js";
import { sqsRoutes } from "./routes/sqs.js";
import { iamRoutes } from "./routes/iam.js";
import { dynamodbRoutes } from "./routes/dynamodb.js";
import { inspectorRoutes } from "./routes/inspector.js";

export { getAwsStore, type AwsStore } from "./store.js";
export * from "./entities.js";

export interface AwsSeedConfig {
  port?: number;
  region?: string;
  account_id?: string;
  s3?: {
    buckets?: Array<{
      name: string;
      region?: string;
    }>;
  };
  sqs?: {
    queues?: Array<{
      name: string;
      fifo?: boolean;
      visibility_timeout?: number;
    }>;
  };
  iam?: {
    users?: Array<{
      user_name: string;
      path?: string;
      create_access_key?: boolean;
    }>;
    roles?: Array<{
      role_name: string;
      path?: string;
      description?: string;
      assume_role_policy?: string;
    }>;
  };
  dynamodb?: {
    tables?: Array<{
      name: string;
      attribute_definitions?: Array<Record<string, unknown>>;
      key_schema?: Array<Record<string, string>>;
      local_secondary_indexes?: Array<Record<string, unknown>>;
      global_secondary_indexes?: Array<Record<string, unknown>>;
      billing_mode?: "PAY_PER_REQUEST" | "PROVISIONED";
      provisioned_throughput?: Record<string, unknown>;
      deletion_protection_enabled?: boolean;
      tags?: Array<{ Key: string; Value: string }>;
      ttl?: { AttributeName?: string; Enabled: boolean };
      resource_policy?: string;
      items?: Array<Record<string, Record<string, unknown>>>;
    }>;
  };
}

function seedDefaults(store: Store, baseUrl: string): void {
  const aws = getAwsStore(store);
  const accountId = getAccountId();
  const region = getDefaultRegion();

  // Create a default S3 bucket
  aws.s3Buckets.insert({
    bucket_name: "emulate-default",
    region,
    creation_date: new Date().toISOString(),
    acl: "private",
    versioning_enabled: false,
  });

  // Create a default SQS queue
  const queueName = "emulate-default-queue";
  aws.sqsQueues.insert({
    queue_name: queueName,
    queue_url: `${baseUrl}/sqs/${accountId}/${queueName}`,
    arn: `arn:aws:sqs:${region}:${accountId}:${queueName}`,
    visibility_timeout: 30,
    delay_seconds: 0,
    max_message_size: 262144,
    message_retention_period: 345600,
    receive_message_wait_time: 0,
    fifo: false,
  });

  // Create a default IAM user
  const userId = generateAwsId("AIDA");
  aws.iamUsers.insert({
    user_name: "admin",
    user_id: userId,
    arn: `arn:aws:iam::${accountId}:user/admin`,
    path: "/",
    access_keys: [
      {
        access_key_id: "AKIAIOSFODNN7EXAMPLE",
        secret_access_key: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
        status: "Active",
      },
    ],
  });

  aws.dynamodbTables.insert({
    table_name: "emulate-default",
    table_arn: `arn:aws:dynamodb:${region}:${accountId}:table/emulate-default`,
    table_id: generateAwsId("dynamodb-"),
    region,
    status: "ACTIVE",
    attribute_definitions: [{ AttributeName: "id", AttributeType: "S" }],
    key_schema: [{ AttributeName: "id", KeyType: "HASH" }],
    local_secondary_indexes: [],
    global_secondary_indexes: [],
    billing_mode: "PAY_PER_REQUEST",
    provisioned_throughput: { ReadCapacityUnits: 0, WriteCapacityUnits: 0 },
    deletion_protection_enabled: false,
    tags: [],
    point_in_time_recovery_enabled: false,
    contributor_insights_status: "DISABLED",
    kinesis_destinations: [],
  });
}

export function seedFromConfig(store: Store, baseUrl: string, config: AwsSeedConfig): void {
  const aws = getAwsStore(store);
  const accountId = getAccountId();
  const region = config.region ?? getDefaultRegion();

  if (config.s3?.buckets) {
    for (const b of config.s3.buckets) {
      const existing = aws.s3Buckets.findOneBy("bucket_name", b.name);
      if (existing) continue;

      aws.s3Buckets.insert({
        bucket_name: b.name,
        region: b.region ?? region,
        creation_date: new Date().toISOString(),
        acl: "private",
        versioning_enabled: false,
      });
    }
  }

  if (config.sqs?.queues) {
    for (const q of config.sqs.queues) {
      const existing = aws.sqsQueues.findOneBy("queue_name", q.name);
      if (existing) continue;

      const fifo = q.fifo ?? q.name.endsWith(".fifo");
      aws.sqsQueues.insert({
        queue_name: q.name,
        queue_url: `${baseUrl}/sqs/${accountId}/${q.name}`,
        arn: `arn:aws:sqs:${region}:${accountId}:${q.name}`,
        visibility_timeout: q.visibility_timeout ?? 30,
        delay_seconds: 0,
        max_message_size: 262144,
        message_retention_period: 345600,
        receive_message_wait_time: 0,
        fifo,
      });
    }
  }

  if (config.iam?.users) {
    for (const u of config.iam.users) {
      const existing = aws.iamUsers.findOneBy("user_name", u.user_name);
      if (existing) continue;

      const userId = generateAwsId("AIDA");
      const path = u.path ?? "/";
      const accessKeys = u.create_access_key
        ? [
            {
              access_key_id: "AKIA" + generateAwsId("").slice(0, 16),
              secret_access_key: generateAwsId("") + generateAwsId(""),
              status: "Active" as const,
            },
          ]
        : [];

      aws.iamUsers.insert({
        user_name: u.user_name,
        user_id: userId,
        arn: `arn:aws:iam::${accountId}:user${path}${u.user_name}`,
        path,
        access_keys: accessKeys,
      });
    }
  }

  if (config.iam?.roles) {
    for (const r of config.iam.roles) {
      const existing = aws.iamRoles.findOneBy("role_name", r.role_name);
      if (existing) continue;

      const roleId = generateAwsId("AROA");
      const path = r.path ?? "/";

      aws.iamRoles.insert({
        role_name: r.role_name,
        role_id: roleId,
        arn: `arn:aws:iam::${accountId}:role${path}${r.role_name}`,
        path,
        assume_role_policy_document: r.assume_role_policy ?? "{}",
        description: r.description ?? "",
      });
    }
  }

  if (config.dynamodb?.tables) {
    for (const t of config.dynamodb.tables) {
      const existing = aws.dynamodbTables.findOneBy("table_name", t.name);
      if (existing) continue;

      const table = aws.dynamodbTables.insert({
        table_name: t.name,
        table_arn: `arn:aws:dynamodb:${region}:${accountId}:table/${t.name}`,
        table_id: generateAwsId("dynamodb-"),
        region,
        status: "ACTIVE",
        attribute_definitions: t.attribute_definitions ?? [{ AttributeName: "id", AttributeType: "S" }],
        key_schema: t.key_schema ?? [{ AttributeName: "id", KeyType: "HASH" }],
        local_secondary_indexes: t.local_secondary_indexes ?? [],
        global_secondary_indexes: t.global_secondary_indexes ?? [],
        billing_mode: t.billing_mode ?? "PAY_PER_REQUEST",
        provisioned_throughput: t.provisioned_throughput ?? { ReadCapacityUnits: 0, WriteCapacityUnits: 0 },
        deletion_protection_enabled: t.deletion_protection_enabled ?? false,
        tags: t.tags ?? [],
        ttl: t.ttl,
        resource_policy: t.resource_policy,
        point_in_time_recovery_enabled: false,
        contributor_insights_status: "DISABLED",
        kinesis_destinations: [],
      });

      for (const item of t.items ?? []) {
        const key: Record<string, Record<string, unknown>> = {};
        for (const schema of table.key_schema) key[schema.AttributeName] = item[schema.AttributeName];
        aws.dynamodbItems.insert({
          table_name: table.table_name,
          item_key: `${table.table_name}:${canonicalJson(key)}`,
          item,
        });
      }
    }
  }
}

export const awsPlugin: ServicePlugin = {
  name: "aws",
  register(app: Hono<AppEnv>, store: Store, webhooks: WebhookDispatcher, baseUrl: string, tokenMap?: TokenMap): void {
    const ctx: RouteContext = { app, store, webhooks, baseUrl, tokenMap };
    // Register inspector and service-specific routes first (static paths),
    // then S3 last since its routes use wildcard path params (/:bucket, /:bucket/:key)
    inspectorRoutes(ctx);
    dynamodbRoutes(ctx);
    sqsRoutes(ctx);
    iamRoutes(ctx);
    s3Routes(ctx);
  },
  seed(store: Store, baseUrl: string): void {
    seedDefaults(store, baseUrl);
  },
};

export default awsPlugin;

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
