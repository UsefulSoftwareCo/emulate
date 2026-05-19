import type { ContentfulStatusCode, Context } from "@emulators/core";
import { DYNAMODB_MODEL, type DynamoDbOperationName } from "../dynamodb-model.js";
import { validation } from "./errors.js";
import type { JsonMap, RequestValidator } from "./types.js";

const NESTED_REQUIRED_FIELDS: Partial<Record<DynamoDbOperationName, Array<[string, string[]]>>> = {
  CreateTable: [
    ["AttributeDefinitions", ["AttributeName", "AttributeType"]],
    ["KeySchema", ["AttributeName", "KeyType"]],
  ],
  ImportTable: [
    ["S3BucketSource", ["S3Bucket"]],
    ["TableCreationParameters", ["TableName", "AttributeDefinitions", "KeySchema"]],
  ],
  RestoreTableFromBackup: [["LocalSecondaryIndexOverride", ["IndexName", "KeySchema", "Projection"]]],
  UpdateContinuousBackups: [["PointInTimeRecoverySpecification", ["PointInTimeRecoveryEnabled"]]],
  UpdateTimeToLive: [["TimeToLiveSpecification", ["AttributeName", "Enabled"]]],
};

export function validateNestedRequiredFields(operation: DynamoDbOperationName, input: JsonMap): void {
  for (const [path, fields] of NESTED_REQUIRED_FIELDS[operation] ?? []) {
    const value = getPlainPath(input, path);
    if (value === undefined || value === null) continue;
    const entries = Array.isArray(value) ? value : [value];
    for (const entry of entries) {
      if (!entry || typeof entry !== "object") throw validation(`Invalid required field ${path}.`);
      for (const field of fields) {
        if ((entry as JsonMap)[field] === undefined || (entry as JsonMap)[field] === null) {
          throw validation(`Missing required field ${path}.${field}.`);
        }
      }
    }
  }
}

const REQUEST_VALIDATORS: Partial<Record<DynamoDbOperationName, RequestValidator>> = {
  BatchExecuteStatement: validateBatchExecuteStatement,
  BatchGetItem: validateBatchGetItem,
  BatchWriteItem: validateBatchWriteItem,
  CreateGlobalTable: validateCreateGlobalTable,
  CreateTable: validateCreateTable,
  DeleteItem: validateKeyOperation,
  DisableKinesisStreamingDestination: validateKinesisStreamingDestination,
  EnableKinesisStreamingDestination: validateKinesisStreamingDestination,
  ExecuteStatement: validateExecuteStatement,
  ExecuteTransaction: validateExecuteTransaction,
  ExportTableToPointInTime: validateExportTableToPointInTime,
  GetItem: validateKeyOperation,
  ImportTable: validateImportTable,
  PutItem: validatePutItem,
  PutResourcePolicy: validatePutResourcePolicy,
  Query: validateQuery,
  RestoreTableFromBackup: validateRestoreTableFromBackup,
  RestoreTableToPointInTime: validateRestoreTableToPointInTime,
  Scan: validateScan,
  TagResource: validateTagResource,
  TransactGetItems: validateTransactGetItems,
  TransactWriteItems: validateTransactWriteItems,
  UntagResource: validateUntagResource,
  UpdateContinuousBackups: validateUpdateContinuousBackups,
  UpdateContributorInsights: validateUpdateContributorInsights,
  UpdateGlobalTable: validateUpdateGlobalTable,
  UpdateItem: validateUpdateItem,
  UpdateKinesisStreamingDestination: validateUpdateKinesisStreamingDestination,
  UpdateTable: validateUpdateTable,
  UpdateTableReplicaAutoScaling: validateUpdateTableReplicaAutoScaling,
  UpdateTimeToLive: validateUpdateTimeToLive,
};

const ATTRIBUTE_VALUE_TYPES = ["S", "N", "B", "BOOL", "NULL", "M", "L", "SS", "NS", "BS"] as const;
const RETURN_CONSUMED_CAPACITY = ["INDEXES", "TOTAL", "NONE"] as const;
const RETURN_ITEM_COLLECTION_METRICS = ["SIZE", "NONE"] as const;

export function validateDynamoDbRequest(operation: DynamoDbOperationName, input: JsonMap): void {
  validateRequiredFields(operation, input);
  validateNestedRequiredFields(operation, input);
  REQUEST_VALIDATORS[operation]?.(input);
}

function validateRequiredFields(operation: DynamoDbOperationName, input: JsonMap): void {
  for (const field of DYNAMODB_MODEL.operations[operation]) {
    if (input[field] === undefined || input[field] === null) throw validation(`Missing required field ${field}.`);
  }
}

