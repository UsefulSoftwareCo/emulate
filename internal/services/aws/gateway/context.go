package gateway

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync/atomic"

	"github.com/vercel-labs/emulate/internal/services/aws/auth"
	"github.com/vercel-labs/emulate/internal/services/aws/protocols"
)

const (
	DefaultAccountID = "123456789012"
	DefaultRegion    = "us-east-1"
)

type Options struct {
	DefaultAccountID   string
	DefaultRegion      string
	RequestIDGenerator func() string
	AuthMode           auth.Mode
	CredentialStore    *auth.Store
}

type AwsRequestContext struct {
	RequestID string
	Service   string
	Action    string
	Protocol  protocols.Protocol
	Region    string
	AccountID string

	RawBody []byte
	Query   map[string]string
	Input   map[string]any
	Target  string

	Credentials Credentials
	Principal   Principal
	Auth        auth.Context
	S3          *protocols.S3Route
}

type Credentials struct {
	AccessKeyID string
	Scope       CredentialScope
}

type CredentialScope struct {
	Date     string
	Region   string
	Service  string
	Terminal string
}

type Principal struct {
	AccountID string
	ARN       string
}

type hostDetection struct {
	Service string
	Region  string
}

var requestIDCounter atomic.Uint64

func BuildContext(req *http.Request, rawBody []byte, options Options) (AwsRequestContext, error) {
	options = normalizeOptions(options)
	authContext := auth.Resolve(req, auth.Options{
		Mode:             options.AuthMode,
		Store:            options.CredentialStore,
		DefaultAccountID: options.DefaultAccountID,
	})
	credentials := credentialsFromSignature(authContext.Signature)
	host := detectHost(req.Host)
	pathService := serviceFromPath(req.URL.Path)
	region := firstNonEmpty(credentials.Scope.Region, host.Region, options.DefaultRegion)
	accountID := firstNonEmpty(authContext.AccountID, options.DefaultAccountID)

	ctx := AwsRequestContext{
		RequestID:   options.RequestIDGenerator(),
		Protocol:    protocols.ProtocolUnknown,
		Region:      region,
		AccountID:   accountID,
		RawBody:     append([]byte(nil), rawBody...),
		Query:       map[string]string{},
		Input:       map[string]any{},
		Credentials: credentials,
		Auth:        authContext,
		Principal: Principal{
			AccountID: accountID,
			ARN:       authContext.PrincipalARN,
		},
	}

	if target := req.Header.Get("X-Amz-Target"); target != "" {
		parsed, err := protocols.ParseJSONRPCRequest(target, rawBody)
		if err != nil {
			return AwsRequestContext{}, err
		}
		ctx.Protocol = protocols.ProtocolJSONRPC
		ctx.Target = parsed.Target
		ctx.Service = firstNonEmpty(serviceFromJSONTargetPrefix(parsed.TargetPrefix), host.Service, pathService, credentials.Scope.Service)
		ctx.Action = parsed.Action
		ctx.Input = parsed.Input
		return ctx, nil
	}

	if host.Service == "s3" || pathService == "s3" {
		s3Route, err := protocols.ParseS3RESTRequest(req)
		if err != nil {
			return AwsRequestContext{}, err
		}
		ctx.Protocol = protocols.ProtocolRESTXML
		ctx.Service = "s3"
		ctx.Action = s3Route.Action
		ctx.Query = s3Route.Query
		ctx.Input = s3Input(s3Route)
		ctx.S3 = &s3Route
		return ctx, nil
	}

	queryReq, err := protocols.ParseQueryRequest(req, rawBody)
	if err != nil {
		return AwsRequestContext{}, err
	}
	ctx.Query = queryReq.Parameters
	if queryReq.Action != "" {
		ctx.Protocol = protocols.ProtocolQuery
		ctx.Service = firstNonEmpty(pathService, host.Service, credentials.Scope.Service, serviceFromQueryAction(queryReq.Action, queryReq.Parameters))
		ctx.Action = queryReq.Action
		ctx.Input = queryInput(queryReq.Parameters)
		return ctx, nil
	}

	if shouldParseLambdaREST(req.URL.Path, pathService, host.Service, credentials.Scope.Service) {
		action, input, ok, err := parseLambdaRESTRequest(req, rawBody, queryReq.Parameters)
		if err != nil {
			return AwsRequestContext{}, err
		}
		if ok {
			ctx.Protocol = protocols.ProtocolRESTJSON
			ctx.Service = "lambda"
			ctx.Action = action
			ctx.Input = input
			return ctx, nil
		}
	}

	if shouldParseAPIGatewayV2REST(req.URL.Path, pathService, host.Service, credentials.Scope.Service) {
		action, input, ok, err := parseAPIGatewayV2RESTRequest(req, rawBody, queryReq.Parameters)
		if err != nil {
			return AwsRequestContext{}, err
		}
		if ok {
			ctx.Protocol = protocols.ProtocolRESTJSON
			ctx.Service = "apigatewayv2"
			ctx.Action = action
			ctx.Input = input
			return ctx, nil
		}
	}

	if shouldTreatAsS3(req, host.Service, pathService, credentials.Scope.Service) {
		s3Route, err := protocols.ParseS3RESTRequest(req)
		if err != nil {
			return AwsRequestContext{}, err
		}
		ctx.Protocol = protocols.ProtocolRESTXML
		ctx.Service = "s3"
		ctx.Action = s3Route.Action
		ctx.Query = s3Route.Query
		ctx.Input = s3Input(s3Route)
		ctx.S3 = &s3Route
		return ctx, nil
	}

	ctx.Service = firstNonEmpty(pathService, host.Service, credentials.Scope.Service)
	return ctx, nil
}

