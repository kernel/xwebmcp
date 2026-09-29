package cli

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/urfave/cli/v3"

	"github.com/kernel/xwebmcp/internal/github"
	"github.com/kernel/xwebmcp/internal/store"
	"github.com/kernel/xwebmcp/internal/textdiff"
)

func (a *App) addCommand() *cli.Command {
	return &cli.Command{
		Name:      "add",
		Usage:     "install tool files from GitHub, pinned to a commit",
		ArgsUsage: "<github url | owner/repo[/path][@ref]>",
		Description: `Fetches every tool file the source selects and stores it under the state
directory with a lockfile entry pinned to the resolved commit. When the repository
has a registry.json, its entries decide which files are tools and which namespace
each belongs to; otherwise every .js file under the path is a tool and its
parent directory is the namespace.

Running add again for a source already installed updates it to the current
commit of its ref and prints a diff of every file whose code changed.`,
		Flags: []cli.Flag{
			&cli.BoolFlag{Name: "no-diff", Usage: "do not print diffs for updated files"},
		},
		Action: func(ctx context.Context, cmd *cli.Command) error {
			if cmd.NArg() != 1 {
				return errors.New("usage: xwebmcp add <github url | owner/repo[/path][@ref]>")
			}
			return a.add(ctx, cmd.Args().First(), !cmd.Bool("no-diff"))
		},
	}
}

func (a *App) add(ctx context.Context, raw string, showDiff bool) error {
	spec, err := github.ParseSpec(raw)
	if err != nil {
		return err
	}
	st, err := a.store()
	if err != nil {
		return err
	}
	lock, err := st.ReadLock()
	if err != nil {
		return err
	}
	snapshot, err := a.GitHub.Fetch(ctx, spec)
	if err != nil {
		return fmt.Errorf("fetch %s: %w", spec, err)
	}

	next := store.Source{
		Spec:      spec.String(),
		Owner:     spec.Owner,
		Repo:      spec.Repo,
		Path:      spec.Path,
		Ref:       snapshot.Ref,
		Commit:    snapshot.Commit,
		UpdatedAt: time.Now().UTC(),
	}
	for file, data := range snapshot.Files {
		namespace, name, kind, status, patterns := github.NamespaceFor(snapshot.Registry, file)
		next.Tools = append(next.Tools, store.Tool{
			Namespace:   namespace,
			Name:        name,
			File:        file,
			Kind:        kind,
			URLPatterns: patterns,
			Status:      status,
			SHA256:      store.Digest(data),
		})
	}

	var previous *store.Source
	if i := lock.FindSource(next.Key()); i >= 0 {
		prev := lock.Sources[i]
		previous = &prev
	}

	added, changed, removed := 0, 0, 0
	previousTools := map[string]store.Tool{}
	if previous != nil {
		for _, tool := range previous.Tools {
			previousTools[tool.File] = tool
		}
	}
	for _, tool := range next.Tools {
		data := snapshot.Files[tool.File]
		old, existed := previousTools[tool.File]
		switch {
		case !existed:
			added++
			a.printf("+ %s/%s (%s)\n", tool.Namespace, tool.Name, tool.File)
		case old.SHA256 != tool.SHA256:
			changed++
			a.printf("~ %s/%s (%s)\n", tool.Namespace, tool.Name, tool.File)
			if showDiff {
				oldText, err := st.ReadToolSource(*previous, old)
				if err == nil {
					a.printf("%s", textdiff.Unified(tool.File, oldText, string(data)))
				}
			}
		}
		if err := st.WriteToolSource(next, tool.File, data); err != nil {
			return err
		}
		delete(previousTools, tool.File)
	}
	for file, tool := range previousTools {
		removed++
		a.printf("- %s/%s (%s)\n", tool.Namespace, tool.Name, file)
		if err := st.RemoveSourceFiles(store.Source{Owner: next.Owner, Repo: next.Repo, Tools: []store.Tool{tool}}); err != nil {
			return err
		}
	}

	if i := lock.FindSource(next.Key()); i >= 0 {
		lock.Sources[i] = next
	} else {
		lock.Sources = append(lock.Sources, next)
	}
	if err := st.WriteLock(lock); err != nil {
		return err
	}

	short := snapshot.Commit
	if len(short) > 12 {
		short = short[:12]
	}
	switch {
	case previous == nil:
		a.printf("installed %d tool(s) from %s at %s (%s)\n", len(next.Tools), spec, snapshot.Ref, short)
	case previous.Commit == next.Commit:
		a.printf("%s is already at %s (%s); nothing changed\n", spec, snapshot.Ref, short)
	default:
		a.printf("updated %s from %s to %s: %d added, %d changed, %d removed\n", spec, previous.Commit[:12], short, added, changed, removed)
	}
	if len(next.Tools) > 0 {
		a.printf("run `xwebmcp attach` to push the tools into a browser\n")
	}
	return nil
}
