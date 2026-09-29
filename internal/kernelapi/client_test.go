package kernelapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestClient(t *testing.T) {
	var gotAuth string
	var gotBody map[string]any
	mux := http.NewServeMux()
	mux.HandleFunc("GET /browsers/b1/webmcp/custom-tools", func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		w.Write([]byte(`{"tools":[{"id":"ct_a","namespace":"aa.com","kind":"cdp","match":{"url_patterns":["https://aa.com/*"]},"tool":{"name":"search_flights","description":"d","inputSchema":{"type":"object"}}}]}`))
	})
	mux.HandleFunc("POST /browsers/b1/webmcp/custom-tools", func(w http.ResponseWriter, r *http.Request) {
		json.NewDecoder(r.Body).Decode(&gotBody)
		w.WriteHeader(http.StatusCreated)
		w.Write([]byte(`{"tools":[{"id":"ct_b","namespace":"aa.com","kind":"cdp","match":{"url_patterns":[]},"tool":{"name":"login","description":"d","inputSchema":{}}}]}`))
	})
	mux.HandleFunc("DELETE /browsers/b1/webmcp/custom-tools/ct_a", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	})
	mux.HandleFunc("POST /browsers/b1/webmcp/invoke", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusGatewayTimeout)
		w.Write([]byte(`{"code":"outcome_unknown","message":"unknown"}`))
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()
	client := &Client{BaseURL: srv.URL, APIKey: "k", HTTP: srv.Client()}
	ctx := context.Background()

	tools, err := client.ListCustomTools(ctx, "b1")
	if err != nil || len(tools) != 1 || tools[0].ID != "ct_a" || tools[0].Match.URLPatterns[0] != "https://aa.com/*" {
		t.Fatalf("list = %+v, %v", tools, err)
	}
	if gotAuth != "Bearer k" {
		t.Errorf("auth header = %q", gotAuth)
	}
	added, err := client.AddCustomTools(ctx, "b1", "aa.com", "[...]", true)
	if err != nil || len(added) != 1 || added[0].ID != "ct_b" {
		t.Fatalf("add = %+v, %v", added, err)
	}
	if gotBody["namespace"] != "aa.com" || gotBody["source"] != "[...]" || gotBody["force_overwrite_namespace"] != true {
		t.Errorf("add body = %v", gotBody)
	}
	if err := client.RemoveCustomTool(ctx, "b1", "ct_a"); err != nil {
		t.Errorf("remove: %v", err)
	}
	_, err = client.Invoke(ctx, "b1", "ref", json.RawMessage(`{}`), 30)
	var apiErr *APIError
	if !errors.As(err, &apiErr) || apiErr.Status != 504 || apiErr.Code != "outcome_unknown" {
		t.Errorf("invoke error = %v", err)
	}
}

func TestFromEnv(t *testing.T) {
	t.Setenv("KERNEL_API_KEY", "")
	if _, err := FromEnv(); err == nil {
		t.Error("expected error without API key")
	}
	t.Setenv("KERNEL_API_KEY", "abc")
	t.Setenv("KERNEL_BASE_URL", "http://example")
	c, err := FromEnv()
	if err != nil || c.BaseURL != "http://example" || c.APIKey != "abc" {
		t.Errorf("FromEnv = %+v, %v", c, err)
	}
}
