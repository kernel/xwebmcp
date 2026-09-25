// Package mcpserver exposes the tools of a browser to MCP clients such as
// Claude Code. The browser is either the xwebmcp Chrome extension (over the
// native messaging bridge) or a Kernel browser (over the Kernel API); both are
// abstracted as a Target using the Kernel API's JSON shapes.
package mcpserver

import (
	"context"
	"encoding/json"
)

// CustomTool mirrors CustomWebMCPDefinition.
type CustomTool struct {
	ID        string          `json:"id"`
	Namespace string          `json:"namespace"`
	Kind      string          `json:"kind"`
	Match     json.RawMessage `json:"match"`
	Tool      ToolMetadata    `json:"tool"`
}

// ToolMetadata mirrors WebMCPToolMetadata.
type ToolMetadata struct {
	Name         string          `json:"name"`
	Title        string          `json:"title,omitempty"`
	Description  string          `json:"description"`
	InputSchema  json.RawMessage `json:"inputSchema"`
	OutputSchema json.RawMessage `json:"outputSchema,omitempty"`
	Annotations  json.RawMessage `json:"annotations,omitempty"`
}

// Invocation mirrors WebMCPInvocationResult plus the extension's diagnostics,
// which are nil for targets that cannot provide them.
type Invocation struct {
	InvocationID string          `json:"invocation_id"`
	Status       string          `json:"status"`
	Output       json.RawMessage `json:"output,omitempty"`
	ErrorText    string          `json:"error_text,omitempty"`
	Diagnostics  json.RawMessage `json:"diagnostics,omitempty"`
}

// InvokeParams selects a live registration by tool_ref or an installed cdp
// tool by namespace and name.
type InvokeParams struct {
	ToolRef       string
	Namespace     string
	Name          string
	Input         json.RawMessage
	TimeoutSec    int
	TabID         int
	AllowUserTabs bool
}

// ListToolsParams narrows the discovery snapshot.
type ListToolsParams struct {
	TabID     int
	OwnedOnly bool
}

// Tab mirrors the extension's tab summary.
type Tab struct {
	TabID    int    `json:"tab_id"`
	WindowID int    `json:"window_id,omitempty"`
	URL      string `json:"url"`
	Title    string `json:"title"`
	Active   bool   `json:"active"`
	Status   string `json:"status,omitempty"`
	Owned    bool   `json:"owned"`
}

// Target is a browser that hosts WebMCP tools.
type Target interface {
	// Name identifies the target in tool descriptions.
	Name() string
	// ListTools returns the WebMCPTool[] snapshot as raw JSON.
	ListTools(ctx context.Context, params ListToolsParams) (json.RawMessage, error)
	Invoke(ctx context.Context, params InvokeParams) (*Invocation, error)
	ListCustomTools(ctx context.Context) ([]CustomTool, []string, error)
	AddCustomTools(ctx context.Context, namespace, source, file string, forceOverwrite bool) ([]CustomTool, []string, error)
	RemoveCustomTool(ctx context.Context, id string) error
	ListTabs(ctx context.Context, all bool) ([]Tab, error)
	OpenTab(ctx context.Context, url string) (*Tab, error)
	NavigateTab(ctx context.Context, tabID int, url string, allowUserTabs bool) (*Tab, error)
	CloseTab(ctx context.Context, tabID int, allowUserTabs bool) error
	GetInvocation(ctx context.Context, id string) (json.RawMessage, error)
}