function validateCreateTable(input: JsonMap): void {
  requireString(input, "TableName", "TableName");
  validateTableCreationParameters(input, "CreateTable");
}

function validateUpdateTable(input: JsonMap): void {
  requireString(input, "TableName", "TableName");
  validateAttributeDefinitions(input.AttributeDefinitions, "AttributeDefinitions", false);
  validateThroughput(input.ProvisionedThroughput, "ProvisionedThroughput", false);
  validateThroughput(input.OnDemandThroughput, "OnDemandThroughput", false);
  validateThroughput(input.WarmThroughput, "WarmThroughput", false);
  validateEnum(input, "BillingMode", ["PROVISIONED", "PAY_PER_REQUEST"], "BillingMode", false);
  validateEnum(input, "TableClass", ["STANDARD", "STANDARD_INFREQUENT_ACCESS"], "TableClass", false);
  validateBoolean(input, "DeletionProtectionEnabled", "DeletionProtectionEnabled", false);
  validateStreamSpecification(input.StreamSpecification, "StreamSpecification", false);
  validateSseSpecification(input.SSESpecification, "SSESpecification", false);
  validateGlobalSecondaryIndexUpdates(input.GlobalSecondaryIndexUpdates, "GlobalSecondaryIndexUpdates", false);
}

function validateImportTable(input: JsonMap): void {
  validateS3BucketSource(input.S3BucketSource, "S3BucketSource", true);
  validateEnum(input, "InputFormat", ["DYNAMODB_JSON", "ION", "CSV"], "InputFormat", true);
  validateEnum(input, "InputCompressionType", ["GZIP", "ZSTD", "NONE"], "InputCompressionType", false);
  validateInputFormatOptions(input.InputFormatOptions, "InputFormatOptions", false);
  const params = requireMap(input, "TableCreationParameters", "TableCreationParameters");
  requireString(params, "TableName", "TableCreationParameters.TableName");
  validateTableCreationParameters(params, "TableCreationParameters");
}

function validatePutItem(input: JsonMap): void {
  requireString(input, "TableName", "TableName");
  validateItemMap(input.Item, "Item", true);
  validateItemCommon(input);
  validateEnum(input, "ReturnValues", ["NONE", "ALL_OLD"], "ReturnValues", false);
}

function validateUpdateItem(input: JsonMap): void {
  requireString(input, "TableName", "TableName");
  validateItemMap(input.Key, "Key", true);
  validateItemCommon(input);
  validateEnum(input, "ReturnValues", ["NONE", "ALL_OLD", "UPDATED_OLD", "ALL_NEW", "UPDATED_NEW"], "ReturnValues", false);
  validateAttributeUpdates(input.AttributeUpdates, "AttributeUpdates", false);
}

function validateKeyOperation(input: JsonMap): void {
  requireString(input, "TableName", "TableName");
  validateItemMap(input.Key, "Key", true);
  validateItemCommon(input);
  validateEnum(input, "ReturnValues", ["NONE", "ALL_OLD"], "ReturnValues", false);
}

function validateQuery(input: JsonMap): void {
  requireString(input, "TableName", "TableName");
  validateString(input, "IndexName", "IndexName", false);
  validateItemCommon(input);
  validateEnum(input, "Select", ["ALL_ATTRIBUTES", "ALL_PROJECTED_ATTRIBUTES", "SPECIFIC_ATTRIBUTES", "COUNT"], "Select", false);
  validateBoolean(input, "ConsistentRead", "ConsistentRead", false);
  validateNumber(input, "Limit", "Limit", false);
  validateItemMap(input.ExclusiveStartKey, "ExclusiveStartKey", false);
  validateLegacyConditions(input.KeyConditions, "KeyConditions", false);
  validateLegacyConditions(input.QueryFilter, "QueryFilter", false);
}

function validateScan(input: JsonMap): void {
  requireString(input, "TableName", "TableName");
  validateItemCommon(input);
  validateEnum(input, "Select", ["ALL_ATTRIBUTES", "ALL_PROJECTED_ATTRIBUTES", "SPECIFIC_ATTRIBUTES", "COUNT"], "Select", false);
  validateBoolean(input, "ConsistentRead", "ConsistentRead", false);
  validateNumber(input, "Limit", "Limit", false);
  validateItemMap(input.ExclusiveStartKey, "ExclusiveStartKey", false);
  validateLegacyConditions(input.ScanFilter, "ScanFilter", false);
}

