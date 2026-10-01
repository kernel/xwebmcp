package mcpserver

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/kernel/xwebmcp/internal/bridge"
)

// ExtensionTarget talks to the Chrome extension over the bridge.
type ExtensionTarget struct {
	client *bridge.Client
}

// NewExtensionTarget connects to the bridge socket in stateDir.
func NewExtensionTarget(ctx context.Context, stateDir string) (*ExtensionTarget, error) {
	client, err := bridge.Dial(ctx, stateDir)
	if err != nil {
		return nil, err
	}
	if _, err := client.Ping(ctx); err != nil {
		client.Close()
		return nil, err
	}
	return &ExtensionTarget{client: client}, nil
}

// Close releases the bridge connection.
func (t *ExtensionTarget) Close() error { return t.client.Close() }

func (t *ExtensionTarget) Name() string { return "Chrome extension" }

func (t *ExtensionTarget) ListTools(ctx context.Context, params ListToolsParams) (json.RawMessage, error) {
	args := map[string]any{"owned_only": params.OwnedOnly, "exclude_custom": params.ExcludeCustom}
	var raw json.RawMessage
	if err := t.client.Call(ctx, "listTools", args, &raw); err != nil {
		return nil, err
	}
	if raw == nil {
		raw = json.RawMessage("[]")
	}
	return raw, nil
}

func (t *ExtensionTarget) Invoke(ctx context.Context, params InvokeParams) (*Invocation, error) {
	timeout := params.TimeoutSec
	if timeout <= 0 {
		timeout = 120
	}
	args := map[string]any{"tool_ref": params.ToolRef, "input": params.Input, "timeout_sec": timeout, "allow_user_tabs": params.AllowUserTabs}
	method := "invoke"
	callCtx, cancel := context.WithTimeout(ctx, time.Duration(timeout+15)*time.Second)
	defer cancel()
	var result Invocation
	err := t.client.Call(callCtx, method, args, &result)
	if err != nil {
		var bridgeErr *bridge.Error
		if errors.As(err, &bridgeErr) && bridgeErr.Code == "outcome_unknown" && bridgeErr.InvocationID != "" {
			result = Invocation{InvocationID: bridgeErr.InvocationID, Status: "error", ErrorText: bridgeErr.Message}
		} else {
			return nil, err
		}
	}
	if result.Status != "completed" && result.InvocationID != "" {
		if record, err := t.GetInvocation(ctx, result.InvocationID); err == nil {
			result.Diagnostics = flattenDiagnostics(record)
		}
	}
	return &result, nil
}

// flattenDiagnostics lifts the extension's nested diagnostics next to the
// invocation's tab and duration so an agent sees one flat object.
func flattenDiagnostics(record json.RawMessage) json.RawMessage {
	var parsed struct {
		TabID       *int            `json:"tab_id"`
		DurationMS  *int            `json:"duration_ms"`
		Diagnostics json.RawMessage `json:"diagnostics"`
	}
	if json.Unmarshal(record, &parsed) != nil || len(parsed.Diagnostics) == 0 {
		return record
	}
	var flat map[string]any
	if json.Unmarshal(parsed.Diagnostics, &flat) != nil {
		return record
	}
	if parsed.TabID != nil {
		flat["tab_id"] = *parsed.TabID
	}
	if parsed.DurationMS != nil {
		flat["total_duration_ms"] = *parsed.DurationMS
	}
	out, err := json.Marshal(flat)
	if err != nil {
		return record
	}
	return out
}

type customToolsResponse struct {
	Tools          []CustomTool `json:"tools"`
	PendingOrigins []string     `json:"pending_origins"`
}

func (t *ExtensionTarget) ListCustomTools(ctx context.Context) ([]CustomTool, []string, error) {
	var res customToolsResponse
	if err := t.client.Call(ctx, "listCustomTools", nil, &res); err != nil {
		return nil, nil, err
	}
	return res.Tools, res.PendingOrigins, nil
}

func (t *ExtensionTarget) AddCustomTools(ctx context.Context, namespace, source, file string, forceOverwrite bool) ([]CustomTool, []string, error) {
	var res customToolsResponse
	args := map[string]any{"namespace": namespace, "source": source, "file": file, "force_overwrite_namespace": forceOverwrite}
	if err := t.client.Call(ctx, "addCustomTools", args, &res); err != nil {
		return nil, nil, err
	}
	return res.Tools, res.PendingOrigins, nil
}

func (t *ExtensionTarget) RemoveCustomTool(ctx context.Context, id string) error {
	return t.client.Call(ctx, "removeCustomTool", map[string]any{"id": id}, nil)
}

func (t *ExtensionTarget) ListTabs(ctx context.Context, all bool) ([]Tab, error) {
	var tabs []Tab
	if err := t.client.Call(ctx, "listTabs", map[string]any{"owned_only": !all}, &tabs); err != nil {
		return nil, err
	}
	if tabs == nil {
		tabs = []Tab{}
	}
	return tabs, nil
}

func (t *ExtensionTarget) OpenTab(ctx context.Context, url string) (*Tab, error) {
	var tab Tab
	if err := t.client.Call(ctx, "openTab", map[string]any{"url": url}, &tab); err != nil {
		return nil, err
	}
	return &tab, nil
}

func (t *ExtensionTarget) NavigateTab(ctx context.Context, tabID int, url string, allowUserTabs bool) (*Tab, error) {
	var tab Tab
	if err := t.client.Call(ctx, "navigateTab", map[string]any{"tab_id": tabID, "url": url, "allow_user_tabs": allowUserTabs}, &tab); err != nil {
		return nil, err
	}
	return &tab, nil
}

func (t *ExtensionTarget) CloseTab(ctx context.Context, tabID int, allowUserTabs bool) error {
	return t.client.Call(ctx, "closeTab", map[string]any{"tab_id": tabID, "allow_user_tabs": allowUserTabs}, nil)
}

func (t *ExtensionTarget) GetInvocation(ctx context.Context, id string) (json.RawMessage, error) {
	var raw json.RawMessage
	if err := t.client.Call(ctx, "getInvocation", map[string]any{"invocation_id": id}, &raw); err != nil {
		return nil, err
	}
	return raw, nil
}
