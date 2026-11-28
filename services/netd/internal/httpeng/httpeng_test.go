package httpeng_test

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/Sycun/GongYuAI/services/netd/internal/httpeng"
)

func TestScopeValidationRedirectsAndUTF8Truncation(t *testing.T) {
	eng := httpeng.NewEngine()
	defer eng.Close()
	evDir := t.TempDir()

	// Reject header CRLF injection & invalid method
	if _, err := eng.Perform(context.Background(), httpeng.RequestInput{
		Method:      "BAD METHOD",
		URL:         "http://127.0.0.1/",
		EvidenceDir: evDir,
	}); err == nil {
		t.Fatal("expected invalid HTTP method error")
	}
	if _, err := eng.Perform(context.Background(), httpeng.RequestInput{
		URL:         "http://127.0.0.1/",
		Headers:     map[string]string{"X-Test": "ok\r\nInjected: 1"},
		EvidenceDir: evDir,
	}); err == nil {
		t.Fatal("expected CRLF header value rejection")
	}

	// Spin up two local servers to verify same-origin vs cross-origin sensitive header stripping on redirect
	var srvBSeenAuth, srvBSeenCookie, srvBMethod string
	srvB := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		srvBSeenAuth = r.Header.Get("Authorization")
		srvBSeenCookie = r.Header.Get("Cookie")
		srvBMethod = r.Method
		// Return multi-byte UTF-8 text to test clean boundary truncation
		_, _ = fmt.Fprint(w, strings.Repeat("安全测试", 20))
	}))
	defer srvB.Close()

	var sameOriginAuth string
	var srvAURL string
	srvA := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/login":
			w.Header().Set("Location", srvAURL+"/step2")
			w.WriteHeader(http.StatusFound)
		case "/step2":
			sameOriginAuth = r.Header.Get("Authorization")
			w.Header().Set("Location", srvB.URL+"/final")
			w.WriteHeader(http.StatusFound)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer srvA.Close()
	srvAURL = srvA.URL

	body := "user=admin"
	maxBytes := 17 // cuts right inside a 3-byte Chinese UTF-8 rune ("安全测试" = 12 bytes, 17 cuts inside 6th rune)
	res, err := eng.Perform(context.Background(), httpeng.RequestInput{
		Method: "POST",
		URL:    srvA.URL + "/login#frag",
		Headers: map[string]string{
			"Authorization": "Bearer secret",
			"Cookie":        "sid=abc",
			"Content-Type":  "application/x-www-form-urlencoded",
		},
		Body:             &body,
		MaxResponseBytes: &maxBytes,
		EvidenceDir:      evDir,
		Scope: &httpeng.ScopeRule{
			AllowHosts: []string{"127.0.0.0/8"},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if res.Artifact.Status != 200 || len(res.Artifact.Redirects) != 2 {
		t.Fatalf("unexpected redirect chain: %+v", res.Artifact)
	}
	if sameOriginAuth != "Bearer secret" {
		t.Fatalf("same-origin hop should preserve Authorization, got %q", sameOriginAuth)
	}
	if srvBSeenAuth != "" || srvBSeenCookie != "" || srvBMethod != "GET" {
		t.Fatalf("cross-origin 302 from POST must become GET and strip credentials: method=%s auth=%q cookie=%q", srvBMethod, srvBSeenAuth, srvBSeenCookie)
	}
	if !res.Artifact.Truncated || !utf8.ValidString(res.BodyHead) {
		t.Fatalf("expected valid UTF-8 truncated bodyHead, truncated=%v bodyHead=%q", res.Artifact.Truncated, res.BodyHead)
	}

	// Out-of-scope CIDR/DenyHosts block check
	denied, err := eng.Perform(context.Background(), httpeng.RequestInput{
		URL:         srvA.URL + "/login",
		EvidenceDir: evDir,
		Scope: &httpeng.ScopeRule{
			AllowHosts: []string{"127.0.0.0/8"},
			DenyHosts:  []string{"127.0.0.1"},
		},
	})
	if err != nil || denied.Artifact.BlockedRedirect != "127.0.0.1" || denied.Artifact.Status != 0 {
		t.Fatalf("expected DenyHosts to block initial request: %+v err=%v", denied, err)
	}
}
