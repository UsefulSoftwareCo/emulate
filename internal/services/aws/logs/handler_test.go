package logs

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"testing"
	"time"

	corestore "github.com/vercel-labs/emulate/internal/core/store"
	"github.com/vercel-labs/emulate/internal/services/aws/gateway"
	"github.com/vercel-labs/emulate/internal/services/aws/protocols"
)

func TestHandlerCreatesAndDescribesLogGroups(t *testing.T) {
	handler := newTestLogsHandler()

	response := handler.call("CreateLogGroup", map[string]any{
		"logGroupName": "app",
		"tags":         map[string]any{"env": "test"},
	})
	if response.StatusCode != http.StatusOK {
		t.Fatalf("create status = %d, body = %s", response.StatusCode, response.Body)
	}

	response = handler.call("DescribeLogGroups", map[string]any{"logGroupNamePrefix": "a"})
	if response.StatusCode != http.StatusOK {
		t.Fatalf("describe status = %d, body = %s", response.StatusCode, response.Body)
	}
	var body struct {
		LogGroups []struct {
			LogGroupName string `json:"logGroupName"`
			ARN          string `json:"arn"`
			LogGroupARN  string `json:"logGroupArn"`
		} `json:"logGroups"`
	}
	decodeLogsBody(t, response, &body)
	if len(body.LogGroups) != 1 || body.LogGroups[0].LogGroupName != "app" {
		t.Fatalf("unexpected groups: %#v", body.LogGroups)
	}
	if body.LogGroups[0].ARN != "arn:aws:logs:us-east-1:123456789012:log-group:app:*" {
		t.Fatalf("arn = %q", body.LogGroups[0].ARN)
	}
	if body.LogGroups[0].LogGroupARN != "arn:aws:logs:us-east-1:123456789012:log-group:app" {
		t.Fatalf("logGroupArn = %q", body.LogGroups[0].LogGroupARN)
	}
}

func TestHandlerPutsGetsAndFiltersLogEvents(t *testing.T) {
	handler := newTestLogsHandler()
	handler.call("CreateLogGroup", map[string]any{"logGroupName": "app"})
	handler.call("CreateLogStream", map[string]any{"logGroupName": "app", "logStreamName": "web"})

	response := handler.call("PutLogEvents", map[string]any{
		"logGroupName":  "app",
		"logStreamName": "web",
		"logEvents": []map[string]any{
			{"timestamp": 1000, "message": "first error"},
			{"timestamp": 2000, "message": "second info"},
		},
	})
	if response.StatusCode != http.StatusOK {
		t.Fatalf("put status = %d, body = %s", response.StatusCode, response.Body)
	}
	var put struct {
		NextSequenceToken string `json:"nextSequenceToken"`
	}
	decodeLogsBody(t, response, &put)
	if put.NextSequenceToken == "" {
		t.Fatalf("missing next sequence token in %s", response.Body)
	}

	response = handler.call("GetLogEvents", map[string]any{"logGroupName": "app", "logStreamName": "web"})
	if response.StatusCode != http.StatusOK {
		t.Fatalf("get status = %d, body = %s", response.StatusCode, response.Body)
	}
	var got struct {
		Events []struct {
			Timestamp int64  `json:"timestamp"`
			Message   string `json:"message"`
		} `json:"events"`
	}
	decodeLogsBody(t, response, &got)
	if len(got.Events) != 2 || got.Events[0].Message != "second info" || got.Events[1].Message != "first error" {
		t.Fatalf("unexpected events: %#v", got.Events)
	}

	response = handler.call("GetLogEvents", map[string]any{"logGroupName": "app", "logStreamName": "web", "startFromHead": true})
	if response.StatusCode != http.StatusOK {
		t.Fatalf("get from head status = %d, body = %s", response.StatusCode, response.Body)
	}
	decodeLogsBody(t, response, &got)
	if len(got.Events) != 2 || got.Events[0].Message != "first error" || got.Events[1].Message != "second info" {
		t.Fatalf("unexpected events: %#v", got.Events)
	}

	response = handler.call("FilterLogEvents", map[string]any{"logGroupName": "app", "filterPattern": "error"})
	if response.StatusCode != http.StatusOK {
		t.Fatalf("filter status = %d, body = %s", response.StatusCode, response.Body)
	}
	var filtered struct {
		Events []struct {
			EventID       string `json:"eventId"`
			LogStreamName string `json:"logStreamName"`
			Message       string `json:"message"`
		} `json:"events"`
	}
	decodeLogsBody(t, response, &filtered)
	if len(filtered.Events) != 1 || filtered.Events[0].Message != "first error" || filtered.Events[0].EventID == "" {
		t.Fatalf("unexpected filtered events: %#v", filtered.Events)
	}
}

