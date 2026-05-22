package ssm

import (
	"encoding/json"
	"net/http"
	"strconv"
	"sync"
	"testing"
	"time"

	corestore "github.com/vercel-labs/emulate/internal/core/store"
	"github.com/vercel-labs/emulate/internal/services/aws/gateway"
	"github.com/vercel-labs/emulate/internal/services/aws/protocols"
)

func TestHandlerPutsGetsOverwritesAndDescribesParameters(t *testing.T) {
	handler := newTestSSMHandler()

	response := handler.call("PutParameter", map[string]any{
		"Name":        "/app/database/url",
		"Description": "database URL",
		"Type":        "String",
		"Value":       "postgres://initial",
		"Tags":        []map[string]any{{"Key": "env", "Value": "test"}},
	})
	if response.StatusCode != http.StatusOK {
		t.Fatalf("put status = %d, body = %s", response.StatusCode, response.Body)
	}
	var put struct {
		Version int64  `json:"Version"`
		Tier    string `json:"Tier"`
	}
	decodeSSMBody(t, response, &put)
	if put.Version != 1 || put.Tier != "Standard" {
		t.Fatalf("unexpected put response: %#v", put)
	}

	response = handler.call("GetParameter", map[string]any{"Name": "/app/database/url"})
	if response.StatusCode != http.StatusOK {
		t.Fatalf("get status = %d, body = %s", response.StatusCode, response.Body)
	}
	var got struct {
		Parameter struct {
			Name    string `json:"Name"`
			Type    string `json:"Type"`
			Value   string `json:"Value"`
			Version int64  `json:"Version"`
			ARN     string `json:"ARN"`
		} `json:"Parameter"`
	}
	decodeSSMBody(t, response, &got)
	if got.Parameter.Name != "/app/database/url" || got.Parameter.Value != "postgres://initial" || got.Parameter.Version != 1 {
		t.Fatalf("unexpected get response: %#v", got.Parameter)
	}
	if got.Parameter.ARN != "arn:aws:ssm:us-east-1:123456789012:parameter/app/database/url" {
		t.Fatalf("arn = %q", got.Parameter.ARN)
	}

	response = handler.call("GetParameter", map[string]any{"Name": got.Parameter.ARN})
	if response.StatusCode != http.StatusOK {
		t.Fatalf("get by arn status = %d, body = %s", response.StatusCode, response.Body)
	}
	decodeSSMBody(t, response, &got)
	if got.Parameter.Name != "/app/database/url" || got.Parameter.Value != "postgres://initial" {
		t.Fatalf("unexpected get by arn response: %#v", got.Parameter)
	}

	response = handler.call("PutParameter", map[string]any{"Name": "/app/database/url", "Value": "duplicate"})
	if response.StatusCode != http.StatusBadRequest || response.Headers["x-amzn-errortype"] != "ParameterAlreadyExists" {
		t.Fatalf("duplicate status = %d, headers = %#v, body = %s", response.StatusCode, response.Headers, response.Body)
	}

	response = handler.call("PutParameter", map[string]any{
		"Name":      "/app/database/url",
		"Value":     "postgres://rotated",
		"Overwrite": true,
	})
	if response.StatusCode != http.StatusOK {
		t.Fatalf("overwrite status = %d, body = %s", response.StatusCode, response.Body)
	}
	decodeSSMBody(t, response, &put)
	if put.Version != 2 {
		t.Fatalf("overwrite version = %d", put.Version)
	}

	response = handler.call("GetParameter", map[string]any{"Name": "/app/database/url:1"})
	if response.StatusCode != http.StatusOK {
		t.Fatalf("get version status = %d, body = %s", response.StatusCode, response.Body)
	}
	decodeSSMBody(t, response, &got)
	if got.Parameter.Value != "postgres://initial" || got.Parameter.Version != 1 {
		t.Fatalf("unexpected version value: %#v", got.Parameter)
	}

	response = handler.call("DescribeParameters", map[string]any{
		"ParameterFilters": []map[string]any{{"Key": "Path", "Option": "Recursive", "Values": []string{"/app"}}},
	})
	if response.StatusCode != http.StatusOK {
		t.Fatalf("describe status = %d, body = %s", response.StatusCode, response.Body)
	}
	var described struct {
		Parameters []struct {
			Name        string `json:"Name"`
			Description string `json:"Description"`
			Version     int64  `json:"Version"`
		} `json:"Parameters"`
	}
	decodeSSMBody(t, response, &described)
	if len(described.Parameters) != 1 || described.Parameters[0].Name != "/app/database/url" || described.Parameters[0].Version != 2 {
		t.Fatalf("unexpected describe response: %#v", described.Parameters)
	}
}

