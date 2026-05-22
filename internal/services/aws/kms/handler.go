package kms

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	corestore "github.com/vercel-labs/emulate/internal/core/store"
	"github.com/vercel-labs/emulate/internal/services/aws/gateway"
	"github.com/vercel-labs/emulate/internal/services/aws/protocols"
)

const jsonContentType = "application/x-amz-json-1.1"

type Handler struct {
	Keys        *corestore.Collection
	Aliases     *corestore.Collection
	AccountID   string
	Region      string
	Now         func() time.Time
	IDGenerator func(string) string
	RandomBytes func(int) []byte
}

type ciphertextEnvelope struct {
	Version   int    `json:"v"`
	KeyID     string `json:"key_id"`
	Plaintext string `json:"plaintext"`
	Algorithm string `json:"alg"`
}

var fallbackIDCounter atomic.Uint64

func (h *Handler) Handle(_ *http.Request, ctx gateway.AwsRequestContext) protocols.ErrorResponse {
	requestID := ctx.RequestID
	if requestID == "" {
		requestID = h.generateID("req")
	}
	var response protocols.ErrorResponse
	switch ctx.Action {
	case "CreateKey":
		response = h.createKey(ctx, requestID)
	case "DescribeKey":
		response = h.describeKey(ctx, requestID)
	case "ListKeys":
		response = h.listKeys(ctx, requestID)
	case "CreateAlias":
		response = h.createAlias(ctx, requestID)
	case "ListAliases":
		response = h.listAliases(ctx, requestID)
	case "Encrypt":
		response = h.encrypt(ctx, requestID)
	case "Decrypt":
		response = h.decrypt(ctx, requestID)
	case "GenerateDataKey":
		response = h.generateDataKey(ctx, requestID)
	default:
		response = h.error("NotImplementedException", fmt.Sprintf("kms.%s is not implemented in the native Go runtime yet.", ctx.Action), http.StatusNotImplemented, requestID)
	}
	return withRequestID(response, requestID)
}

func (h *Handler) createKey(ctx gateway.AwsRequestContext, requestID string) protocols.ErrorResponse {
	keyID := strings.TrimSpace(stringInput(ctx.Input, "KeyId", "keyId"))
	if keyID == "" {
		keyID = h.generateKeyID()
	}
	if _, ok := h.findKey(ctx, keyID); ok {
		return h.error("AlreadyExistsException", "The key already exists.", http.StatusBadRequest, requestID)
	}
	keyUsage := firstNonEmpty(stringInput(ctx.Input, "KeyUsage", "keyUsage"), "ENCRYPT_DECRYPT")
	keySpec := firstNonEmpty(stringInput(ctx.Input, "KeySpec", "keySpec", "CustomerMasterKeySpec", "customerMasterKeySpec"), "SYMMETRIC_DEFAULT")
	origin := firstNonEmpty(stringInput(ctx.Input, "Origin", "origin"), "AWS_KMS")
	keyManager := firstNonEmpty(stringInput(ctx.Input, "KeyManager", "keyManager"), "CUSTOMER")
	now := h.now().Unix()
	key := h.Keys.Insert(corestore.Record{
		"account_id":               h.accountID(ctx),
		"region":                   h.region(ctx),
		"key_id":                   keyID,
		"arn":                      keyARN(h.region(ctx), h.accountID(ctx), keyID),
		"description":              stringInput(ctx.Input, "Description", "description"),
		"enabled":                  true,
		"key_state":                "Enabled",
		"key_usage":                keyUsage,
		"key_spec":                 keySpec,
		"customer_master_key_spec": keySpec,
		"origin":                   origin,
		"key_manager":              keyManager,
		"creation_date":            now,
		"deletion_date":            int64(0),
		"multi_region":             boolInput(ctx.Input, "MultiRegion", "multiRegion"),
		"tags":                     tagsFromInput(ctx.Input["Tags"], ctx.Input["tags"]),
	})
	return jsonResponse(http.StatusOK, map[string]any{"KeyMetadata": h.keyMetadata(key)})
}

