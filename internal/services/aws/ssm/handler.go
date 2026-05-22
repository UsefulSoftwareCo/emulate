package ssm

import (
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
	Parameters  *corestore.Collection
	Versions    *corestore.Collection
	AccountID   string
	Region      string
	Now         func() time.Time
	IDGenerator func(string) string
}

var fallbackIDCounter atomic.Uint64

func (h *Handler) Handle(_ *http.Request, ctx gateway.AwsRequestContext) protocols.ErrorResponse {
	requestID := ctx.RequestID
	if requestID == "" {
		requestID = h.generateID("req")
	}
	var response protocols.ErrorResponse
	switch ctx.Action {
	case "PutParameter":
		response = h.putParameter(ctx, requestID)
	case "GetParameter":
		response = h.getParameter(ctx, requestID)
	case "GetParameters":
		response = h.getParameters(ctx, requestID)
	case "GetParametersByPath":
		response = h.getParametersByPath(ctx, requestID)
	case "DeleteParameter":
		response = h.deleteParameter(ctx, requestID)
	case "DeleteParameters":
		response = h.deleteParameters(ctx, requestID)
	case "DescribeParameters":
		response = h.describeParameters(ctx, requestID)
	case "AddTagsToResource":
		response = h.addTagsToResource(ctx, requestID)
	case "RemoveTagsFromResource":
		response = h.removeTagsFromResource(ctx, requestID)
	case "ListTagsForResource":
		response = h.listTagsForResource(ctx, requestID)
	default:
		response = h.error("NotImplementedException", fmt.Sprintf("ssm.%s is not implemented in the native Go runtime yet.", ctx.Action), http.StatusNotImplemented, requestID)
	}
	return withRequestID(response, requestID)
}

func (h *Handler) putParameter(ctx gateway.AwsRequestContext, requestID string) protocols.ErrorResponse {
	name := strings.TrimSpace(stringInput(ctx.Input, "Name", "name"))
	if name == "" {
		return h.validation("Name is required.", requestID)
	}
	value, hasValue := stringInputPresent(ctx.Input, "Value", "value")
	if !hasValue {
		return h.validation("Value is required.", requestID)
	}
	existing, exists := h.findParameter(ctx, name)
	if exists && !boolInput(ctx.Input, "Overwrite", "overwrite") {
		return h.error("ParameterAlreadyExists", "The parameter already exists.", http.StatusBadRequest, requestID)
	}
	parameterType, response, ok := h.parameterType(ctx.Input, existing, requestID)
	if !ok {
		return response
	}
	tier := firstNonEmpty(stringInput(ctx.Input, "Tier", "tier"), stringField(existing, "tier"), "Standard")
	dataType := firstNonEmpty(stringInput(ctx.Input, "DataType", "dataType"), stringField(existing, "data_type"), "text")
	keyID := firstNonEmpty(stringInput(ctx.Input, "KeyId", "KeyID", "keyId"), stringField(existing, "key_id"))
	description := firstNonEmpty(stringInput(ctx.Input, "Description", "description"), stringField(existing, "description"))
	now := h.now().Unix()
	version := int64(1)
	tags := tagsFromInput(ctx.Input["Tags"], ctx.Input["tags"])
	if exists {
		version = int64Field(existing, "version") + 1
		if len(tags) == 0 {
			tags = mapRecord(existing["tags"])
		} else {
			tags = mergeTags(mapRecord(existing["tags"]), tags)
		}
		h.Parameters.Update(intField(existing, "id"), corestore.Record{
			"type":               parameterType,
			"value":              value,
			"version":            version,
			"description":        description,
			"key_id":             keyID,
			"tier":               tier,
			"data_type":          dataType,
			"last_modified_date": now,
			"tags":               tags,
			"path":               parameterPath(name),
		})
	} else {
		h.Parameters.Insert(corestore.Record{
			"account_id":          h.accountID(ctx),
			"region":              h.region(ctx),
			"name":                name,
			"arn":                 parameterARN(h.region(ctx), h.accountID(ctx), name),
			"path":                parameterPath(name),
			"type":                parameterType,
			"value":               value,
			"version":             version,
			"description":         description,
			"key_id":              keyID,
			"tier":                tier,
			"data_type":           dataType,
			"last_modified_date":  now,
			"last_accessed_date":  int64(0),
			"tags":                tags,
			"allowed_pattern":     stringInput(ctx.Input, "AllowedPattern", "allowedPattern"),
			"policies":            []string{},
			"selector_labels":     []string{},
			"source_result":       "",
			"has_secure_material": parameterType == "SecureString",
		})
	}
	h.insertVersion(ctx, name, version, parameterType, value, description, keyID, tier, dataType, now)
	return jsonResponse(http.StatusOK, map[string]any{
		"Version": version,
		"Tier":    tier,
	})
}

