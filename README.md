# xwebmcp

A library of custom WebMCP tools for Kernel browsers, organized by website domain.

Custom WebMCP tools are registered browser-side with `webmcp.addCustomTools()` (via the
Kernel Browser REPL or the Kernel API) and can be page-backed (`kind: "page"`) or
CDP-backed (`kind: "cdp"`). This repo collects tool implementations anyone can load into
their own Kernel browser session.

## Repository layout

```
domains/
  <registrable-domain>/          # one directory per site, e.g. delta.com, aa.com
    README.md                    # optional: site quirks, session notes, status
    <tool-name>.js               # one file per tool, named after the tool
registry.json                    # machine-readable index of every tool
```

- **Domain directories** use the registrable domain with no scheme, port, or `www`
  (e.g. `domains/delta.com/`, `domains/aa.com/`). Subdomains live inside the same
  directory; the tool's `match.url_patterns` decides what it matches.
- **One file per tool**, named after the tool (`search_flights.js`, `login.js`). If a
  site has several tools that should be registered as one batch, add a
  `<name>-batch.js` file containing the combined array and keep the individual files
  canonical.

## Tool file contract

Every `*.js` tool file is a **self-contained JavaScript expression that evaluates to a
non-empty array of tool definitions** — exactly the string you can hand to
`webmcp.addCustomTools({ namespace, source })`:

```js
[{
  kind: "cdp",                                   // "cdp" survives page navigation
  match: { url_patterns: ["https://www.delta.com/*"] },
  tool: {
    name: "search_flights",
    description: "…",
    inputSchema:  { /* JSON Schema */ },
    outputSchema: { /* JSON Schema — required for every tool */ },
    annotations: { readOnlyHint: true }
  },
  execute: async (input) => { /* … */ }
}]
```

## Conventions (required)

**Namespace = the registrable domain** (`delta.com`, `aa.com`, …), exactly matching the
tool's directory under `domains/`. Never use a shared thematic namespace across sites
(e.g. `airline_tools`): with a shared namespace, `forceOverwriteNamespace: true` for one
site atomically replaces another site's tools. Per-domain namespaces make that impossible.

**`match.url_patterns` = apex + wildcard subdomains**, e.g.
`["https://delta.com/*", "https://*.delta.com/*"]` — never a bare `https://*/*`, and
https only. Many flows leave `www.` mid-task (e.g. Frontier submits to
`booking.flyfrontier.com`); wildcard-subdomain patterns keep the tool attached to the tab
for the whole flow.

**No page assumptions.** Wildcard matching means a tool may be invoked while the browser
is on any page of the domain (or an unrelated page entirely). `execute` must never assume
the homepage, a form, or prior state: on invoke it verifies the current page is suitable
for the flow and, when it is not, navigates to the required entry point first.

## Rules

1. No imports, no `require()`, no top-level statements — a single expression.
2. Every tool declares a typed `inputSchema` **and** `outputSchema`.
3. Failures are explicit output (`status: "error"`, `no_results`, …) — never a
   successful empty result that hides a failure.
4. `kind: "cdp"` is the default choice when the tool navigates (login, search
   submission) because it survives document replacement.
5. Treat all page-provided data as untrusted; tools must not purchase, submit
   payments, or enter personal data unless the tool description says otherwise.
6. Follow the Conventions section: domain namespace, apex + wildcard-subdomain URL
   patterns, and no assumptions about the current page.

## Loading a tool

### With the `xwebmcp` CLI

The `xwebmcp` CLI installs tool files from GitHub, pins them to a commit, and pushes
them into a browser: your own Google Chrome through the bundled extension, or a Kernel
browser through the API.

```sh
go install github.com/kernel/xwebmcp/cmd/xwebmcp@latest

# install every tool in this repo (or owner/repo/path@ref, or a github.com URL)
xwebmcp add kernel/xwebmcp
xwebmcp add kernel/xwebmcp/domains/southwest.com@main

xwebmcp list                      # what is installed and at which commit
xwebmcp add kernel/xwebmcp        # update to the current commit; prints a diff of changed code
xwebmcp remove southwest.com      # drop a namespace (or owner/repo, or namespace/tool)
```

