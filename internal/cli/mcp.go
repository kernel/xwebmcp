package cli

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/urfave/cli/v3"

	"github.com/kernel/xwebmcp/internal/devwatch"
	"github.com/kernel/xwebmcp/internal/mcpserver"
)

const devPollInterval = 500 * time.Millisecond

func (a *App) mcpCommand() *cli.Command {
	return &cli.Command{
		Name:  "mcp",
		Usage: "run a stdio MCP server exposing the browser's WebMCP tools",
		Description: `Exposes the tools of the xwebmcp Chrome extension (default) or of a Kernel
browser (--kernel) to MCP clients such as Claude Code, Codex, or Cursor:
list_tools, invoke_tool, install_tool, remove_tool, list_custom_tools, open_tab,
navigate_tab, close_tab, list_tabs, get_invocation, plus one MCP tool per
installed custom tool (namespace__name).

--dev watches a local checkout (a repository root, a domains/<namespace>
directory, or one tool file) and reinstalls edited tool files into the browser
as they change, so an agent can edit, invoke, read the failure, and fix.`,
		Flags: []cli.Flag{
			&cli.StringFlag{Name: "kernel", Usage: "Kernel browser session ID or name instead of the extension"},
			&cli.StringSliceFlag{Name: "dev", Usage: "local checkout to watch and reinstall on change (repeatable)"},
			&cli.BoolFlag{Name: "all-tabs", Usage: "list tools and tabs from every tab, not only tabs this server opened"},
		},
		Action: func(ctx context.Context, cmd *cli.Command) error {
			target, closeTarget, err := a.target(ctx, cmd.String("kernel"))
			if err != nil {
				return err
			}
			defer closeTarget()
			logf := func(format string, args ...any) { fmt.Fprintf(a.Stderr, "xwebmcp mcp: "+format+"\n", args...) }
			roots, err := absolutePaths(cmd.StringSlice("dev"))
			if err != nil {
				return err
			}
			server := mcpserver.New(mcpserver.Options{Target: target, AllTabs: cmd.Bool("all-tabs"), DevRoots: roots, Version: Version, Logf: logf})
			server.RefreshToolRegistrations(ctx)
			ctx, cancel := context.WithCancel(ctx)
			defer cancel()
			for _, root := range roots {
				go a.watchDev(ctx, root, server, logf)
			}
			if err := server.Run(ctx); err != nil && !errors.Is(err, context.Canceled) {
				return err
			}
			return nil
		},
	}
}

func (a *App) devCommand() *cli.Command {
	return &cli.Command{
		Name:      "dev",
		Usage:     "watch a local checkout and reinstall edited tool files into the browser",
		ArgsUsage: "<path>",
		Flags: []cli.Flag{
			&cli.StringFlag{Name: "kernel", Usage: "Kernel browser session ID or name instead of the extension"},
		},
		Action: func(ctx context.Context, cmd *cli.Command) error {
			if cmd.NArg() != 1 {
				return errors.New("usage: xwebmcp dev <path>")
			}
			target, closeTarget, err := a.target(ctx, cmd.String("kernel"))
			if err != nil {
				return err
			}
			defer closeTarget()
			roots, err := absolutePaths([]string{cmd.Args().First()})
			if err != nil {
				return err
			}
			logf := func(format string, args ...any) { fmt.Fprintf(a.Stdout, format+"\n", args...) }
			server := mcpserver.New(mcpserver.Options{Target: target, DevRoots: roots, Version: Version, Logf: logf})
			a.watchDev(ctx, roots[0], server, logf)
			return nil
		},
	}
}

func (a *App) target(ctx context.Context, browser string) (mcpserver.Target, func(), error) {
	if browser != "" {
		client, err := a.Kernel()
		if err != nil {
			return nil, nil, err
		}
		return mcpserver.NewKernelTarget(client, browser), func() {}, nil
	}
	st, err := a.store()
	if err != nil {
		return nil, nil, err
	}
	target, err := mcpserver.NewExtensionTarget(ctx, st.Dir)
	if err != nil {
		return nil, nil, err
	}
	return target, func() { target.Close() }, nil
}

func absolutePaths(paths []string) ([]string, error) {
	out := make([]string, 0, len(paths))
	for _, path := range paths {
		absolute, err := filepath.Abs(path)
		if err != nil {
			return nil, err
		}
		if _, err := os.Stat(absolute); err != nil {
			return nil, err
		}
		out = append(out, absolute)
	}
	return out, nil
}

// watchDev reinstalls edited tool files until ctx ends.
func (a *App) watchDev(ctx context.Context, root string, server *mcpserver.Server, logf func(string, ...any)) {
	logf("watching %s", root)
	err := devwatch.Watch(ctx, root, devPollInterval, func(changes []devwatch.Change) {
		for _, change := range changes {
			if change.Removed {
				logf("%s removed; its tool stays installed until removed explicitly", change.File.Rel)
				continue
			}
			if change.File.Digest == "" {
				logf("scan failed: %s", change.File.Source)
				continue
			}
			added, pending, err := server.InstallSource(ctx, change.File.Namespace, change.File.Source, change.File.Rel)
			if err != nil {
				logf("reinstall %s: %v", change.File.Rel, err)
				continue
			}
			for _, tool := range added {
				logf("installed %s/%s from %s (%s)", tool.Namespace, tool.Tool.Name, change.File.Rel, tool.ID)
			}
			if len(pending) > 0 {
				logf("%d site(s) need access: open the xwebmcp popup and click \"Grant access\"", len(pending))
			}
		}
	})
	if err != nil {
		logf("watch %s: %v", root, err)
	}
}
