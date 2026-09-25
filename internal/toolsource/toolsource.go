// Package toolsource normalizes tool files before they are evaluated.
package toolsource

import "strings"

// Normalize trims surrounding whitespace and one trailing semicolon so the
// file is a bare expression that can be wrapped in parentheses. Tool files are
// documented as single expressions, but a formatter can add a terminator.
func Normalize(source string) string {
	source = strings.TrimSpace(source)
	for strings.HasSuffix(source, ";") {
		source = strings.TrimSpace(strings.TrimSuffix(source, ";"))
	}
	return source
}
