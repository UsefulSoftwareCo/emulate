package vercel

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestHandlerServesPreviewHealth(t *testing.T) {
	handler := NewHandler(Options{Version: "test"})
	req := httptest.NewRequest(http.MethodGet, "https://preview.example.com/emulate/_emulate/health", nil)
	req.Host = "preview.example.com"

	res := httptest.NewRecorder()
	handler.ServeHTTP(res, req)

	if res.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", res.Code, res.Body.String())
	}
	var body struct {
		OK          bool     `json:"ok"`
		Adapter     string   `json:"adapter"`
		Runtime     string   `json:"runtime"`
		Version     string   `json:"version"`
		RoutePrefix string   `json:"route_prefix"`
		Services    []string `json:"services"`
	}
	if err := json.Unmarshal(res.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if !body.OK || body.Adapter != "vercel" || body.Runtime != "go" || body.Version != "test" || body.RoutePrefix != "/emulate" {
		t.Fatalf("unexpected body: %#v", body)
	}
	if strings.Join(body.Services, ",") != "aws,resend" {
		t.Fatalf("services = %#v", body.Services)
	}
}

func TestHandlerForwardsVercelRewriteQueryToService(t *testing.T) {
	handler := NewHandler(Options{Services: []string{"resend"}})
	req := newJSONRequest(
		http.MethodPost,
		"https://preview.example.com/api/emulate?path=resend/emails&limit=1",
		`{"from":"a@example.com","to":"b@example.com","subject":"Hello"}`,
	)
	req.Host = "preview.example.com"

	res := httptest.NewRecorder()
	handler.ServeHTTP(res, req)

	if res.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", res.Code, res.Body.String())
	}
	if !strings.Contains(res.Body.String(), `"id"`) {
		t.Fatalf("unexpected body: %s", res.Body.String())
	}

	req = httptest.NewRequest(http.MethodGet, "https://preview.example.com/api/emulate?path=resend/emails", nil)
	req.Host = "preview.example.com"
	res = httptest.NewRecorder()
	handler.ServeHTTP(res, req)

	if res.Code != http.StatusOK {
		t.Fatalf("list status = %d, body = %s", res.Code, res.Body.String())
	}
	if !strings.Contains(res.Body.String(), "Hello") {
		t.Fatalf("unexpected list body: %s", res.Body.String())
	}
}

func TestHandlerForwardsDirectPublicPathToService(t *testing.T) {
	handler := NewHandler(Options{Services: []string{"resend"}})
	req := newJSONRequest(
		http.MethodPost,
		"https://preview.example.com/emulate/resend/emails",
		`{"from":"a@example.com","to":"b@example.com","subject":"Direct"}`,
	)
	req.Host = "preview.example.com"

	res := httptest.NewRecorder()
	handler.ServeHTTP(res, req)

	if res.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", res.Code, res.Body.String())
	}
}

func TestHandlerRewritesHTMLRootPathsThroughPublicServicePrefix(t *testing.T) {
	handler := NewHandler(Options{Services: []string{"resend"}})
	createEmail(t, handler, "Rewritten")

	req := httptest.NewRequest(http.MethodGet, "https://preview.example.com/emulate/resend/inbox", nil)
	req.Host = "preview.example.com"
	res := httptest.NewRecorder()
	handler.ServeHTTP(res, req)

	if res.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", res.Code, res.Body.String())
	}
	body := res.Body.String()
	if !strings.Contains(body, `href="/emulate/resend/inbox/`) {
		t.Fatalf("missing rewritten inbox link: %s", body)
	}
	if strings.Contains(body, `href="/inbox/`) || strings.Contains(body, `href="/_emulate/`) {
		t.Fatalf("contains unrewritten root link: %s", body)
	}
	if !strings.Contains(body, `url('/emulate/resend/_emulate/`) {
		t.Fatalf("missing rewritten asset URL: %s", body)
	}
	if res.Header().Get("Content-Length") != "" || res.Header().Get("Content-Encoding") != "" {
		t.Fatalf("unexpected stale content headers: %#v", res.Header())
	}
}

func TestHandlerReturnsUnknownService(t *testing.T) {
	handler := NewHandler(Options{})
	req := httptest.NewRequest(http.MethodGet, "https://preview.example.com/emulate/github/user", nil)

	res := httptest.NewRecorder()
	handler.ServeHTTP(res, req)

	if res.Code != http.StatusNotFound {
		t.Fatalf("status = %d, body = %s", res.Code, res.Body.String())
	}
	if !strings.Contains(res.Body.String(), "Unknown service: github") {
		t.Fatalf("unexpected body: %s", res.Body.String())
	}
}

