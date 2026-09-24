# aa.com

Tools for American Airlines (https://www.aa.com).

| tool | file | status | notes |
|---|---|---|---|
| search_flights | [search_flights.js](search_flights.js) | verified | First-page outbound options; round-trip fares do not select a return flight. |

## Scope and loading

`search_flights.js` is a single expression returning the tool-definition array, with no imports or external dependencies. Register it with namespace `aa.com`:

```js
const source = (await import("node:fs")).readFileSync("domains/aa.com/search_flights.js", "utf8");
await webmcp.addCustomTools({
  namespace: "aa.com",
  tools: eval(source),
  forceOverwriteNamespace: true,
});
```

The CDP tool matches `https://aa.com/*` and `https://*.aa.com/*`. It checks the current origin, path, form action, and visible enabled search controls. If the page is unsuitable, it navigates to `https://www.aa.com/homePage.do` before interacting with the form. It does not depend on prior search state.

Inputs are uppercase IATA codes, ISO dates, `roundTrip` or `oneWay`, and 1–9 adult passengers (default 1). Round trips require a return date; one-way searches reject one. Runtime date validation permits today through 331 days ahead, using UTC dates. This is a cash-fare search, not an award search. It never selects a fare, books, pays, or enters personal data.

Outputs include every rendered first-page option, result counts, the results URL, marketing flight numbers/carrier codes, published operator labels, transport modes, local departure/arrival times, arrival-day offset, duration, stops, and the lowest displayed per-person from-fare. A displayed `$` is preserved as a currency symbol rather than guessed to mean a particular ISO currency. Round-trip prices do not identify a selected return itinerary or guarantee the total for all passengers.

## Site quirks

- Results render client-side. The tool waits for result/error signals, with a 105-second execution budget; invoke with `timeoutSec: 120`. Await the invocation in the same REPL cell, configured with enough execution time. Use a dedicated tab and invoke serially.
- American can include nearby airports and airline-marketed buses. Check each row's `matchesRequestedAirports` and `transportTypes`, plus `exactMatchCount` and `nearbyAirportCount`. `alternatives_only` means none of the returned rows matches both requested airports.
- `no_results` requires an explicit empty-state signal. Challenges and access denial return `blocked`; missing results return `timeout`; validation or parsing failures return `error`. An empty failure output is not evidence of no availability.
- Non-stealth sessions encountered human verification. Stealth enabled successful searches but did not prevent later access denial. Connection failures also occurred on long-haul round-trip searches.
- A one-way radio reset was observed intermittently. The tool waits for homepage load and reasserts the requested trip type before validating the form. Repeated independent verification of that mitigation was prevented by access denial.

## QA summary

Verified on 2026-09-24. Independent QA used separate browsers and reported defects without changing the implementation. Empty-state classification, nearby-airport labeling, and bus classification were corrected and independently retested. Access Denied classification was independently verified on the final pre-migration revision.

| Scenario | Evidence |
|---|---|
| CVG–DFW, 2026-10-15 through 2026-10-20, round trip, one adult | Independent QA returned 40 options. After migration, invocation from `/booking/session-timeout` returned `ok`, 40 exact options in 25.631 seconds; all output fields passed the schema walk. |
| DFW–AUS, 2026-09-27, one way, two adults | Independent QA returned 14 options; an intermittent trip-type reset was also reproduced before mitigation. Final pre-migration author test returned 14. |
| JFK–LHR, 2027-07-10, one way, one adult | Independent QA and final pre-migration author tests returned 40 options. |
| LHR–LGW, 2026-10-15, one way, one adult | Independent fix verification returned `no_results`, zero options. |
| JFK–EWR, 2026-10-15, one way, one adult | Independent fix verification returned `alternatives_only`, 40 nearby options, zero exact matches, including 13 rows with bus segments. |
| Invalid inputs | Identical airports, impossible/reversed dates, dates beyond the booking window, and passenger counts 0/10 were rejected by the tool or invocation schema validation. |

The final pre-migration author tests validated 134 rows across five outputs. Independent regression QA validated 174 rows on the preceding parsing revision. These used recursive validation of every schema keyword present in the output schema; Ajv was unavailable in the browser. The migration preserves both schemas and parsing behavior and adds entry-page verification. Its non-homepage live test is author verification, not a new independent QA pass.

Remaining coverage gaps: independent repeated round-trip/one-way transitions after the radio mitigation, mixed exact-plus-nearby international results, and DFW–HND round trip (2027-02-10 through 2027-02-20, two adults). The latter encountered connection failures and conservatively timed out rather than reporting no flights.

Local entry-point and packaging tests:

```sh
node --test tests/aa.com.test.mjs
```

## Sessions

- Development and migration-verification browser: `qer6pzs0jzhw3r5j9bx7yse4` (24-hour inactivity timeout, left alive).
- Independent QA browser: `herknyf87s7zdzhwscc6g224` (24-hour inactivity timeout, left alive).
- Independent QA agent: `agt_dbdb039786be4bed1121`.
- This repository is canonical; browser sessions and registrations expire, but the source does not.
