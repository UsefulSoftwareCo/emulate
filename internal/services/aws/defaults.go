package aws

import (
	"strings"
	"time"

	corestore "github.com/vercel-labs/emulate/internal/core/store"
	"github.com/vercel-labs/emulate/internal/services/aws/gateway"
)

func seedS3Defaults(store Store, region string) {
	if len(store.S3Buckets.FindBy("bucket_name", "emulate-default")) > 0 {
		return
	}
	store.S3Buckets.Insert(corestore.Record{
		"bucket_name":        "emulate-default",
		"region":             region,
		"creation_date":      time.Now().UTC().Format(time.RFC3339Nano),
		"acl":                "private",
		"versioning_enabled": false,
	})
}

func seedSQSDefaults(store Store, baseURL string, accountID string, region string) {
	if len(store.SQSQueues.FindBy("queue_name", "emulate-default-queue")) > 0 {
		return
	}
	if accountID == "" {
		accountID = gateway.DefaultAccountID
	}
	if region == "" {
		region = gateway.DefaultRegion
	}
	if baseURL == "" {
		baseURL = "http://127.0.0.1"
	}
	queueName := "emulate-default-queue"
	store.SQSQueues.Insert(corestore.Record{
		"queue_name":                queueName,
		"queue_url":                 strings.TrimRight(baseURL, "/") + "/sqs/" + accountID + "/" + queueName,
		"arn":                       "arn:aws:sqs:" + region + ":" + accountID + ":" + queueName,
		"visibility_timeout":        30,
		"delay_seconds":             0,
		"max_message_size":          262144,
		"message_retention_period":  345600,
		"receive_message_wait_time": 0,
		"fifo":                      false,
	})
}
