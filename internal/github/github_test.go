package github

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestParseSpec(t *testing.T) {
	cases := []struct {
		in   string
		want Spec
		err  bool
	}{
		{in: "kernel/xwebmcp", want: Spec{Owner: "kernel", Repo: "xwebmcp"}},
		{in: "kernel/xwebmcp@v1", want: Spec{Owner: "kernel", Repo: "xwebmcp", Ref: "v1"}},
		{in: "kernel/xwebmcp/domains/southwest.com@main", want: Spec{Owner: "kernel", Repo: "xwebmcp", Path: "domains/southwest.com", Ref: "main"}},
		{in: "https://github.com/kernel/xwebmcp", want: Spec{Owner: "kernel", Repo: "xwebmcp"}},
		{in: "https://github.com/kernel/xwebmcp.git", want: Spec{Owner: "kernel", Repo: "xwebmcp"}},
		{in: "https://github.com/kernel/xwebmcp/tree/main/domains/aa.com", want: Spec{Owner: "kernel", Repo: "xwebmcp", Path: "domains/aa.com", Ref: "main"}},
		{in: "https://github.com/kernel/xwebmcp/blob/abc123/domains/aa.com/search_flights.js", want: Spec{Owner: "kernel", Repo: "xwebmcp", Path: "domains/aa.com/search_flights.js", Ref: "abc123"}},
		{in: "github.com/kernel/xwebmcp", want: Spec{Owner: "kernel", Repo: "xwebmcp"}},
		{in: "kernel", err: true},
		{in: "https://gitlab.com/kernel/xwebmcp", err: true},
		{in: "kernel/xwebmcp/../etc", err: true},
		{in: "kernel/xwebmcp@", err: true},
		{in: "", err: true},
	}
	for _, tc := range cases {
		got, err := ParseSpec(tc.in)
		if tc.err {
			if err == nil {
				t.Errorf("ParseSpec(%q) expected error, got %+v", tc.in, got)
			}
			continue
		}
		if err != nil {
			t.Errorf("ParseSpec(%q): %v", tc.in, err)
			continue
		}
		if got != tc.want {
			t.Errorf("ParseSpec(%q) = %+v, want %+v", tc.in, got, tc.want)
		}
	}
}

func TestSelectFiles(t *testing.T) {
	blobs := map[string]bool{
		"README.md":                            true,
		"registry.json":                        true,
		"domains/aa.com/search_flights.js":     true,
		"domains/united.com/login.js":          true,
		"domains/united.com/search_flights.js": true,
		"tests/aa.com.test.mjs":                true,
		"node_modules/x/index.js":              true,
	}
	registry := &Registry{Tools: []RegistryEntry{
		{Domain: "aa.com", Tool: "search_flights", File: "domains/aa.com/search_flights.js"},
		{Domain: "united.com", Tool: "login", File: "domains/united.com/login.js"},
		{Domain: "gone.com", Tool: "x", File: "domains/gone.com/x.js"},
	}}
	got := SelectFiles(blobs, registry, "")
	want := []string{"domains/aa.com/search_flights.js", "domains/united.com/login.js"}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Errorf("registry selection = %v, want %v", got, want)
	}
	got = SelectFiles(blobs, registry, "domains/united.com")
	if strings.Join(got, ",") != "domains/united.com/login.js" {
		t.Errorf("prefix selection = %v", got)
	}
	for _, prefix := range []string{"domains/united.com/search_flights.js", "tests", "node_modules"} {
		if got := SelectFiles(blobs, registry, prefix); len(got) != 0 {
			t.Errorf("registry path %q selected unlisted files: %v", prefix, got)
		}
	}
	got = SelectFiles(blobs, nil, "")
	want = []string{"domains/aa.com/search_flights.js", "domains/united.com/login.js", "domains/united.com/search_flights.js"}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Errorf("scan selection = %v, want %v", got, want)
	}
	got = SelectFiles(blobs, nil, "domains/united.com/login.js")
	if strings.Join(got, ",") != "domains/united.com/login.js" {
		t.Errorf("file selection = %v", got)
	}
}

