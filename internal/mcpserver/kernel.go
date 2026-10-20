package mcpserver

import (
	"context"
	"encoding/json"
	"errors"
	"strings"

	"github.com/kernel/xwebmcp/internal/kernelapi"
)

// KernelTarget talks to a Kernel browser through the API. Tabs are driven
// through the browser REPL, and there is no tab ownership concept there.
type KernelTarget struct {
	client  *kernelapi.Client
	browser string
}

// NewKernelTarget wraps a Kernel browser session.
func NewKernelTarget(client *kernelapi.Client, browser string) *KernelTarget {
	return &KernelTarget{client: client, browser: browser}
}

func (t *KernelTarget) Name() string { return "Kernel browser " + t.browser }

func (t *KernelTarget) ListTools(ctx context.Context, params ListToolsParams) (json.RawMessage, error) {
	raw, err := t.client.ListToolsRaw(ctx, t.browser)
	if err != nil {
		return nil, err
	}
	if !params.ExcludeCustom {
		return raw, nil
	}
	var tools []map[string]json.RawMessage
	if err := json.Unmarshal(raw, &tools); err != nil {
		return nil, err
	}
	filtered := make([]map[string]json.RawMessage, 0)
	for _, tool := range tools {
		var source struct {
			Custom json.RawMessage `json:"custom"`
		}
		if json.Unmarshal(tool["source"], &source) == nil && len(source.Custom) == 0 {
			filtered = append(filtered, tool)
		}
	}
	return json.Marshal(filtered)
}

func (t *KernelTarget) Invoke(ctx context.Context, params InvokeParams) (*Invocation, error) {
	timeout := params.TimeoutSec
	if timeout <= 0 || timeout > 120 {
		timeout = 120
	}
	res, err := t.client.Invoke(ctx, t.browser, params.ToolRef, params.Input, timeout)
	if err != nil {
		var apiErr *kernelapi.APIError
		if errors.As(err, &apiErr) && apiErr.Code == "outcome_unknown" {
			return &Invocation{Status: "error", ErrorText: apiErr.Message}, nil
		}
		return nil, err
	}
	return &Invocation{InvocationID: res.InvocationID, Status: res.Status, Output: res.Output, ErrorText: res.ErrorText}, nil
}

func entryURL(patterns []string, namespace string) string {
	if len(patterns) == 0 {
		return "https://" + namespace + "/"
	}
	first := patterns[0]
	scheme, rest, ok := strings.Cut(first, "://")
	if !ok {
		return "https://" + namespace + "/"
	}
	host := strings.TrimPrefix(strings.SplitN(rest, "/", 2)[0], "*.")
	if scheme == "*" {
		scheme = "https"
	}
	return scheme + "://" + host + "/"
}

func jsonString(s string) string {
	data, _ := json.Marshal(s)
	return string(data)
}

func convertCustomTools(in []kernelapi.CustomTool) []CustomTool {
	out := make([]CustomTool, 0, len(in))
	for _, tool := range in {
		match, _ := json.Marshal(tool.Match)
		out = append(out, CustomTool{
			ID: tool.ID, Namespace: tool.Namespace, Kind: tool.Kind, Match: match,
			Tool: ToolMetadata{Name: tool.Tool.Name, Title: tool.Tool.Title, Description: tool.Tool.Description, InputSchema: tool.Tool.InputSchema, OutputSchema: tool.Tool.OutputSchema, Annotations: tool.Tool.Annotations},
		})
	}
	return out
}

func (t *KernelTarget) ListCustomTools(ctx context.Context) ([]CustomTool, []string, error) {
	tools, err := t.client.ListCustomTools(ctx, t.browser)
	if err != nil {
		return nil, nil, err
	}
	return convertCustomTools(tools), nil, nil
}

func (t *KernelTarget) AddCustomTools(ctx context.Context, namespace, source, _ string, forceOverwrite bool) ([]CustomTool, []string, error) {
	tools, err := t.client.AddCustomTools(ctx, t.browser, namespace, source, forceOverwrite)
	if err != nil {
		return nil, nil, err
	}
	return convertCustomTools(tools), nil, nil
}

func (t *KernelTarget) RemoveCustomTool(ctx context.Context, id string) error {
	return t.client.RemoveCustomTool(ctx, t.browser, id)
}

func (t *KernelTarget) ListTabs(ctx context.Context, _ bool) ([]Tab, error) {
	live, err := t.client.ListTools(ctx, t.browser)
	if err != nil {
		return nil, err
	}
	seen := map[int]bool{}
	tabs := make([]Tab, 0)
	for _, tool := range live {
		if seen[tool.Source.TabID] {
			continue
		}
		seen[tool.Source.TabID] = true
		tabs = append(tabs, Tab{TabID: tool.Source.TabID, URL: tool.Source.PageURL, Title: tool.Source.PageTitle, Owned: false})
	}
	return tabs, nil
}

func (t *KernelTarget) OpenTab(context.Context, string) (*Tab, error) {
	return nil, errors.New("open_tab cannot return a numeric tab_id on a Kernel browser; use its browser REPL instead")
}

func (t *KernelTarget) NavigateTab(context.Context, int, string, bool) (*Tab, error) {
	return nil, errors.New("navigate_tab by numeric tab_id is not supported on a Kernel browser; use its browser REPL to select the target")
}

func (t *KernelTarget) CloseTab(context.Context, int, bool) error {
	return errors.New("close_tab by numeric tab_id is not supported on a Kernel browser; use its browser REPL to select the target")
}

func (t *KernelTarget) GetInvocation(context.Context, string) (json.RawMessage, error) {
	return nil, errors.New("invocation diagnostics are only available from the Chrome extension")
}
