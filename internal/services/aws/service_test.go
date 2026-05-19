package aws

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	corehttp "github.com/vercel-labs/emulate/internal/core/http"
	corestore "github.com/vercel-labs/emulate/internal/core/store"
	"github.com/vercel-labs/emulate/internal/core/ui"
)

func TestServiceHandlesS3ListBuckets(t *testing.T) {
	handler := newTestHandler()
	res := executeAWSRequest(handler, http.MethodGet, "http://127.0.0.1/", nil, "s3", nil)

	if res.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", res.Code, res.Body.String())
	}
	if got := res.Header().Get("Content-Type"); got != "application/xml" {
		t.Fatalf("content type = %q", got)
	}
	if got := res.Header().Get("x-amz-request-id"); got == "" {
		t.Fatal("missing x-amz-request-id")
	}
	body := res.Body.String()
	if !strings.Contains(body, "<ListAllMyBucketsResult>") || !strings.Contains(body, "<Name>emulate-default</Name>") {
		t.Fatalf("unexpected body: %s", body)
	}
}

func TestServiceHandlesUnsignedPathStyleS3ListObjects(t *testing.T) {
	handler := newTestHandler()
	req := httptest.NewRequest(http.MethodGet, "http://127.0.0.1/photos?list-type=2", nil)

	res := httptest.NewRecorder()
	handler.ServeHTTP(res, req)

	if res.Code != http.StatusNotFound {
		t.Fatalf("status = %d, body = %s", res.Code, res.Body.String())
	}
	if got := res.Header().Get("Content-Type"); got != "application/xml" {
		t.Fatalf("content type = %q", got)
	}
	body := res.Body.String()
	if !strings.Contains(body, "<Code>NoSuchBucket</Code>") {
		t.Fatalf("unexpected body: %s", body)
	}
}

func TestServiceHandlesLegacyS3PathStyleInConservativeMode(t *testing.T) {
	handler := newTestHandler()
	req := httptest.NewRequest(http.MethodGet, "http://127.0.0.1/s3/emulate-default", nil)

	res := httptest.NewRecorder()
	handler.ServeHTTP(res, req)

	if res.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", res.Code, res.Body.String())
	}
	if got := res.Header().Get("Content-Type"); got != "application/xml" {
		t.Fatalf("content type = %q", got)
	}
	body := res.Body.String()
	if !strings.Contains(body, "<ListBucketResult>") || !strings.Contains(body, "<Name>emulate-default</Name>") {
		t.Fatalf("unexpected body: %s", body)
	}
}

func TestServiceHandlesS3BucketLifecycle(t *testing.T) {
	handler := newTestHandler()

	res := executeAWSRequest(handler, http.MethodPut, "http://127.0.0.1/photos", nil, "s3", nil)
	if res.Code != http.StatusOK {
		t.Fatalf("create status = %d, body = %s", res.Code, res.Body.String())
	}
	if got := res.Header().Get("Location"); got != "/photos" {
		t.Fatalf("location = %q", got)
	}

	res = executeAWSRequest(handler, http.MethodHead, "http://127.0.0.1/photos", nil, "s3", nil)
	if res.Code != http.StatusOK {
		t.Fatalf("head status = %d, body = %s", res.Code, res.Body.String())
	}
	if got := res.Header().Get("x-amz-bucket-region"); got != "us-east-1" {
		t.Fatalf("bucket region = %q", got)
	}

	res = executeAWSRequest(handler, http.MethodDelete, "http://127.0.0.1/photos", nil, "s3", nil)
	if res.Code != http.StatusNoContent {
		t.Fatalf("delete status = %d, body = %s", res.Code, res.Body.String())
	}

	res = executeAWSRequest(handler, http.MethodHead, "http://127.0.0.1/photos", nil, "s3", nil)
	if res.Code != http.StatusNotFound {
		t.Fatalf("missing head status = %d, body = %s", res.Code, res.Body.String())
	}
}

func TestServiceHandlesS3ObjectLifecycleWithBinaryBodyAndMetadata(t *testing.T) {
	handler := newTestHandler()
	body := []byte{0, 1, 2, 3, 255, 'o', 'k'}

	res := executeAWSRequest(handler, http.MethodPut, "http://127.0.0.1/emulate-default/docs/data.bin", body, "s3", map[string]string{
		"Content-Type":      "application/octet-stream",
		"x-amz-meta-origin": "native-test",
	})
	if res.Code != http.StatusOK {
		t.Fatalf("put status = %d, body = %s", res.Code, res.Body.String())
	}
	if got := res.Header().Get("ETag"); got == "" || !strings.HasPrefix(got, `"`) {
		t.Fatalf("etag = %q", got)
	}

	res = executeAWSRequest(handler, http.MethodGet, "http://127.0.0.1/emulate-default/docs/data.bin", nil, "s3", nil)
	if res.Code != http.StatusOK {
		t.Fatalf("get status = %d, body = %s", res.Code, res.Body.String())
	}
	if !bytes.Equal(res.Body.Bytes(), body) {
		t.Fatalf("body = %v, want %v", res.Body.Bytes(), body)
	}
	if got := res.Header().Get("Content-Type"); got != "application/octet-stream" {
		t.Fatalf("content type = %q", got)
	}
	if got := res.Header().Get("x-amz-meta-origin"); got != "native-test" {
		t.Fatalf("metadata = %q", got)
	}

	res = executeAWSRequest(handler, http.MethodHead, "http://127.0.0.1/emulate-default/docs/data.bin", nil, "s3", nil)
	if res.Code != http.StatusOK {
		t.Fatalf("head status = %d, body = %s", res.Code, res.Body.String())
	}
	if res.Body.Len() != 0 {
		t.Fatalf("head body length = %d", res.Body.Len())
	}
	if got := res.Header().Get("Content-Length"); got != "7" {
		t.Fatalf("content length = %q", got)
	}

	res = executeAWSRequest(handler, http.MethodDelete, "http://127.0.0.1/emulate-default/docs/data.bin", nil, "s3", nil)
	if res.Code != http.StatusNoContent {
		t.Fatalf("delete status = %d, body = %s", res.Code, res.Body.String())
	}

	res = executeAWSRequest(handler, http.MethodGet, "http://127.0.0.1/emulate-default/docs/data.bin", nil, "s3", nil)
	if res.Code != http.StatusNotFound {
		t.Fatalf("missing get status = %d, body = %s", res.Code, res.Body.String())
	}
	if !strings.Contains(res.Body.String(), "<Code>NoSuchKey</Code>") {
		t.Fatalf("unexpected missing body: %s", res.Body.String())
	}
}