func ParseCredentials(req *http.Request) Credentials {
	signature, err := auth.ParseSigV4(req)
	if err != nil || !signature.Present {
		return Credentials{}
	}
	return credentialsFromSignature(signature)
}

func credentialsFromSignature(signature auth.Signature) Credentials {
	if !signature.Present {
		return Credentials{}
	}
	return Credentials{
		AccessKeyID: signature.AccessKeyID,
		Scope: CredentialScope{
			Date:     signature.Scope.Date,
			Region:   signature.Scope.Region,
			Service:  signature.Scope.Service,
			Terminal: signature.Scope.Terminal,
		},
	}
}

func NewRequestID() string {
	var bytes [16]byte
	if _, err := rand.Read(bytes[:]); err == nil {
		return strings.ToUpper(hex.EncodeToString(bytes[:]))
	}
	return fmt.Sprintf("REQ%016X", requestIDCounter.Add(1))
}

func normalizeOptions(options Options) Options {
	if options.DefaultAccountID == "" {
		options.DefaultAccountID = DefaultAccountID
	}
	if options.DefaultRegion == "" {
		options.DefaultRegion = DefaultRegion
	}
	if options.RequestIDGenerator == nil {
		options.RequestIDGenerator = NewRequestID
	}
	return options
}

func queryInput(params map[string]string) map[string]any {
	input := make(map[string]any, len(params))
	for key, value := range params {
		input[key] = value
	}
	return input
}

func s3Input(route protocols.S3Route) map[string]any {
	return map[string]any{
		"bucket":      route.Bucket,
		"copySource":  route.CopySource,
		"key":         route.Key,
		"query":       route.Query,
		"subresource": route.Subresource,
	}
}

func shouldTreatAsS3(req *http.Request, hostService string, pathService string, credentialService string) bool {
	if hostService == "s3" || pathService == "s3" || credentialService == "s3" {
		return true
	}
	if req.URL.Query().Get("Action") != "" || req.Header.Get("X-Amz-Target") != "" {
		return false
	}
	if credentialService != "" {
		return false
	}
	if pathService != "" && isServiceRootPath(req.URL.Path) && !hasS3RequestHint(req) {
		return false
	}
	return hostService == ""
}

