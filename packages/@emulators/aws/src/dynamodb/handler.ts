import type { RouteContext } from "@emulators/core";
import { getAwsStore } from "../store.js";
import type { DynamoDbAttributeValue, DynamoDbItem, DynamoDbTable } from "../entities.js";
import type { DynamoDbOperationName } from "../dynamodb-model.js";
import { generateAwsId, generateMessageId, getAccountId, getDefaultRegion } from "../helpers.js";
import { assertNever, clone, compact, epochSeconds, paginate } from "./common.js";
import { conditionalFailure, DynamoDbLocalError, transactionCanceled, validation } from "./errors.js";
import type { JsonMap } from "./types.js";
import {
  applyRestoreOverrides,
  cloneTable,
  continuousBackups,
  contributorInsightsSummary,
  decorateIndexes,
  removeByName,
  tableArn,
  tableDescription,
  validateCreateTableInput,
  withConsumedCapacity,
} from "./tables.js";
import {
  applyLegacyAttributeUpdates,
  applyUpdateExpression,
  attributeSize,
  changedAttributes,
  conditionMatches,
  itemKey,
  legacyConditionsMatch,
  legacyQueryConditionsMatch,
  nativeToAttributeValue,
  projectItem,
  projectKey,
  setPath,
  storageKey,
  validateItem,
  validateKey,
  validatePrimaryKeyUnchanged,
  validateReturnValues,
  returnValues,
} from "./items.js";
import { compareByKeySchema, indexContainsItem, pageItems, queryTarget, validateQueryInput } from "./query.js";
import {
  backupDetails,
  backupSummary,
  exportDescription,
  exportSummary,
  globalTableDescription,
  globalTableSettings,
  importDescription,
  importSummary,
  tableReplicaAutoScalingDescription,
} from "./lifecycle.js";
import { validateBatchGet, validateBatchWrite, validateTransactionItems } from "./batch.js";
import {
  parsePartiQlStatement,
  partiqlWhereMatches,
  partiQlStatementKind,
  validatePartiQlPrimaryKeyPredicate,
  wrapPartiQl,
  type PartiQlValue,
} from "./partiql.js";
import { validateDynamoDbRequest } from "./protocol.js";

