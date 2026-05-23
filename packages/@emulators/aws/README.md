# @emulators/aws

Metadata package for the AWS cloud services emulator. The native Go engine distributed by the `emulate` npm package implements S3, SQS, SNS, EventBridge, API Gateway v2, DynamoDB, CloudWatch Logs, Secrets Manager, SSM Parameter Store, KMS, Lambda, IAM, and STS.

```bash
npm install emulate @emulators/aws
npx emulate --service aws
```

`@emulators/aws` remains importable for package discovery and compatibility, but it no longer contains a Node.js service implementation.
