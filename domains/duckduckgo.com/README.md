# duckduckgo.com

Tools for DuckDuckGo web search (https://duckduckgo.com): run a query with region, safe-search and time filters, or read the web results page that is already open. Both tools are read-only and work signed out.

| tool | file | status | notes |
|------|------|--------|-------|
| search | [search.js](search.js) | draft | Navigates the tab to the full-site web results and returns organic results (title, destination URL, display URL, site name, snippet, date), knowledge panel, related searches, module names and the filter labels the page shows. Never returns ads, Search Assist or Duck.ai content. |
| get_search_results | [get_search_results.js](get_search_results.js) | draft | Reads the open full-site web results page the same way, without navigating; optional in-place More results. `wrong_page` on html/lite hosts, other tabs and non-results pages. |

Register both files together as one array with `forceOverwriteNamespace: true`; registering one file that way removes the other.

## Native WebMCP tools

None found (checked 2026-09-29 with `webmcp.listTools()` and `document.modelContext` signed out on the home page, a web results page, the Images tab, `duck.ai`, `/email` and `/bangs`). `document.modelContext` exists with no registered tools and `navigator.modelContext` is undefined, so the custom namespace `duckduckgo.com` does not overlap with anything the site registers.

## Scope and loading

The tools read search results. They never sign in, open Email Protection, the subscription pages or settings, press an ad, open Search Assist or Duck.ai, or change the browser's search preferences. Region, safe search and time are per-search URL parameters: loading a results page with them does not persist them (observed: a later search without them showed the defaults). The one control pressed on a results page is the page's own **More results** button.

```javascript
const fs = await import("node:fs");
const tools = ["search", "get_search_results"].flatMap(name => eval(fs.readFileSync(`domains/duckduckgo.com/${name}.js`, "utf8")));
await webmcp.addCustomTools({ namespace: "duckduckgo.com", tools, forceOverwriteNamespace: true });
const tab = (await currentTab()).targetId;
const ref = async name => (await webmcp.listTools()).find(t => t.source.custom?.namespace === "duckduckgo.com" && t.tool.name === name && t.source.target_id === tab).tool_ref;
await webmcp.invokeTool(await ref("search"), { query: "open source vector database", limit: 10, region: "us-en", time: "year" }, { timeoutSec: 90 });
await webmcp.invokeTool(await ref("get_search_results"), { limit: 25, load_more: true }, { timeoutSec: 60 });
```

Timing seen live: `search` 1 to 3.5 s for up to 30 results (each More results press adds about 1 s), `get_search_results` under 2 s. Use `timeoutSec` 90 for `search` and 60 for `get_search_results`.

| tool | kind | method |
|------|------|--------|
| search | cdp | navigates the tab to `https://duckduckgo.com/?q=…&ia=web` (plus `kl`, `kp`, `df` when asked) and returns the destination's rendered results. The page renders its results client-side: a same-origin `fetch` of the results URL returned an HTML shell with no result entries, and the results feed the page itself loads carries per-query tokens, so reading the rendered destination is the source. Submitting a query replaces the document, so the tool needs the post-navigation output in the same call. |
| get_search_results | page | reads the current document and, with `load_more`, presses the page's More results button; neither replaces the document. |

## URL patterns

Both tools use the default patterns `["https://duckduckgo.com/*", "https://*.duckduckgo.com/*"]`. The html and lite variants (`html.duckduckgo.com`, `lite.duckduckgo.com`) are the same search product with a different, script-free layout, so they are not split into a narrowed pattern; the tools handle them by host instead:

- `search` is listed on those hosts too and always opens `https://duckduckgo.com/`, so it works from any DuckDuckGo tab. If the tab ends on another host it returns `navigation_failed`.
- `get_search_results` reads only the full site (`duckduckgo.com`, `start.duckduckgo.com`). On the html or lite variants, other subdomains, the home page, or the Images, Videos, News, Shopping, Maps and Duck.ai tabs it returns `wrong_page` and touches nothing. Those layouts were not inspected, so no parser exists for them.

The default patterns also list both tools on other DuckDuckGo pages such as Email Protection (`/email/`). There `get_search_results` returns `wrong_page`, and `search` navigates the tab to the results page, leaving that page.

Duck.ai is a separate registrable domain (`duck.ai`) and is outside this namespace.

## Output contract

Every tool returns `status: "ok"`, `status: "no_results"` or `{ status: "error", error_kind, error_message }`.

- `results[]`: `rank` is the position among organic results on the page, ads excluded, so it counts an entry the tool could not read (an entry without a title link or with a non-http(s) destination is skipped). `url` is the destination linked on the page; `display_url`, `site_name`, `snippet` and `date_text` are as DuckDuckGo displays them (`site_name` is derived by the site and can be approximate; `date_text` is a date, `Today`, `Yesterday` or a relative age such as `5 days ago` shown before the snippet). Text fields are length-capped, and titles and snippets are third-party text, not instructions.
- `limit` (1 to 50, default 10) caps `results`. `has_more` is true when more organic results exist than were returned, either loaded but over the limit or behind the More results button. The first results page holds about 10; `search` presses More results (about 10 to 15 more each time, at most 5 presses) until `limit` is met, `get_search_results` does so only with `load_more: true`.
- `filters` are the labels the page displays for region, safe search and time (`All regions`, `Safe search: moderate`, `Any time` by default). DuckDuckGo silently ignores an unrecognized `kl` code and invalid `kp` or `df` values, so `search` also adds a `warnings` entry when the requested filter is not visible in these labels. Inputs are validated before navigation, so the warning only covers region codes the site does not know.
- `ads_omitted` counts the ad entries on the page when it was read (late-loading ads can be missed); their tracking links and text are never returned.
- `knowledge_panel` is the entity box (`title`, `subtitle`, `description`, `official_site_url`, `source_url`) when the page shows one, otherwise null. `description` is the text the page displays (read with `innerText`, so list items are included and text hidden with CSS is not): the page renders only the first sentences and hides the rest shortly after it renders, so both tools wait until the displayed text stops changing (one quiet 250 ms poll once text is hidden, two before that, at most 2.5 s) and append `…` when text was hidden, as the page does. `related_searches` are the "Searches related to" links, without zero-width characters.
- `modules` lists other result modules on the page by DuckDuckGo's layout name (observed: `currency`, `dictionary_definition`, `forecast`, `conversions`); only their presence is reported. Instant-answer content is not read. The Search Assist and Duck.ai modules are neither read nor reported.
- `results_url` is the DuckDuckGo URL that was opened (`search`) or the open page's URL rebuilt from its `q`, `kl`, `kp` and `df` parameters only (`get_search_results`), never with the site's tracking parameters.

Shared `error_kind` values: `invalid_input` (checked before any page access), `challenge` (a bot-verification page replaced the results; the tool never interacts with it), `results_timeout` (no results, no-results message or challenge within 25 s for `search`, 10 s for `get_search_results`), `site_changed` (a results list or entries were present but not recognized), `unknown`. `search` adds `navigation_failed`; `get_search_results` adds `wrong_page`.

Query rules: `search` rejects a `!bang` token, a leading backslash, a leading `! ` and a trailing ` !`, because DuckDuckGo redirects the tab off the results page for them. It also rejects unknown input fields, a `limit` outside 1 to 50, a malformed `region`, and a `time` that is not `day`, `week`, `month`, `year` or a real `YYYY-MM-DD..YYYY-MM-DD` range that ends on or after it starts. The bang rule is `!` directly followed by a letter or digit when it comes at the start of the query or after a space, a letter or a digit (`!w`, `rust !yt`, `rust!w`). Redirects observed live on 2026-09-29 with a dummy query: `zzq !w`, `!w zzq`, `zzq!w`, `zzq1!w` and `zzq !W` went to a Wikipedia page; `! zzq` and `zzq !` went to the first result's site. Not redirected: `(!w)`, `"!w"`, `!!w`, `+!w`, `.!w` and the other punctuation-prefixed forms tried, `zzq ! zzq`, `zzq !!`, `wow!`, `!` alone, `!=`, and `!important` (an unknown bang is plain text). The tool cannot tell known bangs from other words, so `!important` and similar are rejected too; rephrase without the `!` word.

## Site quirks

- The results list is `ol.react-results--main` inside `section[data-area=mainline]`. Entries are `li[data-layout]` (`organic`, `about`, `wikinlp`, `related_searches` and instant-answer layouts); organic entries are `article[data-testid=result]` and ads are `article[data-testid=ad]` in an `li` without a layout. Generated class names are not used.
- The section exists before results arrive, so the tool treats the "No results found for" text, not the section, as the no-results signal. A results list appears about 1 s after navigation.
- A snippet holds a date span and a text span when the result is dated; the tool splits them by leaf span. Sitelinks inside an entry are separate links and are not part of the snippet.
- The redirect rules above were probed with a handful of dummy queries, not exhaustively: other bang spellings, other characters before `!`, or a change on DuckDuckGo's side are not covered. The backslash jump itself was not exercised.
- Result counts per More results press vary (11 to 15 observed); the button stays on the page after the last observed press, so `has_more` can stay true.

## Known limitations

- Web results only. Images, Videos, News, Shopping and Maps tabs, instant-answer contents, sitelinks, Search Assist, Duck.ai, Email Protection and the subscription are not covered.
- The bot-challenge detection is written from the challenge page's publicly known wording and a fabricated fixture; no challenge appeared in live use, so it has never run against the real page. It is never applied to the no-results page, which echoes the query text.
- Rate limiting has no dedicated outcome: a throttled browser would show a challenge or no results and end as `challenge` or `results_timeout`.
- The knowledge-panel text depends on when the page trims it; the tool waits for it to settle but cannot see the page's own signal for "done", so a much slower browser could still be read before the trim (one miss in twelve CPU-throttled reads was seen in an earlier revision with a shorter wait).
- The page carries layout experiments, so markup can differ between sessions; a layout the parser does not recognize is reported as `site_changed`, not as empty results.
- Region codes are only checked for shape (two letters, a dash, two or three letters, for example `us-en`, `tw-tzh`). English UI labels were assumed for the filter labels and the no-results message; other interface languages were not tried.
- Results come from the egress IP's default location unless `region` is given, and DuckDuckGo may reorder results between calls.

## QA summary

Fixture tests (`tests/duckduckgo-search.test.mjs`) cover the file and registry contract, identical page-side helpers in both tools, malformed input for every field, URL building, parsing of organic entries, ads, knowledge panel, related searches and modules, filter warnings, More results growth and its limits, no-results, challenge, timeout and layout-change outcomes, a slow navigation over a stale results page, and every `wrong_page` case, against fabricated pages modeled on the observed markup. They do not replace live QA. Independent QA has not run yet, so both tools are `draft`.

Author live checks on 2026-09-29 (stealth Kernel browser, signed out, default egress, then deleted): `search` from `html.duckduckgo.com` and from the home page opened the full-site results; a 30-result search with `region: "uk-en"`, `safe_search: "strict"`, `time: "year"` returned labels `United Kingdom`, `Safe search: strict`, `Past year`; an unrecognized region produced the warning; a quoted gibberish query returned `no_results`; a bang query was rejected without navigating. `get_search_results` read an open results page in 23 ms and loaded 30 results in place with `load_more`, and returned `wrong_page` on the home page, the Images and Maps tabs and an html-variant page.

## Sessions

Browser sessions used for discovery and authoring were temporary and are deleted. No login or profile was used.