func TestHandlerSupportsStringListSecureStringAndPathQueries(t *testing.T) {
	handler := newTestSSMHandler()
	for _, input := range []map[string]any{
		{"Name": "/app/list", "Type": "StringList", "Value": "one,two"},
		{"Name": "/app/secure", "Type": "SecureString", "Value": "secret", "KeyId": "alias/local"},
		{"Name": "/app/nested/value", "Type": "String", "Value": "nested"},
	} {
		response := handler.call("PutParameter", input)
		if response.StatusCode != http.StatusOK {
			t.Fatalf("put %#v status = %d, body = %s", input, response.StatusCode, response.Body)
		}
	}

	response := handler.call("GetParameters", map[string]any{
		"Names":          []string{"/app/secure", "/missing", "/app/list"},
		"WithDecryption": true,
	})
	if response.StatusCode != http.StatusOK {
		t.Fatalf("get parameters status = %d, body = %s", response.StatusCode, response.Body)
	}
	var got struct {
		Parameters []struct {
			Name  string `json:"Name"`
			Type  string `json:"Type"`
			Value string `json:"Value"`
		} `json:"Parameters"`
		InvalidParameters []string `json:"InvalidParameters"`
	}
	decodeSSMBody(t, response, &got)
	if len(got.Parameters) != 2 || got.Parameters[0].Name != "/app/list" || got.Parameters[1].Name != "/app/secure" {
		t.Fatalf("unexpected parameters: %#v", got.Parameters)
	}
	if len(got.InvalidParameters) != 1 || got.InvalidParameters[0] != "/missing" {
		t.Fatalf("invalid parameters = %#v", got.InvalidParameters)
	}

	response = handler.call("GetParametersByPath", map[string]any{"Path": "/app", "Recursive": false})
	if response.StatusCode != http.StatusOK {
		t.Fatalf("path status = %d, body = %s", response.StatusCode, response.Body)
	}
	decodeSSMBody(t, response, &got)
	if len(got.Parameters) != 2 {
		t.Fatalf("nonrecursive path returned %#v", got.Parameters)
	}

	response = handler.call("GetParametersByPath", map[string]any{"Path": "/app", "Recursive": true, "MaxResults": 2})
	if response.StatusCode != http.StatusOK {
		t.Fatalf("recursive path status = %d, body = %s", response.StatusCode, response.Body)
	}
	var page struct {
		Parameters []struct {
			Name string `json:"Name"`
		} `json:"Parameters"`
		NextToken string `json:"NextToken"`
	}
	decodeSSMBody(t, response, &page)
	if len(page.Parameters) != 2 || page.NextToken == "" {
		t.Fatalf("unexpected first page: %#v", page)
	}

	response = handler.call("GetParametersByPath", map[string]any{"Path": "/app", "Recursive": true, "NextToken": page.NextToken})
	if response.StatusCode != http.StatusOK {
		t.Fatalf("recursive second page status = %d, body = %s", response.StatusCode, response.Body)
	}
	decodeSSMBody(t, response, &page)
	if len(page.Parameters) != 1 || page.Parameters[0].Name != "/app/secure" {
		t.Fatalf("unexpected second page: %#v", page)
	}
}

