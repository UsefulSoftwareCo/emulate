package dynamodb

import (
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	corestore "github.com/vercel-labs/emulate/internal/core/store"
	"github.com/vercel-labs/emulate/internal/services/aws/gateway"
	"github.com/vercel-labs/emulate/internal/services/aws/protocols"
)

const jsonContentType = "application/x-amz-json-1.0"

type Handler struct {
	Tables    *corestore.Collection
	Items     *corestore.Collection
	AccountID string
	Region    string
	Now       func() time.Time
}

func (h *Handler) Handle(req *http.Request, ctx gateway.AwsRequestContext) protocols.ErrorResponse {
	requestID := ctx.RequestID
	if requestID == "" {
		requestID = gateway.NewRequestID()
	}
	var response protocols.ErrorResponse
	switch ctx.Action {
	case "CreateTable":
		response = h.createTable(ctx)
	case "DeleteTable":
		response = h.deleteTable(ctx)
	case "DescribeTable":
		response = h.describeTable(ctx)
	case "ListTables":
		response = h.listTables(ctx)
	case "UpdateTable":
		response = h.updateTable(ctx)
	case "PutItem":
		response = h.putItem(ctx)
	case "GetItem":
		response = h.getItem(ctx)
	case "DeleteItem":
		response = h.deleteItem(ctx)
	case "Scan":
		response = h.scan(ctx)
	case "Query":
		response = h.query(ctx)
	case "BatchGetItem":
		response = h.batchGetItem(ctx)
	case "BatchWriteItem":
		response = h.batchWriteItem(ctx)
	case "TagResource":
		response = h.tagResource(ctx)
	case "UntagResource":
		response = h.untagResource(ctx)
	case "ListTagsOfResource":
		response = h.listTagsOfResource(ctx)
	default:
		response = h.error("NotImplementedException", fmt.Sprintf("dynamodb.%s is not implemented in the native Go runtime yet.", ctx.Action), http.StatusNotImplemented, requestID)
	}
	return withRequestID(response, requestID)
}

func (h *Handler) createTable(ctx gateway.AwsRequestContext) protocols.ErrorResponse {
	input := ctx.Input
	tableName := strings.TrimSpace(stringInput(input, "TableName"))
	if tableName == "" {
		return h.validation("TableName is required.", ctx.RequestID)
	}
	if _, ok := h.findTable(ctx, tableName); ok {
		return h.error("ResourceInUseException", "Table already exists: "+tableName, http.StatusBadRequest, ctx.RequestID)
	}
	keySchema, err := normalizeRecordList(input["KeySchema"], "AttributeName", "KeyType")
	if err != nil || len(keySchema) == 0 {
		return h.validation("KeySchema must contain at least one key attribute.", ctx.RequestID)
	}
	attributeDefinitions, err := normalizeRecordList(input["AttributeDefinitions"], "AttributeName", "AttributeType")
	if err != nil || len(attributeDefinitions) == 0 {
		return h.validation("AttributeDefinitions must contain at least one attribute.", ctx.RequestID)
	}
	billingMode := strings.TrimSpace(stringInput(input, "BillingMode"))
	if billingMode == "" {
		billingMode = "PROVISIONED"
	}
	now := h.now().UTC()
	region := h.region(ctx)
	accountID := h.accountID(ctx)
	arn := tableARN(region, accountID, tableName)
	table := h.Tables.Insert(corestore.Record{
		"account_id":             accountID,
		"region":                 region,
		"table_name":             tableName,
		"arn":                    arn,
		"attribute_definitions":  attributeDefinitions,
		"key_schema":             keySchema,
		"billing_mode":           billingMode,
		"table_status":           "ACTIVE",
		"creation_date_time":     now.Unix(),
		"provisioned_throughput": input["ProvisionedThroughput"],
		"tags":                   tagsFromInput(input["Tags"]),
	})
	return jsonResponse(http.StatusOK, map[string]any{"TableDescription": h.tableDescription(table)})
}

