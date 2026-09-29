package devwatch

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestScanRepositoryRoot(t *testing.T) {
	root := t.TempDir()
	os.MkdirAll(filepath.Join(root, "domains", "a.test"), 0o755)
	os.MkdirAll(filepath.Join(root, "node_modules", "x"), 0o755)
	os.WriteFile(filepath.Join(root, "registry.json"), []byte(`{"tools":[{"domain":"a.test","tool":"search","file":"domains/a.test/search.js","kind":"cdp"}]}`), 0o644)
	os.WriteFile(filepath.Join(root, "domains", "a.test", "search.js"), []byte("[1]"), 0o644)
	os.WriteFile(filepath.Join(root, "domains", "a.test", "README.md"), []byte("#"), 0o644)
	os.WriteFile(filepath.Join(root, "node_modules", "x", "index.js"), []byte("x"), 0o644)
	files, err := Scan(root)
	if err != nil {
		t.Fatal(err)
	}
	if len(files) != 1 || files[0].Namespace != "a.test" || files[0].Name != "search" || files[0].Rel != "domains/a.test/search.js" || files[0].Source != "[1]" {
		t.Errorf("files = %+v", files)
	}
}

func TestScanDirectoryWithoutRegistry(t *testing.T) {
	root := t.TempDir()
	os.MkdirAll(filepath.Join(root, "b.test"), 0o755)
	os.WriteFile(filepath.Join(root, "b.test", "login.js"), []byte("[2]"), 0o644)
	files, err := Scan(root)
	if err != nil {
		t.Fatal(err)
	}
	if len(files) != 1 || files[0].Namespace != "b.test" || files[0].Name != "login" {
		t.Errorf("files = %+v", files)
	}
	single, err := Scan(filepath.Join(root, "b.test", "login.js"))
	if err != nil || len(single) != 1 || single[0].Namespace != "b.test" {
		t.Errorf("single = %+v, %v", single, err)
	}
}

func TestScanNamespaceDirectory(t *testing.T) {
	root := filepath.Join(t.TempDir(), "delta.com")
	os.MkdirAll(root, 0o755)
	os.WriteFile(filepath.Join(root, "login.js"), []byte("[3]"), 0o644)
	os.WriteFile(filepath.Join(root, "search_flights.js"), []byte("[4]"), 0o644)
	files, err := Scan(root)
	if err != nil {
		t.Fatal(err)
	}
	if len(files) != 2 {
		t.Fatalf("files = %+v", files)
	}
	for _, file := range files {
		if file.Namespace != "delta.com" {
			t.Errorf("%s namespace = %q, want delta.com", file.Rel, file.Namespace)
		}
	}
}

func TestWatchReportsEdits(t *testing.T) {
	root := t.TempDir()
	os.MkdirAll(filepath.Join(root, "c.test"), 0o755)
	path := filepath.Join(root, "c.test", "tool.js")
	os.WriteFile(path, []byte("[1]"), 0o644)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	changes := make(chan []Change, 10)
	go Watch(ctx, root, 20*time.Millisecond, func(c []Change) { changes <- c })

	first := <-changes
	if len(first) != 1 || first[0].File.Source != "[1]" || first[0].Removed {
		t.Fatalf("initial = %+v", first)
	}
	os.WriteFile(path, []byte("[2]"), 0o644)
	select {
	case edit := <-changes:
		if len(edit) != 1 || edit[0].File.Source != "[2]" {
			t.Fatalf("edit = %+v", edit)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("edit not reported")
	}
	os.Remove(path)
	select {
	case removed := <-changes:
		if len(removed) != 1 || !removed[0].Removed {
			t.Fatalf("removal = %+v", removed)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("removal not reported")
	}
}
