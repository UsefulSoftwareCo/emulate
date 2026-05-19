package iam

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"sync/atomic"
	"time"

	corestore "github.com/vercel-labs/emulate/internal/core/store"
	"github.com/vercel-labs/emulate/internal/services/aws/auth"
	"github.com/vercel-labs/emulate/internal/services/aws/gateway"
	"github.com/vercel-labs/emulate/internal/services/aws/protocols"
)

type Handler struct {
	Users           *corestore.Collection
	Roles           *corestore.Collection
	CredentialStore *auth.Store
	AccountID       string
	Now             func() time.Time
	IDGenerator     func(string) string
	SecretGenerator func(int) string
}

var fallbackIDCounter atomic.Uint64

func (h *Handler) Handle(_ *http.Request, ctx gateway.AwsRequestContext) protocols.ErrorResponse {
	requestID := ctx.RequestID
	if requestID == "" {
		requestID = h.generateID("req")
	}
	var response protocols.ErrorResponse
	switch ctx.Action {
	case "CreateUser":
		response = h.createUser(ctx.Query, requestID)
	case "GetUser":
		response = h.getUser(ctx.Query, requestID)
	case "DeleteUser":
		response = h.deleteUser(ctx.Query, requestID)
	case "ListUsers":
		response = h.listUsers(requestID)
	case "CreateAccessKey":
		response = h.createAccessKey(ctx.Query, requestID)
	case "ListAccessKeys":
		response = h.listAccessKeys(ctx.Query, requestID)
	case "DeleteAccessKey":
		response = h.deleteAccessKey(ctx.Query, requestID)
	case "CreateRole":
		response = h.createRole(ctx.Query, requestID)
	case "GetRole":
		response = h.getRole(ctx.Query, requestID)
	case "DeleteRole":
		response = h.deleteRole(ctx.Query, requestID)
	case "ListRoles":
		response = h.listRoles(requestID)
	default:
		action := ctx.Action
		response = h.queryError("InvalidAction", "The action "+action+" is not valid for this endpoint.", http.StatusBadRequest, requestID)
	}
	return withRequestID(response, requestID)
}

func (h *Handler) createUser(params map[string]string, requestID string) protocols.ErrorResponse {
	userName := params["UserName"]
	if userName == "" {
		return h.queryError("ValidationError", "The request must contain the parameter UserName.", http.StatusBadRequest, requestID)
	}
	if _, ok := h.findUser(userName); ok {
		return h.queryError("EntityAlreadyExists", "User with name "+userName+" already exists.", http.StatusConflict, requestID)
	}
	path := params["Path"]
	if path == "" {
		path = "/"
	}
	user := h.Users.Insert(corestore.Record{
		"user_name":   userName,
		"user_id":     h.generateID("AIDA"),
		"arn":         "arn:aws:iam::" + h.accountID() + ":user" + path + userName,
		"path":        path,
		"access_keys": []corestore.Record{},
	})
	return h.userResponse("CreateUser", user, requestID)
}

func (h *Handler) getUser(params map[string]string, requestID string) protocols.ErrorResponse {
	userName := params["UserName"]
	user, ok := h.findUser(userName)
	if !ok {
		return h.noSuchUser(userName, requestID)
	}
	return h.userResponse("GetUser", user, requestID)
}

func (h *Handler) deleteUser(params map[string]string, requestID string) protocols.ErrorResponse {
	userName := params["UserName"]
	user, ok := h.findUser(userName)
	if !ok {
		return h.noSuchUser(userName, requestID)
	}
	for _, key := range accessKeys(user) {
		h.CredentialStore.Delete(stringField(key, "access_key_id"))
	}
	h.Users.Delete(intField(user, "id"))
	body := `<?xml version="1.0" encoding="UTF-8"?>
<DeleteUserResponse>
  <ResponseMetadata><RequestId>` + xmlEscape(requestID) + `</RequestId></ResponseMetadata>
</DeleteUserResponse>`
	return xmlResponse(http.StatusOK, body)
}

func (h *Handler) listUsers(requestID string) protocols.ErrorResponse {
	var rows strings.Builder
	for _, user := range h.Users.All() {
		rows.WriteString(`      <member>
`)
		writeUserXML(&rows, user)
		rows.WriteString(`      </member>
`)
	}
	body := `<?xml version="1.0" encoding="UTF-8"?>
<ListUsersResponse>
  <ListUsersResult>
    <IsTruncated>false</IsTruncated>
    <Users>
` + strings.TrimRight(rows.String(), "\n") + `
    </Users>
  </ListUsersResult>
  <ResponseMetadata><RequestId>` + xmlEscape(requestID) + `</RequestId></ResponseMetadata>
</ListUsersResponse>`
	return xmlResponse(http.StatusOK, body)
}

