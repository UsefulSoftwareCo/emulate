import { compact, epochSeconds } from "./common.js";
import { tableArn } from "./tables.js";
import type { JsonMap } from "./types.js";

export function backupDetails(backup: JsonMap): JsonMap {
  return {
    BackupArn: backup.backup_arn,
    BackupName: backup.backup_name,
    BackupStatus: backup.status,
    BackupCreationDateTime: epochSeconds(backup.created_at),
    BackupSizeBytes: 0,
  };
}

export function backupSummary(backup: JsonMap): JsonMap {
  return { TableName: backup.table_name, TableArn: backup.table_arn, BackupArn: backup.backup_arn, BackupName: backup.backup_name, BackupStatus: backup.status };
}

export function exportDescription(exp: JsonMap): JsonMap {
  return compact({
    ExportArn: exp.export_arn,
    ExportStatus: exp.status,
    ExportType: exp.export_type,
    TableArn: exp.table_arn,
    S3Bucket: exp.s3_bucket,
    S3Prefix: exp.s3_prefix,
    S3SseAlgorithm: exp.s3_sse_algorithm,
    S3SseKmsKeyId: exp.s3_sse_kms_key_id,
    ExportFormat: exp.export_format,
    ExportTime: epochSeconds(exp.export_time ?? exp.created_at),
    StartTime: epochSeconds(exp.started_at ?? exp.created_at),
    EndTime: exp.completed_at ? epochSeconds(exp.completed_at) : undefined,
    BilledSizeBytes: exp.billed_size_bytes,
    ItemCount: exp.item_count,
    FailureCode: exp.failure_code,
    FailureMessage: exp.failure_message,
  });
}

export function exportSummary(exp: JsonMap): JsonMap {
  return compact({ ExportArn: exp.export_arn, ExportStatus: exp.status, ExportType: exp.export_type });
}

export function importDescription(imp: JsonMap): JsonMap {
  return compact({
    ImportArn: imp.import_arn,
    ImportStatus: imp.status,
    TableArn: imp.table_arn ?? tableArn(imp.table_name),
    TableId: imp.table_id,
    ClientToken: imp.client_token,
    S3BucketSource: imp.s3_bucket_source,
    InputFormat: imp.input_format,
    InputFormatOptions: imp.input_format_options,
    InputCompressionType: imp.input_compression_type,
    TableCreationParameters: imp.table_creation_parameters,
    StartTime: epochSeconds(imp.started_at ?? imp.created_at),
    EndTime: imp.completed_at ? epochSeconds(imp.completed_at) : undefined,
    ProcessedSizeBytes: imp.processed_size_bytes,
    ProcessedItemCount: imp.processed_item_count,
    ImportedItemCount: imp.imported_item_count,
    ErrorCount: imp.error_count,
    FailureCode: imp.failure_code,
    FailureMessage: imp.failure_message,
  });
}

export function importSummary(imp: JsonMap): JsonMap {
  return compact({
    ImportArn: imp.import_arn,
    ImportStatus: imp.status,
    TableArn: imp.table_arn ?? tableArn(imp.table_name),
    S3BucketSource: imp.s3_bucket_source,
    InputFormat: imp.input_format,
    StartTime: epochSeconds(imp.started_at ?? imp.created_at),
    EndTime: imp.completed_at ? epochSeconds(imp.completed_at) : undefined,
  });
}

export function globalTableDescription(global: JsonMap): JsonMap {
  return { GlobalTableName: global.global_table_name, GlobalTableArn: global.global_table_arn, GlobalTableStatus: global.status, ReplicationGroup: global.replication_group };
}

export function autoScalingSettingsDescription(settings: JsonMap | undefined): JsonMap | undefined {
  if (!settings) return undefined;
  return compact({
    MinimumUnits: settings.MinimumUnits,
    MaximumUnits: settings.MaximumUnits,
    AutoScalingDisabled: settings.AutoScalingDisabled,
    AutoScalingRoleArn: settings.AutoScalingRoleArn,
    ScalingPolicies:
      settings.ScalingPolicies ??
      (settings.ScalingPolicyUpdate
        ? [
            compact({
              PolicyName: settings.ScalingPolicyUpdate.PolicyName,
              TargetTrackingScalingPolicyConfiguration:
                settings.ScalingPolicyUpdate.TargetTrackingScalingPolicyConfiguration,
            }),
          ]
        : undefined),
  });
}