func (h *Handler) deleteTable(ctx gateway.AwsRequestContext) protocols.ErrorResponse {
	table, response, ok := h.requireTable(ctx)
	if !ok {
		return response
	}
	for _, item := range h.tableItems(table) {
		h.Items.Delete(intRecordField(item, "id"))
	}
	h.Tables.Delete(intRecordField(table, "id"))
	description := h.tableDescription(table)
	description["TableStatus"] = "DELETING"
	return jsonResponse(http.StatusOK, map[string]any{"TableDescription": description})
}

func (h *Handler) describeTable(ctx gateway.AwsRequestContext) protocols.ErrorResponse {
	table, response, ok := h.requireTable(ctx)
	if !ok {
		return response
	}
	return jsonResponse(http.StatusOK, map[string]any{"Table": h.tableDescription(table)})
}

func (h *Handler) listTables(ctx gateway.AwsRequestContext) protocols.ErrorResponse {
	limit := intInput(ctx.Input, "Limit", 100)
	if limit <= 0 {
		limit = 100
	}
	exclusiveStart := stringInput(ctx.Input, "ExclusiveStartTableName")
	names := []string{}
	for _, table := range h.Tables.All() {
		if !h.sameScope(ctx, table) {
			continue
		}
		names = append(names, stringRecordField(table, "table_name"))
	}
	sort.Strings(names)
	start := 0
	if exclusiveStart != "" {
		for index, name := range names {
			if name == exclusiveStart {
				start = index + 1
				break
			}
		}
	}
	end := start + limit
	if end > len(names) {
		end = len(names)
	}
	response := map[string]any{"TableNames": names[start:end]}
	if end < len(names) {
		response["LastEvaluatedTableName"] = names[end-1]
	}
	return jsonResponse(http.StatusOK, response)
}

func (h *Handler) updateTable(ctx gateway.AwsRequestContext) protocols.ErrorResponse {
	table, response, ok := h.requireTable(ctx)
	if !ok {
		return response
	}
	patch := corestore.Record{}
	if billingMode := strings.TrimSpace(stringInput(ctx.Input, "BillingMode")); billingMode != "" {
		patch["billing_mode"] = billingMode
	}
	if throughput, ok := ctx.Input["ProvisionedThroughput"]; ok {
		patch["provisioned_throughput"] = throughput
	}
	if len(patch) == 0 {
		return h.validation("UpdateTable requires at least one supported table metadata change.", ctx.RequestID)
	}
	updated, _ := h.Tables.Update(intRecordField(table, "id"), patch)
	return jsonResponse(http.StatusOK, map[string]any{"TableDescription": h.tableDescription(updated)})
}

func (h *Handler) putItem(ctx gateway.AwsRequestContext) protocols.ErrorResponse {
	table, response, ok := h.requireTable(ctx)
	if !ok {
		return response
	}
	if response, ok := h.rejectUnsupportedExpression(ctx, "ConditionExpression"); ok {
		return response
	}
	item, err := normalizeItem(ctx.Input["Item"])
	if err != nil {
		return h.validation(err.Error(), ctx.RequestID)
	}
	parts, err := keyPartsFromValues(table, item)
	if err != nil {
		return h.validation(err.Error(), ctx.RequestID)
	}
	oldItem, found := h.findItem(table, parts)
	if found {
		h.Items.Delete(intRecordField(oldItem, "id"))
	}
	h.Items.Insert(corestore.Record{
		"account_id": stringRecordField(table, "account_id"),
		"region":     stringRecordField(table, "region"),
		"table_name": stringRecordField(table, "table_name"),
		"table_arn":  stringRecordField(table, "arn"),
		"pk":         parts.Partition,
		"sk":         parts.Sort,
		"key":        parts.Key,
		"item":       item,
	})
	out := map[string]any{}
	if strings.EqualFold(stringInput(ctx.Input, "ReturnValues"), "ALL_OLD") && found {
		out["Attributes"] = projectItem(itemMap(oldItem), ctx.Input)
	}
	return jsonResponse(http.StatusOK, out)
}

func (h *Handler) getItem(ctx gateway.AwsRequestContext) protocols.ErrorResponse {
	table, response, ok := h.requireTable(ctx)
	if !ok {
		return response
	}
	parts, err := normalizeKey(table, ctx.Input["Key"])
	if err != nil {
		return h.validation(err.Error(), ctx.RequestID)
	}
	item, found := h.findItem(table, parts)
	out := map[string]any{}
	if found {
		out["Item"] = projectItem(itemMap(item), ctx.Input)
	}
	return jsonResponse(http.StatusOK, out)
}

