# flyfrontier.com

Tools for Frontier Airlines (https://www.flyfrontier.com).

| tool | file | status | notes |
|---|---|---|---|
| search_flights | [search_flights.js](search_flights.js) | verified | Core search matrix and live invocation verified; intermittent failures remain. Use supervised searches. |

## Scope

- Read-only flight search for 1–9 adults, one-way or round-trip, using uppercase IATA codes and ISO dates. No children, infants, flight selection, purchases, or personal-data entry.
- Returns all displayed first-page flight rows, including separate outbound and return alternatives, flight numbers, local dates/times, duration, stops, and prices. Rows are not paired round-trip itineraries.
- Namespace: `flyfrontier.com`. Matching: `https://flyfrontier.com/*` and `https://*.flyfrontier.com/*`.
- Before searching, checks the current URL and expected form. A loaded homepage search form or booking results form is suitable; other pages, including unrelated origins, first navigate to the homepage entry point. Matching still limits normal tool discovery to Frontier hosts.
- The file is a single self-contained expression evaluating to the definition array. Register it with `webmcp.addCustomTools({ namespace: "flyfrontier.com", tools: eval(source), forceOverwriteNamespace: true })`, following the root README. This replaces all registrations in this domain namespace.

## Site quirks

- Homepage airports require autocomplete selection. The UI uses calendar pickers and separate adult/child/infant counters. Search navigation goes through `booking.flyfrontier.com/Flight/InternalSelect` to `/Flight/Select`.
- Results render asynchronously. The tool waits for document replacement and populated flight metadata, a visible no-flights message, or a visible site error. It validates the requested route, dates, trip type, and passenger count before returning rows.
- `price.amount` is the per-person Basic Standard leg fare from the row's `basicstandardfare` metadata. `displayedAmount` is the rounded UI fare or null when the UI shows `--`. Round-trip displayed amounts are indicative totals; do not sum them. Metadata amounts are not checkout quotes or standalone one-way quotes for a round-trip search.
- Durations may contain a `day(s)` prefix and an overnight suffix. Local timestamps come from segment sell keys because the separate display-date metadata can reflect a different calendar day.
- A search beyond the published schedule can explicitly show no flights. Only that visible signal produces `no_results`. Timeouts, site errors, parser failures, and mismatched search state remain explicit errors. Departure-date validation uses today's UTC date.

## QA summary

Independent QA agent: `agt_7944f6b168e2b52c685d`.

The final pre-migration QA pass made 33 calls: 24 valid-route searches, one unknown-route search, and eight invalid-input calls. All 366 returned rows passed output-schema and field-by-field DOM comparisons. This verifies returned data, not uninterrupted reliability: the longer alternation run had three stale-state failures and one timeout, detailed below.

| Search | Adults | Core-case outcome |
|---|---:|---|
| DEN–LAS round trip, 2026-10-15 / 2026-10-18 | 1 | 50 rows, 25 each direction |
| DEN–LAS one-way, 2026-10-15 | 2 | 25 rows |
| PHL–LAS one-way, 2026-10-20 | 1 | 12 rows, including multi-day connections |
| CVG–DEN one-way, 2026-09-26 | 1 | 16 rows |
| DEN–MCO one-way, 2027-03-15 | 3 | 23 rows |
| DEN–LAS one-way, 2027-09-15 | 1 | Explicit `no_results` |
| DEN–AAA one-way, 2026-10-15 | 1 | Explicit `SITE_ERROR` |

Invalid calendar dates, past dates, identical airports, reversed return dates, inconsistent trip types, and passenger counts outside 1–9 were rejected. Multi-day duration parsing, return-price metadata handling, and prompt invalid-station errors were fixed during development.

Migration verification on 2026-09-24 started at `https://www.flyfrontier.com/optional-services`, not the homepage. The domain-scoped tool automatically established the entry point and returned 50 DEN–LAS round-trip rows (2026-10-15 / 2026-10-18, one adult) in 10.974 seconds. The input and output schemas were compared to the previous version and are unchanged. The old `airline_tools` registration was removed.

Local tests: `node --test tests/flyfrontier-search-flights.test.mjs`. These exercise source loading, matching, entry-point control flow, and explicit failures using mocked browser helpers; they do not replace the live DOM/parser QA above.

## Known limitations

- **Intermittent stale state:** 3 of 24 valid-route calls in the final independent alternation run displayed the preceding search's form. Reproduction included PHL–LAS → CVG–DEN → DEN–MCO. Validation returned an error rather than substituted flights. The document gate and `IsEdited=true` did not eliminate this issue; the namespace/entry-point migration does not claim to fix it.
- **Intermittent timeout:** one zero-results → DEN–MCO transition returned `RESULTS_TIMEOUT` after 65.725 seconds without flight rows or a no-flights signal. Cause was unconfirmed. An earlier pass separately observed a proxy error page; generic timeouts do not identify the underlying cause.
- The full 120-second invocation deadline, other routes/schedules, and checkout-confirmed pricing remain unverified. Invoke serially with `{ timeoutSec: 120 }`; do not automatically retry an `outcome_unknown` result.

## Sessions

- Live verification browser: `wok7l4bkxn6ptqe0mf3rig15` (24-hour inactivity timeout; left alive).
- Independent QA browser: `kkmt7tlnsbzkxl0kc8y78wo9` (24-hour inactivity timeout; left alive).
- Last live verification: `2026-09-24T23:09:25.555Z`.
- This repository is canonical; browser sessions and registration IDs expire, but the source does not.
