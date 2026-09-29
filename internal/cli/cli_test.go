package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/kernel/xwebmcp/internal/github"
	"github.com/kernel/xwebmcp/internal/kernelapi"
)

type fakeGitHub struct {
	defaultBranch string
	commits       map[string]string
	files         map[string]string
}

func (f *fakeGitHub) server(t *testing.T) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("/repos/kernel/xwebmcp", func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]string{"default_branch": f.defaultBranch})
	})
	mux.HandleFunc("/repos/kernel/xwebmcp/commits/", func(w http.ResponseWriter, r *http.Request) {
		sha, ok := f.commits[strings.TrimPrefix(r.URL.Path, "/repos/kernel/xwebmcp/commits/")]
		if !ok {
			http.NotFound(w, r)
			return
		}
		w.Write([]byte(sha))
	})
	mux.HandleFunc("/repos/kernel/xwebmcp/git/trees/", func(w http.ResponseWriter, r *http.Request) {
		var tree []map[string]string
		for path := range f.files {
			tree = append(tree, map[string]string{"path": path, "type": "blob"})
		}
		json.NewEncoder(w).Encode(map[string]any{"tree": tree})
	})
	mux.HandleFunc("/kernel/xwebmcp/", func(w http.ResponseWriter, r *http.Request) {
		parts := strings.SplitN(strings.TrimPrefix(r.URL.Path, "/kernel/xwebmcp/"), "/", 2)
		content, ok := f.files[parts[1]]
		if !ok {
			http.NotFound(w, r)
			return
		}
		w.Write([]byte(content))
	})
	return httptest.NewServer(mux)
}

func newTestApp(t *testing.T, gh *fakeGitHub) (*App, *bytes.Buffer) {
	t.Helper()
	srv := gh.server(t)
	t.Cleanup(srv.Close)
	out := &bytes.Buffer{}
	app := &App{
		Stdout:   out,
		Stderr:   out,
		StoreDir: filepath.Join(t.TempDir(), "state"),
		GitHub:   &github.Client{HTTP: srv.Client(), APIBase: srv.URL, RawBase: srv.URL},
	}
	return app, out
}

func run(t *testing.T, app *App, args ...string) error {
	t.Helper()
	return app.Run(context.Background(), append([]string{"xwebmcp"}, args...))
}

func TestAddListUpdateRemove(t *testing.T) {
	gh := &fakeGitHub{
		defaultBranch: "main",
		commits:       map[string]string{"main": strings.Repeat("1", 40)},
		files: map[string]string{
			"registry.json": `{"tools":[{"domain":"southwest.com","tool":"search_flights","file":"domains/southwest.com/search_flights.js","kind":"cdp","status":"verified","url_patterns":["https://southwest.com/*"]},{"domain":"southwest.com","tool":"login","file":"domains/southwest.com/login.js","kind":"cdp","status":"draft"}]}`,
			"domains/southwest.com/search_flights.js": "[{ kind: 'cdp', tool: { name: 'search_flights' } }]\n",
			"domains/southwest.com/login.js":          "[{ kind: 'cdp', tool: { name: 'login' } }]\n",
		},
	}
	app, out := newTestApp(t, gh)

	if err := run(t, app, "add", "kernel/xwebmcp"); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "installed 2 tool(s) from kernel/xwebmcp at main (111111111111)") {
		t.Errorf("add output:\n%s", out.String())
	}

	out.Reset()
	if err := run(t, app, "list"); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "southwest.com  search_flights  cdp   verified") || !strings.Contains(out.String(), "kernel/xwebmcp@1111111") {
		t.Errorf("list output:\n%s", out.String())
	}

	// Same commit: no changes.
	out.Reset()
	if err := run(t, app, "add", "kernel/xwebmcp"); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "already at main") {
		t.Errorf("noop add output:\n%s", out.String())
	}

	// New commit changes one file and drops another.
	gh.commits["main"] = strings.Repeat("2", 40)
	gh.files["domains/southwest.com/search_flights.js"] = "[{ kind: 'cdp', tool: { name: 'search_flights', description: 'new' } }]\n"
	delete(gh.files, "domains/southwest.com/login.js")
	out.Reset()
	if err := run(t, app, "add", "kernel/xwebmcp"); err != nil {
		t.Fatal(err)
	}
	got := out.String()
	for _, want := range []string{
		"~ southwest.com/search_flights",
		"--- a/domains/southwest.com/search_flights.js",
		"-[{ kind: 'cdp', tool: { name: 'search_flights' } }]",
		"+[{ kind: 'cdp', tool: { name: 'search_flights', description: 'new' } }]",
		"- southwest.com/login",
		"updated kernel/xwebmcp from 111111111111 to 222222222222: 0 added, 1 changed, 1 removed",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("update output missing %q:\n%s", want, got)
		}
	}

	out.Reset()
	if err := run(t, app, "remove", "southwest.com/search_flights"); err != nil {
		t.Fatal(err)
	}
	if err := run(t, app, "list"); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "no tools installed") {
		t.Errorf("list after remove:\n%s", out.String())
	}
	if err := run(t, app, "remove", "southwest.com"); err == nil {
		t.Error("removing a missing namespace should fail")
	}
}