func (h *Handler) deleteItem(ctx gateway.AwsRequestContext) protocols.ErrorResponse {
	table, response, ok := h.requireTable(ctx)
	if !ok {
		return response
	}
	if response, ok := h.rejectUnsupportedExpression(ctx, "ConditionExpression"); ok {
		return response
	}
	parts, err := normalizeKey(table, ctx.Input["Key"])
	if err != nil {
		return h.validation(err.Error(), ctx.RequestID)
	}
	item, found := h.findItem(table, parts)
	if found {
		h.Items.Delete(intRecordField(item, "id"))
	}
	out := map[string]any{}
	if strings.EqualFold(stringInput(ctx.Input, "ReturnValues"), "ALL_OLD") && found {
		out["Attributes"] = projectItem(itemMap(item), ctx.Input)
	}
	return jsonResponse(http.StatusOK, out)
}

func (h *Handler) scan(ctx gateway.AwsRequestContext) protocols.ErrorResponse {
	table, response, ok := h.requireTable(ctx)
	if !ok {
		return response
	}
	if response, ok := h.rejectUnsupportedExpression(ctx, "FilterExpression"); ok {
		return response
	}
	items := h.tableItems(table)
	items = h.applyExclusiveStartKey(table, items, ctx.Input)
	limit := intInput(ctx.Input, "Limit", len(items))
	if limit <= 0 || limit > len(items) {
		limit = len(items)
	}
	selected := items[:limit]
	outItems := make([]map[string]any, 0, len(selected))
	for _, item := range selected {
		outItems = append(outItems, projectItem(itemMap(item), ctx.Input))
	}
	out := map[string]any{
		"Items":        outItems,
		"Count":        len(outItems),
		"ScannedCount": len(selected),
	}
	if limit < len(items) {
		out["LastEvaluatedKey"] = keyMap(items[limit-1])
	}
	return jsonResponse(http.StatusOK, out)
}

func (h *Handler) query(ctx gateway.AwsRequestContext) protocols.ErrorResponse {
	table, response, ok := h.requireTable(ctx)
	if !ok {
		return response
	}
	if response, ok := h.rejectUnsupportedExpression(ctx, "FilterExpression"); ok {
		return response
	}
	matcher, response, ok := h.queryMatcher(table, ctx.Input, ctx.RequestID)
	if !ok {
		return response
	}
	candidates := h.tableItems(table)
	candidates = h.applyExclusiveStartKey(table, candidates, ctx.Input)
	items := []corestore.Record{}
	for _, item := range candidates {
		if matcher(itemMap(item)) {
			items = append(items, item)
		}
	}
	limit := intInput(ctx.Input, "Limit", len(items))
	if limit <= 0 || limit > len(items) {
		limit = len(items)
	}
	selected := items[:limit]
	outItems := make([]map[string]any, 0, len(selected))
	for _, item := range selected {
		outItems = append(outItems, projectItem(itemMap(item), ctx.Input))
	}
	out := map[string]any{
		"Items":        outItems,
		"Count":        len(outItems),
		"ScannedCount": len(selected),
	}
	if limit < len(items) {
		out["LastEvaluatedKey"] = keyMap(items[limit-1])
	}
	return jsonResponse(http.StatusOK, out)
}