func (h *Handler) getParameter(ctx gateway.AwsRequestContext, requestID string) protocols.ErrorResponse {
	name, selector := parameterNameSelector(strings.TrimSpace(stringInput(ctx.Input, "Name", "name")))
	parameter, response, ok := h.requireParameter(ctx, name, requestID)
	if !ok {
		return response
	}
	record := parameter
	if selector != "" {
		version, response, ok := h.requireVersion(parameter, selector, requestID)
		if !ok {
			return response
		}
		record = version
	}
	h.Parameters.Update(intField(parameter, "id"), corestore.Record{"last_accessed_date": h.now().Unix()})
	body := h.parameterResponse(parameter, record)
	if selector != "" {
		body["Selector"] = ":" + selector
	}
	return jsonResponse(http.StatusOK, map[string]any{"Parameter": body})
}

func (h *Handler) getParameters(ctx gateway.AwsRequestContext, requestID string) protocols.ErrorResponse {
	names := stringSlice(inputValue(ctx.Input, "Names", "names"))
	if len(names) == 0 {
		return h.validation("Names is required.", requestID)
	}
	parameters := []map[string]any{}
	invalid := []string{}
	for _, rawName := range names {
		name, selector := parameterNameSelector(strings.TrimSpace(rawName))
		parameter, ok := h.findParameter(ctx, name)
		if !ok {
			invalid = append(invalid, rawName)
			continue
		}
		record := parameter
		if selector != "" {
			version, ok := h.findVersion(parameter, selector)
			if !ok {
				invalid = append(invalid, rawName)
				continue
			}
			record = version
		}
		h.Parameters.Update(intField(parameter, "id"), corestore.Record{"last_accessed_date": h.now().Unix()})
		parameters = append(parameters, h.parameterResponse(parameter, record))
	}
	sort.Slice(parameters, func(i int, j int) bool {
		return stringValue(parameters[i]["Name"]) < stringValue(parameters[j]["Name"])
	})
	sort.Strings(invalid)
	return jsonResponse(http.StatusOK, map[string]any{
		"Parameters":        parameters,
		"InvalidParameters": invalid,
	})
}

func (h *Handler) getParametersByPath(ctx gateway.AwsRequestContext, requestID string) protocols.ErrorResponse {
	path := normalizePath(strings.TrimSpace(stringInput(ctx.Input, "Path", "path")))
	if path == "" {
		return h.validation("Path is required.", requestID)
	}
	recursive := boolInput(ctx.Input, "Recursive", "recursive")
	parameters := []corestore.Record{}
	for _, parameter := range h.Parameters.All() {
		if !h.sameScope(ctx, parameter) || !isParameterUnderPath(stringField(parameter, "name"), path, recursive) {
			continue
		}
		parameters = append(parameters, parameter)
	}
	sort.Slice(parameters, func(i int, j int) bool {
		return stringField(parameters[i], "name") < stringField(parameters[j], "name")
	})
	start, end, nextToken, response, ok := h.pageBounds(ctx.Input, len(parameters), 10, 10, requestID)
	if !ok {
		return response
	}
	out := make([]map[string]any, 0, end-start)
	for _, parameter := range parameters[start:end] {
		h.Parameters.Update(intField(parameter, "id"), corestore.Record{"last_accessed_date": h.now().Unix()})
		out = append(out, h.parameterResponse(parameter, parameter))
	}
	body := map[string]any{"Parameters": out}
	if nextToken != "" {
		body["NextToken"] = nextToken
	}
	return jsonResponse(http.StatusOK, body)
}

func (h *Handler) deleteParameter(ctx gateway.AwsRequestContext, requestID string) protocols.ErrorResponse {
	parameter, response, ok := h.requireParameter(ctx, strings.TrimSpace(stringInput(ctx.Input, "Name", "name")), requestID)
	if !ok {
		return response
	}
	h.deleteParameterRecord(parameter)
	return jsonResponse(http.StatusOK, map[string]any{})
}

