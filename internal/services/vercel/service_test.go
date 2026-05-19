package vercel

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	corehttp "github.com/vercel-labs/emulate/internal/core/http"
)

const testBaseURL = "http://localhost:4000"

func TestVercelCurrentUserUsesSeededTokenUser(t *testing.T) {
	handler := newVercelTestHandler()
	res := doVercelJSON(handler, http.MethodGet, "/v2/user", "", true)

	if res.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", res.Code, res.Body.String())
	}
	var body struct {
		User struct {
			Username string `json:"username"`
			Email    string `json:"email"`
		} `json:"user"`
	}
	decodeVercelBody(t, res, &body)
	if body.User.Username != "testuser" || body.User.Email != "testuser@example.com" {
		t.Fatalf("unexpected user: %#v", body.User)
	}
}

func TestVercelProjectsEnvAndDomains(t *testing.T) {
	handler := newVercelTestHandler()
	create := doVercelJSON(handler, http.MethodPost, "/v11/projects", `{
		"name":"docs-app",
		"framework":"nextjs",
		"environmentVariables":[{"key":"API_URL","value":"https://example.test","type":"encrypted","target":["production"]}]
	}`, true)
	if create.Code != http.StatusOK {
		t.Fatalf("create status = %d, body = %s", create.Code, create.Body.String())
	}
	var project struct {
		ID        string `json:"id"`
		Name      string `json:"name"`
		Framework string `json:"framework"`
	}
	decodeVercelBody(t, create, &project)
	if project.ID == "" || project.Name != "docs-app" || project.Framework != "nextjs" {
		t.Fatalf("unexpected project: %#v", project)
	}

	list := doVercelJSON(handler, http.MethodGet, "/v10/projects?search=docs", "", true)
	if list.Code != http.StatusOK {
		t.Fatalf("list status = %d, body = %s", list.Code, list.Body.String())
	}
	var listed struct {
		Projects []struct {
			ID string `json:"id"`
		} `json:"projects"`
		Pagination map[string]any `json:"pagination"`
	}
	decodeVercelBody(t, list, &listed)
	if len(listed.Projects) != 1 || listed.Projects[0].ID != project.ID || listed.Pagination == nil {
		t.Fatalf("unexpected project list: %#v", listed)
	}

	envCreate := doVercelJSON(handler, http.MethodPost, "/v10/projects/"+project.ID+"/env?upsert=1", `{
		"key":"API_URL",
		"value":"https://override.test",
		"type":"encrypted",
		"target":["production"],
		"comment":"updated"
	}`, true)
	if envCreate.Code != http.StatusOK {
		t.Fatalf("env status = %d, body = %s", envCreate.Code, envCreate.Body.String())
	}
	var envBody struct {
		Envs []struct {
			ID    string `json:"id"`
			Value string `json:"value"`
		} `json:"envs"`
	}
	decodeVercelBody(t, envCreate, &envBody)
	if len(envBody.Envs) != 1 || envBody.Envs[0].Value != "https://override.test" {
		t.Fatalf("unexpected env body: %#v", envBody)
	}

	domainCreate := doVercelJSON(handler, http.MethodPost, "/v10/projects/"+project.ID+"/domains", `{"name":"docs-app.vercel.app"}`, true)
	if domainCreate.Code != http.StatusOK {
		t.Fatalf("domain status = %d, body = %s", domainCreate.Code, domainCreate.Body.String())
	}
	var domain struct {
		Name     string `json:"name"`
		Verified bool   `json:"verified"`
	}
	decodeVercelBody(t, domainCreate, &domain)
	if domain.Name != "docs-app.vercel.app" || !domain.Verified {
		t.Fatalf("unexpected domain: %#v", domain)
	}
}

func TestVercelDeploymentsFilesAndAliases(t *testing.T) {
	handler := newVercelTestHandler()
	projectID := createVercelProject(t, handler, "deploy-app")
	deploy := doVercelJSON(handler, http.MethodPost, "/v13/deployments", `{
		"name":"deploy-app",
		"project":"`+projectID+`",
		"target":"production",
		"meta":{"githubCommitSha":"abc123"},
		"files":[{"file":"api/index.ts","sha":"sha256-abc","size":123}]
	}`, true)
	if deploy.Code != http.StatusOK {
		t.Fatalf("deploy status = %d, body = %s", deploy.Code, deploy.Body.String())
	}
	var dep struct {
		UID   string   `json:"uid"`
		State string   `json:"state"`
		Alias []string `json:"alias"`
	}
	decodeVercelBody(t, deploy, &dep)
	if dep.UID == "" || dep.State != "READY" || len(dep.Alias) != 2 {
		t.Fatalf("unexpected deployment: %#v", dep)
	}

	files := doVercelJSON(handler, http.MethodGet, "/v6/deployments/"+dep.UID+"/files", "", true)
	if files.Code != http.StatusOK {
		t.Fatalf("files status = %d, body = %s", files.Code, files.Body.String())
	}
	if !strings.Contains(files.Body.String(), "index.ts") {
		t.Fatalf("missing file tree entry: %s", files.Body.String())
	}

	events := doVercelJSON(handler, http.MethodGet, "/v3/deployments/"+dep.UID+"/events", "", true)
	if events.Code != http.StatusOK {
		t.Fatalf("events status = %d, body = %s", events.Code, events.Body.String())
	}
	if !strings.Contains(events.Body.String(), "Deployment ready") {
		t.Fatalf("missing ready event: %s", events.Body.String())
	}
}