func (h *Handler) describeKey(ctx gateway.AwsRequestContext, requestID string) protocols.ErrorResponse {
	key, response, ok := h.requireKey(ctx, stringInput(ctx.Input, "KeyId", "keyId"), requestID)
	if !ok {
		return response
	}
	return jsonResponse(http.StatusOK, map[string]any{"KeyMetadata": h.keyMetadata(key)})
}

func (h *Handler) listKeys(ctx gateway.AwsRequestContext, requestID string) protocols.ErrorResponse {
	keys := []corestore.Record{}
	for _, key := range h.Keys.All() {
		if h.sameScope(ctx, key) {
			keys = append(keys, key)
		}
	}
	sort.Slice(keys, func(i int, j int) bool {
		return stringField(keys[i], "key_id") < stringField(keys[j], "key_id")
	})
	start, end, nextMarker, response, ok := h.pageBounds(ctx.Input, len(keys), 100, 1000, requestID)
	if !ok {
		return response
	}
	out := make([]map[string]any, 0, end-start)
	for _, key := range keys[start:end] {
		out = append(out, map[string]any{
			"KeyId":  stringField(key, "key_id"),
			"KeyArn": stringField(key, "arn"),
		})
	}
	body := map[string]any{
		"Keys":      out,
		"Truncated": end < len(keys),
	}
	if nextMarker != "" {
		body["NextMarker"] = nextMarker
	}
	return jsonResponse(http.StatusOK, body)
}

func (h *Handler) createAlias(ctx gateway.AwsRequestContext, requestID string) protocols.ErrorResponse {
	aliasName := normalizeAliasName(stringInput(ctx.Input, "AliasName", "aliasName"))
	if aliasName == "" {
		return h.validation("AliasName is required.", requestID)
	}
	if strings.HasPrefix(aliasName, "alias/aws/") {
		return h.validation("AliasName cannot use the reserved alias/aws/ prefix.", requestID)
	}
	if _, ok := h.findAlias(ctx, aliasName); ok {
		return h.error("AlreadyExistsException", "The alias already exists.", http.StatusBadRequest, requestID)
	}
	key, response, ok := h.requireKey(ctx, stringInput(ctx.Input, "TargetKeyId", "targetKeyId"), requestID)
	if !ok {
		return response
	}
	now := h.now().Unix()
	h.Aliases.Insert(corestore.Record{
		"account_id":        h.accountID(ctx),
		"region":            h.region(ctx),
		"alias_name":        aliasName,
		"alias_arn":         aliasARN(h.region(ctx), h.accountID(ctx), aliasName),
		"target_key_id":     stringField(key, "key_id"),
		"creation_date":     now,
		"last_updated_date": now,
	})
	return jsonResponse(http.StatusOK, map[string]any{})
}

func (h *Handler) listAliases(ctx gateway.AwsRequestContext, requestID string) protocols.ErrorResponse {
	keyFilter := strings.TrimSpace(stringInput(ctx.Input, "KeyId", "keyId"))
	targetKeyID := ""
	if keyFilter != "" {
		key, response, ok := h.requireKey(ctx, keyFilter, requestID)
		if !ok {
			return response
		}
		targetKeyID = stringField(key, "key_id")
	}
	aliases := []corestore.Record{}
	for _, alias := range h.Aliases.All() {
		if !h.sameScope(ctx, alias) {
			continue
		}
		if targetKeyID != "" && stringField(alias, "target_key_id") != targetKeyID {
			continue
		}
		aliases = append(aliases, alias)
	}
	sort.Slice(aliases, func(i int, j int) bool {
		return stringField(aliases[i], "alias_name") < stringField(aliases[j], "alias_name")
	})
	start, end, nextMarker, response, ok := h.pageBounds(ctx.Input, len(aliases), 100, 1000, requestID)
	if !ok {
		return response
	}
	out := make([]map[string]any, 0, end-start)
	for _, alias := range aliases[start:end] {
		out = append(out, h.aliasResponse(alias))
	}
	body := map[string]any{
		"Aliases":   out,
		"Truncated": end < len(aliases),
	}
	if nextMarker != "" {
		body["NextMarker"] = nextMarker
	}
	return jsonResponse(http.StatusOK, body)
}

