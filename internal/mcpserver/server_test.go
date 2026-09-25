package mcpserver

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// fakeTarget records calls and serves canned custom tools.
type fakeTarget struct {
	custom  []CustomTool
	invokes []InvokeParams
	nextID  int
	opened  []string
}

func (f *fakeTarget) Name() string { return "fake" }

func (f *fakeTarget) ListTools(context.Context, ListToolsParams) (json.RawMessage, error) {
	return json.RawMessage(`[{"tool_ref":"1:0:ab:custom.ct_x.search","tool":{"name":"search","description":"d","inputSchema":{"type":"object"}},"source":{"window_id":1,"tab_id":1,"page_title":"t","page_url":"https://a.test/","frame":null,"custom":{"id":"ct_x","namespace":"a.test"}}}]`), nil
}

func (f *fakeTarget) Invoke(_ context.Context, params InvokeParams) (*Invocation, error) {
	f.invokes = append(f.invokes, params)
	if params.Name == "boom" {
		return &Invocation{InvocationID: "inv-1", Status: "error", ErrorText: "boom", Diagnostics: json.RawMessage(`{"error":{"stack":"x.js:3:1"}}`)}, nil
	}
	return &Invocation{InvocationID: "inv-2", Status: "completed", Output: json.RawMessage(`{"ok":true}`)}, nil
}

func (f *fakeTarget) ListCustomTools(context.Context) ([]CustomTool, []string, error) {
	return append([]CustomTool(nil), f.custom...), []string{"https://a.test/*"}, nil
}

func (f *fakeTarget) AddCustomTools(_ context.Context, namespace, source, file string, force bool) ([]CustomTool, []string, error) {
	names := map[string]bool{}
	for _, match := range regexp.MustCompile(`name:'([a-z_]+)'`).FindAllStringSubmatch(source, -1) {
		names[match[1]] = true
	}
	for _, existing := range f.custom {
		if existing.Namespace == namespace && names[existing.Tool.Name] && !force {
			return nil, nil, errors.New("custom tool already exists: " + namespace + "/" + existing.Tool.Name)
		}
	}
	var added []CustomTool
	for name := range names {
		f.nextID++
		tool := CustomTool{ID: "ct_" + strings.Repeat("a", 23-len(string(rune('0'+f.nextID)))) + string(rune('0'+f.nextID)), Namespace: namespace, Kind: "cdp", Match: json.RawMessage(`{"url_patterns":["https://a.test/*"]}`), Tool: ToolMetadata{Name: name, Description: file, InputSchema: json.RawMessage(`{"type":"object"}`)}}
		f.custom = append(f.custom, tool)
		added = append(added, tool)
	}
	return added, nil, nil
}

func (f *fakeTarget) RemoveCustomTool(_ context.Context, id string) error {
	for i, tool := range f.custom {
		if tool.ID == id {
			f.custom = append(f.custom[:i], f.custom[i+1:]...)
			return nil
		}
	}
	return errors.New("not found")
}

func (f *fakeTarget) ListTabs(context.Context, bool) ([]Tab, error) {
	return []Tab{{TabID: 1, URL: "https://a.test/", Owned: true}}, nil
}

func (f *fakeTarget) OpenTab(_ context.Context, url string) (*Tab, error) {
	f.opened = append(f.opened, url)
	return &Tab{TabID: 2, URL: url, Owned: true}, nil
}

func (f *fakeTarget) NavigateTab(_ context.Context, tabID int, url string, _ bool) (*Tab, error) {
	return &Tab{TabID: tabID, URL: url, Owned: true}, nil
}

func (f *fakeTarget) CloseTab(context.Context, int, bool) error { return nil }

func (f *fakeTarget) GetInvocation(_ context.Context, id string) (json.RawMessage, error) {
	return json.RawMessage(`{"invocation_id":"` + id + `","status":"error"}`), nil
}

func connect(t *testing.T, target Target) (*Server, *mcp.ClientSession) {
	t.Helper()
	server := New(Options{Target: target, Version: "test"})
	server.RefreshToolRegistrations(context.Background())
	clientTransport, serverTransport := mcp.NewInMemoryTransports()
	session, err := server.MCP().Connect(context.Background(), serverTransport, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { session.Close() })
	client := mcp.NewClient(&mcp.Implementation{Name: "test", Version: "0"}, nil)
	cs, err := client.Connect(context.Background(), clientTransport, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cs.Close() })
	return server, cs
}