func TestHandlerSupportsLogGroupIdentifier(t *testing.T) {
	handler := newTestLogsHandler()
	handler.call("CreateLogGroup", map[string]any{"logGroupName": "app"})
	handler.call("CreateLogStream", map[string]any{"logGroupName": "app", "logStreamName": "web"})
	handler.call("PutLogEvents", map[string]any{
		"logGroupName":  "app",
		"logStreamName": "web",
		"logEvents": []map[string]any{
			{"timestamp": 1000, "message": "first error"},
		},
	})

	identifier := "arn:aws:logs:us-east-1:123456789012:log-group:app:*"
	response := handler.call("DescribeLogStreams", map[string]any{"logGroupIdentifier": identifier})
	if response.StatusCode != http.StatusOK {
		t.Fatalf("describe streams status = %d, body = %s", response.StatusCode, response.Body)
	}
	var streams struct {
		LogStreams []struct {
			LogStreamName string `json:"logStreamName"`
		} `json:"logStreams"`
	}
	decodeLogsBody(t, response, &streams)
	if len(streams.LogStreams) != 1 || streams.LogStreams[0].LogStreamName != "web" {
		t.Fatalf("unexpected streams: %#v", streams.LogStreams)
	}

	response = handler.call("GetLogEvents", map[string]any{"logGroupIdentifier": identifier, "logStreamName": "web", "startFromHead": true})
	if response.StatusCode != http.StatusOK {
		t.Fatalf("get by identifier status = %d, body = %s", response.StatusCode, response.Body)
	}
	var got struct {
		Events []struct {
			Message string `json:"message"`
		} `json:"events"`
	}
	decodeLogsBody(t, response, &got)
	if len(got.Events) != 1 || got.Events[0].Message != "first error" {
		t.Fatalf("unexpected identifier events: %#v", got.Events)
	}

	response = handler.call("FilterLogEvents", map[string]any{"logGroupIdentifier": "app", "filterPattern": "error"})
	if response.StatusCode != http.StatusOK {
		t.Fatalf("filter by identifier status = %d, body = %s", response.StatusCode, response.Body)
	}
	var filtered struct {
		Events []struct {
			Message string `json:"message"`
		} `json:"events"`
	}
	decodeLogsBody(t, response, &filtered)
	if len(filtered.Events) != 1 || filtered.Events[0].Message != "first error" {
		t.Fatalf("unexpected identifier filtered events: %#v", filtered.Events)
	}

	response = handler.call("GetLogEvents", map[string]any{"logGroupName": "app", "logGroupIdentifier": identifier, "logStreamName": "web"})
	if response.StatusCode != http.StatusBadRequest || response.Headers["x-amzn-errortype"] != "InvalidParameterException" {
		t.Fatalf("both identifiers status = %d, headers = %#v, body = %s", response.StatusCode, response.Headers, response.Body)
	}
}

