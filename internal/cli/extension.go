package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"text/tabwriter"
	"time"

	"github.com/urfave/cli/v3"

	"github.com/kernel/xwebmcp/internal/bridge"
)

// extensionTool mirrors the CustomWebMCPDefinition shape the extension returns.
type extensionTool struct {
	ID        string `json:"id"`
	Namespace string `json:"namespace"`
	Kind      string `json:"kind"`
	Match     struct {
		URLPatterns []string `json:"url_patterns"`
	} `json:"match"`
	Tool struct {
		Name        string `json:"name"`
		Description string `json:"description"`
	} `json:"tool"`
}

// liveTool mirrors WebMCPTool from GET /webmcp/tools.
type liveTool struct {
	ToolRef string `json:"tool_ref"`
	Tool    struct {
		Name        string          `json:"name"`
		Description string          `json:"description"`
		InputSchema json.RawMessage `json:"inputSchema"`
	} `json:"tool"`
	Source struct {
		TabID     int    `json:"tab_id"`
		PageTitle string `json:"page_title"`
		PageURL   string `json:"page_url"`
		Frame     *struct {
			FrameID int    `json:"frame_id"`
			URL     string `json:"url"`
		} `json:"frame"`
		Custom *struct {
			ID        string `json:"id"`
			Namespace string `json:"namespace"`
		} `json:"custom"`
	} `json:"source"`
}

// invocationResult mirrors WebMCPInvocationResult.
type invocationResult struct {
	InvocationID string          `json:"invocation_id"`
	Status       string          `json:"status"`
	Output       json.RawMessage `json:"output,omitempty"`
	ErrorText    string          `json:"error_text,omitempty"`
}

func (a *App) dialExtension(ctx context.Context) (*bridge.Client, error) {
	st, err := a.store()
	if err != nil {
		return nil, err
	}
	client, err := bridge.Dial(ctx, st.Dir)
	if err != nil {
		return nil, err
	}
	if _, err := client.Ping(ctx); err != nil {
		client.Close()
		return nil, fmt.Errorf("the xwebmcp extension did not answer: %w", err)
	}
	return client, nil
}

func (a *App) attachExtension(ctx context.Context) error {
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
	client, err := a.dialExtension(ctx)
	if err != nil {
		return err
	}
	defer client.Close()

	var existing struct {
		Tools []extensionTool `json:"tools"`
	}
	if err := client.Call(ctx, "listCustomTools", nil, &existing); err != nil {
		return err
	}
	wanted := map[string]bool{}
	for _, ns := range namespaces {
		wanted[ns.Namespace] = true
	}
	for _, tool := range existing.Tools {
		if wanted[tool.Namespace] {
			continue
		}
		if err := client.Call(ctx, "removeCustomNamespace", map[string]any{"namespace": tool.Namespace}, nil); err != nil {
			return err
		}
		a.printf("removed %s (no longer installed)\n", tool.Namespace)
		wanted[tool.Namespace] = true // only report once
	}

	total := 0
	var pending []string
	seenPending := map[string]bool{}
	for _, ns := range namespaces {
		source, err := namespaceBatch(st, ns)
		if err != nil {
			return err
		}
		var result struct {
			Tools          []extensionTool `json:"tools"`
			PendingOrigins []string        `json:"pending_origins"`
		}
		params := map[string]any{
			"namespace":                 ns.Namespace,
			"source":                    source,
			"file":                      "domains/" + ns.Namespace + "/(batch).js",
			"force_overwrite_namespace": true,
		}
		if err := client.Call(ctx, "addCustomTools", params, &result); err != nil {
			return fmt.Errorf("register %s: %w", ns.Namespace, err)
		}
		for _, tool := range result.Tools {
			total++
			a.printf("%s  %s/%s  %s\n", tool.ID, tool.Namespace, tool.Tool.Name, tool.Kind)
		}
		for _, origin := range result.PendingOrigins {
			if !seenPending[origin] {
				pending = append(pending, origin)
				seenPending[origin] = true
			}
		}
	}
	a.printf("attached %d tool(s) to the Chrome extension\n", total)
	if len(pending) > 0 {
		a.printf("\n%d site(s) still need access before their tools register: open the xwebmcp popup in Chrome and click \"Grant access\":\n", len(pending))
		for _, origin := range pending {
			a.printf("  %s\n", origin)
		}
	}
	return nil
}

