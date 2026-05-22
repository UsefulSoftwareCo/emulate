package kms

import (
	"encoding/base64"
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

func TestHandlerCreatesKeysAliasesAndListsMetadata(t *testing.T) {
	handler := newTestKMSHandler()

	response := handler.call("CreateKey", map[string]any{
		"Description": "local test key",
		"Tags":        []map[string]any{{"TagKey": "env", "TagValue": "test"}},
	})
	if response.StatusCode != http.StatusOK {
		t.Fatalf("create status = %d, body = %s", response.StatusCode, response.Body)
	}
	var created struct {
		KeyMetadata struct {
			KeyID       string `json:"KeyId"`
			Arn         string `json:"Arn"`
			Description string `json:"Description"`
			KeyState    string `json:"KeyState"`
		} `json:"KeyMetadata"`
	}
	decodeKMSBody(t, response, &created)
	if created.KeyMetadata.KeyID != "key-test-1" || created.KeyMetadata.KeyState != "Enabled" || created.KeyMetadata.Description != "local test key" {
		t.Fatalf("unexpected created metadata: %#v", created.KeyMetadata)
	}
	if created.KeyMetadata.Arn != "arn:aws:kms:us-east-1:123456789012:key/key-test-1" {
		t.Fatalf("arn = %q", created.KeyMetadata.Arn)
	}

	response = handler.call("CreateAlias", map[string]any{"AliasName": "alias/app", "TargetKeyId": created.KeyMetadata.Arn})
	if response.StatusCode != http.StatusOK {
		t.Fatalf("create alias status = %d, body = %s", response.StatusCode, response.Body)
	}

	response = handler.call("DescribeKey", map[string]any{"KeyId": "alias/app"})
	if response.StatusCode != http.StatusOK {
		t.Fatalf("describe alias status = %d, body = %s", response.StatusCode, response.Body)
	}
	decodeKMSBody(t, response, &created)
	if created.KeyMetadata.KeyID != "key-test-1" {
		t.Fatalf("alias resolved key = %#v", created.KeyMetadata)
	}

	response = handler.call("ListKeys", map[string]any{})
	if response.StatusCode != http.StatusOK {
		t.Fatalf("list keys status = %d, body = %s", response.StatusCode, response.Body)
	}
	var keys struct {
		Keys []struct {
			KeyID string `json:"KeyId"`
		} `json:"Keys"`
	}
	decodeKMSBody(t, response, &keys)
	if len(keys.Keys) != 1 || keys.Keys[0].KeyID != "key-test-1" {
		t.Fatalf("unexpected keys: %#v", keys.Keys)
	}

	response = handler.call("ListAliases", map[string]any{"KeyId": "key-test-1"})
	if response.StatusCode != http.StatusOK {
		t.Fatalf("list aliases status = %d, body = %s", response.StatusCode, response.Body)
	}
	var aliases struct {
		Aliases []struct {
			AliasName   string `json:"AliasName"`
			TargetKeyID string `json:"TargetKeyId"`
		} `json:"Aliases"`
	}
	decodeKMSBody(t, response, &aliases)
	if len(aliases.Aliases) != 1 || aliases.Aliases[0].AliasName != "alias/app" || aliases.Aliases[0].TargetKeyID != "key-test-1" {
		t.Fatalf("unexpected aliases: %#v", aliases.Aliases)
	}
}

func TestHandlerEncryptsDecryptsAndGeneratesDataKeys(t *testing.T) {
	handler := newTestKMSHandler()
	response := handler.call("CreateKey", map[string]any{"Description": "crypto stub"})
	if response.StatusCode != http.StatusOK {
		t.Fatalf("create status = %d, body = %s", response.StatusCode, response.Body)
	}
	var created struct {
		KeyMetadata struct {
			KeyID string `json:"KeyId"`
			Arn   string `json:"Arn"`
		} `json:"KeyMetadata"`
	}
	decodeKMSBody(t, response, &created)

	response = handler.call("Encrypt", map[string]any{
		"KeyId":     created.KeyMetadata.KeyID,
		"Plaintext": base64.StdEncoding.EncodeToString([]byte("hello kms")),
	})
	if response.StatusCode != http.StatusOK {
		t.Fatalf("encrypt status = %d, body = %s", response.StatusCode, response.Body)
	}
	var encrypted struct {
		CiphertextBlob      string `json:"CiphertextBlob"`
		KeyID               string `json:"KeyId"`
		EncryptionAlgorithm string `json:"EncryptionAlgorithm"`
	}
	decodeKMSBody(t, response, &encrypted)
	if encrypted.CiphertextBlob == "" || encrypted.KeyID != created.KeyMetadata.Arn || encrypted.EncryptionAlgorithm != "SYMMETRIC_DEFAULT" {
		t.Fatalf("unexpected encrypt response: %#v", encrypted)
	}

	response = handler.call("Decrypt", map[string]any{"CiphertextBlob": encrypted.CiphertextBlob, "KeyId": created.KeyMetadata.Arn})
	if response.StatusCode != http.StatusOK {
		t.Fatalf("decrypt status = %d, body = %s", response.StatusCode, response.Body)
	}
	var decrypted struct {
		Plaintext string `json:"Plaintext"`
		KeyID     string `json:"KeyId"`
	}
	decodeKMSBody(t, response, &decrypted)
	raw, err := base64.StdEncoding.DecodeString(decrypted.Plaintext)
	if err != nil {
		t.Fatal(err)
	}
	if string(raw) != "hello kms" || decrypted.KeyID != created.KeyMetadata.Arn {
		t.Fatalf("unexpected decrypt response: %#v", decrypted)
	}

	response = handler.call("GenerateDataKey", map[string]any{"KeyId": created.KeyMetadata.KeyID, "KeySpec": "AES_128"})
	if response.StatusCode != http.StatusOK {
		t.Fatalf("generate data key status = %d, body = %s", response.StatusCode, response.Body)
	}
	var dataKey struct {
		CiphertextBlob string `json:"CiphertextBlob"`
		Plaintext      string `json:"Plaintext"`
		KeyID          string `json:"KeyId"`
	}
	decodeKMSBody(t, response, &dataKey)
	plain, err := base64.StdEncoding.DecodeString(dataKey.Plaintext)
	if err != nil {
		t.Fatal(err)
	}
	if len(plain) != 16 || dataKey.CiphertextBlob == "" || dataKey.KeyID != created.KeyMetadata.Arn {
		t.Fatalf("unexpected data key response: %#v len=%d", dataKey, len(plain))
	}
}

type testKMSHandler struct {
	handler Handler
	mu      sync.Mutex
	ids     int
}

func newTestKMSHandler() *testKMSHandler {
	store := corestore.New()
	tester := &testKMSHandler{}
	tester.handler = Handler{
		Keys:      store.MustCollection("aws.kms_keys", "account_id", "region", "key_id", "arn"),
		Aliases:   store.MustCollection("aws.kms_aliases", "account_id", "region", "alias_name", "alias_arn", "target_key_id"),
		AccountID: "123456789012",
		Region:    "us-east-1",
		Now: func() time.Time {
			return time.Unix(1700000000, 0).UTC()
		},
		IDGenerator: tester.generateID,
		RandomBytes: func(size int) []byte {
			out := make([]byte, size)
			for index := range out {
				out[index] = byte(index + 1)
			}
			return out
		},
	}
	return tester
}

func (h *testKMSHandler) call(action string, input map[string]any) protocols.ErrorResponse {
	return h.handler.Handle(nil, gateway.AwsRequestContext{
		RequestID: "req-test",
		Service:   "kms",
		Action:    action,
		AccountID: "123456789012",
		Region:    "us-east-1",
		Input:     input,
	})
}

func (h *testKMSHandler) generateID(prefix string) string {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.ids++
	return prefix + "-test-" + strconv.Itoa(h.ids)
}

func decodeKMSBody(t *testing.T, response protocols.ErrorResponse, target any) {
	t.Helper()
	if err := json.Unmarshal(response.Body, target); err != nil {
		t.Fatalf("decode body %s: %v", string(response.Body), err)
	}
}
