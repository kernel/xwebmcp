package cli

import (
	"context"
	"fmt"
	"os"
	"strings"

	"github.com/urfave/cli/v3"

	"github.com/kernel/xwebmcp/internal/bridge"
)

// IsNativeHostInvocation reports whether Chrome started this process as the
// native messaging host: on macOS and Linux the extension origin is argv[1].
func IsNativeHostInvocation(args []string) bool {
	return len(args) > 1 && strings.HasPrefix(args[1], "chrome-extension://")
}

func (a *App) nativeHostCommand() *cli.Command {
	return &cli.Command{
		Name:   "native-host",
		Usage:  "run as the Chrome native messaging host (started by Chrome)",
		Hidden: true,
		Action: func(ctx context.Context, cmd *cli.Command) error {
			return a.RunNativeHost(ctx)
		},
	}
}

// RunNativeHost relays between Chrome on stdin/stdout and CLI clients.
func (a *App) RunNativeHost(ctx context.Context) error {
	st, err := a.store()
	if err != nil {
		return err
	}
	logf := func(format string, args ...any) {
		fmt.Fprintf(os.Stderr, "xwebmcp native host: "+format+"\n", args...)
	}
	return bridge.NewHost(st.Dir, os.Stdin, os.Stdout, logf).Run(ctx)
}
