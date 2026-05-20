package dynamodb

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"math/big"
	"sort"
	"strconv"
	"strings"

	corestore "github.com/vercel-labs/emulate/internal/core/store"
)

type keyParts struct {
	Partition string
	Sort      string
	Key       map[string]any
}

func normalizeItem(raw any) (map[string]any, error) {
	values, ok := asMap(raw)
	if !ok || len(values) == 0 {
		return nil, fmt.Errorf("item must be a non-empty map")
	}
	item := make(map[string]any, len(values))
	for name, value := range values {
		normalized, err := normalizeAttributeValue(value)
		if err != nil {
			return nil, fmt.Errorf("attribute %s: %w", name, err)
		}
		item[name] = normalized
	}
	return item, nil
}

func normalizeKey(table corestore.Record, raw any) (keyParts, error) {
	values, err := normalizeItem(raw)
	if err != nil {
		return keyParts{}, fmt.Errorf("key must be a map")
	}
	return keyPartsFromValues(table, values)
}

func keyPartsFromValues(table corestore.Record, values map[string]any) (keyParts, error) {
	partitionName, sortName := keyAttributeNames(table)
	if partitionName == "" {
		return keyParts{}, fmt.Errorf("table has no partition key")
	}
	partitionValue, ok := values[partitionName]
	if !ok {
		return keyParts{}, fmt.Errorf("missing partition key %s", partitionName)
	}
	key := map[string]any{partitionName: partitionValue}
	parts := keyParts{Partition: attributeIdentity(partitionValue), Key: key}
	if sortName != "" {
		sortValue, ok := values[sortName]
		if !ok {
			return keyParts{}, fmt.Errorf("missing sort key %s", sortName)
		}
		key[sortName] = sortValue
		parts.Sort = attributeIdentity(sortValue)
	}
	return parts, nil
}

func normalizeAttributeValue(raw any) (map[string]any, error) {
	values, ok := asMap(raw)
	if !ok || len(values) == 0 {
		return nil, fmt.Errorf("attribute value must be an AttributeValue object")
	}
	out := map[string]any{}
	for kind, value := range values {
		switch kind {
		case "S":
			out[kind] = scalarString(value)
		case "N":
			number := strings.TrimSpace(scalarString(value))
			if _, err := numberRat(number); err != nil {
				return nil, fmt.Errorf("invalid number %q", number)
			}
			out[kind] = number
		case "B":
			encoded := scalarString(value)
			if encoded != "" {
				if _, err := base64.StdEncoding.DecodeString(encoded); err != nil {
					return nil, fmt.Errorf("invalid binary value")
				}
			}
			out[kind] = encoded
		case "BOOL":
			boolean, ok := value.(bool)
			if !ok {
				return nil, fmt.Errorf("BOOL must be boolean")
			}
			out[kind] = boolean
		case "NULL":
			boolean, ok := value.(bool)
			if !ok {
				return nil, fmt.Errorf("NULL must be boolean")
			}
			out[kind] = boolean
		case "SS", "NS", "BS":
			list, err := stringList(value)
			if err != nil {
				return nil, fmt.Errorf("%s must be a string list", kind)
			}
			if kind == "NS" {
				for _, number := range list {
					if _, err := numberRat(number); err != nil {
						return nil, fmt.Errorf("invalid number %q", number)
					}
				}
			}
			if kind == "BS" {
				for _, encoded := range list {
					if encoded != "" {
						if _, err := base64.StdEncoding.DecodeString(encoded); err != nil {
							return nil, fmt.Errorf("invalid binary value")
						}
					}
				}
			}
			out[kind] = list
		case "L":
			values, ok := value.([]any)
			if !ok {
				return nil, fmt.Errorf("L must be a list")
			}
			items := make([]any, 0, len(values))
			for _, nested := range values {
				normalized, err := normalizeAttributeValue(nested)
				if err != nil {
					return nil, err
				}
				items = append(items, normalized)
			}
			out[kind] = items
		case "M":
			values, ok := asMap(value)
			if !ok {
				return nil, fmt.Errorf("M must be a map")
			}
			nested := make(map[string]any, len(values))
			for name, nestedValue := range values {
				normalized, err := normalizeAttributeValue(nestedValue)
				if err != nil {
					return nil, fmt.Errorf("attribute %s: %w", name, err)
				}
				nested[name] = normalized
			}
			out[kind] = nested
		default:
			return nil, fmt.Errorf("unsupported AttributeValue member %s", kind)
		}
	}
	if len(out) != 1 {
		return nil, fmt.Errorf("attribute value must contain exactly one member")
	}
	return out, nil
}

func keyAttributeNames(table corestore.Record) (string, string) {
	var partitionName, sortName string
	for _, item := range recordList(table["key_schema"]) {
		switch strings.ToUpper(stringRecordField(item, "KeyType")) {
		case "HASH":
			partitionName = stringRecordField(item, "AttributeName")
		case "RANGE":
			sortName = stringRecordField(item, "AttributeName")
		}
	}
	return partitionName, sortName
}