func (h *Handler) encrypt(ctx gateway.AwsRequestContext, requestID string) protocols.ErrorResponse {
	key, response, ok := h.requireEnabledKey(ctx, stringInput(ctx.Input, "KeyId", "keyId"), requestID)
	if !ok {
		return response
	}
	plaintext, response, ok := requiredBlobInput(ctx.Input, "Plaintext", "plaintext", requestID, h)
	if !ok {
		return response
	}
	algorithm := firstNonEmpty(stringInput(ctx.Input, "EncryptionAlgorithm", "encryptionAlgorithm"), "SYMMETRIC_DEFAULT")
	ciphertext, err := encodeCiphertext(stringField(key, "key_id"), algorithm, plaintext)
	if err != nil {
		return h.error("KMSInternalException", "Failed to encode local ciphertext.", http.StatusInternalServerError, requestID)
	}
	return jsonResponse(http.StatusOK, map[string]any{
		"CiphertextBlob":      ciphertext,
		"KeyId":               stringField(key, "arn"),
		"EncryptionAlgorithm": algorithm,
	})
}

func (h *Handler) decrypt(ctx gateway.AwsRequestContext, requestID string) protocols.ErrorResponse {
	ciphertext, response, ok := requiredBlobInput(ctx.Input, "CiphertextBlob", "ciphertextBlob", requestID, h)
	if !ok {
		return response
	}
	envelope, err := decodeCiphertext(ciphertext)
	if err != nil {
		return h.error("InvalidCiphertextException", "CiphertextBlob is not a valid local KMS ciphertext.", http.StatusBadRequest, requestID)
	}
	key, response, ok := h.requireEnabledKey(ctx, envelope.KeyID, requestID)
	if !ok {
		return response
	}
	if requestedKeyID := strings.TrimSpace(stringInput(ctx.Input, "KeyId", "keyId")); requestedKeyID != "" {
		requested, response, ok := h.requireEnabledKey(ctx, requestedKeyID, requestID)
		if !ok {
			return response
		}
		if stringField(requested, "key_id") != stringField(key, "key_id") {
			return h.error("InvalidCiphertextException", "CiphertextBlob was encrypted with a different key.", http.StatusBadRequest, requestID)
		}
	}
	return jsonResponse(http.StatusOK, map[string]any{
		"KeyId":               stringField(key, "arn"),
		"Plaintext":           envelope.Plaintext,
		"EncryptionAlgorithm": firstNonEmpty(envelope.Algorithm, "SYMMETRIC_DEFAULT"),
	})
}

func (h *Handler) generateDataKey(ctx gateway.AwsRequestContext, requestID string) protocols.ErrorResponse {
	key, response, ok := h.requireEnabledKey(ctx, stringInput(ctx.Input, "KeyId", "keyId"), requestID)
	if !ok {
		return response
	}
	size, response, ok := dataKeySize(ctx.Input, requestID, h)
	if !ok {
		return response
	}
	plaintext := h.randomBytes(size)
	algorithm := "SYMMETRIC_DEFAULT"
	ciphertext, err := encodeCiphertext(stringField(key, "key_id"), algorithm, plaintext)
	if err != nil {
		return h.error("KMSInternalException", "Failed to encode local data key.", http.StatusInternalServerError, requestID)
	}
	return jsonResponse(http.StatusOK, map[string]any{
		"CiphertextBlob": ciphertext,
		"Plaintext":      base64.StdEncoding.EncodeToString(plaintext),
		"KeyId":          stringField(key, "arn"),
	})
}

func (h *Handler) requireKey(ctx gateway.AwsRequestContext, keyID string, requestID string) (corestore.Record, protocols.ErrorResponse, bool) {
	keyID = strings.TrimSpace(keyID)
	if keyID == "" {
		return nil, h.validation("KeyId is required.", requestID), false
	}
	key, ok := h.findKey(ctx, keyID)
	if !ok {
		return nil, h.notFound("Key not found.", requestID), false
	}
	return key, protocols.ErrorResponse{}, true
}