func TestServiceHandlesS3CopyObject(t *testing.T) {
	handler := newTestHandler()

	res := executeAWSRequest(handler, http.MethodPut, "http://127.0.0.1/emulate-default/docs/source.txt", []byte("copy me"), "s3", map[string]string{
		"Content-Type": "text/plain",
	})
	if res.Code != http.StatusOK {
		t.Fatalf("put status = %d, body = %s", res.Code, res.Body.String())
	}

	res = executeAWSRequest(handler, http.MethodPut, "http://127.0.0.1/emulate-default/docs/copy.txt", nil, "s3", map[string]string{
		"x-amz-copy-source": "/emulate-default/docs/source.txt",
	})
	if res.Code != http.StatusOK {
		t.Fatalf("copy status = %d, body = %s", res.Code, res.Body.String())
	}
	if !strings.Contains(res.Body.String(), "<CopyObjectResult>") {
		t.Fatalf("unexpected copy body: %s", res.Body.String())
	}

	res = executeAWSRequest(handler, http.MethodGet, "http://127.0.0.1/emulate-default/docs/copy.txt", nil, "s3", nil)
	if res.Code != http.StatusOK {
		t.Fatalf("get status = %d, body = %s", res.Code, res.Body.String())
	}
	if got := res.Body.String(); got != "copy me" {
		t.Fatalf("body = %q", got)
	}
}

func TestServicePaginatesS3CommonPrefixes(t *testing.T) {
	handler := newTestHandler()
	for _, key := range []string{"a/file.txt", "b/file.txt", "c.txt"} {
		res := executeAWSRequest(handler, http.MethodPut, "http://127.0.0.1/emulate-default/"+key, []byte(key), "s3", nil)
		if res.Code != http.StatusOK {
			t.Fatalf("put %s status = %d, body = %s", key, res.Code, res.Body.String())
		}
	}

	page1 := executeAWSRequest(handler, http.MethodGet, "http://127.0.0.1/emulate-default?list-type=2&delimiter=/&max-keys=1", nil, "s3", nil)
	if page1.Code != http.StatusOK {
		t.Fatalf("page1 status = %d, body = %s", page1.Code, page1.Body.String())
	}
	body := page1.Body.String()
	for _, expected := range []string{"<IsTruncated>true</IsTruncated>", "<KeyCount>1</KeyCount>", "<Prefix>a/</Prefix>", "<NextContinuationToken>a/</NextContinuationToken>"} {
		if !strings.Contains(body, expected) {
			t.Fatalf("page1 missing %q in %s", expected, body)
		}
	}
	if strings.Contains(body, "<Prefix>b/</Prefix>") || strings.Contains(body, "<Key>c.txt</Key>") {
		t.Fatalf("page1 contains entries beyond max-keys: %s", body)
	}

	page2 := executeAWSRequest(handler, http.MethodGet, "http://127.0.0.1/emulate-default?list-type=2&delimiter=/&max-keys=1&continuation-token=a%2F", nil, "s3", nil)
	if page2.Code != http.StatusOK {
		t.Fatalf("page2 status = %d, body = %s", page2.Code, page2.Body.String())
	}
	body = page2.Body.String()
	if !strings.Contains(body, "<Prefix>b/</Prefix>") || strings.Contains(body, "<Prefix>a/</Prefix>") {
		t.Fatalf("unexpected page2 body: %s", body)
	}
}

func TestServiceRejectsS3PostObjectWhenPolicyExactMatchFails(t *testing.T) {
	tests := []struct {
		name       string
		conditions []any
	}{
		{
			name: "object condition",
			conditions: []any{
				map[string]string{"bucket": "emulate-default"},
				map[string]string{"key": "locked.txt"},
			},
		},
		{
			name: "eq condition",
			conditions: []any{
				[]any{"eq", "$key", "locked-eq.txt"},
			},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			handler := newTestHandler()
			res := executeS3MultipartPost(t, handler, "http://127.0.0.1/emulate-default", map[string]string{
				"key":    "tampered.txt",
				"Policy": encodePostPolicy(t, test.conditions),
			}, []byte("tampered"))

			if res.Code != http.StatusForbidden {
				t.Fatalf("post status = %d, body = %s", res.Code, res.Body.String())
			}
			if !strings.Contains(res.Body.String(), "<Code>AccessDenied</Code>") {
				t.Fatalf("unexpected body: %s", res.Body.String())
			}

			res = executeAWSRequest(handler, http.MethodGet, "http://127.0.0.1/emulate-default/tampered.txt", nil, "s3", nil)
			if res.Code != http.StatusNotFound {
				t.Fatalf("tampered object status = %d, body = %s", res.Code, res.Body.String())
			}
		})
	}
}

