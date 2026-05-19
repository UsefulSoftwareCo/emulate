import type { DynamoDbTable } from "../entities.js";
import { getAccountId, getDefaultRegion } from "../helpers.js";
import { clone, compact, epochSeconds } from "./common.js";
import { validation } from "./errors.js";
import type { JsonMap } from "./types.js";

const HASH = "HASH";
const RANGE = "RANGE";

export function tableDescription(table: DynamoDbTable): JsonMap {
  return compact({
    AttributeDefinitions: table.attribute_definitions,
    TableName: table.table_name,
    KeySchema: table.key_schema,
    TableStatus: table.status,
    CreationDateTime: epochSeconds(table.created_at),
    ProvisionedThroughput: {
      NumberOfDecreasesToday: 0,
      ReadCapacityUnits: table.provisioned_throughput.ReadCapacityUnits ?? 0,
      WriteCapacityUnits: table.provisioned_throughput.WriteCapacityUnits ?? 0,
    },
    OnDemandThroughput: table.on_demand_throughput,
    WarmThroughput: table.warm_throughput,
    TableSizeBytes: 0,
    ItemCount: 0,
    TableArn: table.table_arn,
    TableId: table.table_id,
    BillingModeSummary: { BillingMode: table.billing_mode },
    TableClassSummary: table.table_class ? { TableClass: table.table_class } : undefined,
    LocalSecondaryIndexes: table.local_secondary_indexes.length ? table.local_secondary_indexes : undefined,
    GlobalSecondaryIndexes: table.global_secondary_indexes.length ? table.global_secondary_indexes : undefined,
    StreamSpecification: table.stream_specification,
    SSEDescription: table.sse_description,
    DeletionProtectionEnabled: table.deletion_protection_enabled,
    RestoreSummary: table.restore_summary,
  });
}

export function tableArn(tableName: string): string {
  return `arn:aws:dynamodb:${getDefaultRegion()}:${getAccountId()}:table/${tableName}`;
}

export function decorateIndexes(indexes: JsonMap[], tableName: string, global: boolean): JsonMap[] {
  return indexes.map((index) => ({
    ...index,
    IndexStatus: "ACTIVE",
    IndexArn: `${tableArn(tableName)}/index/${index.IndexName}`,
    ItemCount: 0,
    IndexSizeBytes: 0,
    ...(global ? { ProvisionedThroughput: index.ProvisionedThroughput ?? { ReadCapacityUnits: 0, WriteCapacityUnits: 0 } } : {}),
  }));
}

export function validateCreateTableInput(input: JsonMap): void {
  if (!Array.isArray(input.AttributeDefinitions) || !Array.isArray(input.KeySchema)) {
    throw validation("CreateTable requires AttributeDefinitions and KeySchema.");
  }
  const attributes = new Map(input.AttributeDefinitions.map((attribute: JsonMap) => [attribute.AttributeName, attribute.AttributeType]));
  if (attributes.size !== input.AttributeDefinitions.length) throw validation("AttributeDefinitions contains duplicate attributes.");
  if (!input.KeySchema.some((schema: JsonMap) => schema.KeyType === HASH)) throw validation("KeySchema must include a HASH key.");
  validateUniqueKeySchema(input.KeySchema, "KeySchema");
  for (const schema of input.KeySchema) {
    if (!schema.AttributeName || ![HASH, RANGE].includes(schema.KeyType)) throw validation("Invalid KeySchema.");
    if (!attributes.has(schema.AttributeName)) throw validation("KeySchema attribute is missing from AttributeDefinitions.");
  }
  const indexNames = new Set<string>();
  for (const index of [...(input.LocalSecondaryIndexes ?? []), ...(input.GlobalSecondaryIndexes ?? [])]) {
    if (!index.IndexName || !Array.isArray(index.KeySchema) || !index.Projection) throw validation("Invalid secondary index definition.");
    if (indexNames.has(index.IndexName)) throw validation("Duplicate secondary index name.");
    indexNames.add(index.IndexName);
    validateUniqueKeySchema(index.KeySchema, "Index KeySchema");
    validateProjection(index.Projection);
    for (const schema of index.KeySchema) {
      if (!attributes.has(schema.AttributeName)) throw validation("Index key schema attribute is missing from AttributeDefinitions.");
    }
  }
  if (input.BillingMode === "PROVISIONED" && !input.ProvisionedThroughput) throw validation("ProvisionedThroughput is required when BillingMode is PROVISIONED.");
}

function validateUniqueKeySchema(keySchema: JsonMap[], path: string): void {
  const names = new Set<string>();
  const keyTypes = new Set<string>();
  for (const schema of keySchema) {
    if (names.has(schema.AttributeName)) throw validation(`${path} contains duplicate attributes.`);
    if (keyTypes.has(schema.KeyType)) throw validation(`${path} contains duplicate key types.`);
    names.add(schema.AttributeName);
    keyTypes.add(schema.KeyType);
  }
}

