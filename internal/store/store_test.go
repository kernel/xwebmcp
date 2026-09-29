package store

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLockRoundTrip(t *testing.T) {
	st, err := Open(filepath.Join(t.TempDir(), "state"))
	if err != nil {
		t.Fatal(err)
	}
	lock, err := st.ReadLock()
	if err != nil {
		t.Fatal(err)
	}
	if len(lock.Sources) != 0 {
		t.Fatalf("fresh lock has sources: %+v", lock.Sources)
	}
	src := Source{Spec: "kernel/xwebmcp", Owner: "kernel", Repo: "xwebmcp", Ref: "main", Commit: "abc"}
	src.Tools = []Tool{
		{Namespace: "united.com", Name: "search_flights", File: "domains/united.com/search_flights.js", SHA256: Digest([]byte("b"))},
		{Namespace: "aa.com", Name: "search_flights", File: "domains/aa.com/search_flights.js", SHA256: Digest([]byte("a"))},
	}
	if err := st.WriteToolSource(src, "domains/aa.com/search_flights.js", []byte("a")); err != nil {
		t.Fatal(err)
	}
	lock.Sources = append(lock.Sources, src)
	if err := st.WriteLock(lock); err != nil {
		t.Fatal(err)
	}
	reloaded, err := st.ReadLock()
	if err != nil {
		t.Fatal(err)
	}
	if reloaded.Version != lockVersion || len(reloaded.Sources) != 1 {
		t.Fatalf("reloaded = %+v", reloaded)
	}
	if reloaded.Sources[0].Tools[0].Namespace != "aa.com" {
		t.Errorf("tools not sorted: %+v", reloaded.Sources[0].Tools)
	}
	text, err := st.ReadToolSource(src, Tool{File: "domains/aa.com/search_flights.js"})
	if err != nil || text != "a" {
		t.Errorf("read source = %q, %v", text, err)
	}
	installed := reloaded.Installed()
	if len(installed) != 2 || installed[0].Tool.Namespace != "aa.com" {
		t.Errorf("installed = %+v", installed)
	}
	if reloaded.FindSource("kernel/xwebmcp/") != 0 || reloaded.FindSource("nope") != -1 {
		t.Error("FindSource mismatch")
	}
	if err := st.RemoveSourceFiles(src); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(st.ToolsDir(), "kernel")); !os.IsNotExist(err) {
		t.Errorf("source directory not cleaned up: %v", err)
	}
	info, err := os.Stat(st.lockPath())
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Errorf("lock mode = %o", info.Mode().Perm())
	}
}

func TestDefaultDirHonorsEnv(t *testing.T) {
	t.Setenv("XWEBMCP_HOME", "/tmp/xw-test")
	dir, err := DefaultDir()
	if err != nil || dir != "/tmp/xw-test" {
		t.Errorf("DefaultDir = %q, %v", dir, err)
	}
}
