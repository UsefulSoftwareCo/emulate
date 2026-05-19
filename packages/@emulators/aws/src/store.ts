import { Store, type Collection } from "@emulators/core";
import type {
  S3Bucket,
  S3Object,
  SqsQueue,
  SqsMessage,
  IamUser,
  IamRole,
  DynamoDbTable,
  DynamoDbStoredItem,
  DynamoDbBackup,
  DynamoDbExport,
  DynamoDbImport,
  DynamoDbGlobalTable,
} from "./entities.js";

export interface AwsStore {
  s3Buckets: Collection<S3Bucket>;
  s3Objects: Collection<S3Object>;
  sqsQueues: Collection<SqsQueue>;
  sqsMessages: Collection<SqsMessage>;
  iamUsers: Collection<IamUser>;
  iamRoles: Collection<IamRole>;
  dynamodbTables: Collection<DynamoDbTable>;
  dynamodbItems: Collection<DynamoDbStoredItem>;
  dynamodbBackups: Collection<DynamoDbBackup>;
  dynamodbExports: Collection<DynamoDbExport>;
  dynamodbImports: Collection<DynamoDbImport>;
  dynamodbGlobalTables: Collection<DynamoDbGlobalTable>;
}

export function getAwsStore(store: Store): AwsStore {
  return {
    s3Buckets: store.collection<S3Bucket>("aws.s3_buckets", ["bucket_name"]),
    s3Objects: store.collection<S3Object>("aws.s3_objects", ["key", "bucket_name"]),
    sqsQueues: store.collection<SqsQueue>("aws.sqs_queues", ["queue_name", "queue_url"]),
    sqsMessages: store.collection<SqsMessage>("aws.sqs_messages", ["message_id", "queue_name"]),
    iamUsers: store.collection<IamUser>("aws.iam_users", ["user_name", "user_id"]),
    iamRoles: store.collection<IamRole>("aws.iam_roles", ["role_name", "role_id"]),
    dynamodbTables: store.collection<DynamoDbTable>("aws.dynamodb_tables", ["table_name", "table_arn"]),
    dynamodbItems: store.collection<DynamoDbStoredItem>("aws.dynamodb_items", ["table_name", "item_key"]),
    dynamodbBackups: store.collection<DynamoDbBackup>("aws.dynamodb_backups", ["backup_name", "backup_arn", "table_name"]),
    dynamodbExports: store.collection<DynamoDbExport>("aws.dynamodb_exports", ["export_arn", "table_arn"]),
    dynamodbImports: store.collection<DynamoDbImport>("aws.dynamodb_imports", ["import_arn", "table_name"]),
    dynamodbGlobalTables: store.collection<DynamoDbGlobalTable>("aws.dynamodb_global_tables", [
      "global_table_name",
      "global_table_arn",
    ]),
  };
}
