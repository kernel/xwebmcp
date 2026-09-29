package cli

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/urfave/cli/v3"

	"github.com/kernel/xwebmcp/internal/kernelapi"
	"github.com/kernel/xwebmcp/internal/store"
	"github.com/kernel/xwebmcp/internal/toolsource"
)

func (a *App) attachCommand() *cli.Command {
	return &cli.Command{
		Name:  "attach",
		Usage: "push installed tools into a browser",
		Description: `With --kernel, every installed namespace is registered on the Kernel browser
through the custom WebMCP tools API, replacing any earlier registration of the
same namespace. KERNEL_API_KEY must be set.`,
		Flags: []cli.Flag{
			&cli.StringFlag{Name: "kernel", Usage: "Kernel browser session ID or name"},
		},
		Action: func(ctx context.Context, cmd *cli.Command) error {
			if cmd.String("kernel") == "" {
				return errors.New("attach requires --kernel <browser id or name>")
			}
			return a.attachKernel(ctx, cmd.String("kernel"))
		},
	}
}

// namespaceSources groups stored tools by namespace, keeping install order.
type namespaceSource struct {
	Namespace string
	Tools     []store.InstalledTool
}

func (a *App) namespaces(st *store.Store) ([]namespaceSource, error) {
	lock, err := st.ReadLock()
	if err != nil {
		return nil, err
	}
	var out []namespaceSource
	index := map[string]int{}
	for _, item := range lock.Installed() {
		i, ok := index[item.Tool.Namespace]
		if !ok {
			i = len(out)
			index[item.Tool.Namespace] = i
			out = append(out, namespaceSource{Namespace: item.Tool.Namespace})
		}
		out[i].Tools = append(out[i].Tools, item)
	}
	return out, nil
}

func (a *App) attachKernel(ctx context.Context, browser string) error {
	client, err := a.Kernel()
	if err != nil {
		return err
	}
	st, err := a.store()
	if err != nil {
		return err
	}
	namespaces, err := a.namespaces(st)
	if err != nil {
		return err
	}
	if len(namespaces) == 0 {
		return errors.New("no tools installed; run `xwebmcp add kernel/xwebmcp` first")
	}
	total := 0
	for _, ns := range namespaces {
		parts := make([]string, 0, len(ns.Tools))
		for _, item := range ns.Tools {
			source, err := st.ReadToolSource(item.Source, item.Tool)
			if err != nil {
				return err
			}
			parts = append(parts, "...("+toolsource.Normalize(source)+")")
		}
		added, err := client.AddCustomTools(ctx, browser, ns.Namespace, "["+strings.Join(parts, ",")+"]", true)
		if err != nil {
			var apiErr *kernelapi.APIError
			if errors.As(err, &apiErr) {
				return fmt.Errorf("register %s: %w", ns.Namespace, err)
			}
			return err
		}
		for _, tool := range added {
			total++
			a.printf("%s  %s/%s  %s\n", tool.ID, tool.Namespace, tool.Tool.Name, tool.Kind)
		}
	}
	a.printf("attached %d tool(s) to Kernel browser %s\n", total, browser)
	return nil
}
