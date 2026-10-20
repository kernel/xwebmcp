package mcpserver

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/kernel/xwebmcp/internal/toolsource"
)

// Options configure the MCP server.
type Options struct {
	Target Target
	// AllTabs lets list_tools, invoke_tool and list_tabs use tabs the user
	// opened; by default only tabs this server opened are used.
	AllTabs bool
	// DevRoots are local checkouts whose tool files are being edited; their
	// paths are shown to the agent.
	DevRoots []string
	Version  string
	Logf     func(format string, args ...any)
}

// Server is an MCP server over a Target.
type Server struct {
	opts   Options
	server *mcp.Server
	mu     sync.Mutex
}

// tabScope describes which tabs list_tools and invoke_tool may use.
func (s *Server) tabScope() string {
	if s.opts.AllTabs {
		return "This server was started with --all-tabs, so tabs the user opened are included."
	}
	return "Only tabs this server opened (open_tab) are included; start the server with --all-tabs to include the user's tabs."
}

// New builds the server with the generic tools registered.
func New(opts Options) *Server {
	if opts.Logf == nil {
		opts.Logf = func(string, ...any) {}
	}
	s := &Server{opts: opts}
	instructions := fmt.Sprintf(`xwebmcp exposes the WebMCP tools of a browser (%s).

Use list_tools to see what the open tabs expose (site-native and installed custom tools) and
invoke_tool to run one by tool_ref or, for an installed cdp tool, by namespace and name.
Installed custom tools are also registered here as their own MCP tools (namespace__name).
Failed invocations include diagnostics: the thrown error with its stack mapped to the tool file,
the tool's console output, and timing. By default tools only act on tabs this server opened
(open_tab); pass allow_user_tabs to act on the user's own tabs. Never log or repeat tool inputs:
login tools take passwords.`, opts.Target.Name())
	if len(opts.DevRoots) > 0 {
		instructions += fmt.Sprintf("\n\nLocal tool checkouts being watched: %s. Editing a tool file there reinstalls it into the browser automatically; invoke again after editing.", strings.Join(opts.DevRoots, ", "))
	}
	s.server = mcp.NewServer(&mcp.Implementation{Name: "xwebmcp", Version: opts.Version}, &mcp.ServerOptions{Instructions: instructions})
	s.registerGenericTools()
	return s
}

// MCP returns the underlying server for transports and tests.
func (s *Server) MCP() *mcp.Server { return s.server }

// Run serves stdio until ctx ends.
func (s *Server) Run(ctx context.Context) error {
	return s.server.Run(ctx, &mcp.StdioTransport{})
}

func schema(props map[string]any, required ...string) json.RawMessage {
	doc := map[string]any{"type": "object", "properties": props, "additionalProperties": false}
	if len(required) > 0 {
		doc["required"] = required
	}
	data, _ := json.Marshal(doc)
	return data
}

func prop(typ, description string) map[string]any {
	return map[string]any{"type": typ, "description": description}
}

func textResult(value any) *mcp.CallToolResult {
	data, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		data = []byte(fmt.Sprintf("%v", value))
	}
	return &mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: string(data)}}, StructuredContent: value}
}

func errorResult(err error) *mcp.CallToolResult {
	return &mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: err.Error()}}, IsError: true}
}

func decodeArgs(req *mcp.CallToolRequest, out any) error {
	if len(req.Params.Arguments) == 0 {
		return nil
	}
	return json.Unmarshal(req.Params.Arguments, out)
}

func (s *Server) add(name, description string, input json.RawMessage, handler func(context.Context, *mcp.CallToolRequest) (any, error)) {
	s.server.AddTool(&mcp.Tool{Name: name, Description: description, InputSchema: input}, func(ctx context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		value, err := handler(ctx, req)
		if err != nil {
			return errorResult(err), nil
		}
		return textResult(value), nil
	})
}