func TestHandlerGetLogEventsEndTimeIsExclusive(t *testing.T) {
	handler := newTestLogsHandler()
	handler.call("CreateLogGroup", map[string]any{"logGroupName": "app"})
	handler.call("CreateLogStream", map[string]any{"logGroupName": "app", "logStreamName": "web"})
	handler.call("PutLogEvents", map[string]any{
		"logGroupName":  "app",
		"logStreamName": "web",
		"logEvents": []map[string]any{
			{"timestamp": 1000, "message": "first"},
			{"timestamp": 2000, "message": "second"},
			{"timestamp": 3000, "message": "third"},
		},
	})

	response := handler.call("GetLogEvents", map[string]any{"logGroupName": "app", "logStreamName": "web", "startFromHead": true, "endTime": 2000})
	if response.StatusCode != http.StatusOK {
		t.Fatalf("get status = %d, body = %s", response.StatusCode, response.Body)
	}
	var got struct {
		Events []struct {
			Message string `json:"message"`
		} `json:"events"`
	}
	decodeLogsBody(t, response, &got)
	if len(got.Events) != 1 || got.Events[0].Message != "first" {
		t.Fatalf("unexpected events with endTime: %#v", got.Events)
	}
}

func TestHandlerRejectsInvalidStreamFilterCombinations(t *testing.T) {
	handler := newTestLogsHandler()
	handler.call("CreateLogGroup", map[string]any{"logGroupName": "app"})
	handler.call("CreateLogStream", map[string]any{"logGroupName": "app", "logStreamName": "web"})

	response := handler.call("DescribeLogStreams", map[string]any{"logGroupName": "app", "logStreamNamePrefix": "web", "orderBy": "LastEventTime"})
	if response.StatusCode != http.StatusBadRequest || response.Headers["x-amzn-errortype"] != "InvalidParameterException" {
		t.Fatalf("describe streams status = %d, headers = %#v, body = %s", response.StatusCode, response.Headers, response.Body)
	}

	response = handler.call("FilterLogEvents", map[string]any{"logGroupName": "app", "logStreamNames": []string{"web"}, "logStreamNamePrefix": "web"})
	if response.StatusCode != http.StatusBadRequest || response.Headers["x-amzn-errortype"] != "InvalidParameterException" {
		t.Fatalf("filter events status = %d, headers = %#v, body = %s", response.StatusCode, response.Headers, response.Body)
	}
}

func TestHandlerRejectsOutOfOrderLogEventBatches(t *testing.T) {
	handler := newTestLogsHandler()
	handler.call("CreateLogGroup", map[string]any{"logGroupName": "app"})
	handler.call("CreateLogStream", map[string]any{"logGroupName": "app", "logStreamName": "web"})

	response := handler.call("PutLogEvents", map[string]any{
		"logGroupName":  "app",
		"logStreamName": "web",
		"logEvents": []map[string]any{
			{"timestamp": 2000, "message": "second info"},
			{"timestamp": 1000, "message": "first error"},
		},
	})
	if response.StatusCode != http.StatusBadRequest {
		t.Fatalf("status = %d, body = %s", response.StatusCode, response.Body)
	}
	if handler.LogEvents.Count() != 0 {
		t.Fatalf("out of order batch inserted events")
	}
}