function validateBatchGetItem(input: JsonMap): void {
  const requestItems = requireMap(input, "RequestItems", "RequestItems");
  for (const [tableName, request] of Object.entries(requestItems)) {
    validateTableRequestName(tableName, "RequestItems");
    const path = `RequestItems.${tableName}`;
    const requestMap = requireValueMap(request, path);
    const keys = requireList(requestMap, "Keys", `${path}.Keys`);
    for (const [index, key] of keys.entries()) validateItemMap(key, `${path}.Keys.${index}`, true);
    validateStringList(requestMap.AttributesToGet, `${path}.AttributesToGet`, false);
    validateString(requestMap, "ProjectionExpression", `${path}.ProjectionExpression`, false);
    validateExpressionAttributeNames(requestMap.ExpressionAttributeNames, `${path}.ExpressionAttributeNames`, false);
  }
  validateEnum(input, "ReturnConsumedCapacity", RETURN_CONSUMED_CAPACITY, "ReturnConsumedCapacity", false);
}

function validateBatchWriteItem(input: JsonMap): void {
  const requestItems = requireMap(input, "RequestItems", "RequestItems");
  for (const [tableName, requests] of Object.entries(requestItems)) {
    validateTableRequestName(tableName, "RequestItems");
    const list = requireValueList(requests, `RequestItems.${tableName}`);
    for (const [index, request] of list.entries()) {
      const path = `RequestItems.${tableName}.${index}`;
      const requestMap = requireValueMap(request, path);
      const actions = ["PutRequest", "DeleteRequest"].filter((action) => requestMap[action] !== undefined);
      if (actions.length !== 1) throw validation(`${path} must contain exactly one request action.`);
      if (requestMap.PutRequest) validateItemMap(requireValueMap(requestMap.PutRequest, `${path}.PutRequest`).Item, `${path}.PutRequest.Item`, true);
      if (requestMap.DeleteRequest) validateItemMap(requireValueMap(requestMap.DeleteRequest, `${path}.DeleteRequest`).Key, `${path}.DeleteRequest.Key`, true);
    }
  }
  validateEnum(input, "ReturnConsumedCapacity", RETURN_CONSUMED_CAPACITY, "ReturnConsumedCapacity", false);
  validateEnum(input, "ReturnItemCollectionMetrics", RETURN_ITEM_COLLECTION_METRICS, "ReturnItemCollectionMetrics", false);
}

function validateTransactGetItems(input: JsonMap): void {
  const items = requireList(input, "TransactItems", "TransactItems");
  for (const [index, entry] of items.entries()) {
    const path = `TransactItems.${index}`;
    const get = requireSingleAction(entry, ["Get"], path);
    validateTransactionKeyAction(get, `${path}.Get`);
  }
  validateEnum(input, "ReturnConsumedCapacity", RETURN_CONSUMED_CAPACITY, "ReturnConsumedCapacity", false);
}

function validateTransactWriteItems(input: JsonMap): void {
  const items = requireList(input, "TransactItems", "TransactItems");
  for (const [index, entry] of items.entries()) {
    const path = `TransactItems.${index}`;
    const action = requireSingleAction(entry, ["ConditionCheck", "Put", "Update", "Delete"], path);
    if (action.name === "Put") {
      requireString(action.value, "TableName", `${path}.Put.TableName`);
      validateItemMap(action.value.Item, `${path}.Put.Item`, true);
      validateItemCommon(action.value, `${path}.Put`);
      continue;
    }
    validateTransactionKeyAction(action, `${path}.${action.name}`);
    if (action.name === "Update") validateAttributeUpdates(action.value.AttributeUpdates, `${path}.Update.AttributeUpdates`, false);
  }
  validateEnum(input, "ReturnConsumedCapacity", RETURN_CONSUMED_CAPACITY, "ReturnConsumedCapacity", false);
  validateEnum(input, "ReturnItemCollectionMetrics", RETURN_ITEM_COLLECTION_METRICS, "ReturnItemCollectionMetrics", false);
}

function validateExecuteStatement(input: JsonMap): void {
  requireString(input, "Statement", "Statement");
  validatePartiQlParameters(input.Parameters, "Parameters", false);
  validateItemCommon(input);
  validateBoolean(input, "ConsistentRead", "ConsistentRead", false);
  validateNumber(input, "Limit", "Limit", false);
  validateString(input, "NextToken", "NextToken", false);
}

function validateBatchExecuteStatement(input: JsonMap): void {
  const statements = requireList(input, "Statements", "Statements");
  for (const [index, statement] of statements.entries()) validateExecuteStatementAt(statement, `Statements.${index}`);
  validateEnum(input, "ReturnConsumedCapacity", RETURN_CONSUMED_CAPACITY, "ReturnConsumedCapacity", false);
}

