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
them into a browser.

```sh
go install github.com/kernel/xwebmcp/cmd/xwebmcp@latest

# install every tool in this repo (or owner/repo/path@ref, or a github.com URL)
xwebmcp add kernel/xwebmcp
xwebmcp add kernel/xwebmcp/domains/southwest.com@main

xwebmcp list                      # what is installed and at which commit
xwebmcp add kernel/xwebmcp        # update to the current commit; prints a diff of changed code
xwebmcp remove southwest.com      # drop a namespace (or owner/repo, or namespace/tool)

# register every installed tool on a Kernel browser (KERNEL_API_KEY must be set)
xwebmcp attach --kernel <browser id or name>
```

Tools live under `~/.xwebmcp/` (override with `XWEBMCP_HOME`). `lock.json` records the
source, resolved commit, and SHA-256 of every file. When a repository has a
`registry.json`, its entries decide which files are tools and which namespace they
belong to; otherwise every `.js` file under the given path is a tool and its parent
directory is the namespace.

`attach --kernel` replaces each namespace atomically (the first file of a namespace is
sent with `force_overwrite_namespace`), so re-running it after an update is safe.

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