func TestServiceReturnsNoSuchBucketForDeleteObjectInMissingBucket(t *testing.T) {
	handler := newTestHandler()
	res := executeAWSRequest(handler, http.MethodDelete, "http://127.0.0.1/missing/docs/data.bin", nil, "s3", nil)

	if res.Code != http.StatusNotFound {
		t.Fatalf("status = %d, body = %s", res.Code, res.Body.String())
	}
	if !strings.Contains(res.Body.String(), "<Code>NoSuchBucket</Code>") {
		t.Fatalf("unexpected body: %s", res.Body.String())
	}
}

func TestServiceReturnsUnsignedS3SubresourceNotImplemented(t *testing.T) {
	tests := []struct {
		name       string
		method     string
		target     string
		wantAction string
	}{
		{
			name:       "bucket lifecycle",
			method:     http.MethodGet,
			target:     "http://127.0.0.1/photos?lifecycle",
			wantAction: "s3.GetBucketLifecycleConfiguration",
		},
		{
			name:       "bucket notification",
			method:     http.MethodPut,
			target:     "http://127.0.0.1/photos?notification",
			wantAction: "s3.PutBucketNotificationConfiguration",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			handler := newTestHandler()
			req := httptest.NewRequest(test.method, test.target, nil)

			res := httptest.NewRecorder()
			handler.ServeHTTP(res, req)

			if res.Code != http.StatusNotImplemented {
				t.Fatalf("status = %d, body = %s", res.Code, res.Body.String())
			}
			if got := res.Header().Get("Content-Type"); got != "application/xml" {
				t.Fatalf("content type = %q", got)
			}
			body := res.Body.String()
			if !strings.Contains(body, "<Code>NotImplemented</Code>") || !strings.Contains(body, test.wantAction) {
				t.Fatalf("unexpected body: %s", body)
			}
		})
	}
}

func TestServiceHandlesSQSCreateQueue(t *testing.T) {
	handler := newTestHandler()
	res := executeAWSQueryRequest(handler, "sqs", "Action=CreateQueue&QueueName=jobs")

	if res.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", res.Code, res.Body.String())
	}
	if got := res.Header().Get("Content-Type"); got != "application/xml" {
		t.Fatalf("content type = %q", got)
	}
	if got := res.Header().Get("x-amzn-requestid"); got == "" {
		t.Fatal("missing x-amzn-requestid")
	}
	body := res.Body.String()
	if !strings.Contains(body, "<CreateQueueResponse>") || !strings.Contains(body, "<QueueUrl>") || !strings.Contains(body, "jobs") {
		t.Fatalf("unexpected body: %s", body)
	}
}

func TestServiceAcceptsBearerTokenForSQSQuery(t *testing.T) {
	handler := newTestHandler()
	req := httptest.NewRequest(http.MethodPost, "http://127.0.0.1/sqs/", strings.NewReader("Action=CreateQueue&QueueName=jobs"))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Authorization", "Bearer test_token_admin")

	res := httptest.NewRecorder()
	handler.ServeHTTP(res, req)

	if res.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", res.Code, res.Body.String())
	}
	if got := res.Header().Get("Content-Type"); got != "application/xml" {
		t.Fatalf("content type = %q", got)
	}
	if body := res.Body.String(); !strings.Contains(body, "<CreateQueueResponse>") {
		t.Fatalf("unexpected body: %s", body)
	}
}

func TestServiceHandlesSQSLifecycle(t *testing.T) {
	handler := newTestHandler()

	res := executeAWSQueryRequest(handler, "sqs", "Action=ListQueues")
	if res.Code != http.StatusOK {
		t.Fatalf("list status = %d, body = %s", res.Code, res.Body.String())
	}
	if body := res.Body.String(); !strings.Contains(body, "emulate-default-queue") {
		t.Fatalf("list missing default queue: %s", body)
	}

	res = executeAWSQueryRequest(handler, "sqs", "Action=GetQueueUrl&QueueName=emulate-default-queue")
	if res.Code != http.StatusOK {
		t.Fatalf("get url status = %d, body = %s", res.Code, res.Body.String())
	}
	queueURL := xmlElement(res.Body.String(), "QueueUrl")
	if queueURL == "" {
		t.Fatalf("missing queue url in %s", res.Body.String())
	}

	res = executeAWSQueryRequest(handler, "sqs", "Action=GetQueueAttributes&QueueUrl="+url.QueryEscape(queueURL))
	if res.Code != http.StatusOK {
		t.Fatalf("attributes status = %d, body = %s", res.Code, res.Body.String())
	}
	if body := res.Body.String(); !strings.Contains(body, "<Name>QueueArn</Name>") || !strings.Contains(body, "<Name>VisibilityTimeout</Name>") {
		t.Fatalf("unexpected attributes body: %s", body)
	}

	res = executeAWSQueryRequest(handler, "sqs", "Action=SendMessage&QueueUrl="+url.QueryEscape(queueURL)+"&MessageBody=test+message")
	if res.Code != http.StatusOK {
		t.Fatalf("send status = %d, body = %s", res.Code, res.Body.String())
	}
	if body := res.Body.String(); !strings.Contains(body, "<SendMessageResponse>") || !strings.Contains(body, "<MessageId>") {
		t.Fatalf("unexpected send body: %s", body)
	}

	res = executeAWSQueryRequest(handler, "sqs", "Action=ReceiveMessage&QueueUrl="+url.QueryEscape(queueURL)+"&MaxNumberOfMessages=1")
	if res.Code != http.StatusOK {
		t.Fatalf("receive status = %d, body = %s", res.Code, res.Body.String())
	}
	body := res.Body.String()
	if !strings.Contains(body, "<Body>test message</Body>") || !strings.Contains(body, "<ReceiptHandle>") {
		t.Fatalf("unexpected receive body: %s", body)
	}
	receiptHandle := xmlElement(body, "ReceiptHandle")
	if receiptHandle == "" {
		t.Fatalf("missing receipt handle in %s", body)
	}

	res = executeAWSQueryRequest(handler, "sqs", "Action=DeleteMessage&QueueUrl="+url.QueryEscape(queueURL)+"&ReceiptHandle="+url.QueryEscape(receiptHandle))
	if res.Code != http.StatusOK {
		t.Fatalf("delete message status = %d, body = %s", res.Code, res.Body.String())
	}
	if body := res.Body.String(); !strings.Contains(body, "<DeleteMessageResponse>") {
		t.Fatalf("unexpected delete message body: %s", body)
	}
}

