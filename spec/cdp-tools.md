# Custom WebMCP tool runtime

Status: draft for review. This document is the normative runtime specification for
custom WebMCP tools: the files in this repository and the runtimes that execute them.
It is written so that a second implementation (the `xwebmcp` Chrome extension under
`extension/`) can conform to the reference implementation, the Kernel browser image.

The key words MUST, MUST NOT, SHOULD, SHOULD NOT, and MAY are to be interpreted as
described in RFC 2119 and only mark behavior a conforming runtime or tool file is held
to. Everything else is description.

Repository layout, `registry.json`, and how `xwebmcp add` resolves sources are covered
by [`repository.md`](repository.md) and are not repeated here.

## Citations

Claims about the reference implementation cite `kernel/kernel-images` at commit
`92a94a0dd723b19b1e738c218bb756a54d181c65` and `kernel/kernel` at commit
`d61af74eefddee93b75be29135b280445077ed1f` as `file:line`. The relevant files:

| short name | path |
|---|---|
| `definitions.ts` | `server/runtime/custom-webmcp-definitions.ts` |
| `page-runtime.ts` | `server/runtime/custom-webmcp-page-runtime.ts` |
| `custom-webmcp.ts` | `server/runtime/custom-webmcp.ts` |
| `helpers.ts` | `server/runtime/browser-helpers.ts` |
| `cdp-client.ts` | `server/runtime/browser-cdp-client.ts` |
| `page-evaluation.ts` | `server/runtime/page-evaluation.ts` |
| `browser-repl.ts` | `server/runtime/browser-repl.ts` |
| `custom_webmcp.go` | `server/cmd/api/api/custom_webmcp.go` |
| `webmcp.go` | `server/cmd/api/api/webmcp.go` |
| `webmcpclient.go` | `server/lib/webmcpclient/client.go` |
| `webmcpclient-types.go` | `server/lib/webmcpclient/types.go` |
| `openapi.yaml` | `packages/api/openapi.yaml` in `kernel/kernel` |

## 1. Terms

- **Tool file**: one `*.js` file in a `domains/<namespace>/` directory whose content is a
  single JavaScript expression evaluating to an array of *definitions*.
- **Definition**: one element of that array (§3).
- **Runtime**: the component that evaluates tool files, registers their tools on
  documents, and executes them. The reference runtime is the Kernel browser image's
  browser REPL; the extension is the second runtime.
- **Registration**: the act of calling `document.modelContext.registerTool` for a
  definition on a specific document.
- **Invocation**: one execution of a definition's `execute` for one input.
- **Top document**: the top-level document of a tab. **Frame**: any document in the
  tab's frame tree, including out-of-process iframes.

## 2. Tool kinds

A definition's `kind` is `"page"` or `"cdp"` (`definitions.ts:278`).

| | `kind: "page"` | `kind: "cdp"` |
|---|---|---|
| where `execute` runs | inside the registering document's main world, as page JavaScript (`custom-webmcp.ts:435-439`, `page-runtime.ts:150-151`) | outside the page, in the runtime; the page holds only a stub that forwards the call (`page-runtime.ts:157-177`) |
| receives | `input` and the WebMCP `{signal}` | `input` and a context `{signal, matches}` plus the browser helpers (§7) |
| lives as long as | the registering document (§2.2) | the invocation: the runtime owns the execution (§6.4) |
| can drive the tab | only through the DOM and JavaScript of its own document | through CDP: navigation, trusted input, other frames, other tabs |

### 2.1 Choosing a kind

`page` is the default. A tool SHOULD be `kind: "page"` when its work happens in the
document it is registered on: reading or changing the DOM, filling fields, same-document
route changes (`history.pushState`, fragment changes), and `fetch`/XHR issued from the
page context with the page's own cookies, including requests that mutate state through
the site's API.

A tool SHOULD be `kind: "cdp"` only when both hold:

1. the tool itself replaces the document it runs against: it follows a link, assigns
   `location`, submits a form, or reloads; and
2. the caller materially benefits from a structured result read *after* that
   navigation, in the same call: parsed result rows, the post-login state, a
   confirmation read from the next page.