func (s *Server) registerGenericTools() {
	s.add("list_tools",
		"List the WebMCP tools live in open tabs, in the Kernel API's WebMCPTool shape (tool_ref, tool, source): site-native tools and installed custom tools of both kinds, each registered in the tab whose URL it matches. A tool_ref identifies one registration in one document and becomes invalid when that document navigates; list again after navigation. "+s.tabScope(),
		schema(map[string]any{
			"exclude_custom": prop("boolean", "omit custom tools and list only site-native ones"),
		}),
		func(ctx context.Context, req *mcp.CallToolRequest) (any, error) {
			var args struct {
				ExcludeCustom bool `json:"exclude_custom"`
			}
			if err := decodeArgs(req, &args); err != nil {
				return nil, err
			}
			raw, err := s.opts.Target.ListTools(ctx, ListToolsParams{ExcludeCustom: args.ExcludeCustom, OwnedOnly: !s.opts.AllTabs})
			if err != nil {
				return nil, err
			}
			return map[string]any{"tools": raw}, nil
		})

	s.add("invoke_tool",
		"Invoke the exact live registration identified by tool_ref (from list_tools), like the Kernel API's POST /webmcp/invoke. Works the same for site-native tools and custom page or cdp tools; to run a tool on a site, open a tab there (open_tab), list_tools, then invoke. Returns WebMCPInvocationResult (invocation_id, status, output, error_text) plus diagnostics when it did not complete; get_invocation returns them again later.",
		schema(map[string]any{
			"tool_ref":    prop("string", "tool_ref from list_tools"),
			"input":       map[string]any{"type": "object", "description": "tool input; validated against the tool's inputSchema", "additionalProperties": true},
			"timeout_sec": prop("integer", "seconds to wait (default 120)"),
		}, "tool_ref"),
		func(ctx context.Context, req *mcp.CallToolRequest) (any, error) {
			var args struct {
				ToolRef    string          `json:"tool_ref"`
				Input      json.RawMessage `json:"input"`
				TimeoutSec int             `json:"timeout_sec"`
			}
			if err := decodeArgs(req, &args); err != nil {
				return nil, err
			}
			if args.ToolRef == "" {
				return nil, errors.New("tool_ref is required; get one from list_tools")
			}
			if len(args.Input) == 0 {
				args.Input = json.RawMessage("{}")
			}
			return s.opts.Target.Invoke(ctx, InvokeParams{ToolRef: args.ToolRef, Input: args.Input, TimeoutSec: args.TimeoutSec, AllowUserTabs: s.opts.AllTabs})
		})

	s.add("get_invocation",
		"Return a past invocation with its diagnostics (error with mapped stack, console output, timing, final tab URL).",
		schema(map[string]any{"invocation_id": prop("string", "invocation_id from invoke_tool")}, "invocation_id"),
		func(ctx context.Context, req *mcp.CallToolRequest) (any, error) {
			var args struct {
				InvocationID string `json:"invocation_id"`
			}
			if err := decodeArgs(req, &args); err != nil {
				return nil, err
			}
			raw, err := s.opts.Target.GetInvocation(ctx, args.InvocationID)
			if err != nil {
				return nil, err
			}
			return raw, nil
		})

	s.add("list_custom_tools",
		"List the custom tools installed in the browser (CustomWebMCPDefinition shape) and, for the extension, sites that still need access granted in the popup.",
		schema(map[string]any{}),
		func(ctx context.Context, req *mcp.CallToolRequest) (any, error) {
			tools, pending, err := s.opts.Target.ListCustomTools(ctx)
			if err != nil {
				return nil, err
			}
			return map[string]any{"tools": tools, "pending_origins": pending}, nil
		})

	s.add("install_tool",
		"Install or update a tool from a local tool file (a single JavaScript expression evaluating to an array of definitions). The namespace defaults to the file's parent directory name. Existing tools with the same namespace and name are replaced; other tools in the namespace are kept.",
		schema(map[string]any{
			"path":      prop("string", "absolute path of the tool file"),
			"namespace": prop("string", "namespace (default: parent directory name)"),
		}, "path"),
		func(ctx context.Context, req *mcp.CallToolRequest) (any, error) {
			var args struct {
				Path      string `json:"path"`
				Namespace string `json:"namespace"`
			}
			if err := decodeArgs(req, &args); err != nil {
				return nil, err
			}
			added, pending, err := s.InstallFile(ctx, args.Path, args.Namespace)
			if err != nil {
				return nil, err
			}
			return map[string]any{"tools": added, "pending_origins": pending}, nil
		})

	s.add("remove_tool",
		"Remove an installed custom tool by id, or by namespace and name.",
		schema(map[string]any{
			"id":        prop("string", "custom tool id (ct_…)"),
			"namespace": prop("string", "namespace"),
			"name":      prop("string", "tool name"),
		}),
		func(ctx context.Context, req *mcp.CallToolRequest) (any, error) {
			var args struct {
				ID        string `json:"id"`
				Namespace string `json:"namespace"`
				Name      string `json:"name"`
			}
			if err := decodeArgs(req, &args); err != nil {
				return nil, err
			}
			id := args.ID
			if id == "" {
				tools, _, err := s.opts.Target.ListCustomTools(ctx)
				if err != nil {
					return nil, err
				}
				for _, tool := range tools {
					if tool.Namespace == args.Namespace && tool.Tool.Name == args.Name {
						id = tool.ID
					}
				}
				if id == "" {
					return nil, fmt.Errorf("no installed tool %s/%s", args.Namespace, args.Name)
				}
			}
			if err := s.opts.Target.RemoveCustomTool(ctx, id); err != nil {
				return nil, err
			}
			return map[string]any{"removed": id}, nil
		})

	s.add("list_tabs",
		"List browser tabs. By default only tabs opened by this server.",
		schema(map[string]any{"all_tabs": prop("boolean", "include tabs the user opened")}),
		func(ctx context.Context, req *mcp.CallToolRequest) (any, error) {
			var args struct {
				AllTabs bool `json:"all_tabs"`
			}
			if err := decodeArgs(req, &args); err != nil {
				return nil, err
			}
			tabs, err := s.opts.Target.ListTabs(ctx, args.AllTabs || s.opts.AllTabs)
			if err != nil {
				return nil, err
			}
			return map[string]any{"tabs": tabs}, nil
		})

	s.add("open_tab",
		"Open a new tab owned by this server (grouped under \"xwebmcp\" in the extension) and return it.",
		schema(map[string]any{"url": prop("string", "http(s) URL")}, "url"),
		func(ctx context.Context, req *mcp.CallToolRequest) (any, error) {
			var args struct {
				URL string `json:"url"`
			}
			if err := decodeArgs(req, &args); err != nil {
				return nil, err
			}
			return s.opts.Target.OpenTab(ctx, args.URL)
		})

	s.add("navigate_tab",
		"Navigate a tab owned by this server to a URL.",
		schema(map[string]any{
			"tab_id":          prop("integer", "tab id"),
			"url":             prop("string", "http(s) URL"),
			"allow_user_tabs": prop("boolean", "allow navigating a tab the user opened"),
		}, "tab_id", "url"),
		func(ctx context.Context, req *mcp.CallToolRequest) (any, error) {
			var args struct {
				TabID         int    `json:"tab_id"`
				URL           string `json:"url"`
				AllowUserTabs bool   `json:"allow_user_tabs"`
			}
			if err := decodeArgs(req, &args); err != nil {
				return nil, err
			}
			return s.opts.Target.NavigateTab(ctx, args.TabID, args.URL, args.AllowUserTabs)
		})

	s.add("close_tab",
		"Close a tab owned by this server.",
		schema(map[string]any{
			"tab_id":          prop("integer", "tab id"),
			"allow_user_tabs": prop("boolean", "allow closing a tab the user opened"),
		}, "tab_id"),
		func(ctx context.Context, req *mcp.CallToolRequest) (any, error) {
			var args struct {
				TabID         int  `json:"tab_id"`
				AllowUserTabs bool `json:"allow_user_tabs"`
			}
			if err := decodeArgs(req, &args); err != nil {
				return nil, err
			}
			if err := s.opts.Target.CloseTab(ctx, args.TabID, args.AllowUserTabs); err != nil {
				return nil, err
			}
			return map[string]any{"closed": args.TabID}, nil
		})
}