export function createDynamoDbHandler(
  ctx: Pick<RouteContext, "store" | "baseUrl">,
): (operation: DynamoDbOperationName, input: JsonMap) => JsonMap {
  const { store, baseUrl } = ctx;
  const aws = () => getAwsStore(store);

  function handle(operation: DynamoDbOperationName, input: JsonMap): JsonMap {
    validateDynamoDbRequest(operation, input);
    switch (operation) {
      case "CreateTable":
        return { TableDescription: createTable(input) };
      case "DescribeTable":
        return { Table: describeTable(input.TableName) };
      case "ListTables":
        return listTables(input);
      case "UpdateTable":
        return { TableDescription: updateTable(input) };
      case "DeleteTable":
        return { TableDescription: deleteTable(input.TableName) };
      case "PutItem":
        return putItem(input);
      case "GetItem":
        return getItem(input);
      case "UpdateItem":
        return updateItem(input);
      case "DeleteItem":
        return deleteItem(input);
      case "Query":
        return queryItems(input);
      case "Scan":
        return scanItems(input);
      case "BatchGetItem":
        return batchGetItem(input);
      case "BatchWriteItem":
        return batchWriteItem(input);
      case "TransactGetItems":
        return transactGetItems(input);
      case "TransactWriteItems":
        return transactWriteItems(input);
      case "ExecuteStatement":
        return executeStatement(input);
      case "BatchExecuteStatement":
        return {
          Responses: input.Statements.map((statement: JsonMap) => wrapPartiQl(() => executeStatement(statement))),
        };
      case "ExecuteTransaction":
        return executeTransaction(input);
      case "CreateBackup":
        return { BackupDetails: createBackup(input) };
      case "DeleteBackup":
        return { BackupDescription: { BackupDetails: deleteBackup(input.BackupArn) } };
      case "DescribeBackup":
        return { BackupDescription: { BackupDetails: backupDetails(requireBackup(input.BackupArn)) } };
      case "ListBackups":
        return listBackups(input);
      case "RestoreTableFromBackup":
        return { TableDescription: restoreTableFromBackup(input) };
      case "RestoreTableToPointInTime":
        return { TableDescription: restoreTableToPointInTime(input) };
      case "UpdateContinuousBackups":
        return updateContinuousBackups(input);
      case "DescribeContinuousBackups":
        return continuousBackups(requireTable(input.TableName));
      case "UpdateTimeToLive":
        return updateTimeToLive(input);
      case "DescribeTimeToLive":
        return describeTimeToLive(input);
      case "TagResource":
        return tagResource(input);
      case "UntagResource":
        return untagResource(input);
      case "ListTagsOfResource":
        return { Tags: requireTableByArn(input.ResourceArn).tags };
      case "PutResourcePolicy":
        return putResourcePolicy(input);
      case "GetResourcePolicy":
        return getResourcePolicy(input);
      case "DeleteResourcePolicy":
        return deleteResourcePolicy(input);
      case "ExportTableToPointInTime":
        return { ExportDescription: createExport(input) };
      case "DescribeExport":
        return { ExportDescription: exportDescription(requireExport(input.ExportArn)) };
      case "ListExports":
        return listExports(input);
      case "ImportTable":
        return { ImportTableDescription: importTable(input) };
      case "DescribeImport":
        return { ImportTableDescription: importDescription(requireImport(input.ImportArn)) };
      case "ListImports":
        return listImports(input);
      case "CreateGlobalTable":
        return { GlobalTableDescription: createGlobalTable(input) };
      case "DescribeGlobalTable":
        return { GlobalTableDescription: globalTableDescription(requireGlobalTable(input.GlobalTableName)) };
      case "DescribeGlobalTableSettings":
        return globalTableSettings(requireGlobalTable(input.GlobalTableName));
      case "ListGlobalTables":
        return {
          GlobalTables: aws()
            .dynamodbGlobalTables.all()
            .map((g) => ({ GlobalTableName: g.global_table_name })),
        };
      case "UpdateGlobalTable":
        return { GlobalTableDescription: updateGlobalTable(input) };
      case "UpdateGlobalTableSettings":
        return updateGlobalTableSettings(input);
      case "EnableKinesisStreamingDestination":
      case "DisableKinesisStreamingDestination":
      case "UpdateKinesisStreamingDestination":
        return updateKinesis(operation, input);
      case "DescribeKinesisStreamingDestination":
        return describeKinesis(input);
      case "UpdateContributorInsights":
        return updateContributorInsights(input);
      case "DescribeContributorInsights":
        return describeContributorInsights(input);
      case "ListContributorInsights":
        return listContributorInsights(input);
      case "UpdateTableReplicaAutoScaling":
        return updateTableReplicaAutoScaling(input);
      case "DescribeTableReplicaAutoScaling":
        return describeTableReplicaAutoScaling(input);
      case "DescribeLimits":
        return {
          AccountMaxReadCapacityUnits: 80000,
          AccountMaxWriteCapacityUnits: 80000,
          TableMaxReadCapacityUnits: 40000,
          TableMaxWriteCapacityUnits: 40000,
        };
      case "DescribeEndpoints":
        return { Endpoints: [{ Address: `${baseUrl}/dynamodb/`, CachePeriodInMinutes: 60 }] };
      default:
        assertNever(operation);
    }
  }

  function createTable(input: JsonMap): JsonMap {
    if (aws().dynamodbTables.findOneBy("table_name", input.TableName)) {
      throw new DynamoDbLocalError("ResourceInUseException", "Table already exists: " + input.TableName);
    }
    validateCreateTableInput(input);

    const table = aws().dynamodbTables.insert({
      table_name: input.TableName,
      table_arn: tableArn(input.TableName),
      table_id: generateAwsId("dynamodb-"),
      region: getDefaultRegion(),
      status: "CREATING",
      attribute_definitions: input.AttributeDefinitions,
      key_schema: input.KeySchema,
      local_secondary_indexes: decorateIndexes(input.LocalSecondaryIndexes ?? [], input.TableName, false),
      global_secondary_indexes: decorateIndexes(input.GlobalSecondaryIndexes ?? [], input.TableName, true),
      billing_mode: input.BillingMode ?? (input.ProvisionedThroughput ? "PROVISIONED" : "PAY_PER_REQUEST"),
      provisioned_throughput: input.ProvisionedThroughput ?? { ReadCapacityUnits: 0, WriteCapacityUnits: 0 },
      on_demand_throughput: clone(input.OnDemandThroughput),
      warm_throughput: clone(input.WarmThroughput),
      table_class: input.TableClass,
      deletion_protection_enabled: input.DeletionProtectionEnabled ?? false,
      stream_specification: input.StreamSpecification,
      sse_description: input.SSESpecification
        ? { Status: "ENABLED", SSEType: input.SSESpecification.SSEType ?? "KMS" }
        : undefined,
      tags: input.Tags ?? [],
      ttl: undefined,
      point_in_time_recovery_enabled: false,
      resource_policy: input.ResourcePolicy,
      resource_policy_revision_id: input.ResourcePolicy ? generateMessageId() : undefined,
      contributor_insights_status: "DISABLED",
      contributor_insights_mode: undefined,
      index_contributor_insights: {},
      index_contributor_insights_modes: {},
      kinesis_destinations: [],
      replica_auto_scaling: undefined,
    });
    return tableDescription(aws().dynamodbTables.update(table.id, { status: "ACTIVE" })!);
  }

  function updateTable(input: JsonMap): JsonMap {
    const table = requireTable(input.TableName);
    const patch: Partial<DynamoDbTable> = { status: "UPDATING" };
    if (input.AttributeDefinitions) patch.attribute_definitions = input.AttributeDefinitions;
    if (input.BillingMode) patch.billing_mode = input.BillingMode;
    if (input.ProvisionedThroughput) patch.provisioned_throughput = input.ProvisionedThroughput;
    if (input.OnDemandThroughput) patch.on_demand_throughput = input.OnDemandThroughput;
    if (input.WarmThroughput) patch.warm_throughput = input.WarmThroughput;
    if (input.TableClass) patch.table_class = input.TableClass;
    if (input.DeletionProtectionEnabled !== undefined)
      patch.deletion_protection_enabled = input.DeletionProtectionEnabled;
    if (input.StreamSpecification) patch.stream_specification = input.StreamSpecification;
    if (input.SSESpecification)
      patch.sse_description = { Status: "ENABLED", SSEType: input.SSESpecification.SSEType ?? "KMS" };

    const globalIndexes = [...table.global_secondary_indexes];
    for (const update of input.GlobalSecondaryIndexUpdates ?? []) {
      if (update.Create) globalIndexes.push(decorateIndexes([update.Create], table.table_name, true)[0]);
      if (update.Delete) removeByName(globalIndexes, update.Delete.IndexName);
      if (update.Update) {
        const index = globalIndexes.find((g) => g.IndexName === update.Update.IndexName);
        if (index) index.ProvisionedThroughput = update.Update.ProvisionedThroughput;
      }
    }
    patch.global_secondary_indexes = globalIndexes;
    const updating = aws().dynamodbTables.update(table.id, patch)!;
    return tableDescription(aws().dynamodbTables.update(updating.id, { status: "ACTIVE" })!);
  }

  function deleteTable(name: string): JsonMap {
    const table = requireTable(name);
    if (table.deletion_protection_enabled) {
      throw new DynamoDbLocalError(
        "ValidationException",
        `Resource cannot be deleted as it is currently protected against deletion. Disable deletion protection first.`,
      );
    }
    const deleting = aws().dynamodbTables.update(table.id, { status: "DELETING", delete_after_observation: true })!;
    for (const item of aws().dynamodbItems.findBy("table_name", table.table_name)) aws().dynamodbItems.delete(item.id);
    return { ...tableDescription(deleting), TableStatus: "DELETING" };
  }

  function listTables(input: JsonMap): JsonMap {
    const names = aws()
      .dynamodbTables.all()
      .filter((t) => t.status !== "DELETING")
      .map((t) => t.table_name)
      .sort();
    const start = input.ExclusiveStartTableName ? names.indexOf(input.ExclusiveStartTableName) + 1 : 0;
    const limit = Math.min(input.Limit ?? 100, 100);
    const page = names.slice(start, start + limit);
    return { TableNames: page, LastEvaluatedTableName: start + limit < names.length ? page.at(-1) : undefined };
  }

  function putItem(input: JsonMap): JsonMap {
    validateReturnValues("PutItem", input.ReturnValues);
    const table = requireTable(input.TableName);
    validateItem(table, input.Item);
    const key = itemKey(table, input.Item);
    const existing = aws().dynamodbItems.findOneBy("item_key", storageKey(table, key));
    if (
      !conditionMatches(input.ConditionExpression, existing?.item, input) ||
      !legacyConditionsMatch(input.Expected, existing?.item, input.ConditionalOperator)
    ) {
      throw conditionalFailure(existing?.item, input.ReturnValuesOnConditionCheckFailure);
    }
    const old = existing?.item;
    if (existing) aws().dynamodbItems.update(existing.id, { item: clone(input.Item) });
    else
      aws().dynamodbItems.insert({
        table_name: table.table_name,
        item_key: storageKey(table, key),
        item: clone(input.Item),
      });
    return withConsumedCapacity(returnValues(input.ReturnValues, undefined, undefined, old, input.Item), input, table);
  }

  function getItem(input: JsonMap): JsonMap {
    const table = requireTable(input.TableName);
    validateKey(table, input.Key);
    const found = findItem(table, input.Key);
    const result = found ? { Item: projectItem(found.item, input) } : {};
    return withConsumedCapacity(result, input, table);
  }

  function updateItem(input: JsonMap): JsonMap {
    validateReturnValues("UpdateItem", input.ReturnValues);
    const table = requireTable(input.TableName);
    validateKey(table, input.Key);
    const existing = findItem(table, input.Key);
    if (
      !conditionMatches(input.ConditionExpression, existing?.item, input) ||
      !legacyConditionsMatch(input.Expected, existing?.item, input.ConditionalOperator)
    ) {
      throw conditionalFailure(existing?.item, input.ReturnValuesOnConditionCheckFailure);
    }

    const old = clone(existing?.item ?? input.Key);
    const next = clone(existing?.item ?? input.Key);
    if (input.UpdateExpression) applyUpdateExpression(next, input.UpdateExpression, input);
    else applyLegacyAttributeUpdates(next, input.AttributeUpdates ?? {});

    validatePrimaryKeyUnchanged(table, input.Key, next);
    const key = itemKey(table, next);
    if (existing) {
      const nextStorageKey = storageKey(table, key);
      aws().dynamodbItems.update(existing.id, { item_key: nextStorageKey, item: next });
    } else {
      aws().dynamodbItems.insert({ table_name: table.table_name, item_key: storageKey(table, key), item: next });
    }
    return withConsumedCapacity(
      returnValues(input.ReturnValues, changedAttributes(old, next), changedAttributes(next, old), old, next),
      input,
      table,
    );
  }

  function deleteItem(input: JsonMap): JsonMap {
    validateReturnValues("DeleteItem", input.ReturnValues);
    const table = requireTable(input.TableName);
    validateKey(table, input.Key);
    const existing = findItem(table, input.Key);
    if (
      !conditionMatches(input.ConditionExpression, existing?.item, input) ||
      !legacyConditionsMatch(input.Expected, existing?.item, input.ConditionalOperator)
    ) {
      throw conditionalFailure(existing?.item, input.ReturnValuesOnConditionCheckFailure);
    }
    if (existing) aws().dynamodbItems.delete(existing.id);
    return withConsumedCapacity(
      returnValues(input.ReturnValues, undefined, undefined, existing?.item, undefined),
      input,
      table,
    );
  }

  function queryItems(input: JsonMap): JsonMap {
    const table = requireTable(input.TableName);
    const target = queryTarget(table, input.IndexName);
    validateQueryInput(input, target);
    const keyMatched = tableItems(table)
      .filter((entry) => indexContainsItem(target, entry.item))
      .filter(
        (entry) =>
          conditionMatches(input.KeyConditionExpression, entry.item, input) &&
          legacyQueryConditionsMatch(input.KeyConditions, entry.item, input.ConditionalOperator),
      )
      .sort((a, b) => compareByKeySchema(target.keySchema, a.item, b.item));
    if (input.ScanIndexForward === false) keyMatched.reverse();
    return pageItems(
      table,
      keyMatched,
      input,
      (entry) =>
        conditionMatches(input.FilterExpression, entry.item, input) &&
        legacyQueryConditionsMatch(input.QueryFilter, entry.item, input.ConditionalOperator),
      target,
    );
  }

  function scanItems(input: JsonMap): JsonMap {
    const table = requireTable(input.TableName);
    return pageItems(
      table,
      tableItems(table),
      input,
      (entry) =>
        conditionMatches(input.FilterExpression, entry.item, input) &&
        legacyQueryConditionsMatch(input.ScanFilter, entry.item, input.ConditionalOperator),
    );
  }

  function batchGetItem(input: JsonMap): JsonMap {
    validateBatchGet(input, requireTable);
    const responses: JsonMap = {};
    for (const [tableName, request] of Object.entries<JsonMap>(input.RequestItems)) {
      const table = requireTable(tableName);
      responses[tableName] = (request.Keys ?? [])
        .map((key: DynamoDbItem) => findItem(table, key)?.item)
        .filter(Boolean)
        .map((item: DynamoDbItem) => projectItem(item, request));
    }
    return withConsumedCapacity(
      { Responses: responses, UnprocessedKeys: {} },
      input,
      undefined,
      Object.keys(input.RequestItems),
    );
  }

  function batchWriteItem(input: JsonMap): JsonMap {
    validateBatchWrite(input, requireTable);
    for (const [tableName, requests] of Object.entries<JsonMap[]>(input.RequestItems)) {
      for (const request of requests) {
        if (request.PutRequest) putItem({ TableName: tableName, Item: request.PutRequest.Item });
        if (request.DeleteRequest) deleteItem({ TableName: tableName, Key: request.DeleteRequest.Key });
      }
    }
    return withConsumedCapacity({ UnprocessedItems: {} }, input, undefined, Object.keys(input.RequestItems));
  }

  function transactGetItems(input: JsonMap): JsonMap {
    validateTransactionItems(input.TransactItems, ["Get"], requireTable);
    return {
      Responses: input.TransactItems.map((entry: JsonMap) => {
        const get = entry.Get;
        const item = findItem(requireTable(get.TableName), get.Key)?.item;
        return item ? { Item: projectItem(item, get) } : {};
      }),
    };
  }

  function transactWriteItems(input: JsonMap): JsonMap {
    validateTransactionItems(input.TransactItems, ["ConditionCheck", "Put", "Update", "Delete"], requireTable);
    const snapshot = aws().dynamodbItems.snapshot();
    const reasons: JsonMap[] = input.TransactItems.map(() => ({ Code: "None" }));
    const cancel = (index: number, reason: JsonMap): never => {
      reasons[index] = reason;
      throw transactionCanceled(reasons);
    };
    try {
      for (const [index, entry] of input.TransactItems.entries()) {
        try {
          if (entry.ConditionCheck) {
            const check = entry.ConditionCheck;
            const item = findItem(requireTable(check.TableName), check.Key)?.item;
            if (!conditionMatches(check.ConditionExpression, item, check)) {
              cancel(index, { Code: "ConditionalCheckFailed", Message: "The conditional request failed" });
            }
          }
          if (entry.Put) putItem(entry.Put);
          if (entry.Update) updateItem(entry.Update);
          if (entry.Delete) deleteItem(entry.Delete);
        } catch (error) {
          if (error instanceof DynamoDbLocalError && error.code === "ConditionalCheckFailedException") {
            cancel(index, { Code: "ConditionalCheckFailed", Message: error.message });
          }
          if (error instanceof DynamoDbLocalError && error.code === "ValidationException") {
            cancel(index, { Code: "ValidationError", Message: error.message });
          }
          throw error;
        }
      }
      return withConsumedCapacity(
        {},
        input,
        undefined,
        input.TransactItems.map(
          (entry: JsonMap) => (entry.Put ?? entry.Update ?? entry.Delete ?? entry.ConditionCheck).TableName,
        ),
      );
    } catch (error) {
      aws().dynamodbItems.restore(snapshot);
      throw error;
    }
  }

  function executeStatement(input: JsonMap): JsonMap {
    const parameters = [...(input.Parameters ?? [])];
    const statement = parsePartiQlStatement(String(input.Statement ?? ""));

    if (statement.kind === "select") {
      const table = requireTable(statement.tableName);
      const limit = Number(statement.limit ?? input.Limit ?? 100);
      const start = Number(input.NextToken ?? 0);
      const matching = tableItems(table)
        .filter((entry) => partiqlWhereMatches(statement.where, entry.item, parameters))
        .map((entry) => entry.item);
      const items = matching.slice(start, start + limit);
      return compact({ Items: items, NextToken: start + limit < matching.length ? String(start + limit) : undefined });
    }

    if (statement.kind === "insert") {
      const item = resolvePartiQlValue(statement.value, parameters) as DynamoDbItem;
      const table = requireTable(statement.tableName);
      validateItem(table, item);
      if (findItem(table, itemKey(table, item))) throw validation("Duplicate primary key in PartiQL INSERT.");
      putItem({ TableName: statement.tableName, Item: item });
      return {};
    }

    if (statement.kind === "update") {
      const table = requireTable(statement.tableName);
      validatePartiQlPrimaryKeyPredicate(table, statement.where);
      const entry = tableItems(table).find((candidate) =>
        partiqlWhereMatches(statement.where, candidate.item, parameters),
      );
      if (!entry) return {};
      const next = clone(entry.item);
      for (const assignment of statement.assignments) {
        setPath(next, assignment.path, resolvePartiQlAttributeValue(assignment.value, parameters));
      }
      validatePrimaryKeyUnchanged(table, projectKey(table, entry.item), next);
      aws().dynamodbItems.update(entry.id, { item_key: storageKey(table, itemKey(table, next)), item: next });
      return {};
    }

    if (statement.kind === "delete") {
      const table = requireTable(statement.tableName);
      validatePartiQlPrimaryKeyPredicate(table, statement.where);
      for (const entry of tableItems(table).filter((candidate) =>
        partiqlWhereMatches(statement.where, candidate.item, parameters),
      )) {
        aws().dynamodbItems.delete(entry.id);
      }
      return {};
    }

    throw validation("Unsupported PartiQL statement.");
  }

  function resolvePartiQlValue(value: PartiQlValue, parameters: DynamoDbAttributeValue[]): unknown {
    if (value.kind === "literal") return value.value;
    const parameter = parameters[value.index];
    if (parameter === undefined) throw validation("PartiQL parameter was not provided.");
    return parameter;
  }

  function resolvePartiQlAttributeValue(
    value: PartiQlValue,
    parameters: DynamoDbAttributeValue[],
  ): DynamoDbAttributeValue {
    const resolved = resolvePartiQlValue(value, parameters);
    return value.kind === "literal" ? nativeToAttributeValue(resolved) : (resolved as DynamoDbAttributeValue);
  }

  function executeTransaction(input: JsonMap): JsonMap {
    const kinds = input.TransactStatements.map((statement: JsonMap) =>
      partiQlStatementKind(String(statement.Statement ?? "")),
    );
    const hasRead = kinds.includes("read");
    const hasWrite = kinds.includes("write");
    if (hasRead && hasWrite) throw validation("ExecuteTransaction cannot contain both read and write statements.");
    const snapshots = aws().dynamodbItems.snapshot();
    try {
      const responses = input.TransactStatements.map((statement: JsonMap) => executeStatement(statement));
      return hasRead ? { Responses: responses.map((response: JsonMap) => ({ Item: response.Items?.[0] })) } : {};
    } catch (error) {
      aws().dynamodbItems.restore(snapshots);
      throw error;
    }
  }

  function createBackup(input: JsonMap): JsonMap {
    const table = requireTable(input.TableName);
    if (aws().dynamodbBackups.findOneBy("backup_name", input.BackupName)) {
      throw new DynamoDbLocalError("BackupInUseException", "Backup already exists.");
    }
    const backup = aws().dynamodbBackups.insert({
      backup_name: input.BackupName,
      backup_arn: `${table.table_arn}/backup/${generateAwsId("")}`,
      table_name: table.table_name,
      table_arn: table.table_arn,
      table_definition: cloneTable(table, table.table_name),
      status: "AVAILABLE",
      snapshot: tableItems(table).map((entry) => clone(entry.item)),
    });
    return backupDetails(backup);
  }

  function deleteBackup(arn: string): JsonMap {
    const backup = requireBackup(arn);
    aws().dynamodbBackups.update(backup.id, { status: "DELETED" });
    return { ...backupDetails(backup), BackupStatus: "DELETED" };
  }

  function listBackups(input: JsonMap): JsonMap {
    const backups = aws()
      .dynamodbBackups.all()
      .filter((backup) => backup.status !== "DELETED")
      .filter((backup) => !input.TableName || backup.table_name === input.TableName)
      .sort((left, right) => left.backup_arn.localeCompare(right.backup_arn));
    const page = paginate(backups, {
      cursor: input.ExclusiveStartBackupArn,
      cursorValue: (backup) => backup.backup_arn,
      limit: input.Limit,
    });
    return compact({ BackupSummaries: page.items.map(backupSummary), LastEvaluatedBackupArn: page.nextToken });
  }

  function restoreTableFromBackup(input: JsonMap): JsonMap {
    const backup = requireBackup(input.BackupArn);
    if (aws().dynamodbTables.findOneBy("table_name", input.TargetTableName)) {
      throw new DynamoDbLocalError("TableAlreadyExistsException", "Table already exists.");
    }
    const table = aws().dynamodbTables.insert({
      ...applyRestoreOverrides(cloneTable(backup.table_definition, input.TargetTableName), input),
      table_arn: tableArn(input.TargetTableName),
      table_id: generateAwsId("dynamodb-"),
      restore_summary: {
        SourceBackupArn: input.BackupArn,
        SourceTableArn: backup.table_arn,
        RestoreDateTime: epochSeconds(new Date().toISOString()),
        RestoreInProgress: false,
      },
    });
    for (const item of backup.snapshot) {
      aws().dynamodbItems.insert({
        table_name: table.table_name,
        item_key: storageKey(table, itemKey(table, item)),
        item: clone(item),
      });
    }
    return tableDescription(table);
  }

  function restoreTableToPointInTime(input: JsonMap): JsonMap {
    const source = input.SourceTableName
      ? requireTable(input.SourceTableName)
      : requireTableByArn(input.SourceTableArn);
    if (aws().dynamodbTables.findOneBy("table_name", input.TargetTableName)) {
      throw new DynamoDbLocalError("TableAlreadyExistsException", "Table already exists.");
    }
    const table = aws().dynamodbTables.insert({
      ...applyRestoreOverrides(cloneTable(source, input.TargetTableName), input),
      table_arn: tableArn(input.TargetTableName),
      table_id: generateAwsId("dynamodb-"),
      restore_summary: {
        SourceTableArn: source.table_arn,
        RestoreDateTime: epochSeconds(new Date().toISOString()),
        RestoreInProgress: false,
      },
    });
    for (const entry of tableItems(source)) {
      aws().dynamodbItems.insert({
        table_name: table.table_name,
        item_key: storageKey(table, itemKey(table, entry.item)),
        item: clone(entry.item),
      });
    }
    return tableDescription(table);
  }

  function updateContinuousBackups(input: JsonMap): JsonMap {
    const table = requireTable(input.TableName);
    const enabled = input.PointInTimeRecoverySpecification.PointInTimeRecoveryEnabled === true;
    const period = input.PointInTimeRecoverySpecification.RecoveryPeriodInDays
      ? { RecoveryPeriodInDays: input.PointInTimeRecoverySpecification.RecoveryPeriodInDays }
      : table.point_in_time_recovery_period;
    aws().dynamodbTables.update(table.id, {
      point_in_time_recovery_enabled: enabled,
      point_in_time_recovery_period: period,
    });
    return continuousBackups({
      ...table,
      point_in_time_recovery_enabled: enabled,
      point_in_time_recovery_period: period,
    });
  }

  function updateTimeToLive(input: JsonMap): JsonMap {
    const table = requireTable(input.TableName);
    const ttl = input.TimeToLiveSpecification;
    aws().dynamodbTables.update(table.id, { ttl });
    return { TimeToLiveSpecification: ttl };
  }

  function describeTimeToLive(input: JsonMap): JsonMap {
    const table = requireTable(input.TableName);
    return {
      TimeToLiveDescription: {
        AttributeName: table.ttl?.AttributeName,
        TimeToLiveStatus: table.ttl?.Enabled ? "ENABLED" : "DISABLED",
      },
    };
  }

  function tagResource(input: JsonMap): JsonMap {
    const table = requireTableByArn(input.ResourceArn);
    const tags = [
      ...table.tags.filter((tag) => !input.Tags.some((next: JsonMap) => next.Key === tag.Key)),
      ...input.Tags,
    ];
    aws().dynamodbTables.update(table.id, { tags });
    return {};
  }

  function untagResource(input: JsonMap): JsonMap {
    const table = requireTableByArn(input.ResourceArn);
    aws().dynamodbTables.update(table.id, { tags: table.tags.filter((tag) => !input.TagKeys.includes(tag.Key)) });
    return {};
  }

  function putResourcePolicy(input: JsonMap): JsonMap {
    const table = requireTableByArn(input.ResourceArn);
    if (input.ExpectedRevisionId && input.ExpectedRevisionId !== table.resource_policy_revision_id) {
      throw new DynamoDbLocalError(
        "PolicyNotFoundException",
        "The expected revision does not match the current resource policy.",
      );
    }
    const revision = generateMessageId();
    aws().dynamodbTables.update(table.id, { resource_policy: input.Policy, resource_policy_revision_id: revision });
    return { RevisionId: revision };
  }

  function getResourcePolicy(input: JsonMap): JsonMap {
    const table = requireTableByArn(input.ResourceArn);
    const policy = table.resource_policy;
    if (!policy) throw new DynamoDbLocalError("ResourceNotFoundException", "Resource policy not found.");
    return { Policy: policy, RevisionId: table.resource_policy_revision_id };
  }

  function deleteResourcePolicy(input: JsonMap): JsonMap {
    const table = requireTableByArn(input.ResourceArn);
    if (input.ExpectedRevisionId && input.ExpectedRevisionId !== table.resource_policy_revision_id) {
      throw new DynamoDbLocalError(
        "PolicyNotFoundException",
        "The expected revision does not match the current resource policy.",
      );
    }
    aws().dynamodbTables.update(table.id, { resource_policy: undefined, resource_policy_revision_id: undefined });
    return {};
  }

  function createExport(input: JsonMap): JsonMap {
    const table = requireTableByArn(input.TableArn);
    const items = tableItems(table);
    const now = new Date().toISOString();
    const exp = aws().dynamodbExports.insert({
      export_arn: `${table.table_arn}/export/${generateAwsId("")}`,
      table_arn: table.table_arn,
      s3_bucket: input.S3Bucket,
      s3_prefix: input.S3Prefix,
      s3_sse_algorithm: input.S3SseAlgorithm,
      s3_sse_kms_key_id: input.S3SseKmsKeyId,
      export_format: input.ExportFormat ?? "DYNAMODB_JSON",
      export_type: input.ExportType ?? "FULL_EXPORT",
      export_time: now,
      started_at: now,
      completed_at: now,
      billed_size_bytes: items.reduce((total, entry) => total + itemSizeBytes(entry.item), 0),
      item_count: items.length,
      status: "COMPLETED",
    });
    return exportDescription(exp);
  }

  function itemSizeBytes(item: DynamoDbItem): number {
    return Object.entries(item).reduce((total, [name, value]) => total + name.length + attributeSize(value), 0);
  }

  function listExports(input: JsonMap): JsonMap {
    const exports = aws()
      .dynamodbExports.all()
      .filter((exp) => !input.TableArn || exp.table_arn === input.TableArn)
      .sort((left, right) => left.export_arn.localeCompare(right.export_arn));
    const page = paginate(exports, {
      cursor: input.NextToken,
      cursorValue: (exp) => exp.export_arn,
      limit: input.MaxResults,
    });
    return compact({ ExportSummaries: page.items.map(exportSummary), NextToken: page.nextToken });
  }

  function importTable(input: JsonMap): JsonMap {
    const params = input.TableCreationParameters;
    validateCreateTableInput(params);
    const tableDescription = createTable(params);
    const completedAt = new Date().toISOString();
    const imp = aws().dynamodbImports.insert({
      import_arn: `${tableDescription.TableArn}/import/${generateAwsId("")}`,
      table_name: params.TableName,
      table_id: tableDescription.TableId,
      table_arn: tableDescription.TableArn,
      client_token: input.ClientToken,
      s3_bucket_source: clone(input.S3BucketSource),
      input_format: input.InputFormat,
      input_format_options: clone(input.InputFormatOptions),
      input_compression_type: input.InputCompressionType ?? "NONE",
      table_creation_parameters: clone(params),
      status: "COMPLETED",
      started_at: completedAt,
      completed_at: completedAt,
      error_count: 0,
      processed_size_bytes: 0,
      processed_item_count: 0,
      imported_item_count: 0,
    });
    return importDescription(imp);
  }

  function listImports(input: JsonMap): JsonMap {
    const imports = aws()
      .dynamodbImports.all()
      .filter((imp) => !input.TableArn || (imp.table_arn ?? tableArn(imp.table_name)) === input.TableArn)
      .filter((imp) => !input.TableArnPrefix || (imp.table_arn ?? tableArn(imp.table_name)).startsWith(input.TableArnPrefix))
      .sort((left, right) => left.import_arn.localeCompare(right.import_arn));
    const page = paginate(imports, {
      cursor: input.NextToken,
      cursorValue: (imp) => imp.import_arn,
      limit: input.PageSize,
    });
    return compact({ ImportSummaryList: page.items.map(importSummary), NextToken: page.nextToken });
  }

  function createGlobalTable(input: JsonMap): JsonMap {
    if (aws().dynamodbGlobalTables.findOneBy("global_table_name", input.GlobalTableName)) {
      throw new DynamoDbLocalError("GlobalTableAlreadyExistsException", "Global table already exists.");
    }
    const global = aws().dynamodbGlobalTables.insert({
      global_table_name: input.GlobalTableName,
      global_table_arn: `arn:aws:dynamodb::${getAccountId()}:global-table/${input.GlobalTableName}`,
      status: "ACTIVE",
      replication_group: input.ReplicationGroup,
    });
    return globalTableDescription(global);
  }

  function updateGlobalTable(input: JsonMap): JsonMap {
    const global = requireGlobalTable(input.GlobalTableName);
    let replicationGroup = [...global.replication_group];
    for (const update of input.ReplicaUpdates ?? []) {
      if (update.Create) replicationGroup.push(update.Create);
      if (update.Delete)
        replicationGroup = replicationGroup.filter((replica) => replica.RegionName !== update.Delete.RegionName);
    }
    return globalTableDescription(
      aws().dynamodbGlobalTables.update(global.id, { replication_group: replicationGroup })!,
    );
  }

  function updateGlobalTableSettings(input: JsonMap): JsonMap {
    const global = requireGlobalTable(input.GlobalTableName);
    const globalIndexSettings = input.GlobalTableGlobalSecondaryIndexSettingsUpdate ?? [];
    const replicaSettings = global.replication_group.map((replica) => {
      const update = (input.ReplicaSettingsUpdate ?? []).find(
        (candidate: JsonMap) => candidate.RegionName === replica.RegionName,
      );
      const replicaIndexSettings = [
        ...globalIndexSettings,
        ...(update?.ReplicaGlobalSecondaryIndexSettingsUpdate ?? []),
      ].reduce((settings: JsonMap[], index: JsonMap) => {
        const existing = settings.find((candidate) => candidate.IndexName === index.IndexName);
        if (existing) Object.assign(existing, index);
        else settings.push({ ...index });
        return settings;
      }, []);
      return compact({
        ...replica,
        ...update,
        ReplicaBillingModeSummary: input.GlobalTableBillingMode
          ? { BillingMode: input.GlobalTableBillingMode }
          : replica.ReplicaBillingModeSummary,
        ReplicaProvisionedWriteCapacityUnits:
          input.GlobalTableProvisionedWriteCapacityUnits ?? replica.ReplicaProvisionedWriteCapacityUnits,
        ReplicaProvisionedWriteCapacityAutoScalingSettings:
          input.GlobalTableProvisionedWriteCapacityAutoScalingSettingsUpdate ??
          replica.ReplicaProvisionedWriteCapacityAutoScalingSettings,
        ReplicaGlobalSecondaryIndexSettings: replicaIndexSettings.length
          ? replicaIndexSettings
          : replica.ReplicaGlobalSecondaryIndexSettings,
        ReplicaTableClassSummary:
          update?.ReplicaTableClass ? { TableClass: update.ReplicaTableClass } : replica.ReplicaTableClassSummary,
      });
    });
    aws().dynamodbGlobalTables.update(global.id, { replication_group: replicaSettings });
    return globalTableSettings({ ...global, replication_group: replicaSettings });
  }

  function updateKinesis(operation: DynamoDbOperationName, input: JsonMap): JsonMap {
    const table = requireTable(input.TableName);
    const destinations = table.kinesis_destinations.filter((destination) => destination.StreamArn !== input.StreamArn);
    const status = operation === "DisableKinesisStreamingDestination" ? "DISABLED" : "ACTIVE";
    const config =
      operation === "UpdateKinesisStreamingDestination"
        ? input.UpdateKinesisStreamingConfiguration
        : input.EnableKinesisStreamingConfiguration;
    const destinationPrecision = config?.ApproximateCreationDateTimePrecision ?? input.ApproximateCreationDateTimePrecision;
    if (status !== "DISABLED")
      destinations.push({
        StreamArn: input.StreamArn,
        DestinationStatus: status,
        DestinationStatusDescription: input.DestinationStatusDescription,
        ApproximateCreationDateTimePrecision: destinationPrecision,
      });
    aws().dynamodbTables.update(table.id, { kinesis_destinations: destinations });
    return compact({
      TableName: table.table_name,
      StreamArn: input.StreamArn,
      DestinationStatus: status,
      EnableKinesisStreamingConfiguration:
        operation === "UpdateKinesisStreamingDestination" ? undefined : input.EnableKinesisStreamingConfiguration,
      UpdateKinesisStreamingConfiguration:
        operation === "UpdateKinesisStreamingDestination" ? input.UpdateKinesisStreamingConfiguration : undefined,
    });
  }

  function describeKinesis(input: JsonMap): JsonMap {
    const table = requireTable(input.TableName);
    return { TableName: table.table_name, KinesisDataStreamDestinations: table.kinesis_destinations };
  }

  function updateContributorInsights(input: JsonMap): JsonMap {
    const table = requireTable(input.TableName);
    const status = input.ContributorInsightsAction === "ENABLE" ? "ENABLED" : "DISABLED";
    const mode = input.ContributorInsightsMode;
    if (input.IndexName) {
      aws().dynamodbTables.update(table.id, {
        index_contributor_insights: { ...(table.index_contributor_insights ?? {}), [input.IndexName]: status },
        index_contributor_insights_modes: {
          ...(table.index_contributor_insights_modes ?? {}),
          ...(mode ? { [input.IndexName]: mode } : {}),
        },
      });
      return compact({
        TableName: table.table_name,
        IndexName: input.IndexName,
        ContributorInsightsStatus: status,
        ContributorInsightsMode: mode,
      });
    }
    aws().dynamodbTables.update(table.id, { contributor_insights_status: status, contributor_insights_mode: mode });
    return compact({ TableName: table.table_name, ContributorInsightsStatus: status, ContributorInsightsMode: mode });
  }

  function describeContributorInsights(input: JsonMap): JsonMap {
    const table = requireTable(input.TableName);
    const status = input.IndexName
      ? table.index_contributor_insights?.[input.IndexName]
      : table.contributor_insights_status;
    const mode = input.IndexName
      ? table.index_contributor_insights_modes?.[input.IndexName]
      : table.contributor_insights_mode;
    return compact({
      TableName: table.table_name,
      IndexName: input.IndexName,
      ContributorInsightsRuleList: [],
      ContributorInsightsStatus: status ?? "DISABLED",
      ContributorInsightsMode: mode,
    });
  }

  function listContributorInsights(input: JsonMap): JsonMap {
    const tables = aws()
      .dynamodbTables.all()
      .filter((table) => !input.TableName || table.table_name === input.TableName);
    const summaries = tables.flatMap((table) => {
      const tableSummary = compact({
        ...contributorInsightsSummary(table),
        ContributorInsightsMode: table.contributor_insights_mode,
      });
      const indexSummaries = Object.entries(table.index_contributor_insights ?? {}).map(
        ([IndexName, ContributorInsightsStatus]) => ({
          TableName: table.table_name,
          IndexName,
          ContributorInsightsStatus,
          ContributorInsightsMode: table.index_contributor_insights_modes?.[IndexName],
        }),
      );
      return [tableSummary, ...indexSummaries];
    });
    const page = paginate(summaries, {
      cursor: input.NextToken,
      cursorValue: (summary) => `${summary.TableName}:${summary.IndexName ?? ""}`,
      limit: input.MaxResults,
    });
    return compact({ ContributorInsightsSummaries: page.items, NextToken: page.nextToken });
  }

  function updateTableReplicaAutoScaling(input: JsonMap): JsonMap {
    const table = requireTable(input.TableName);
    aws().dynamodbTables.update(table.id, { replica_auto_scaling: input });
    return {
      TableAutoScalingDescription: tableReplicaAutoScalingDescription({ ...table, replica_auto_scaling: input }),
    };
  }

  function describeTableReplicaAutoScaling(input: JsonMap): JsonMap {
    const table = requireTable(input.TableName);
    return {
      TableAutoScalingDescription: tableReplicaAutoScalingDescription(table),
    };
  }

  function requireTable(name: string): DynamoDbTable {
    const table = name?.startsWith("arn:")
      ? aws().dynamodbTables.findOneBy("table_arn", name)
      : aws().dynamodbTables.findOneBy("table_name", name);
    if (!table)
      throw new DynamoDbLocalError("ResourceNotFoundException", `Cannot do operations on a non-existent table`);
    return table;
  }

  function requireTableByArn(arn: string): DynamoDbTable {
    const table = aws().dynamodbTables.findOneBy("table_arn", arn);
    if (!table) throw new DynamoDbLocalError("ResourceNotFoundException", "Requested resource not found.");
    return table;
  }

  function requireBackup(arn: string) {
    const backup = aws().dynamodbBackups.findOneBy("backup_arn", arn);
    if (!backup) throw new DynamoDbLocalError("BackupNotFoundException", "Backup not found.");
    return backup;
  }

  function requireExport(arn: string) {
    const exp = aws().dynamodbExports.findOneBy("export_arn", arn);
    if (!exp) throw new DynamoDbLocalError("ExportNotFoundException", "Export not found.");
    return exp;
  }

  function requireImport(arn: string) {
    const imp = aws().dynamodbImports.findOneBy("import_arn", arn);
    if (!imp) throw new DynamoDbLocalError("ImportNotFoundException", "Import not found.");
    return imp;
  }

  function requireGlobalTable(name: string) {
    const global = aws().dynamodbGlobalTables.findOneBy("global_table_name", name);
    if (!global) throw new DynamoDbLocalError("GlobalTableNotFoundException", "Global table not found.");
    return global;
  }

  function findItem(table: DynamoDbTable, key: DynamoDbItem) {
    return aws().dynamodbItems.findOneBy("item_key", storageKey(table, itemKey(table, key)));
  }

  function tableItems(table: DynamoDbTable) {
    return aws().dynamodbItems.findBy("table_name", table.table_name);
  }

  function describeTable(name: string): JsonMap {
    const table = requireTable(name);
    const description = tableDescription(table);
    if (table.status === "DELETING" && table.delete_after_observation) {
      aws().dynamodbTables.delete(table.id);
    }
    return description;
  }

  return handle;
}