func isServiceRootPath(pathValue string) bool {
	trimmed := strings.Trim(pathValue, "/")
	if trimmed == "" {
		return false
	}
	_, rest, _ := strings.Cut(trimmed, "/")
	return rest == ""
}

func hasS3RequestHint(req *http.Request) bool {
	query := req.URL.Query()
	if query.Get("list-type") == "2" {
		return true
	}
	for _, key := range []string{
		"acl",
		"delete",
		"lifecycle",
		"location",
		"notification",
		"policy",
		"tagging",
		"uploadId",
		"uploads",
		"versioning",
		"website",
	} {
		if _, ok := query[key]; ok {
			return true
		}
	}
	return false
}

func detectHost(host string) hostDetection {
	host = normalizeHost(host)
	if host == "" {
		return hostDetection{}
	}
	labels := strings.Split(host, ".")
	for index := len(labels) - 1; index >= 0; index-- {
		label := labels[index]
		if label == "s3" {
			return hostDetection{Service: "s3", Region: regionAfterS3Label(labels, index)}
		}
		if strings.HasPrefix(label, "s3-") {
			return hostDetection{Service: "s3", Region: regionFromDashedS3Label(labels, index)}
		}
	}
	if service := knownHostService(labels[0]); service != "" {
		return hostDetection{Service: service, Region: regionAfterLabel(labels, 0)}
	}
	return hostDetection{}
}

func normalizeHost(host string) string {
	if value, _, err := net.SplitHostPort(host); err == nil {
		host = value
	}
	return strings.TrimSuffix(strings.ToLower(host), ".")
}

func regionAfterLabel(labels []string, index int) string {
	for _, candidate := range labels[index+1:] {
		if candidate == "amazonaws" {
			return ""
		}
		if looksLikeAWSRegion(candidate) {
			return candidate
		}
	}
	return ""
}

func regionAfterS3Label(labels []string, index int) string {
	return firstAWSRegionLabelAfter(labels, index)
}

func regionFromDashedS3Label(labels []string, index int) string {
	region := strings.TrimPrefix(labels[index], "s3-")
	if looksLikeAWSRegion(region) {
		return region
	}
	return firstAWSRegionLabelAfter(labels, index)
}

func firstAWSRegionLabelAfter(labels []string, index int) string {
	for _, label := range labels[index+1:] {
		if label == "amazonaws" {
			return ""
		}
		if looksLikeAWSRegion(label) {
			return label
		}
	}
	return ""
}

func looksLikeAWSRegion(label string) bool {
	parts := strings.Split(label, "-")
	if len(parts) < 3 {
		return false
	}
	last := parts[len(parts)-1]
	if len(last) != 1 || last[0] < '0' || last[0] > '9' {
		return false
	}
	for _, part := range parts[:len(parts)-1] {
		if part == "" {
			return false
		}
		for _, char := range part {
			if char < 'a' || char > 'z' {
				return false
			}
		}
	}
	return true
}

func serviceFromPath(pathValue string) string {
	trimmed := strings.Trim(pathValue, "/")
	if trimmed == "" {
		return ""
	}
	first := strings.Split(trimmed, "/")[0]
	return knownPathService(strings.ToLower(first))
}

func serviceFromQueryAction(action string, params map[string]string) string {
	switch action {
	case "AddPermission", "RemovePermission":
		if params["TopicArn"] != "" {
			return "sns"
		}
		if params["QueueUrl"] != "" {
			return "sqs"
		}
	}
	return queryActionServices[action]
}

func serviceFromJSONTargetPrefix(prefix string) string {
	for marker, service := range jsonTargetServices {
		if strings.HasPrefix(prefix, marker) {
			return service
		}
	}
	return ""
}

func shouldParseLambdaREST(pathValue string, pathService string, hostService string, credentialService string) bool {
	if credentialService == "s3" {
		return false
	}
	if firstNonEmpty(pathService, hostService, credentialService) == "lambda" {
		return true
	}
	return credentialService == "" && hostService == "" && isLambdaRESTPath(pathValue)
}

