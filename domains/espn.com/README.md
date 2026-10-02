# espn.com

Tools for ESPN's public sports site (https://www.espn.com): scoreboards and site search. Both are read-only, work signed out, and never navigate.

| tool | file | status | notes |
|------|------|--------|-------|
| get_scoreboard | [get_scoreboard.js](get_scoreboard.js) | verified | NFL, NBA and NHL games for one date (NBA, NHL) or one week (NFL): start time, state, score, record, broadcasters, venue; echoes the effective date or week and reports no_games separately from errors |
| search | [search.js](search.js) | verified | Teams, players, articles and upcoming Watch ESPN events, capped per type, with ESPN page URLs and uids; clips, replays and films omitted |

## Native WebMCP tools

None found (checked 2026-09-29 with `webmcp.listTools({ excludeCustom: true })` signed out on the homepage, an NBA scoreboard, an NFL game page and a search results page). `document.modelContext` exists with no registered tools and `navigator.modelContext` is undefined, so the custom namespace `espn.com` does not overlap with anything the site registers.

## Scope and loading

The two tools cover ESPN's public scoreboards and search for three leagues. They do not cover Fantasy (`fantasy.espn.com`), account features, Watch ESPN playback, betting odds, standings, schedules, rosters, box scores or play-by-play. Nothing signed-in was explored.

Register both together, because `forceOverwriteNamespace: true` replaces the whole namespace:

```javascript
const fs = await import("node:fs");
const read = name => fs.readFileSync(`domains/espn.com/${name}.js`, "utf8");
const tools = ["get_scoreboard", "search"].flatMap(name => eval(read(name)));
await webmcp.addCustomTools({ namespace: "espn.com", tools, forceOverwriteNamespace: true });
```

Both tools are `kind: "page"`. Neither replaces its document: each makes one same-origin or cross-origin `fetch` from the registering `www.espn.com` page with `credentials: "omit"` (no account cookies are sent) and returns. Live runs took 30 to 400 ms; the default invocation timeout is enough.

- **get_scoreboard** fetches the scoreboard page HTML (0.4 to 0.9 MB) and reads the page's own data, the JSON assigned to `window['__espnfitt__']` in the HTML (`page.content.scoreboard`). For NBA and NHL the route is `/<league>/scoreboard/_/date/YYYYMMDD`; for NFL it is `/nfl/scoreboard/_/week/<n>/year/<yyyy>/seasontype/<1|2|3>` (1 preseason, 2 regular, 3 postseason). ESPN's NFL route ignores `/date/`, so `date` is rejected for NFL. Output is an allowlist of fields; odds, tickets and leaders are dropped.
- **search** calls `https://site.web.api.espn.com/apis/search/v2` with the query and `limit`, the request the site's own search page sends. The response groups results by type; the tool returns `team`, `player`, `article` and `upcoming` groups.

Outputs:

- `effective` in `get_scoreboard` says what was actually returned. With no date or week ESPN chooses: NBA and NHL default to the next day that has games (for example an NBA request on a day with no games returned a date four days ahead), and NFL to the current week. `source` is `requested` or `site_default`. When the caller gives a date, ESPN does not echo it back, so `effective.date` is the requested date.
- `no_games` means ESPN returned a valid scoreboard page with an empty events list (an off-season date, a bye day, or a week number ESPN has no games for). It is not an error.
- Scores are `null` before a game starts. `winner` is true only for the winner; a tie or unfinished game has both false.
- `game_id` (scoreboard) equals `event_id` on `upcoming` search results.
- Page-tool outputs have been observed to arrive from the runtime's page bridge as a JSON string rather than an object; parse the string when `typeof output === "string"`. Outputs containing non-ASCII text (accented names) were the usual trigger in independent checks. This is runtime behaviour, not tool code.
- `search` adds `warnings` when ESPN reported errors alongside the results; the results may then be incomplete (for example a team group can be missing).
- Every success carries `observed_at`.
- Search returns at most `limit` results per type even when ESPN repeats a group; `omitted_types` contains at most 10 sanitized names, each capped at 40 characters.
- Scoreboard events without a usable string or finite-number game id are omitted with a warning. `game_count` counts readable events; an entirely unreadable nonempty board returns `site_changed`.