func keyAttributeTypes(table corestore.Record) map[string]string {
	types := map[string]string{}
	for _, item := range recordList(table["attribute_definitions"]) {
		name := stringRecordField(item, "AttributeName")
		if name != "" {
			types[name] = strings.ToUpper(stringRecordField(item, "AttributeType"))
		}
	}
	return types
}

func attributeIdentity(value any) string {
	normalized, err := normalizeAttributeValue(value)
	if err != nil {
		return fmt.Sprint(value)
	}
	if number, ok := normalized["N"].(string); ok {
		if canonical, err := canonicalNumber(number); err == nil {
			return "N:" + canonical
		}
	}
	raw, _ := json.Marshal(normalized)
	return string(raw)
}

func sameAttributeValue(left any, right any) bool {
	leftID := attributeIdentity(left)
	rightID := attributeIdentity(right)
	return leftID == rightID
}

func compareKeyAttribute(left any, right any, attributeType string) int {
	leftValue, err := normalizeAttributeValue(left)
	if err != nil {
		return strings.Compare(fmt.Sprint(left), fmt.Sprint(right))
	}
	rightValue, err := normalizeAttributeValue(right)
	if err != nil {
		return strings.Compare(fmt.Sprint(left), fmt.Sprint(right))
	}
	switch strings.ToUpper(attributeType) {
	case "N":
		leftNumber, leftOK := leftValue["N"].(string)
		rightNumber, rightOK := rightValue["N"].(string)
		if leftOK && rightOK {
			leftRat, leftErr := numberRat(leftNumber)
			rightRat, rightErr := numberRat(rightNumber)
			if leftErr == nil && rightErr == nil {
				return leftRat.Cmp(rightRat)
			}
		}
	case "B":
		leftEncoded, leftOK := leftValue["B"].(string)
		rightEncoded, rightOK := rightValue["B"].(string)
		if leftOK && rightOK {
			leftBytes, leftErr := base64.StdEncoding.DecodeString(leftEncoded)
			rightBytes, rightErr := base64.StdEncoding.DecodeString(rightEncoded)
			if leftErr == nil && rightErr == nil {
				return strings.Compare(string(leftBytes), string(rightBytes))
			}
		}
	case "S":
		leftString, leftOK := leftValue["S"].(string)
		rightString, rightOK := rightValue["S"].(string)
		if leftOK && rightOK {
			return strings.Compare(leftString, rightString)
		}
	}
	return strings.Compare(attributeIdentity(leftValue), attributeIdentity(rightValue))
}

func canonicalNumber(raw string) (string, error) {
	rat, err := numberRat(raw)
	if err != nil {
		return "", err
	}
	return rat.RatString(), nil
}

func numberRat(raw string) (*big.Rat, error) {
	value := strings.TrimSpace(raw)
	if value == "" {
		return nil, fmt.Errorf("empty number")
	}
	sign := 1
	if strings.HasPrefix(value, "+") || strings.HasPrefix(value, "-") {
		if value[0] == '-' {
			sign = -1
		}
		value = value[1:]
	}
	mantissa := value
	exponent := 0
	if index := strings.IndexAny(value, "eE"); index >= 0 {
		mantissa = value[:index]
		rawExponent := value[index+1:]
		if rawExponent == "" {
			return nil, fmt.Errorf("missing exponent")
		}
		parsed, err := strconv.Atoi(rawExponent)
		if err != nil {
			return nil, fmt.Errorf("invalid exponent")
		}
		exponent = parsed
	}
	digits := strings.Builder{}
	fractionalDigits := 0
	sawDigit := false
	sawDecimal := false
	for _, char := range mantissa {
		switch {
		case char >= '0' && char <= '9':
			digits.WriteRune(char)
			sawDigit = true
			if sawDecimal {
				fractionalDigits++
			}
		case char == '.':
			if sawDecimal {
				return nil, fmt.Errorf("multiple decimal points")
			}
			sawDecimal = true
		default:
			return nil, fmt.Errorf("invalid number")
		}
	}
	if !sawDigit {
		return nil, fmt.Errorf("missing digits")
	}
	digitString := strings.TrimLeft(digits.String(), "0")
	if digitString == "" {
		return big.NewRat(0, 1), nil
	}
	numerator := new(big.Int)
	numerator.SetString(digitString, 10)
	if sign < 0 {
		numerator.Neg(numerator)
	}
	scale := fractionalDigits - exponent
	if scale <= 0 {
		multiplier := new(big.Int).Exp(big.NewInt(10), big.NewInt(int64(-scale)), nil)
		numerator.Mul(numerator, multiplier)
		return new(big.Rat).SetInt(numerator), nil
	}
	denominator := new(big.Int).Exp(big.NewInt(10), big.NewInt(int64(scale)), nil)
	return new(big.Rat).SetFrac(numerator, denominator), nil
}

func cloneAttributeMap(input map[string]any) map[string]any {
	out := make(map[string]any, len(input))
	for key, value := range input {
		out[key] = cloneValue(value)
	}
	return out
}