func (a *App) toolsCommand() *cli.Command {
	return &cli.Command{
		Name:  "tools",
		Usage: "list the WebMCP tools currently exposed by open tabs (native and custom)",
		Flags: []cli.Flag{
			&cli.BoolFlag{Name: "json", Usage: "print the WebMCPTool snapshot as JSON"},
			&cli.StringFlag{Name: "kernel", Usage: "Kernel browser session ID or name instead of the extension"},
		},
		Action: func(ctx context.Context, cmd *cli.Command) error {
			var raw json.RawMessage
			if browser := cmd.String("kernel"); browser != "" {
				client, err := a.Kernel()
				if err != nil {
					return err
				}
				live, err := client.ListToolsRaw(ctx, browser)
				if err != nil {
					return err
				}
				raw = live
			} else {
				client, err := a.dialExtension(ctx)
				if err != nil {
					return err
				}
				defer client.Close()
				if err := client.Call(ctx, "listTools", map[string]any{}, &raw); err != nil {
					return err
				}
			}
			if cmd.Bool("json") {
				var buf bytes.Buffer
				if err := json.Indent(&buf, raw, "", "  "); err != nil {
					return err
				}
				a.printf("{\n  \"tools\": %s\n}\n", strings.ReplaceAll(buf.String(), "\n", "\n  "))
				return nil
			}
			var tools []liveTool
			if err := json.Unmarshal(raw, &tools); err != nil {
				return fmt.Errorf("decode tools: %w", err)
			}
			if len(tools) == 0 {
				a.printf("no WebMCP tools on any open tab\n")
				return nil
			}
			w := tabwriter.NewWriter(a.Stdout, 0, 0, 2, ' ', 0)
			defer w.Flush()
			w.Write([]byte("TOOL\tKIND\tTAB\tPAGE\tTOOL_REF\n"))
			for _, tool := range tools {
				kind := "native"
				if tool.Source.Custom != nil {
					kind = "custom " + tool.Source.Custom.Namespace
				}
				page := tool.Source.PageURL
				if tool.Source.Frame != nil {
					page = fmt.Sprintf("%s (frame %d)", tool.Source.Frame.URL, tool.Source.Frame.FrameID)
				}
				fmt.Fprintf(w, "%s\t%s\t%d\t%s\t%s\n", tool.Tool.Name, kind, tool.Source.TabID, page, tool.ToolRef)
			}
			return nil
		},
	}
}

func (a *App) invokeCommand() *cli.Command {
	return &cli.Command{
		Name:      "invoke",
		Usage:     "invoke a tool and print its result",
		ArgsUsage: "<tool_ref>",
		Description: `Invokes the exact live registration a tool_ref from ` + "`xwebmcp tools`" + ` identifies,
site-native or custom (page or cdp), like the Kernel API's POST /webmcp/invoke. Open
a tab on the site first so its tools register. Input is read from --input or, when
--input is "-", from stdin, so credentials never appear in shell history.`,
		Flags: []cli.Flag{
			&cli.StringFlag{Name: "input", Usage: "JSON input object, or - to read it from stdin", Value: "{}"},
			&cli.IntFlag{Name: "timeout", Usage: "seconds to wait for the tool", Value: 120},
			&cli.StringFlag{Name: "kernel", Usage: "Kernel browser session ID or name instead of the extension"},
		},
		Action: func(ctx context.Context, cmd *cli.Command) error {
			if cmd.NArg() != 1 {
				return errors.New("usage: xwebmcp invoke <tool_ref> [--input JSON]; get tool_refs from `xwebmcp tools`")
			}
			inputText := cmd.String("input")
			if inputText == "-" {
				data, err := io.ReadAll(os.Stdin)
				if err != nil {
					return err
				}
				inputText = string(data)
			}
			var input json.RawMessage
			if err := json.Unmarshal([]byte(inputText), &input); err != nil {
				return fmt.Errorf("--input must be a JSON object: %w", err)
			}
			target := cmd.Args().First()
			if !strings.Contains(target, ":") {
				return fmt.Errorf("%q is not a tool_ref; tools are invoked by the tool_ref `xwebmcp tools` lists for an open tab (open the site first)", target)
			}
			timeout := cmd.Int("timeout")

			var result invocationResult
			if browser := cmd.String("kernel"); browser != "" {
				client, err := a.Kernel()
				if err != nil {
					return err
				}
				res, err := client.Invoke(ctx, browser, target, input, timeout)
				if err != nil {
					return err
				}
				result = invocationResult{InvocationID: res.InvocationID, Status: res.Status, Output: res.Output, ErrorText: res.ErrorText}
			} else {
				client, err := a.dialExtension(ctx)
				if err != nil {
					return err
				}
				defer client.Close()
				callCtx, cancel := context.WithTimeout(ctx, time.Duration(timeout+10)*time.Second)
				defer cancel()
				params := map[string]any{"tool_ref": target, "input": input, "timeout_sec": timeout, "allow_user_tabs": true}
				if err := client.Call(callCtx, "invoke", params, &result); err != nil {
					return err
				}
			}
			enc := json.NewEncoder(a.Stdout)
			enc.SetIndent("", "  ")
			return enc.Encode(result)
		},
	}
}
