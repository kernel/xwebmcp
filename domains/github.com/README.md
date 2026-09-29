# github.com

Tools for GitHub (https://github.com): repository and issue/pull request search, and read-only detail pages for one repository, issue or pull request. Everything here only reads; no tool signs in, comments, stars, forks, creates or changes anything.

| tool | file | status | notes |
|------|------|--------|-------|
| get_issue | [get_issue.js](get_issue.js) | qa_passed | Issue title, state and close reason, labels, assignees, milestone, linked pull requests, body and the first timeline items GitHub puts in the page (about 15). Signed-out tabs only (see Site quirks); private repositories not tested. |
| get_pull_request | [get_pull_request.js](get_pull_request.js) | qa_passed | Pull request state (open, draft, closed, merged), branches, head and merge commits, times, labels and the description as text. No comments, review threads, files, checks or lock state. Public repositories signed out; private repositories not tested. |
| get_repository | [get_repository.js](get_repository.js) | qa_passed | Repository overview from the repository page: description, topics, star, fork and watcher counts, license, default branch, latest commit, counts, root entries and README text; `empty_repository` for a repository with no commits. Public repositories signed out; private repositories not tested. |
| search_issues | [search_issues.js](search_issues.js) | qa_passed | One page of 10 issue or pull request search results with GitHub qualifiers, sorting and paging. |
| search_repositories | [search_repositories.js](search_repositories.js) | qa_passed | One page of 10 repository search results with GitHub qualifiers, sorting and paging. |

Register all five files together as one array with `forceOverwriteNamespace: true`;
registering one file that way removes the others.

## Scope and loading

The tools search GitHub and read repository, issue and pull request pages. None of them opens
a sign-in prompt, changes account state, posts anything or navigates the tab. They use only the
tab's own session, so a repository the signed-in tab can see is read the same way as a public
one (except `get_issue`, which runs only when the page says the tab is signed out), but that was not tested. Account-specific state (whether you starred or watch a repository,
your permissions on an item) is deliberately not returned.

```javascript
const fs = await import("node:fs");
const files = ["get_issue", "get_pull_request", "get_repository", "search_issues", "search_repositories"];
const tools = files.flatMap(name => eval(fs.readFileSync(`domains/github.com/${name}.js`, "utf8")));
await webmcp.addCustomTools({ namespace: "github.com", tools, forceOverwriteNamespace: true });
const ref = async name => (await webmcp.listTools()).find(t => t.source.custom?.namespace === "github.com" && t.tool.name === name).tool_ref;
await webmcp.invokeTool(await ref("search_repositories"), { query: "topic:cli language:go", sort: "stars" }, { timeoutSec: 60 });
await webmcp.invokeTool(await ref("get_repository"), { owner: "<owner from search>", repo: "<name from search>" }, { timeoutSec: 60 });
await webmcp.invokeTool(await ref("search_issues"), { query: "repo:<owner>/<name> is:open label:bug", sort: "comments" }, { timeoutSec: 60 });
await webmcp.invokeTool(await ref("get_issue"), { owner: "<owner>", repo: "<name>", number: 1234 }, { timeoutSec: 60 });
await webmcp.invokeTool(await ref("get_pull_request"), { owner: "<owner>", repo: "<name>", number: 1235 }, { timeoutSec: 60 });
```

The tools are listed while the tab is on any `https://github.com/*` page (see URL patterns);
they read the site with relative same-origin requests, so the starting page does not matter.
Live timings on 2026-09-29: about 0.1 to 1.2 s for searches and `get_repository`, 1 to 2 s for `get_issue` and `get_pull_request`, up to about 6 s for a pull request page with a
very large conversation, and one search answered HTTP 502 after about 9 s; `timeoutSec: 60` is plenty.

How each tool reaches the site. All five are `kind: "page"`: none navigates, and each result is
computed and returned from the registering document before anything else happens, so there is
no post-navigation result that would justify `cdp`.

| tool | kind | method |
|------|------|--------|
| search_repositories | page | `GET /search?q=…&type=repositories[&s=…&o=…][&p=…]` with `Accept: application/json`, the search page's own JSON (`payload.blackbirdSearchRoute`: results, `page_count`, `result_count`, `errors`). |
| search_issues | page | the same route with `type=issues` or `type=pullrequests`. |
| get_repository | page | `GET /<owner>/<repo>` as HTML; `meta[name="route-pattern"]` must be `/:user_id/:repository` (other pages such as `/topics/…` are `not_found`); a repository page without embedded data that says "This repository is empty" is an empty repository (`empty_repository`, name and visibility from the `octolytics-dimension-repository_*` meta tags); otherwise the page's embedded `script[data-target="react-app.embeddedData"]` JSON: `sidebarAbout` (description, topics, counts, license, flags), `codeViewLayoutRoute` (default branch, creation time, empty flag) and `codeViewRepoRoute` (root entries, commit count, latest commit, rendered README HTML). The README HTML is parsed with `DOMParser` (which runs nothing) and reduced to text. |
| get_issue | page | refuses (`signed_in_side_effect`) unless the document has `meta[name="user-login"]` present with empty content, i.e. a signed-out GitHub page; otherwise `GET /<owner>/<repo>/issues/<n>` as HTML, then the embedded `IssueViewerViewQuery` result: the issue, its labels, assignees, linked pull requests and its first timeline items. |
| get_pull_request | page | `GET /<owner>/<repo>/pull/<n>` as HTML, then the embedded `pullRequestsLayoutRoute.pullRequest` record (state, branches, SHAs, times), and from the server-rendered conversation the description (first comment container that is not a review thread) and the labels sidebar. The page data's `locked` flag reads false even for locked pull requests, so no lock state is returned. |

Every request goes only to `https://github.com` with the page's own cookies. Each call sends one request, which the browser follows through any redirect (checked with a CDP network trace), except
`get_issue`, whose page response makes Chrome send a second, unrequested one (see Site quirks). The tools send no custom headers except `Accept: application/json` on searches, no tokens and no body; the embedded
data contains CSRF and upload tokens and account fields, and none of it is copied into results
(fields are copied one by one from an allowlist).

## URL patterns

All five tools use `["https://github.com/*"]` instead of the default `["https://github.com/*",
"https://*.github.com/*"]`. github.com is the code-hosting product; the other hosts under the
registrable domain are unrelated products and are not covered here: `docs.github.com` (documentation
with its own search), `gist.github.com` (gists), `api.github.com` (the REST API), `education.`, `support.`,
`cli.github.com` and others. The tools read same-origin relative URLs such as `/search` and
`/<owner>/<repo>`, which mean something different or do not exist on those hosts, and a page tool
cannot navigate the tab to fix that. With the narrowed pattern the tools are simply not listed there
(checked live on `docs.github.com`, `gist.github.com` and `example.com`). `*.github.io` and
`githubusercontent.com` are different registrable domains with unrelated content and are out of scope.

## Output contract

Every tool returns `status: "ok"` (searches may return `no_results`) or `{ status: "error",
error_kind, error_message }`. Inputs are checked before any request, including unknown fields.
Shared `error_kind` values: `invalid_input`, `wrong_page` (the top document is not on
`https://github.com`), `throttled` (HTTP 429), `blocked` (HTTP 403), `login_required` (GitHub redirected
to `/login`; matched as the exact path so owners whose names start with "login" still work), `site_changed` (the response no longer has the expected shape; nothing partial is
returned), `unknown`. The detail tools add `not_found` (HTTP 404, or GitHub redirected to a different kind of
page); `get_repository` also returns `status: "empty_repository"` (name, url, visibility) for a repository with no commits, because GitHub serves no overview data for it;
`get_issue` adds `signed_in_side_effect` (see Site quirks) and `is_pull_request`, and `get_pull_request` adds `is_issue`, because GitHub redirects `/issues/<n>` and
`/pull/<n>` to whichever it is. A `no_results` search is only returned when GitHub answered with an
empty result list; query problems GitHub reports come back in `warnings`.

- Text written by users (titles, descriptions, topics, README, issue and comment bodies, branch
  names) is untrusted content. Tool descriptions say so; callers must not treat it as instructions.
- Times are UTC ISO 8601 (GitHub sends mixed offsets; they are normalized). URLs are built from validated
  names and numbers, not copied from the page.
- Bounds: searches return one page of 10 items. `get_repository` returns at most 100 root entries and
  `readme_max_chars` (default 2000, at most 20000) characters. `get_issue` returns at most
  `max_timeline_items` (default 20, at most 50) timeline items with `comment_max_chars` (default 1500)
  per comment and `body_max_chars` (default 4000) for the body. `get_pull_request` bounds the
  description with `body_max_chars`. Truncation is reported (`truncated`, `body_truncated`); cuts never split a surrogate pair.
- `get_issue.body` is GitHub's stored Markdown; `get_pull_request.body` and `get_repository.readme.text` are
  rendered text (formatting and code indentation are not preserved), because those pages carry only rendered HTML.

## Site quirks

- **Rate limiting.** Observed 2026-09-29: about 14 search requests in a few seconds from one browser session returned HTTP 429
  (tools report `throttled`). Slower calls did not reliably avoid it: independent runs from a shared egress address got 429s at 2.7 s
  spacing and again at 5.5 s spacing after about 35 requests from one browser. The tools do not retry; callers should pace calls and back off for a minute or more.
- **Preload request on issue pages.** An issue page answers with `Link: <…/issues/<n>/secondary_view?markAsRead=true&queryId=…>; rel=preload; as=fetch`.
  Chrome acts on that hint whenever the page is fetched, and CDP network traces showed a second, unrequested GET to `secondary_view?markAsRead=true`
  for `fetch()` and `XMLHttpRequest`, with `keepalive`, `credentials: "omit"`, `cache: "no-store"`, `HEAD`, several `Accept` values that return the page, and when the response was aborted after its headers.
  `Accept` values that do not return the page (`application/json`, `text/plain` and similar) answer HTTP 406 with no `Link` header and no data. Signed in, that request
  may mark the account's notification for the issue as read (untested: the only account used had no notifications, and creating one would need a state change).
  A read-only tool must not do that, so `get_issue` refuses with `signed_in_side_effect` before any request unless the page positively says the tab is signed out (its
  `meta[name="user-login"]` tag is present and empty); a missing tag, as on a text or feed document, is treated as unknown. In a signed-out tab there is no account to change. Pull request and repository pages carry no such header (checked signed out and signed in) and make one request.
- **Search result state.** Search results carry `state` (open, closed, merged, draft). For the handful of pull requests compared
  on 2026-09-29 (draft, merged, closed and open) it matched the pull request's own page; index lag was not observed but is not
  ruled out, and `get_issue` and `get_pull_request` read the item's page.
- **Sorting.** Search `s=` values verified live: repositories `stars`, `forks`, `updated`, `help-wanted-issues`;
  issues and pull requests `comments`, `created`, `updated`, each with `o=asc|desc`. GitHub silently falls back to
  best match for an unknown `s`, so the tools only offer verified values. Page 101 and above is HTTP 404, so `page` stops at 100.
- **Query problems.** A misspelled qualifier on repository search returned zero results with no error; `no_results` there
  does not prove the qualifier was understood. Code search reports `errors[]` with a suggested rewrite, and the search tools
  pass any such messages through as `warnings`.
- **Non-ASCII output on the Kernel runtime.** The Kernel runtime was observed to return a page tool's `output` as a JSON string
  instead of an object when it contains a character in U+0080 to U+00FF (accented Latin letters, curly quotes are outside that range),
  while CJK and emoji come back as objects; the extension path returned objects. This is runtime behavior, not tool code: parse the string
  when `typeof output === "string"`.
- **Long issues.** GitHub renders only the first ~15 timeline items into the issue page (`frontTimelineItems`) and loads the rest
  through requests the tool does not make; on a 160-item issue `timeline_returned` was 15 and `timeline_complete` false.
- **Pull request pages.** They are large (over 1 MB with many review threads) and their conversation is server-rendered HTML;
  only the description and the labels sidebar are read from it. The page's header badges are not used for the state because
  a pull request page can show several badges; the embedded record's `state` (OPEN, DRAFT, CLOSED, MERGED) is.
- **Redirects.** A renamed or transferred repository is followed and reported in `redirected_from`. Pull request URLs of a renamed repository redirected at once (an
  old name whose pull request number is really an issue then reports `is_issue`), but issue URLs of some renamed repositories answered HTTP 404 even after the repository page had been read, so
  `get_issue` can report `not_found` for the old name where `get_repository` succeeds. Use the canonical name that `get_repository` returns (its `full_name`, with `redirected_from` set) for the issue. `/orgs/<name>` style
  paths redirect away from a repository page and are reported as `not_found`. `/issues/<n>` for a pull request redirects to `/pull/<n>` and the reverse.
- **Content Security Policy.** github.com's `script-src` has no `unsafe-eval`, so `new Function` inside the page is blocked. The Kernel
  runtime nevertheless registered and invoked these page tools on 2026-09-29. The extension path for CSP-blocked pages is described
  in `spec/cdp-tools.md` §9 (item 12) and was not exercised for this domain.
- **Internal payloads.** The embedded data and `Accept: application/json` search responses are GitHub front-end internals and
  may change without notice. The tools check the fields they need and return `site_changed` instead of partial results.
  Several other routes (issue and pull request lists, releases, tags, pull request files) answer HTTP 406 to `Accept: application/json` and
  are not used.

## Overlap with other GitHub access

GitHub also offers a REST/GraphQL API, the `gh` CLI and an official GitHub MCP server. Those need a token or a local install
and cover far more (writes, code search, files, Actions). These tools exist for browser agents that stay in a tab, need no token,
and want a page-consistent read of what a person would see. Code search, dashboards, notifications, file contents and every write
are out of scope here and are not implemented.

## Native WebMCP tools

None found (checked 2026-09-29 with `webmcp.listTools()`, signed out, on the github.com home page, a repository page, an issue page,
a search results page and `docs.github.com`; and signed in on the dashboard). `document.modelContext` exists with zero registered
tools and `navigator.modelContext` is undefined, so the custom namespace conflicts with nothing the site registers.

## Status and known limitations

All five tools are `qa_passed`: the independent review (three rounds) signed off the final source with no open blocker or major defect. Nothing was tested signed in (see below).

- **Private repositories and organization SSO were not tested.** The tools read whatever the tab's session may see; nothing here
  distinguishes a private repository from a public one beyond the `visibility` field.
- **Issue timelines and pull request conversations are partial.** `get_issue` returns only the items GitHub puts in the page.
  `get_pull_request` returns no comments, review threads, changed files, check results or lock state; their pages were not parsed, and the lock flag in the page data is wrong.
- **`get_issue` is signed-out only.** See the preload note above; this is a deliberate refusal, not a bug, and a real-Chrome user who is signed in to GitHub
  will get `signed_in_side_effect` from it. The gate reads the current document's render-time state, so a stale signed-out document sitting over a signed-in session
  (GitHub's "signed in with another tab" case) would not be caught; the cookie that would show it is not readable from the page. Other signed-in side effects of reading pull request, repository and search pages (for example notification read state) were
  not observed but could not be tested with an account that has notifications.
- **Rendered text.** `get_pull_request.body` and `get_repository.readme.text` are text: links, images, formatting and code indentation are dropped; task-list checkboxes
  are kept as `[x]` and `[ ]`. A README that GitHub does not inline into the page (very large ones) gives `readme: null`, the same as no README.
- **Labels on pull requests** come from the page's labels sidebar (verified on pull requests with and without labels); if the sidebar is
  missing `labels` is null.
- **Repository facts not read:** languages, contributors, latest release, and the account-specific star/watch/fork state.
- **Empty repositories are read for a signed-out visitor only.** `empty_repository` relies on the text "This repository is empty"; what a signed-in owner's view of an empty repository shows was not
  tested and may be reported as `site_changed`.
- **Repository flags.** `is_archived`, `is_fork`, `is_mirror` and `is_template` are read from the repository page's sidebar data; the independent review exercised
  them live on archived, mirror, fork and template repositories. Empty repositories are the separate `empty_repository` status.
- **Search:** repositories and issues only; code, users, commits, topics and discussions search are not exposed. Only the first
  100 pages (1000 results) of any query are reachable. Qualifier support is whatever GitHub's search accepts.
- **Rate limits** for sustained use were not characterized beyond the burst noted above.
- **Extension behavior was exercised only by the independent review**, not by the author: it built the CLI, loaded the extension into Chromium 153 and invoked the tools through
  `xwebmcp mcp` (`open_tab`, `invoke_tool`; `xwebmcp invoke` refuses tabs it did not open and cannot call page tools by name). Results matched the Kernel runtime, and accented text
  arrived as objects there. Local Chrome (not Chromium) and a signed-in profile were not tested.

## QA summary

Author checks on 2026-09-29 (headful stealth Kernel browser, signed out, default network, then one signed-in read-only smoke run;
requests paced about 2.5 s apart after an early burst returned HTTP 429). All five tools were registered together with
`forceOverwriteNamespace: true` and invoked through `webmcp.invokeTool`.

| case | result |
|------|--------|
| discovery | five tools listed on `github.com/cli/cli` and `github.com/about`; none listed on `docs.github.com`, `gist.github.com`, `example.com`; no native tools on the page |
| search_repositories | `webmcp` by stars, 10 results with counts; nonsense query gave `no_results` |
| search_issues | open pull requests of one repository sorted by updated; a query with accented letters (result arrived as an object here; see the non-ASCII note above) |
| get_repository | a large organization repository, a small personal one without license or releases, a renamed repository (`redirected_from` set), a missing repository (`not_found`), a reserved-name path (`not_found`), a differently cased name |
| get_issue | a closed issue with a linked pull request; a 160-item issue (`timeline_returned` 15, `timeline_complete` false); a pull request number (`is_pull_request`); a missing number (`not_found`) |
| get_pull_request | merged, closed-unmerged and draft pull requests; a pull request with no description; an issue number (`is_issue`); a missing number (`not_found`) |
| review round 1 fixes | empty repository, non-repository pages (`/topics/…`, `/features/…`, `/collections/…`), owners whose names start with "login", a locked pull request, task-list checkboxes and the single-request behavior of `get_issue`: re-checked live after the fixes (see the pull request) |
| input handling | malformed and unknown inputs returned `invalid_input` from the tool with no request; the runtime does not validate page-tool input against `inputSchema` itself |

Fixture tests (`tests/github-read-tools.test.mjs`) run each page tool from `execute.toString()` in a fresh context against a fake
`fetch` and a test-only DOM (`tests/etsy-dom.mjs`), with fabricated repositories, users and tokens:

```sh
node --test tests/github-read-tools.test.mjs
```

Independent QA: agent `agt_a95c2a4fd4ea679db158` (independent reviewer with its own signed-out headful stealth Kernel browsers and a local Chromium with the extension, no account, read-only), three rounds:

| round | head | result |
|-------|------|--------|
| 1 | `3db7d10` | 240 recorded invocations, 129 against the live site, all schema-valid; signed off the two search tools and reported major defects in the other three (unanchored login check misreading owners named `login…`, empty repositories answered `site_changed`, wrong pull request `locked` flag, dropped task-list checkbox state, an unrequested `markAsRead` preload request on issue pages) and minor ones (array-coerced `sort`, code-unit query length, snippet wording, non-repository pages, README claims); 129 mutants, 25 survived |
| 2 | `1e6a15d` | all round-1 defects verified fixed on both runtimes; signed off four tools, `get_issue` conditionally; minor defects (the signed-in gate failing open on non-HTML documents, a missing visibility meta, README wording); 77 mutants, 11 survived |
| 3 (final) | `4866b76` | 234 live outputs, all schema-valid on the Kernel runtime; 28 invocations through the local Chromium extension, all schema-valid, results matching Kernel; 91 mutants, 83 killed, the survivors equivalent or minor; signed off all five tools with no open blocker or major defect. Its four minor documentation findings (the `get_issue` gate wording, the renamed-repository redirect mechanism, the one-request wording, the stale-document limit) were corrected in the README in a later commit that changes no tool source, and its two small test gaps were closed in the tests |

What the review covered: page-kind choice and self-contained `execute`; discovery on github.com pages and absence on `docs.github.com`, `gist.github.com` and `example.com`; no native tools or
name collisions; live success from several unrelated starting pages; malformed and unknown input (86 of 88 rejected with no request); a CDP network trace of every tool; output bounds (worst case 58.7 KB);
data leakage against the raw embedded payloads (none in about 230 outputs); navigation lifetime; and cross-runtime behavior on the Kernel runtime and a local Chromium extension. Untested by the review, as by the author:
anything signed in (including whether the issue-page preload marks a notification read), private repositories and organizations, the private branch of `empty_repository`, live `warnings` passthrough, and
pull request `labels: null`.

## Sessions

Browser and agent identifiers used for QA are ephemeral and are recorded in the pull request conversation rather than here. This
repository is canonical; no credentials, account details or live-view URLs are stored in it.
