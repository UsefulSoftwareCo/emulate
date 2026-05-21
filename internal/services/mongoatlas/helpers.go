package mongoatlas

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	corehttp "github.com/vercel-labs/emulate/internal/core/http"
	corestore "github.com/vercel-labs/emulate/internal/core/store"
)

func generateObjectID() string {
	raw := make([]byte, 8)
	if _, err := rand.Read(raw); err != nil {
		return fmt.Sprintf("%08x%s", time.Now().Unix(), strconv.FormatInt(time.Now().UnixNano(), 16))[:24]
	}
	return fmt.Sprintf("%08x%s", time.Now().Unix(), hex.EncodeToString(raw))[:24]
}

func generateHexID() string {
	raw := make([]byte, 12)
	if _, err := rand.Read(raw); err != nil {
		return strconv.FormatInt(time.Now().UnixNano(), 16)
	}
	return hex.EncodeToString(raw)
}

func readJSONBody(r *http.Request) map[string]any {
	return readJSONBodyWithOrder(r).Values
}

type orderedJSONBody struct {
	Values map[string]any
	Orders map[string][]string
}

func (body orderedJSONBody) Order(path string) []string {
	return append([]string(nil), body.Orders[path]...)
}

func readJSONBodyWithOrder(r *http.Request) orderedJSONBody {
	defer r.Body.Close()
	raw, _ := io.ReadAll(r.Body)
	if len(strings.TrimSpace(string(raw))) == 0 {
		return orderedJSONBody{Values: map[string]any{}, Orders: map[string][]string{}}
	}
	decoder := json.NewDecoder(strings.NewReader(string(raw)))
	decoder.UseNumber()
	orders := map[string][]string{}
	value, err := readOrderedJSONValue(decoder, "", orders)
	if err != nil {
		return orderedJSONBody{Values: map[string]any{}, Orders: map[string][]string{}}
	}
	body, ok := value.(map[string]any)
	if !ok || body == nil {
		return orderedJSONBody{Values: map[string]any{}, Orders: map[string][]string{}}
	}
	return orderedJSONBody{Values: body, Orders: orders}
}

func readOrderedJSONValue(decoder *json.Decoder, path string, orders map[string][]string) (any, error) {
	token, err := decoder.Token()
	if err != nil {
		return nil, err
	}

	delimiter, ok := token.(json.Delim)
	if !ok {
		return token, nil
	}

	switch delimiter {
	case '{':
		object := map[string]any{}
		keys := make([]string, 0)
		for decoder.More() {
			keyToken, err := decoder.Token()
			if err != nil {
				return nil, err
			}
			key, ok := keyToken.(string)
			if !ok {
				return nil, fmt.Errorf("invalid JSON object key")
			}
			value, err := readOrderedJSONValue(decoder, joinJSONPath(path, key), orders)
			if err != nil {
				return nil, err
			}
			object[key] = value
			keys = append(keys, key)
		}
		if _, err := decoder.Token(); err != nil {
			return nil, err
		}
		orders[path] = keys
		return object, nil
	case '[':
		items := make([]any, 0)
		for i := 0; decoder.More(); i++ {
			value, err := readOrderedJSONValue(decoder, joinJSONPath(path, strconv.Itoa(i)), orders)
			if err != nil {
				return nil, err
			}
			items = append(items, value)
		}
		if _, err := decoder.Token(); err != nil {
			return nil, err
		}
		return items, nil
	default:
		return nil, fmt.Errorf("unexpected JSON delimiter %q", delimiter)
	}
}

func joinJSONPath(parent string, child string) string {
	if parent == "" {
		return child
	}
	return parent + "." + child
}

func mongoOK(c *corehttp.Context, status int, value map[string]any) {
	c.JSON(status, value)
}

func mongoError(c *corehttp.Context, status int, code string, detail string) {
	c.JSON(status, map[string]any{"error": status, "errorCode": code, "detail": detail})
}

func firstRecord(records []corestore.Record) corestore.Record {
	if len(records) == 0 {
		return nil
	}
	return records[0]
}