func TestServiceHandlesSQSPurgeAndDeleteQueue(t *testing.T) {
	handler := newTestHandler()

	res := executeAWSQueryRequest(handler, "sqs", "Action=CreateQueue&QueueName=jobs")
	if res.Code != http.StatusOK {
		t.Fatalf("create status = %d, body = %s", res.Code, res.Body.String())
	}
	queueURL := xmlElement(res.Body.String(), "QueueUrl")
	if queueURL == "" {
		t.Fatalf("missing queue url in %s", res.Body.String())
	}

	for _, body := range []string{"one", "two"} {
		res = executeAWSQueryRequest(handler, "sqs", "Action=SendMessage&QueueUrl="+url.QueryEscape(queueURL)+"&MessageBody="+url.QueryEscape(body))
		if res.Code != http.StatusOK {
			t.Fatalf("send %s status = %d, body = %s", body, res.Code, res.Body.String())
		}
	}

	res = executeAWSQueryRequest(handler, "sqs", "Action=PurgeQueue&QueueUrl="+url.QueryEscape(queueURL))
	if res.Code != http.StatusOK {
		t.Fatalf("purge status = %d, body = %s", res.Code, res.Body.String())
	}

	res = executeAWSQueryRequest(handler, "sqs", "Action=ReceiveMessage&QueueUrl="+url.QueryEscape(queueURL))
	if res.Code != http.StatusOK {
		t.Fatalf("receive after purge status = %d, body = %s", res.Code, res.Body.String())
	}
	if strings.Contains(res.Body.String(), "<Message>") {
		t.Fatalf("purged queue returned messages: %s", res.Body.String())
	}

	res = executeAWSQueryRequest(handler, "sqs", "Action=DeleteQueue&QueueUrl="+url.QueryEscape(queueURL))
	if res.Code != http.StatusOK {
		t.Fatalf("delete queue status = %d, body = %s", res.Code, res.Body.String())
	}

	res = executeAWSQueryRequest(handler, "sqs", "Action=GetQueueUrl&QueueName=jobs")
	if res.Code != http.StatusBadRequest {
		t.Fatalf("get deleted queue status = %d, body = %s", res.Code, res.Body.String())
	}
	if !strings.Contains(res.Body.String(), "<Code>AWS.SimpleQueueService.NonExistentQueue</Code>") {
		t.Fatalf("unexpected missing queue body: %s", res.Body.String())
	}
}

func TestServiceHonorsSQSMessageDelaySeconds(t *testing.T) {
	handler := newTestHandler()

	res := executeAWSQueryRequest(handler, "sqs", "Action=CreateQueue&QueueName=delayed-query")
	if res.Code != http.StatusOK {
		t.Fatalf("create status = %d, body = %s", res.Code, res.Body.String())
	}
	queueURL := xmlElement(res.Body.String(), "QueueUrl")

	values := url.Values{}
	values.Set("Action", "SendMessage")
	values.Set("QueueUrl", queueURL)
	values.Set("MessageBody", "wait for it")
	values.Set("DelaySeconds", "5")
	res = executeAWSQueryRequest(handler, "sqs", values.Encode())
	if res.Code != http.StatusOK {
		t.Fatalf("send status = %d, body = %s", res.Code, res.Body.String())
	}

	values = url.Values{}
	values.Set("Action", "ReceiveMessage")
	values.Set("QueueUrl", queueURL)
	values.Set("MaxNumberOfMessages", "1")
	res = executeAWSQueryRequest(handler, "sqs", values.Encode())
	if res.Code != http.StatusOK {
		t.Fatalf("receive status = %d, body = %s", res.Code, res.Body.String())
	}
	if strings.Contains(res.Body.String(), "<Message>") {
		t.Fatalf("delayed message was visible immediately: %s", res.Body.String())
	}
}

func TestServiceReturnsSQSQueryMessageAttributes(t *testing.T) {
	handler := newTestHandler()

	res := executeAWSQueryRequest(handler, "sqs", "Action=CreateQueue&QueueName=query-attrs")
	if res.Code != http.StatusOK {
		t.Fatalf("create status = %d, body = %s", res.Code, res.Body.String())
	}
	queueURL := xmlElement(res.Body.String(), "QueueUrl")

	values := url.Values{}
	values.Set("Action", "SendMessage")
	values.Set("QueueUrl", queueURL)
	values.Set("MessageBody", "with attrs")
	values.Set("MessageAttribute.1.Name", "color")
	values.Set("MessageAttribute.1.Value.DataType", "String")
	values.Set("MessageAttribute.1.Value.StringValue", "blue")
	res = executeAWSQueryRequest(handler, "sqs", values.Encode())
	if res.Code != http.StatusOK {
		t.Fatalf("send status = %d, body = %s", res.Code, res.Body.String())
	}
	sentAttributesMD5 := xmlElement(res.Body.String(), "MD5OfMessageAttributes")
	if sentAttributesMD5 == "" {
		t.Fatalf("send missing MD5OfMessageAttributes in %s", res.Body.String())
	}

	values = url.Values{}
	values.Set("Action", "ReceiveMessage")
	values.Set("QueueUrl", queueURL)
	values.Set("MessageAttributeName.1", "All")
	values.Set("AttributeName.1", "All")
	res = executeAWSQueryRequest(handler, "sqs", values.Encode())
	if res.Code != http.StatusOK {
		t.Fatalf("receive status = %d, body = %s", res.Code, res.Body.String())
	}
	body := res.Body.String()
	for _, expected := range []string{"<MessageAttribute>", "<Name>color</Name>", "<DataType>String</DataType>", "<StringValue>blue</StringValue>", "<Name>SenderId</Name>", "<Value>123456789012</Value>"} {
		if !strings.Contains(body, expected) {
			t.Fatalf("receive missing %q in %s", expected, body)
		}
	}
	if got := xmlElement(body, "MD5OfMessageAttributes"); got != sentAttributesMD5 {
		t.Fatalf("receive MD5OfMessageAttributes = %q, want %q in %s", got, sentAttributesMD5, body)
	}
}

