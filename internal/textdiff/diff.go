// Package textdiff produces unified diffs of text files.
package textdiff

import (
	"fmt"
	"strings"
)

type op struct {
	kind byte // ' ', '-', '+'
	text string
}

// Unified returns a unified diff between old and new text with three lines of
// context, or an empty string when they are identical.
func Unified(name, oldText, newText string) string {
	if oldText == newText {
		return ""
	}
	a := splitLines(oldText)
	b := splitLines(newText)
	ops := diff(a, b)

	var sb strings.Builder
	fmt.Fprintf(&sb, "--- a/%s\n+++ b/%s\n", name, name)
	const context = 3
	i := 0
	for i < len(ops) {
		if ops[i].kind == ' ' {
			i++
			continue
		}
		start := max(i-context, 0)
		end := i
		for end < len(ops) {
			if ops[end].kind != ' ' {
				end++
				continue
			}
			run := end
			for run < len(ops) && ops[run].kind == ' ' {
				run++
			}
			if run-end > 2*context && run < len(ops) {
				end += context
				break
			}
			if run >= len(ops) {
				end = min(end+context, len(ops))
				break
			}
			end = run
		}
		writeHunk(&sb, ops, start, end)
		i = end
	}
	return sb.String()
}

func writeHunk(sb *strings.Builder, ops []op, start, end int) {
	oldStart, newStart := 1, 1
	for _, o := range ops[:start] {
		if o.kind != '+' {
			oldStart++
		}
		if o.kind != '-' {
			newStart++
		}
	}
	oldCount, newCount := 0, 0
	for _, o := range ops[start:end] {
		if o.kind != '+' {
			oldCount++
		}
		if o.kind != '-' {
			newCount++
		}
	}
	fmt.Fprintf(sb, "@@ -%d,%d +%d,%d @@\n", oldStart, oldCount, newStart, newCount)
	for _, o := range ops[start:end] {
		sb.WriteByte(o.kind)
		sb.WriteString(o.text)
		sb.WriteByte('\n')
	}
}

func splitLines(s string) []string {
	if s == "" {
		return nil
	}
	s = strings.TrimSuffix(s, "\n")
	return strings.Split(s, "\n")
}

// diff computes an edit script using an LCS table.
func diff(a, b []string) []op {
	n, m := len(a), len(b)
	lcs := make([][]int, n+1)
	for i := range lcs {
		lcs[i] = make([]int, m+1)
	}
	for i := n - 1; i >= 0; i-- {
		for j := m - 1; j >= 0; j-- {
			if a[i] == b[j] {
				lcs[i][j] = lcs[i+1][j+1] + 1
			} else {
				lcs[i][j] = max(lcs[i+1][j], lcs[i][j+1])
			}
		}
	}
	var ops []op
	i, j := 0, 0
	for i < n && j < m {
		switch {
		case a[i] == b[j]:
			ops = append(ops, op{' ', a[i]})
			i++
			j++
		case lcs[i+1][j] >= lcs[i][j+1]:
			ops = append(ops, op{'-', a[i]})
			i++
		default:
			ops = append(ops, op{'+', b[j]})
			j++
		}
	}
	for ; i < n; i++ {
		ops = append(ops, op{'-', a[i]})
	}
	for ; j < m; j++ {
		ops = append(ops, op{'+', b[j]})
	}
	return ops
}