A tool that navigates but has nothing useful to report from the next document SHOULD be
`page` and MUST follow §2.2. A flow that needs output from the next document MAY instead
be split into `page` tools (§2.3); choose `cdp` when one call returning the post-navigation
result is what makes the tool useful.

The exceptions in §2.4 are the only other reasons to choose `cdp`. Tools in this
repository predate this rule and are all `kind: "cdp"`; reclassifying an existing tool is
a change to that tool, not to this document.

### 2.2 Document lifetime of a `page` tool

A `page` tool's `execute` runs in its registering document and stops when that document
is replaced. A `page` tool MUST NOT replace its registering document (navigation, form submission,
reload) before the promise it returned has settled. To navigate, it MUST compute its
result first and start the navigation after settling, for example
`setTimeout(() => form.requestSubmit(), 100)` followed by `return {submitted: true}`.
Same-document navigations do not replace the document and are not restricted.

When the rule is broken, the returned value is lost and the outcome is not observable.
The reference runtime reports such an invocation as `completed` with an empty `output`:
that status arrives from Chrome in `WebMCP.toolResponded`, and the reference forwards
the response unchanged (`webmcpclient-types.go:73-78`, `webmcpclient.go:184-200`,
`webmcp.go:179-187`). Observed on a Kernel browser on 2026-09-26 (the image version was
not pinned to the commit above): a tool that called
`location.assign()` or `form.submit()` and then awaited returned
`{"status":"completed","output":[]}` within 0.2 s; the same tool deferring the navigation
with `setTimeout` returned its value. A runtime that can detect that the registering
document was replaced before a `page` tool settled SHOULD report the invocation as
`outcome_unknown` (§6.7) rather than as `completed`.

**No page assumptions.** Wildcard URL patterns (§5) mean a tool can be invoked on any
page of its domain, which is the rule [`repository.md`](repository.md) refers to: a tool
MUST NOT assume it starts on its entry page, a form, or state left by an earlier call,
and MUST check that the current page is suitable before acting. A `cdp` tool that finds
an unsuitable page navigates to its entry point and continues. A `page` tool MUST NOT do
that, because the continuation would run in a destroyed document; it settles with an
explicit output instead (for example `{status: "wrong_page", entry_url}`), or narrows
`match.url_patterns` so that it is only registered where it works.

### 2.3 Phased `page` tools

A flow that crosses a navigation can be built from `page` tools, one per document:

1. The first tool, registered on the start document, does its same-document work,
   settles with an output that names the next tool and the document it expects
   (for example `{submitted: true, next_tool: "read_results", expected_url}`), and only
   then starts the navigation (§2.2).
2. The next tool is registered through `match.url_patterns` that match the destination
   document and reads its result there.

The caller waits for the destination tool to appear (discovery changes when documents
change, §8) and invokes it by its new `tool_ref`; a `tool_ref` from the start document is
not valid on the next one (§8). The destination tool MUST NOT assume that the first phase
ran and SHOULD be read-only, so that calling it again is safe. Phased tools suit flows
where the caller decides between steps (for example a login that may stop at MFA);
a single `cdp` tool suits flows where the caller wants one answer.

### 2.4 Technical exceptions

A tool MAY be `kind: "cdp"` without meeting §2.1 when the work cannot be done from the
registering document's JavaScript:

- the site requires trusted input events (`isTrusted`, real key and pointer sequences):
  `click`, `typeText`, `pressKey` (§7);
- the work is inside a cross-origin frame: `iframeTarget` (§7);
- a file must be attached from a path: `uploadFile` (§7);
- the work spans tabs or targets: `newTab`, `switchTab`, `closeTab` (§7);
- the tool must read responses to requests the page itself makes, as opposed to
  requests the tool issues with `fetch`: `cdp('Network.*')`, `waitForEvent` (§7);
- the tool needs browser-only surfaces: `captureScreenshot`, `accessibilitySnapshot` (§7).

A tool that uses a `cdp` helper only for convenience, where page JavaScript would do,
SHOULD be `page`.

## 3. Tool source format

### 3.1 The single-expression rule