func TestServiceHandlesSQSJSONMessageAttributes(t *testing.T) {
	handler := newTestHandler()

	res := executeAWSJSONRequest(t, handler, "CreateQueue", map[string]any{"QueueName": "json-attrs"})
	if res.Code != http.StatusOK {
		t.Fatalf("create status = %d, body = %s", res.Code, res.Body.String())
	}
	var created struct {
		QueueURL string `json:"QueueUrl"`
	}
	if err := json.Unmarshal(res.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}

	res = executeAWSJSONRequest(t, handler, "SendMessage", map[string]any{
		"QueueUrl":    created.QueueURL,
		"MessageBody": "with attrs",
		"MessageAttributes": map[string]any{
			"color": map[string]any{
				"DataType":    "String",
				"StringValue": "blue",
			},
		},
	})
	if res.Code != http.StatusOK {
		t.Fatalf("send status = %d, body = %s", res.Code, res.Body.String())
	}
	var sent struct {
		MD5OfMessageAttributes string `json:"MD5OfMessageAttributes"`
	}
	if err := json.Unmarshal(res.Body.Bytes(), &sent); err != nil {
		t.Fatal(err)
	}
	if sent.MD5OfMessageAttributes == "" {
		t.Fatalf("send missing MD5OfMessageAttributes in %s", res.Body.String())
	}

	res = executeAWSJSONRequest(t, handler, "ReceiveMessage", map[string]any{
		"QueueUrl":                    created.QueueURL,
		"MessageAttributeNames":       []string{"All"},
		"MessageSystemAttributeNames": []string{"All"},
	})
	if res.Code != http.StatusOK {
		t.Fatalf("receive status = %d, body = %s", res.Code, res.Body.String())
	}
	var received struct {
		Messages []struct {
			Attributes             map[string]string `json:"Attributes"`
			MD5OfMessageAttributes string            `json:"MD5OfMessageAttributes"`
			MessageAttributes      map[string]struct {
				DataType    string `json:"DataType"`
				StringValue string `json:"StringValue"`
			} `json:"MessageAttributes"`
		} `json:"Messages"`
	}
	if err := json.Unmarshal(res.Body.Bytes(), &received); err != nil {
		t.Fatal(err)
	}
	if len(received.Messages) != 1 {
		t.Fatalf("messages = %#v", received.Messages)
	}
	color := received.Messages[0].MessageAttributes["color"]
	if color.DataType != "String" || color.StringValue != "blue" {
		t.Fatalf("message attributes = %#v", received.Messages[0].MessageAttributes)
	}
	if received.Messages[0].MD5OfMessageAttributes != sent.MD5OfMessageAttributes {
		t.Fatalf("message attribute md5 = %q, want %q", received.Messages[0].MD5OfMessageAttributes, sent.MD5OfMessageAttributes)
	}
	if received.Messages[0].Attributes["SenderId"] != "123456789012" {
		t.Fatalf("system attributes = %#v", received.Messages[0].Attributes)
	}
}

func TestServiceHonorsSQSJSONMessageDelaySeconds(t *testing.T) {
	handler := newTestHandler()

	res := executeAWSJSONRequest(t, handler, "CreateQueue", map[string]any{"QueueName": "json-delay"})
	if res.Code != http.StatusOK {
		t.Fatalf("create status = %d, body = %s", res.Code, res.Body.String())
	}
	var created struct {
		QueueURL string `json:"QueueUrl"`
	}
	if err := json.Unmarshal(res.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}

	res = executeAWSJSONRequest(t, handler, "SendMessage", map[string]any{
		"QueueUrl":     created.QueueURL,
		"MessageBody":  "wait for it",
		"DelaySeconds": json.Number("5"),
	})
	if res.Code != http.StatusOK {
		t.Fatalf("send status = %d, body = %s", res.Code, res.Body.String())
	}

	res = executeAWSJSONRequest(t, handler, "ReceiveMessage", map[string]any{
		"QueueUrl":            created.QueueURL,
		"MaxNumberOfMessages": json.Number("1"),
	})
	if res.Code != http.StatusOK {
		t.Fatalf("receive status = %d, body = %s", res.Code, res.Body.String())
	}
	var received struct {
		Messages []map[string]any `json:"Messages"`
	}
	if err := json.Unmarshal(res.Body.Bytes(), &received); err != nil {
		t.Fatal(err)
	}
	if len(received.Messages) != 0 {
		t.Fatalf("delayed message was visible immediately: %#v", received.Messages)
	}
}

