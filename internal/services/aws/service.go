package aws

import (
	"net/http"
	"strings"

	corehttp "github.com/vercel-labs/emulate/internal/core/http"
	corestore "github.com/vercel-labs/emulate/internal/core/store"
	"github.com/vercel-labs/emulate/internal/services/aws/auth"
	"github.com/vercel-labs/emulate/internal/services/aws/gateway"
)

type Options struct {
	Store            *corestore.Store
	DefaultAccountID string
	DefaultRegion    string
	AuthMode         auth.Mode
	CredentialStore  *auth.Store
}

type Service struct {
	store            Store
	defaultAccountID string
	defaultRegion    string
	authMode         auth.Mode
	credentialStore  *auth.Store
}

func Register(router *corehttp.Router, options Options) {
	service := New(options)
	router.Get("/_inspector", service.handleInspector)
	router.Fallback(service.handleAWS)
}

func New(options Options) *Service {
	runtimeStore := options.Store
	if runtimeStore == nil {
		runtimeStore = corestore.New()
	}
	defaultAccountID := options.DefaultAccountID
	if defaultAccountID == "" {
		defaultAccountID = gateway.DefaultAccountID
	}
	defaultRegion := options.DefaultRegion
	if defaultRegion == "" {
		defaultRegion = gateway.DefaultRegion
	}
	return &Service{
		store:            NewStore(runtimeStore),
		defaultAccountID: defaultAccountID,
		defaultRegion:    defaultRegion,
		authMode:         options.AuthMode,
		credentialStore:  options.CredentialStore,
	}
}

func (s *Service) handleAWS(c *corehttp.Context) {
	if !looksLikeAWSRequest(c.Request) {
		c.JSON(http.StatusNotFound, map[string]any{"message": "Not Found"})
		return
	}

	rawBody, err := readRequestBody(c.Request)
	if err != nil {
		c.JSON(http.StatusBadRequest, map[string]any{"message": "Failed to read request body"})
		return
	}

	ctx, err := gateway.BuildContext(c.Request, rawBody, gateway.Options{
		DefaultAccountID: s.defaultAccountID,
		DefaultRegion:    s.defaultRegion,
		AuthMode:         s.authMode,
		CredentialStore:  s.credentialStore,
	})
	if err != nil {
		s.writeParseError(c, err)
		return
	}
	if ctx.Auth.Error != nil {
		s.writeAWSError(c, ctx, awsAuthError(ctx))
		return
	}

	s.writeAWSError(c, ctx, notImplementedError(ctx))
}

func looksLikeAWSRequest(req *http.Request) bool {
	if req.URL.Query().Get("Action") != "" || req.URL.Query().Get("X-Amz-Algorithm") != "" {
		return true
	}
	if req.Header.Get("X-Amz-Target") != "" || req.Header.Get("X-Amz-Date") != "" || req.Header.Get("X-Amz-Content-Sha256") != "" {
		return true
	}
	if strings.HasPrefix(req.Header.Get("Authorization"), "AWS4-HMAC-SHA256") {
		return true
	}
	host := strings.ToLower(req.Host)
	if strings.Contains(host, "amazonaws.com") || hasKnownServiceLabel(host) {
		return true
	}
	return hasKnownServicePath(req.URL.Path)
}

func hasKnownServicePath(pathValue string) bool {
	first := firstPathSegment(pathValue)
	switch first {
	case "cloudformation", "dynamodb", "events", "iam", "kms", "lambda", "logs", "s3", "secretsmanager", "sns", "sqs", "ssm", "states", "sts":
		return true
	default:
		return false
	}
}

func hasKnownServiceLabel(host string) bool {
	label := strings.Split(strings.TrimSuffix(host, "."), ".")[0]
	switch label {
	case "cloudformation", "dynamodb", "events", "iam", "kms", "lambda", "logs", "s3", "secretsmanager", "sns", "sqs", "ssm", "states", "sts":
		return true
	default:
		return false
	}
}

func firstPathSegment(pathValue string) string {
	trimmed := strings.Trim(pathValue, "/")
	if trimmed == "" {
		return ""
	}
	return strings.ToLower(strings.Split(trimmed, "/")[0])
}