func TestHandlerLoadsAndSavesPerServiceSnapshots(t *testing.T) {
	persistence := &memoryPersistence{snapshots: map[string][]byte{}}
	handler := NewHandler(Options{
		Services:    []string{"resend"},
		Persistence: persistence,
	})
	createEmail(t, handler, "Persistent")

	if persistence.saves != 1 {
		t.Fatalf("saves = %d", persistence.saves)
	}
	if len(persistence.snapshots["resend"]) == 0 {
		t.Fatal("missing resend snapshot")
	}

	restored := NewHandler(Options{
		Services:    []string{"resend"},
		Persistence: persistence,
	})
	req := httptest.NewRequest(http.MethodGet, "https://preview.example.com/emulate/resend/emails", nil)
	req.Host = "preview.example.com"
	res := httptest.NewRecorder()
	restored.ServeHTTP(res, req)

	if res.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", res.Code, res.Body.String())
	}
	if !strings.Contains(res.Body.String(), "Persistent") {
		t.Fatalf("expected restored email, got %s", res.Body.String())
	}
	if persistence.loads == 0 {
		t.Fatal("persistence was not loaded")
	}
}

func TestHandlerLoadsAndSavesAWSS3ObjectSnapshots(t *testing.T) {
	persistence := &memoryPersistence{snapshots: map[string][]byte{}}
	handler := NewHandler(Options{
		Services:    []string{"aws"},
		Persistence: persistence,
	})
	req := httptest.NewRequest(
		http.MethodPut,
		"https://preview.example.com/emulate/aws/emulate-default/docs/persistent.txt",
		strings.NewReader("persistent object"),
	)
	req.Host = "preview.example.com"
	req.Header.Set("Content-Type", "text/plain")
	res := httptest.NewRecorder()
	handler.ServeHTTP(res, req)

	if res.Code != http.StatusOK {
		t.Fatalf("put status = %d, body = %s", res.Code, res.Body.String())
	}
	if len(persistence.snapshots["aws"]) == 0 {
		t.Fatal("missing aws snapshot")
	}

	restored := NewHandler(Options{
		Services:    []string{"aws"},
		Persistence: persistence,
	})
	req = httptest.NewRequest(http.MethodGet, "https://preview.example.com/emulate/aws/emulate-default/docs/persistent.txt", nil)
	req.Host = "preview.example.com"
	res = httptest.NewRecorder()
	restored.ServeHTTP(res, req)

	if res.Code != http.StatusOK {
		t.Fatalf("get status = %d, body = %s", res.Code, res.Body.String())
	}
	if res.Body.String() != "persistent object" {
		t.Fatalf("body = %q", res.Body.String())
	}
	if got := res.Header().Get("Content-Type"); got != "text/plain" {
		t.Fatalf("content type = %q", got)
	}
}

func TestHandlerPreservesTrailingSlashInVercelRewritePath(t *testing.T) {
	handler := NewHandler(Options{Services: []string{"aws"}})
	req := httptest.NewRequest(
		http.MethodPut,
		"https://preview.example.com/api/emulate?path=aws/emulate-default/folder/",
		strings.NewReader("directory marker"),
	)
	req.Host = "preview.example.com"
	req.Header.Set("Content-Type", "text/plain")
	res := httptest.NewRecorder()
	handler.ServeHTTP(res, req)

	if res.Code != http.StatusOK {
		t.Fatalf("put status = %d, body = %s", res.Code, res.Body.String())
	}

	req = httptest.NewRequest(http.MethodGet, "https://preview.example.com/api/emulate?path=aws/emulate-default&list-type=2", nil)
	req.Host = "preview.example.com"
	res = httptest.NewRecorder()
	handler.ServeHTTP(res, req)

	if res.Code != http.StatusOK {
		t.Fatalf("list status = %d, body = %s", res.Code, res.Body.String())
	}
	body := res.Body.String()
	if !strings.Contains(body, "<Key>folder/</Key>") {
		t.Fatalf("missing trailing slash key in %s", body)
	}
	if strings.Contains(body, "<Key>folder</Key>") {
		t.Fatalf("key lost trailing slash in %s", body)
	}
}

func createEmail(t *testing.T, handler http.Handler, subject string) {
	t.Helper()
	req := newJSONRequest(
		http.MethodPost,
		"https://preview.example.com/emulate/resend/emails",
		`{"from":"a@example.com","to":"b@example.com","subject":"`+subject+`"}`,
	)
	req.Host = "preview.example.com"
	res := httptest.NewRecorder()
	handler.ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("create status = %d, body = %s", res.Code, res.Body.String())
	}
}

func newJSONRequest(method string, target string, body string) *http.Request {
	req := httptest.NewRequest(method, target, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	return req
}

type memoryPersistence struct {
	loads     int
	saves     int
	snapshots map[string][]byte
}

func (p *memoryPersistence) Load(_ context.Context, service string) ([]byte, error) {
	p.loads++
	return append([]byte(nil), p.snapshots[service]...), nil
}

func (p *memoryPersistence) Save(_ context.Context, service string, snapshot []byte) error {
	p.saves++
	p.snapshots[service] = append([]byte(nil), snapshot...)
	return nil
}