func projectItem(item map[string]any, input map[string]any) map[string]any {
	projection := strings.TrimSpace(stringInput(input, "ProjectionExpression"))
	if projection == "" {
		return cloneAttributeMap(item)
	}
	names := expressionAttributeNames(input)
	out := map[string]any{}
	for _, token := range strings.Split(projection, ",") {
		name := resolveExpressionName(strings.TrimSpace(token), names)
		if name == "" {
			continue
		}
		if value, ok := item[name]; ok {
			out[name] = cloneValue(value)
		}
	}
	return out
}

func expressionAttributeNames(input map[string]any) map[string]string {
	raw, ok := asMap(input["ExpressionAttributeNames"])
	if !ok {
		return nil
	}
	names := map[string]string{}
	for key, value := range raw {
		names[key] = scalarString(value)
	}
	return names
}

func expressionAttributeValues(input map[string]any) (map[string]any, error) {
	raw, ok := asMap(input["ExpressionAttributeValues"])
	if !ok {
		return map[string]any{}, nil
	}
	values := map[string]any{}
	for key, value := range raw {
		normalized, err := normalizeAttributeValue(value)
		if err != nil {
			return nil, fmt.Errorf("expression value %s: %w", key, err)
		}
		values[key] = normalized
	}
	return values, nil
}

func resolveExpressionName(token string, names map[string]string) string {
	token = strings.TrimSpace(token)
	if strings.HasPrefix(token, "#") {
		if resolved := names[token]; resolved != "" {
			return resolved
		}
	}
	return token
}

func stringList(raw any) ([]string, error) {
	values, ok := raw.([]any)
	if !ok {
		return nil, fmt.Errorf("not a list")
	}
	out := make([]string, 0, len(values))
	for _, value := range values {
		out = append(out, scalarString(value))
	}
	return out, nil
}

func asMap(raw any) (map[string]any, bool) {
	switch value := raw.(type) {
	case map[string]any:
		return value, true
	case corestore.Record:
		out := map[string]any{}
		for key, nested := range value {
			out[key] = nested
		}
		return out, true
	default:
		return nil, false
	}
}

func recordList(raw any) []corestore.Record {
	switch values := raw.(type) {
	case []corestore.Record:
		return values
	case []map[string]any:
		out := make([]corestore.Record, 0, len(values))
		for _, value := range values {
			out = append(out, corestore.Record(value))
		}
		return out
	case []any:
		out := make([]corestore.Record, 0, len(values))
		for _, value := range values {
			if mapped, ok := asMap(value); ok {
				out = append(out, corestore.Record(mapped))
			}
		}
		return out
	default:
		return nil
	}
}

func normalizeRecordList(raw any, requiredFields ...string) ([]corestore.Record, error) {
	values, ok := raw.([]any)
	if !ok {
		return nil, fmt.Errorf("must be a list")
	}
	out := make([]corestore.Record, 0, len(values))
	for _, value := range values {
		mapped, ok := asMap(value)
		if !ok {
			return nil, fmt.Errorf("must contain objects")
		}
		record := corestore.Record{}
		for key, nested := range mapped {
			record[key] = cloneValue(nested)
		}
		for _, field := range requiredFields {
			if scalarString(record[field]) == "" {
				return nil, fmt.Errorf("missing %s", field)
			}
		}
		out = append(out, record)
	}
	return out, nil
}

func cloneValue(value any) any {
	switch value := value.(type) {
	case map[string]any:
		out := make(map[string]any, len(value))
		for key, nested := range value {
			out[key] = cloneValue(nested)
		}
		return out
	case corestore.Record:
		out := make(map[string]any, len(value))
		for key, nested := range value {
			out[key] = cloneValue(nested)
		}
		return out
	case []any:
		out := make([]any, len(value))
		for index, nested := range value {
			out[index] = cloneValue(nested)
		}
		return out
	case []string:
		return append([]string(nil), value...)
	case []corestore.Record:
		out := make([]corestore.Record, len(value))
		for index, nested := range value {
			out[index] = corestore.Record(cloneValue(nested).(map[string]any))
		}
		return out
	default:
		return value
	}
}

func scalarString(value any) string {
	switch value := value.(type) {
	case string:
		return value
	case json.Number:
		return value.String()
	case float64:
		return strconv.FormatFloat(value, 'f', -1, 64)
	case float32:
		return strconv.FormatFloat(float64(value), 'f', -1, 32)
	case int:
		return strconv.Itoa(value)
	case int64:
		return strconv.FormatInt(value, 10)
	case bool:
		return strconv.FormatBool(value)
	default:
		if value == nil {
			return ""
		}
		return fmt.Sprint(value)
	}
}

func sortedRecordNames(records []corestore.Record, field string) []string {
	names := make([]string, 0, len(records))
	for _, record := range records {
		names = append(names, stringRecordField(record, field))
	}
	sort.Strings(names)
	return names
}

func stringRecordField(record corestore.Record, name string) string {
	value, _ := record[name].(string)
	return value
}