function validateExecuteTransaction(input: JsonMap): void {
  const statements = requireList(input, "TransactStatements", "TransactStatements");
  for (const [index, statement] of statements.entries()) validateExecuteStatementAt(statement, `TransactStatements.${index}`);
  validateString(input, "ClientRequestToken", "ClientRequestToken", false);
  validateEnum(input, "ReturnConsumedCapacity", RETURN_CONSUMED_CAPACITY, "ReturnConsumedCapacity", false);
}

function validateUpdateTimeToLive(input: JsonMap): void {
  requireString(input, "TableName", "TableName");
  const ttl = requireMap(input, "TimeToLiveSpecification", "TimeToLiveSpecification");
  requireString(ttl, "AttributeName", "TimeToLiveSpecification.AttributeName");
  validateBoolean(ttl, "Enabled", "TimeToLiveSpecification.Enabled", true);
}

function validateUpdateContinuousBackups(input: JsonMap): void {
  requireString(input, "TableName", "TableName");
  const spec = requireMap(input, "PointInTimeRecoverySpecification", "PointInTimeRecoverySpecification");
  validateBoolean(spec, "PointInTimeRecoveryEnabled", "PointInTimeRecoverySpecification.PointInTimeRecoveryEnabled", true);
  validateNumber(spec, "RecoveryPeriodInDays", "PointInTimeRecoverySpecification.RecoveryPeriodInDays", false);
}

function validateTagResource(input: JsonMap): void {
  requireString(input, "ResourceArn", "ResourceArn");
  validateTags(input.Tags, "Tags", true);
}

function validateUntagResource(input: JsonMap): void {
  requireString(input, "ResourceArn", "ResourceArn");
  validateStringList(input.TagKeys, "TagKeys", true);
}

function validatePutResourcePolicy(input: JsonMap): void {
  requireString(input, "ResourceArn", "ResourceArn");
  requireString(input, "Policy", "Policy");
  validateString(input, "ExpectedRevisionId", "ExpectedRevisionId", false);
}

function validateExportTableToPointInTime(input: JsonMap): void {
  requireString(input, "TableArn", "TableArn");
  requireString(input, "S3Bucket", "S3Bucket");
  validateString(input, "S3Prefix", "S3Prefix", false);
  validateEnum(input, "ExportFormat", ["DYNAMODB_JSON", "ION"], "ExportFormat", false);
  validateEnum(input, "ExportType", ["FULL_EXPORT", "INCREMENTAL_EXPORT"], "ExportType", false);
  validateS3SseAlgorithm(input.S3SseAlgorithm, "S3SseAlgorithm", false);
}

function validateRestoreTableFromBackup(input: JsonMap): void {
  requireString(input, "TargetTableName", "TargetTableName");
  requireString(input, "BackupArn", "BackupArn");
  validateRestoreOverrides(input);
}

function validateRestoreTableToPointInTime(input: JsonMap): void {
  requireString(input, "TargetTableName", "TargetTableName");
  validateString(input, "SourceTableName", "SourceTableName", false);
  validateString(input, "SourceTableArn", "SourceTableArn", false);
  validateBoolean(input, "UseLatestRestorableTime", "UseLatestRestorableTime", false);
  validateRestoreOverrides(input);
}

function validateCreateGlobalTable(input: JsonMap): void {
  requireString(input, "GlobalTableName", "GlobalTableName");
  validateReplicationGroup(input.ReplicationGroup, "ReplicationGroup", true);
}

function validateUpdateGlobalTable(input: JsonMap): void {
  requireString(input, "GlobalTableName", "GlobalTableName");
  const updates = requireList(input, "ReplicaUpdates", "ReplicaUpdates");
  for (const [index, update] of updates.entries()) {
    const path = `ReplicaUpdates.${index}`;
    const action = requireSingleAction(update, ["Create", "Delete"], path);
    requireString(action.value, "RegionName", `${path}.${action.name}.RegionName`);
  }
}

function validateUpdateKinesisStreamingDestination(input: JsonMap): void {
  validateKinesisStreamingDestination(input);
  validateString(input, "DestinationStatusDescription", "DestinationStatusDescription", false);
  validateEnum(input, "ApproximateCreationDateTimePrecision", ["MILLISECOND", "MICROSECOND"], "ApproximateCreationDateTimePrecision", false);
}

function validateKinesisStreamingDestination(input: JsonMap): void {
  requireString(input, "TableName", "TableName");
  requireString(input, "StreamArn", "StreamArn");
}

function validateUpdateContributorInsights(input: JsonMap): void {
  requireString(input, "TableName", "TableName");
  validateString(input, "IndexName", "IndexName", false);
  validateEnum(input, "ContributorInsightsAction", ["ENABLE", "DISABLE"], "ContributorInsightsAction", true);
}