func TestHandlerTagsAndDeletesParameters(t *testing.T) {
	handler := newTestSSMHandler()
	response := handler.call("PutParameter", map[string]any{
		"Name":  "plain",
		"Value": "value",
		"Tags":  []map[string]any{{"Key": "env", "Value": "test"}},
	})
	if response.StatusCode != http.StatusOK {
		t.Fatalf("put status = %d, body = %s", response.StatusCode, response.Body)
	}

	response = handler.call("AddTagsToResource", map[string]any{
		"ResourceType": "Parameter",
		"ResourceId":   "plain",
		"Tags":         []map[string]any{{"Key": "team", "Value": "platform"}},
	})
	if response.StatusCode != http.StatusOK {
		t.Fatalf("add tags status = %d, body = %s", response.StatusCode, response.Body)
	}
	response = handler.call("ListTagsForResource", map[string]any{"ResourceType": "Parameter", "ResourceId": "plain"})
	if response.StatusCode != http.StatusOK {
		t.Fatalf("list tags status = %d, body = %s", response.StatusCode, response.Body)
	}
	var tags struct {
		TagList []map[string]string `json:"TagList"`
	}
	decodeSSMBody(t, response, &tags)
	if !containsSSMTag(tags.TagList, "env", "test") || !containsSSMTag(tags.TagList, "team", "platform") {
		t.Fatalf("missing tags in %#v", tags.TagList)
	}

	response = handler.call("RemoveTagsFromResource", map[string]any{"ResourceType": "Parameter", "ResourceId": "plain", "TagKeys": []string{"team"}})
	if response.StatusCode != http.StatusOK {
		t.Fatalf("remove tags status = %d, body = %s", response.StatusCode, response.Body)
	}
	response = handler.call("ListTagsForResource", map[string]any{"ResourceType": "Parameter", "ResourceId": "plain"})
	decodeSSMBody(t, response, &tags)
	if containsSSMTag(tags.TagList, "team", "platform") {
		t.Fatalf("tag was not removed: %#v", tags.TagList)
	}

	response = handler.call("DeleteParameters", map[string]any{"Names": []string{"plain", "missing"}})
	if response.StatusCode != http.StatusOK {
		t.Fatalf("delete parameters status = %d, body = %s", response.StatusCode, response.Body)
	}
	var deleted struct {
		DeletedParameters []string `json:"DeletedParameters"`
		InvalidParameters []string `json:"InvalidParameters"`
	}
	decodeSSMBody(t, response, &deleted)
	if len(deleted.DeletedParameters) != 1 || deleted.DeletedParameters[0] != "plain" || len(deleted.InvalidParameters) != 1 {
		t.Fatalf("unexpected delete response: %#v", deleted)
	}
	response = handler.call("GetParameter", map[string]any{"Name": "plain"})
	if response.StatusCode != http.StatusBadRequest || response.Headers["x-amzn-errortype"] != "ParameterNotFound" {
		t.Fatalf("missing get status = %d, headers = %#v, body = %s", response.StatusCode, response.Headers, response.Body)
	}
}

type testSSMHandler struct {
	handler Handler
	mu      sync.Mutex
	ids     int
}

func newTestSSMHandler() *testSSMHandler {
	store := corestore.New()
	tester := &testSSMHandler{}
	tester.handler = Handler{
		Parameters: store.MustCollection("aws.ssm_parameters", "account_id", "region", "name", "arn", "path"),
		Versions:   store.MustCollection("aws.ssm_parameter_versions", "account_id", "region", "name", "version"),
		AccountID:  "123456789012",
		Region:     "us-east-1",
		Now: func() time.Time {
			return time.Unix(1700000000, 0).UTC()
		},
		IDGenerator: tester.generateID,
	}
	return tester
}

func (h *testSSMHandler) call(action string, input map[string]any) protocols.ErrorResponse {
	return h.handler.Handle(nil, gateway.AwsRequestContext{
		RequestID: "req-test",
		Service:   "ssm",
		Action:    action,
		AccountID: "123456789012",
		Region:    "us-east-1",
		Input:     input,
	})
}

func (h *testSSMHandler) generateID(prefix string) string {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.ids++
	return prefix + "-test-" + strconv.Itoa(h.ids)
}

func decodeSSMBody(t *testing.T, response protocols.ErrorResponse, target any) {
	t.Helper()
	if err := json.Unmarshal(response.Body, target); err != nil {
		t.Fatalf("decode body %s: %v", string(response.Body), err)
	}
}

func containsSSMTag(tags []map[string]string, key string, value string) bool {
	for _, tag := range tags {
		if tag["Key"] == key && tag["Value"] == value {
			return true
		}
	}
	return false
}