// InstallFile installs one local tool file, replacing tools of the same
// namespace and name and keeping the namespace's other tools.
func (s *Server) InstallFile(ctx context.Context, path, namespace string) ([]CustomTool, []string, error) {
	absolute, err := filepath.Abs(path)
	if err != nil {
		return nil, nil, err
	}
	data, err := os.ReadFile(absolute)
	if err != nil {
		return nil, nil, err
	}
	if namespace == "" {
		namespace = filepath.Base(filepath.Dir(absolute))
	}
	return s.InstallSource(ctx, namespace, string(data), absolute)
}

// InstallSource installs a tool source under a namespace with the same
// replace-by-name semantics as InstallFile. Neither target can replace a
// single tool in place, so a conflict names the colliding tool, which is
// removed before trying again.
func (s *Server) InstallSource(ctx context.Context, namespace, source, file string) ([]CustomTool, []string, error) {
	normalized := toolsource.Normalize(source)
	for attempt := 0; attempt < maxReplaceAttempts; attempt++ {
		added, pending, err := s.opts.Target.AddCustomTools(ctx, namespace, normalized, file, false)
		if err == nil {
			return added, pending, nil
		}
		conflict := conflictingName(err, namespace)
		if conflict == "" {
			return nil, nil, err
		}
		if err := s.removeByName(ctx, namespace, conflict); err != nil {
			return nil, nil, err
		}
	}
	return nil, nil, fmt.Errorf("could not replace tools in namespace %s after %d attempts", namespace, maxReplaceAttempts)
}

const maxReplaceAttempts = 32

var conflictPattern = regexp.MustCompile(`custom tool already exists: (\S+)/(\S+)`)

// conflictingName extracts the tool name from a custom_tool_conflict error.
func conflictingName(err error, namespace string) string {
	match := conflictPattern.FindStringSubmatch(err.Error())
	if match == nil || match[1] != namespace {
		return ""
	}
	return match[2]
}

func (s *Server) removeByName(ctx context.Context, namespace, name string) error {
	tools, _, err := s.opts.Target.ListCustomTools(ctx)
	if err != nil {
		return err
	}
	for _, tool := range tools {
		if tool.Namespace == namespace && tool.Tool.Name == name {
			return s.opts.Target.RemoveCustomTool(ctx, tool.ID)
		}
	}
	return fmt.Errorf("conflicting tool %s/%s not found", namespace, name)
}