func (h *Handler) createAccessKey(params map[string]string, requestID string) protocols.ErrorResponse {
	userName := params["UserName"]
	user, ok := h.findUser(userName)
	if !ok {
		return h.noSuchUser(userName, requestID)
	}
	accessKeyID := "AKIA" + h.generateID("")[0:16]
	secretAccessKey := h.generateSecret(30)
	key := corestore.Record{
		"access_key_id":     accessKeyID,
		"secret_access_key": secretAccessKey,
		"status":            "Active",
	}
	keys := append(accessKeys(user), key)
	updated, _ := h.Users.Update(intField(user, "id"), corestore.Record{"access_keys": keys})
	h.CredentialStore.Put(auth.Credential{
		AccessKeyID:     accessKeyID,
		SecretAccessKey: secretAccessKey,
		AccountID:       h.accountID(),
		PrincipalARN:    stringField(updated, "arn"),
	})
	body := `<?xml version="1.0" encoding="UTF-8"?>
<CreateAccessKeyResponse>
  <CreateAccessKeyResult>
    <AccessKey>
      <UserName>` + xmlEscape(userName) + `</UserName>
      <AccessKeyId>` + accessKeyID + `</AccessKeyId>
      <Status>Active</Status>
      <SecretAccessKey>` + xmlEscape(secretAccessKey) + `</SecretAccessKey>
      <CreateDate>` + xmlEscape(h.now().Format(time.RFC3339Nano)) + `</CreateDate>
    </AccessKey>
  </CreateAccessKeyResult>
  <ResponseMetadata><RequestId>` + xmlEscape(requestID) + `</RequestId></ResponseMetadata>
</CreateAccessKeyResponse>`
	return xmlResponse(http.StatusOK, body)
}

func (h *Handler) listAccessKeys(params map[string]string, requestID string) protocols.ErrorResponse {
	userName := params["UserName"]
	user, ok := h.findUser(userName)
	if !ok {
		return h.noSuchUser(userName, requestID)
	}
	var rows strings.Builder
	for _, key := range accessKeys(user) {
		rows.WriteString(`      <member>
        <UserName>`)
		rows.WriteString(xmlEscape(userName))
		rows.WriteString(`</UserName>
        <AccessKeyId>`)
		rows.WriteString(xmlEscape(stringField(key, "access_key_id")))
		rows.WriteString(`</AccessKeyId>
        <Status>`)
		rows.WriteString(xmlEscape(stringField(key, "status")))
		rows.WriteString(`</Status>
      </member>
`)
	}
	body := `<?xml version="1.0" encoding="UTF-8"?>
<ListAccessKeysResponse>
  <ListAccessKeysResult>
    <IsTruncated>false</IsTruncated>
    <AccessKeyMetadata>
` + strings.TrimRight(rows.String(), "\n") + `
    </AccessKeyMetadata>
  </ListAccessKeysResult>
  <ResponseMetadata><RequestId>` + xmlEscape(requestID) + `</RequestId></ResponseMetadata>
</ListAccessKeysResponse>`
	return xmlResponse(http.StatusOK, body)
}

func (h *Handler) deleteAccessKey(params map[string]string, requestID string) protocols.ErrorResponse {
	userName := params["UserName"]
	accessKeyID := params["AccessKeyId"]
	user, ok := h.findUser(userName)
	if !ok {
		return h.noSuchUser(userName, requestID)
	}
	keys := []corestore.Record{}
	for _, key := range accessKeys(user) {
		if stringField(key, "access_key_id") == accessKeyID {
			h.CredentialStore.Delete(accessKeyID)
			continue
		}
		keys = append(keys, key)
	}
	h.Users.Update(intField(user, "id"), corestore.Record{"access_keys": keys})
	body := `<?xml version="1.0" encoding="UTF-8"?>
<DeleteAccessKeyResponse>
  <ResponseMetadata><RequestId>` + xmlEscape(requestID) + `</RequestId></ResponseMetadata>
</DeleteAccessKeyResponse>`
	return xmlResponse(http.StatusOK, body)
}

func (h *Handler) createRole(params map[string]string, requestID string) protocols.ErrorResponse {
	roleName := params["RoleName"]
	if roleName == "" {
		return h.queryError("ValidationError", "The request must contain the parameter RoleName.", http.StatusBadRequest, requestID)
	}
	if _, ok := h.findRole(roleName); ok {
		return h.queryError("EntityAlreadyExists", "Role with name "+roleName+" already exists.", http.StatusConflict, requestID)
	}
	path := params["Path"]
	if path == "" {
		path = "/"
	}
	role := h.Roles.Insert(corestore.Record{
		"role_name":                   roleName,
		"role_id":                     h.generateID("AROA"),
		"arn":                         "arn:aws:iam::" + h.accountID() + ":role" + path + roleName,
		"path":                        path,
		"assume_role_policy_document": defaultString(params["AssumeRolePolicyDocument"], "{}"),
		"description":                 params["Description"],
	})
	return h.roleResponse("CreateRole", role, requestID)
}