func TestHandlerRetentionTagsAndDeletes(t *testing.T) {
	handler := newTestLogsHandler()
	handler.call("CreateLogGroup", map[string]any{"logGroupName": "app"})

	response := handler.call("PutRetentionPolicy", map[string]any{"logGroupName": "app", "retentionInDays": 7})
	if response.StatusCode != http.StatusOK {
		t.Fatalf("retention status = %d, body = %s", response.StatusCode, response.Body)
	}

	response = handler.call("DescribeLogGroups", map[string]any{"logGroupNamePrefix": "app"})
	var described struct {
		LogGroups []struct {
			RetentionInDays int `json:"retentionInDays"`
		} `json:"logGroups"`
	}
	decodeLogsBody(t, response, &described)
	if described.LogGroups[0].RetentionInDays != 7 {
		t.Fatalf("retention = %#v", described.LogGroups)
	}

	arn := "arn:aws:logs:us-east-1:123456789012:log-group:app"
	response = handler.call("TagResource", map[string]any{"resourceArn": arn, "tags": map[string]any{"team": "platform"}})
	if response.StatusCode != http.StatusOK {
		t.Fatalf("tag status = %d, body = %s", response.StatusCode, response.Body)
	}
	response = handler.call("ListTagsForResource", map[string]any{"resourceArn": arn})
	var tags struct {
		Tags map[string]string `json:"tags"`
	}
	decodeLogsBody(t, response, &tags)
	if tags.Tags["team"] != "platform" {
		t.Fatalf("tags = %#v", tags.Tags)
	}
	response = handler.call("TagResource", map[string]any{"resourceArn": "arn:aws:logs:us-west-2:123456789012:log-group:app", "tags": map[string]any{"region": "wrong"}})
	if response.StatusCode != http.StatusBadRequest || response.Headers["x-amzn-errortype"] != "ResourceNotFoundException" {
		t.Fatalf("cross-region tag status = %d, headers = %#v, body = %s", response.StatusCode, response.Headers, response.Body)
	}

	response = handler.call("UntagResource", map[string]any{"resourceArn": arn, "tagKeys": []string{"team"}})
	if response.StatusCode != http.StatusOK {
		t.Fatalf("untag status = %d, body = %s", response.StatusCode, response.Body)
	}
	response = handler.call("DeleteRetentionPolicy", map[string]any{"logGroupName": "app"})
	if response.StatusCode != http.StatusOK {
		t.Fatalf("delete retention status = %d, body = %s", response.StatusCode, response.Body)
	}
	response = handler.call("DeleteLogGroup", map[string]any{"logGroupName": "app"})
	if response.StatusCode != http.StatusOK {
		t.Fatalf("delete group status = %d, body = %s", response.StatusCode, response.Body)
	}
	response = handler.call("DescribeLogGroups", map[string]any{"logGroupNamePrefix": "app"})
	decodeLogsBody(t, response, &described)
	if len(described.LogGroups) != 0 {
		t.Fatalf("deleted group still listed: %#v", described.LogGroups)
	}
}

func TestHandlerReturnsModeledLogErrors(t *testing.T) {
	handler := newTestLogsHandler()

	response := handler.call("CreateLogStream", map[string]any{"logGroupName": "missing", "logStreamName": "web"})
	if response.StatusCode != http.StatusBadRequest {
		t.Fatalf("status = %d, body = %s", response.StatusCode, response.Body)
	}
	if got := response.Headers["x-amzn-errortype"]; got != "ResourceNotFoundException" {
		t.Fatalf("error type = %q", got)
	}
	if !strings.Contains(string(response.Body), "com.amazonaws.logs#ResourceNotFoundException") {
		t.Fatalf("unexpected body: %s", response.Body)
	}
}

type testLogsHandler struct {
	Handler
	nextID int
}

func newTestLogsHandler() *testLogsHandler {
	store := corestore.New()
	h := &testLogsHandler{}
	h.Handler = Handler{
		LogGroups:  store.MustCollection("aws.log_groups", "account_id", "region", "log_group_name", "arn"),
		LogStreams: store.MustCollection("aws.log_streams", "account_id", "region", "log_group_name", "log_stream_name", "arn"),
		LogEvents:  store.MustCollection("aws.log_events", "account_id", "region", "log_group_name", "log_stream_name", "event_id"),
		AccountID:  "123456789012",
		Region:     "us-east-1",
		Now: func() time.Time {
			return time.UnixMilli(1700000000000).UTC()
		},
		IDGenerator: func(prefix string) string {
			h.nextID++
			return prefix + "-test-" + strconv.Itoa(h.nextID)
		},
	}
	return h
}

func (h *testLogsHandler) call(action string, input map[string]any) protocols.ErrorResponse {
	return h.Handle(nil, gateway.AwsRequestContext{
		RequestID: "req-test",
		Service:   "logs",
		Action:    action,
		Protocol:  protocols.ProtocolJSONRPC,
		AccountID: "123456789012",
		Region:    "us-east-1",
		Input:     input,
	})
}

func decodeLogsBody(t *testing.T, response protocols.ErrorResponse, target any) {
	t.Helper()
	if err := json.Unmarshal(response.Body, target); err != nil {
		t.Fatalf("decode body %s: %v", response.Body, err)
	}
}
