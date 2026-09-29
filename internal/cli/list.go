package cli

import (
	"context"
	"encoding/json"
	"strings"
	"text/tabwriter"

	"github.com/urfave/cli/v3"
)

func (a *App) listCommand() *cli.Command {
	return &cli.Command{
		Name:  "list",
		Usage: "list installed tools",
		Flags: []cli.Flag{
			&cli.BoolFlag{Name: "json", Usage: "print the lockfile as JSON"},
		},
		Action: func(ctx context.Context, cmd *cli.Command) error {
			st, err := a.store()
			if err != nil {
				return err
			}
			lock, err := st.ReadLock()
			if err != nil {
				return err
			}
			if cmd.Bool("json") {
				enc := json.NewEncoder(a.Stdout)
				enc.SetIndent("", "  ")
				return enc.Encode(lock)
			}
			installed := lock.Installed()
			if len(installed) == 0 {
				a.printf("no tools installed; run `xwebmcp add kernel/xwebmcp`\n")
				return nil
			}
			w := tabwriter.NewWriter(a.Stdout, 0, 0, 2, ' ', 0)
			defer w.Flush()
			w.Write([]byte("NAMESPACE\tTOOL\tKIND\tSTATUS\tSOURCE\tFILE\n"))
			for _, item := range installed {
				commit := item.Source.Commit
				if len(commit) > 7 {
					commit = commit[:7]
				}
				w.Write([]byte(strings.Join([]string{
					item.Tool.Namespace,
					item.Tool.Name,
					orDash(item.Tool.Kind),
					orDash(item.Tool.Status),
					item.Source.Owner + "/" + item.Source.Repo + "@" + commit,
					item.Tool.File,
				}, "\t") + "\n"))
			}
			return nil
		},
	}
}

func orDash(s string) string {
	if s == "" {
		return "-"
	}
	return s
}