## URL patterns

Both tools match only `https://www.espn.com/*`, not the default `https://espn.com/*` and `https://*.espn.com/*`. The other hosts under the registrable domain are separate products or back ends: `fantasy.espn.com` (Fantasy games), `secure.espn.com`, `watch.*.espn.com` and `site.*.api.espn.com` (APIs), and `espndeportes.espn.com` (Spanish edition). The scoreboard tool reads `www.espn.com` pages same-origin and would not work on those hosts. The country editions (`espn.co.uk`, `espn.com.au`, `espn.in`, `espn.com.br`, and others) are separate registrable domains and are out of scope. The tools return `wrong_page` on any other origin. Observed on 2026-09-29 with the Kernel runtime: pages on `fantasy.espn.com` and `secure.espn.com` embed a `www.espn.com` frame (the Disney ID responder), and the runtime registers a tool on the top document when any frame matches, so both tools are listed there and return `wrong_page` without sending a request. The Chrome extension registers only when the top document matches (spec/cdp-tools.md section 9); an independent check on 2026-09-29 (Chromium with a throwaway profile, site access granted) saw it list no tools on `fantasy.espn.com/football/` or `secure.espn.com/nfl/scoreboard`.

## Safety and trust boundary

- Nothing here signs in, follows, favorites, subscribes, bets, starts playback, accepts terms or changes any preference. Both tools only read.
- Requests carry no cookies (`credentials: "omit"`), so they behave the same signed in or out and never expose account state.
- ESPN page and search content is untrusted text. It is returned as data, with C0 and C1 control characters (U+0000 to U+001F and U+007F to U+009F) replaced by spaces and every returned text field length-capped (URLs longer than 300 characters and identifiers longer than their cap, 20 to 60 characters depending on the field, are dropped rather than truncated), and never interpreted; URLs are limited to `https://*.espn.com` paths with the port, query string and fragment removed.
- Results are quotes at `observed_at`, not live updates.

## Site quirks

- Scoreboard data is embedded in the HTML as a private, abbreviated layout (for example `evts`, `vnue`, `competitors`), and the soccer scoreboard uses a different one (`gmsByLeague`, no `evts`). When the expected page data or events list is missing the tool returns `site_changed` instead of an empty result.
- Dates use ESPN's own scoreboard day. In observed sessions games starting late in the evening Eastern time were listed under that Eastern date, but the time zone rule is ESPN's, not verified here.
- `/<league>/scoreboard/_/date/YYYY-MM-DD` (dashed) returned HTTP 503; only `YYYYMMDD` works, which the tool builds itself.
- Search fails in several ways depending on the characters in the query (observed 2026-09-29): a single character or `%` returns HTTP 400, which the page often cannot read because the response lacks CORS headers; `<` and `>` get an HTML HTTP 403 from a filter with no CORS headers; whitespace that ESPN decodes to nothing, or two backslashes, return HTTP 200 with only an `errors` array; a lone backslash character in a longer query returns HTTP 400 in some positions and HTTP 200 with results *and* an `errors` array in others (also seen with `|`, `^`, `[`, `]`, `{`, `}` and a backtick); a trailing `|` returned HTTP 504 twice in an independent check. An unmatched query returns `{}` with HTTP 200. The tool rejects `<`, `>`, `%` and control characters before sending, maps the 400 and errors-only cases to `invalid_input` or `site_error` (never `no_results`), and adds a `warnings` entry when results arrive together with errors. A 200 response that has no `results` list, is not empty and has no `errors` array is reported as `site_changed`.
- Search `limit` applies per result type, so a query can return up to four times `limit` results.
- The pages carry a Content-Security-Policy; the cross-origin search request from a `www.espn.com` page was permitted.

## Known limitations