func (h *Handler) requireEnabledKey(ctx gateway.AwsRequestContext, keyID string, requestID string) (corestore.Record, protocols.ErrorResponse, bool) {
	key, response, ok := h.requireKey(ctx, keyID, requestID)
	if !ok {
		return nil, response, false
	}
	if !boolField(key, "enabled") || stringField(key, "key_state") != "Enabled" {
		return nil, h.error("DisabledException", "Key is disabled.", http.StatusBadRequest, requestID), false
	}
	return key, protocols.ErrorResponse{}, true
}

func (h *Handler) findKey(ctx gateway.AwsRequestContext, keyID string) (corestore.Record, bool) {
	keyID = strings.TrimSpace(keyID)
	if keyID == "" {
		return nil, false
	}
	if strings.HasPrefix(keyID, "alias/") || strings.Contains(keyID, ":alias/") {
		alias, ok := h.findAlias(ctx, keyID)
		if !ok {
			return nil, false
		}
		keyID = stringField(alias, "target_key_id")
	}
	if strings.HasPrefix(keyID, "arn:") {
		parsed, ok := parseKMSARN(keyID)
		if !ok || parsed.AccountID != h.accountID(ctx) || parsed.Region != h.region(ctx) {
			return nil, false
		}
		if parsed.Kind == "alias" {
			alias, ok := h.findAlias(ctx, parsed.Kind+"/"+parsed.ID)
			if !ok {
				return nil, false
			}
			keyID = stringField(alias, "target_key_id")
		} else {
			keyID = parsed.ID
		}
	}
	for _, key := range h.Keys.FindBy("key_id", keyID) {
		if h.sameScope(ctx, key) {
			return key, true
		}
	}
	for _, key := range h.Keys.FindBy("arn", keyID) {
		if h.sameScope(ctx, key) {
			return key, true
		}
	}
	return nil, false
}

func (h *Handler) findAlias(ctx gateway.AwsRequestContext, aliasName string) (corestore.Record, bool) {
	aliasName = normalizeAliasName(aliasName)
	if aliasName == "" {
		return nil, false
	}
	if strings.HasPrefix(aliasName, "arn:") {
		parsed, ok := parseKMSARN(aliasName)
		if !ok || parsed.Kind != "alias" || parsed.AccountID != h.accountID(ctx) || parsed.Region != h.region(ctx) {
			return nil, false
		}
		aliasName = parsed.Kind + "/" + parsed.ID
	}
	for _, alias := range h.Aliases.FindBy("alias_name", aliasName) {
		if h.sameScope(ctx, alias) {
			return alias, true
		}
	}
	for _, alias := range h.Aliases.FindBy("alias_arn", aliasName) {
		if h.sameScope(ctx, alias) {
			return alias, true
		}
	}
	return nil, false
}

func (h *Handler) keyMetadata(key corestore.Record) map[string]any {
	response := map[string]any{
		"AWSAccountId":          stringField(key, "account_id"),
		"KeyId":                 stringField(key, "key_id"),
		"Arn":                   stringField(key, "arn"),
		"CreationDate":          int64Field(key, "creation_date"),
		"Enabled":               boolField(key, "enabled"),
		"KeyUsage":              stringField(key, "key_usage"),
		"KeyState":              stringField(key, "key_state"),
		"Origin":                stringField(key, "origin"),
		"KeyManager":            stringField(key, "key_manager"),
		"CustomerMasterKeySpec": stringField(key, "customer_master_key_spec"),
		"KeySpec":               stringField(key, "key_spec"),
		"EncryptionAlgorithms":  []string{"SYMMETRIC_DEFAULT"},
		"MultiRegion":           boolField(key, "multi_region"),
	}
	if description := stringField(key, "description"); description != "" {
		response["Description"] = description
	}
	if deletionDate := int64Field(key, "deletion_date"); deletionDate > 0 {
		response["DeletionDate"] = deletionDate
	}
	return response
}

func (h *Handler) aliasResponse(alias corestore.Record) map[string]any {
	response := map[string]any{
		"AliasName":       stringField(alias, "alias_name"),
		"AliasArn":        stringField(alias, "alias_arn"),
		"CreationDate":    int64Field(alias, "creation_date"),
		"LastUpdatedDate": int64Field(alias, "last_updated_date"),
	}
	if target := stringField(alias, "target_key_id"); target != "" {
		response["TargetKeyId"] = target
	}
	return response
}

