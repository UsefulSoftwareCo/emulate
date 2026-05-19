# @emulators/aws

S3, DynamoDB, SQS, IAM, and STS emulation with AWS SDK-compatible S3 paths, DynamoDB JSON protocol endpoints, and query-style SQS/IAM/STS endpoints.

Part of [emulate](https://github.com/vercel-labs/emulate) — local drop-in replacement services for CI and no-network sandboxes.

## Install

```bash
npm install @emulators/aws
```

## Endpoints

### S3

S3 routes use root paths matching the real AWS S3 wire format, so the official AWS SDK works out of the box with `forcePathStyle: true`. Legacy `/s3/` prefixed paths are also supported for backward compatibility.

- `GET /` — list all buckets
- `PUT /:bucket` — create bucket
- `DELETE /:bucket` — delete bucket
- `HEAD /:bucket` — check existence
- `GET /:bucket` — list objects (prefix, delimiter, max-keys, continuation-token, start-after)
- `POST /:bucket` — presigned POST upload (browser-style multipart form with policy validation)
- `PUT /:bucket/:key` — put object (supports copy via `x-amz-copy-source`)
- `GET /:bucket/:key` — get object
- `HEAD /:bucket/:key` — head object
- `DELETE /:bucket/:key` — delete object

### SQS
All operations via `POST /sqs/` with `Action` parameter:
- `CreateQueue`, `ListQueues`, `GetQueueUrl`, `GetQueueAttributes`
- `SendMessage`, `ReceiveMessage`, `DeleteMessage`
- `PurgeQueue`, `DeleteQueue`

### DynamoDB

All operations use the DynamoDB JSON protocol via `POST /` or `POST /dynamodb/` with the `X-Amz-Target` header.

Compatibility coverage:

- Table lifecycle: `CreateTable`, `DescribeTable`, `ListTables`, `UpdateTable`, and `DeleteTable`, including key schema, LSI, GSI, billing mode, stream, SSE, table class, warm throughput, and deletion protection metadata.
- Item APIs: `PutItem`, `GetItem`, `UpdateItem`, `DeleteItem`, `Query`, and `Scan`, including DynamoDB AttributeValue items, condition expressions, update expressions, projection and filter expressions, consumed capacity responses, and key condition validation for tables and secondary indexes.
- Batch and transaction APIs: `BatchGetItem`, `BatchWriteItem`, `TransactGetItems`, and `TransactWriteItems`, including rollback and ordered cancellation reasons for supported validation and condition failures.
- PartiQL APIs: `ExecuteStatement`, `BatchExecuteStatement`, and `ExecuteTransaction` for bounded `SELECT`, `INSERT`, `UPDATE`, and `DELETE` statements with primary key predicates.
- Local admin metadata: TTL, PITR, backups, restores, imports, exports, tags, resource policies, global tables, Kinesis destinations, contributor insights, and table replica auto scaling.

Known local emulator limits:

- State is in-memory and scoped to the emulator process and seed config.
- Lifecycle and metadata operations complete locally. They do not create S3 objects, deliver Kinesis records, run streams, expire TTL items, perform cross-region replication, or change real autoscaling capacity.
- Capacity, throttling, billing, IAM policy evaluation, and cryptographic SigV4 verification are not modeled.
- PartiQL and expression support is intentionally bounded to the application test paths above, not the full DynamoDB grammar.

### IAM
All operations via `POST /iam/` with `Action` parameter:
- `CreateUser`, `GetUser`, `ListUsers`, `DeleteUser`
- `CreateAccessKey`, `ListAccessKeys`, `DeleteAccessKey`
- `CreateRole`, `GetRole`, `ListRoles`, `DeleteRole`

### STS
All operations via `POST /sts/` with `Action` parameter:
- `GetCallerIdentity`, `AssumeRole`

## Auth

Bearer tokens or IAM access key credentials. Default key pair always seeded: `AKIAIOSFODNN7EXAMPLE` / `wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY`.

## Seed Configuration

```yaml
aws:
  region: us-east-1
  s3:
    buckets:
      - name: my-app-bucket
      - name: my-app-uploads
  dynamodb:
    tables:
      - name: my-app-table
        attribute_definitions:
          - AttributeName: id
            AttributeType: S
        key_schema:
          - AttributeName: id
            KeyType: HASH
        items:
          - id:
              S: seed-1
            name:
              S: Seed item
  sqs:
    queues:
      - name: my-app-events
      - name: my-app-dlq
  iam:
    users:
      - user_name: developer
        create_access_key: true
    roles:
      - role_name: lambda-execution-role
        description: Role for Lambda function execution
```

## Links

- [Full documentation](https://emulate.dev/aws)
- [GitHub](https://github.com/vercel-labs/emulate)