func (h *Handler) deleteParameters(ctx gateway.AwsRequestContext, requestID string) protocols.ErrorResponse {
	names := stringSlice(inputValue(ctx.Input, "Names", "names"))
	if len(names) == 0 {
		return h.validation("Names is required.", requestID)
	}
	deleted := []string{}
	invalid := []string{}
	for _, name := range names {
		parameter, ok := h.findParameter(ctx, strings.TrimSpace(name))
		if !ok {
			invalid = append(invalid, name)
			continue
		}
		h.deleteParameterRecord(parameter)
		deleted = append(deleted, name)
	}
	sort.Strings(deleted)
	sort.Strings(invalid)
	return jsonResponse(http.StatusOK, map[string]any{
		"DeletedParameters": deleted,
		"InvalidParameters": invalid,
	})
}

func (h *Handler) describeParameters(ctx gateway.AwsRequestContext, requestID string) protocols.ErrorResponse {
	parameters := []corestore.Record{}
	filters := mapSlice(inputValue(ctx.Input, "ParameterFilters", "parameterFilters", "Filters", "filters"))
	for _, parameter := range h.Parameters.All() {
		if !h.sameScope(ctx, parameter) || !h.matchesFilters(parameter, filters) {
			continue
		}
		parameters = append(parameters, parameter)
	}
	sort.Slice(parameters, func(i int, j int) bool {
		return stringField(parameters[i], "name") < stringField(parameters[j], "name")
	})
	start, end, nextToken, response, ok := h.pageBounds(ctx.Input, len(parameters), 50, 50, requestID)
	if !ok {
		return response
	}
	out := make([]map[string]any, 0, end-start)
	for _, parameter := range parameters[start:end] {
		out = append(out, h.parameterMetadata(parameter))
	}
	body := map[string]any{"Parameters": out}
	if nextToken != "" {
		body["NextToken"] = nextToken
	}
	return jsonResponse(http.StatusOK, body)
}

func (h *Handler) addTagsToResource(ctx gateway.AwsRequestContext, requestID string) protocols.ErrorResponse {
	parameter, response, ok := h.requireTaggedParameter(ctx, requestID)
	if !ok {
		return response
	}
	tags := tagsFromInput(ctx.Input["Tags"], ctx.Input["tags"])
	h.Parameters.Update(intField(parameter, "id"), corestore.Record{"tags": mergeTags(mapRecord(parameter["tags"]), tags)})
	return jsonResponse(http.StatusOK, map[string]any{})
}

func (h *Handler) removeTagsFromResource(ctx gateway.AwsRequestContext, requestID string) protocols.ErrorResponse {
	parameter, response, ok := h.requireTaggedParameter(ctx, requestID)
	if !ok {
		return response
	}
	tags := mapRecord(parameter["tags"])
	for _, key := range stringSlice(inputValue(ctx.Input, "TagKeys", "tagKeys")) {
		delete(tags, key)
	}
	h.Parameters.Update(intField(parameter, "id"), corestore.Record{"tags": tags})
	return jsonResponse(http.StatusOK, map[string]any{})
}

func (h *Handler) listTagsForResource(ctx gateway.AwsRequestContext, requestID string) protocols.ErrorResponse {
	parameter, response, ok := h.requireTaggedParameter(ctx, requestID)
	if !ok {
		return response
	}
	return jsonResponse(http.StatusOK, map[string]any{"TagList": tagListResponse(mapRecord(parameter["tags"]))})
}

func (h *Handler) requireTaggedParameter(ctx gateway.AwsRequestContext, requestID string) (corestore.Record, protocols.ErrorResponse, bool) {
	resourceType := firstNonEmpty(stringInput(ctx.Input, "ResourceType", "resourceType"), "Parameter")
	if resourceType != "Parameter" {
		return nil, h.validation("ResourceType must be Parameter.", requestID), false
	}
	resourceID := strings.TrimSpace(stringInput(ctx.Input, "ResourceId", "resourceId"))
	if resourceID == "" {
		return nil, h.validation("ResourceId is required.", requestID), false
	}
	parameter, ok := h.findParameter(ctx, resourceID)
	if !ok {
		return nil, h.notFound("Parameter not found.", requestID), false
	}
	return parameter, protocols.ErrorResponse{}, true
}

