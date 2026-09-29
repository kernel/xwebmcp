// Package devwatch scans a local tool checkout and reports edits so the
// edited files can be reinstalled into a browser without a manual reload.
package devwatch

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/kernel/xwebmcp/internal/github"
)

// File is one tool file in a checkout.
type File struct {
	Namespace string
	Name      string
	Path      string // absolute
	Rel       string // slash-separated, relative to the root
	Source    string
	Digest    string
}

// Scan lists the tool files under root. root may be a single tool file, a
// domains/<namespace> directory, or a repository root with registry.json.
func Scan(root string) ([]File, error) {
	absolute, err := filepath.Abs(root)
	if err != nil {
		return nil, err
	}
	info, err := os.Stat(absolute)
	if err != nil {
		return nil, err
	}
	if !info.IsDir() {
		data, err := os.ReadFile(absolute)
		if err != nil {
			return nil, err
		}
		name := strings.TrimSuffix(filepath.Base(absolute), ".js")
		return []File{{
			Namespace: filepath.Base(filepath.Dir(absolute)),
			Name:      name,
			Path:      absolute,
			Rel:       filepath.Base(absolute),
			Source:    string(data),
			Digest:    digest(data),
		}}, nil
	}

	blobs := map[string]bool{}
	err = filepath.WalkDir(absolute, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() {
			if entry.Name() == "node_modules" || entry.Name() == ".git" || (path != absolute && strings.HasPrefix(entry.Name(), ".")) {
				return filepath.SkipDir
			}
			return nil
		}
		rel, _ := filepath.Rel(absolute, path)
		blobs[filepath.ToSlash(rel)] = true
		return nil
	})
	if err != nil {
		return nil, err
	}
	var registry *github.Registry
	if blobs["registry.json"] {
		data, err := os.ReadFile(filepath.Join(absolute, "registry.json"))
		if err != nil {
			return nil, err
		}
		var parsed github.Registry
		if err := json.Unmarshal(data, &parsed); err == nil {
			registry = &parsed
		}
	}
	var files []File
	for _, rel := range github.SelectFiles(blobs, registry, "") {
		path := filepath.Join(absolute, filepath.FromSlash(rel))
		data, err := os.ReadFile(path)
		if err != nil {
			return nil, err
		}
		namespace, name, _, _, _ := github.NamespaceFor(registry, rel)
		if !strings.Contains(rel, "/") && !inRegistry(registry, rel) {
			// Watching a domains/<namespace> directory: its files sit at the
			// top level, so the directory itself names the namespace.
			namespace = filepath.Base(absolute)
		}
		files = append(files, File{Namespace: namespace, Name: name, Path: path, Rel: rel, Source: string(data), Digest: digest(data)})
	}
	sort.Slice(files, func(i, j int) bool { return files[i].Rel < files[j].Rel })
	return files, nil
}

func inRegistry(registry *github.Registry, file string) bool {
	if registry == nil {
		return false
	}
	for _, entry := range registry.Tools {
		if entry.File == file {
			return true
		}
	}
	return false
}

func digest(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

// Change describes one edited, added, or removed file.
type Change struct {
	File    File
	Removed bool
}

// Watch polls root every interval and calls onChange with the files whose
// content changed since the previous scan. The initial scan is reported as
// changes too, so callers install everything on start.
func Watch(ctx context.Context, root string, interval time.Duration, onChange func([]Change)) error {
	known := map[string]File{}
	report := func() error {
		files, err := Scan(root)
		if err != nil {
			return err
		}
		var changes []Change
		seen := map[string]bool{}
		for _, file := range files {
			seen[file.Rel] = true
			if previous, ok := known[file.Rel]; !ok || previous.Digest != file.Digest {
				changes = append(changes, Change{File: file})
			}
			known[file.Rel] = file
		}
		for rel, file := range known {
			if !seen[rel] {
				changes = append(changes, Change{File: file, Removed: true})
				delete(known, rel)
			}
		}
		if len(changes) > 0 {
			onChange(changes)
		}
		return nil
	}
	if err := report(); err != nil {
		return err
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
			if err := report(); err != nil {
				onChange([]Change{{File: File{Rel: root, Source: err.Error()}}})
			}
		}
	}
}
