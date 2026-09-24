# jetblue.com

Tools for JetBlue (https://www.jetblue.com).

| tool | file | status | notes |
|---|---|---|---|
| search_flights | [search_flights.js](search_flights.js) | verified | Initial outbound flight cards, including round-trip searches; 1–7 adults |

## Scope

- Namespace: `jetblue.com`. Matches `https://jetblue.com/*` and `https://*.jetblue.com/*`.
- The file is a single self-contained expression returning a CDP tool-definition array. Register it with `webmcp.addCustomTools({ namespace: "jetblue.com", tools: eval(source), forceOverwriteNamespace: true })`.
- Inputs: distinct uppercase IATA airports, a non-past ISO departure date, `one_way` or `round_trip`, an optional return date required only for round trips, and 1–7 adult passengers (default 1). Children, infants, points, and multi-city searches are not supported.
- Returns every flight card in the initial results batch, its airline and flight numbers, airports, local departure/arrival dates and times, duration, stops, lowest displayed cash fare, result count, results URL, and whether more cards can be loaded. Round trips return outbound options, not return-flight selections or whole-trip totals. The displayed dollar symbol is preserved without inferring an ISO currency or passenger-total basis.
- Read-only search: never selects a fare, loads another batch, books, enters personal data, or purchases. Use one invocation at a time per browser; the tool navigates the current tab.

## Site quirks

- Homepage airport fields use autocomplete: select the exact airport, not a metropolitan-area grouping. Dates accept `MM/DD/YYYY`; trip type and passengers have separate menus. The tool uses the observed booking URL parameters instead of depending on those controls.
- Invocation checks the current URL. The canonical homepage and flight-results path are suitable entry contexts; other pages first navigate to the homepage and wait for its origin input. Every invocation then navigates to a fresh search URL, even if the browser already shows results.
- Results render client-side in `.flight-result-item`. Wait on priced cards or the explicit no-flights message, not a fixed sleep. The initial batch is commonly ten cards; a “more flights” control exposes later options.
- JetBlue may add `IncludeBasic=true` to the URL. The tool verifies the requested parameters while permitting additional site parameters. Overnight `+1 day` markers are in `.arrival-offset`, outside the arrival-time element.
- The site can display “No flights have been found” when its inventory request fails. The tool requires a successful inventory HTTP response and transaction, matching outbound route/date, and agreement between empty/nonempty inventory and visible cards. HTTP failures, timeouts, malformed cards, and inconsistent results produce invocation errors, never successful empty output. Allow 120 seconds for invocation; controlled missing-inventory tests returned errors at about 95 seconds and failed page loads at about 100 seconds.

## QA summary

Independent QA completed three rounds on 2026-09-24. Every successful response was recursively checked against its output schema and compared with every visible initial flight card. No fare or load-more button was selected.

| Coverage | Result |
|---|---|
| Round trip, one way, short haul, long haul, near-term and June 2027 dates | Passed |
| Connecting flight numbers, stops, overnight dates, displayed prices, count and more-results flag | Passed |
| Default one adult, two/three adults, seven-adult boundary | Passed |
| Genuine empty inventory; blocked inventory twice and recovery searches | Passed; failures do not become `no_results` |
| Invalid dates, trip/date combinations, same airports, extra properties, invalid passenger counts | Rejected without navigation |

QA found and verified fixes for false empty results on inventory failure and an incorrect nine-adult maximum; earlier checks also corrected URL canonicalization and overnight-marker parsing. Transient network and site failures remain explicit errors. No actionable defect remained in the tested matrix.

The repository migration was live-verified on 2026-09-24 starting from `https://www.jetblue.com/travel-agents`, not the homepage. A two-adult JFK–LAX round trip for 2026-10-15 through 2026-10-20 returned ten complete outbound cards in 12.7 seconds, with both overnight arrivals dated 2026-10-16. The old `airline_tools` registration was removed. The registered definition and repository definition were compared byte-for-byte after serialization, including the execute function. The prior QA pass covered the search/parser; migration-specific entry routing was checked by local tests and this live invocation.

Run local contract/navigation tests from the repository root:

```sh
node --test tests/jetblue-search-flights.test.mjs
```

These use browser-helper stubs to check expression loading, matching, entry navigation from different hosts/pages, fresh search from suitable pages, and explicit failures. They do not replace live DOM or inventory QA.

## Sessions

- Verification browser: `fe509cugfxs9gqfs1wk1kkne` (24-hour inactivity timeout; left alive).
- Independent QA browser: `vcmmlsr2fph2ydejqtc1h6gs` (24-hour inactivity timeout; left alive).
- Independent QA agent: `agt_8da83a2e489269a5ff05`.
- Source: this repository is canonical; sessions expire but files do not. No authenticated browser URLs or credentials are stored here.