function validateUpdateTableReplicaAutoScaling(input: JsonMap): void {
  requireString(input, "TableName", "TableName");
  const updates = input.ReplicaUpdates;
  if (updates === undefined) return;
  for (const [index, update] of requireValueList(updates, "ReplicaUpdates").entries()) {
    requireString(requireValueMap(update, `ReplicaUpdates.${index}`), "RegionName", `ReplicaUpdates.${index}.RegionName`);
  }
}

function validateTableCreationParameters(input: JsonMap, path: string): void {
  validateAttributeDefinitions(input.AttributeDefinitions, `${path}.AttributeDefinitions`, true);
  validateKeySchema(input.KeySchema, `${path}.KeySchema`, true);
  validateSecondaryIndexes(input.LocalSecondaryIndexes, `${path}.LocalSecondaryIndexes`, false, false);
  validateSecondaryIndexes(input.GlobalSecondaryIndexes, `${path}.GlobalSecondaryIndexes`, false, true);
  validateThroughput(input.ProvisionedThroughput, `${path}.ProvisionedThroughput`, false);
  validateThroughput(input.OnDemandThroughput, `${path}.OnDemandThroughput`, false);
  validateThroughput(input.WarmThroughput, `${path}.WarmThroughput`, false);
  validateEnum(input, "BillingMode", ["PROVISIONED", "PAY_PER_REQUEST"], `${path}.BillingMode`, false);
  validateEnum(input, "TableClass", ["STANDARD", "STANDARD_INFREQUENT_ACCESS"], `${path}.TableClass`, false);
  validateBoolean(input, "DeletionProtectionEnabled", `${path}.DeletionProtectionEnabled`, false);
  validateStreamSpecification(input.StreamSpecification, `${path}.StreamSpecification`, false);
  validateSseSpecification(input.SSESpecification, `${path}.SSESpecification`, false);
  validateTags(input.Tags, `${path}.Tags`, false);
  validateString(input, "ResourcePolicy", `${path}.ResourcePolicy`, false);
}

function validateAttributeDefinitions(value: unknown, path: string, required: boolean): void {
  const list = getOptionalList(value, path, required);
  if (!list) return;
  for (const [index, attribute] of list.entries()) {
    const entry = requireValueMap(attribute, `${path}.${index}`);
    requireString(entry, "AttributeName", `${path}.${index}.AttributeName`);
    validateEnum(entry, "AttributeType", ["S", "N", "B"], `${path}.${index}.AttributeType`, true);
  }
}

function validateKeySchema(value: unknown, path: string, required: boolean): void {
  const list = getOptionalList(value, path, required);
  if (!list) return;
  for (const [index, key] of list.entries()) {
    const entry = requireValueMap(key, `${path}.${index}`);
    requireString(entry, "AttributeName", `${path}.${index}.AttributeName`);
    validateEnum(entry, "KeyType", ["HASH", "RANGE"], `${path}.${index}.KeyType`, true);
  }
}

function validateSecondaryIndexes(value: unknown, path: string, required: boolean, global: boolean): void {
  const indexes = getOptionalList(value, path, required);
  if (!indexes) return;
  for (const [index, item] of indexes.entries()) {
    const entry = requireValueMap(item, `${path}.${index}`);
    requireString(entry, "IndexName", `${path}.${index}.IndexName`);
    validateKeySchema(entry.KeySchema, `${path}.${index}.KeySchema`, true);
    validateProjection(entry.Projection, `${path}.${index}.Projection`, true);
    if (global) validateThroughput(entry.ProvisionedThroughput, `${path}.${index}.ProvisionedThroughput`, false);
  }
}

function validateProjection(value: unknown, path: string, required: boolean): void {
  const projection = getOptionalMap(value, path, required);
  if (!projection) return;
  validateEnum(projection, "ProjectionType", ["ALL", "KEYS_ONLY", "INCLUDE"], `${path}.ProjectionType`, false);
  validateStringList(projection.NonKeyAttributes, `${path}.NonKeyAttributes`, false);
}

function validateThroughput(value: unknown, path: string, required: boolean): void {
  const throughput = getOptionalMap(value, path, required);
  if (!throughput) return;
  for (const [name, amount] of Object.entries(throughput)) {
    if (amount !== undefined) validateNumberValue(amount, `${path}.${name}`);
  }
}

function validateStreamSpecification(value: unknown, path: string, required: boolean): void {
  const spec = getOptionalMap(value, path, required);
  if (!spec) return;
  validateBoolean(spec, "StreamEnabled", `${path}.StreamEnabled`, false);
  validateEnum(spec, "StreamViewType", ["NEW_IMAGE", "OLD_IMAGE", "NEW_AND_OLD_IMAGES", "KEYS_ONLY"], `${path}.StreamViewType`, false);
}