func shouldParseAPIGatewayV2REST(pathValue string, pathService string, hostService string, credentialService string) bool {
	service := firstNonEmpty(pathService, hostService, credentialService)
	if service == "apigatewayv2" || service == "apigateway" || service == "execute-api" {
		return true
	}
	return isAPIGatewayV2RESTPath(pathValue) || isAPIGatewayV2InvokePath(pathValue)
}

func parseAPIGatewayV2RESTRequest(req *http.Request, rawBody []byte, query map[string]string) (string, map[string]any, bool, error) {
	if isAPIGatewayV2InvokePath(req.URL.Path) {
		return "InvokeRoute", lambdaRESTQueryInput(query), true, nil
	}
	if !isAPIGatewayV2RESTPath(req.URL.Path) {
		return "", nil, false, nil
	}
	input := lambdaRESTQueryInput(query)
	if req.Method == http.MethodPost || req.Method == http.MethodPut || req.Method == http.MethodPatch {
		if len(bytes.TrimSpace(rawBody)) > 0 {
			decoder := json.NewDecoder(bytes.NewReader(rawBody))
			decoder.UseNumber()
			body := map[string]any{}
			if err := decoder.Decode(&body); err != nil {
				return "", nil, false, fmt.Errorf("request body must be a valid JSON object: %w", err)
			}
			for key, value := range body {
				input[key] = value
			}
		}
	}
	return apigatewayV2Action(req), input, true, nil
}

func apigatewayV2Action(req *http.Request) string {
	segments := apigatewayV2Segments(req.URL.Path)
	if len(segments) > 0 && (segments[0] == "apigatewayv2" || segments[0] == "apigateway") {
		segments = segments[1:]
	}
	if len(segments) < 2 || segments[0] != "v2" || segments[1] != "apis" {
		return ""
	}
	if len(segments) == 2 {
		if req.Method == http.MethodPost {
			return "CreateApi"
		}
		if req.Method == http.MethodGet {
			return "GetApis"
		}
	}
	if len(segments) == 3 {
		switch req.Method {
		case http.MethodGet:
			return "GetApi"
		case http.MethodDelete:
			return "DeleteApi"
		}
	}
	if len(segments) >= 4 {
		switch segments[3] {
		case "integrations":
			if len(segments) == 4 {
				if req.Method == http.MethodPost {
					return "CreateIntegration"
				}
				if req.Method == http.MethodGet {
					return "GetIntegrations"
				}
			}
			if len(segments) == 5 {
				if req.Method == http.MethodGet {
					return "GetIntegration"
				}
				if req.Method == http.MethodDelete {
					return "DeleteIntegration"
				}
			}
		case "routes":
			if len(segments) == 4 {
				if req.Method == http.MethodPost {
					return "CreateRoute"
				}
				if req.Method == http.MethodGet {
					return "GetRoutes"
				}
			}
			if len(segments) == 5 {
				if req.Method == http.MethodGet {
					return "GetRoute"
				}
				if req.Method == http.MethodDelete {
					return "DeleteRoute"
				}
			}
		case "stages":
			if len(segments) == 4 {
				if req.Method == http.MethodPost {
					return "CreateStage"
				}
				if req.Method == http.MethodGet {
					return "GetStages"
				}
			}
			if len(segments) == 5 {
				if req.Method == http.MethodGet {
					return "GetStage"
				}
				if req.Method == http.MethodDelete {
					return "DeleteStage"
				}
			}
		}
	}
	return ""
}

func isAPIGatewayV2RESTPath(pathValue string) bool {
	segments := apigatewayV2Segments(pathValue)
	if len(segments) > 0 && (segments[0] == "apigatewayv2" || segments[0] == "apigateway") {
		segments = segments[1:]
	}
	return len(segments) >= 2 && segments[0] == "v2" && segments[1] == "apis"
}

