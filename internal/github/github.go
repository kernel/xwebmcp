// Package github resolves tool sources hosted on GitHub.
package github

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path"
	"regexp"
	"strings"
)

// Spec is a parsed source specifier.
type Spec struct {
	Owner string
	Repo  string
	Path  string // slash-separated path inside the repo, may be empty
	Ref   string // branch, tag, or commit; empty means the default branch
}

// String renders the spec in owner/repo[/path][@ref] form.
func (s Spec) String() string {
	out := s.Owner + "/" + s.Repo
	if s.Path != "" {
		out += "/" + s.Path
	}
	if s.Ref != "" {
		out += "@" + s.Ref
	}
	return out
}

var namePattern = regexp.MustCompile(`^[A-Za-z0-9_.-]+$`)

// ParseSpec accepts:
//
//	owner/repo
//	owner/repo@ref
//	owner/repo/path/to/dir@ref
//	https://github.com/owner/repo
//	https://github.com/owner/repo/tree/<ref>/<path>
//	https://github.com/owner/repo/blob/<ref>/<file>
func ParseSpec(raw string) (Spec, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return Spec{}, errors.New("source is required")
	}
	if strings.Contains(raw, "://") || strings.HasPrefix(raw, "github.com/") {
		return parseURL(raw)
	}
	var spec Spec
	if at := strings.LastIndex(raw, "@"); at >= 0 {
		spec.Ref = raw[at+1:]
		raw = raw[:at]
		if spec.Ref == "" {
			return Spec{}, errors.New("ref after @ must not be empty")
		}
	}
	parts := strings.Split(strings.Trim(raw, "/"), "/")
	if len(parts) < 2 {
		return Spec{}, fmt.Errorf("source %q must look like owner/repo[/path][@ref]", raw)
	}
	spec.Owner, spec.Repo = parts[0], parts[1]
	spec.Path = path.Clean(strings.Join(parts[2:], "/"))
	if spec.Path == "." {
		spec.Path = ""
	}
	return spec, spec.validate()
}

func parseURL(raw string) (Spec, error) {
	if !strings.Contains(raw, "://") {
		raw = "https://" + raw
	}
	u, err := url.Parse(raw)
	if err != nil {
		return Spec{}, err
	}
	if !strings.EqualFold(u.Host, "github.com") {
		return Spec{}, fmt.Errorf("only github.com URLs are supported, got %s", u.Host)
	}
	parts := strings.Split(strings.Trim(u.Path, "/"), "/")
	if len(parts) < 2 {
		return Spec{}, fmt.Errorf("URL %q must include owner and repository", raw)
	}
	spec := Spec{Owner: parts[0], Repo: strings.TrimSuffix(parts[1], ".git")}
	rest := parts[2:]
	if len(rest) >= 2 && (rest[0] == "tree" || rest[0] == "blob") {
		spec.Ref = rest[1]
		spec.Path = strings.Join(rest[2:], "/")
	} else if len(rest) > 0 {
		return Spec{}, fmt.Errorf("unsupported GitHub URL path %q; use /tree/<ref>/<path>", u.Path)
	}
	return spec, spec.validate()
}

func (s Spec) validate() error {
	if !namePattern.MatchString(s.Owner) || !namePattern.MatchString(s.Repo) {
		return fmt.Errorf("invalid repository %q/%q", s.Owner, s.Repo)
	}
	if strings.HasPrefix(s.Path, "../") || s.Path == ".." || strings.Contains(s.Path, "/../") {
		return fmt.Errorf("invalid path %q", s.Path)
	}
	return nil
}

// RegistryEntry is one tool in a repository's registry.json.
type RegistryEntry struct {
	Domain      string   `json:"domain"`
	Tool        string   `json:"tool"`
	File        string   `json:"file"`
	Kind        string   `json:"kind"`
	Namespace   string   `json:"namespace"`
	URLPatterns []string `json:"url_patterns"`
	Status      string   `json:"status"`
}

// Registry is the parsed registry.json.
type Registry struct {
	Tools []RegistryEntry `json:"tools"`
}

