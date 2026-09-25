package extension

import (
	"os"
	"path/filepath"
	"testing"
)

func TestID(t *testing.T) {
	id, err := ID()
	if err != nil {
		t.Fatal(err)
	}
	if len(id) != 32 {
		t.Fatalf("id = %q", id)
	}
	for _, c := range id {
		if c < 'a' || c > 'p' {
			t.Fatalf("id %q has a character outside a-p", id)
		}
	}
	// The key in manifest.json is fixed; the ID must stay stable so the native
	// messaging manifest keeps allowing it.
	if id != "gonbafhnhdlffidehindilafagapamff" {
		t.Errorf("id = %q; the manifest key changed", id)
	}
}

func TestWrite(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "ext")
	if err := os.MkdirAll(filepath.Join(dir, "tools"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "tools", "keep.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := Write(dir); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"manifest.json", "background.js", "sandbox/sandbox.html", "content/agent.js", "lib/url-pattern.js", "popup.html"} {
		if _, err := os.Stat(filepath.Join(dir, name)); err != nil {
			t.Errorf("%s not written: %v", name, err)
		}
	}
	if _, err := os.Stat(filepath.Join(dir, "tools", "keep.txt")); err != nil {
		t.Error("existing files must be left in place")
	}
	if err := Write(dir); err != nil {
		t.Errorf("second Write: %v", err)
	}
}