func (h *Handler) getRole(params map[string]string, requestID string) protocols.ErrorResponse {
	roleName := params["RoleName"]
	role, ok := h.findRole(roleName)
	if !ok {
		return h.noSuchRole(roleName, requestID)
	}
	return h.roleResponse("GetRole", role, requestID)
}

func (h *Handler) deleteRole(params map[string]string, requestID string) protocols.ErrorResponse {
	roleName := params["RoleName"]
	role, ok := h.findRole(roleName)
	if !ok {
		return h.noSuchRole(roleName, requestID)
	}
	h.Roles.Delete(intField(role, "id"))
	body := `<?xml version="1.0" encoding="UTF-8"?>
<DeleteRoleResponse>
  <ResponseMetadata><RequestId>` + xmlEscape(requestID) + `</RequestId></ResponseMetadata>
</DeleteRoleResponse>`
	return xmlResponse(http.StatusOK, body)
}

func (h *Handler) listRoles(requestID string) protocols.ErrorResponse {
	var rows strings.Builder
	for _, role := range h.Roles.All() {
		rows.WriteString(`      <member>
`)
		writeRoleXML(&rows, role)
		rows.WriteString(`      </member>
`)
	}
	body := `<?xml version="1.0" encoding="UTF-8"?>
<ListRolesResponse>
  <ListRolesResult>
    <IsTruncated>false</IsTruncated>
    <Roles>
` + strings.TrimRight(rows.String(), "\n") + `
    </Roles>
  </ListRolesResult>
  <ResponseMetadata><RequestId>` + xmlEscape(requestID) + `</RequestId></ResponseMetadata>
</ListRolesResponse>`
	return xmlResponse(http.StatusOK, body)
}

func (h *Handler) userResponse(action string, user corestore.Record, requestID string) protocols.ErrorResponse {
	body := `<?xml version="1.0" encoding="UTF-8"?>
<` + action + `Response>
  <` + action + `Result>
    <User>
`
	var rows strings.Builder
	writeUserXML(&rows, user)
	body += strings.TrimRight(rows.String(), "\n") + `
    </User>
  </` + action + `Result>
  <ResponseMetadata><RequestId>` + xmlEscape(requestID) + `</RequestId></ResponseMetadata>
</` + action + `Response>`
	return xmlResponse(http.StatusOK, body)
}

func (h *Handler) roleResponse(action string, role corestore.Record, requestID string) protocols.ErrorResponse {
	body := `<?xml version="1.0" encoding="UTF-8"?>
<` + action + `Response>
  <` + action + `Result>
    <Role>
`
	var rows strings.Builder
	writeRoleXML(&rows, role)
	body += strings.TrimRight(rows.String(), "\n") + `
    </Role>
  </` + action + `Result>
  <ResponseMetadata><RequestId>` + xmlEscape(requestID) + `</RequestId></ResponseMetadata>
</` + action + `Response>`
	return xmlResponse(http.StatusOK, body)
}

func writeUserXML(rows *strings.Builder, user corestore.Record) {
	rows.WriteString(`      <Path>`)
	rows.WriteString(xmlEscape(stringField(user, "path")))
	rows.WriteString(`</Path>
      <UserName>`)
	rows.WriteString(xmlEscape(stringField(user, "user_name")))
	rows.WriteString(`</UserName>
      <UserId>`)
	rows.WriteString(xmlEscape(stringField(user, "user_id")))
	rows.WriteString(`</UserId>
      <Arn>`)
	rows.WriteString(xmlEscape(stringField(user, "arn")))
	rows.WriteString(`</Arn>
      <CreateDate>`)
	rows.WriteString(xmlEscape(stringField(user, "created_at")))
	rows.WriteString(`</CreateDate>
`)
}

func writeRoleXML(rows *strings.Builder, role corestore.Record) {
	rows.WriteString(`      <Path>`)
	rows.WriteString(xmlEscape(stringField(role, "path")))
	rows.WriteString(`</Path>
      <RoleName>`)
	rows.WriteString(xmlEscape(stringField(role, "role_name")))
	rows.WriteString(`</RoleName>
      <RoleId>`)
	rows.WriteString(xmlEscape(stringField(role, "role_id")))
	rows.WriteString(`</RoleId>
      <Arn>`)
	rows.WriteString(xmlEscape(stringField(role, "arn")))
	rows.WriteString(`</Arn>
      <CreateDate>`)
	rows.WriteString(xmlEscape(stringField(role, "created_at")))
	rows.WriteString(`</CreateDate>
      <AssumeRolePolicyDocument>`)
	rows.WriteString(xmlEscape(urlEncode(stringField(role, "assume_role_policy_document"))))
	rows.WriteString(`</AssumeRolePolicyDocument>
      <Description>`)
	rows.WriteString(xmlEscape(stringField(role, "description")))
	rows.WriteString(`</Description>
`)
}