func stringField(record corestore.Record, field string) string {
	if record == nil {
		return ""
	}
	return stringValue(record[field])
}

func stringValue(value any) string {
	switch v := value.(type) {
	case string:
		return v
	case fmt.Stringer:
		return v.String()
	case nil:
		return ""
	default:
		return fmt.Sprint(v)
	}
}

func intField(record corestore.Record, field string) int {
	if record == nil {
		return 0
	}
	return intValue(record[field])
}

func intValue(value any) int {
	switch v := value.(type) {
	case int:
		return v
	case int64:
		return int(v)
	case float64:
		return int(v)
	case json.Number:
		n, _ := v.Int64()
		return int(n)
	case string:
		n, _ := strconv.Atoi(v)
		return n
	default:
		return 0
	}
}

func floatValue(value any) (float64, bool) {
	switch v := value.(type) {
	case int:
		return float64(v), true
	case int64:
		return float64(v), true
	case float64:
		return v, true
	case json.Number:
		n, err := v.Float64()
		return n, err == nil
	default:
		return 0, false
	}
}

func mapValue(value any) map[string]any {
	if m, ok := objectValue(value); ok {
		return m
	}
	return map[string]any{}
}

func objectValue(value any) (map[string]any, bool) {
	if value == nil {
		return nil, false
	}
	if m, ok := value.(map[string]any); ok {
		return cloneMap(m), true
	}
	return nil, false
}

func mapSliceValue(value any) []map[string]any {
	if maps, ok := value.([]map[string]any); ok {
		out := make([]map[string]any, 0, len(maps))
		for _, item := range maps {
			out = append(out, cloneMap(item))
		}
		return out
	}
	items, ok := value.([]any)
	if !ok {
		return nil
	}
	out := make([]map[string]any, 0, len(items))
	for _, item := range items {
		if m, ok := item.(map[string]any); ok {
			out = append(out, cloneMap(m))
		}
	}
	return out
}

func stringSliceValue(value any) []string {
	switch v := value.(type) {
	case []string:
		return append([]string(nil), v...)
	case []any:
		out := make([]string, 0, len(v))
		for _, item := range v {
			if text, ok := item.(string); ok {
				out = append(out, text)
			}
		}
		return out
	default:
		return nil
	}
}

func cloneMap(in map[string]any) map[string]any {
	out := make(map[string]any, len(in))
	for key, value := range in {
		out[key] = cloneValue(value)
	}
	return out
}

func cloneValue(value any) any {
	switch v := value.(type) {
	case map[string]any:
		return cloneMap(v)
	case []any:
		out := make([]any, len(v))
		for i, item := range v {
			out[i] = cloneValue(item)
		}
		return out
	case []string:
		return append([]string(nil), v...)
	case []map[string]any:
		out := make([]map[string]any, len(v))
		for i, item := range v {
			out[i] = cloneMap(item)
		}
		return out
	default:
		return value
	}
}

func recordData(record corestore.Record) map[string]any {
	return mapValue(record["data"])
}

func recordsForCollection(store Store, clusterID string, database string, collection string) []corestore.Record {
	records := store.Documents.FindBy("cluster_id", clusterID)
	filtered := make([]corestore.Record, 0, len(records))
	for _, record := range records {
		if stringField(record, "database") == database && stringField(record, "collection") == collection {
			filtered = append(filtered, record)
		}
	}
	return filtered
}