func (h *Handler) batchGetItem(ctx gateway.AwsRequestContext) protocols.ErrorResponse {
	requestItems, ok := asMap(ctx.Input["RequestItems"])
	if !ok {
		return h.validation("RequestItems is required.", ctx.RequestID)
	}
	responses := map[string]any{}
	for tableName, raw := range requestItems {
		table, ok := h.findTable(ctx, tableName)
		if !ok {
			return h.tableNotFound(ctx.RequestID)
		}
		request, ok := asMap(raw)
		if !ok {
			return h.validation("RequestItems entries must be maps.", ctx.RequestID)
		}
		keys, ok := request["Keys"].([]any)
		if !ok {
			return h.validation("Keys is required.", ctx.RequestID)
		}
		projectInput := map[string]any{}
		if value, ok := request["ProjectionExpression"]; ok {
			projectInput["ProjectionExpression"] = value
		}
		if value, ok := request["ExpressionAttributeNames"]; ok {
			projectInput["ExpressionAttributeNames"] = value
		}
		rows := []map[string]any{}
		for _, rawKey := range keys {
			parts, err := normalizeKey(table, rawKey)
			if err != nil {
				return h.validation(err.Error(), ctx.RequestID)
			}
			if item, found := h.findItem(table, parts); found {
				rows = append(rows, projectItem(itemMap(item), projectInput))
			}
		}
		responses[tableName] = rows
	}
	return jsonResponse(http.StatusOK, map[string]any{"Responses": responses, "UnprocessedKeys": map[string]any{}})
}

func (h *Handler) batchWriteItem(ctx gateway.AwsRequestContext) protocols.ErrorResponse {
	requestItems, ok := asMap(ctx.Input["RequestItems"])
	if !ok {
		return h.validation("RequestItems is required.", ctx.RequestID)
	}
	for tableName, raw := range requestItems {
		table, ok := h.findTable(ctx, tableName)
		if !ok {
			return h.tableNotFound(ctx.RequestID)
		}
		requests, ok := raw.([]any)
		if !ok {
			return h.validation("RequestItems entries must be lists.", ctx.RequestID)
		}
		for _, request := range requests {
			entry, ok := asMap(request)
			if !ok {
				return h.validation("Batch write request entries must be maps.", ctx.RequestID)
			}
			if putRequest, ok := asMap(entry["PutRequest"]); ok {
				item, err := normalizeItem(putRequest["Item"])
				if err != nil {
					return h.validation(err.Error(), ctx.RequestID)
				}
				parts, err := keyPartsFromValues(table, item)
				if err != nil {
					return h.validation(err.Error(), ctx.RequestID)
				}
				if oldItem, found := h.findItem(table, parts); found {
					h.Items.Delete(intRecordField(oldItem, "id"))
				}
				h.Items.Insert(corestore.Record{
					"account_id": stringRecordField(table, "account_id"),
					"region":     stringRecordField(table, "region"),
					"table_name": stringRecordField(table, "table_name"),
					"table_arn":  stringRecordField(table, "arn"),
					"pk":         parts.Partition,
					"sk":         parts.Sort,
					"key":        parts.Key,
					"item":       item,
				})
				continue
			}
			if deleteRequest, ok := asMap(entry["DeleteRequest"]); ok {
				parts, err := normalizeKey(table, deleteRequest["Key"])
				if err != nil {
					return h.validation(err.Error(), ctx.RequestID)
				}
				if item, found := h.findItem(table, parts); found {
					h.Items.Delete(intRecordField(item, "id"))
				}
				continue
			}
			return h.validation("Batch write entries require PutRequest or DeleteRequest.", ctx.RequestID)
		}
	}
	return jsonResponse(http.StatusOK, map[string]any{"UnprocessedItems": map[string]any{}})
}

func (h *Handler) tagResource(ctx gateway.AwsRequestContext) protocols.ErrorResponse {
	resourceARN := stringInput(ctx.Input, "ResourceArn")
	table, ok := h.findTableByARN(ctx, resourceARN)
	if !ok {
		return h.tableNotFound(ctx.RequestID)
	}
	tags := mergeTags(recordList(table["tags"]), tagsFromInput(ctx.Input["Tags"]))
	h.Tables.Update(intRecordField(table, "id"), corestore.Record{"tags": tags})
	return jsonResponse(http.StatusOK, map[string]any{})
}

func (h *Handler) untagResource(ctx gateway.AwsRequestContext) protocols.ErrorResponse {
	resourceARN := stringInput(ctx.Input, "ResourceArn")
	table, ok := h.findTableByARN(ctx, resourceARN)
	if !ok {
		return h.tableNotFound(ctx.RequestID)
	}
	keys := stringSlice(ctx.Input["TagKeys"])
	updated := removeTags(recordList(table["tags"]), keys)
	h.Tables.Update(intRecordField(table, "id"), corestore.Record{"tags": updated})
	return jsonResponse(http.StatusOK, map[string]any{})
}

