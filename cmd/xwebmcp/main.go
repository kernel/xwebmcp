// Command xwebmcp installs custom WebMCP tools and connects agents to them.
package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	"github.com/kernel/xwebmcp/internal/cli"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := cli.Default().Run(ctx, os.Args); err != nil {
		fmt.Fprintln(os.Stderr, "xwebmcp:", err)
		os.Exit(1)
	}
}