func (h *Handler) requireParameter(ctx gateway.AwsRequestContext, name string, requestID string) (corestore.Record, protocols.ErrorResponse, bool) {
	name = strings.TrimSpace(name)
	if name == "" {
		return nil, h.validation("Name is required.", requestID), false
	}
	parameter, ok := h.findParameter(ctx, name)
	if !ok {
		return nil, h.notFound("Parameter not found.", requestID), false
	}
	return parameter, protocols.ErrorResponse{}, true
}

func (h *Handler) findParameter(ctx gateway.AwsRequestContext, name string) (corestore.Record, bool) {
	name = strings.TrimSpace(name)
	if name == "" {
		return nil, false
	}
	if strings.HasPrefix(name, "arn:") {
		parsed, ok := parseParameterARN(name)
		if !ok || parsed.AccountID != h.accountID(ctx) || parsed.Region != h.region(ctx) {
			return nil, false
		}
		for _, parameter := range h.Parameters.FindBy("arn", name) {
			if h.sameScope(ctx, parameter) {
				return parameter, true
			}
		}
		for _, candidate := range parameterNameCandidates(parsed.Name) {
			if parameter, ok := h.findParameterByName(ctx, candidate); ok {
				return parameter, true
			}
		}
		return nil, false
	}
	if parameter, ok := h.findParameterByName(ctx, name); ok {
		return parameter, true
	}
	for _, candidate := range alternateParameterNames(name) {
		if parameter, ok := h.findParameterByName(ctx, candidate); ok {
			return parameter, true
		}
	}
	return nil, false
}

func (h *Handler) findParameterByName(ctx gateway.AwsRequestContext, name string) (corestore.Record, bool) {
	for _, parameter := range h.Parameters.FindBy("name", name) {
		if h.sameScope(ctx, parameter) {
			return parameter, true
		}
	}
	return nil, false
}

func (h *Handler) requireVersion(parameter corestore.Record, selector string, requestID string) (corestore.Record, protocols.ErrorResponse, bool) {
	version, ok := h.findVersion(parameter, selector)
	if !ok {
		return nil, h.error("ParameterVersionNotFound", "Parameter version not found.", http.StatusBadRequest, requestID), false
	}
	return version, protocols.ErrorResponse{}, true
}

func (h *Handler) findVersion(parameter corestore.Record, selector string) (corestore.Record, bool) {
	version, err := strconv.ParseInt(selector, 10, 64)
	if err != nil || version <= 0 {
		return nil, false
	}
	for _, record := range h.Versions.FindBy("name", stringField(parameter, "name")) {
		if stringField(record, "account_id") == stringField(parameter, "account_id") &&
			stringField(record, "region") == stringField(parameter, "region") &&
			int64Field(record, "version") == version {
			return record, true
		}
	}
	return nil, false
}

func (h *Handler) insertVersion(ctx gateway.AwsRequestContext, name string, version int64, parameterType string, value string, description string, keyID string, tier string, dataType string, modified int64) {
	h.Versions.Insert(corestore.Record{
		"account_id":          h.accountID(ctx),
		"region":              h.region(ctx),
		"name":                name,
		"arn":                 parameterARN(h.region(ctx), h.accountID(ctx), name),
		"version":             version,
		"type":                parameterType,
		"value":               value,
		"description":         description,
		"key_id":              keyID,
		"tier":                tier,
		"data_type":           dataType,
		"last_modified_date":  modified,
		"has_secure_material": parameterType == "SecureString",
	})
}

func (h *Handler) deleteParameterRecord(parameter corestore.Record) {
	name := stringField(parameter, "name")
	for _, version := range h.Versions.FindBy("name", name) {
		if sameRecordScope(parameter, version) {
			h.Versions.Delete(intField(version, "id"))
		}
	}
	h.Parameters.Delete(intField(parameter, "id"))
}

func (h *Handler) parameterType(input map[string]any, existing corestore.Record, requestID string) (string, protocols.ErrorResponse, bool) {
	raw, hasType := stringInputPresent(input, "Type", "type")
	parameterType := raw
	if !hasType {
		parameterType = firstNonEmpty(stringField(existing, "type"), "String")
	}
	switch parameterType {
	case "String", "StringList", "SecureString":
		return parameterType, protocols.ErrorResponse{}, true
	default:
		return "", h.validation("Type must be String, StringList, or SecureString.", requestID), false
	}
}