func TestServiceHandlesIAMLifecycleAndAccessKeys(t *testing.T) {
	handler := newTestHandler()

	res := executeAWSQueryRequest(handler, "iam", "Action=ListUsers")
	if res.Code != http.StatusOK {
		t.Fatalf("list users status = %d, body = %s", res.Code, res.Body.String())
	}
	if body := res.Body.String(); !strings.Contains(body, "<ListUsersResponse>") || !strings.Contains(body, "admin") {
		t.Fatalf("unexpected list users body: %s", body)
	}

	res = executeAWSQueryRequest(handler, "iam", "Action=CreateUser&UserName=developer&Path=/team/")
	if res.Code != http.StatusOK {
		t.Fatalf("create user status = %d, body = %s", res.Code, res.Body.String())
	}
	developerARN := xmlElement(res.Body.String(), "Arn")
	if !strings.Contains(developerARN, ":user/team/developer") {
		t.Fatalf("developer arn = %q", developerARN)
	}

	res = executeAWSQueryRequest(handler, "iam", "Action=CreateUser&UserName=developer")
	if res.Code != http.StatusConflict {
		t.Fatalf("duplicate create status = %d, body = %s", res.Code, res.Body.String())
	}

	res = executeAWSQueryRequest(handler, "iam", "Action=GetUser&UserName=developer")
	if res.Code != http.StatusOK || !strings.Contains(res.Body.String(), "<GetUserResponse>") {
		t.Fatalf("get user status = %d, body = %s", res.Code, res.Body.String())
	}

	res = executeAWSQueryRequest(handler, "iam", "Action=CreateAccessKey&UserName=developer")
	if res.Code != http.StatusOK {
		t.Fatalf("create key status = %d, body = %s", res.Code, res.Body.String())
	}
	accessKeyID := xmlElement(res.Body.String(), "AccessKeyId")
	if !strings.HasPrefix(accessKeyID, "AKIA") {
		t.Fatalf("access key id = %q", accessKeyID)
	}

	res = executeAWSQueryRequest(handler, "iam", "Action=ListAccessKeys&UserName=developer")
	if res.Code != http.StatusOK || !strings.Contains(res.Body.String(), accessKeyID) {
		t.Fatalf("list keys status = %d, body = %s", res.Code, res.Body.String())
	}

	res = executeAWSQueryRequestWithAccessKey(handler, "sts", "Action=GetCallerIdentity", accessKeyID)
	if res.Code != http.StatusOK {
		t.Fatalf("caller identity status = %d, body = %s", res.Code, res.Body.String())
	}
	if arn := xmlElement(res.Body.String(), "Arn"); arn != developerARN {
		t.Fatalf("caller arn = %q, want %q", arn, developerARN)
	}

	res = executeAWSQueryRequest(handler, "iam", "Action=DeleteAccessKey&UserName=developer&AccessKeyId="+url.QueryEscape(accessKeyID))
	if res.Code != http.StatusOK {
		t.Fatalf("delete key status = %d, body = %s", res.Code, res.Body.String())
	}

	res = executeAWSQueryRequest(handler, "iam", "Action=DeleteUser&UserName=developer")
	if res.Code != http.StatusOK {
		t.Fatalf("delete user status = %d, body = %s", res.Code, res.Body.String())
	}
	res = executeAWSQueryRequest(handler, "iam", "Action=GetUser&UserName=developer")
	if res.Code != http.StatusNotFound {
		t.Fatalf("get deleted user status = %d, body = %s", res.Code, res.Body.String())
	}
}

func TestServiceHandlesIAMRolesAndSTS(t *testing.T) {
	handler := newTestHandler()
	policy := `{"Version":"2012-10-17","Statement":[]}`

	res := executeAWSQueryRequest(handler, "iam", "Action=CreateRole&RoleName=worker&Description=Worker+role&AssumeRolePolicyDocument="+url.QueryEscape(policy))
	if res.Code != http.StatusOK {
		t.Fatalf("create role status = %d, body = %s", res.Code, res.Body.String())
	}
	roleARN := xmlElement(res.Body.String(), "Arn")
	if !strings.Contains(roleARN, ":role/worker") {
		t.Fatalf("role arn = %q", roleARN)
	}

	res = executeAWSQueryRequest(handler, "iam", "Action=GetRole&RoleName=worker")
	if res.Code != http.StatusOK || !strings.Contains(res.Body.String(), "Worker role") {
		t.Fatalf("get role status = %d, body = %s", res.Code, res.Body.String())
	}

	res = executeAWSQueryRequest(handler, "iam", "Action=ListRoles")
	if res.Code != http.StatusOK || !strings.Contains(res.Body.String(), "worker") {
		t.Fatalf("list roles status = %d, body = %s", res.Code, res.Body.String())
	}

	res = executeAWSQueryRequest(handler, "sts", "Action=GetCallerIdentity")
	if res.Code != http.StatusOK {
		t.Fatalf("caller identity status = %d, body = %s", res.Code, res.Body.String())
	}
	if body := res.Body.String(); !strings.Contains(body, "<GetCallerIdentityResponse>") || !strings.Contains(body, "<Account>123456789012</Account>") {
		t.Fatalf("unexpected caller identity body: %s", body)
	}

	res = executeAWSQueryRequest(handler, "sts", "Action=AssumeRole&RoleArn="+url.QueryEscape(roleARN)+"&RoleSessionName=test-session")
	if res.Code != http.StatusOK {
		t.Fatalf("assume role status = %d, body = %s", res.Code, res.Body.String())
	}
	assumedAccessKey := xmlElement(res.Body.String(), "AccessKeyId")
	sessionToken := xmlElement(res.Body.String(), "SessionToken")
	if !strings.HasPrefix(assumedAccessKey, "ASIA") || !strings.Contains(res.Body.String(), "<SessionToken>") {
		t.Fatalf("unexpected assume role body: %s", res.Body.String())
	}

	res = executeAWSQueryRequestWithAccessKeyAndToken(handler, "sts", "Action=GetCallerIdentity", assumedAccessKey, sessionToken)
	if res.Code != http.StatusOK {
		t.Fatalf("assumed caller status = %d, body = %s", res.Code, res.Body.String())
	}
	if arn := xmlElement(res.Body.String(), "Arn"); arn != roleARN+"/test-session" {
		t.Fatalf("assumed arn = %q, want %q", arn, roleARN+"/test-session")
	}

	res = executeAWSQueryRequest(handler, "iam", "Action=DeleteRole&RoleName=worker")
	if res.Code != http.StatusOK {
		t.Fatalf("delete role status = %d, body = %s", res.Code, res.Body.String())
	}
}

