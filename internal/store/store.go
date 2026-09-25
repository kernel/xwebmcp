// Package store manages the local xwebmcp state directory: installed tool
// sources pinned to a commit and the lockfile that records them.
package store

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

const (
	lockFileName = "lock.json"
	toolsDirName = "tools"
	lockVersion  = 1
)

// Tool is one installed tool file.
type Tool struct {
	Namespace   string   `json:"namespace"`
	Name        string   `json:"name"`
	File        string   `json:"file"`
	Kind        string   `json:"kind,omitempty"`
	URLPatterns []string `json:"url_patterns,omitempty"`
	Status      string   `json:"status,omitempty"`
	SHA256      string   `json:"sha256"`
}

// Source is a GitHub location pinned to a commit.
type Source struct {
	Spec      string    `json:"spec"`
	Owner     string    `json:"owner"`
	Repo      string    `json:"repo"`
	Path      string    `json:"path,omitempty"`
	Ref       string    `json:"ref"`
	Commit    string    `json:"commit"`
	UpdatedAt time.Time `json:"updated_at"`
	Tools     []Tool    `json:"tools"`
}

// Key identifies a source independently of the ref it was pinned to.
func (s Source) Key() string {
	return strings.ToLower(s.Owner + "/" + s.Repo + "/" + s.Path)
}

// Lock is the on-disk lockfile.
type Lock struct {
	Version int      `json:"version"`
	Sources []Source `json:"sources"`
}

// Store is a state directory.
type Store struct {
	Dir string
}

// DefaultDir returns $XWEBMCP_HOME or ~/.xwebmcp.
func DefaultDir() (string, error) {
	if dir := os.Getenv("XWEBMCP_HOME"); dir != "" {
		return dir, nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".xwebmcp"), nil
}

// Open returns a store rooted at dir, creating it when missing.
func Open(dir string) (*Store, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, fmt.Errorf("create state dir: %w", err)
	}
	return &Store{Dir: dir}, nil
}

func (s *Store) lockPath() string { return filepath.Join(s.Dir, lockFileName) }

// ToolsDir is where tool sources live.
func (s *Store) ToolsDir() string { return filepath.Join(s.Dir, toolsDirName) }

// ReadLock loads the lockfile; a missing file yields an empty lock.
func (s *Store) ReadLock() (*Lock, error) {
	data, err := os.ReadFile(s.lockPath())
	if errors.Is(err, os.ErrNotExist) {
		return &Lock{Version: lockVersion}, nil
	}
	if err != nil {
		return nil, err
	}
	var lock Lock
	if err := json.Unmarshal(data, &lock); err != nil {
		return nil, fmt.Errorf("parse %s: %w", s.lockPath(), err)
	}
	if lock.Version != lockVersion {
		return nil, fmt.Errorf("%s has unsupported version %d", s.lockPath(), lock.Version)
	}
	return &lock, nil
}

// WriteLock atomically replaces the lockfile.
func (s *Store) WriteLock(lock *Lock) error {
	lock.Version = lockVersion
	sort.Slice(lock.Sources, func(i, j int) bool { return lock.Sources[i].Key() < lock.Sources[j].Key() })
	for i := range lock.Sources {
		tools := lock.Sources[i].Tools
		sort.Slice(tools, func(a, b int) bool {
			if tools[a].Namespace != tools[b].Namespace {
				return tools[a].Namespace < tools[b].Namespace
			}
			return tools[a].Name < tools[b].Name
		})
	}
	data, err := json.MarshalIndent(lock, "", "  ")
	if err != nil {
		return err
	}
	return writeAtomic(s.lockPath(), append(data, '\n'), 0o600)
}

// SourcePath returns the local path of a tool file for a source.
func (s *Store) SourcePath(src Source, file string) string {
	return filepath.Join(s.ToolsDir(), src.Owner, src.Repo, filepath.FromSlash(file))
}

// ReadToolSource returns the stored source text for a tool.
func (s *Store) ReadToolSource(src Source, tool Tool) (string, error) {
	data, err := os.ReadFile(s.SourcePath(src, tool.File))
	if err != nil {
		return "", err
	}
	return string(data), nil
}

// WriteToolSource stores a tool file.
func (s *Store) WriteToolSource(src Source, file string, data []byte) error {
	path := s.SourcePath(src, file)
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	return writeAtomic(path, data, 0o600)
}

// RemoveSourceFiles deletes every stored file for a source.
func (s *Store) RemoveSourceFiles(src Source) error {
	for _, tool := range src.Tools {
		path := s.SourcePath(src, tool.File)
		if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
		if err := removeEmptyParents(filepath.Dir(path), s.ToolsDir()); err != nil {
			return err
		}
	}
	return nil
}

// InstalledTool pairs a tool with its source.
type InstalledTool struct {
	Source Source
	Tool   Tool
}

// Installed lists every tool across sources, sorted by namespace then name.
func (l *Lock) Installed() []InstalledTool {
	var out []InstalledTool
	for _, src := range l.Sources {
		for _, tool := range src.Tools {
			out = append(out, InstalledTool{Source: src, Tool: tool})
		}
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Tool.Namespace != out[j].Tool.Namespace {
			return out[i].Tool.Namespace < out[j].Tool.Namespace
		}
		return out[i].Tool.Name < out[j].Tool.Name
	})
	return out
}

// FindSource returns the index of the source with the given key, or -1.
func (l *Lock) FindSource(key string) int {
	for i, src := range l.Sources {
		if src.Key() == key {
			return i
		}
	}
	return -1
}

// Digest returns the hex SHA-256 of data.
func Digest(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

func writeAtomic(path string, data []byte, mode os.FileMode) error {
	tmp, err := os.CreateTemp(filepath.Dir(path), "."+filepath.Base(path)+".*.tmp")
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		os.Remove(tmpPath)
		return err
	}
	if err := tmp.Chmod(mode); err != nil {
		tmp.Close()
		os.Remove(tmpPath)
		return err
	}
	if err := tmp.Close(); err != nil {
		os.Remove(tmpPath)
		return err
	}
	return os.Rename(tmpPath, path)
}

func removeEmptyParents(dir, stop string) error {
	dir = filepath.Clean(dir)
	stop = filepath.Clean(stop)
	for dir != stop && strings.HasPrefix(dir, stop) {
		entries, err := os.ReadDir(dir)
		if errors.Is(err, os.ErrNotExist) || (err == nil && len(entries) > 0) {
			return nil
		}
		if err != nil {
			return err
		}
		if err := os.Remove(dir); err != nil {
			return err
		}
		dir = filepath.Dir(dir)
	}
	return nil
}