func matchesFilter(data map[string]any, filter map[string]any) bool {
	for key, value := range filter {
		switch key {
		case "$and":
			conditions := mapSliceValue(value)
			for _, condition := range conditions {
				if !matchesFilter(data, condition) {
					return false
				}
			}
			continue
		case "$or":
			conditions := mapSliceValue(value)
			matched := false
			for _, condition := range conditions {
				if matchesFilter(data, condition) {
					matched = true
					break
				}
			}
			if !matched {
				return false
			}
			continue
		case "$nor":
			for _, condition := range mapSliceValue(value) {
				if matchesFilter(data, condition) {
					return false
				}
			}
			continue
		}

		docValue, exists := nestedValue(data, key)
		if operators, ok := value.(map[string]any); ok && value != nil && hasOperatorKey(operators) {
			for op, opValue := range operators {
				switch op {
				case "$eq":
					if !valuesEqual(docValue, opValue) {
						return false
					}
				case "$ne":
					if valuesEqual(docValue, opValue) {
						return false
					}
				case "$gt", "$gte", "$lt", "$lte":
					if !compareNumber(docValue, opValue, op) {
						return false
					}
				case "$in":
					if !matchesAnyValue(opValue, docValue) {
						return false
					}
				case "$nin":
					if matchesAnyValue(opValue, docValue) {
						return false
					}
				case "$exists":
					want := boolValue(opValue)
					if want != exists {
						return false
					}
				case "$regex":
					pattern := stringValue(opValue)
					if len(pattern) > 1000 {
						return false
					}
					flags := stringValue(operators["$options"])
					if strings.Contains(flags, "i") {
						pattern = "(?i)" + pattern
					}
					re, err := regexp.Compile(pattern)
					if err != nil || !re.MatchString(stringValue(docValue)) {
						return false
					}
				case "$options":
					if operators["$regex"] == nil {
						return false
					}
				default:
					return false
				}
			}
			continue
		}
		if !valuesEqual(docValue, value) {
			return false
		}
	}
	return true
}

func filterRecords(records []corestore.Record, filter map[string]any) []corestore.Record {
	if len(filter) == 0 {
		return records
	}
	out := make([]corestore.Record, 0, len(records))
	for _, record := range records {
		if matchesFilter(recordData(record), filter) {
			out = append(out, record)
		}
	}
	return out
}

func nestedValue(data map[string]any, path string) (any, bool) {
	parts := strings.Split(path, ".")
	if hasDangerousKey(parts) {
		return nil, false
	}
	var current any = data
	for _, part := range parts {
		m, ok := current.(map[string]any)
		if !ok || m == nil {
			return nil, false
		}
		current, ok = m[part]
		if !ok {
			return nil, false
		}
	}
	return current, true
}

func setNestedValue(data map[string]any, path string, value any) {
	parts := strings.Split(path, ".")
	if hasDangerousKey(parts) || len(parts) == 0 {
		return
	}
	current := data
	for i := 0; i < len(parts)-1; i++ {
		next, ok := current[parts[i]].(map[string]any)
		if !ok || next == nil {
			next = map[string]any{}
			current[parts[i]] = next
		}
		current = next
	}
	current[parts[len(parts)-1]] = cloneValue(value)
}

func unsetNestedValue(data map[string]any, path string) {
	parts := strings.Split(path, ".")
	if hasDangerousKey(parts) || len(parts) == 0 {
		return
	}
	if len(parts) == 1 {
		delete(data, path)
		return
	}
	current := data
	for i := 0; i < len(parts)-1; i++ {
		next, ok := current[parts[i]].(map[string]any)
		if !ok || next == nil {
			return
		}
		current = next
	}
	delete(current, parts[len(parts)-1])
}

func applyProjection(data map[string]any, projection map[string]any) map[string]any {
	if len(projection) == 0 {
		return cloneMap(data)
	}
	hasInclusions := false
	for _, value := range projection {
		if projectionEnabled(value) {
			hasInclusions = true
			break
		}
	}
	if hasInclusions {
		out := map[string]any{}
		if !projectionDisabled(projection["_id"]) {
			if value, ok := data["_id"]; ok {
				out["_id"] = cloneValue(value)
			}
		}
		for key, value := range projection {
			if key == "_id" {
				continue
			}
			if projectionEnabled(value) {
				if item, ok := nestedValue(data, key); ok {
					setNestedValue(out, key, item)
				}
			}
		}
		return out
	}
	out := cloneMap(data)
	for key, value := range projection {
		if projectionDisabled(value) {
			unsetNestedValue(out, key)
		}
	}
	return out
}

