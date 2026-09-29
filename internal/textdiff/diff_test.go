package textdiff

import "testing"

func TestUnifiedIdentical(t *testing.T) {
	if got := Unified("a.js", "x\ny\n", "x\ny\n"); got != "" {
		t.Errorf("expected empty diff, got %q", got)
	}
}

func TestUnifiedChange(t *testing.T) {
	old := "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\n"
	updated := "one\ntwo\nthree\nFOUR\nfive\nsix\nseven\neight\n"
	got := Unified("f.js", old, updated)
	want := "--- a/f.js\n+++ b/f.js\n@@ -1,7 +1,7 @@\n one\n two\n three\n-four\n+FOUR\n five\n six\n seven\n"
	if got != want {
		t.Errorf("diff mismatch:\n%s\nwant:\n%s", got, want)
	}
}

func TestUnifiedTwoHunks(t *testing.T) {
	old := "a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk\nl\n"
	updated := "A\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk\nL\n"
	got := Unified("f.js", old, updated)
	want := "--- a/f.js\n+++ b/f.js\n@@ -1,4 +1,4 @@\n-a\n+A\n b\n c\n d\n@@ -9,4 +9,4 @@\n i\n j\n k\n-l\n+L\n"
	if got != want {
		t.Errorf("diff mismatch:\n%s\nwant:\n%s", got, want)
	}
}

func TestUnifiedAppend(t *testing.T) {
	got := Unified("f.js", "", "new\n")
	want := "--- a/f.js\n+++ b/f.js\n@@ -1,0 +1,1 @@\n+new\n"
	if got != want {
		t.Errorf("diff mismatch:\n%s\nwant:\n%s", got, want)
	}
}
