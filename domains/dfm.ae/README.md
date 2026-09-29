# dfm.ae

Tools for the Dubai Financial Market (https://www.dfm.ae): a symbol directory, published quotes and daily trading history. Exchange data only, read-only, no sign-in.

| tool | file | status | notes |
|------|------|--------|-------|
| search_securities | [search_securities.js](search_securities.js) | draft | Ranked symbol/name search over the site's six directory lists; failed lists are named, never hidden |
| get_security | [get_security.js](get_security.js) | draft | Identity (profile feed) plus the quote the company page renders (Trading-tab feed), with `quote.status` and `timing`; real-time vs delayed is always `unknown` |
| get_price_history | [get_price_history.js](get_price_history.js) | draft | Daily OHLCV between two dates, newest first; reports the first and last dates the site actually returned |

## Native WebMCP tools

None. `webmcp.listTools()` returned no tools on `www.dfm.ae` (home, a company page, the disclosures page), `marketwatch.dfm.ae`, `arena.dfm.ae` and `ivestor.ae` on 2026-09-29, signed out, and `navigator.modelContext` was undefined on the pages checked. There is no native tool to collide with.

## Execution kind

All three tools are `kind: "page"`. Each makes one to six `fetch` calls (`get_security` two, `get_price_history` one or two, `search_securities` up to six) to `api2.dfm.ae` (the JSON endpoint DFM's own pages call) from whichever `www.dfm.ae` or `marketwatch.dfm.ae` page is open and returns the parsed result. None navigates the tab, so none has anything to read after a navigation and none qualifies for `cdp`. The requests are sent with `credentials: "omit"`; the endpoints need no cookie, and no account state is used.

## Scope and loading

Register all three files together under namespace `dfm.ae`:

```javascript
const names = ["search_securities", "get_security", "get_price_history"];
const fs = await import("node:fs");
const tools = names.flatMap(n => (0, eval)("(" + fs.readFileSync(`domains/dfm.ae/${n}.js`, "utf8") + ")"));
await webmcp.addCustomTools({ namespace: "dfm.ae", tools, forceOverwriteNamespace: true });
const tab = (await currentTab()).targetId;
const tool = (await webmcp.listTools()).find(t => t.source.custom?.namespace === "dfm.ae" && t.tool.name === "get_security" && t.source.target_id === tab);
const result = await webmcp.invokeTool(tool.tool_ref, { symbol: "EMAAR" }, { timeoutSec: 60 });
```

A call takes about 2 s for `get_security` (two requests), about 1 s for `get_price_history`, and about 6 s for `search_securities` across all six lists. `search_securities` requests the lists one after another within an overall 45 second budget and names any list it did not reach in `failed_types`, so `timeoutSec: 60` always covers it.

What the tools never do: sign in or use an account, subscribe to an offering (IPO, sukuk, rights issue), place or route orders, touch eServices, submit forms or requests, or give investment advice, ratings or recommendations. They read exchange data and nothing else.

Conventions:

- **Symbols** are DFM's own (`EMAAR`, `SALAM_BAH`, `TAKAFUL-EM`, `UAESUKUK0728`, and for a few delisted funds one with an inner space such as `NBD GULF`). `search_securities` finds a symbol; `get_security` and `get_price_history` take it exactly (case-insensitive, no leading or trailing whitespace, ASCII only) and reject anything else before any request.
- **Where each value comes from.** `get_security` reads identity from `Command=companyprofile` and the quote block from `Command=SearchProfileTradingTab` (the feed behind the company page's Trading tab, checked against the rendered page for 16 instruments on 2026-09-29). `get_price_history` reads `Command=SearchProfileDailyTab`, the company page's Daily Summary feed.
- **Numbers** are parsed from the site's formatted strings (`"12,024,247"`, `"-0.512%"`). Percent fields are in percent units: `-0.512` means -0.512%. Prices carry no currency because the site's quote block states none.
- **Dates** are `YYYY-MM-DD`. Trading dates are Dubai dates; `get_price_history` defaults `to_date` to today in Dubai and `from_date` to 30 days earlier.
- **Timing.** `get_security` and `get_price_history` return `timing.retrieved_at` (the browser's UTC clock) and `timing.realtime: "unknown"`. The quote has no intraday timestamp: `get_security` gives `timing.last_trade_date` (a date), history rows carry no time of day. DFM's market-watch page says "Data delayed by 15 minutes. Login to view real-time data" (observed 2026-09-29); the tools do not sign in and cannot tell which a given value is, so they never call it real-time.
- **Directory lists.** `search_securities` accepts `equities`, `bonds`, `sukuk`, `funds`, `etfs` and `reits`; `sukuk` is sent to the site as `sukuks`, the value its own Sukuk tab uses. The site's Equities, Bonds, Sukuk and Funds tabs were observed sending `equities`, `bonds`, `sukuks` and `funds`; `etfs` and `reits` were called directly and each returned three rows (the site's ETF and REIT tabs were not observed sending them).
- Failures are explicit: `status: "error"` with `error_kind` (`invalid_input`, `not_found`, `rate_limited`, `blocked`, `site_error`, `site_changed`) and a message. `no_results` is used only when the source answered and nothing matched. Nothing is retried.

## Site quirks

- **Undocumented endpoints.** `api2.dfm.ae/web/widgets/v1/data` is the internal form-encoded endpoint DFM's pages use (`Command=companyprofile`, `SearchProfileDailyTab`, `FreshSecuritiesLists`). It is not a published API and can change; a changed shape is reported as `site_changed`.
- **The profile feed's quote block is not reliable.** `companyprofile` returned `0.00`/empty quote fields for instruments that trade (independent QA found six of twenty sampled, e.g. recently listed ones) and a zero price for a retail sukuk that the Trading-tab feed prices at 100.4. `get_security` therefore takes only identity, NAV and NAV date from the profile feed and the whole quote block from the Trading-tab feed.
- **HTTP 200 for everything.** An unknown symbol answers 200 with a record whose `Symbol` is empty (`get_security` maps it to `not_found`); a valid symbol with no history answers 200 with `[]`, so `get_price_history` makes one extra `companyprofile` request to tell `no_results` from `not_found`. The site's `GetUpcomingIPO` command answered 200 with the plain text "Unable to connect to the remote server" during discovery, so a non-JSON body is treated as `site_error`.
- **Directory `Active` flag.** The directory's `Active` value disagrees with DFM's company page for some instruments: a matured bond and a fund were `Active: true` in the directory while their DFM company pages were labelled DELISTED (2026-09-29). It is returned as the site's flag and nothing filters on it.
- **Directory gaps and duplicates.** The lists do not contain every symbol the site can quote: the retail sukuk `UAESUKUK0728` resolves in `get_security` but was in none of the six lists. Ten directory rows across the six lists have no name (`name: null`). One equity symbol appears twice with different name spellings; both rows are returned. A few delisted funds have a space in the symbol (`NBD GULF`, which resolves), and two delisted funds (`EFF`, `MAKASEBUAE`) are listed with a leading space that the site itself cannot resolve: `search_securities` returns them trimmed and `get_security` answers `not_found`.
- **The directory's own `ProfileUrl` is not used.** It redirected to the listed-securities page, not to the instrument. For instruments whose exchange is DFM or Nasdaq Dubai the tools return `https://www.dfm.ae/the-exchange/market-information/company/<SYMBOL>` (loaded for an equity, a REIT, a fund, a matured bond and the active Nasdaq Dubai equities on 2026-09-29); any other exchange string gets `profile_url: null`. The page loads for any symbol, including unknown ones, so the URL does not prove the instrument exists.
- **Zero placeholders.** Instruments that did not trade show `0.00`/`0.000` prices (a stale equity's last trade was 2024-11-14; a Nasdaq Dubai equity had a close but no last price). `get_security` reports `quote.status: "zero_or_absent_last_price"` and `get_price_history` marks each row `traded: false`; `last_trade_date` can be years old.
- **Delisted and matured instruments.** The Trading-tab feed returns no quote fields (the page shows `--`) for a delisted Nasdaq Dubai equity, a delisted ETF, a delisted fund and a matured bond (`quote.status: "not_published"`), and the daily-history call returned no rows for the delisted Nasdaq Dubai equity and the fund. Active Nasdaq Dubai equities (e.g. `REIT`, `DEPA`, `HIK`, `NDAQ`) do return quote fields and daily rows; an earlier draft of this README wrongly attributed the missing data to the exchange.
- **History window.** On 2026-09-29 the earliest daily row the site returned for an equity was 2024-12-31 (a request from 2024-01-01 to 2024-12-31 returned only that day), and the site's Historical Data page says older history needs a request submitted in eServices, which requires a login and is not offered here. `starts_after_from_date` says when the first row is later than requested; that can also be a from_date on a weekend or holiday, or a listing after from_date.
- **Large payloads.** The site's `FreshSecuritiesLists` answers were about 67 KB (equities), 72 KB (bonds) and 135 KB (sukuk). They are filtered in the page, and outputs are bounded by `limit` (50 matches, 500 history rows). The largest output seen was about 105 KB, for the 436 rows the site served for a two-year range.
- No bot challenge, throttle or login wall was met in a few hundred low-rate requests over two stealth browsers on 2026-09-29. A 429 or a 401/403 is reported as `rate_limited` or `blocked`; `search_securities` stops requesting further lists after either.

## Known limitations

- Read-only market data from a public, unauthenticated feed. No account, watchlist, portfolio, real-time data, insider trades or eServices features (login-required, not investigated).
- Whether a quote or a history row is real-time, delayed by 15 minutes or final is unknown; `timing.realtime` is always `"unknown"`. Not suitable for trading decisions.
- `search_securities` covers only what the six directory lists contain; `no_results` is not proof a symbol does not exist. When `failed_types` is non-empty the results are incomplete.
- `get_security` costs two requests and returns the fields in its output schema only; it does not return the board, management, contacts, subsidiaries, company brief, documents, shareholders, disclosures or corporate actions.
- `get_price_history` returns at most 500 rows per call (newest first) and only what the site serves; older rows need narrower `to_date` windows and are bounded by the site's window. No intraday, index, sector or futures history.
- Delisted or matured instruments return identity only from `get_security` and no rows from `get_price_history`; instrument types other than equities, bonds, funds, a REIT, an ETF and a retail sukuk were not sampled.
- The Arabic site (`/ar/`) and Arabic-only content are not parsed; requests use `Language=en`.
- Not verified: behavior from the Chrome extension runtime and against a page CSP; the tools were exercised on a Kernel browser only. Behavior during trading hours was not observed (all live checks were made after the close).
- Not investigated: `arena.dfm.ae` offerings, whose API needs app-set headers, and the subscription flows, which are consequential and out of scope.

## QA summary

Builder checks, 2026-09-29, fresh stealth Kernel browsers, signed out, all read-only:

- Fixture tests in `tests/dfm-market-data.test.mjs` (fabricated symbols and data) cover input validation before any request (including whitespace, Unicode look-alikes and inner spaces), request bodies and encoding, ranking and limits, every output branch against its `outputSchema`, unavailable/zero/absent quotes, the quote coming from the Trading-tab feed rather than the profile feed, `not_found` vs `no_results`, the search time budget, and 401/403/429/5xx/non-JSON/changed-shape/network failures.
- Mutation check: deliberate regressions to the tool sources (ranking, credentials, list name, retry-after-429, total failure as `no_results`, zero price as reported, real-time claim, unknown symbol as ok, missing sort, missing empty-history handling, hidden window start, UTC instead of Dubai date, `traded` always true, quote taken from the profile feed, ignored trading-feed errors, unencoded URLs, missing timeout signals, missing budget check, lenient symbol validation) each fail at least one test; the one remaining survivor is equivalent (a no-op after the ASCII check).
- Live: all three tools registered together under `dfm.ae` (`forceOverwriteNamespace`) and invoked through `webmcp.invokeTool`. Listed on `www.dfm.ae` (also via the `dfm.ae` redirect), a company page and `marketwatch.dfm.ae`; not listed on `login.dfm.ae` (where `esrv.dfm.ae` lands), `arena.dfm.ae`, `ivestor.ae` or `example.com`. Outputs conform to their `outputSchema`, including `get_security` for 17 instruments (equities, REITs, a retail sukuk, active and delisted Nasdaq Dubai equities, a delisted ETF, and delisted funds, one with an inner space in its symbol) plus an unknown symbol, multi-list searches, `no_results`, `not_found`, and a 436-row history (105 KB). For 16 instruments the Trading-tab quote was also compared field by field with the rendered company page and matched.
- Local extension (builder, not independent): Chromium 153 headless with a throwaway profile, the CLI and extension built from this checkout, tools installed from the PR commit with `xwebmcp add`, invoked through `xwebmcp mcp`; the three tools registered on `www.dfm.ae` and returned ok, `not_found` and `invalid_input` results. The extension's "Grant access" prompt cannot be shown headless, so the two dfm.ae origins were added to `host_permissions` in a throwaway copy of the extension manifest; the grant flow itself was not exercised.

Independent QA round 1 (Sonnet 5.5 reviewer, SHA `af72470`, 2026-09-29) returned FAIL with these findings, all addressed in the following commit:

- `get_security` returned all-zero quotes for live-trading instruments because `companyprofile`'s quote block is unreliable (six of twenty sampled); the quote now comes from the Trading-tab feed.
- The documentation wrongly said Nasdaq Dubai-traded equities have no quotes or history; it is delisted or matured instruments that do not.
- Search could return symbols the other tools rejected (inner space); symbol validation now accepts single inner spaces. Two leading-space directory rows resolve nowhere and are documented.
- Symbols were upper-cased before the ASCII check, letting look-alike Unicode through; validation is now strict and happens first.
- `starts_after_from_date` wording now covers weekends and holidays.
- Search could outlast a 60 s invocation; it now has an overall 45 s budget.
- Six surviving mutants are now covered by tests.

No tool has an independent sign-off yet; all three are `draft` until the reviewer rechecks the fixed source.

## URL patterns

Narrowed under spec §6.2 to `https://www.dfm.ae/*` and `https://marketwatch.dfm.ae/*` instead of the default `https://dfm.ae/*` / `https://*.dfm.ae/*`. `dfm.ae` hosts separate products: the market-information site (`www.dfm.ae`), the market-watch page (`marketwatch.dfm.ae`), the Arena offerings portal, and the eServices/sign-in hosts (`esrv.dfm.ae`, `login.dfm.ae`). The tools read public exchange data and belong on the first two; the default patterns would also list them on the sign-in and account pages, where they cannot help and where an agent may be entering credentials. `dfm.ae` itself redirects to `www.dfm.ae`. `api2.dfm.ae` allowed cross-origin requests from `www.dfm.ae` and `marketwatch.dfm.ae` origins (checked 2026-09-29).

## Sessions

Ephemeral browser sessions used by the builder are deleted after the work; none is recorded here.