func applyUpdate(data map[string]any, update map[string]any) map[string]any {
	out := cloneMap(data)
	hasOperators := false
	for key := range update {
		if strings.HasPrefix(key, "$") {
			hasOperators = true
			break
		}
	}
	if !hasOperators {
		id := out["_id"]
		out = cloneMap(update)
		out["_id"] = id
		return out
	}

	if fields := mapValue(update["$set"]); len(fields) > 0 {
		for key, value := range fields {
			setNestedValue(out, key, value)
		}
	}
	if fields := mapValue(update["$unset"]); len(fields) > 0 {
		for key := range fields {
			unsetNestedValue(out, key)
		}
	}
	if fields := mapValue(update["$inc"]); len(fields) > 0 {
		for key, value := range fields {
			current, _ := nestedValue(out, key)
			left, _ := floatValue(current)
			right, ok := floatValue(value)
			if !ok {
				continue
			}
			next := left + right
			if isWhole(next) {
				setNestedValue(out, key, int(next))
			} else {
				setNestedValue(out, key, next)
			}
		}
	}
	if fields := mapValue(update["$push"]); len(fields) > 0 {
		for key, value := range fields {
			current, _ := nestedValue(out, key)
			items, _ := current.([]any)
			items = append(append([]any(nil), items...), cloneValue(value))
			setNestedValue(out, key, items)
		}
	}
	if fields := mapValue(update["$pull"]); len(fields) > 0 {
		for key, value := range fields {
			current, _ := nestedValue(out, key)
			items, ok := current.([]any)
			if !ok {
				continue
			}
			next := make([]any, 0, len(items))
			for _, item := range items {
				if !valuesEqual(item, value) {
					next = append(next, item)
				}
			}
			setNestedValue(out, key, next)
		}
	}
	if fields := mapValue(update["$rename"]); len(fields) > 0 {
		for oldKey, newKeyValue := range fields {
			newKey := stringValue(newKeyValue)
			if newKey == "" {
				continue
			}
			if value, ok := nestedValue(out, oldKey); ok {
				setNestedValue(out, newKey, value)
				unsetNestedValue(out, oldKey)
			}
		}
	}
	return out
}

func sortRecords(records []corestore.Record, spec map[string]any, order []string) []corestore.Record {
	out := append([]corestore.Record(nil), records...)
	keys := orderedSpecKeys(spec, order)
	sort.SliceStable(out, func(i int, j int) bool {
		for _, key := range keys {
			directionValue := spec[key]
			direction := intValue(directionValue)
			if direction == 0 {
				direction = 1
			}
			left, leftOK := nestedValue(recordData(out[i]), key)
			right, rightOK := nestedValue(recordData(out[j]), key)
			if valuesEqual(left, right) {
				continue
			}
			if !leftOK {
				return direction > 0
			}
			if !rightOK {
				return direction < 0
			}
			return compareValues(left, right) < 0 == (direction > 0)
		}
		return false
	})
	return out
}

func sortMaps(records []map[string]any, spec map[string]any, order []string) []map[string]any {
	out := append([]map[string]any(nil), records...)
	keys := orderedSpecKeys(spec, order)
	sort.SliceStable(out, func(i int, j int) bool {
		for _, key := range keys {
			directionValue := spec[key]
			direction := intValue(directionValue)
			if direction == 0 {
				direction = 1
			}
			left, leftOK := nestedValue(out[i], key)
			right, rightOK := nestedValue(out[j], key)
			if valuesEqual(left, right) {
				continue
			}
			if !leftOK {
				return direction > 0
			}
			if !rightOK {
				return direction < 0
			}
			return compareValues(left, right) < 0 == (direction > 0)
		}
		return false
	})
	return out
}

func orderedSpecKeys(spec map[string]any, order []string) []string {
	keys := make([]string, 0, len(spec))
	seen := map[string]bool{}
	for _, key := range order {
		if _, ok := spec[key]; ok {
			keys = append(keys, key)
			seen[key] = true
		}
	}
	remaining := make([]string, 0)
	for key := range spec {
		if !seen[key] {
			remaining = append(remaining, key)
		}
	}
	sort.Strings(remaining)
	return append(keys, remaining...)
}