// Snapshot is the resolved content of a spec at one commit.
type Snapshot struct {
	Spec     Spec
	Ref      string
	Commit   string
	Files    map[string][]byte // repo path -> content
	Registry *Registry         // nil when the repo has no registry.json
}

// Client fetches repository content.
type Client struct {
	HTTP    *http.Client
	APIBase string // default https://api.github.com
	RawBase string // default https://raw.githubusercontent.com
	Token   string
}

// NewClient builds a client that honors GITHUB_TOKEN / GH_TOKEN.
func NewClient() *Client {
	token := os.Getenv("GITHUB_TOKEN")
	if token == "" {
		token = os.Getenv("GH_TOKEN")
	}
	return &Client{HTTP: http.DefaultClient, Token: token}
}

func (c *Client) apiBase() string {
	if c.APIBase != "" {
		return strings.TrimSuffix(c.APIBase, "/")
	}
	return "https://api.github.com"
}

func (c *Client) rawBase() string {
	if c.RawBase != "" {
		return strings.TrimSuffix(c.RawBase, "/")
	}
	return "https://raw.githubusercontent.com"
}

func (c *Client) get(ctx context.Context, u, accept string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return nil, err
	}
	if accept != "" {
		req.Header.Set("Accept", accept)
	}
	if c.Token != "" {
		req.Header.Set("Authorization", "Bearer "+c.Token)
	}
	req.Header.Set("User-Agent", "xwebmcp")
	res, err := c.HTTP.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	body, err := io.ReadAll(io.LimitReader(res.Body, 64<<20))
	if err != nil {
		return nil, err
	}
	if res.StatusCode == http.StatusNotFound {
		return nil, fmt.Errorf("%s: not found", u)
	}
	if res.StatusCode/100 != 2 {
		return nil, fmt.Errorf("%s: HTTP %d: %s", u, res.StatusCode, strings.TrimSpace(string(body)))
	}
	return body, nil
}

// ResolveCommit maps a ref (or the default branch) to a commit SHA.
func (c *Client) ResolveCommit(ctx context.Context, spec Spec) (ref, commit string, err error) {
	ref = spec.Ref
	if ref == "" {
		body, err := c.get(ctx, fmt.Sprintf("%s/repos/%s/%s", c.apiBase(), spec.Owner, spec.Repo), "application/vnd.github+json")
		if err != nil {
			return "", "", err
		}
		var repo struct {
			DefaultBranch string `json:"default_branch"`
		}
		if err := json.Unmarshal(body, &repo); err != nil || repo.DefaultBranch == "" {
			return "", "", fmt.Errorf("could not determine default branch of %s/%s", spec.Owner, spec.Repo)
		}
		ref = repo.DefaultBranch
	}
	body, err := c.get(ctx, fmt.Sprintf("%s/repos/%s/%s/commits/%s", c.apiBase(), spec.Owner, spec.Repo, url.PathEscape(ref)), "application/vnd.github.sha")
	if err != nil {
		return "", "", err
	}
	commit = strings.TrimSpace(string(body))
	if !regexp.MustCompile(`^[0-9a-f]{40}$`).MatchString(commit) {
		return "", "", fmt.Errorf("unexpected commit response for %s: %q", ref, commit)
	}
	return ref, commit, nil
}

type treeResponse struct {
	Tree []struct {
		Path string `json:"path"`
		Type string `json:"type"`
	} `json:"tree"`
	Truncated bool `json:"truncated"`
}