func isAPIGatewayV2InvokePath(pathValue string) bool {
	segments := apigatewayV2Segments(pathValue)
	return len(segments) >= 3 && segments[0] == "_aws" && segments[1] == "apigatewayv2"
}

func apigatewayV2Segments(pathValue string) []string {
	trimmed := strings.Trim(pathValue, "/")
	if trimmed == "" {
		return nil
	}
	parts := strings.Split(trimmed, "/")
	out := make([]string, 0, len(parts))
	for _, part := range parts {
		if part != "" {
			decoded, err := url.PathUnescape(part)
			if err != nil {
				decoded = part
			}
			out = append(out, decoded)
		}
	}
	return out
}

func parseLambdaRESTRequest(req *http.Request, rawBody []byte, query map[string]string) (string, map[string]any, bool, error) {
	segments := lambdaRESTSegments(req.URL.Path)
	if len(segments) > 0 && strings.EqualFold(segments[0], "lambda") {
		segments = segments[1:]
	}
	if len(segments) < 2 {
		return "", nil, false, nil
	}
	if segments[0] == "2017-03-31" && len(segments) >= 3 && segments[1] == "tags" {
		input := lambdaRESTQueryInput(query)
		if req.Method == http.MethodPost {
			var err error
			input, err = lambdaRESTInput(rawBody, query)
			if err != nil {
				return "", nil, false, err
			}
		}
		resource := decodeLambdaSegment(strings.Join(segments[2:], "/"))
		input["Resource"] = resource
		switch req.Method {
		case http.MethodGet:
			return "ListTags", input, true, nil
		case http.MethodPost:
			return "TagResource", input, true, nil
		case http.MethodDelete:
			return "UntagResource", input, true, nil
		}
		return "", nil, false, nil
	}
	if segments[0] != "2015-03-31" || segments[1] != "functions" {
		return "", nil, false, nil
	}
	if len(segments) == 2 {
		switch req.Method {
		case http.MethodGet:
			return "ListFunctions", lambdaRESTQueryInput(query), true, nil
		case http.MethodPost:
			input, err := lambdaRESTInput(rawBody, query)
			if err != nil {
				return "", nil, false, err
			}
			return "CreateFunction", input, true, nil
		}
		return "", nil, false, nil
	}
	functionName := decodeLambdaSegment(segments[2])
	addFunctionContext := func(input map[string]any) map[string]any {
		input["FunctionName"] = functionName
		if qualifier := req.URL.Query().Get("Qualifier"); qualifier != "" {
			input["Qualifier"] = qualifier
		}
		return input
	}
	if len(segments) == 3 {
		switch req.Method {
		case http.MethodGet:
			return "GetFunction", addFunctionContext(lambdaRESTQueryInput(query)), true, nil
		case http.MethodDelete:
			return "DeleteFunction", addFunctionContext(lambdaRESTQueryInput(query)), true, nil
		}
		return "", nil, false, nil
	}
	switch segments[3] {
	case "configuration":
		switch req.Method {
		case http.MethodGet:
			return "GetFunctionConfiguration", addFunctionContext(lambdaRESTQueryInput(query)), true, nil
		case http.MethodPut:
			input, err := lambdaRESTInput(rawBody, query)
			if err != nil {
				return "", nil, false, err
			}
			return "UpdateFunctionConfiguration", addFunctionContext(input), true, nil
		}
	case "code":
		if req.Method == http.MethodPut {
			input, err := lambdaRESTInput(rawBody, query)
			if err != nil {
				return "", nil, false, err
			}
			return "UpdateFunctionCode", addFunctionContext(input), true, nil
		}
	case "invocations":
		if req.Method == http.MethodPost {
			return "Invoke", addFunctionContext(lambdaRESTQueryInput(query)), true, nil
		}
	case "versions":
		if len(segments) == 4 {
			if req.Method == http.MethodGet {
				return "ListVersionsByFunction", addFunctionContext(lambdaRESTQueryInput(query)), true, nil
			}
			if req.Method == http.MethodPost {
				input, err := lambdaRESTInput(rawBody, query)
				if err != nil {
					return "", nil, false, err
				}
				return "PublishVersion", addFunctionContext(input), true, nil
			}
		}
		if len(segments) == 5 && req.Method == http.MethodGet {
			input := addFunctionContext(lambdaRESTQueryInput(query))
			input["Qualifier"] = decodeLambdaSegment(segments[4])
			return "GetFunction", input, true, nil
		}
	case "aliases":
		if len(segments) == 4 {
			if req.Method == http.MethodGet {
				return "ListAliases", addFunctionContext(lambdaRESTQueryInput(query)), true, nil
			}
			if req.Method == http.MethodPost {
				input, err := lambdaRESTInput(rawBody, query)
				if err != nil {
					return "", nil, false, err
				}
				return "CreateAlias", addFunctionContext(input), true, nil
			}
		}
		if len(segments) == 5 {
			input := lambdaRESTQueryInput(query)
			if req.Method == http.MethodPut {
				var err error
				input, err = lambdaRESTInput(rawBody, query)
				if err != nil {
					return "", nil, false, err
				}
			}
			input = addFunctionContext(input)
			input["Name"] = decodeLambdaSegment(segments[4])
			switch req.Method {
			case http.MethodGet:
				return "GetAlias", input, true, nil
			case http.MethodPut:
				return "UpdateAlias", input, true, nil
			case http.MethodDelete:
				return "DeleteAlias", input, true, nil
			}
		}
	case "policy":
		if len(segments) == 4 {
			if req.Method == http.MethodGet {
				return "GetPolicy", addFunctionContext(lambdaRESTQueryInput(query)), true, nil
			}
			if req.Method == http.MethodPost {
				input, err := lambdaRESTInput(rawBody, query)
				if err != nil {
					return "", nil, false, err
				}
				return "AddPermission", addFunctionContext(input), true, nil
			}
		}
		if len(segments) == 5 && req.Method == http.MethodDelete {
			input := addFunctionContext(lambdaRESTQueryInput(query))
			input["StatementId"] = decodeLambdaSegment(segments[4])
			return "RemovePermission", input, true, nil
		}
	}
	return "", nil, false, nil
}

