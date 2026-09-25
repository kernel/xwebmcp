# google.com

Tools for Google Flights (https://www.google.com/travel/flights).

| tool | file | status | notes |
| --- | --- | --- | --- |
| search_flights | [search_flights.js](search_flights.js) | qa_passed | Outbound itineraries across all airlines from a `tfs` deep link; expands details for flight numbers and segments |

## Scope and loading

`search_flights.js` is a single self-contained expression evaluating to a CDP tool-definition array. Register it with namespace `google.com`:

```js
const source = (await import("node:fs")).readFileSync("domains/google.com/search_flights.js", "utf8");
await webmcp.addCustomTools({ namespace: "google.com", tools: eval(source), forceOverwriteNamespace: true });
const tool = (await webmcp.listTools()).find(t =>
  t.source.custom?.namespace === "google.com" && t.tool.name === "search_flights"
);
const result = await webmcp.invokeTool(tool.tool_ref, {
  origin: "CVG",
  destination: "SFO",
  departDate: "2026-10-16",
  returnDate: "2026-10-23",
  tripType: "round_trip",
  passengers: 1,
  cabin: "economy",
  currency: "USD",
  maxResults: 25
}, { timeoutSec: 120 });
repl.write(JSON.stringify(result));
```

Use current future dates when running the example. Inputs: distinct uppercase IATA airports, ISO dates today or later, `one_way` or `round_trip` (a return date is required for round trips and rejected for one-way), 1–9 adults (default 1), `economy` / `premium_economy` / `business` / `first` (default economy), an ISO currency code (default USD), and `maxResults` 1–100 (default 25). Children, infants, multi-city, and flexible dates are not supported. The tool never selects, books or purchases.

The common input and output core matches the airline `search_flights` tools: `origin`, `destination`, `departDate`, `returnDate`, `tripType`, `passengers` in; `status`, `resultsUrl`, `resultCount`, `flights[]` with `airline`, `flightNumbers`, `departureAirport`, `arrivalAirport`, `departureDate`, `departureTime`, `arrivalDate`, `arrivalTime`, `arrivalDayOffset`, `durationMinutes`, `stops`, `price.amount` and `price.currency` out. Google-specific additions: `cabin`, `currency`, `maxResults` inputs; `section` (`best` versus `other`), `airlines`, `partnerAirlines`, `operatedBy`, `layovers`, `emissionsKgCo2e`, `emissionsVsTypicalPercent`, `segments`, `totalResults`, `hasMore`, `priceInsight`, `pricingNote` and `warnings` outputs.

## url_pattern exception

The repository convention is apex plus wildcard subdomains (`https://google.com/*`, `https://*.google.com/*`). For google.com that would attach the tool to Google Search, Gmail, Maps, Docs and every other Google product tab, so this tool deliberately narrows the path:

```
https://google.com/travel/*
https://*.google.com/travel/*
```

`/travel/*` covers the Google Flights entry page (`/travel/flights`), result pages (`/travel/flights/search`), and the other Google Travel surfaces (hotels, explore) an agent may be on while planning a trip. The CDP runtime matches the pattern against the tab's current URL at discovery and invocation time, so the tool is **not** listed and cannot be invoked while the tab is on `google.com/search`, `about:blank`, or another site. Navigate the tab to `https://www.google.com/travel/flights?hl=en` first. Regional hosts such as `google.co.uk` are separate registrable domains and are outside this namespace; the tool always searches on `www.google.com` with `hl=en&gl=US`, so it works from a regional tab only if that tab is on a `*.google.com/travel/*` URL.

## Entry approach: `tfs` deep link, not the form

Google Flights encodes a search in the `tfs` query parameter, a base64url protobuf. The tool encodes it directly (legs with date and airport codes, one adult entry per passenger, seat class, trip type) and navigates to `https://www.google.com/travel/flights/search?tfs=…&hl=en&gl=US&curr=<currency>`. This was chosen over the natural-language `q=` deep link, which fell through to the Google Flights home page without results during development, and over driving the form, which involves autocomplete and calendar widgets. Google rewrites the URL to its canonical form after load; `resultsUrl` reports the rewritten URL. Passenger count, cabin, trip type and currency were confirmed live from the page header and the “Prices include required taxes + fees for N adults” note.

`hl=en` pins English labels (the parser depends on them), `gl=US` pins the market, `curr` sets the display currency. Prices are read from the accessible label (`<amount> <currency name>`); when the label's currency name does not match the requested code for a known currency, a warning is added rather than silently reporting the wrong currency.

## Site quirks

- Google announces completion in an `aria-live` region: “N results returned.” or “No results returned, alternative suggestions found.” The tool waits for either (up to 60 s) instead of a fixed sleep; if neither appears but cards render and stay stable for 4 s it proceeds with a warning.
- The DOM contains hidden duplicate result lists; only visible `li.pIav2d` cards are read.
- Results are split into a “Top/Best (departing) flights” section and an “Other (departing) flights” section. The latter is collapsed behind a “View more flights” button when long; the tool clicks it only when more results are wanted than are visible, then returns cards in page order up to `maxResults`. `totalResults` is Google's announced count after expansion and `hasMore` is true when more remained.
- Flight numbers, aircraft, operators and per-segment times only exist inside each card's expandable details, so the tool clicks “Flight details” on every returned card (82 cards expanded in about 6 s). A card that fails to expand keeps empty `flightNumbers`/`segments` with a warning.
- Round-trip prices are whole-trip totals for the shown outbound choice; return options require selecting an outbound flight and are not included. All prices are totals for the requested passengers, not per person.
- Overnight arrivals carry `+1` markers; `arrivalDate` is taken from the accessible arrival label and `arrivalDayOffset` is derived from it.
- Consent interstitial (`consent.google.com`): the tool clicks “Reject all” (or “Accept all”) and waits to return to Google Flights. This path is covered by local tests only; the US egress used for QA never triggered it.
- An automated-traffic challenge (`/sorry/`) is reported as `BLOCKED`; a Google error page as `SITE_ERROR`; a page that never announces results as `RESULTS_TIMEOUT`. None of these become empty successes.
- Internal waits share a 110-second budget; invoke with `timeoutSec: 120`.

## QA summary

Author verification on 2026-09-25 (session `j3s22gi3hj37cbptlluo351a`, stealth, `cincy` proxy) registered the branch file after a SHA-256 check of the fetched source and invoked it through `webmcp.invokeTool`. The first two prices and times of each populated result were compared with the card labels on the page.

| Case | Result |
| --- | --- |
| CVG–SFO 2026-10-16 one way, 1 adult economy | ok, 25 of 159 returned in 13.5 s, flight numbers for every itinerary |
| CVG–SFO 2026-10-16 → 2026-10-23 round trip | ok, 25 of 99, round-trip totals, 3 best + 22 other |
| JFK–LAX 2026-10-20 one way, 3 adults business, maxResults 8 | ok, 8 of 37, “for 3 adults” pricing note, hasMore |
| JFK–LHR 2026-11-10 → 2026-11-17 round trip, GBP | see independent QA table below |
| LUK–SFO 2026-10-16 one way | no_results with Google's alternative-suggestions message |
| Invalid inputs (bad IATA, past date, return before depart, 12 passengers) | rejected before navigation |
| Invocation from google.com search page, about:blank, another site | tool not listed (url_patterns); listed again on `/travel/*` |

Independent QA: see the registry entry and the table appended below.

Run the local tests from the repository root:

```sh
node --test tests/google-flights-search.test.mjs
```

They use a small fake DOM built from the observed Google Flights markup and stubbed browser helpers to cover the deep-link encoding, entry navigation from unrelated pages, tab switching, consent handling, blocked/timeout/no-results states, section and segment parsing, “View more flights” expansion and `maxResults` capping, and output-schema conformance. They do not replace live QA.

## Sessions

- Author verification browser: `j3s22gi3hj37cbptlluo351a` (24-hour inactivity timeout).
- Source: this repository is canonical; sessions expire but files do not.
