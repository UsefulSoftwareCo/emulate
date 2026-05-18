package ui

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	corehttp "github.com/vercel-labs/emulate/internal/core/http"
)

func TestRenderCardPageEscapesTitleAndUsesSharedChrome(t *testing.T) {
	html := RenderCardPage(`<Login>`, `<strong>Choose</strong>`, `<form></form>`, PageOptions{Service: "GitHub", Prefix: "/emulate"})

	for _, want := range []string{
		"<!DOCTYPE html>",
		"&lt;Login&gt; | emulate",
		"GitHub Emulator",
		"<strong>Choose</strong>",
		"Powered by",
		"/emulate/_emulate/fonts/geist-sans.woff2",
	} {
		if !strings.Contains(html, want) {
			t.Fatalf("rendered card page missing %q:\n%s", want, html)
		}
	}
}

func TestRenderErrorPageEscapesMessage(t *testing.T) {
	html := RenderErrorPage("Denied", `bad "scope" <admin>`, PageOptions{})
	if !strings.Contains(html, `bad &quot;scope&quot; &lt;admin&gt;`) {
		t.Fatalf("message was not escaped:\n%s", html)
	}
}

func TestRenderInspectorPageMarksActiveTab(t *testing.T) {
	html := RenderInspectorPage("AWS", []InspectorTab{
		{ID: "s3", Label: "S3", Href: "/_inspector?tab=s3"},
		{ID: "sqs", Label: "SQS", Href: "/_inspector?tab=sqs"},
	}, "sqs", `<section class="inspector-section"></section>`, PageOptions{Service: "AWS"})

	if !strings.Contains(html, `<a href="/_inspector?tab=sqs" class="active">SQS</a>`) {
		t.Fatalf("active tab missing:\n%s", html)
	}
	if !strings.Contains(html, `inspector-section`) {
		t.Fatalf("body missing:\n%s", html)
	}
}

func TestRenderFormPostPageSortsAndEscapesHiddenFields(t *testing.T) {
	html := RenderFormPostPage("/callback", map[string]string{
		"z": "last",
		"a": `"first"`,
	}, PageOptions{})

	first := strings.Index(html, `name="a"`)
	second := strings.Index(html, `name="z"`)
	if first < 0 || second < 0 || first > second {
		t.Fatalf("hidden fields were not sorted:\n%s", html)
	}
	if !strings.Contains(html, `value="&quot;first&quot;"`) {
		t.Fatalf("hidden field was not escaped:\n%s", html)
	}
}

func TestRenderUserButtonSortsHiddenFields(t *testing.T) {
	html := RenderUserButton(UserButtonOptions{
		Letter:     "A",
		Login:      "alice",
		Name:       "Alice",
		Email:      "alice@example.com",
		FormAction: "/choose",
		HiddenFields: map[string]string{
			"state":       "s1",
			"client_id":   "c1",
			"redirect_to": "/dashboard",
		},
	})

	if !strings.Contains(html, `class="user-btn"`) || !strings.Contains(html, `alice@example.com`) {
		t.Fatalf("user button missing content:\n%s", html)
	}
	if strings.Index(html, `name="client_id"`) > strings.Index(html, `name="state"`) {
		t.Fatalf("hidden fields were not stable:\n%s", html)
	}
}

func TestAssetRoutesServeEmbeddedPlaceholders(t *testing.T) {
	router := corehttp.NewRouter()
	RegisterAssetRoutes(router)

	res := httptest.NewRecorder()
	router.ServeHTTP(res, httptest.NewRequest(http.MethodGet, "/_emulate/fonts/geist-sans.woff2", nil))
	if res.Code != http.StatusOK {
		t.Fatalf("font status = %d, body = %s", res.Code, res.Body.String())
	}
	if res.Header().Get("Content-Type") != "font/woff2" {
		t.Fatalf("font content type = %q", res.Header().Get("Content-Type"))
	}

	missing := httptest.NewRecorder()
	router.ServeHTTP(missing, httptest.NewRequest(http.MethodGet, "/_emulate/fonts/missing.woff2", nil))
	if missing.Code != http.StatusNotFound {
		t.Fatalf("missing status = %d", missing.Code)
	}
}