func (h *Handler) listTagsOfResource(ctx gateway.AwsRequestContext) protocols.ErrorResponse {
	resourceARN := stringInput(ctx.Input, "ResourceArn")
	table, ok := h.findTableByARN(ctx, resourceARN)
	if !ok {
		return h.tableNotFound(ctx.RequestID)
	}
	return jsonResponse(http.StatusOK, map[string]any{"Tags": recordList(table["tags"])})
}

func (h *Handler) rejectUnsupportedExpression(ctx gateway.AwsRequestContext, name string) (protocols.ErrorResponse, bool) {
	if strings.TrimSpace(stringInput(ctx.Input, name)) == "" {
		return protocols.ErrorResponse{}, false
	}
	return h.validation(name+" is not supported in the native Go runtime yet.", ctx.RequestID), true
}

func (h *Handler) queryMatcher(table corestore.Record, input map[string]any, requestID string) (func(map[string]any) bool, protocols.ErrorResponse, bool) {
	condition := strings.TrimSpace(stringInput(input, "KeyConditionExpression"))
	if condition == "" {
		return nil, h.validation("KeyConditionExpression is required.", requestID), false
	}
	names := expressionAttributeNames(input)
	values, err := expressionAttributeValues(input)
	if err != nil {
		return nil, h.validation(err.Error(), requestID), false
	}
	partitionName, sortName := keyAttributeNames(table)
	requiredPartition := any(nil)
	requiredSort := any(nil)
	for _, part := range splitAndConditions(condition) {
		left, right, ok := strings.Cut(part, "=")
		if !ok {
			return nil, h.validation("Only equality key conditions are supported.", requestID), false
		}
		name := resolveExpressionName(strings.TrimSpace(left), names)
		valueToken := strings.TrimSpace(right)
		value, ok := values[valueToken]
		if !ok {
			return nil, h.validation("Missing expression value "+valueToken+".", requestID), false
		}
		switch name {
		case partitionName:
			requiredPartition = value
		case sortName:
			requiredSort = value
		default:
			return nil, h.validation("KeyConditionExpression can only reference key attributes.", requestID), false
		}
	}
	if requiredPartition == nil {
		return nil, h.validation("Partition key equality is required.", requestID), false
	}
	return func(item map[string]any) bool {
		if !sameAttributeValue(item[partitionName], requiredPartition) {
			return false
		}
		if requiredSort != nil && !sameAttributeValue(item[sortName], requiredSort) {
			return false
		}
		return true
	}, protocols.ErrorResponse{}, true
}

func (h *Handler) requireTable(ctx gateway.AwsRequestContext) (corestore.Record, protocols.ErrorResponse, bool) {
	tableName := strings.TrimSpace(stringInput(ctx.Input, "TableName"))
	if tableName == "" {
		return nil, h.validation("TableName is required.", ctx.RequestID), false
	}
	table, ok := h.findTable(ctx, tableName)
	if !ok {
		return nil, h.tableNotFound(ctx.RequestID), false
	}
	return table, protocols.ErrorResponse{}, true
}

func (h *Handler) findTable(ctx gateway.AwsRequestContext, tableName string) (corestore.Record, bool) {
	for _, table := range h.Tables.FindBy("table_name", tableName) {
		if h.sameScope(ctx, table) {
			return table, true
		}
	}
	return nil, false
}

func (h *Handler) findTableByARN(ctx gateway.AwsRequestContext, arn string) (corestore.Record, bool) {
	if arn == "" {
		return nil, false
	}
	for _, table := range h.Tables.FindBy("arn", arn) {
		if h.sameScope(ctx, table) {
			return table, true
		}
	}
	return nil, false
}

func (h *Handler) findItem(table corestore.Record, parts keyParts) (corestore.Record, bool) {
	for _, item := range h.Items.FindBy("table_name", stringRecordField(table, "table_name")) {
		if stringRecordField(item, "table_arn") != stringRecordField(table, "arn") {
			continue
		}
		if stringRecordField(item, "pk") == parts.Partition && stringRecordField(item, "sk") == parts.Sort {
			return item, true
		}
	}
	return nil, false
}