function validateSseSpecification(value: unknown, path: string, required: boolean): void {
  const spec = getOptionalMap(value, path, required);
  if (!spec) return;
  validateBoolean(spec, "Enabled", `${path}.Enabled`, false);
  validateEnum(spec, "SSEType", ["AES256", "KMS"], `${path}.SSEType`, false);
  validateString(spec, "KMSMasterKeyId", `${path}.KMSMasterKeyId`, false);
}

function validateGlobalSecondaryIndexUpdates(value: unknown, path: string, required: boolean): void {
  const updates = getOptionalList(value, path, required);
  if (!updates) return;
  for (const [index, update] of updates.entries()) {
    const action = requireSingleAction(update, ["Create", "Update", "Delete"], `${path}.${index}`);
    if (action.name === "Create") validateSecondaryIndexes([action.value], `${path}.${index}.Create`, true, true);
    if (action.name === "Update") {
      requireString(action.value, "IndexName", `${path}.${index}.Update.IndexName`);
      validateThroughput(action.value.ProvisionedThroughput, `${path}.${index}.Update.ProvisionedThroughput`, true);
    }
    if (action.name === "Delete") requireString(action.value, "IndexName", `${path}.${index}.Delete.IndexName`);
  }
}

function validateS3BucketSource(value: unknown, path: string, required: boolean): void {
  const source = getOptionalMap(value, path, required);
  if (!source) return;
  requireString(source, "S3Bucket", `${path}.S3Bucket`);
  validateString(source, "S3BucketOwner", `${path}.S3BucketOwner`, false);
  validateString(source, "S3KeyPrefix", `${path}.S3KeyPrefix`, false);
}

function validateInputFormatOptions(value: unknown, path: string, required: boolean): void {
  const options = getOptionalMap(value, path, required);
  if (!options) return;
  const csv = getOptionalMap(options.Csv, `${path}.Csv`, false);
  if (!csv) return;
  validateString(csv, "Delimiter", `${path}.Csv.Delimiter`, false);
  validateStringList(csv.HeaderList, `${path}.Csv.HeaderList`, false);
}

function validateItemCommon(input: JsonMap, path = ""): void {
  validateExpressionAttributeNames(input.ExpressionAttributeNames, joinPath(path, "ExpressionAttributeNames"), false);
  validateExpressionAttributeValues(input.ExpressionAttributeValues, joinPath(path, "ExpressionAttributeValues"), false);
  validateLegacyConditions(input.Expected, joinPath(path, "Expected"), false);
  validateStringList(input.AttributesToGet, joinPath(path, "AttributesToGet"), false);
  validateEnum(input, "ConditionalOperator", ["AND", "OR"], joinPath(path, "ConditionalOperator"), false);
  validateEnum(input, "ReturnConsumedCapacity", RETURN_CONSUMED_CAPACITY, joinPath(path, "ReturnConsumedCapacity"), false);
  validateEnum(input, "ReturnItemCollectionMetrics", RETURN_ITEM_COLLECTION_METRICS, joinPath(path, "ReturnItemCollectionMetrics"), false);
}

function validateExpressionAttributeNames(value: unknown, path: string, required: boolean): void {
  const names = getOptionalMap(value, path, required);
  if (!names) return;
  for (const [key, replacement] of Object.entries(names)) {
    if (typeof key !== "string" || typeof replacement !== "string") throw validation(`${path} must be a map of strings.`);
  }
}

function validateExpressionAttributeValues(value: unknown, path: string, required: boolean): void {
  const values = getOptionalMap(value, path, required);
  if (!values) return;
  for (const [name, attributeValue] of Object.entries(values)) validateAttributeValue(attributeValue, `${path}.${name}`);
}

function validateAttributeUpdates(value: unknown, path: string, required: boolean): void {
  const updates = getOptionalMap(value, path, required);
  if (!updates) return;
  for (const [name, update] of Object.entries(updates)) {
    const entry = requireValueMap(update, `${path}.${name}`);
    validateAttributeValue(entry.Value, `${path}.${name}.Value`, false);
    validateEnum(entry, "Action", ["ADD", "PUT", "DELETE"], `${path}.${name}.Action`, false);
  }
}

function validateLegacyConditions(value: unknown, path: string, required: boolean): void {
  const conditions = getOptionalMap(value, path, required);
  if (!conditions) return;
  for (const [name, condition] of Object.entries(conditions)) {
    const entry = requireValueMap(condition, `${path}.${name}`);
    validateAttributeValue(entry.Value, `${path}.${name}.Value`, false);
    validateAttributeValueList(entry.AttributeValueList, `${path}.${name}.AttributeValueList`, false);
    validateBoolean(entry, "Exists", `${path}.${name}.Exists`, false);
    validateString(entry, "ComparisonOperator", `${path}.${name}.ComparisonOperator`, false);
  }
}

