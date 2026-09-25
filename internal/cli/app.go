// Package cli wires the xwebmcp command tree.
package cli

import (
	"context"
	"fmt"
	"io"
	"os"

	"github.com/urfave/cli/v3"

	"github.com/kernel/xwebmcp/internal/github"
	"github.com/kernel/xwebmcp/internal/kernelapi"
	"github.com/kernel/xwebmcp/internal/store"
)

// Version is set at build time.
var Version = "dev"

// App holds the dependencies the commands need.
type App struct {
	Stdout   io.Writer
	Stderr   io.Writer
	StoreDir string
	GitHub   *github.Client
	Kernel   func() (*kernelapi.Client, error)
	// Executable overrides the path written into the native host manifest.
	Executable string
}

// Default returns an App wired to the real environment.
func Default() *App {
	return &App{
		Stdout: os.Stdout,
		Stderr: os.Stderr,
		GitHub: github.NewClient(),
		Kernel: kernelapi.FromEnv,
	}
}

func (a *App) store() (*store.Store, error) {
	dir := a.StoreDir
	if dir == "" {
		var err error
		dir, err = store.DefaultDir()
		if err != nil {
			return nil, err
		}
	}
	return store.Open(dir)
}

// Command builds the root command.
func (a *App) Command() *cli.Command {
	return &cli.Command{
		Name:      "xwebmcp",
		Usage:     "install custom WebMCP tools and connect agents to them",
		Version:   Version,
		Writer:    a.Stdout,
		ErrWriter: a.Stderr,
		Commands: []*cli.Command{
			a.addCommand(),
			a.listCommand(),
			a.removeCommand(),
			a.attachCommand(),
			a.setupCommand(),
			a.statusCommand(),
			a.toolsCommand(),
			a.invokeCommand(),
			a.mcpCommand(),
			a.devCommand(),
			a.nativeHostCommand(),
		},
	}
}

// Run executes the CLI with the given arguments (including argv[0]).
func (a *App) Run(ctx context.Context, args []string) error {
	return a.Command().Run(ctx, args)
}

func (a *App) printf(format string, args ...any) {
	fmt.Fprintf(a.Stdout, format, args...)
}

func (a *App) warnf(format string, args ...any) {
	fmt.Fprintf(a.Stderr, format, args...)
}
