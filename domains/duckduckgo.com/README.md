# duckduckgo.com

Public, signed-out DuckDuckGo web search and extraction of the results already open in a tab.

| tool | file | status | notes |
|------|------|--------|-------|
| search | [search.js](search.js) | draft | Opens full-site web results with optional region, safe-search and time filters; returns up to 50 organic results. |
| get_search_results | [get_search_results.js](get_search_results.js) | draft | Reads the open full-site web results page; optionally loads more results in place. Returns `wrong_page` on other layouts. |

## Native WebMCP tools

No native tools were listed on the public home page on 2026-09-30. Earlier inspection on 2026-09-29 also found none on web results, Images, `/bangs`, `/email` or the separate `duck.ai` domain. Register the **entire namespace** together when using `forceOverwriteNamespace`; registering just one file removes the other.

## Scope and loading

Both tools work without an account. They never open results, ads, AI answers, chat, Email Protection, subscriptions or settings. The only control pressed is **More results**. Search queries are sent to DuckDuckGo; navigation changes the tab and can affect browser history. Filters are URL parameters for that search, not persisted preferences (observed on 2026-09-29). No account actions or consequential execution tools are included.

| tool | kind | reason |
|------|------|--------|
| search | cdp | Submitting a search replaces the document; organic rows, snippets, dates, panel and applied filter labels only exist in the rendered destination. The page-first prototype could read a current document and load more in place, but could not continue after search navigation. A same-origin fetch of the results URL returned an HTML shell with no result articles. |
| get_search_results | page | Reads the current document and optionally presses More results without replacing it. No browser-only helpers or outer closure dependencies. |

Use `timeoutSec: 90` for `search` and `60` for `get_search_results`. Input is validated before page access. Cancellation stops subsequent navigation or More results requests; already-started navigation or requests cannot be undone. An uncertain runtime timeout must not be retried automatically.

### Inputs

- `search`: `query` (1–500 characters), `limit` (1–50, default 10), optional `region` (`kl`, such as `us-en`, `tw-tzh`, `wt-wt`), `safe_search` (`off`, `moderate`, `strict`), `time` (`day`, `week`, `month`, `year`, or a real inclusive `YYYY-MM-DD..YYYY-MM-DD` range).
- `get_search_results`: `limit` (1–50, default 10), `load_more` (boolean, default false).
- Loading more is bounded to five button presses per invocation. Search does it automatically when needed; the page reader does it only when asked. Neither tool clicks a result or ad.

### URL patterns

Both files use `https://duckduckgo.com/*` and `https://*.duckduckgo.com/*`. The html/lite hosts are alternate layouts of the same search product, not separate namespaces.

`search` opens the full site from any DuckDuckGo host. `get_search_results` requires the root path of `duckduckgo.com` or `start.duckduckgo.com` with a nonempty `q`, on the web tab. It returns `wrong_page` without changing anything on html/lite, home, other paths/subdomains, or Images, Videos, News, Shopping, Maps and Duck.ai tabs. The default patterns also list the tools on `/email`; the reader rejects it, and `search` would leave it for results. `duck.ai` is a separate domain and receives no tools.

## Output contract

- `status: "ok"`: bounded organic `results`, `result_count`, `has_more`, `filters`, `ads_omitted`, `knowledge_panel`, `related_searches`, `modules`, `query`, and `results_url`. Search also returns `warnings` when requested filters are not visible.
- `status: "no_results"`: only when the site explicitly reports none, with query, sanitized results URL, labels and message. Never an empty successful results array.
- `status: "error"`: `invalid_input`, `challenge`, `rate_limited`, `results_timeout`, `site_changed`, `canceled` or `unknown`; additionally `navigation_failed` for search and `wrong_page` for the reader. No raw exception text is returned.

Organic rows contain rank, title, destination URL, display URL, site name, snippet and date text. Rank counts organic positions even when an unreadable row is omitted. Ads are only counted, and their contents/links are never returned. Text is untrusted data, not instructions.