func toolNames(t *testing.T, cs *mcp.ClientSession) []string {
	t.Helper()
	res, err := cs.ListTools(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, tool := range res.Tools {
		names = append(names, tool.Name)
	}
	return names
}

func call(t *testing.T, cs *mcp.ClientSession, name string, args map[string]any) *mcp.CallToolResult {
	t.Helper()
	res, err := cs.CallTool(context.Background(), &mcp.CallToolParams{Name: name, Arguments: args})
	if err != nil {
		t.Fatalf("%s: %v", name, err)
	}
	return res
}

func text(res *mcp.CallToolResult) string {
	var out []string
	for _, content := range res.Content {
		if tc, ok := content.(*mcp.TextContent); ok {
			out = append(out, tc.Text)
		}
	}
	return strings.Join(out, "\n")
}

func TestGenericToolsAndDynamicRegistration(t *testing.T) {
	target := &fakeTarget{custom: []CustomTool{{ID: "ct_x", Namespace: "a.test", Kind: "cdp", Tool: ToolMetadata{Name: "search", Description: "search things", InputSchema: json.RawMessage(`{"type":"object","properties":{"q":{"type":"string"}}}`)}}}}
	server, cs := connect(t, target)

	names := strings.Join(toolNames(t, cs), ",")
	for _, want := range []string{"list_tools", "invoke_tool", "install_tool", "remove_tool", "open_tab", "a_test__search"} {
		if !strings.Contains(names, want) {
			t.Errorf("tool %s missing from %s", want, names)
		}
	}

	res := call(t, cs, "list_tools", nil)
	if res.IsError || !strings.Contains(text(res), `"tool_ref": "1:0:ab:custom.ct_x.search"`) {
		t.Errorf("list_tools = %s", text(res))
	}

	res = call(t, cs, "a_test__search", map[string]any{"q": "x"})
	if res.IsError || !strings.Contains(text(res), `"ok":true`) {
		t.Errorf("dynamic tool = %s", text(res))
	}
	if len(target.invokes) != 1 || target.invokes[0].Namespace != "a.test" || target.invokes[0].Name != "search" || string(target.invokes[0].Input) != `{"q":"x"}` {
		t.Errorf("invoke params = %+v", target.invokes)
	}

	res = call(t, cs, "invoke_tool", map[string]any{"namespace": "a.test", "name": "boom", "input": map[string]any{}})
	if res.IsError || !strings.Contains(text(res), `"stack": "x.js:3:1"`) {
		t.Errorf("failed invocation should carry diagnostics: %s", text(res))
	}
	res = call(t, cs, "invoke_tool", map[string]any{})
	if !res.IsError {
		t.Error("invoke_tool without a target should be an error")
	}

	// install_tool replaces the same name and keeps siblings; the dynamic MCP
	// tool follows the new definition.
	dir := t.TempDir()
	file := filepath.Join(dir, "a.test", "search.js")
	os.MkdirAll(filepath.Dir(file), 0o755)
	os.WriteFile(file, []byte("[{kind:'cdp', tool:{name:'search'}}, {kind:'cdp', tool:{name:'login'}}]\n"), 0o644)
	res = call(t, cs, "install_tool", map[string]any{"path": file})
	if res.IsError {
		t.Fatalf("install_tool = %s", text(res))
	}
	names = strings.Join(toolNames(t, cs), ",")
	if !strings.Contains(names, "a_test__login") || strings.Count(names, "a_test__search") != 1 {
		t.Errorf("tools after install = %s", names)
	}
	if len(target.custom) != 2 {
		t.Errorf("custom after install = %+v", target.custom)
	}
	server.mu.Lock()
	if server.dynamic["a_test__search"].ID == "ct_x" {
		t.Error("dynamic registration still points at the replaced definition")
	}
	server.mu.Unlock()

	res = call(t, cs, "remove_tool", map[string]any{"namespace": "a.test", "name": "login"})
	if res.IsError {
		t.Fatalf("remove_tool = %s", text(res))
	}
	if strings.Contains(strings.Join(toolNames(t, cs), ","), "a_test__login") {
		t.Error("removed tool still registered")
	}

	res = call(t, cs, "open_tab", map[string]any{"url": "https://a.test/"})
	if res.IsError || len(target.opened) != 1 {
		t.Errorf("open_tab = %s", text(res))
	}
}

func TestMCPToolName(t *testing.T) {
	if got := MCPToolName("southwest.com", "search_flights"); got != "southwest_com__search_flights" {
		t.Errorf("name = %q", got)
	}
	if got := MCPToolName("a-b.c", "x.y"); got != "a-b_c__x_y" {
		t.Errorf("name = %q", got)
	}
}
