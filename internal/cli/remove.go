package cli

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/urfave/cli/v3"

	"github.com/kernel/xwebmcp/internal/github"
	"github.com/kernel/xwebmcp/internal/store"
)

func (a *App) removeCommand() *cli.Command {
	return &cli.Command{
		Name:      "remove",
		Usage:     "remove an installed source, namespace, or tool",
		ArgsUsage: "<owner/repo[/path] | namespace | namespace/tool>",
		Action: func(ctx context.Context, cmd *cli.Command) error {
			if cmd.NArg() != 1 {
				return errors.New("usage: xwebmcp remove <owner/repo[/path] | namespace | namespace/tool>")
			}
			return a.remove(cmd.Args().First())
		},
	}
}

func (a *App) remove(target string) error {
	st, err := a.store()
	if err != nil {
		return err
	}
	lock, err := st.ReadLock()
	if err != nil {
		return err
	}

	if spec, err := github.ParseSpec(target); err == nil {
		key := store.Source{Owner: spec.Owner, Repo: spec.Repo, Path: spec.Path}.Key()
		if i := lock.FindSource(key); i >= 0 {
			src := lock.Sources[i]
			if err := st.RemoveSourceFiles(src); err != nil {
				return err
			}
			lock.Sources = append(lock.Sources[:i], lock.Sources[i+1:]...)
			if err := st.WriteLock(lock); err != nil {
				return err
			}
			a.printf("removed %s (%d tool(s))\n", src.Spec, len(src.Tools))
			return nil
		}
	}

	namespace, tool, _ := strings.Cut(target, "/")
	removed := 0
	for i := range lock.Sources {
		src := &lock.Sources[i]
		var keep []store.Tool
		for _, t := range src.Tools {
			if t.Namespace == namespace && (tool == "" || t.Name == tool) {
				if err := st.RemoveSourceFiles(store.Source{Owner: src.Owner, Repo: src.Repo, Tools: []store.Tool{t}}); err != nil {
					return err
				}
				removed++
				a.printf("removed %s/%s (%s)\n", t.Namespace, t.Name, t.File)
				continue
			}
			keep = append(keep, t)
		}
		src.Tools = keep
	}
	var sources []store.Source
	for _, src := range lock.Sources {
		if len(src.Tools) > 0 {
			sources = append(sources, src)
		}
	}
	lock.Sources = sources
	if removed == 0 {
		return fmt.Errorf("nothing installed matches %q", target)
	}
	return st.WriteLock(lock)
}