func TestNamespaceFor(t *testing.T) {
	registry := &Registry{Tools: []RegistryEntry{{Domain: "aa.com", Tool: "search_flights", File: "domains/aa.com/search_flights.js", Kind: "cdp", Status: "verified", URLPatterns: []string{"https://aa.com/*"}}}}
	ns, tool, kind, status, patterns := NamespaceFor(registry, "domains/aa.com/search_flights.js")
	if ns != "aa.com" || tool != "search_flights" || kind != "cdp" || status != "verified" || len(patterns) != 1 {
		t.Errorf("registry namespace = %s %s %s %s %v", ns, tool, kind, status, patterns)
	}
	ns, tool, kind, _, _ = NamespaceFor(registry, "domains/delta.com/search_flights.js")
	if ns != "delta.com" || tool != "search_flights" || kind != "" {
		t.Errorf("fallback namespace = %s %s %s", ns, tool, kind)
	}
	ns, tool, _, _, _ = NamespaceFor(nil, "tool.js")
	if ns != "tool" || tool != "tool" {
		t.Errorf("root namespace = %s %s", ns, tool)
	}
}

// FakeRepo serves the subset of the GitHub API the client uses.
type FakeRepo struct {
	DefaultBranch string
	Commits       map[string]string // ref -> sha
	Files         map[string]string // path -> content, served at every commit
}

func (f *FakeRepo) Server(t *testing.T) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("/repos/owner/repo", func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]string{"default_branch": f.DefaultBranch})
	})
	mux.HandleFunc("/repos/owner/repo/commits/", func(w http.ResponseWriter, r *http.Request) {
		ref := strings.TrimPrefix(r.URL.Path, "/repos/owner/repo/commits/")
		sha, ok := f.Commits[ref]
		if !ok {
			http.NotFound(w, r)
			return
		}
		w.Write([]byte(sha))
	})
	mux.HandleFunc("/repos/owner/repo/git/trees/", func(w http.ResponseWriter, r *http.Request) {
		var tree []map[string]string
		for path := range f.Files {
			tree = append(tree, map[string]string{"path": path, "type": "blob"})
		}
		json.NewEncoder(w).Encode(map[string]any{"tree": tree})
	})
	mux.HandleFunc("/owner/repo/", func(w http.ResponseWriter, r *http.Request) {
		parts := strings.SplitN(strings.TrimPrefix(r.URL.Path, "/owner/repo/"), "/", 2)
		content, ok := f.Files[parts[1]]
		if !ok {
			http.NotFound(w, r)
			return
		}
		w.Write([]byte(content))
	})
	return httptest.NewServer(mux)
}

func TestFetch(t *testing.T) {
	repo := &FakeRepo{
		DefaultBranch: "main",
		Commits:       map[string]string{"main": strings.Repeat("a", 40)},
		Files: map[string]string{
			"registry.json":                    `{"tools":[{"domain":"aa.com","tool":"search_flights","file":"domains/aa.com/search_flights.js","kind":"cdp"}]}`,
			"domains/aa.com/search_flights.js": "[{kind:'cdp'}]",
			"domains/aa.com/README.md":         "# aa",
		},
	}
	srv := repo.Server(t)
	defer srv.Close()
	client := &Client{HTTP: srv.Client(), APIBase: srv.URL, RawBase: srv.URL}
	snapshot, err := client.Fetch(context.Background(), Spec{Owner: "owner", Repo: "repo"})
	if err != nil {
		t.Fatal(err)
	}
	if snapshot.Ref != "main" || snapshot.Commit != strings.Repeat("a", 40) {
		t.Errorf("resolved %s %s", snapshot.Ref, snapshot.Commit)
	}
	if snapshot.Registry == nil || len(snapshot.Registry.Tools) != 1 {
		t.Errorf("registry not parsed: %+v", snapshot.Registry)
	}
	if string(snapshot.Files["domains/aa.com/search_flights.js"]) != "[{kind:'cdp'}]" || len(snapshot.Files) != 1 {
		t.Errorf("files = %v", snapshot.Files)
	}
	if _, err := client.Fetch(context.Background(), Spec{Owner: "owner", Repo: "repo", Ref: "missing"}); err == nil {
		t.Error("expected missing ref to fail")
	}
}
