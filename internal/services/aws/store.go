package aws

import corestore "github.com/vercel-labs/emulate/internal/core/store"

type Store struct {
	S3Buckets        *corestore.Collection
	S3Objects        *corestore.Collection
	SQSQueues        *corestore.Collection
	SQSMessages      *corestore.Collection
	SNSTopics        *corestore.Collection
	SNSSubscriptions *corestore.Collection
	SNSDeliveries    *corestore.Collection
	IAMUsers         *corestore.Collection
	IAMRoles         *corestore.Collection
	DynamoDBTables   *corestore.Collection
	DynamoDBItems    *corestore.Collection
}

func NewStore(runtimeStore *corestore.Store) Store {
	return Store{
		S3Buckets:        runtimeStore.MustCollection("aws.s3_buckets", "bucket_name"),
		S3Objects:        runtimeStore.MustCollection("aws.s3_objects", "key", "bucket_name"),
		SQSQueues:        runtimeStore.MustCollection("aws.sqs_queues", "queue_name", "queue_url"),
		SQSMessages:      runtimeStore.MustCollection("aws.sqs_messages", "message_id", "queue_name"),
		SNSTopics:        runtimeStore.MustCollection("aws.sns_topics", "topic_name", "arn"),
		SNSSubscriptions: runtimeStore.MustCollection("aws.sns_subscriptions", "subscription_arn", "topic_arn", "protocol", "endpoint"),
		SNSDeliveries:    runtimeStore.MustCollection("aws.sns_deliveries", "message_id", "topic_arn", "subscription_arn"),
		IAMUsers:         runtimeStore.MustCollection("aws.iam_users", "user_name", "user_id"),
		IAMRoles:         runtimeStore.MustCollection("aws.iam_roles", "role_name", "role_id"),
		DynamoDBTables:   runtimeStore.MustCollection("aws.dynamodb_tables", "table_name", "arn"),
		DynamoDBItems:    runtimeStore.MustCollection("aws.dynamodb_items", "table_name", "table_arn", "pk", "sk"),
	}
}