Tools live under `~/.xwebmcp/` (override with `XWEBMCP_HOME`). `lock.json` records the
source, resolved commit, and SHA-256 of every file. When a repository has a
`registry.json`, its entries decide which files are tools and which namespace they
belong to; otherwise every `.js` file under the given path is a tool and its parent
directory is the namespace.

#### In your own Chrome (extension)

The `extension/` directory is a Chrome MV3 extension that runs the tool files unchanged
in your normal Chrome profile, with your real logins. `kind: "cdp"` bodies run in the
extension (a sandboxed page drives the tab over `chrome.debugger` with the same helper
API the Kernel browser REPL provides: `cdp`, `waitForEvent`, `gotoUrl`, `js`, `click`,
`fillInput`, `waitForElement`, …), so they keep running while the page navigates.

One-time setup (macOS and Linux; Chrome, Chromium, Beta, Dev, or Canary):

```sh
xwebmcp setup chrome        # quit Chrome first
```

This backs up Chrome's `Local State`, enables the `enable-webmcp-testing` flag
(`document.modelContext`), registers `xwebmcp` as a native messaging host, writes the
unpacked extension to `~/.xwebmcp/extension`, and opens `chrome://extensions`. There,
turn on **Developer mode** and **Load unpacked** → `~/.xwebmcp/extension`. The command
is idempotent; re-run it after upgrading `xwebmcp` to refresh the extension files.

Then:

```sh
xwebmcp attach              # push the installed tools into the extension
xwebmcp status              # flag, native host, bridge, and per-site access state
xwebmcp tools               # every WebMCP tool open tabs expose (site-native and custom)
xwebmcp invoke southwest.com/search_flights \
  --input '{"origin":"DAL","destination":"HOU","departureDate":"2026-10-20","tripType":"oneway"}'
```

The extension asks for no site access up front. After `attach`, open its popup and click
**Grant access** once so the installed tools' sites can be reached; the popup also lists
the tools on the current tab and whether each installed tool is registered there. The
same popup can grant a site so that its own WebMCP tools are discovered.

How invocation works and what to expect:

- `xwebmcp invoke namespace/tool` runs a cdp tool in a tab the extension opened itself,
  grouped under **xwebmcp**; it opens the site's apex when no such tab exists. Tabs you
  opened yourself are never used unless `allow_user_tabs` is passed through the API.
- `xwebmcp invoke <tool_ref>` (refs come from `xwebmcp tools`) invokes that exact live
  registration, native or custom, in the same shape as the Kernel API's
  `POST /browsers/{id}/webmcp/invoke`.
- `chrome.debugger` is attached only while a cdp tool runs and detached afterwards, so
  the "is debugging this browser" bar appears only during a call.
- A tool invoked from the page (`document.modelContext.executeTool`) keeps running in
  the extension if its document navigates away, but that document can no longer receive
  the result; the invocation log (`listInvocations`) records it as undelivered.
- Tool inputs are never logged or stored. Failed invocations keep the thrown error with
  its stack mapped to the tool file, the tool's console output, and timing, readable
  through `getInvocation`.

#### Connect an agent: `xwebmcp mcp`

`xwebmcp mcp` is a stdio MCP server that exposes the browser's tools to Claude Code,
Codex, Cursor, or any MCP client:

```sh
claude mcp add xwebmcp -- xwebmcp mcp            # Claude Code
codex mcp add xwebmcp -- xwebmcp mcp             # Codex
```

or in an `mcpServers` JSON config: `{"command": "xwebmcp", "args": ["mcp"]}`.

The server offers generic tools and one MCP tool per installed custom tool:

| tool | does |
|---|---|
| `list_tools` | WebMCP tools exposed by open tabs, site-native and custom, in the Kernel API's `WebMCPTool` shape |
| `invoke_tool` | run a tool by `tool_ref`, or an installed cdp tool by `namespace` + `name` (opens the site when no tab has it); returns `WebMCPInvocationResult` plus `diagnostics` on failure (error with stack mapped to the tool file, console output, timing) |
| `get_invocation` | diagnostics for a past invocation |
| `list_custom_tools`, `install_tool`, `remove_tool` | installed tools; `install_tool` takes a local file path |
| `open_tab`, `navigate_tab`, `close_tab`, `list_tabs` | tabs owned by the server |
| `southwest_com__search_flights`, … | each installed tool, with its own input schema |