function replicaGlobalSecondaryIndexSettingsDescription(settings: JsonMap): JsonMap {
  return compact({
    IndexName: settings.IndexName,
    IndexStatus: settings.IndexStatus ?? "ACTIVE",
    ProvisionedReadCapacityUnits: settings.ProvisionedReadCapacityUnits,
    ProvisionedReadCapacityAutoScalingSettings: autoScalingSettingsDescription(
      settings.ProvisionedReadCapacityAutoScalingSettings ?? settings.ProvisionedReadCapacityAutoScalingSettingsUpdate,
    ),
    ProvisionedWriteCapacityUnits: settings.ProvisionedWriteCapacityUnits,
    ProvisionedWriteCapacityAutoScalingSettings: autoScalingSettingsDescription(
      settings.ProvisionedWriteCapacityAutoScalingSettings ?? settings.ProvisionedWriteCapacityAutoScalingSettingsUpdate,
    ),
  });
}

function replicaSettingsDescription(replica: JsonMap): JsonMap {
  return compact({
    RegionName: replica.RegionName,
    ReplicaStatus: replica.ReplicaStatus ?? "ACTIVE",
    ReplicaBillingModeSummary: replica.ReplicaBillingModeSummary ?? { BillingMode: replica.BillingMode ?? "PAY_PER_REQUEST" },
    ReplicaProvisionedReadCapacityUnits: replica.ReplicaProvisionedReadCapacityUnits,
    ReplicaProvisionedReadCapacityAutoScalingSettings: autoScalingSettingsDescription(
      replica.ReplicaProvisionedReadCapacityAutoScalingSettings ??
        replica.ReplicaProvisionedReadCapacityAutoScalingSettingsUpdate,
    ),
    ReplicaProvisionedWriteCapacityUnits: replica.ReplicaProvisionedWriteCapacityUnits,
    ReplicaProvisionedWriteCapacityAutoScalingSettings: autoScalingSettingsDescription(
      replica.ReplicaProvisionedWriteCapacityAutoScalingSettings ??
        replica.ReplicaProvisionedWriteCapacityAutoScalingSettingsUpdate,
    ),
    ReplicaGlobalSecondaryIndexSettings:
      replica.ReplicaGlobalSecondaryIndexSettings?.map(replicaGlobalSecondaryIndexSettingsDescription) ??
      replica.ReplicaGlobalSecondaryIndexSettingsUpdate?.map(replicaGlobalSecondaryIndexSettingsDescription),
    ReplicaTableClassSummary:
      replica.ReplicaTableClassSummary ??
      (replica.ReplicaTableClass ? { TableClass: replica.ReplicaTableClass } : undefined),
  });
}

export function globalTableSettings(global: JsonMap): JsonMap {
  return {
    GlobalTableName: global.global_table_name,
    ReplicaSettings: global.replication_group.map(replicaSettingsDescription),
  };
}

export function tableReplicaAutoScalingDescription(table: JsonMap): JsonMap {
  const replicaAutoScaling = table.replica_auto_scaling;
  return {
    TableName: table.table_name,
    TableStatus: table.status ?? "ACTIVE",
    Replicas: (replicaAutoScaling?.ReplicaUpdates ?? []).map((replica: JsonMap) =>
      compact({
        RegionName: replica.RegionName,
        GlobalSecondaryIndexes: replica.ReplicaGlobalSecondaryIndexUpdates?.map((index: JsonMap) =>
          compact({
            IndexName: index.IndexName,
            IndexStatus: index.IndexStatus ?? "ACTIVE",
            ProvisionedReadCapacityAutoScalingSettings: autoScalingSettingsDescription(
              index.ProvisionedReadCapacityAutoScalingSettings ?? index.ProvisionedReadCapacityAutoScalingUpdate,
            ),
            ProvisionedWriteCapacityAutoScalingSettings: autoScalingSettingsDescription(
              index.ProvisionedWriteCapacityAutoScalingSettings ?? index.ProvisionedWriteCapacityAutoScalingUpdate,
            ),
          }),
        ),
        ReplicaProvisionedReadCapacityAutoScalingSettings: autoScalingSettingsDescription(
          replica.ReplicaProvisionedReadCapacityAutoScalingSettings ??
            replica.ReplicaProvisionedReadCapacityAutoScalingUpdate,
        ),
        ReplicaProvisionedWriteCapacityAutoScalingSettings: autoScalingSettingsDescription(
          replica.ReplicaProvisionedWriteCapacityAutoScalingSettings ??
            replica.ReplicaProvisionedWriteCapacityAutoScalingUpdate,
        ),
        ReplicaStatus: replica.ReplicaStatus ?? "ACTIVE",
      }),
    ),
  };
}
