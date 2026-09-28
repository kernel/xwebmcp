# alaskaair.com

Tools for Alaska Airlines (https://www.alaskaair.com).

| tool | file | status | notes |
|---|---|---|---|
| search_flights | [search_flights.js](search_flights.js) | verified | First-page outbound options; round-trip fares are per-adult starting fares, not selected return flights |

## Load

`search_flights.js` is a single expression evaluating to a tool-definition array.
Load it in the Browser REPL with the source file available in that browser:

```js
const source = (await import('node:fs')).readFileSync('domains/alaskaair.com/search_flights.js', 'utf8');
await webmcp.addCustomTools({
  namespace: 'alaskaair.com',
  tools: eval(source),
  forceOverwriteNamespace: true,
});
const tool = (await webmcp.listTools()).find(t =>
  t.tool.name === 'search_flights' && t.source.custom?.namespace === 'alaskaair.com'
);
const result = await webmcp.invokeTool(tool.tool_ref, {
  origin: 'SEA', destination: 'SFO',
  depart_date: '2026-10-10', return_date: '2026-10-15',
  trip_type: 'round_trip', passengers: 1,
}, { timeoutSec: 120 });
repl.write(JSON.stringify(result));
```

Choose future dates when reusing the example. Invoke serially in a dedicated tab.
The HTTPS match patterns cover the apex and all Alaska subdomains; navigation uses
`www.alaskaair.com`. The tool checks the current URL against the requested results
entry point before navigating. A matching search is refreshed for current fares.
It does not require a homepage, existing form, or previous search state.

## Scope and failures

Returns the first rendered page of outbound options, all segment flight numbers,
marketing airlines, local departure/arrival times, arrival calendar labels,
duration, stops, lowest displayed enabled cash fare, counts, and results URL.
Round-trip searches return outbound choices with per-adult round-trip starting
fares, not selected return flights or a total for the entire party.

Supports 1–9 adults and dates from today through 330 days ahead, validated in UTC.
Children, lap infants, award searches, later result pages, and booking are outside
scope. No fares are selected, personal data entered, or purchases made.

Invalid inputs throw before navigation. Runtime failures return `status: "error"`
with a message; only an explicit airline no-results notice produces `no_results`.
An invocation envelope of `completed` is not enough: inspect `output.status`.

## Site quirks

- Homepage airport inputs require an explicit airport suggestion selection;
  dates use a calendar and passengers use counters. The tool instead uses the
  verified results URL parameters `O`, `D`, `OD`, `DD`, `A`, and `RT`.
- Alaska serves two fare layouts: `button.fare-tile` and
  `button[data-testid^="valuetile-"]`. Both are supported.
- Connecting flight numbers require opening the Details dialog. Airline names
  use `[data-testid="airline-name"]` to exclude nested operating-carrier text.
- Arrival labels can be one or two calendar days later. Times are local, not UTC.
- Proxy or rendering failures remain explicit. The tool retries a proxy-error
  navigation once, and retries a detail click once only if the dialog is closed.

## Known limitations

- First rendered page of outbound options only; round trips return outbound choices with per-adult round-trip starting fares, not selected return flights or a total for the party.
- 1–9 adults, dates from today through 330 days ahead; children, lap infants, award searches, later result pages, and booking are out of scope.
- Only an explicit airline no-results notice produces `no_results`; other failures are `status: "error"`. Inspect `output.status`, not just the invocation envelope.
- The outer request can time out before the invocation completes; inspect persistent REPL state rather than repeating an invocation with unknown outcome.

## QA evidence

Independent QA agent: `agt_9e874c140265bd2a438f`.
Browser session: `b0djbuahqoj14q2qy8qhuln1` (left alive with a 24-hour inactivity timeout).
Independent QA browser: `dy2tqxwbl6xcnmbrgv8ibekw`.
No credential-bearing browser URLs are stored here.

The prior parser version passed independent checks of 60 populated flight options
against live cards and segment dialogs, including schema conformance, all flight
numbers, overnight arrivals, prices, and passenger count. The repository migration
preserves those schemas and parsing behavior; its URL-entry guard was subsequently
verified live from a non-homepage page.

| Route | Trip / dates | Adults | Returned / total |
| --- | --- | ---: | ---: |
| SEA–SFO | Round trip, 2026-10-10 to 2026-10-15 | 1 | 10 / 45 |
| SEA–PDX | One way, 2026-09-26 | 1 | 10 / 12 |
| SEA–PDX | One way, 2026-09-26 | 3 | 10 / 12 |
| SEA–JFK | Round trip, 2027-07-15 to 2027-07-22 | 2 | 10 / 13 |
| SEA–NRT | One way, 2027-07-15 | 1 | 10 / 32 |
| SEA–HNL | One way, 2027-07-15 | 2 | 10 / 45 |
| JFK–LGA | One way, 2026-10-10 | 1 | 0 / 0, explicit no_results |

Eight invalid-input cases were rejected without navigation. A controlled offline
search returned an explicit error in 70.7 seconds and recovered after reconnecting.
The outer request can time out before the invocation completes: inspect persistent
REPL state rather than automatically repeating an invocation with unknown outcome.
The closed-dialog retry branch did not recur during independent regression QA.

Migration verification: from `https://www.alaskaair.com/content/travel-info`, the
`alaskaair.com` registration returned SEA–SFO round-trip results in 17.7 seconds:
10 of 45 options, first fare USD 277, complete connecting flight numbers. The old
`airline_tools` registration was removed. The loaded definition matched the
repository source after normalizing indentation.

Local regression tests cover the expression contract, domain patterns, navigation
from arbitrary pages and existing searches, invalid inputs, and explicit failures:

```sh
node --test tests/alaskaair-search-flights.test.mjs
```