func compareNumber(left any, right any, op string) bool {
	leftNumber, leftOK := floatValue(left)
	rightNumber, rightOK := floatValue(right)
	if !leftOK || !rightOK {
		return false
	}
	switch op {
	case "$gt":
		return leftNumber > rightNumber
	case "$gte":
		return leftNumber >= rightNumber
	case "$lt":
		return leftNumber < rightNumber
	case "$lte":
		return leftNumber <= rightNumber
	default:
		return false
	}
}

func compareValues(left any, right any) int {
	if leftNumber, leftOK := floatValue(left); leftOK {
		if rightNumber, rightOK := floatValue(right); rightOK {
			switch {
			case leftNumber < rightNumber:
				return -1
			case leftNumber > rightNumber:
				return 1
			default:
				return 0
			}
		}
	}
	leftText := stringValue(left)
	rightText := stringValue(right)
	switch {
	case leftText < rightText:
		return -1
	case leftText > rightText:
		return 1
	default:
		return 0
	}
}

func valuesEqual(left any, right any) bool {
	if leftNumber, leftOK := floatValue(left); leftOK {
		if rightNumber, rightOK := floatValue(right); rightOK {
			return leftNumber == rightNumber
		}
	}
	leftJSON, _ := json.Marshal(left)
	rightJSON, _ := json.Marshal(right)
	return string(leftJSON) == string(rightJSON)
}

func matchesAnyValue(options any, docValue any) bool {
	items, ok := arrayItems(options)
	if !ok {
		return false
	}
	for _, item := range items {
		if valuesEqual(item, docValue) {
			return true
		}
		docItems, ok := arrayItems(docValue)
		if !ok {
			continue
		}
		for _, docItem := range docItems {
			if valuesEqual(item, docItem) {
				return true
			}
		}
	}
	return false
}

func arrayItems(value any) ([]any, bool) {
	switch v := value.(type) {
	case []any:
		return append([]any(nil), v...), true
	case []string:
		items := make([]any, 0, len(v))
		for _, item := range v {
			items = append(items, item)
		}
		return items, true
	case []int:
		items := make([]any, 0, len(v))
		for _, item := range v {
			items = append(items, item)
		}
		return items, true
	default:
		return nil, false
	}
}

func boolValue(value any) bool {
	v, _ := value.(bool)
	return v
}

func projectionEnabled(value any) bool {
	if boolValue(value) {
		return true
	}
	return intValue(value) == 1
}

func projectionDisabled(value any) bool {
	if value == nil {
		return false
	}
	if v, ok := value.(bool); ok {
		return !v
	}
	return intValue(value) == 0
}

func isWhole(value float64) bool {
	return value == float64(int(value))
}

var dangerousKeys = map[string]bool{"__proto__": true, "constructor": true, "prototype": true}

func hasDangerousKey(parts []string) bool {
	for _, part := range parts {
		if dangerousKeys[part] {
			return true
		}
	}
	return false
}

func hasOperatorKey(values map[string]any) bool {
	for key := range values {
		if strings.HasPrefix(key, "$") {
			return true
		}
	}
	return false
}

func extractEqualityFields(filter map[string]any) map[string]any {
	out := map[string]any{}
	for key, value := range filter {
		if strings.HasPrefix(key, "$") {
			continue
		}
		if operators, ok := value.(map[string]any); ok && value != nil {
			hasOperator := false
			for op := range operators {
				if strings.HasPrefix(op, "$") {
					hasOperator = true
					break
				}
			}
			if hasOperator {
				continue
			}
		}
		out[key] = cloneValue(value)
	}
	return out
}

func roleRecords(value any) []map[string]any {
	items, ok := value.([]any)
	if !ok {
		return nil
	}
	out := make([]map[string]any, 0, len(items))
	for _, item := range items {
		if role, ok := item.(map[string]any); ok {
			out = append(out, map[string]any{
				"database_name": firstNonEmpty(stringValue(role["databaseName"]), stringValue(role["database_name"])),
				"role_name":     firstNonEmpty(stringValue(role["roleName"]), stringValue(role["role_name"])),
			})
		}
	}
	return out
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}