A tool file MUST be a single JavaScript expression that evaluates (possibly through a
promise) to a non-empty array of definitions. It MUST NOT contain top-level
statements, imports, or `require`.

The reference runtime wraps the file verbatim inside the expression
`webmcp.addCustomTools({namespace, tools: await (SOURCE), forceOverwriteNamespace})`
(`custom_webmcp.go:50`) and rejects the result when `tools` is not a non-empty array
(`definitions.ts:217-219`). Any wrapping a runtime uses MUST place the file inside
parentheses so that the file's own syntax is not altered, and MUST await the result so
that a file evaluating to a promise (for example an async IIFE, as
`domains/jetblue.com/search_flights.js` does) works.

### 3.2 Trailing semicolons

Because the file is wrapped in parentheses, a trailing `;` is a syntax error in the
reference runtime (`await ([...];)` does not parse). This specification resolves the
question as follows:

- A tool file MUST NOT end with a semicolon. Leading and trailing whitespace and
  comments are allowed.
- A runtime MAY strip trailing whitespace and one or more trailing semicolons before
  wrapping, as `xwebmcp` does (`internal/toolsource`), but tool files MUST NOT rely on it.

`domains/delta.com/search_flights.js` ended with `];` and is corrected in the change
that introduces this document.

### 3.3 What the file evaluates to

Each element of the array is an object with these members
(`definitions.ts:33-46`, validated at `definitions.ts:276-306`):

| member | requirement | reference |
|---|---|---|
| `kind` | `"page"` or `"cdp"` | `definitions.ts:278` |
| `match.url_patterns` | non-empty array of URL patterns (§5), each of which MUST parse | `definitions.ts:281-284` |
| `tool` | MCP tool metadata: `name` and `inputSchema` required, `title`, `description`, `outputSchema`, `annotations` optional; parsed with the MCP SDK `ToolSchema` | `definitions.ts:287-293` |
| `tool.inputSchema`, `tool.outputSchema` | MUST be compilable JSON Schemas (Ajv) | `definitions.ts:295-298` |
| `execute` | a function `(input, context) => output` (possibly async) | `definitions.ts:285` |

For `kind: "page"`, `execute.toString()` MUST be a valid function expression, because
the runtime re-creates the function from its source inside the page
(`definitions.ts:299-306`).

The `tool.name` is namespaced at registration time (§4.2); the name inside the file is
the bare tool name (for example `search_flights`).

## 4. Namespaces, identity, and registration batches

### 4.1 Namespace

A batch of definitions is added under a namespace that MUST match
`^[A-Za-z0-9_.-]{1,128}$` (`definitions.ts:6,214`). By repository convention the
namespace is the registrable domain of the site and equals the tool file's directory
name (see `README.md`); the runtime does not enforce the convention.

### 4.2 Identity

Each added definition receives a generated id matching `^ct_[a-z][a-z0-9]{23}$`
(`definitions.ts:245`, `openapi.yaml:8098-8106`). A tool is registered on documents
under the hidden name `custom.<id>.<name>`, which MUST NOT exceed 128 characters
(`definitions.ts:80-85`). Discovery (§8) MUST map that hidden name back to the
definition and expose the bare `tool.name` together with `source.custom.{id,
namespace}` (`webmcpclient.go:208-232`, `webmcp.go:80-99`).

### 4.3 Conflicts and `force_overwrite_namespace`

Within one runtime the pair (namespace, `tool.name`) is unique. Adding a batch that
contains an already-registered pair MUST fail with the conflict code
`custom_tool_conflict` (HTTP 409 in the API) and MUST NOT add any tool from the batch
(`definitions.ts:233-243`, `custom_webmcp.go:55-57`).

When `force_overwrite_namespace` is true, every existing tool in that namespace is
removed and the batch is added, atomically (`definitions.ts:226-230`). Invocations
already running continue (`openapi.yaml`, "Existing invocations continue").

### 4.4 Revisions

Every successful add or remove increments a runtime-wide revision
(`definitions.ts:258,272`). A registration carries the revision it was made with; an
invocation whose definition has since been replaced MUST be refused with
"custom tool is no longer registered" (`page-runtime.ts:231-235`,
`custom-webmcp.ts:85-86`).

