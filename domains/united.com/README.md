# united.com

Tools for United Airlines (https://www.united.com).

| tool | file | status | notes |
| --- | --- | --- | --- |
| search_flights | [search_flights.js](search_flights.js) | verified | Initial outbound results, including connections and nearby-airport alternatives |

## Scope and loading

`search_flights.js` is a single self-contained expression evaluating to a tool-definition array. Register it with namespace `united.com`:

```js
const source = (await import("node:fs")).readFileSync("domains/united.com/search_flights.js", "utf8");
await webmcp.addCustomTools({ namespace: "united.com", tools: eval(source), forceOverwriteNamespace: true });
const tool = (await webmcp.listTools()).find(t =>
  t.source.custom?.namespace === "united.com" && t.tool.name === "search_flights"
);
const result = await webmcp.invokeTool(tool.tool_ref, {
  origin: "SFO",
  destination: "LAX",
  departDate: "2026-10-15",
  returnDate: "2026-10-20",
  tripType: "roundtrip",
  passengers: 1
}, { timeoutSec: 120 });
repl.write(JSON.stringify(result));
```

Use current future dates when running the example. The CDP tool matches both `https://united.com/*` and `https://*.united.com/*`. On invocation it checks the current URL against the requested search entry point and navigates there when needed; it does not require the homepage or prefilled form state. It still waits for results when already at that exact search URL.

Supported scope: the English/US cash-fare flow, 1–9 adults, and valid travel dates from today through 330 days ahead. Searches request economy and return the lowest displayed fare for each initial-page itinerary. No purchase, fare selection, login, or personal-data entry occurs.

The output includes marketing airlines, segment flight numbers, actual departure/arrival airports, airport-local times, arrival day offsets, duration in minutes, stops, per-person USD starting fares, result count, results URL, fare disclaimer, and search notices. Roundtrip searches return outbound options with advertised roundtrip starting fares, not confirmed outbound/return pairings. `resultCount` counts returned rows, not all inventory or later pages.

## Site quirks

- Results arrive client-side in stages. The tool waits for priced rows, network idle, and DOM quiet, then expands flight details to obtain connecting segment numbers.
- United may include nearby airports automatically. These remain in the output with their actual airport codes and explicit `searchNotices`; an NRT search can include HND.
- Overnight arrivals use labels such as `Arrives Jan 1`, not necessarily `+1`. Parsing handles year rollover and durations below one hour.
- The explicit no-flights component returns `no_results`; a redirect to the booking form returns `error`. Missing or unparseable required data also fails explicitly rather than returning partial success.
- Internal waits share a 105-second budget. Slow navigation or an external transport deadline can still interrupt the caller before the invocation completes. Inspect stored invocation state after an uncertain outcome instead of automatically replaying it. Selectors and English text depend on United's current UI.

## QA summary

Independent QA passed on 2026-09-24 after fixing nearby-airport extraction and explicit no-results detection. Every completed output was checked against its output schema, with successful flights compared row-by-row to the live DOM. Tests covered roundtrip and one-way searches, near-term and far-future dates, 1–3 adults, short-haul and long-haul routes, partners and connections, overnight/year-boundary arrivals, a 58-minute flight, site rejection, and zero results. Ten invalid-input cases were rejected without navigation; registration persisted across navigation.

| Independent re-QA case | Result | Rows |
| --- | --- | ---: |
| SFO–LAX, 2026-10-15 to 2026-10-20, 1 adult | success | 26 |
| SFO–LAX, 2026-09-26 one-way, 2 adults | success | 21 |
| EWR–LHR, 2026-11-10 to 2026-11-17, 1 adult | success | 35 |
| SFO–NRT, 2027-07-15 one-way, 3 adults | success; HND alternatives disclosed | 35 |
| SFO–MRY, 2026-10-15 one-way, 1 adult | success | 6 |
| CVG–LUK, 2026-10-15 one-way, 1 adult | site rejection reported as error | 0 |
| EWR–JFK, 2026-10-15 one-way, 1 adult | no_results | 0 |
| SFO–LAX, 2026-12-31 one-way, 1 adult | success; Jan 1 arrival parsed | 19 |

After the repository-convention migration, a live invocation under `united.com` started on the SFO–NRT results page, not the homepage. It navigated to the requested SFO–LAX roundtrip search and returned 26 flights matching 26 DOM rows in 29.309 seconds at 2026-09-24T23:09:04Z. The first itinerary was UA 2127, 06:00–07:37 local, 97 minutes, nonstop, $117 roundtrip per person. Both schemas are unchanged from the independently tested version. The obsolete `airline_tools` registration was removed.

Run the local contract/navigation tests from the repository root:

```sh
node --test tests/united-search-flights.test.mjs
```

## Sessions

- Verification browser session: `m49n8cyp3k0hzn902fof5x6t` (24-hour inactivity timeout; kept alive).
- Independent QA browser session: `sdxghwgyazxgtfojg2sqehsk`.
- Independent QA agent: `agt_a87837884a432de575e8`.
- Source: this repository is canonical; sessions expire but files do not.
