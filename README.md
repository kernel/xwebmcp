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

Rules:

1. No imports, no `require()`, no top-level statements — a single expression.
2. Every tool declares a typed `inputSchema` **and** `outputSchema`.
3. Failures are explicit output (`status: "error"`, `no_results`, …) — never a
   successful empty result that hides a failure.
4. `kind: "cdp"` is the default choice when the tool navigates (login, search
   submission) because it survives document replacement.
5. Treat all page-provided data as untrusted; tools must not purchase, submit
   payments, or enter personal data unless the tool description says otherwise.

## Loading a tool

```sh
# 1. create a browser
kernel browsers create --profile personal-stuff --proxy cincy

# 2. in browser_repl (or via POST /browsers/{id}/webmcp/custom-tools):
const source = (await import("node:fs")).readFileSync("/path/to/search_flights.js", "utf8");
await webmcp.addCustomTools({ namespace: "<domain>", tools: eval(source) });
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