## 5. URL patterns and matching

A pattern is `<scheme>://<host><path>` (`definitions.ts:123-145`):

- `scheme` is `http`, `https`, or `*` (`*` matches both).
- `host` is an exact host (`host:port` when a port is present), `*`, or `*.<suffix>`.
  A `*.` host matches the suffix itself and any subdomain (`definitions.ts:166-171`).
  Any other use of `*` in the host is rejected.
- `path` MUST be present (at least `/`); `*` in the path matches any sequence of
  characters. The path pattern is matched against `pathname + search` of the URL
  (`definitions.ts:118-121,173`).

Before matching, the URL's fragment is removed (`definitions.ts:147-150`). Host
comparison is case-insensitive.

Repository convention (README, "Conventions") is `["https://<domain>/*",
"https://*.<domain>/*"]`; the runtime accepts any pattern the grammar allows.

## 6. Registration and invocation lifecycle

### 6.1 Where a tool is registered

The reference runtime attaches to every `page` target whose URL is `http(s)`
(`custom-webmcp.ts:257-260`), reads the tab's full frame tree including out-of-process
iframes reached through flat child sessions (`custom-webmcp.ts:352-386`), and computes,
per definition, the list of frames whose URL matches any of its patterns
(`custom-webmcp.ts:391-403`). Each match is recorded as

```json
{"frame_id": "...", "session_id": "...", "target_id": "... or null", "top_target_id": "...", "url": "..."}
```

A definition with at least one matching frame is registered once on the tab's **top
document** (`custom-webmcp.ts:404-449`): `kind: "page"` tools in the main world,
`kind: "cdp"` tools in a dedicated isolated world named `kernel-custom-webmcp`
(`custom-webmcp.ts:8,414-419,436-445`). The runtime MUST re-register after every
document replacement of the top document (`custom-webmcp.ts:405-409`).

### 6.2 Dispatch

An invocation reaches the runtime in one of two ways:

- **From the page**: an agent calls `document.modelContext.executeTool` on the
  registered stub; the stub sends `{type: "invoke", invocation_id, definition_id,
  revision, input}` to the runtime (`page-runtime.ts:170-176`) and, if its
  `AbortSignal` fires, `{type: "cancel", invocation_id}` (`page-runtime.ts:161-169`).
- **From the API**: `POST /browsers/{id}/webmcp/invoke` with a `tool_ref` obtained
  from discovery; for a `cdp` tool the API resolves the definition and the tab's CDP
  target and calls the runtime directly (`webmcp.go:134-154`, `custom_webmcp.go:105-171`).

### 6.3 Execution

For a `cdp` invocation the runtime MUST:

1. Validate `input` against `tool.inputSchema` and fail with
   `input failed JSON Schema validation: <detail>` when it does not validate
   (`page-runtime.ts:54-55`).
2. Call `execute(input, {signal, matches})` with the browser helpers (§7) in scope and
   the tab that registered the tool as the attached target (`page-runtime.ts:56-59`,
   `custom_webmcp.go:130`).
3. Validate the returned value against `tool.outputSchema` when one is declared and
   fail with `output failed JSON Schema validation: <detail>` otherwise
   (`page-runtime.ts:60-64`).
4. Treat `undefined` as `null` (`page-runtime.ts:65`).
5. Reject a result whose JSON serialization exceeds 1 MiB with
   `custom WebMCP output exceeds 1 MiB` (`definitions.ts:4`, `page-runtime.ts:66-68`).

The reference API additionally rejects results above 240 KiB for API-originated
invocations (`custom_webmcp.go:20,140`). A conforming runtime MUST enforce the 1 MiB
limit and MAY enforce the lower API limit.

### 6.4 Navigation during a call