function validateProjection(projection: JsonMap): void {
  const type = projection.ProjectionType ?? "ALL";
  const nonKeyAttributes = projection.NonKeyAttributes;
  if (type === "INCLUDE" && (!Array.isArray(nonKeyAttributes) || nonKeyAttributes.length === 0)) {
    throw validation("INCLUDE projection requires NonKeyAttributes.");
  }
  if (type !== "INCLUDE" && nonKeyAttributes !== undefined) {
    throw validation("NonKeyAttributes can only be specified with INCLUDE projection.");
  }
}

export function removeByName(items: JsonMap[], name: string): void {
  const index = items.findIndex((item) => item.IndexName === name);
  if (index >= 0) items.splice(index, 1);
}

export function contributorInsightsSummary(table: DynamoDbTable): JsonMap {
  return { TableName: table.table_name, ContributorInsightsStatus: table.contributor_insights_status ?? "DISABLED" };
}

export function continuousBackups(table: DynamoDbTable): JsonMap {
  const status = table.point_in_time_recovery_enabled ? "ENABLED" : "DISABLED";
  return {
    ContinuousBackupsDescription: {
      ContinuousBackupsStatus: "ENABLED",
      PointInTimeRecoveryDescription: compact({
        PointInTimeRecoveryStatus: status,
        RecoveryPeriodInDays: table.point_in_time_recovery_period?.RecoveryPeriodInDays,
      }),
    },
  };
}

export function withConsumedCapacity(
  result: JsonMap,
  input: JsonMap,
  table?: DynamoDbTable,
  tableNames?: string[],
  index?: JsonMap,
): JsonMap {
  const mode = input.ReturnConsumedCapacity;
  if (!mode || mode === "NONE") return result;
  const names = table ? [table.table_name] : [...new Set(tableNames ?? [])];
  const capacity = names.map((TableName) => {
    const base = { TableName, CapacityUnits: 1 };
    if (mode !== "INDEXES") return base;
    return {
      ...base,
      Table: { CapacityUnits: 1 },
      ...(index ? { GlobalSecondaryIndexes: { [index.IndexName]: { CapacityUnits: 1 } } } : {}),
    };
  });
  return { ...result, ConsumedCapacity: table ? capacity[0] : capacity };
}

export function applyRestoreOverrides(
  table: Omit<DynamoDbTable, "id" | "created_at" | "updated_at">,
  input: JsonMap,
): Omit<DynamoDbTable, "id" | "created_at" | "updated_at"> {
  return {
    ...table,
    billing_mode: input.BillingModeOverride ?? table.billing_mode,
    provisioned_throughput: clone(input.ProvisionedThroughputOverride ?? table.provisioned_throughput),
    local_secondary_indexes: input.LocalSecondaryIndexOverride ? decorateIndexes(input.LocalSecondaryIndexOverride, table.table_name, false) : table.local_secondary_indexes,
    global_secondary_indexes: input.GlobalSecondaryIndexOverride ? decorateIndexes(input.GlobalSecondaryIndexOverride, table.table_name, true) : table.global_secondary_indexes,
    sse_description: input.SSESpecificationOverride
      ? { Status: "ENABLED", SSEType: input.SSESpecificationOverride.SSEType ?? "KMS" }
      : table.sse_description,
  };
}

export function cloneTable(table: Omit<DynamoDbTable, "id" | "created_at" | "updated_at">, tableName: string): Omit<DynamoDbTable, "id" | "created_at" | "updated_at"> {
  return {
    table_name: tableName,
    table_arn: tableArn(tableName),
    table_id: table.table_id,
    region: table.region,
    status: "ACTIVE",
    delete_after_observation: false,
    attribute_definitions: clone(table.attribute_definitions),
    key_schema: clone(table.key_schema),
    local_secondary_indexes: clone(table.local_secondary_indexes),
    global_secondary_indexes: clone(table.global_secondary_indexes),
    billing_mode: table.billing_mode,
    provisioned_throughput: clone(table.provisioned_throughput),
    on_demand_throughput: clone(table.on_demand_throughput),
    warm_throughput: clone(table.warm_throughput),
    table_class: table.table_class,
    deletion_protection_enabled: false,
    stream_specification: clone(table.stream_specification),
    sse_description: clone(table.sse_description),
    tags: clone(table.tags),
    ttl: clone(table.ttl),
    point_in_time_recovery_enabled: table.point_in_time_recovery_enabled,
    point_in_time_recovery_period: clone(table.point_in_time_recovery_period),
    resource_policy: table.resource_policy,
    resource_policy_revision_id: table.resource_policy_revision_id,
    contributor_insights_status: table.contributor_insights_status,
    index_contributor_insights: clone(table.index_contributor_insights),
    kinesis_destinations: clone(table.kinesis_destinations),
    replica_auto_scaling: clone(table.replica_auto_scaling),
    restore_summary: clone(table.restore_summary),
  };
}
