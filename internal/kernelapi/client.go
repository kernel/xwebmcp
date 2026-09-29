// Package kernelapi is a minimal client for the Kernel browser WebMCP endpoints.
package kernelapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
)

// DefaultBaseURL is the production Kernel API.
const DefaultBaseURL = "https://api.onkernel.com"

// ToolMetadata mirrors WebMCPToolMetadata.
type ToolMetadata struct {
	Name         string          `json:"name"`
	Title        string          `json:"title,omitempty"`
	Description  string          `json:"description"`
	InputSchema  json.RawMessage `json:"inputSchema"`
	OutputSchema json.RawMessage `json:"outputSchema,omitempty"`
	Annotations  json.RawMessage `json:"annotations,omitempty"`
}

// CustomTool mirrors CustomWebMCPDefinition.
type CustomTool struct {
	ID        string `json:"id"`
	Namespace string `json:"namespace"`
	Kind      string `json:"kind"`
	Match     struct {
		URLPatterns []string `json:"url_patterns"`
	} `json:"match"`
	Tool ToolMetadata `json:"tool"`
}

// LiveTool mirrors WebMCPTool from the tool snapshot.
type LiveTool struct {
	ToolRef string       `json:"tool_ref"`
	Tool    ToolMetadata `json:"tool"`
	Source  struct {
		WindowID  int    `json:"window_id"`
		TabID     int    `json:"tab_id"`
		PageTitle string `json:"page_title"`
		PageURL   string `json:"page_url"`
		TargetID  string `json:"target_id,omitempty"`
		Custom    *struct {
			ID        string `json:"id"`
			Namespace string `json:"namespace"`
		} `json:"custom,omitempty"`
	} `json:"source"`
}

// Invocation mirrors WebMCPInvocationResult.
type Invocation struct {
	InvocationID string          `json:"invocation_id"`
	Status       string          `json:"status"`
	Output       json.RawMessage `json:"output,omitempty"`
	ErrorText    string          `json:"error_text,omitempty"`
}

// APIError is a non-2xx response.
type APIError struct {
	Status  int
	Code    string
	Message string
}

func (e *APIError) Error() string {
	if e.Code != "" {
		return fmt.Sprintf("kernel API %d (%s): %s", e.Status, e.Code, e.Message)
	}
	return fmt.Sprintf("kernel API %d: %s", e.Status, e.Message)
}

// Client talks to the Kernel API.
type Client struct {
	BaseURL string
	APIKey  string
	HTTP    *http.Client
}

// FromEnv reads KERNEL_API_KEY and optional KERNEL_BASE_URL.
func FromEnv() (*Client, error) {
	key := os.Getenv("KERNEL_API_KEY")
	if key == "" {
		return nil, errors.New("KERNEL_API_KEY is not set")
	}
	base := os.Getenv("KERNEL_BASE_URL")
	if base == "" {
		base = DefaultBaseURL
	}
	return &Client{BaseURL: base, APIKey: key, HTTP: http.DefaultClient}, nil
}

func (c *Client) do(ctx context.Context, method, path string, body, out any) error {
	var reader io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return err
		}
		reader = bytes.NewReader(data)
	}
	req, err := http.NewRequestWithContext(ctx, method, strings.TrimSuffix(c.BaseURL, "/")+path, reader)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+c.APIKey)
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	res, err := c.HTTP.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	data, err := io.ReadAll(io.LimitReader(res.Body, 16<<20))
	if err != nil {
		return err
	}
	if res.StatusCode/100 != 2 {
		apiErr := &APIError{Status: res.StatusCode, Message: strings.TrimSpace(string(data))}
		var payload struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		}
		if json.Unmarshal(data, &payload) == nil && payload.Message != "" {
			apiErr.Code = payload.Code
			apiErr.Message = payload.Message
		}
		return apiErr
	}
	if out != nil && len(data) > 0 {
		return json.Unmarshal(data, out)
	}
	return nil
}

func browserPath(browser, suffix string) string {
	return "/browsers/" + url.PathEscape(browser) + suffix
}

// ListCustomTools returns the registered custom tool definitions.
func (c *Client) ListCustomTools(ctx context.Context, browser string) ([]CustomTool, error) {
	var res struct {
		Tools []CustomTool `json:"tools"`
	}
	if err := c.do(ctx, http.MethodGet, browserPath(browser, "/webmcp/custom-tools"), nil, &res); err != nil {
		return nil, err
	}
	return res.Tools, nil
}

// AddCustomTools registers a namespaced batch from a source expression.
func (c *Client) AddCustomTools(ctx context.Context, browser, namespace, source string, forceOverwrite bool) ([]CustomTool, error) {
	body := map[string]any{"namespace": namespace, "source": source}
	if forceOverwrite {
		body["force_overwrite_namespace"] = true
	}
	var res struct {
		Tools []CustomTool `json:"tools"`
	}
	if err := c.do(ctx, http.MethodPost, browserPath(browser, "/webmcp/custom-tools"), body, &res); err != nil {
		return nil, err
	}
	return res.Tools, nil
}

// RemoveCustomTool deletes one custom tool by ID.
func (c *Client) RemoveCustomTool(ctx context.Context, browser, id string) error {
	return c.do(ctx, http.MethodDelete, browserPath(browser, "/webmcp/custom-tools/"+url.PathEscape(id)), nil, nil)
}

// ListTools returns the live WebMCP tool snapshot.
func (c *Client) ListTools(ctx context.Context, browser string) ([]LiveTool, error) {
	var res struct {
		Tools []LiveTool `json:"tools"`
	}
	if err := c.do(ctx, http.MethodGet, browserPath(browser, "/webmcp/tools"), nil, &res); err != nil {
		return nil, err
	}
	return res.Tools, nil
}

// ListToolsRaw returns the tools array of the live snapshot as raw JSON.
func (c *Client) ListToolsRaw(ctx context.Context, browser string) (json.RawMessage, error) {
	var res struct {
		Tools json.RawMessage `json:"tools"`
	}
	if err := c.do(ctx, http.MethodGet, browserPath(browser, "/webmcp/tools"), nil, &res); err != nil {
		return nil, err
	}
	return res.Tools, nil
}

// Invoke runs a live tool registration.
func (c *Client) Invoke(ctx context.Context, browser, toolRef string, input json.RawMessage, timeoutSec int) (*Invocation, error) {
	if input == nil {
		input = json.RawMessage("{}")
	}
	body := map[string]any{"tool_ref": toolRef, "input": input}
	if timeoutSec > 0 {
		body["timeout_sec"] = timeoutSec
	}
	var res Invocation
	if err := c.do(ctx, http.MethodPost, browserPath(browser, "/webmcp/invoke"), body, &res); err != nil {
		return nil, err
	}
	return &res, nil
}

// ReplResult mirrors BrowserReplResult.
type ReplResult struct {
	Success bool   `json:"success"`
	Error   string `json:"error,omitempty"`
}

// ExecuteRepl runs code in the browser REPL.
func (c *Client) ExecuteRepl(ctx context.Context, browser, code string, timeoutSec int) (*ReplResult, error) {
	body := map[string]any{"code": code}
	if timeoutSec > 0 {
		body["timeout_sec"] = timeoutSec
	}
	var res ReplResult
	if err := c.do(ctx, http.MethodPost, browserPath(browser, "/repl"), body, &res); err != nil {
		return nil, err
	}
	if !res.Success {
		return nil, fmt.Errorf("browser REPL: %s", res.Error)
	}
	return &res, nil
}
