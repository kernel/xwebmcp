# dfm.ae

Public market information from Dubai Financial Market (https://www.dfm.ae). Read-only, signed out, no account access or investment execution.

| tool | file | status | notes |
|------|------|--------|-------|
| search_securities | [search_securities.js](search_securities.js) | draft | Ranked symbol/name search across six directory lists; bounded results and explicit failed lists |
| get_security | [get_security.js](get_security.js) | draft | Instrument identity plus the Trading-tab quote, retrieval time and last-trade date |
| get_price_history | [get_price_history.js](get_price_history.js) | draft | Daily summaries, newest first, with coverage dates, retrieval time and explicitly unknown currency |

## Native tools and execution kind

No native tools were discovered on the public home page on 2026-09-30 before custom registration. Earlier public checks also found none on company pages and market watch.

All three are `page` tools. Requests run in the registering document and never navigate. A page-first invocation returns structured data without replacing the document; no CDP exception is needed. The tools call the same public widgets endpoint used by the site, with `credentials: "omit"`; no cookies, profile or authorized account are required.

## Scope and loading

Register **all three files together** under namespace `dfm.ae` when using `forceOverwriteNamespace`, including on updates. Atomic replacement removes the entire previous namespace; registering only one file would remove the other two.

- `search_securities`: `query` (1–80 characters before normalization), optional `security_type` (`equities`, `bonds`, `sukuk`, `funds`, `etfs`, `reits`), `limit` (1–50, default 20). Exact symbol, symbol prefix and name prefix rank ahead of other textual matches, not investment merit. Up to six sequential requests within a 45-second budget; `failed_types` means incomplete coverage.
- `get_security`: exact `symbol`, case-insensitive ASCII, at most 40 characters, with single internal spaces allowed. Reads identity from `companyprofile`, then quotes from `SearchProfileTradingTab`. Two requests, each capped at 20 seconds. Unknown symbols stop after the profile lookup.
- `get_price_history`: `symbol`, optional ISO `from_date`/`to_date`, `limit` (1–500, default 60). Dates default to the 30 days ending today in Dubai. One daily-summary request, with one profile lookup only if history is empty to distinguish `no_results` from `not_found`. Narrow `to_date` to retrieve older rows discarded by the limit.

Use a 60-second invocation timeout. Invalid inputs are rejected before requests. Failures distinguish `invalid_input`, `not_found`, `rate_limited`, `blocked`, `site_error` and `site_changed`; a denial is never treated as empty results. Requests are not retried.

### Timestamps and currency

- `retrieved_at` is the browser's UTC clock, not the source's timestamp. Search has no source timestamp.
- Quotes expose a date-only `last_trade_date`; daily rows expose session dates and date-only last-trade dates. No intraday timestamp is available.
- `timing.realtime` stays `"unknown"`. Market watch states public data is delayed 15 minutes and real-time data requires sign-in; these tools cannot establish freshness or whether today's summary is final.
- `get_security.currency` preserves the profile feed's `Currency`, or null when absent. It is not independently verified as the denomination of every quote field or NAV.
- `get_price_history.currency` is explicitly null: the daily-summary feed does not state currency. Do not infer AED or USD from the exchange or symbol. Search lists likewise publish no currency field. Missing currency is a limitation, not a claim of zero monetary value.
- Numbers are parsed from formatted strings. Percentage changes use percent units: `-0.51` means `-0.51%`. Volume and trade counts are not monetary amounts.

## Safety

No sign-in, watchlist/preference writes, portfolio access, subscriptions, trading, investment orders, funds movement, account creation or eServices requests. These tools do not recommend securities or provide execution-ready prices. No live account mutations were used for development or QA.

## Site quirks

- The undocumented `api2.dfm.ae/web/widgets/v1/data` endpoint may change. The site's Sukuk directory uses `securitytype=sukuks`.
- The company-profile quote block can be stale or zero even when the company page shows trades. `get_security` therefore takes the entire quote block from the Trading-tab feed, retaining profile identity and NAV only.
- Unknown symbols return HTTP 200 with an empty `Symbol`. Existing instruments without daily rows return `[]`; a profile lookup separates these cases.
- `quote.status` distinguishes positive published last price, zero/absent last price and entirely absent quotes. Non-trading rows can have zero placeholders and stale closes; `traded` is based on positive volume. Neither a zero nor a close proves a current executable price.
- Delisted instruments can still appear in directory lists as `Active: true`. Listings can duplicate symbols, omit names or omit instruments supported by profile lookup. Leading-space directory symbols are trimmed; some still do not resolve. A returned profile URL alone does not prove existence.
- Active Nasdaq Dubai instruments can have history and quote fields even without a positive last price. Missing quotes are not an exchange-wide restriction.

## Known limitations

- Public market data only. No authenticated watchlist or preferences were established, so no account tools are shipped. Login expiry and existing cleanup are not changed by this implementation.
- Currency may be unknown; no currency conversion, generic AED default, intraday timestamp or real-time guarantee. Not suitable for trading decisions.
- Results are bounded to 50 search matches or 500 history rows. Search names failed lists; absence from a directory is not proof an instrument does not exist.
- The site's history window is limited. Earlier checks on 2026-09-29 found equity history starting at 2024-12-31; older history requires a logged-in eServices request, not implemented here. `starts_after_from_date` can also reflect weekends, holidays or a later listing.
- No disclosures, market summaries, corporate actions, ownership, index/futures history, Arabic-content parsing or Arena offerings.
- Full local-extension parity, interactive permission grant, headful Chrome, page-CSP fallback and trading-hours behavior are not established by prior headless/pre-granted checks.

## QA summary

Fixture tests in `tests/dfm-market-data.test.mjs` use fabricated data and a stubbed page fetch/clock. They cover input validation before interaction, schemas, request encoding, limits and time budgets, feed selection, missing data, stale/zero quotes, currency uncertainty and explicit network/permission/rate-limit failures.

Builder live checks on 2026-09-30 (signed-out Kernel browser, market closed): all three tools registered together twice with atomic namespace replacement. From the EMAAR Daily Summary page, search returned matching instruments, details returned the published quote, and history returned three newest rows from 21 sessions with `currency: null`. Unknown symbol and malformed array/date inputs returned explicit errors; all six invocations kept the URL unchanged. The namespace was absent on `example.com`. Profile currency was null and the sampled daily feed and directory had no currency fields.

Earlier independent QA found stale profile-feed quotes, invalid symbol handling and an excessive search request budget. The branch already contains fixes and regression tests for those findings. Historical live/extension checks are not a substitute for a new independent check of the final source. Current-source QA is pending; registry entries remain draft.

## URL patterns

Tools belong to the public market-information product on `https://www.dfm.ae/*` and `https://marketwatch.dfm.ae/*`. Patterns are narrowed under spec §6.2 because Arena offerings and eServices/sign-in are separate products within the domain. Tools do not attach there or on `ivestor.ae`. The bare domain redirects to `www.dfm.ae`. Public widget CORS was observed working from the main site; blocked origins return a request failure rather than changing the tab.