func TestServiceReturnsJSONRPCNotImplemented(t *testing.T) {
	handler := newTestHandler()
	req := httptest.NewRequest(http.MethodPost, "http://127.0.0.1/", strings.NewReader(`{"TableName":"items"}`))
	req.Header.Set("X-Amz-Target", "DynamoDB_20120810.DescribeTable")
	signAWSRequest(req, "dynamodb")

	res := httptest.NewRecorder()
	handler.ServeHTTP(res, req)

	if res.Code != http.StatusNotImplemented {
		t.Fatalf("status = %d, body = %s", res.Code, res.Body.String())
	}
	if got := res.Header().Get("Content-Type"); got != "application/x-amz-json-1.0" {
		t.Fatalf("content type = %q", got)
	}
	if got := res.Header().Get("x-amzn-errortype"); got != "NotImplementedException" {
		t.Fatalf("error type = %q", got)
	}
	var body map[string]string
	if err := json.Unmarshal(res.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body["__type"] != "com.amazonaws.dynamodb.v20120810#NotImplementedException" {
		t.Fatalf("unexpected body: %#v", body)
	}
	if !strings.Contains(body["message"], "dynamodb.DescribeTable") {
		t.Fatalf("unexpected message: %#v", body)
	}
}

func TestServiceDoesNotTreatSignedNonS3ServicePathAsS3(t *testing.T) {
	handler := newTestHandler()
	req := httptest.NewRequest(http.MethodGet, "http://127.0.0.1/lambda/2015-03-31/functions", nil)
	signAWSRequest(req, "lambda")

	res := httptest.NewRecorder()
	handler.ServeHTTP(res, req)

	if res.Code != http.StatusNotImplemented {
		t.Fatalf("status = %d, body = %s", res.Code, res.Body.String())
	}
	if got := res.Header().Get("Content-Type"); got != "application/x-amz-json-1.0" {
		t.Fatalf("content type = %q", got)
	}
	var body map[string]string
	if err := json.Unmarshal(res.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body["__type"] != "com.amazonaws.lambda#NotImplemented" {
		t.Fatalf("unexpected body: %#v", body)
	}
	if strings.Contains(res.Body.String(), "s3.GetObject") {
		t.Fatalf("unexpected S3 fallback response: %s", res.Body.String())
	}
}

func TestServiceDoesNotTreatKnownNonS3ServiceRootAsS3(t *testing.T) {
	handler := newTestHandler()
	req := httptest.NewRequest(http.MethodGet, "http://127.0.0.1/lambda", nil)

	res := httptest.NewRecorder()
	handler.ServeHTTP(res, req)

	if res.Code != http.StatusNotImplemented {
		t.Fatalf("status = %d, body = %s", res.Code, res.Body.String())
	}
	if got := res.Header().Get("Content-Type"); got != "application/x-amz-json-1.0" {
		t.Fatalf("content type = %q", got)
	}
	var body map[string]string
	if err := json.Unmarshal(res.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body["__type"] != "com.amazonaws.lambda#NotImplemented" {
		t.Fatalf("unexpected body: %#v", body)
	}
	if strings.Contains(res.Body.String(), "s3.ListObjects") {
		t.Fatalf("unexpected S3 fallback response: %s", res.Body.String())
	}
}

func TestServicePassesThroughNonAWSNotFound(t *testing.T) {
	handler := newTestHandler()
	res := httptest.NewRecorder()
	handler.ServeHTTP(res, httptest.NewRequest(http.MethodGet, "/missing", nil))

	if res.Code != http.StatusNotFound {
		t.Fatalf("status = %d, body = %s", res.Code, res.Body.String())
	}
	var body map[string]string
	if err := json.Unmarshal(res.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body["message"] != "Not Found" {
		t.Fatalf("unexpected body: %#v", body)
	}
}

func TestServicePassesThroughNestedKnownServicePathWithoutAWSHints(t *testing.T) {
	handler := newTestHandler()
	res := httptest.NewRecorder()
	handler.ServeHTTP(res, httptest.NewRequest(http.MethodGet, "/sqs/foo", nil))

	if res.Code != http.StatusNotFound {
		t.Fatalf("status = %d, body = %s", res.Code, res.Body.String())
	}
	var body map[string]string
	if err := json.Unmarshal(res.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body["message"] != "Not Found" {
		t.Fatalf("unexpected body: %#v", body)
	}
	if strings.Contains(res.Body.String(), "s3.GetObject") {
		t.Fatalf("unexpected S3 fallback response: %s", res.Body.String())
	}
}

func TestServicePassesThroughGenericListQueryParams(t *testing.T) {
	handler := newTestHandler()
	for _, target := range []string{
		"/users?continuation-token=abc",
		"/users?delimiter=/",
		"/users?list-type=1",
		"/users?max-keys=10",
		"/users?partNumber=1",
		"/users?prefix=a",
		"/users?start-after=a",
	} {
		t.Run(target, func(t *testing.T) {
			res := httptest.NewRecorder()
			handler.ServeHTTP(res, httptest.NewRequest(http.MethodGet, target, nil))

			if res.Code != http.StatusNotFound {
				t.Fatalf("status = %d, body = %s", res.Code, res.Body.String())
			}
			var body map[string]string
			if err := json.Unmarshal(res.Body.Bytes(), &body); err != nil {
				t.Fatal(err)
			}
			if body["message"] != "Not Found" {
				t.Fatalf("unexpected body: %#v", body)
			}
		})
	}
}

func TestServiceRendersInspectorWithDefaultIAMUser(t *testing.T) {
	handler := newTestHandler()
	res := httptest.NewRecorder()
	handler.ServeHTTP(res, httptest.NewRequest(http.MethodGet, "/_inspector?tab=iam", nil))

	if res.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", res.Code, res.Body.String())
	}
	body := res.Body.String()
	for _, expected := range []string{"AWS Emulator", "S3", "SQS", "IAM", "IAM Users (1)", "IAM Roles (0)", "admin", "Access Keys", "No roles"} {
		if !strings.Contains(body, expected) {
			t.Fatalf("inspector missing %q in %s", expected, body)
		}
	}
}

func TestNewStoreCreatesAWSCollections(t *testing.T) {
	runtimeStore := corestore.New()
	awsStore := NewStore(runtimeStore)

	awsStore.S3Buckets.Insert(corestore.Record{"bucket_name": "photos"})
	awsStore.SQSQueues.Insert(corestore.Record{"queue_name": "jobs", "queue_url": "http://localhost/sqs/jobs"})
	awsStore.IAMUsers.Insert(corestore.Record{"user_name": "developer", "user_id": "AIDAEXAMPLE"})

	snapshot := runtimeStore.Snapshot()
	for _, name := range []string{"aws.s3_buckets", "aws.s3_objects", "aws.sqs_queues", "aws.sqs_messages", "aws.iam_users", "aws.iam_roles"} {
		if _, ok := snapshot.Collections[name]; !ok {
			t.Fatalf("missing collection %s", name)
		}
	}
}

func newTestHandler() http.Handler {
	router := corehttp.NewRouter()
	ui.RegisterAssetRoutes(router)
	Register(router, Options{Store: corestore.New()})
	router.NotFound(func(c *corehttp.Context) {
		c.JSON(http.StatusNotFound, map[string]any{"message": "Not Found"})
	})
	return router
}

func executeAWSRequest(handler http.Handler, method string, target string, body []byte, service string, headers map[string]string) *httptest.ResponseRecorder {
	var reader *bytes.Reader
	if body == nil {
		reader = bytes.NewReader(nil)
	} else {
		reader = bytes.NewReader(body)
	}
	req := httptest.NewRequest(method, target, reader)
	for key, value := range headers {
		req.Header.Set(key, value)
	}
	if service != "" {
		signAWSRequest(req, service)
	}
	res := httptest.NewRecorder()
	handler.ServeHTTP(res, req)
	return res
}

func executeAWSQueryRequest(handler http.Handler, service string, body string) *httptest.ResponseRecorder {
	return executeAWSQueryRequestWithAccessKey(handler, service, body, "AKIAEXAMPLE")
}

func executeAWSQueryRequestWithAccessKey(handler http.Handler, service string, body string, accessKeyID string) *httptest.ResponseRecorder {
	return executeAWSQueryRequestWithAccessKeyAndToken(handler, service, body, accessKeyID, "")
}

func executeAWSQueryRequestWithAccessKeyAndToken(handler http.Handler, service string, body string, accessKeyID string, sessionToken string) *httptest.ResponseRecorder {
	headers := map[string]string{
		"Content-Type": "application/x-www-form-urlencoded",
		"X-Access-Key": accessKeyID,
	}
	if sessionToken != "" {
		headers["X-Amz-Security-Token"] = sessionToken
	}
	return executeAWSRequest(handler, http.MethodPost, "http://127.0.0.1/"+service+"/", []byte(body), service, headers)
}

func executeAWSJSONRequest(t *testing.T, handler http.Handler, action string, payload map[string]any) *httptest.ResponseRecorder {
	t.Helper()
	raw, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, "http://127.0.0.1/sqs/", bytes.NewReader(raw))
	req.Header.Set("Content-Type", "application/x-amz-json-1.0")
	req.Header.Set("X-Amz-Target", "AmazonSQS."+action)
	signAWSRequest(req, "sqs")
	res := httptest.NewRecorder()
	handler.ServeHTTP(res, req)
	return res
}

func executeS3MultipartPost(t *testing.T, handler http.Handler, target string, fields map[string]string, fileBody []byte) *httptest.ResponseRecorder {
	t.Helper()
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	for key, value := range fields {
		if err := writer.WriteField(key, value); err != nil {
			t.Fatal(err)
		}
	}
	part, err := writer.CreateFormFile("file", "upload.txt")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := part.Write(fileBody); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return executeAWSRequest(handler, http.MethodPost, target, body.Bytes(), "s3", map[string]string{
		"Content-Type": writer.FormDataContentType(),
	})
}

func encodePostPolicy(t *testing.T, conditions []any) string {
	t.Helper()
	raw, err := json.Marshal(map[string]any{
		"expiration": time.Now().Add(time.Hour).UTC().Format(time.RFC3339),
		"conditions": conditions,
	})
	if err != nil {
		t.Fatal(err)
	}
	return base64.StdEncoding.EncodeToString(raw)
}

func xmlElement(body string, name string) string {
	startToken := "<" + name + ">"
	endToken := "</" + name + ">"
	start := strings.Index(body, startToken)
	if start < 0 {
		return ""
	}
	start += len(startToken)
	end := strings.Index(body[start:], endToken)
	if end < 0 {
		return ""
	}
	return body[start : start+end]
}

func signAWSRequest(req *http.Request, service string) {
	accessKeyID := req.Header.Get("X-Access-Key")
	if accessKeyID == "" {
		accessKeyID = "AKIAEXAMPLE"
	}
	req.Header.Del("X-Access-Key")
	req.Header.Set("Authorization", "AWS4-HMAC-SHA256 Credential="+accessKeyID+"/20260519/us-east-1/"+service+"/aws4_request, SignedHeaders=host;x-amz-date, Signature=abcdef")
	req.Header.Set("X-Amz-Date", "20260519T000000Z")
}
