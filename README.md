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
    README.md                    # status table, site quirks, known limitations
    <tool-name>.js               # one file per tool, named after the tool
tests/                           # node --test "tests/*.test.mjs"
registry.json                    # machine-readable index of every tool
spec/                            # the rules this repo follows, and JSON Schemas
scripts/validate-registry.mjs    # checks registry.json and domains/ against the spec
```

## Specification

The rules for layout, naming, `registry.json`, URL patterns, status values, and
per-domain READMEs are in [`spec/repository.md`](spec/repository.md). It is the
normative source; this README is a summary. The tool source format, the `cdp` and
`page` runtimes, and the invocation lifecycle are in
[`spec/cdp-tools.md`](spec/cdp-tools.md).

In short:

- one directory per registrable domain, one tool per file, namespace = domain;
- `url_patterns` default to `https://<domain>/*` and `https://*.<domain>/*`;
- every tool has a registry entry with a `status` of `draft`, `qa_passed`, `verified`,
  or `broken`, and the evidence the spec requires for that status;
- tools never assume which page the browser is on when they are invoked.

## Tool file contract

Every `*.js` tool file is a **self-contained JavaScript expression that evaluates to an
array containing one tool definition**, exactly the string you can hand to
`webmcp.addCustomTools({ namespace, source })`:

```js
[{
  kind: "cdp",                                   // "cdp" survives page navigation
  match: { url_patterns: ["https://delta.com/*", "https://*.delta.com/*"] },
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

No imports, no `require()`, no top-level statements. Failures are explicit output
(`status: "error"`, `no_results`, …), never a successful empty result. Tools must not
purchase, submit payments, or enter personal data unless the tool description says so.

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

Never invoke a tool whose metadata you don't trust: check its `status`, `notes`, and
`url_patterns` in `registry.json` and the per-domain README first.

## Contributing

Before opening a pull request:

```sh
node scripts/validate-registry.mjs   # registry.json, domains/, and READMEs against the spec
node --test "tests/*.test.mjs"        # tool tests
```

CI runs both on every pull request. Adding a tool means adding the tool file, a test, a
`registry.json` entry, and the per-domain README sections the spec requires.