func (h *Handler) noSuchUser(userName string, requestID string) protocols.ErrorResponse {
	return h.queryError("NoSuchEntity", "The user with name "+userName+" cannot be found.", http.StatusNotFound, requestID)
}

func (h *Handler) noSuchRole(roleName string, requestID string) protocols.ErrorResponse {
	return h.queryError("NoSuchEntity", "The role with name "+roleName+" cannot be found.", http.StatusNotFound, requestID)
}

func (h *Handler) queryError(code string, message string, status int, requestID string) protocols.ErrorResponse {
	return protocols.SerializeXMLError(protocols.AWSError{
		Code:       code,
		Message:    message,
		RequestID:  requestID,
		StatusCode: status,
	})
}

func (h *Handler) findUser(userName string) (corestore.Record, bool) {
	for _, user := range h.Users.FindBy("user_name", userName) {
		return user, true
	}
	return nil, false
}

func (h *Handler) findRole(roleName string) (corestore.Record, bool) {
	for _, role := range h.Roles.FindBy("role_name", roleName) {
		return role, true
	}
	return nil, false
}

func (h *Handler) now() time.Time {
	if h.Now != nil {
		return h.Now().UTC()
	}
	return time.Now().UTC()
}

func (h *Handler) accountID() string {
	if h.AccountID != "" {
		return h.AccountID
	}
	return gateway.DefaultAccountID
}

func (h *Handler) generateID(prefix string) string {
	if h.IDGenerator != nil {
		return h.IDGenerator(prefix)
	}
	var bytes [8]byte
	if _, err := rand.Read(bytes[:]); err == nil {
		return prefix + strings.ToUpper(hex.EncodeToString(bytes[:]))
	}
	return fmt.Sprintf("%s%016X", prefix, fallbackIDCounter.Add(1))
}

func (h *Handler) generateSecret(size int) string {
	if h.SecretGenerator != nil {
		return h.SecretGenerator(size)
	}
	bytes := make([]byte, size)
	if _, err := rand.Read(bytes); err == nil {
		return base64.StdEncoding.EncodeToString(bytes)
	}
	return fmt.Sprintf("secret-%d", fallbackIDCounter.Add(1))
}

func accessKeys(user corestore.Record) []corestore.Record {
	switch value := user["access_keys"].(type) {
	case []corestore.Record:
		return append([]corestore.Record(nil), value...)
	case []map[string]any:
		keys := make([]corestore.Record, 0, len(value))
		for _, item := range value {
			keys = append(keys, corestore.Record(item))
		}
		return keys
	case []any:
		keys := make([]corestore.Record, 0, len(value))
		for _, item := range value {
			if record := recordValue(item); len(record) > 0 {
				keys = append(keys, record)
			}
		}
		return keys
	default:
		return []corestore.Record{}
	}
}

func recordValue(value any) corestore.Record {
	switch typed := value.(type) {
	case corestore.Record:
		return typed
	case map[string]any:
		return corestore.Record(typed)
	default:
		return corestore.Record{}
	}
}

func stringField(record corestore.Record, name string) string {
	switch value := record[name].(type) {
	case string:
		return value
	default:
		if value == nil {
			return ""
		}
		return fmt.Sprint(value)
	}
}

func intField(record corestore.Record, name string) int {
	switch value := record[name].(type) {
	case int:
		return value
	case int64:
		return int(value)
	case float64:
		return int(value)
	default:
		return 0
	}
}

func defaultString(value string, fallback string) string {
	if value != "" {
		return value
	}
	return fallback
}

func urlEncode(value string) string {
	return strings.ReplaceAll(url.QueryEscape(value), "+", "%20")
}

func xmlResponse(status int, body string) protocols.ErrorResponse {
	return protocols.ErrorResponse{
		StatusCode:  status,
		ContentType: "application/xml",
		Headers:     map[string]string{"Content-Type": "application/xml"},
		Body:        []byte(body),
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

func xmlEscape(value string) string {
	replacer := strings.NewReplacer(
		"&", "&amp;",
		"<", "&lt;",
		">", "&gt;",
		`"`, "&quot;",
		"'", "&apos;",
	)
	return replacer.Replace(value)
}