- NFL, NBA and NHL only. MLB, WNBA, college sports, soccer, tennis, golf, motorsport and others are not supported; `get_scoreboard` rejects them with `invalid_input`.
- Games in progress were not observed (none were live during discovery), so the in-progress `state`, clock text and score updates are covered by fixtures only. Postponed, delayed and overtime games are mapped from ESPN's `status` fields but were not seen live.
- No pagination: at most `max_games` (default 30, maximum 50) games and `limit` results per type. `truncated` and `game_count` report what was cut.
- A week or date outside ESPN's calendar returns `no_games` (for NFL a nonexistent week such as regular-season week 19 looks the same as a real empty week).
- Search rejects queries containing `<`, `>` or `%` (ESPN's search fails on them). When ESPN reports errors together with results, the results are returned with a `warnings` entry and may be incomplete. Search returns only team, player, article and upcoming results; `omitted_types` names other groups ESPN returned. `upcoming` entries are Watch ESPN listings and may need an ESPN subscription to play. Article `premium` reflects ESPN's own flag; premium article text is not read.
- Not live-tested: HTTP 403 and 429 responses, a challenge page, a slow ESPN response. They are covered by stubbed tests.
- On 2026-09-30 one public browser received HTTP 202 with an empty scoreboard body (`site_changed`); an independent browser received valid HTTP 200 scoreboards. Availability can differ without a source change; no bypass is attempted.
- Hostile lone-surrogate text can serialize to about 288 KiB in Node (under the runtime's 1 MiB limit but above the API's optional 240 KiB limit). Tested Kernel output normalized these characters and stayed below 240 KiB; this is not a universal 240 KiB guarantee.
- Signed-in behaviour is untested and unsupported by design: nothing here reads Fantasy leagues, favorites or entitlements.
- The scoreboard layout is ESPN's private page data, not a documented API, and can change without notice.
- Search rejects control characters before trimming, including leading/trailing tabs or newlines. The raw query is limited to 100 characters; whitespace-only queries are invalid.
- Untrusted text is returned as data, not instructions. Bidirectional text overrides are not stripped, and truncation can split a surrogate pair.

## QA

Independent QA by `agt_38231d3040927db065c6`, using `pi` / `openai-codex/gpt-6.1-sol`, thinking high, fast false, context 272k, with Codex auth checked before each review:

1. `21fdf3b`: FAIL. Malformed search errors/recognized-group contents returned `no_results`, and scoreboard links retained controls. All three were fixed with regression fixtures.
2. `4df51f9676bfe41314b4d4acf3d11be568e97cbc`: PASS, no concrete defects in the bounded recheck. Reviewed source blobs: `get_scoreboard.js` = `39131d29f742ca881c3424138194339d5ad4136c`, `search.js` = `9ddbe98ca1d74e856ea8a6bc6d675b2afb4ab410`. Later updates only record documentation and registry status.

Final-source evidence, signed out, 2026-09-30:

- **Kernel real site, 02:34 UTC:** starting from an NFL game page, search returned six results; an errors-only query returned `site_error`; NFL week 3 returned 16 games and NHL dated scoreboard returned three, each truncated to one when requested. Both whole-namespace overwrites preserved both tools, no native conflicts were found, navigation re-registered tools and rejected the stale ref, and cookie/storage equality checks passed.
- **Local Chrome extension real site, 02:40 UTC:** SHA-pinned final files in a throwaway Chromium profile; search success/error, NFL scoreboard success and NBA `no_games` from an NFL game page; post-navigation search succeeded and the stale ref was rejected. Requests used `credentials: "omit"`; cookie/storage equality checks passed. This is observed parity only for the cases listed, not a blanket cross-runtime guarantee.
- **Fixture-only:** 25 focused response cases in each runtime, separate from real site evidence. Includes malformed/null/mixed search errors and groups, C0/DEL/C1 link controls, giant omitted arrays, repeated group limits, identifier types/caps, all-unusable and partially unreadable scoreboards, HTTP 202-empty, blocked/rate-limited responses and unrelated-origin guards. 46 standalone malformed inputs were rejected before origin/network access; 40 Kernel and eight extension negative cases made zero requests. 210 fresh outputs independently validated with Ajv, zero violations.
- **Local checks:** registry validator 81 valid; full suite 1612 pass including 35 ESPN tests. Go extension embedding/toolsource checks and extension sidepanel test pass. The initial fresh-source review's 23 targeted hardening mutants were all killed.
- **Unverified:** real challenges/403/429, slow responses, overtime/postponement and account behavior. In-progress game handling remains fixture-only.

All temporary public browsers and throwaway extension profiles used for this revision were deleted. No authorized login session or cleanup deadline was changed.