// Fetch resolves the spec and downloads the tool files it selects.
func (c *Client) Fetch(ctx context.Context, spec Spec) (*Snapshot, error) {
	ref, commit, err := c.ResolveCommit(ctx, spec)
	if err != nil {
		return nil, err
	}
	body, err := c.get(ctx, fmt.Sprintf("%s/repos/%s/%s/git/trees/%s?recursive=1", c.apiBase(), spec.Owner, spec.Repo, commit), "application/vnd.github+json")
	if err != nil {
		return nil, err
	}
	var tree treeResponse
	if err := json.Unmarshal(body, &tree); err != nil {
		return nil, fmt.Errorf("parse tree: %w", err)
	}
	if tree.Truncated {
		return nil, fmt.Errorf("%s/%s is too large to list", spec.Owner, spec.Repo)
	}
	snapshot := &Snapshot{Spec: spec, Ref: ref, Commit: commit, Files: map[string][]byte{}}
	blobs := map[string]bool{}
	for _, entry := range tree.Tree {
		if entry.Type == "blob" {
			blobs[entry.Path] = true
		}
	}
	if blobs["registry.json"] {
		data, err := c.raw(ctx, spec, commit, "registry.json")
		if err != nil {
			return nil, err
		}
		var registry Registry
		if err := json.Unmarshal(data, &registry); err != nil {
			return nil, fmt.Errorf("parse registry.json: %w", err)
		}
		snapshot.Registry = &registry
	}
	selected := SelectFiles(blobs, snapshot.Registry, spec.Path)
	if len(selected) == 0 {
		return nil, fmt.Errorf("no tool files found in %s at %s", spec, commit[:12])
	}
	for _, file := range selected {
		data, err := c.raw(ctx, spec, commit, file)
		if err != nil {
			return nil, err
		}
		snapshot.Files[file] = data
	}
	return snapshot, nil
}

func (c *Client) raw(ctx context.Context, spec Spec, commit, file string) ([]byte, error) {
	segments := strings.Split(file, "/")
	for i, s := range segments {
		segments[i] = url.PathEscape(s)
	}
	return c.get(ctx, fmt.Sprintf("%s/%s/%s/%s/%s", c.rawBase(), spec.Owner, spec.Repo, commit, strings.Join(segments, "/")), "")
}

// SelectFiles decides which repository files are tool files. With a registry,
// registry entries under prefix win; otherwise every .js file under prefix
// (or under domains/ when present at the root) is a tool file.
func SelectFiles(blobs map[string]bool, registry *Registry, prefix string) []string {
	var out []string
	seen := map[string]bool{}
	add := func(file string) {
		if !seen[file] && blobs[file] {
			seen[file] = true
			out = append(out, file)
		}
	}
	if registry != nil {
		for _, entry := range registry.Tools {
			if underPrefix(entry.File, prefix) {
				add(entry.File)
			}
		}
		if len(out) > 0 || prefix == "" {
			return out
		}
	}
	scanPrefix := prefix
	if scanPrefix == "" && hasDir(blobs, "domains") {
		scanPrefix = "domains"
	}
	for file := range blobs {
		if strings.HasSuffix(file, ".js") && underPrefix(file, scanPrefix) && !strings.Contains(file, "node_modules/") {
			add(file)
		}
	}
	sortStrings(out)
	return out
}

func hasDir(blobs map[string]bool, dir string) bool {
	for file := range blobs {
		if strings.HasPrefix(file, dir+"/") {
			return true
		}
	}
	return false
}

func underPrefix(file, prefix string) bool {
	if prefix == "" {
		return true
	}
	return file == prefix || strings.HasPrefix(file, strings.TrimSuffix(prefix, "/")+"/")
}

func sortStrings(s []string) {
	for i := 1; i < len(s); i++ {
		for j := i; j > 0 && s[j] < s[j-1]; j-- {
			s[j], s[j-1] = s[j-1], s[j]
		}
	}
}

// NamespaceFor derives the namespace of a tool file: its registry entry when
// present, otherwise the name of its parent directory.
func NamespaceFor(registry *Registry, file string) (namespace, tool, kind, status string, patterns []string) {
	if registry != nil {
		for _, entry := range registry.Tools {
			if entry.File == file {
				ns := entry.Namespace
				if ns == "" {
					ns = entry.Domain
				}
				return ns, entry.Tool, entry.Kind, entry.Status, entry.URLPatterns
			}
		}
	}
	dir := path.Dir(file)
	name := strings.TrimSuffix(path.Base(file), ".js")
	if dir == "." {
		return name, name, "", "", nil
	}
	return path.Base(dir), name, "", "", nil
}