func (h *Handler) pageBounds(input map[string]any, total int, fallbackLimit int, maxLimit int, requestID string) (int, int, string, protocols.ErrorResponse, bool) {
	limit := intInput(input, fallbackLimit, "Limit", "limit")
	if limit <= 0 {
		limit = fallbackLimit
	}
	if maxLimit > 0 && limit > maxLimit {
		limit = maxLimit
	}
	start := 0
	if raw := strings.TrimSpace(stringInput(input, "Marker", "marker")); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed < 0 || parsed > total {
			return 0, 0, "", h.validation("Marker is invalid.", requestID), false
		}
		start = parsed
	}
	end := start + limit
	if end > total {
		end = total
	}
	nextMarker := ""
	if end < total {
		nextMarker = strconv.Itoa(end)
	}
	return start, end, nextMarker, protocols.ErrorResponse{}, true
}

func requiredBlobInput(input map[string]any, first string, second string, requestID string, h *Handler) ([]byte, protocols.ErrorResponse, bool) {
	raw, ok := stringInputPresent(input, first, second)
	if !ok || raw == "" {
		return nil, h.validation(first+" is required.", requestID), false
	}
	decoded, err := base64.StdEncoding.DecodeString(raw)
	if err != nil {
		return nil, h.validation(first+" must be base64 encoded.", requestID), false
	}
	return decoded, protocols.ErrorResponse{}, true
}

func dataKeySize(input map[string]any, requestID string, h *Handler) (int, protocols.ErrorResponse, bool) {
	if size := intInput(input, 0, "NumberOfBytes", "numberOfBytes"); size > 0 {
		return size, protocols.ErrorResponse{}, true
	}
	switch firstNonEmpty(stringInput(input, "KeySpec", "keySpec"), "AES_256") {
	case "AES_128":
		return 16, protocols.ErrorResponse{}, true
	case "AES_256":
		return 32, protocols.ErrorResponse{}, true
	default:
		return 0, h.validation("KeySpec must be AES_128 or AES_256.", requestID), false
	}
}

func encodeCiphertext(keyID string, algorithm string, plaintext []byte) (string, error) {
	raw, err := json.Marshal(ciphertextEnvelope{
		Version:   1,
		KeyID:     keyID,
		Plaintext: base64.StdEncoding.EncodeToString(plaintext),
		Algorithm: algorithm,
	})
	if err != nil {
		return "", err
	}
	return base64.StdEncoding.EncodeToString(raw), nil
}

func decodeCiphertext(ciphertext []byte) (ciphertextEnvelope, error) {
	var envelope ciphertextEnvelope
	if err := json.Unmarshal(ciphertext, &envelope); err != nil {
		return ciphertextEnvelope{}, err
	}
	if envelope.Version != 1 || envelope.KeyID == "" || envelope.Plaintext == "" {
		return ciphertextEnvelope{}, fmt.Errorf("invalid ciphertext envelope")
	}
	if _, err := base64.StdEncoding.DecodeString(envelope.Plaintext); err != nil {
		return ciphertextEnvelope{}, err
	}
	return envelope, nil
}

func (h *Handler) validation(message string, requestID string) protocols.ErrorResponse {
	return h.error("ValidationException", message, http.StatusBadRequest, requestID)
}

func (h *Handler) notFound(message string, requestID string) protocols.ErrorResponse {
	return h.error("NotFoundException", message, http.StatusBadRequest, requestID)
}

func (h *Handler) error(code string, message string, status int, requestID string) protocols.ErrorResponse {
	return protocols.SerializeJSONError(protocols.AWSError{
		Code:       code,
		Message:    message,
		RequestID:  requestID,
		Service:    "com.amazonaws.kms",
		StatusCode: status,
	})
}

func (h *Handler) sameScope(ctx gateway.AwsRequestContext, record corestore.Record) bool {
	return stringField(record, "account_id") == h.accountID(ctx) && stringField(record, "region") == h.region(ctx)
}