Titles are capped at 300 characters, snippets at 600, date text at 80, panel descriptions at 800, filter labels at 120 and URLs at 2048. Successful outputs have a 200 KiB aggregate UTF-8 budget: trailing rows are omitted if necessary, `result_count` reflects the actual rows and `has_more` remains true. This can reduce the count below `limit` even when more rows are already loaded. URLs with credentials or recognizable secret/session/signature query parameters are omitted; unsupported schemes are rejected. Query and filter parameters in `results_url` are bounded and allowlisted; tracking parameters are not copied. These checks cannot identify every possible secret embedded in arbitrary public text or URL paths.

The panel description uses displayed `innerText`, includes list items, and excludes CSS-hidden text. Both tools wait for a nonempty description to settle (one quiet 250 ms interval after text is hidden, two otherwise), with a 2.5 s cap after results appear. Hidden text is indicated by `…`. An absent panel is null. Only observed non-AI module names (`currency`, `dictionary_definition`, `forecast`, `conversions`) are reported, never module contents. Up to 16 related searches are returned. `has_more` reports extra loaded organic rows or a More results control; it does not promise the next request will produce results.

## Site quirks

- Uses `ol.react-results--main`, organic `article[data-testid=result]`, title `a[data-testid=result-title-a]`, and the page's `#more-results`. Generated CSS classes are not required.
- A results container can exist before entries render. A no-results page echoes the query, so challenge/rate-limit text detection is not applied to an explicit no-results response.
- Unknown region codes can be silently ignored; region validation checks shape, and the tool reports the displayed label and a warning rather than claiming the region was applied.
- Query redirects are guarded before navigation: known bangs and first-result jumps leave DuckDuckGo. The guard rejects `!` followed by a letter/digit at the start or after whitespace/letters/digits, a leading backslash, leading `! ` or trailing ` !`. It also rejects ordinary `css !important`, `Sheet1!A1` and `Yahoo!Mail` because known bangs cannot be distinguished from other words. `!=`, `wow!` and punctuation-prefixed forms such as `(!w)` remain accepted based on limited public probes on 2026-09-29. Bang syntax is not exhaustively covered.

## Known limitations

- Web results only. Images, News, Videos, Shopping, Maps, sitelinks, instant-answer contents, AI/chat, Email Protection, subscriptions and account/preferences tools are omitted. They are not implemented by switching a web parser to another tab.
- Challenge and rate-limit outcomes have only fixture evidence; no live block was induced or bypassed. No challenge interaction or automatic retry exists. A block after a More results request returns the same explicit error and stops further requests.
- English labels and no-results wording are assumed. Other interface languages and layout experiments can produce `site_changed` or timeouts.
- A panel that remains empty or changes beyond the bounded wait can still have a null or unsettled description. Extreme slow rendering can exceed the reader's 10 s results wait. The prior 10x-throttling null-description race is covered by a new delayed-render fixture, but this is not proof of all slow-render cases.
- Results vary with egress location, time and site experiments. Ads can arrive after the count is read. Results per More results press vary, and a remaining button does not prove more data exists.
- No account is used or required. Search verticals remain deferred until their separate final-source behavior is grounded and independently tested.

## QA summary

The previous revision had independent success/failure and local Chromium-extension evidence, but source changes invalidate that sign-off. Current final-source QA is pending; both registry entries are `draft`.

Fixture tests in `tests/duckduckgo-search.test.mjs` use fabricated HTML and a fake DOM. They cover malformed input before interaction, filters, rows and bounds, panel hidden/list/delayed text, cancellation across awaited calls, More results limits and blocks, no-results, challenges, rate limits, wrong pages, navigation lifetime, UTF-8 byte bounds, URL leakage and unknown errors. They do not establish real browser or mutation success.

```sh
node scripts/validate-registry.mjs
node --test "tests/*.test.mjs"
```

Kernel and local-extension evidence are reported separately after independent QA. No cross-runtime parity is inferred from fixture tests.