func (h *Handler) tableItems(table corestore.Record) []corestore.Record {
	items := h.Items.FindBy("table_name", stringRecordField(table, "table_name"))
	filtered := make([]corestore.Record, 0, len(items))
	for _, item := range items {
		if stringRecordField(item, "table_arn") == stringRecordField(table, "arn") {
			filtered = append(filtered, item)
		}
	}
	partitionName, sortName := keyAttributeNames(table)
	attributeTypes := keyAttributeTypes(table)
	sort.Slice(filtered, func(left, right int) bool {
		leftKey := keyMap(filtered[left])
		rightKey := keyMap(filtered[right])
		if cmp := compareKeyAttribute(leftKey[partitionName], rightKey[partitionName], attributeTypes[partitionName]); cmp != 0 {
			return cmp < 0
		}
		if sortName != "" {
			if cmp := compareKeyAttribute(leftKey[sortName], rightKey[sortName], attributeTypes[sortName]); cmp != 0 {
				return cmp < 0
			}
		}
		return intRecordField(filtered[left], "id") < intRecordField(filtered[right], "id")
	})
	return filtered
}

func (h *Handler) applyExclusiveStartKey(table corestore.Record, items []corestore.Record, input map[string]any) []corestore.Record {
	raw, ok := input["ExclusiveStartKey"]
	if !ok {
		return items
	}
	parts, err := normalizeKey(table, raw)
	if err != nil {
		return items
	}
	for index, item := range items {
		if stringRecordField(item, "pk") == parts.Partition && stringRecordField(item, "sk") == parts.Sort {
			return items[index+1:]
		}
	}
	return items
}

func (h *Handler) tableDescription(table corestore.Record) map[string]any {
	itemCount := len(h.tableItems(table))
	return map[string]any{
		"AttributeDefinitions":  recordList(table["attribute_definitions"]),
		"TableName":             stringRecordField(table, "table_name"),
		"KeySchema":             recordList(table["key_schema"]),
		"TableStatus":           stringRecordField(table, "table_status"),
		"CreationDateTime":      int64RecordField(table, "creation_date_time"),
		"ProvisionedThroughput": throughputDescription(table["provisioned_throughput"]),
		"TableSizeBytes":        0,
		"ItemCount":             itemCount,
		"TableArn":              stringRecordField(table, "arn"),
		"BillingModeSummary": map[string]any{
			"BillingMode": stringRecordField(table, "billing_mode"),
		},
	}
}

func (h *Handler) sameScope(ctx gateway.AwsRequestContext, table corestore.Record) bool {
	return stringRecordField(table, "account_id") == h.accountID(ctx) && stringRecordField(table, "region") == h.region(ctx)
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
		return h.Now()
	}
	return time.Now()
}

func (h *Handler) validation(message string, requestID string) protocols.ErrorResponse {
	return h.error("ValidationException", message, http.StatusBadRequest, requestID)
}

func (h *Handler) tableNotFound(requestID string) protocols.ErrorResponse {
	return h.error("ResourceNotFoundException", "Cannot do operations on a non-existent table.", http.StatusBadRequest, requestID)
}

func (h *Handler) error(code string, message string, status int, requestID string) protocols.ErrorResponse {
	return protocols.SerializeJSONError(protocols.AWSError{
		Code:       code,
		Message:    message,
		RequestID:  requestID,
		Service:    "com.amazonaws.dynamodb.v20120810",
		StatusCode: status,
	})
}

func jsonResponse(status int, value any) protocols.ErrorResponse {
	body, _ := json.Marshal(value)
	return protocols.ErrorResponse{
		StatusCode:  status,
		ContentType: jsonContentType,
		Headers:     map[string]string{"Content-Type": jsonContentType},
		Body:        body,
	}
}

func withRequestID(response protocols.ErrorResponse, requestID string) protocols.ErrorResponse {
	if requestID == "" {
		return response
	}
	if response.Headers == nil {
		response.Headers = map[string]string{}
	}
	if response.Headers["x-amzn-requestid"] == "" {
		response.Headers["x-amzn-requestid"] = requestID
	}
	return response
}

