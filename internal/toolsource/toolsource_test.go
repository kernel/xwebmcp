package toolsource

import "testing"

func TestNormalize(t *testing.T) {
	cases := map[string]string{
		"[1]":              "[1]",
		"  [1]\n":          "[1]",
		"[1];\n":           "[1]",
		"[1];;\n  ":        "[1]",
		"(() => [1])()\n;": "(() => [1])()",
	}
	for in, want := range cases {
		if got := Normalize(in); got != want {
			t.Errorf("Normalize(%q) = %q, want %q", in, got, want)
		}
	}
}
