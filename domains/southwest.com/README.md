# southwest.com

Tools for Southwest Airlines (https://www.southwest.com).

| tool | file | status | notes |
|------|------|--------|-------|
| search_flights | [search_flights.js](search_flights.js) | verified | First outbound results page; round trips return outbound options only |

## Scope and loading

Register the file's array expression under namespace `southwest.com`, with
`forceOverwriteNamespace: true` when replacing it. Its CDP definition matches
`https://southwest.com/*` and `https://*.southwest.com/*` and survives navigation.

```javascript
const source = (await import("node:fs")).readFileSync(
  "domains/southwest.com/search_flights.js", "utf8"
);
await webmcp.addCustomTools({
  namespace: "southwest.com",
  tools: eval(source),
  forceOverwriteNamespace: true
});
const tool = (await webmcp.listTools()).find(t =>
  t.source.custom?.namespace === "southwest.com" &&
  t.tool.name === "search_flights"
);
const result = await webmcp.invokeTool(tool.tool_ref, {
  origin: "DAL",
  destination: "HOU",
  departureDate: "2026-10-15",
  returnDate: "2026-10-18",
  tripType: "roundtrip",
  passengers: 1
}, { timeoutSec: 120 });
repl.write(JSON.stringify(result));
```

Use future dates within the site's current booking horizon. Run searches serially
and obtain a fresh tool reference for each invocation. The tool checks for the
canonical homepage's airport inputs; if absent or on another page, it opens that
entry point before navigating to a fresh results URL. It does not rely on prior
form values or prior results.

Inputs support uppercase IATA airport codes, one-way or round-trip dates, and
1–9 adult passengers. Output includes all visible first-page outbound rows,
flight numbers, local departure/arrival times, arrival day offsets, durations,
stops, and the lowest enabled displayed fare. Prices are USD per adult per
direction, not party totals or round-trip totals. This is a read-only search:
it never selects a fare, adds to a cart, purchases, or enters personal data.

## Site quirks

- Results render client-side at `/air/booking/select-depart.html`. The tool waits
  for fare rows or explicit failure/empty states rather than a fixed sleep.
  Entry-form loading has a 30-second limit within the 95-second search budget.
- Return options require selecting an outbound fare. The tool deliberately stops
  at the first outbound page, including for round-trip searches.
- Fares are displayed rounded up to whole dollars. Unavailable fare classes are
  excluded from the minimum; a completely unavailable row retains its flight
  data with a null price. Times are airport-local; next-day arrivals are explicit.
- Unsupported routes or dates can redirect to the low-fare calendar. Unknown
  airport codes can redirect to a validation form while destroying the page
  execution context. These return `site_error`, not false empty availability.
- Input-schema violations may be rejected before execution. Semantic date/route
  checks return `invalid_input`; date validation uses the current Eastern date.

## QA summary

Verified on 2026-09-24. Independent QA agent: `agt_8afff9b68b132cd8ce86`.

Before the namespace migration, independent QA compared 408 live flight rows
across initial testing and retesting with the rendered DOM: no schema violations,
count mismatches, or field discrepancies. Coverage included DAL–HOU round trips
and one-way searches, 1 versus 3 adults, HNL–SJU connecting overnight flights,
near-term dates, future dates within the booking horizon, out-of-horizon dates,
unsupported routes, and invalid inputs. The unknown-airport navigation race was
fixed and independently retested successfully three times.

The migrated tool was invoked from an existing results page, not the homepage:
DAL–HOU on 2026-10-15, returning 2026-10-18, one adult. It returned `ok` with 26
flights in 11.7 seconds, matching all 26 rendered rows; the first fare was $99.
The legacy `airline_tools` registration was removed from the live browser.

Independent migration QA loaded the canonical array expression and started from
`/air/low-fare-calendar/`. DAL–HOU round trip returned 26 flights in 10.2 seconds;
HNL–SJU one-way for two adults returned five overnight flights in 6.8 seconds;
ZZZ–HOU returned a schema-valid `site_error` in 4.7 seconds. All 31 flight rows
matched the live DOM and full output schema, with no new defects found.

Synthetic CDP document fixtures separately verified `no_results`, `parse_error`,
all-unavailable fares, and a schema-valid `timeout` after 95.84 seconds. These
are fault-injection tests, not evidence of live Southwest availability.

Local contract and navigation tests:

```sh
node --test tests/southwest-search-flights.test.mjs
```

These mock page responses to test the single-expression contract, page-entry
routing, passenger/date query parameters, and explicit failures. Live QA covers
the flight DOM parser. The input/output schemas remain unchanged from the
independently tested implementation.

### Known limitations

- No genuine live zero-flight page was found. Empty-result classification has
  synthetic coverage only.
- An outer Browser REPL request can time out before delivering the tool's
  95-second timeout response, even when a larger timeout is requested. Splitting
  an invocation across REPL cells did not fix delivery and produced canceled or
  uncertain outcomes. Await within one cell; never automatically retry an
  `outcome_unknown` invocation.

## Sessions

- Live browser: `fx7wthoc7hk61tlbj91rhuq0` (24-hour inactivity timeout).
- Independent QA browser: `styc5ynixcw173holdcvm4dx` (24-hour inactivity timeout).
- Source: this repository is canonical; sessions expire but files do not.