func (h *Handler) parameterResponse(parameter corestore.Record, source corestore.Record) map[string]any {
	return map[string]any{
		"Name":             stringField(parameter, "name"),
		"Type":             stringField(source, "type"),
		"Value":            stringField(source, "value"),
		"Version":          int64Field(source, "version"),
		"LastModifiedDate": int64Field(source, "last_modified_date"),
		"ARN":              stringField(parameter, "arn"),
		"DataType":         firstNonEmpty(stringField(source, "data_type"), "text"),
	}
}

func (h *Handler) parameterMetadata(parameter corestore.Record) map[string]any {
	response := map[string]any{
		"Name":             stringField(parameter, "name"),
		"Type":             stringField(parameter, "type"),
		"Version":          int64Field(parameter, "version"),
		"LastModifiedDate": int64Field(parameter, "last_modified_date"),
		"ARN":              stringField(parameter, "arn"),
		"DataType":         firstNonEmpty(stringField(parameter, "data_type"), "text"),
		"Tier":             firstNonEmpty(stringField(parameter, "tier"), "Standard"),
	}
	if description := stringField(parameter, "description"); description != "" {
		response["Description"] = description
	}
	if keyID := stringField(parameter, "key_id"); keyID != "" {
		response["KeyId"] = keyID
	}
	return response
}

func (h *Handler) matchesFilters(parameter corestore.Record, filters []map[string]any) bool {
	for _, filter := range filters {
		key := stringInput(filter, "Key", "key")
		option := firstNonEmpty(stringInput(filter, "Option", "option"), "Equals")
		values := stringSlice(inputValue(filter, "Values", "values"))
		if !parameterMatchesFilter(parameter, key, option, values) {
			return false
		}
	}
	return true
}

func parameterMatchesFilter(parameter corestore.Record, key string, option string, values []string) bool {
	name := stringField(parameter, "name")
	switch {
	case key == "" || len(values) == 0:
		return true
	case key == "Name":
		return stringMatchesOption(name, option, values)
	case key == "Path":
		for _, value := range values {
			path := normalizePath(value)
			if path != "" && isParameterUnderPath(name, path, strings.EqualFold(option, "Recursive")) {
				return true
			}
		}
		return false
	case key == "Type":
		return hasString(values, stringField(parameter, "type"))
	case key == "KeyId":
		return hasString(values, stringField(parameter, "key_id"))
	case key == "Tier":
		return hasString(values, stringField(parameter, "tier"))
	case key == "DataType":
		return hasString(values, stringField(parameter, "data_type"))
	case strings.HasPrefix(key, "tag:"):
		tagKey := strings.TrimPrefix(key, "tag:")
		return hasString(values, stringField(mapRecord(parameter["tags"]), tagKey))
	default:
		return true
	}
}

func stringMatchesOption(value string, option string, candidates []string) bool {
	for _, candidate := range candidates {
		switch option {
		case "BeginsWith":
			if strings.HasPrefix(value, candidate) {
				return true
			}
		default:
			if value == candidate {
				return true
			}
		}
	}
	return false
}

func (h *Handler) pageBounds(input map[string]any, total int, fallbackLimit int, maxLimit int, requestID string) (int, int, string, protocols.ErrorResponse, bool) {
	limit := intInput(input, fallbackLimit, "MaxResults", "maxResults")
	if limit <= 0 {
		limit = fallbackLimit
	}
	if maxLimit > 0 && limit > maxLimit {
		limit = maxLimit
	}
	start := 0
	if raw := strings.TrimSpace(stringInput(input, "NextToken", "nextToken")); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed < 0 || parsed > total {
			return 0, 0, "", h.validation("NextToken is invalid.", requestID), false
		}
		start = parsed
	}
	end := start + limit
	if end > total {
		end = total
	}
	nextToken := ""
	if end < total {
		nextToken = strconv.Itoa(end)
	}
	return start, end, nextToken, protocols.ErrorResponse{}, true
}

func (h *Handler) validation(message string, requestID string) protocols.ErrorResponse {
	return h.error("ValidationException", message, http.StatusBadRequest, requestID)
}

func (h *Handler) notFound(message string, requestID string) protocols.ErrorResponse {
	return h.error("ParameterNotFound", message, http.StatusBadRequest, requestID)
}

