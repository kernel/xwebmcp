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
	lists   []ListToolsParams
}

func (f *fakeTarget) Name() string { return "fake" }

func (f *fakeTarget) ListTools(_ context.Context, params ListToolsParams) (json.RawMessage, error) {
	f.lists = append(f.lists, params)
	return json.RawMessage(`[{"tool_ref":"1:0:ab:custom.ct_x.search","tool":{"name":"search","description":"d","inputSchema":{"type":"object"}},"source":{"window_id":1,"tab_id":1,"page_title":"t","page_url":"https://a.test/","frame":null,"custom":{"id":"ct_x","namespace":"a.test"}}}]`), nil
}

func (f *fakeTarget) Invoke(_ context.Context, params InvokeParams) (*Invocation, error) {
	f.invokes = append(f.invokes, params)
	if strings.HasSuffix(params.ToolRef, ".boom") {
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

func TestListAndInvokeMatchTheKernelAPI(t *testing.T) {
	target := &fakeTarget{custom: []CustomTool{{ID: "ct_x", Namespace: "a.test", Kind: "cdp", Tool: ToolMetadata{Name: "search", Description: "search things", InputSchema: json.RawMessage(`{"type":"object","properties":{"q":{"type":"string"}}}`)}}}}
	_, cs := connect(t, target)

	names := toolNames(t, cs)
	joined := strings.Join(names, ",")
	for _, want := range []string{"list_tools", "invoke_tool", "get_invocation", "install_tool", "remove_tool", "open_tab"} {
		if !strings.Contains(joined, want) {
			t.Errorf("tool %s missing from %s", want, joined)
		}
	}
	for _, name := range names {
		if strings.Contains(name, "__") {
			t.Errorf("per-tool shortcut %s should not be registered; custom tools are invoked by tool_ref", name)
		}
	}

	res := call(t, cs, "list_tools", map[string]any{"exclude_custom": true})
	if res.IsError || !strings.Contains(text(res), `"tool_ref": "1:0:ab:custom.ct_x.search"`) {
		t.Errorf("list_tools = %s", text(res))
	}
	if len(target.lists) != 1 || !target.lists[0].ExcludeCustom || !target.lists[0].OwnedOnly {
		t.Errorf("list params = %+v", target.lists)
	}

	res = call(t, cs, "invoke_tool", map[string]any{"tool_ref": "1:0:ab:custom.ct_x.search", "input": map[string]any{"q": "x"}, "timeout_sec": 30})
	if res.IsError || !strings.Contains(text(res), `"ok": true`) {
		t.Errorf("invoke_tool = %s", text(res))
	}
	if len(target.invokes) != 1 || target.invokes[0].ToolRef != "1:0:ab:custom.ct_x.search" || string(target.invokes[0].Input) != `{"q":"x"}` || target.invokes[0].TimeoutSec != 30 || target.invokes[0].AllowUserTabs {
		t.Errorf("invoke params = %+v", target.invokes)
	}

	res = call(t, cs, "invoke_tool", map[string]any{"tool_ref": "1:0:ab:custom.ct_y.boom"})
	if res.IsError || !strings.Contains(text(res), `"stack": "x.js:3:1"`) {
		t.Errorf("failed invocation should carry diagnostics: %s", text(res))
	}
	for _, args := range []map[string]any{{}, {"namespace": "a.test", "name": "search"}} {
		if res := call(t, cs, "invoke_tool", args); !res.IsError {
			t.Errorf("invoke_tool %v without tool_ref should be an error", args)
		}
	}
}

func TestAllTabsServerAllowsUserTabs(t *testing.T) {
	target := &fakeTarget{}
	server := New(Options{Target: target, Version: "test", AllTabs: true})
	clientTransport, serverTransport := mcp.NewInMemoryTransports()
	session, _ := server.MCP().Connect(context.Background(), serverTransport, nil)
	defer session.Close()
	cs, _ := mcp.NewClient(&mcp.Implementation{Name: "test", Version: "0"}, nil).Connect(context.Background(), clientTransport, nil)
	defer cs.Close()
	call(t, cs, "list_tools", nil)
	call(t, cs, "invoke_tool", map[string]any{"tool_ref": "r"})
	if target.lists[0].OwnedOnly || !target.invokes[0].AllowUserTabs {
		t.Errorf("--all-tabs not applied: lists %+v invokes %+v", target.lists, target.invokes)
	}
}

func TestInstallAndRemoveTools(t *testing.T) {
	target := &fakeTarget{custom: []CustomTool{{ID: "ct_x", Namespace: "a.test", Kind: "cdp", Tool: ToolMetadata{Name: "search", InputSchema: json.RawMessage(`{"type":"object"}`)}}}}
	_, cs := connect(t, target)
	dir := t.TempDir()
	file := filepath.Join(dir, "a.test", "search.js")
	os.MkdirAll(filepath.Dir(file), 0o755)
	os.WriteFile(file, []byte("[{kind:'cdp', tool:{name:'search'}}, {kind:'cdp', tool:{name:'login'}}]\n"), 0o644)
	if res := call(t, cs, "install_tool", map[string]any{"path": file}); res.IsError {
		t.Fatalf("install_tool = %s", text(res))
	}
	if len(target.custom) != 2 {
		t.Errorf("custom after install = %+v", target.custom)
	}
	if res := call(t, cs, "remove_tool", map[string]any{"namespace": "a.test", "name": "login"}); res.IsError {
		t.Fatalf("remove_tool = %s", text(res))
	}
	if res := call(t, cs, "open_tab", map[string]any{"url": "https://a.test/"}); res.IsError || len(target.opened) != 1 {
		t.Errorf("open_tab = %s", text(res))
	}
}
