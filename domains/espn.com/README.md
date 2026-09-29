# espn.com

Tools for ESPN's public sports site (https://www.espn.com): scoreboards and site search. Both are read-only, work signed out, and never navigate.

| tool | file | status | notes |
|------|------|--------|-------|
| get_scoreboard | [get_scoreboard.js](get_scoreboard.js) | draft | NFL, NBA and NHL games for one date (NBA, NHL) or one week (NFL): start time, state, score, record, broadcasters, venue; echoes the effective date or week and reports no_games separately from errors |
| search | [search.js](search.js) | draft | Teams, players, articles and upcoming Watch ESPN events, capped per type, with ESPN page URLs and uids; clips, replays and films omitted |

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
- Page-tool outputs have been observed to arrive from the runtime's page bridge as a JSON string rather than an object; parse the string when `typeof output === "string"`. This is runtime behaviour, not tool code.
- Every success carries `observed_at`.

## URL patterns

Both tools match only `https://www.espn.com/*`, not the default `https://espn.com/*` and `https://*.espn.com/*`. The other hosts under the registrable domain are separate products or back ends: `fantasy.espn.com` (Fantasy games), `secure.espn.com`, `watch.*.espn.com` and `site.*.api.espn.com` (APIs), and `espndeportes.espn.com` (Spanish edition). The scoreboard tool reads `www.espn.com` pages same-origin and would not work on those hosts. The country editions (`espn.co.uk`, `espn.com.au`, `espn.in`, `espn.com.br`, and others) are separate registrable domains and are out of scope. The tools return `wrong_page` on any other origin. Observed on 2026-09-29 with the Kernel runtime: pages on `fantasy.espn.com` and `secure.espn.com` embed a `www.espn.com` frame (the Disney ID responder), and the runtime registers a tool on the top document when any frame matches, so both tools are listed there and return `wrong_page` without sending a request. The Chrome extension registers only when the top document matches (spec/cdp-tools.md section 9), so it should not list them; that was not checked here.

## Safety and trust boundary

- Nothing here signs in, follows, favorites, subscribes, bets, starts playback, accepts terms or changes any preference. Both tools only read.
- Requests carry no cookies (`credentials: "omit"`), so they behave the same signed in or out and never expose account state.
- ESPN page and search content is untrusted text. It is returned as data with length caps and never interpreted; URLs are limited to `https://*.espn.com` paths with the query string and fragment removed.
- Results are quotes at `observed_at`, not live updates.

## Site quirks

- Scoreboard data is embedded in the HTML as a private, abbreviated layout (for example `evts`, `vnue`, `competitors`), and the soccer scoreboard uses a different one (`gmsByLeague`, no `evts`). When the expected page data or events list is missing the tool returns `site_changed` instead of an empty result.
- Dates use ESPN's own scoreboard day. In observed sessions games starting late in the evening Eastern time were listed under that Eastern date, but the time zone rule is ESPN's, not verified here.
- `/<league>/scoreboard/_/date/YYYY-MM-DD` (dashed) returned HTTP 503; only `YYYYMMDD` works, which the tool builds itself.
- Search rejects queries shorter than two characters (HTTP 400); an unmatched query returns `{}` with HTTP 200.
- Search `limit` applies per result type, so a query can return up to four times `limit` results.
- The pages carry a Content-Security-Policy; the cross-origin search request from a `www.espn.com` page was permitted.

## Known limitations

- NFL, NBA and NHL only. MLB, WNBA, college sports, soccer, tennis, golf, motorsport and others are not supported; `get_scoreboard` rejects them with `invalid_input`.
- Games in progress were not observed (none were live during discovery), so the in-progress `state`, clock text and score updates are covered by fixtures only. Postponed, delayed and overtime games are mapped from ESPN's `status` fields but were not seen live.
- No pagination: at most `max_games` (default 30, maximum 50) games and `limit` results per type. `truncated` and `game_count` report what was cut.
- A week or date outside ESPN's calendar returns `no_games` (for NFL a nonexistent week such as regular-season week 19 looks the same as a real empty week).
- Search returns only team, player, article and upcoming results; `omitted_types` names other groups ESPN returned. `upcoming` entries are Watch ESPN listings and may need an ESPN subscription to play. Article `premium` reflects ESPN's own flag; premium article text is not read.
- Not live-tested: HTTP 403 and 429 responses, a challenge page, a slow ESPN response. They are covered by stubbed tests.
- Signed-in behaviour is untested and unsupported by design: nothing here reads Fantasy leagues, favorites or entitlements.
- The scoreboard layout is ESPN's private page data, not a documented API, and can change without notice.

## QA

No independent QA yet; both tools are `draft`. Local checks: fixture tests in `tests/espn-tools.test.mjs` against fabricated data, and live signed-out invocations on 2026-09-29 from the homepage and an article page of a fresh Kernel browser (NFL default and explicit week, NBA default and no-games date, NHL dated with truncation, a nonexistent NFL week, search with results, no results and filtered types, and malformed inputs).

Sessions (ephemeral): the builder's temporary browser was deleted after use.