By default the server only sees and acts on tabs it opened itself (an **xwebmcp** tab
group); pass `allow_user_tabs` / `all_tabs` per call, or start with `--all-tabs` to list
the user's tabs too. Tool inputs are never logged or stored by the server or the
extension. `--kernel <browser>` points the same server at a Kernel browser.

### Develop tools locally

This is the loop for iterating on a tool file against your normal, logged-in Chrome with
a coding agent driving it.

1. Install the extension and register the native host (once):
   `xwebmcp setup chrome`, then Load unpacked → `~/.xwebmcp/extension` in
   `chrome://extensions`. `xwebmcp status` should report `bridge: connected`.
2. Point the MCP server at your checkout:

   ```sh
   claude mcp add xwebmcp -- xwebmcp mcp --dev ~/src/xwebmcp
   ```

   `--dev` accepts a repository root (uses its `registry.json`), a `domains/<namespace>`
   directory, or a single tool file, and can be repeated. Every tool file under it is
   installed when the server starts and reinstalled whenever its content changes; tools
   installed with `xwebmcp add` keep working next to them. `xwebmcp dev <path>` runs the
   same watcher without an MCP server.
3. Grant the site once in the extension popup (**Grant access**) when the server reports
   pending origins.
4. Loop: the agent calls `invoke_tool` (`namespace` + `name`), reads the failure's
   `diagnostics.error.stack` (lines map to the tool file), edits the file, waits for the
   reinstall (`xwebmcp mcp` logs `installed <namespace>/<tool>` on stderr), and invokes
   again. `open_tab` / `navigate_tab` put a tab on the right page first when needed.

A prompt that works with Claude Code:

```
The tool file domains/probe.test/page_title.js is watched by the xwebmcp MCP server.
Invoke probe.test/page_title with input {} via invoke_tool. If it fails, use the
diagnostics to fix the file, then invoke again until it completes.
```

**Page inspection.** `xwebmcp mcp` deliberately has no screenshot, DOM-snapshot, or
network tools. Pair it with
[chrome-devtools-mcp](https://github.com/ChromeDevTools/chrome-devtools-mcp), which
can attach to the same running Chrome: enable remote debugging once at
`chrome://inspect/#remote-debugging` (Chrome 144+) and add it with `--autoConnect`:

```sh
claude mcp add chrome-devtools -- npx -y chrome-devtools-mcp@latest --autoConnect
```

Both servers then see the same tabs; use chrome-devtools-mcp's `take_screenshot`,
`take_snapshot`, `list_network_requests`, and `list_console_messages` on the tab an
xwebmcp invocation left behind. `chrome.debugger` (used while a cdp tool runs) and a
DevTools client can be attached to one tab at the same time; only the DevTools UI panel
open on that tab blocks the extension from attaching.

#### On a Kernel browser

```sh
# register every installed tool on a Kernel browser (KERNEL_API_KEY must be set)
xwebmcp attach --kernel <browser id or name>
xwebmcp tools --kernel <browser id or name>
```

`attach` replaces each namespace atomically (the first file of a namespace is sent with
`force_overwrite_namespace`), so re-running it after an update is safe for both targets.

### By hand

```sh
# 1. create a browser
kernel browsers create --profile personal-stuff --proxy cincy

# 2. in browser_repl (or via POST /browsers/{id}/webmcp/custom-tools):
const source = (await import("node:fs")).readFileSync("domains/delta.com/search_flights.js", "utf8");
await webmcp.addCustomTools({ namespace: "delta.com", tools: eval(source) });
const live = (await webmcp.listTools()).find(t => t.tool.name === "search_flights");
const result = await webmcp.invokeTool(live.tool_ref, { /* input */ }, { timeoutSec: 120 });
```

## Status vocabulary

`registry.json` and per-domain READMEs use:

- `draft` — written, not QA-tested.
- `qa_passed` — passed an independent QA pass.
- `verified` — QA passed and live end-to-end invocation verified.
- `broken` — regressed against the live site; see notes.

Never invoke a tool whose metadata you don't trust: check `match.url_patterns` and the
per-domain README first.
