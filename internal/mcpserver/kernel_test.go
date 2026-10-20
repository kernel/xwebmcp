package mcpserver

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/kernel/xwebmcp/internal/kernelapi"
)

func TestKernelTargetInvokesByToolRef(t *testing.T) {
	var invoked, replCode string
	noTools := false
	mux := http.NewServeMux()
	mux.HandleFunc("GET /browsers/b1/webmcp/custom-tools", func(w http.ResponseWriter, _ *http.Request) {
		w.Write([]byte(`{"tools":[{"id":"ct_1","namespace":"example.test","kind":"cdp","match":{"url_patterns":["https://example.test/*"]},"tool":{"name":"probe","description":"probe","inputSchema":{"type":"object"}}}]}`))
	})
	mux.HandleFunc("GET /browsers/b1/webmcp/tools", func(w http.ResponseWriter, _ *http.Request) {
		if noTools && replCode != "" {
			w.Write([]byte(`{"tools":[{"tool_ref":"after","source":{"tab_id":3,"custom":{"id":"ct_1"}}}]}`))
			return
		}
		if noTools {
			w.Write([]byte(`{"tools":[]}`))
			return
		}
		w.Write([]byte(`{"tools":[{"tool_ref":"first","source":{"tab_id":1,"custom":{"id":"ct_1"}}},{"tool_ref":"second","source":{"tab_id":2,"custom":{"id":"ct_1"}}}]}`))
	})
	mux.HandleFunc("POST /browsers/b1/webmcp/invoke", func(w http.ResponseWriter, r *http.Request) {
		var request struct {
			ToolRef string `json:"tool_ref"`
		}
		json.NewDecoder(r.Body).Decode(&request)
		invoked = request.ToolRef
		w.Write([]byte(`{"invocation_id":"inv_1","status":"completed","output":{}}`))
	})
	mux.HandleFunc("POST /browsers/b1/repl", func(w http.ResponseWriter, r *http.Request) {
		var request struct {
			Code string `json:"code"`
		}
		json.NewDecoder(r.Body).Decode(&request)
		replCode = request.Code
		w.Write([]byte(`{"success":true}`))
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()
	target := NewKernelTarget(&kernelapi.Client{BaseURL: srv.URL, APIKey: "test", HTTP: srv.Client()}, "b1")
	ctx := context.Background()
	if _, err := target.Invoke(ctx, InvokeParams{ToolRef: "second", Input: json.RawMessage(`{}`)}); err != nil || invoked != "second" || replCode != "" {
		t.Fatalf("invoke by tool_ref: ref %q, REPL %q, error %v", invoked, replCode, err)
	}
	raw, err := target.ListTools(ctx, ListToolsParams{ExcludeCustom: true})
	if err != nil || string(raw) != "[]" {
		t.Fatalf("exclude_custom = %s, %v", raw, err)
	}
	if _, err := target.OpenTab(ctx, "https://example.test/"); err == nil {
		t.Fatal("open_tab must not return a fabricated numeric tab ID")
	}
	if _, err := target.NavigateTab(ctx, 2, "https://example.test/", true); err == nil {
		t.Fatal("navigate_tab must not operate on the REPL's current tab")
	}
	if err := target.CloseTab(ctx, 2, true); err == nil {
		t.Fatal("close_tab must not operate on the REPL's current tab")
	}
}