function validateItemMap(value: unknown, path: string, required: boolean): void {
  const item = getOptionalMap(value, path, required);
  if (!item) return;
  for (const [name, attributeValue] of Object.entries(item)) validateAttributeValue(attributeValue, `${path}.${name}`);
}

function validateAttributeValueList(value: unknown, path: string, required: boolean): void {
  const list = getOptionalList(value, path, required);
  if (!list) return;
  for (const [index, attributeValue] of list.entries()) validateAttributeValue(attributeValue, `${path}.${index}`);
}

function validateAttributeValue(value: unknown, path: string, required = true): void {
  if (value === undefined || value === null) {
    if (required) throw validation(`Missing required field ${path}.`);
    return;
  }
  const attribute = requireValueMap(value, path);
  const present = ATTRIBUTE_VALUE_TYPES.filter((type) => attribute[type] !== undefined);
  if (present.length !== 1) throw validation(`${path} must contain exactly one DynamoDB attribute value type.`);
  const type = present[0];
  const typedValue = attribute[type];
  switch (type) {
    case "S":
    case "N":
    case "B":
      if (typeof typedValue !== "string") throw validation(`${path}.${type} must be a string.`);
      return;
    case "BOOL":
    case "NULL":
      if (typeof typedValue !== "boolean") throw validation(`${path}.${type} must be a boolean.`);
      return;
    case "M":
      validateItemMap(typedValue, `${path}.M`, true);
      return;
    case "L":
      validateAttributeValueList(typedValue, `${path}.L`, true);
      return;
    case "SS":
    case "NS":
    case "BS":
      validateStringList(typedValue, `${path}.${type}`, true);
      return;
  }
}

function validateTags(value: unknown, path: string, required: boolean): void {
  const tags = getOptionalList(value, path, required);
  if (!tags) return;
  for (const [index, tag] of tags.entries()) {
    const entry = requireValueMap(tag, `${path}.${index}`);
    requireString(entry, "Key", `${path}.${index}.Key`);
    requireString(entry, "Value", `${path}.${index}.Value`);
  }
}

function validateReplicationGroup(value: unknown, path: string, required: boolean): void {
  const replicas = getOptionalList(value, path, required);
  if (!replicas) return;
  for (const [index, replica] of replicas.entries()) requireString(requireValueMap(replica, `${path}.${index}`), "RegionName", `${path}.${index}.RegionName`);
}

function validateRestoreOverrides(input: JsonMap): void {
  validateEnum(input, "BillingModeOverride", ["PROVISIONED", "PAY_PER_REQUEST"], "BillingModeOverride", false);
  validateThroughput(input.ProvisionedThroughputOverride, "ProvisionedThroughputOverride", false);
  validateSecondaryIndexes(input.LocalSecondaryIndexOverride, "LocalSecondaryIndexOverride", false, false);
  validateSecondaryIndexes(input.GlobalSecondaryIndexOverride, "GlobalSecondaryIndexOverride", false, true);
  validateSseSpecification(input.SSESpecificationOverride, "SSESpecificationOverride", false);
}

function validateS3SseAlgorithm(value: unknown, path: string, required: boolean): void {
  if (value === undefined || value === null) {
    if (required) throw validation(`Missing required field ${path}.`);
    return;
  }
  if (!["AES256", "KMS"].includes(String(value))) throw validation(`${path} must be one of AES256, KMS.`);
}

function validateExecuteStatementAt(value: unknown, path: string): void {
  const statement = requireValueMap(value, path);
  requireString(statement, "Statement", `${path}.Statement`);
  validatePartiQlParameters(statement.Parameters, `${path}.Parameters`, false);
  validateBoolean(statement, "ConsistentRead", `${path}.ConsistentRead`, false);
  validateNumber(statement, "Limit", `${path}.Limit`, false);
}

function validatePartiQlParameters(value: unknown, path: string, required: boolean): void {
  const list = getOptionalList(value, path, required);
  if (!list) return;
  for (const [index, parameter] of list.entries()) {
    const map = requireValueMap(parameter, `${path}.${index}`);
    const attributeTypes = ATTRIBUTE_VALUE_TYPES.filter((type) => map[type] !== undefined);
    if (attributeTypes.length === 1) validateAttributeValue(map, `${path}.${index}`);
    else validateItemMap(map, `${path}.${index}`, true);
  }
}