func TestVercelOAuthIssuesUsableBearerToken(t *testing.T) {
	handler := newVercelTestHandler()
	form := url.Values{
		"username":     {"testuser"},
		"redirect_uri": {"http://localhost:3000/callback"},
		"scope":        {"user"},
		"state":        {"state-1"},
		"client_id":    {"client-id"},
	}
	req := httptest.NewRequest(http.MethodPost, "/oauth/authorize/callback", strings.NewReader(form.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	res := httptest.NewRecorder()
	handler.ServeHTTP(res, req)
	if res.Code != http.StatusFound {
		t.Fatalf("callback status = %d, body = %s", res.Code, res.Body.String())
	}
	location, err := url.Parse(res.Header().Get("Location"))
	if err != nil {
		t.Fatal(err)
	}
	code := location.Query().Get("code")
	if code == "" || location.Query().Get("state") != "state-1" {
		t.Fatalf("unexpected callback location: %s", location.String())
	}

	tokenRes := doVercelJSON(handler, http.MethodPost, "/login/oauth/token", `{"code":"`+code+`","redirect_uri":"http://localhost:3000/callback"}`, false)
	if tokenRes.Code != http.StatusOK {
		t.Fatalf("token status = %d, body = %s", tokenRes.Code, tokenRes.Body.String())
	}
	var tokenBody struct {
		AccessToken string `json:"access_token"`
		TokenType   string `json:"token_type"`
	}
	decodeVercelBody(t, tokenRes, &tokenBody)
	if tokenBody.AccessToken == "" || tokenBody.TokenType != "Bearer" {
		t.Fatalf("unexpected token body: %#v", tokenBody)
	}

	req = httptest.NewRequest(http.MethodGet, "/login/oauth/userinfo", nil)
	req.Header.Set("Authorization", "Bearer "+tokenBody.AccessToken)
	userInfo := httptest.NewRecorder()
	handler.ServeHTTP(userInfo, req)
	if userInfo.Code != http.StatusOK {
		t.Fatalf("userinfo status = %d, body = %s", userInfo.Code, userInfo.Body.String())
	}
	if !strings.Contains(userInfo.Body.String(), "testuser") {
		t.Fatalf("unexpected userinfo body: %s", userInfo.Body.String())
	}
}

func TestVercelAPIKeyCanAuthenticateRequests(t *testing.T) {
	handler := newVercelTestHandler()
	keyRes := doVercelJSON(handler, http.MethodPost, "/v1/api-keys", `{"name":"SDK Tests"}`, true)
	if keyRes.Code != http.StatusOK {
		t.Fatalf("key status = %d, body = %s", keyRes.Code, keyRes.Body.String())
	}
	var keyBody struct {
		APIKeyString string `json:"apiKeyString"`
	}
	decodeVercelBody(t, keyRes, &keyBody)
	if keyBody.APIKeyString == "" {
		t.Fatal("missing API key string")
	}
	req := httptest.NewRequest(http.MethodGet, "/v2/user", nil)
	req.Header.Set("Authorization", "Bearer "+keyBody.APIKeyString)
	userRes := httptest.NewRecorder()
	handler.ServeHTTP(userRes, req)
	if userRes.Code != http.StatusOK {
		t.Fatalf("user status = %d, body = %s", userRes.Code, userRes.Body.String())
	}
}

func newVercelTestHandler() http.Handler {
	router := corehttp.NewRouter()
	Register(router, Options{
		BaseURL: testBaseURL,
		Seed: &SeedConfig{
			Users: []UserSeed{{Username: "testuser", Email: "testuser@example.com", Name: "Test User"}},
		},
	})
	return router
}

func doVercelJSON(handler http.Handler, method string, target string, body string, auth bool) *httptest.ResponseRecorder {
	var reader *bytes.Reader
	if body == "" {
		reader = bytes.NewReader(nil)
	} else {
		reader = bytes.NewReader([]byte(body))
	}
	req := httptest.NewRequest(method, target, reader)
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	if auth {
		req.Header.Set("Authorization", "Bearer test-token")
	}
	res := httptest.NewRecorder()
	handler.ServeHTTP(res, req)
	return res
}

func decodeVercelBody(t *testing.T, res *httptest.ResponseRecorder, target any) {
	t.Helper()
	if err := json.Unmarshal(res.Body.Bytes(), target); err != nil {
		t.Fatalf("decode body: %v: %s", err, res.Body.String())
	}
}

func createVercelProject(t *testing.T, handler http.Handler, name string) string {
	t.Helper()
	res := doVercelJSON(handler, http.MethodPost, "/v11/projects", `{"name":"`+name+`"}`, true)
	if res.Code != http.StatusOK {
		t.Fatalf("project status = %d, body = %s", res.Code, res.Body.String())
	}
	var project struct {
		ID string `json:"id"`
	}
	decodeVercelBody(t, res, &project)
	if project.ID == "" {
		t.Fatal("missing project id")
	}
	return project.ID
}
