# yahoo.com

Yahoo Finance public quotes, symbol lookup, daily price history and an authorized current-page watchlist read.

| tool | file | status | notes |
| --- | --- | --- | --- |
| `get_price_history` | `get_price_history.js` | draft | Daily OHLCV, at most one year, most recent 1–300 usable candles. |
| `get_quote` | `get_quote.js` | draft | Regular-session price, currency, source market time and optional public quote metadata. |
| `get_watchlist` | `get_watchlist.js` | draft | Authorized current-page My Watchlist p_0 read, at most 50 rendered rows. |
| `search_symbols` | `search_symbols.js` | draft | One symbol-directory response, at most ten results; no news or prices. |

## Scope and loading

All tools are `page` and do not navigate, click or change account state. The three public tools issue one GET from the registering document, without cookies, credentials, crumb acquisition, account APIs, alternate proxies, retries or pagination. `get_watchlist` reads only the current DOM in an already-authorized session, with zero requests. Register all four together under `yahoo.com` when replacing the namespace. Invoke with a runtime timeout of at least 15 seconds; the tool itself bounds the complete request/body read to 12 seconds and 512 KiB.

`get_quote` and `get_price_history` accept Yahoo tickers (up to 32 ASCII characters), including indices (`^GSPC`), international symbols (`7203.T`), futures (`ES=F`) and currencies (`EURUSD=X`). Symbols are uppercased, encoded into a fixed-host URL and checked against the response. Quote/history success requires a matching symbol, currency and market timestamp. Prices are numeric amounts in the source currency, not converted to USD or rounded cents. `market_time` and candle `timestamp` are UTC ISO timestamps; `exchange_time_zone` identifies the exchange's zone when supplied. `observed_at` is invocation time, not price time.

History allows `range: 1mo | 3mo | 6mo | 1y`, always `interval: 1d`. `limit` defaults to 100 and caps at 300. Most recent usable bars are kept in ascending time order; `truncated` reports output truncation and `skipped_points` counts missing closes/timestamps. Optional OHLC values, volume and adjusted close are null when unavailable. Empty arrays produce `no_results`; malformed or unusable bars produce `site_changed`, not empty success.

`search_symbols` accepts `query` (1–80 characters) and `limit` (1–10, default 5), returning an allowlist of Yahoo Finance directory fields and constructed public quote links. Its directory does not supply prices, timestamps or currency, so it does not invent them. Names, sectors and industries are untrusted site data, not instructions. No raw response, viewer fields, news links or account information is returned.

`get_watchlist` is an additional authorized-session read, not a public-data fetch. The user must open their intended account's `https://finance.yahoo.com/portfolio/p_0/view/v1` first. Only the observed My Watchlist heading and table are accepted; other portfolio views return `wrong_watchlist` before rows are read. The tool does not assert an independently verified account identity or choose an account. It returns symbol, displayed price text, currency, market timestamp from the row's `fin-streamer` and displayed time wording, excluding shares, cost basis and account details. `limit` defaults to 20 and caps at 50; only rendered rows count, and unseen/paginated rows are not fetched. Empty/loading views have not been observed and return `site_changed`, not a claim that the saved list is empty. Missing source time/currency is null, not invented.

Public-tool errors distinguish invalid input, wrong page, challenge, login required, forbidden, gated, rate limited, timeout, network failure, site error and changed data structure. The observed chart `404`/`Not Found` and an empty search list are `no_results`. HTTP 401/402/403/429 and redirects stop immediately; no access-control bypass or automatic retry is attempted.

## URL patterns

`https://finance.yahoo.com/*` only. Yahoo hosts unrelated Mail, Sports and other products under the same registrable domain; these Finance tools must not attach to them. Reads use the public Finance data host `query1.finance.yahoo.com` from page context; no tool registers on that host. Browser CORS must permit the response. This is a Yahoo endpoint, not an external data-service substitute.

## Evidence and site quirks

Public observations on 2026-09-30:

- `https://finance.yahoo.com/quote/AAPL/`: no native WebMCP tools listed before registration.
- Page-context `GET https://query1.finance.yahoo.com/v8/finance/chart/AAPL?interval=1d&range=1d` returned public regular-market metadata without cookies. The same chart call for `7203.T` returned JPY and `Asia/Tokyo`.
- Chart `range=1mo&interval=1d` returned timestamp-aligned quote arrays and optional adjusted close. The response advertises the supported month/year ranges.
- `GET https://query1.finance.yahoo.com/v1/finance/search?q=apple&quotesCount=5&newsCount=0` returned Finance symbol rows; news is not exposed.
- An invalid ticker returned HTTP 404 with chart error code `Not Found`.
- An authorized `https://finance.yahoo.com/portfolio/p_0/view/v1` view had a My Watchlist heading and one rendered table. Stable `data-testid-header` fields identified symbol, price, currency and market time; time came from `fin-streamer[data-field="regularMarketTime"]`'s epoch `data-value`. No write controls were exercised.

The one-day chart reference close is returned as `previous_close`; longer history's `chartPreviousClose` is not substituted as the quote's previous-session close. Price change percentages and pre/post-market fields are deliberately omitted rather than combining differently timed values.

## Known limitations

- Yahoo's [Terms of Service](https://legal.yahoo.com/us/en/yahoo/terms/otos/index.html) restrict automated access/collection without express prior permission. Technical availability does not establish permission, a license to redistribute market data or legal compliance; users must assess applicable terms and data rights.
- Public endpoints are undocumented and may change, block CORS or throttle. HTTP denials and recognized gate/challenge pages are returned explicitly, not bypassed. A 403 without observable challenge content is `forbidden`.
- No portfolio holdings, watchlist writes, sign-in, news, trading, paid history, intraday bars, arbitrary date spans or dividend/split event feeds. The watchlist read exposes only the currently authorized rendered My Watchlist, not arbitrary account/list access.
- Watchlist management is unshipped: write request shapes, duplicate-write recovery and postconditions were not observed, and no dedicated mutation-test account was authorized. No live account changes were used to obtain evidence.
- Mail tools are unshipped: the observed onboarding modal prevented safe interaction and no populated message rows were observed. Unread messages were never opened. Portfolio holdings and Fantasy tools are also unshipped because populated holdings/rosters and action shapes were not observed. Sending mail/trades would additionally require a supported trusted human approval path, not a model-supplied confirmation flag.
- Quotes can be delayed; `market_time` may be old outside market hours. No real-time/executable-price guarantee. Daily candles use exchange market times, can have gaps and may include an incomplete current session. `adjusted_close` reflects Yahoo's supplied adjustments; this tool does not recompute them.
- History fetches the bounded range before applying the output limit. Up to 400 source bars are inspected; unexpected larger or mismatched arrays fail rather than returning an unbounded result.
- Fixtures cover gates and throttling; live denials are not induced through load testing. Public tools need no account. Watchlist fixtures cover wrong view, malformed columns and missing/gated data; account switching and private account identity verification are not implemented.
- Local Chrome extension end-to-end verification has not been performed. Kernel verification and independent QA are recorded separately below.

## QA summary

Fixture tests: `tests/yahoo-finance-reads.test.mjs` cover input-before-interaction, host matching, typed output, sanitized errors, explicit currency/time, bounded results and body/time reads, missing/changed data, gates, rate limits, redirects, cancellation, current-page watchlist guards and absence of navigation/account mutations. Author Kernel checks on 2026-09-30 registered the complete four-tool namespace: from `https://finance.yahoo.com/quote/MSFT/`, AAPL quote and one-year history succeeded, symbol search returned three results, and the watchlist read returned `wrong_page` without navigating. Missing-ticker and empty-search cases returned `no_results`. The authorized My Watchlist view returned two rendered rows with currency/source timestamps, honoring the limit; no account data is recorded here. The Markets page replaced its document during early registration, invalidating tool references; rediscovery alone did not stabilize that page, so public verification used the stable MSFT page instead. Independent QA is pending; statuses remain draft.