function validateTransactionKeyAction(action: { name: string; value: JsonMap }, path: string): void {
  requireString(action.value, "TableName", `${path}.TableName`);
  validateItemMap(action.value.Key, `${path}.Key`, true);
  validateItemCommon(action.value, path);
}

function requireSingleAction(value: unknown, actions: string[], path: string): { name: string; value: JsonMap } {
  const entry = requireValueMap(value, path);
  const present = actions.filter((action) => entry[action] !== undefined);
  if (present.length !== 1) throw validation(`${path} must contain exactly one action.`);
  const name = present[0];
  return { name, value: requireValueMap(entry[name], `${path}.${name}`) };
}

function validateTableRequestName(value: string, path: string): void {
  if (!value) throw validation(`${path} contains an invalid table name.`);
}

function requireString(input: JsonMap, field: string, path: string): void {
  validateString(input, field, path, true);
}

function validateString(input: JsonMap, field: string, path: string, required: boolean): void {
  const value = input[field];
  if (value === undefined || value === null) {
    if (required) throw validation(`Missing required field ${path}.`);
    return;
  }
  if (typeof value !== "string") throw validation(`${path} must be a string.`);
}

function validateStringList(value: unknown, path: string, required: boolean): void {
  const list = getOptionalList(value, path, required);
  if (!list) return;
  for (const [index, item] of list.entries()) {
    if (typeof item !== "string") throw validation(`${path}.${index} must be a string.`);
  }
}

function validateBoolean(input: JsonMap, field: string, path: string, required: boolean): void {
  const value = input[field];
  if (value === undefined || value === null) {
    if (required) throw validation(`Missing required field ${path}.`);
    return;
  }
  if (typeof value !== "boolean") throw validation(`${path} must be a boolean.`);
}

function validateNumber(input: JsonMap, field: string, path: string, required: boolean): void {
  const value = input[field];
  if (value === undefined || value === null) {
    if (required) throw validation(`Missing required field ${path}.`);
    return;
  }
  validateNumberValue(value, path);
}

function validateNumberValue(value: unknown, path: string): void {
  if (typeof value !== "number" || !Number.isFinite(value)) throw validation(`${path} must be a number.`);
}

function validateEnum(input: JsonMap, field: string, values: readonly string[], path: string, required: boolean): void {
  const value = input[field];
  if (value === undefined || value === null) {
    if (required) throw validation(`Missing required field ${path}.`);
    return;
  }
  if (typeof value !== "string" || !values.includes(value)) throw validation(`${path} must be one of ${values.join(", ")}.`);
}

function requireMap(input: JsonMap, field: string, path: string): JsonMap {
  const value = input[field];
  if (value === undefined || value === null) throw validation(`Missing required field ${path}.`);
  return requireValueMap(value, path);
}

function requireList(input: JsonMap, field: string, path: string): unknown[] {
  const value = input[field];
  if (value === undefined || value === null) throw validation(`Missing required field ${path}.`);
  return requireValueList(value, path);
}

function getOptionalMap(value: unknown, path: string, required: boolean): JsonMap | undefined {
  if (value === undefined || value === null) {
    if (required) throw validation(`Missing required field ${path}.`);
    return undefined;
  }
  return requireValueMap(value, path);
}

function getOptionalList(value: unknown, path: string, required: boolean): unknown[] | undefined {
  if (value === undefined || value === null) {
    if (required) throw validation(`Missing required field ${path}.`);
    return undefined;
  }
  return requireValueList(value, path);
}

function requireValueMap(value: unknown, path: string): JsonMap {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw validation(`${path} must be a map.`);
  return value as JsonMap;
}

function requireValueList(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw validation(`${path} must be a list.`);
  return value;
}

function joinPath(prefix: string, field: string): string {
  return prefix ? `${prefix}.${field}` : field;
}

export function validateDynamoDbAuth(c: Context) {
  const authHeader = c.req.header("Authorization") ?? "";
  if (/^AWS4-HMAC-SHA256\b/.test(authHeader)) return undefined;
  const scopes = c.get("authScopes") ?? [];
  if (/^Bearer\s+/i.test(authHeader) && (scopes.includes("dynamodb:*") || scopes.includes("*"))) return undefined;
  return jsonError(c, "UnrecognizedClientException", "The security token included in the request is invalid.", 400);
}

export function jsonError(c: Context, code: string, message: string, status: ContentfulStatusCode = 400) {
  return c.json({ __type: `com.amazonaws.dynamodb.v20120810#${code}`, message, Message: message }, status, {
    "x-amzn-errortype": code,
  });
}

function getPlainPath(value: JsonMap, path: string): unknown {
  return path.split(".").reduce<unknown>((current, part) => (current && typeof current === "object" ? (current as JsonMap)[part] : undefined), value);
}