func lambdaRESTQueryInput(query map[string]string) map[string]any {
	input := make(map[string]any, len(query))
	for key, value := range query {
		input[key] = value
	}
	return input
}

func lambdaRESTInput(rawBody []byte, query map[string]string) (map[string]any, error) {
	input := lambdaRESTQueryInput(query)
	if len(bytes.TrimSpace(rawBody)) == 0 {
		return input, nil
	}
	decoder := json.NewDecoder(bytes.NewReader(rawBody))
	decoder.UseNumber()
	body := map[string]any{}
	if err := decoder.Decode(&body); err != nil {
		return nil, fmt.Errorf("request body must be a valid JSON object: %w", err)
	}
	for key, value := range body {
		input[key] = value
	}
	return input, nil
}

func isLambdaRESTPath(pathValue string) bool {
	segments := lambdaRESTSegments(pathValue)
	if len(segments) > 0 && strings.EqualFold(segments[0], "lambda") {
		segments = segments[1:]
	}
	if len(segments) < 2 {
		return false
	}
	if segments[0] == "2015-03-31" && segments[1] == "functions" {
		return true
	}
	return segments[0] == "2017-03-31" && segments[1] == "tags"
}

func lambdaRESTSegments(pathValue string) []string {
	trimmed := strings.Trim(pathValue, "/")
	if trimmed == "" {
		return nil
	}
	parts := strings.Split(trimmed, "/")
	out := make([]string, 0, len(parts))
	for _, part := range parts {
		if part != "" {
			out = append(out, part)
		}
	}
	return out
}

func decodeLambdaSegment(value string) string {
	decoded, err := url.PathUnescape(value)
	if err != nil {
		return value
	}
	return decoded
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}

func knownHostService(label string) string {
	return knownServices[label]
}