func (h *Handler) accountID(ctx gateway.AwsRequestContext) string {
	if ctx.AccountID != "" {
		return ctx.AccountID
	}
	if h.AccountID != "" {
		return h.AccountID
	}
	return gateway.DefaultAccountID
}

func (h *Handler) region(ctx gateway.AwsRequestContext) string {
	if ctx.Region != "" {
		return ctx.Region
	}
	if h.Region != "" {
		return h.Region
	}
	return gateway.DefaultRegion
}

func (h *Handler) now() time.Time {
	if h.Now != nil {
		return h.Now().UTC()
	}
	return time.Now().UTC()
}

func (h *Handler) generateID(prefix string) string {
	if h.IDGenerator != nil {
		return h.IDGenerator(prefix)
	}
	return fmt.Sprintf("%s-%d", prefix, fallbackIDCounter.Add(1))
}

func (h *Handler) generateKeyID() string {
	if h.IDGenerator != nil {
		generated := strings.TrimSpace(h.IDGenerator("key"))
		if generated != "" {
			return generated
		}
	}
	if raw := randomBytes(16); len(raw) == 16 {
		hexed := hex.EncodeToString(raw)
		return hexed[0:8] + "-" + hexed[8:12] + "-" + hexed[12:16] + "-" + hexed[16:20] + "-" + hexed[20:32]
	}
	value := fallbackIDCounter.Add(1)
	return fmt.Sprintf("00000000-0000-0000-0000-%012d", value)
}

func (h *Handler) randomBytes(size int) []byte {
	if h.RandomBytes != nil {
		if raw := h.RandomBytes(size); len(raw) == size {
			return append([]byte(nil), raw...)
		}
	}
	if raw := randomBytes(size); len(raw) == size {
		return raw
	}
	out := make([]byte, size)
	for index := range out {
		out[index] = byte((index + int(fallbackIDCounter.Add(1))) % 256)
	}
	return out
}

func randomBytes(size int) []byte {
	raw := make([]byte, size)
	if _, err := rand.Read(raw); err != nil {
		return nil
	}
	return raw
}

type kmsARNParts struct {
	Region    string
	AccountID string
	Kind      string
	ID        string
}

func parseKMSARN(value string) (kmsARNParts, bool) {
	parts := strings.SplitN(value, ":", 6)
	if len(parts) != 6 || parts[0] != "arn" || parts[2] != "kms" || parts[3] == "" || parts[4] == "" {
		return kmsARNParts{}, false
	}
	kind, id, ok := strings.Cut(parts[5], "/")
	if !ok || kind == "" || id == "" {
		return kmsARNParts{}, false
	}
	if kind != "key" && kind != "alias" {
		return kmsARNParts{}, false
	}
	return kmsARNParts{Region: parts[3], AccountID: parts[4], Kind: kind, ID: id}, true
}

func keyARN(region string, accountID string, keyID string) string {
	return "arn:aws:kms:" + region + ":" + accountID + ":key/" + keyID
}

func aliasARN(region string, accountID string, aliasName string) string {
	return "arn:aws:kms:" + region + ":" + accountID + ":" + normalizeAliasName(aliasName)
}

func normalizeAliasName(value string) string {
	value = strings.TrimSpace(value)
	if strings.HasPrefix(value, "arn:") {
		return value
	}
	if value == "" {
		return ""
	}
	if !strings.HasPrefix(value, "alias/") {
		value = "alias/" + value
	}
	return value
}

func jsonResponse(status int, value map[string]any) protocols.ErrorResponse {
	body, _ := json.Marshal(value)
	return protocols.ErrorResponse{
		StatusCode:  status,
		ContentType: jsonContentType,
		Headers:     map[string]string{"Content-Type": jsonContentType},
		Body:        body,
	}
}

func withRequestID(response protocols.ErrorResponse, requestID string) protocols.ErrorResponse {
	if response.Headers == nil {
		response.Headers = map[string]string{}
	}
	if requestID != "" {
		response.Headers["x-amzn-requestid"] = requestID
	}
	if response.ContentType == "" {
		response.ContentType = jsonContentType
	}
	if _, ok := response.Headers["Content-Type"]; !ok {
		response.Headers["Content-Type"] = response.ContentType
	}
	return response
}