Because a `cdp` body runs outside the page, it keeps running while the tab navigates;
helpers observe the new document. When the invoking document was replaced, the result
cannot be delivered to it: the reference runtime swallows the delivery failure
(`page-runtime.ts:262-266`). The invocation is still complete. A runtime MUST NOT abort
a running body merely because its registering document navigated, and SHOULD keep the
result retrievable by other means (the extension keeps an invocation log). This is the
gap tracked upstream as
[webmachinelearning/webmcp#212](https://github.com/webmachinelearning/webmcp/issues/212).

A `page` tool has no such continuation: its execution ends with its document (§2.2).

### 6.5 Timeouts

- API invocations accept `timeout_sec` in `[1, 120]`, default 60
  (`webmcp.go:17-18,122-127`, `openapi.yaml`, `WebMCPInvokeRequest`).
- The runtime races the body against the deadline; on expiry the body is aborted and
  the invocation fails with `outcome_unknown` (`browser-repl.ts:352-379`,
  `custom_webmcp.go:116-143`).
- Helper waits are clamped to end 500 ms before the execution deadline so that the
  helper's error is reported instead of a hard kill (`helpers.ts:19,206-213`,
  `cdp-client.ts:53,485-494`).

A runtime MUST bound every invocation by a deadline and MUST report `outcome_unknown`
rather than a result when the deadline passes after the body started.

### 6.6 Cancellation

`context.signal` is an `AbortSignal`. It fires when the page-side caller aborts
(`page-runtime.ts:161-169,217-221`), when the runtime is disposed
(`page-runtime.ts:43-46`), or when the API deadline expires. Helpers do not check the
signal; a body that wants to stop early MUST check `signal.aborted` itself. Abort is
delivered as an `AbortError` to a page-side caller.

### 6.7 Errors

A thrown error becomes the invocation's `error_text`. Error text is truncated to
64 KiB with a `...[truncated]` marker (`page-runtime.ts:9,19-23`).

Distinguished failure codes seen by API callers (`custom_webmcp.go:146-165`,
`webmcp.go:162-174`):

| code | meaning | HTTP |
|---|---|---|
| `custom_tool_not_found` / tool not found | the tool_ref no longer names a live registration, or the definition is gone | 404 |
| `outcome_unknown` | the body started but its outcome could not be observed; callers MUST NOT retry automatically | 504 |
| execution error | `status: "error"` with `error_text` in a 200 response | 200 |

### 6.8 Tab or frame disappears