func knownPathService(label string) string {
	return knownServices[label]
}

var knownServices = map[string]string{
	"apigateway":     "apigatewayv2",
	"apigatewayv2":   "apigatewayv2",
	"cloudformation": "cloudformation",
	"dynamodb":       "dynamodb",
	"events":         "events",
	"iam":            "iam",
	"kms":            "kms",
	"lambda":         "lambda",
	"logs":           "logs",
	"s3":             "s3",
	"secretsmanager": "secretsmanager",
	"sns":            "sns",
	"sqs":            "sqs",
	"ssm":            "ssm",
	"states":         "states",
	"sts":            "sts",
}

var queryActionServices = map[string]string{
	"AddPermission":                "sqs",
	"AttachRolePolicy":             "iam",
	"AttachUserPolicy":             "iam",
	"AssumeRole":                   "sts",
	"ChangeMessageVisibility":      "sqs",
	"ChangeMessageVisibilityBatch": "sqs",
	"CreateAccessKey":              "iam",
	"CreatePolicy":                 "iam",
	"CreateQueue":                  "sqs",
	"CreateRole":                   "iam",
	"CreateUser":                   "iam",
	"CreateTopic":                  "sns",
	"DeleteAccessKey":              "iam",
	"DeleteMessage":                "sqs",
	"DeleteMessageBatch":           "sqs",
	"DeletePolicy":                 "iam",
	"DeleteQueue":                  "sqs",
	"DeleteRole":                   "iam",
	"DeleteRolePolicy":             "iam",
	"DeleteTopic":                  "sns",
	"DeleteUser":                   "iam",
	"DeleteUserPolicy":             "iam",
	"DetachRolePolicy":             "iam",
	"DetachUserPolicy":             "iam",
	"ConfirmSubscription":          "sns",
	"GetCallerIdentity":            "sts",
	"GetPolicy":                    "iam",
	"GetPolicyVersion":             "iam",
	"GetQueueAttributes":           "sqs",
	"GetQueueUrl":                  "sqs",
	"GetRole":                      "iam",
	"GetRolePolicy":                "iam",
	"GetTopicAttributes":           "sns",
	"GetUser":                      "iam",
	"GetUserPolicy":                "iam",
	"ListAccessKeys":               "iam",
	"ListAttachedRolePolicies":     "iam",
	"ListAttachedUserPolicies":     "iam",
	"ListPolicies":                 "iam",
	"ListQueueTags":                "sqs",
	"ListQueues":                   "sqs",
	"ListRoles":                    "iam",
	"ListRolePolicies":             "iam",
	"ListSubscriptions":            "sns",
	"ListSubscriptionsByTopic":     "sns",
	"ListTagsForResource":          "sns",
	"ListTopics":                   "sns",
	"ListUsers":                    "iam",
	"ListUserPolicies":             "iam",
	"Publish":                      "sns",
	"PutRolePolicy":                "iam",
	"PutUserPolicy":                "iam",
	"PurgeQueue":                   "sqs",
	"ReceiveMessage":               "sqs",
	"SendMessage":                  "sqs",
	"SendMessageBatch":             "sqs",
	"SetQueueAttributes":           "sqs",
	"SetTopicAttributes":           "sns",
	"Subscribe":                    "sns",
	"TagQueue":                     "sqs",
	"TagResource":                  "sns",
	"Unsubscribe":                  "sns",
	"UntagQueue":                   "sqs",
	"UntagResource":                "sns",
}

var jsonTargetServices = map[string]string{
	"AmazonCloudWatchLogs": "logs",
	"AmazonSQS":            "sqs",
	"DynamoDB":             "dynamodb",
	"Lambda":               "lambda",
	"AWSEvents":            "events",
	"SecretsManager":       "secretsmanager",
	"Logs_20140328":        "logs",
	"secretsmanager":       "secretsmanager",
	"AmazonSSM":            "ssm",
	"TrentService":         "kms",
	"AWSStepFunctions":     "states",
}