func inputValue(input map[string]any, names ...string) any {
	for _, name := range names {
		if value, ok := input[name]; ok {
			return value
		}
	}
	return nil
}

func stringInput(input map[string]any, names ...string) string {
	value, _ := stringInputPresent(input, names...)
	return value
}

func stringInputPresent(input map[string]any, names ...string) (string, bool) {
	for _, name := range names {
		value, ok := input[name]
		if !ok {
			continue
		}
		return stringValue(value), true
	}
	return "", false
}

func boolInput(input map[string]any, names ...string) bool {
	for _, name := range names {
		switch value := input[name].(type) {
		case bool:
			return value
		case string:
			return strings.EqualFold(value, "true")
		}
	}
	return false
}

func intInput(input map[string]any, fallback int, names ...string) int {
	for _, name := range names {
		value, ok := input[name]
		if !ok {
			continue
		}
		switch v := value.(type) {
		case int:
			return v
		case int64:
			return int(v)
		case float64:
			return int(v)
		case json.Number:
			parsed, err := v.Int64()
			if err == nil {
				return int(parsed)
			}
		case string:
			parsed, err := strconv.Atoi(v)
			if err == nil {
				return parsed
			}
		}
	}
	return fallback
}

func intField(record corestore.Record, name string) int {
	value, _ := numericValue(record[name])
	return int(value)
}

func int64Field(record corestore.Record, name string) int64 {
	value, _ := numericValue(record[name])
	return value
}

func numericValue(value any) (int64, bool) {
	switch v := value.(type) {
	case int:
		return int64(v), true
	case int64:
		return v, true
	case int32:
		return int64(v), true
	case float64:
		return int64(v), true
	case json.Number:
		parsed, err := v.Int64()
		return parsed, err == nil
	case string:
		parsed, err := strconv.ParseInt(v, 10, 64)
		return parsed, err == nil
	default:
		return 0, false
	}
}

func boolField(record corestore.Record, name string) bool {
	value, _ := record[name].(bool)
	return value
}

func stringField(record corestore.Record, name string) string {
	if record == nil {
		return ""
	}
	return stringValue(record[name])
}

func stringValue(value any) string {
	switch v := value.(type) {
	case string:
		return v
	case fmt.Stringer:
		return v.String()
	case json.Number:
		return v.String()
	case int:
		return strconv.Itoa(v)
	case int64:
		return strconv.FormatInt(v, 10)
	case float64:
		if v == float64(int64(v)) {
			return strconv.FormatInt(int64(v), 10)
		}
		return strconv.FormatFloat(v, 'f', -1, 64)
	case bool:
		if v {
			return "true"
		}
		return "false"
	default:
		return ""
	}
}

func mapSlice(value any) []map[string]any {
	switch v := value.(type) {
	case []map[string]any:
		return append([]map[string]any(nil), v...)
	case []corestore.Record:
		out := make([]map[string]any, 0, len(v))
		for _, item := range v {
			out = append(out, map[string]any(item))
		}
		return out
	case []any:
		out := make([]map[string]any, 0, len(v))
		for _, item := range v {
			switch typed := item.(type) {
			case map[string]any:
				out = append(out, typed)
			case corestore.Record:
				out = append(out, map[string]any(typed))
			}
		}
		return out
	default:
		return nil
	}
}

func tagsFromInput(values ...any) corestore.Record {
	tags := corestore.Record{}
	for _, value := range values {
		switch v := value.(type) {
		case map[string]string:
			for key, item := range v {
				tags[key] = item
			}
		case map[string]any:
			for key, item := range v {
				tags[key] = stringValue(item)
			}
		case corestore.Record:
			for key, item := range v {
				tags[key] = stringValue(item)
			}
		default:
			for _, item := range mapSlice(v) {
				key := stringInput(item, "TagKey", "Key", "key")
				if key == "" {
					continue
				}
				tags[key] = stringInput(item, "TagValue", "Value", "value")
			}
		}
	}
	return tags
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}