func stringInput(input map[string]any, name string) string {
	return scalarString(input[name])
}

func intInput(input map[string]any, name string, fallback int) int {
	switch value := input[name].(type) {
	case int:
		return value
	case int64:
		return int(value)
	case float64:
		return int(value)
	case json.Number:
		number, err := value.Int64()
		if err == nil {
			return int(number)
		}
	case string:
		number, err := strconv.Atoi(value)
		if err == nil {
			return number
		}
	}
	return fallback
}

func intRecordField(record corestore.Record, name string) int {
	switch value := record[name].(type) {
	case int:
		return value
	case int64:
		return int(value)
	case float64:
		return int(value)
	case json.Number:
		number, err := value.Int64()
		if err == nil {
			return int(number)
		}
	default:
		return 0
	}
	return 0
}

func int64RecordField(record corestore.Record, name string) int64 {
	switch value := record[name].(type) {
	case int64:
		return value
	case int:
		return int64(value)
	case float64:
		return int64(value)
	case json.Number:
		number, err := value.Int64()
		if err == nil {
			return number
		}
	default:
		return 0
	}
	return 0
}

func itemMap(record corestore.Record) map[string]any {
	item, _ := asMap(record["item"])
	return cloneAttributeMap(item)
}

func keyMap(record corestore.Record) map[string]any {
	key, _ := asMap(record["key"])
	return cloneAttributeMap(key)
}

func tableARN(region string, accountID string, tableName string) string {
	return "arn:aws:dynamodb:" + region + ":" + accountID + ":table/" + tableName
}

func throughputDescription(raw any) map[string]any {
	values, ok := asMap(raw)
	if !ok {
		return map[string]any{
			"ReadCapacityUnits":  int64(0),
			"WriteCapacityUnits": int64(0),
		}
	}
	out := map[string]any{}
	for key, value := range values {
		out[key] = cloneValue(value)
	}
	return out
}

func tagsFromInput(raw any) []corestore.Record {
	values, ok := raw.([]any)
	if !ok {
		return nil
	}
	tags := make([]corestore.Record, 0, len(values))
	for _, value := range values {
		mapped, ok := asMap(value)
		if !ok {
			continue
		}
		key := scalarString(mapped["Key"])
		if key == "" {
			continue
		}
		tags = append(tags, corestore.Record{"Key": key, "Value": scalarString(mapped["Value"])})
	}
	return tags
}

func mergeTags(existing []corestore.Record, updates []corestore.Record) []corestore.Record {
	merged := map[string]string{}
	for _, tag := range existing {
		merged[stringRecordField(tag, "Key")] = stringRecordField(tag, "Value")
	}
	for _, tag := range updates {
		merged[stringRecordField(tag, "Key")] = stringRecordField(tag, "Value")
	}
	keys := make([]string, 0, len(merged))
	for key := range merged {
		if key != "" {
			keys = append(keys, key)
		}
	}
	sort.Strings(keys)
	out := make([]corestore.Record, 0, len(keys))
	for _, key := range keys {
		out = append(out, corestore.Record{"Key": key, "Value": merged[key]})
	}
	return out
}

func removeTags(existing []corestore.Record, keys []string) []corestore.Record {
	remove := map[string]bool{}
	for _, key := range keys {
		remove[key] = true
	}
	out := []corestore.Record{}
	for _, tag := range existing {
		if !remove[stringRecordField(tag, "Key")] {
			out = append(out, tag)
		}
	}
	return out
}

func stringSlice(raw any) []string {
	values, ok := raw.([]any)
	if !ok {
		return nil
	}
	out := make([]string, 0, len(values))
	for _, value := range values {
		out = append(out, scalarString(value))
	}
	return out
}

func splitAndConditions(condition string) []string {
	fields := strings.Fields(condition)
	parts := []string{}
	var current []string
	for _, field := range fields {
		if strings.EqualFold(field, "AND") {
			if len(current) > 0 {
				parts = append(parts, strings.Join(current, " "))
				current = nil
			}
			continue
		}
		current = append(current, field)
	}
	if len(current) > 0 {
		parts = append(parts, strings.Join(current, " "))
	}
	return parts
}