func TestRemoveSource(t *testing.T) {
	gh := &fakeGitHub{
		defaultBranch: "main",
		commits:       map[string]string{"main": strings.Repeat("1", 40)},
		files:         map[string]string{"domains/aa.com/search_flights.js": "[]"},
	}
	app, out := newTestApp(t, gh)
	if err := run(t, app, "add", "https://github.com/kernel/xwebmcp"); err != nil {
		t.Fatal(err)
	}
	out.Reset()
	if err := run(t, app, "remove", "kernel/xwebmcp"); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "removed kernel/xwebmcp (1 tool(s))") {
		t.Errorf("remove output:\n%s", out.String())
	}
}

func TestAttachKernel(t *testing.T) {
	gh := &fakeGitHub{
		defaultBranch: "main",
		commits:       map[string]string{"main": strings.Repeat("1", 40)},
		files: map[string]string{
			"domains/southwest.com/search_flights.js": "[search]",
			"domains/southwest.com/login.js":          "[login]",
			"domains/aa.com/search_flights.js":        "[aa]",
		},
	}
	app, out := newTestApp(t, gh)
	if err := run(t, app, "add", "kernel/xwebmcp"); err != nil {
		t.Fatal(err)
	}

	type call struct {
		Namespace string `json:"namespace"`
		Source    string `json:"source"`
		Force     bool   `json:"force_overwrite_namespace"`
	}
	var calls []call
	mux := http.NewServeMux()
	mux.HandleFunc("POST /browsers/abc/webmcp/custom-tools", func(w http.ResponseWriter, r *http.Request) {
		var c call
		json.NewDecoder(r.Body).Decode(&c)
		calls = append(calls, c)
		var names []string
		if c.Namespace == "aa.com" {
			names = []string{"aa"}
		} else {
			names = []string{"login", "search"}
		}
		var tools []map[string]any
		for _, name := range names {
			tools = append(tools, map[string]any{
				"id": "ct_" + name, "namespace": c.Namespace, "kind": "cdp",
				"match": map[string]any{"url_patterns": []string{}},
				"tool":  map[string]any{"name": name, "description": "", "inputSchema": map[string]any{}},
			})
		}
		w.WriteHeader(http.StatusCreated)
		json.NewEncoder(w).Encode(map[string]any{"tools": tools})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()
	app.Kernel = func() (*kernelapi.Client, error) {
		return &kernelapi.Client{BaseURL: srv.URL, APIKey: "k", HTTP: srv.Client()}, nil
	}

	out.Reset()
	if err := run(t, app, "attach", "--kernel", "abc"); err != nil {
		t.Fatal(err)
	}
	if len(calls) != 2 {
		t.Fatalf("calls = %+v", calls)
	}
	if calls[0].Namespace != "aa.com" || !calls[0].Force || calls[0].Source != "[...([aa])]" {
		t.Errorf("first call = %+v", calls[0])
	}
	if calls[1].Namespace != "southwest.com" || !calls[1].Force ||
		!strings.Contains(calls[1].Source, "...([login])") || !strings.Contains(calls[1].Source, "...([search])") {
		t.Errorf("southwest batch = %+v", calls[1])
	}
	if !strings.Contains(out.String(), "attached 3 tool(s) to Kernel browser abc") {
		t.Errorf("attach output:\n%s", out.String())
	}

	if err := run(t, app, "attach"); err == nil {
		t.Error("attach without a running extension should fail")
	}
}