If the tab closes while a body runs, CDP commands fail ("Detached while handling
command" or "Inspected target navigated or closed"); the body sees those as helper
errors. If the failure surfaces as the invocation's outcome, the runtime reports it as
an execution error when the body caught it and returned, and as `outcome_unknown`
when the runtime can no longer observe the body (`webmcpclient.go:376-383`).

### 6.9 Concurrency

The reference REPL serializes executions (`openapi.yaml`, `/repl`: "Executions are
serialized"). Tool descriptions in this repository assume serial use per tab. A runtime
MAY run invocations for different tabs concurrently and MUST NOT run two invocations
that share a tab concurrently.

## 7. Helpers available to a `cdp` body

The body of a `cdp` tool is evaluated in the REPL's evaluation context, where the
helpers below are free identifiers and are also grouped under `browser`
(`helpers.ts:1151-1157`, `browser-repl.ts:392-395,417-422`). A conforming runtime MUST
provide every helper with the signature and semantics given here. Signatures are
TypeScript-style; `Sec` values are seconds.

| helper | signature | semantics | reference |
|---|---|---|---|
| `cdp` | `(method: string, params?: object, sessionId?: string \| null) => Promise<unknown>` | Raw CDP. `sessionId === null` sends browser-level; a string sends to that session; omitted sends to the attached tab session, except that `Target.*`, `Browser.*`, `SystemInfo.*`, `Storage.*` are routed browser-level. Rejects with `CDP <method> failed: <message> (code N)`. | `helpers.ts:217-232`, `cdp-client.ts:276` |
| `drainEvents` | `() => Promise<CdpEvent[]>` | Returns and clears the buffered events (ring of 500). `CdpEvent = {method, params, sessionId?, time}`. | `helpers.ts:234-237`, `cdp-client.ts:39,288-293,753-757` |
| `waitForEvent` | `(method: string, options?: {sessionId?: string \| null, timeoutSec?: number, predicate?: (e: CdpEvent) => boolean}) => Promise<CdpEvent \| null>` | Resolves with the first matching event or `null` on timeout (default 30 s). Without `sessionId` it waits on the attached tab session and throws if none is attached; `sessionId: null` waits on browser-level events. Unknown options throw. | `helpers.ts:239-279` |
| `gotoUrl` | `(url: string) => Promise<{frameId, loaderId?}>` | `Page.navigate` on the attached tab; returns immediately. | `helpers.ts:281-283` |
| `pageInfo` | `() => Promise<{url, title, viewport, scroll, page, ready_state, dialog}>` | Reads location, title, sizes and `document.readyState`; when a modal dialog is pending returns `{dialog, url, title}` without evaluating in the page. | `helpers.ts:304-349` |
| `accessibilitySnapshot` | `() => Promise<{url, title, nodes: {backendNodeId, role, name, value?, checked?, pressed?, selected?, expanded?, disabled?}[]}>` | `Accessibility.getFullAXTree` filtered to non-ignored nodes with a backend node. | `helpers.ts:285-302` |
| `click` | `(target: string \| {x, y} \| {backendNodeId}, options?: {button?, clickCount?, timeoutSec?}) => Promise<void>` | Waits (default 10 s) for a single visible, enabled, stable, unobscured match, scrolls it into view, then dispatches mouse events at its center. Multiple visible matches throw. | `helpers.ts:351-420,887-1019,1021-1088` |
| `typeText` | `(text: string) => Promise<void>` | `Input.insertText`. | `helpers.ts:422-424` |
| `fillInput` | `(target: string \| {backendNodeId}, text: string, options?: {clearFirst?: boolean, timeoutSec?: number}) => Promise<void>` | Focuses an editable target (default 10 s), selects-all and deletes when `clearFirst` (default true), presses each character, then dispatches `input` and `change`. | `helpers.ts:426-484` |
| `pressKey` | `(key: string, modifiers?: number \| string[] \| {[m]: boolean}) => Promise<void>` | Dispatches keyDown/char/keyUp for a US-layout key name or a single character. | `helpers.ts:486-542` |
| `scroll` | `(x: number, y: number, dy = -300, dx = 0) => Promise<void>` | Mouse-wheel at a point, 5 s command timeout. | `helpers.ts:544-557` |
| `captureScreenshot` | `(path?: string, fullPage = false, maxDim?: number) => Promise<string>` | PNG of the attached tab; the reference writes a VM file and returns its path. | `helpers.ts:560-583` |
| `listTabs` | `(includeChrome = true) => Promise<{targetId, title, url}[]>` | Page targets. | `helpers.ts:586-592` |
| `currentTab` | `() => Promise<{targetId, url, title}>` | The attached tab. | `helpers.ts:594-604` |
| `switchTab` | `(target: string \| {targetId}) => Promise<string>` | Attach to another tab; returns its session id. | `helpers.ts:612-614` |
| `newTab` | `(url = 'about:blank') => Promise<string>` | Reuses a blank current tab or creates a target, attaches, navigates, waits for the commit. Returns the target id. | `helpers.ts:616-641` |
| `closeTab` | `(target?: string \| {targetId}) => Promise<void>` | Closes the given or attached tab. | `helpers.ts:643-658` |
| `ensureRealTab` | `() => Promise<{targetId, url, title} \| null>` | Attaches to a non-internal page if the current one is internal. | `helpers.ts:660-671` |
| `iframeTarget` | `(urlSubstring: string) => Promise<{targetId, url, title, type} \| null>` | First out-of-process iframe target whose URL contains the substring. | `helpers.ts:673-680` |
| `waitMs` | `(milliseconds = 1000) => Promise<void>` | Sleep. | `helpers.ts:682-684` |
| `waitForLoad` | `(timeoutSec = 15) => Promise<boolean>` | Polls `document.readyState === 'complete'`. | `helpers.ts:686-697` |
| `waitForElement` | `(target: string \| {backendNodeId}, options?: {state?: 'attached' \| 'detached' \| 'visible' \| 'hidden', timeoutSec?: number}) => Promise<boolean>` | Polls all matches for the state (default `visible`, 10 s). Returns `false` on timeout, never throws for a missing element. | `helpers.ts:699-739` |
| `waitForNetworkIdle` | `(idleSec = 0.5, timeoutSec = 30) => Promise<boolean>` | True once no tracked request on the attached session was in flight for `idleSec`. | `helpers.ts:741-757` |
| `js` | `(expressionOrFunction: string \| ((arg) => unknown), options?: {arg?: unknown, targetId?: string}) => Promise<unknown>` | Evaluates once in the attached tab (or another target), awaiting promises, returning by value. A function is serialized from its source and called with `arg` revived from JSON, so it MUST NOT close over body variables. A thrown page error rejects with the error's description. | `helpers.ts:759-780`, `page-evaluation.ts`, `cdp-client.ts:724-737` |
| `uploadFile` | `(target: string \| {backendNodeId}, path: string \| string[]) => Promise<void>` | `DOM.setFileInputFiles` with browser-machine paths. | `helpers.ts:782-809` |
| `httpGet` | `(url: string, headers?: Record<string,string>, timeoutSec = 20) => Promise<string>` | Fetches from the runtime's process, not the page; non-2xx throws. | `helpers.ts:811-847` |

Semantics shared by helpers:

- The **attached tab** is the tab that registered the tool; it is attached at the start
  of every invocation with `Page`, `DOM`, `Runtime`, and `Network` enabled and brought to
  the foreground (`cdp-client.ts:510-547,549-566`).
- Single CDP commands time out after 30 s (`cdp-client.ts:46`).
- A modal JavaScript dialog left open is auto-dismissed on attach and reported
  (`cdp-client.ts:568-596`).
- Evaluation errors from `js` carry the page error's description, including
  "Inspected target navigated or closed" and "Execution context was destroyed" during
  navigation; tools in this repository rely on those strings
  (`domains/united.com/search_flights.js`).

Helpers not listed here (`repl.*`, `webmcp.*`) are REPL conveniences and MUST NOT be
used by tool files.

## 8. Discovery and invocation formats

Runtimes expose tools and invocation results in the shapes of the Kernel browser API.
The JSON Schemas under [`schemas/`](schemas/) are generated from
`openapi.yaml:8062-8292` and are normative for both runtimes.

| schema | used by |
|---|---|
| [`WebMCPTool`](schemas/WebMCPTool.json), [`WebMCPToolsResponse`](schemas/WebMCPToolsResponse.json) | discovery: `GET /browsers/{id}/webmcp/tools`; extension `listTools` |
| [`WebMCPToolSource`](schemas/WebMCPToolSource.json), [`WebMCPToolFrame`](schemas/WebMCPToolFrame.json), [`WebMCPCustomToolSource`](schemas/WebMCPCustomToolSource.json), [`WebMCPToolMetadata`](schemas/WebMCPToolMetadata.json), [`WebMCPToolAnnotations`](schemas/WebMCPToolAnnotations.json) | parts of `WebMCPTool` |
| [`WebMCPInvokeRequest`](schemas/WebMCPInvokeRequest.json) | `POST /browsers/{id}/webmcp/invoke`; extension `invoke` |
| [`WebMCPInvocationResult`](schemas/WebMCPInvocationResult.json), [`WebMCPInvocationFailure`](schemas/WebMCPInvocationFailure.json) | invocation outcome |
| [`AddCustomWebMCPToolsRequest`](schemas/AddCustomWebMCPToolsRequest.json), [`CustomWebMCPMatch`](schemas/CustomWebMCPMatch.json), [`CustomWebMCPDefinition`](schemas/CustomWebMCPDefinition.json), [`CustomWebMCPToolsResponse`](schemas/CustomWebMCPToolsResponse.json) | `POST/GET /browsers/{id}/webmcp/custom-tools`; extension `addCustomTools` / `listCustomTools` |

Requirements beyond the schemas:

- Discovery MUST list every WebMCP tool registered on every open tab and frame, site-
  provided and custom, and MUST rename custom registrations from
  `custom.<id>.<name>` to `<name>` with `source.custom` set (§4.2). `source.frame` is
  `null` for the top document and `{frame_id, url}` for an embedded frame; `frame.url`
  and `page_url` omit the fragment (`openapi.yaml:8085-8137`).
- A `tool_ref` identifies one live registration and MUST become invalid when that
  document is replaced (`openapi.yaml:8168-8170`). Its format is opaque to callers.
- `input` is limited to 1 MiB after JSON serialization (`webmcp.go:19,118-120`).
- `status` is `completed`, `canceled`, or `error` for imperative tools;
  `awaiting_submission` only for declarative form tools that were populated but not
  submitted (`webmcpclient.go:365,408-418`).

## 9. Extension conformance

The extension cannot reach two things the reference runtime has: the DevTools `WebMCP`
domain (Chrome's `chrome.debugger` allowlist excludes it; the extension discovers and
invokes through the page API `document.modelContext.getTools()` / `executeTool()`
instead) and a browser-level CDP connection (there is no `Target.getTargets` for
extensions; targets come from `chrome.debugger.getTargets()`). Within those limits the
following deviations are conforming:

1. **Registration world.** cdp tools MAY be registered from the extension's isolated
   content-script world instead of a CDP-created isolated world; the page still sees
   them through `getTools()`.
2. **Frame coverage.** The extension registers a tool on the top document only when the
   top document's URL matches. It does not register a tool on the top document because
   only an embedded frame matched (§6.1). `context.matches` MUST still list every
   matching frame, including out-of-process iframes reached through flat child
   sessions.
3. **Debugger attachment.** `chrome.debugger` is attached only for the duration of an
   invocation and detached afterwards; Chrome shows its info bar while attached. The
   attached-tab semantics of §7 hold for the duration of the call.
4. **Root session id.** chrome.debugger gives the tab's page session no CDP session id.
   The extension mints `root:<targetId>` for it so that `event.sessionId`,
   `waitForEvent({sessionId})`, and `cdp(method, params, sessionId)` keep the reference
   semantics. Bodies MUST treat session ids as opaque.
5. **Browser-level commands.** `cdp(method, params, null)` and the browser-routed
   families of §7 are sent to the attached tab's page target, where
   `Target.createTarget`, `Target.closeTarget`, and `Target.activateTarget` are
   answered. `Target.getTargets` is unavailable; `listTabs` is served from
   `chrome.debugger.getTargets()`.
6. **`captureScreenshot`** returns a `data:image/png;base64,` URL instead of a file path;
   `maxDim` is unsupported and throws.
7. **`httpGet`** fetches from the extension service worker.
8. **`uploadFile`** paths are paths on the user's machine.
9. **Native tool output.** Chrome's `executeTool` returns a tool's result as a JSON
   string; the extension parses it so that `output` is the structured value, as in the
   reference API.
10. **`awaiting_submission`** cannot be observed through the page API; the extension
    reports such invocations as `completed` with a null output.
11. **Evaluation site.** Tool files are evaluated in a sandboxed extension page because
    MV3 forbids `eval` elsewhere; helper calls are relayed to the service worker, which
    is the only component that calls `chrome.debugger`.
12. **`kind: "page"` under CSP.** A page whose Content-Security-Policy forbids `eval`
    blocks materializing a page tool's `execute`; the extension reports the registration
    error instead of registering the tool. Because `page` is the default kind (§2.1),
    this affects every `page` tool on such a site.
13. **Site access.** The extension holds no host permissions by default and asks the
    user once per site; tools on sites without access are not registered and their
    native tools are not discovered.
14. **Tab ownership.** Invocations that do not come from the page run only in tabs the
    extension opened unless the caller opts in; this is a policy layer above this
    specification, not a change to invocation semantics.
15. **`page` tool lifetime.** The extension reports a `page` invocation whose registering
    document was replaced before the tool settled as `outcome_unknown`, as §2.2
    recommends, where the reference reports `completed`.

## 10. Out of scope

Per-site hosting of tool files and `.well-known` discovery are not part of this
specification. Repository layout and source resolution are in
[`repository.md`](repository.md).