func (h *Handler) error(code string, message string, status int, requestID string) protocols.ErrorResponse {
	return protocols.SerializeJSONError(protocols.AWSError{
		Code:       code,
		Message:    message,
		RequestID:  requestID,
		Service:    "com.amazonaws.ssm",
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

type parameterARNParts struct {
	Region    string
	AccountID string
	Name      string
}

func parseParameterARN(value string) (parameterARNParts, bool) {
	parts := strings.SplitN(value, ":", 6)
	if len(parts) != 6 || parts[0] != "arn" || parts[2] != "ssm" || parts[3] == "" || parts[4] == "" {
		return parameterARNParts{}, false
	}
	name, ok := strings.CutPrefix(parts[5], "parameter/")
	if !ok || name == "" {
		return parameterARNParts{}, false
	}
	return parameterARNParts{Region: parts[3], AccountID: parts[4], Name: name}, true
}

func parameterARN(region string, accountID string, name string) string {
	return "arn:aws:ssm:" + region + ":" + accountID + ":parameter/" + strings.TrimPrefix(name, "/")
}

func parameterNameSelector(value string) (string, string) {
	if strings.HasPrefix(value, "arn:") {
		return value, ""
	}
	index := strings.LastIndex(value, ":")
	if index <= 0 || index == len(value)-1 {
		return value, ""
	}
	return value[:index], value[index+1:]
}

func parameterNameCandidates(name string) []string {
	if strings.HasPrefix(name, "/") {
		return []string{name, strings.TrimPrefix(name, "/")}
	}
	return []string{name, "/" + name}
}

func alternateParameterNames(name string) []string {
	if strings.HasPrefix(name, "/") {
		return []string{strings.TrimPrefix(name, "/")}
	}
	return []string{"/" + name}
}

func parameterPath(name string) string {
	name = strings.TrimSpace(name)
	if name == "" || !strings.HasPrefix(name, "/") {
		return "/"
	}
	trimmed := strings.TrimSuffix(name, "/")
	index := strings.LastIndex(trimmed, "/")
	if index <= 0 {
		return "/"
	}
	return trimmed[:index]
}

func normalizePath(path string) string {
	path = strings.TrimSpace(path)
	if path == "" {
		return ""
	}
	if !strings.HasPrefix(path, "/") {
		path = "/" + path
	}
	if len(path) > 1 {
		path = strings.TrimRight(path, "/")
	}
	return path
}

func isParameterUnderPath(name string, path string, recursive bool) bool {
	if path == "/" {
		if !strings.HasPrefix(name, "/") || name == "/" {
			return false
		}
		remainder := strings.TrimPrefix(name, "/")
		return recursive || !strings.Contains(remainder, "/")
	}
	if name == path || !strings.HasPrefix(name, path+"/") {
		return false
	}
	remainder := strings.TrimPrefix(name, path+"/")
	return recursive || !strings.Contains(remainder, "/")
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

func stringSlice(value any) []string {
	switch v := value.(type) {
	case []string:
		return append([]string(nil), v...)
	case []any:
		out := make([]string, 0, len(v))
		for _, item := range v {
			if s := stringValue(item); s != "" {
				out = append(out, s)
			}
		}
		return out
	case []map[string]any:
		return nil
	case nil:
		return nil
	default:
		if s := stringValue(v); s != "" {
			return []string{s}
		}
		return nil
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

func mapRecord(value any) corestore.Record {
	switch v := value.(type) {
	case corestore.Record:
		out := corestore.Record{}
		for key, item := range v {
			out[key] = item
		}
		return out
	case map[string]any:
		out := corestore.Record{}
		for key, item := range v {
			out[key] = item
		}
		return out
	case map[string]string:
		out := corestore.Record{}
		for key, item := range v {
			out[key] = item
		}
		return out
	default:
		return corestore.Record{}
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
				key := stringInput(item, "Key", "key")
				if key == "" {
					continue
				}
				tags[key] = stringInput(item, "Value", "value")
			}
		}
	}
	return tags
}

func mergeTags(existing corestore.Record, updates corestore.Record) corestore.Record {
	out := corestore.Record{}
	for key, value := range existing {
		out[key] = stringValue(value)
	}
	for key, value := range updates {
		out[key] = stringValue(value)
	}
	return out
}

func tagListResponse(tags corestore.Record) []map[string]any {
	keys := make([]string, 0, len(tags))
	for key := range tags {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	out := make([]map[string]any, 0, len(keys))
	for _, key := range keys {
		out = append(out, map[string]any{"Key": key, "Value": stringValue(tags[key])})
	}
	return out
}

func hasString(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}

func sameRecordScope(left corestore.Record, right corestore.Record) bool {
	return stringField(left, "account_id") == stringField(right, "account_id") && stringField(left, "region") == stringField(right, "region")
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}
