import type { Entity } from "@emulators/core";

export interface S3Bucket extends Entity {
  bucket_name: string;
  region: string;
  creation_date: string;
  acl: "private" | "public-read" | "public-read-write";
  versioning_enabled: boolean;
}

export interface S3Object extends Entity {
  bucket_name: string;
  key: string;
  body: string;
  content_type: string;
  content_length: number;
  etag: string;
  last_modified: string;
  metadata: Record<string, string>;
  version_id?: string;
}

export interface SqsQueue extends Entity {
  queue_name: string;
  queue_url: string;
  arn: string;
  visibility_timeout: number;
  delay_seconds: number;
  max_message_size: number;
  message_retention_period: number;
  receive_message_wait_time: number;
  fifo: boolean;
}

export interface SqsMessage extends Entity {
  queue_name: string;
  message_id: string;
  receipt_handle: string;
  body: string;
  md5_of_body: string;
  attributes: Record<string, string>;
  message_attributes: Record<string, { DataType: string; StringValue?: string; BinaryValue?: string }>;
  visible_after: number;
  sent_timestamp: number;
  receive_count: number;
}

export interface IamUser extends Entity {
  user_name: string;
  user_id: string;
  arn: string;
  path: string;
  access_keys: Array<{ access_key_id: string; secret_access_key: string; status: "Active" | "Inactive" }>;
}

export interface IamRole extends Entity {
  role_name: string;
  role_id: string;
  arn: string;
  path: string;
  assume_role_policy_document: string;
  description: string;
}

export type DynamoDbAttributeValue = Record<string, unknown>;
export type DynamoDbItem = Record<string, DynamoDbAttributeValue>;

export interface DynamoDbTable extends Entity {
  table_name: string;
  table_arn: string;
  table_id: string;
  region: string;
  status: "CREATING" | "ACTIVE" | "UPDATING" | "DELETING";
  delete_after_observation?: boolean;
  attribute_definitions: Array<Record<string, unknown>>;
  key_schema: Array<Record<string, string>>;
  local_secondary_indexes: Array<Record<string, unknown>>;
  global_secondary_indexes: Array<Record<string, unknown>>;
  billing_mode: "PAY_PER_REQUEST" | "PROVISIONED";
  provisioned_throughput: Record<string, unknown>;
  on_demand_throughput?: Record<string, unknown>;
  warm_throughput?: Record<string, unknown>;
  table_class?: string;
  deletion_protection_enabled: boolean;
  stream_specification?: Record<string, unknown>;
  sse_description?: Record<string, unknown>;
  tags: Array<{ Key: string; Value: string }>;
  ttl?: { AttributeName?: string; Enabled: boolean };
  point_in_time_recovery_enabled: boolean;
  point_in_time_recovery_period?: Record<string, unknown>;
  resource_policy?: string;
  resource_policy_revision_id?: string;
  contributor_insights_status?: "ENABLING" | "ENABLED" | "DISABLING" | "DISABLED";
  contributor_insights_mode?: "ACCESSED_AND_THROTTLED_KEYS" | "THROTTLED_KEYS";
  index_contributor_insights?: Record<string, "ENABLING" | "ENABLED" | "DISABLING" | "DISABLED">;
  index_contributor_insights_modes?: Record<string, "ACCESSED_AND_THROTTLED_KEYS" | "THROTTLED_KEYS">;
  kinesis_destinations: Array<Record<string, unknown>>;
  replica_auto_scaling?: Record<string, unknown>;
  restore_summary?: Record<string, unknown>;
}

export interface DynamoDbStoredItem extends Entity {
  table_name: string;
  item_key: string;
  item: DynamoDbItem;
}

export interface DynamoDbBackup extends Entity {
  backup_name: string;
  backup_arn: string;
  table_name: string;
  table_arn: string;
  table_definition: Omit<DynamoDbTable, "id" | "created_at" | "updated_at">;
  status: "CREATING" | "DELETED" | "AVAILABLE";
  snapshot: DynamoDbItem[];
}

export interface DynamoDbExport extends Entity {
  export_arn: string;
  table_arn: string;
  s3_bucket: string;
  s3_prefix?: string;
  s3_sse_algorithm?: string;
  s3_sse_kms_key_id?: string;
  export_format: string;
  export_type: string;
  export_time: string;
  started_at: string;
  completed_at?: string;
  billed_size_bytes: number;
  item_count: number;
  failure_code?: string;
  failure_message?: string;
  status: "IN_PROGRESS" | "COMPLETED" | "FAILED";
}

export interface DynamoDbImport extends Entity {
  import_arn: string;
  table_name: string;
  table_id: string;
  table_arn: string;
  client_token?: string;
  s3_bucket_source: Record<string, unknown>;
  input_format: string;
  input_format_options?: Record<string, unknown>;
  input_compression_type: string;
  table_creation_parameters: Record<string, unknown>;
  status: "IN_PROGRESS" | "COMPLETED" | "FAILED";
  started_at: string;
  completed_at?: string;
  error_count: number;
  processed_size_bytes: number;
  processed_item_count: number;
  imported_item_count: number;
  failure_code?: string;
  failure_message?: string;
}

export interface DynamoDbGlobalTable extends Entity {
  global_table_name: string;
  global_table_arn: string;
  status: "CREATING" | "ACTIVE" | "UPDATING" | "DELETING";
  replication_group: Array<Record<string, unknown>>;
}
