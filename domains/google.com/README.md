# google.com

Tools for three separate Google products that share the `google.com` namespace: Google Flights (https://www.google.com/travel/flights), Google Finance (https://www.google.com/finance) and Google Maps (https://www.google.com/maps). They are kept apart by URL pattern, not by namespace (see [URL patterns](#url-patterns-finance-and-maps)). Google Search, Gmail, Calendar, Drive, Hotels and the other Google products have no tools here.

| tool | file | status | notes |
| --- | --- | --- | --- |
| search_flights | [search_flights.js](search_flights.js) | qa_passed | Outbound itineraries across all airlines from a `tfs` deep link; expands details for flight numbers and segments |
| get_stock_quote | [get_stock_quote.js](get_stock_quote.js) | draft | Finance quote and key statistics for a `TICKER:EXCHANGE` symbol from one same-origin request; page tool, never navigates |
| search_places | [search_places.js](search_places.js) | draft | Maps place search through the tab's own search box: up to 20 loaded results, no scrolling; page tool |
| get_place | [get_place.js](get_place.js) | draft | Maps place details for the open place or a place from the results the tab shows; page tool |

## Native WebMCP tools

None found. Checked 2026-09-29 with `webmcp.listTools()` on a fresh signed-out Kernel browser: the Google home page, web results, Finance home and quote pages, Maps home, search results and place pages, Travel Flights and Hotels, News search and Scholar results all listed no tools. `document.modelContext` exists with no registrations and `navigator.modelContext` is undefined, so the custom `google.com` namespace does not overlap with anything the sites register.

## Scope and loading

The rest of this section describes `search_flights` (CDP); the Finance and Maps page tools are described in [Finance and Maps tools](#finance-and-maps-tools). Every tool file is a single self-contained expression evaluating to a one-element tool-definition array. Register the **whole** `google.com` namespace together, because `forceOverwriteNamespace: true` replaces every tool already registered under it:

```js
const fs = await import("node:fs");
const names = ["get_place", "get_stock_quote", "search_flights", "search_places"];
const tools = names.flatMap(name => eval(fs.readFileSync(`domains/google.com/${name}.js`, "utf8")));
await webmcp.addCustomTools({ namespace: "google.com", tools, forceOverwriteNamespace: true });
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

`hl=en` pins English labels (the parser depends on them), `gl=US` pins the market, `curr` sets the display currency. Prices are read from the accessible label (`<amount> <currency name>`); `price.currencyLabel` carries that name and `price.currency` is the ISO code it maps to when the name is recognized. Google silently falls back to US dollars for codes it does not support, so a request for `XYZ` returns `currency: "USD"` plus a warning instead of mislabeled amounts; an unrecognized label keeps the requested code and warns that it is unverified. Labels are matched as Unicode letters (“Icelandic krónur”), and the 40-entry label map uses Google's own wording (“Brazilian reals”, “Turkish Lira”, “UAE dirhams”).

## Site quirks

- Google announces completion in an `aria-live` region: “N results returned.” or “No results returned, alternative suggestions found.” The tool waits for either (up to 60 s) instead of a fixed sleep, falls back to cards that stay stable for 8 s, then waits for network idle. The announced count is transient and sometimes lags the list, so `totalResults` is the number of visible cards on the page after expansion, not the announcement.
- The DOM contains hidden duplicate result lists; only visible `li.pIav2d` cards are read.
- Results are split into a “Top/Best (departing) flights” section and an “Other (departing) flights” section. The latter is collapsed behind a “View more flights” button when long; the tool clicks it only when more results are wanted than are visible, then returns cards in page order up to `maxResults`. `hasMore` is true when a collapsed set remains or the page holds more cards than were returned. Thin routes show a single “All flights” heading; every itinerary is then `section: "other"`.
- Flight numbers, aircraft, operators and per-segment times only exist inside each card's expandable details, so the tool clicks “Flight details” on every returned card (82 cards expanded in about 6 s). Google can re-render the list after a price refinement and replace expanded cards with collapsed ones, so expansion and parsing run in one page call with up to three re-expansion passes. A card whose panel still cannot be read keeps empty `flightNumbers`/`segments` with a warning; its `layovers` then come from the summary row.
- A card missing a core field (for example a “Price unavailable” card) is skipped and listed in `warnings`; only a page with no readable card at all is a `PARSE_ERROR`.
- Eastbound date-line crossings (GUM–HNL) arrive the calendar day before departure; `arrivalDayOffset` is -1 for those. The same route shows airport-change layovers (“Transfer from NRT to HND”), so each layover's `airport` is the preceding segment's arrival airport and the change itself is visible in `segments`.
- Round-trip prices are whole-trip totals for the shown outbound choice; return options require selecting an outbound flight and are not included. All prices are totals for the requested passengers, not per person.
- Overnight arrivals carry `+1` markers; `arrivalDate` is taken from the accessible arrival label and `arrivalDayOffset` is derived from it.
- Consent interstitial (`consent.google.com`): the tool clicks “Reject all” (or “Accept all”) and waits to return to Google Flights. This path is covered by local tests only; the US egress used for QA never triggered it.
- An automated-traffic challenge (`/sorry/`) is reported as `BLOCKED`; a Google error page as `SITE_ERROR`; a page that never announces results as `RESULTS_TIMEOUT`. None of these become empty successes.
- Internal waits share a 110-second budget; invoke with `timeoutSec: 120`.

## Finance and Maps tools

`get_stock_quote`, `search_places` and `get_place` are `kind: "page"` tools. Google Search, Hotels and every other Google product are outside their patterns.

### Execution kind

All three run in the document they are invoked in and never navigate it.

- **get_stock_quote** makes one same-origin `fetch` of `/finance/quote/<TICKER>:<EXCHANGE>?hl=en` and reads the quote page's own bootstrap data (`AF_initDataCallback` blocks) plus its key-statistics rows from the returned text. It does not parse the response as a DOM: Finance enforces Trusted Types, and `DOMParser` on fetched HTML throws there (it worked on Search, which this tool does not touch). The bootstrap array is positional and undocumented, so the tool accepts it only when the price, change and previous close reconcile with each other and the block names the requested ticker and exchange; otherwise it returns `site_changed` instead of numbers. Observed on a stock, an ETF and an index; the type code is mapped only for those three (`0` stock, `5` etf, `1` index), anything else is `other`.
- **search_places** and **get_place** drive and read the Maps single-page app. Maps' own search box accepts a programmatic value, input event and click on its Search button, changes the URL with the History API and re-renders the result list without replacing the document (a page-level marker survived the search and every place open in live checks), so no CDP is needed: no trusted input events, cross-origin frames or tab switching are involved. The cost is that the tab must already be on a Maps page; the tools are only registered there, and they return `wrong_page` on Maps pages without a search box (directions, for example).

### Scope and behavior

- `get_stock_quote` input: `symbol` as `TICKER:EXCHANGE` (`AAPL:NASDAQ`-style; a bare ticker is rejected because Finance cannot resolve it, and currency pairs and crypto pages are not supported). Output: price, change, percent change, previous close, quote time and time zone, currency (null for indices), the key-statistics rows as displayed, and `retrieved_at`. Quotes can be delayed by the exchange; compare `quote_time_utc` with `retrieved_at`.
- `search_places` input: `query` and `limit` (1-20, default 10). It returns the results Maps has loaded for that one query, in Maps' order, and does not scroll or page (8 were loaded in the live checks). Each place has `name`, `feature_id`, `place_id`, `place_url`, coordinates, category, street address, rating, review count, price range and the opening-status text. `single_place` (the query resolved to one place) and `no_results` are their own outcomes.
- `get_place` input: optional `place_url`. Without it, it reads the place open in the tab. With a `place_url` from `search_places` it selects that card in the results the tab is showing, waits until the URL, the pane's name and its address all belong to that place and stop changing, and reads the pane. Both the URL and the pane update, at slightly different moments, and the pane content updated first in live checks; reading before they agree would return the previous place under the new place's id. A place that is neither open nor in the tab's results returns `not_open` (the tool cannot navigate; open `place_url` in the tab and call again).
- `place_url` is `https://www.google.com/maps/place/<name>/data=!4m2!3m1!1s<feature id>`, rebuilt from the feature id only, without viewport, session or query state. It loaded the right place when opened in a fresh tab (author check, 2026-09-29).
- Reviews and their snippets, photos, popular times, menus, prices, sponsored panels, "people also search for" and account features are never returned.
- Both Maps tools require an English interface (`document.documentElement.lang` starting with `en`); they return `unsupported_language` otherwise. Open `https://www.google.com/maps?hl=en`.
- Registration: register the whole namespace at once (see Scope and loading). Use `timeoutSec: 60`; live calls took under 3 s.

### URL patterns (Finance and Maps)

The repository default (`https://google.com/*`, `https://*.google.com/*`) would attach these tools to every Google product, so their patterns are narrowed to one host and one product path (spec section 6.2):

```
get_stock_quote           https://www.google.com/finance/*
search_places, get_place  https://www.google.com/maps/*
```

`search_flights` keeps its existing `/travel/*` patterns on the apex and wildcard hosts. Verified 2026-09-29 on a fresh browser: the Maps tools are listed on Maps pages only, `get_stock_quote` on Finance pages only, and neither group is listed on the Google home page, web results, Flights, News or example.com. Regional Google domains (`google.co.uk`, ...) are separate registrable domains and are not covered.

### Access and terms

Read on 2026-09-29; these are facts about the pages, not legal advice.

- `https://www.google.com/robots.txt` (`User-agent: *` group) has no rule for `/finance`, and explicitly allows `/maps/search/`, `/maps/place/` and `/maps/dir/`, which are the Maps paths these tools use. The same file disallows `/search`, `/travel/search` and `/travel/flights/search`; these tools use none of those, and the disallowed Flights path is what the existing `search_flights` uses (unchanged here).
- The Google Terms of Service (effective 2026-07-30) prohibit "using automated means to access content from any of our services in violation of the machine-readable instructions on our web pages (for example, robots.txt files that disallow crawling...)". Nothing these tools read is disallowed for `User-agent: *`.
- The Google Maps Additional Terms (section 2, Prohibited Conduct) also forbid copying Maps content, mass download or bulk feeds, and building business-listing datasets. Hence the design limits: at most 20 places per call from the one result page Maps already shows, no scrolling or paging, no reviews or photos, user-directed calls, and tool descriptions that say so. Whether a bounded structured read of result cards for a user's question fits those terms is an interpretation the maintainers should confirm before this leaves draft; it is not settled by robots.txt.
- Signed in, Google may record searches and place views in the account's history as it does for any manual use. Live checks for these tools ran signed out.

### Site quirks

- Finance: a bare ticker or an unknown symbol returns the shell page titled only "Google Finance" with no quote data (`not_found`). Statistics rows appear twice in the page text; the tool keeps the first of each label. Values such as `P/E ratio` and `EPS` are Google's and can look odd for some share classes.
- Maps result cards: the name comes from the anchor's `aria-label`, the rating and review count from a `role="img"` label, and the category and street address from the `Category · … · Address` line. Class names are obfuscated and rotate; the tool uses them only where no attribute or role exists (`a.hfpxzc`, `button.DkEaL`), and reports `site_changed` when no card can be read as a place.
- Maps place pane: the pane is found from its `data-item-id="address"` row, because a plain `h1` can match the results heading. Weekly hours are read from the pane's table only when Maps renders it; some places show just a collapsed "See more hours" row that opens a separate Hours view, which the tool does not open, so `hours` is empty for them and `open_status_text` still gives today's status.
- A query that names one place opens it directly with no result list (`single_place`).

## Known limitations

- Outbound itineraries only. Round-trip return options need an outbound selection and are not returned.
- Searches run on `www.google.com` with `hl=en&gl=US`. Regional Google domains are outside this namespace.
- The consent interstitial, `/sorry/` blocks and "Price unavailable" cards are covered by local tests only.
- Children, infants, multi-city and flexible dates are not supported. The tool never selects, books or purchases.
- `get_stock_quote`: only `TICKER:EXCHANGE` stocks, ETFs and indices; no currency pairs, crypto, name lookup, extended-hours prices or news. The quote comes from an undocumented positional array in the page; a layout change is reported as `site_changed`. Consent pages (`consent_required`), `/sorry/` challenges and HTTP 429 are covered by fixture tests only.
- `search_places`: one query's first loaded results (8 in live checks), at most 20, no scrolling or paging; sponsored placements are not identified (none appeared in live checks); an English interface is required; the tab must already be on a Maps page with a search box. The Maps tab is left on the results. Category and address come from one text line and are null when the card does not have the usual shape.
- `get_place`: only places that are open or in the results the tab shows; `place_id` is null unless the open place's URL carries it (`search_places` returns it from the card); `hours` is empty for places whose pane shows only the collapsed hours row; no reviews, photos, popular times or menus.
- The Maps tools were checked live only on signed-out browsers with US egress. Signed-in behavior, other locales and regions, Maps dialogs shown to signed-in users, and non-US address formats are untested.

## QA summary

Author verification on 2026-09-25 (session `j3s22gi3hj37cbptlluo351a`, stealth, US residential proxy) registered the branch file after a SHA-256 check of the fetched source and invoked it through `webmcp.invokeTool`. The first two prices and times of each populated result were compared with the card labels on the page.

| Case | Result |
| --- | --- |
| CVG–SFO 2026-10-16 one way, 1 adult economy | ok, 25 of 159 returned in 13.5 s, flight numbers for every itinerary |
| CVG–SFO 2026-10-16 → 2026-10-23 round trip | ok, 25 of 99, round-trip totals, 3 best + 22 other |
| JFK–LAX 2026-10-20 one way, 3 adults business, maxResults 8 | ok, 8 of 37, “for 3 adults” pricing note, hasMore |
| JFK–LHR 2026-11-10 → 2026-11-17 round trip, GBP, maxResults 40 | ok, 40 of 64, `£555` round-trip totals labeled “British pounds”, mixed-carrier itineraries such as American / British Airways with per-segment operators |
| LUK–SFO 2026-10-16 one way | no_results with Google's alternative-suggestions message |
| Invalid inputs (bad IATA, past date, return before depart, 12 passengers) | rejected before navigation |
| Discovery from `google.com/`, `google.com/search`, `example.com`, `about:blank` | tool not listed (url_patterns), so it cannot be invoked there; listed again on `/travel/flights` and on `/travel/hotels` (which redirects to `/travel/search`) |

Google Search itself served an automated-traffic challenge (`/sorry/`) on this egress during the reachability check; Google Flights never did.

Independent QA (agent `agt_7ffe2dcdda2935caea70`, three rounds on 2026-09-25, each in a fresh stealth browser with the same proxy) hash-checked the registered source against the branch commit, invoked only through `webmcp.invokeTool` and the Kernel MCP invoke action, walked every output against the tool's `outputSchema`, and cross-checked the first two prices and times of every populated result against the page labels (20 of 20 matched in the final round). Round one found four defects that were fixed before round two: date-line arrivals (`arrivalDayOffset` -1) failed the whole search, detail panels were intermittently lost to a list re-render between expansion and parsing (17 of 40 empty `flightNumbers` once in five runs), `totalResults` echoed a stale announcement, and `price.currency` echoed the request even when Google fell back to US dollars. Round two found a non-ASCII currency label (`Icelandic krónur`) that failed the price regex, three label-map keys that did not match Google's wording, and a 30-second stall on cards without a readable panel; all were fixed before round three.

| Independent QA case (final round, commit `59a8da7`) | Result | Time |
| --- | --- | ---: |
| JFK–LAX 2026-10-20 one way, ISK, maxResults 3 | ok, `ISK 24,487`, label “Icelandic krónur”, flight numbers present | 14.3 s |
| Same in TRY, BRL, AED | ok, currency equals the request, no warnings | 12.4–12.9 s |
| CVG–SFO 2026-10-16 one way | ok, 25 of 155, 3 best + 22 other | 17.3 s |
| JFK–LHR 2026-11-10 → 2026-11-17 round trip, USD, maxResults 40, two fresh runs | ok, 40 of 64, 0 empty flight numbers, 0 stop/layover mismatches | 18.0–18.4 s |
| GUM–HNL 2026-10-20 one way | ok, UA 200 with offset -1; JAL/Alaska one-stops with NRT layover and NRT→HND airport change in segments | 12.8 s |
| LUK–SFO 2026-10-16 one way | no_results | 1.6 s |
| CVG–SFO one way, maxResults 100 | ok, 100 of 155, all panels read | 29.6 s |

Earlier rounds also passed the round-trip domestic, 3-adult business, 2-adult premium economy, first-class, GBP, invalid-input and reachability cases (see the author table above for the shapes). Known minor points left as designed: a skipped unreadable card still counts toward `maxResults`, and `resultsUrl` can differ from the final tab URL if Google rewrites it again after the read.

Run the local tests from the repository root:

```sh
node --test tests/google-flights-search.test.mjs
```

They use a small fake DOM built from the observed Google Flights markup and stubbed browser helpers to cover the deep-link encoding, entry navigation from unrelated pages, tab switching, consent handling, blocked/timeout/no-results states, section and segment parsing, “View more flights” expansion and `maxResults` capping, and output-schema conformance. They do not replace live QA.

### Finance and Maps page tools: author verification

Author checks on 2026-09-29 in fresh signed-out stealth Kernel browsers (US egress), registering the whole `google.com` namespace from the branch files and invoking through `webmcp.invokeTool`. These tools have had no independent QA yet, so they stay `draft`. `search_flights` was registered but not invoked.

| Case | Result |
| --- | --- |
| Discovery on Maps, Finance, Flights, the Google home page, example.com and News | Maps tools on Maps only, `get_stock_quote` on Finance only, `search_flights` on Flights only, nothing elsewhere |
| `get_stock_quote` for a stock, an ETF and an index | ok in 0.3-0.5 s; type mapped to stock, etf, index; the index has no currency; 5-16 statistics rows |
| `get_stock_quote` unknown symbol, bare ticker, extra field | `not_found`; `invalid_input` and `invalid_input` with no request made |
| `search_places` two multi-result queries, limit 2-20 | ok in about 2 s; 8 cards loaded; a page-level marker survived, so the document was not replaced |
| `search_places` nonsense query, one-landmark query, repeated query | `no_results`; `single_place`; ok |
| `search_places` malformed input (nine shapes) | `invalid_input` in under 15 ms, search box untouched |
| `search_places` and `get_place` on a directions page and with `hl=fr` | `wrong_page` and `not_open`; `unsupported_language` |
| `get_place` with each of 16 `place_url`s from two searches (all names distinct) | 16 of 16 matched the requested feature id and address; 14 returned weekly hours, 2 showed only the collapsed hours row and returned none |
| `place_url` opened in a fresh tab, then `get_place` with no input | same place, identical `place_url` (2 of 2) |

Fixture tests (`tests/google-finance-quote.test.mjs`, `tests/google-maps-places.test.mjs`, helper `tests/google-support.mjs`) cover the outcomes above plus consent, challenge, rate-limit and timeout paths, hostile text in names, and the pane/URL agreement guards in `get_place`, including two same-name places at different addresses and both update orders (checked by mutation: removing each guard fails a test). Same-name places were not re-checked live. Not verified: signed-in behavior, non-US egress, sponsored Maps placements, the Chrome extension runtime, and any account feature.

Intermittent scratch-browser note: twice a scratch tab stopped responding right after a Maps page loaded with `hl=fr`; a controlled rerun with the same steps did not reproduce it, and the tools do nothing on that page beyond the language check.

## Sessions

- Author verification browser: `j3s22gi3hj37cbptlluo351a` (deleted after verification).
- Independent QA browsers: `m0i2vxdeph6kw0l3b5xegyr1`, `hhrgvj03yt8efdl2wr59nkgu`, `msdeh31j82v60yslgp6vaflz` (deleted after each round).
- Independent QA agent: `agt_7ffe2dcdda2935caea70`.
- Source: this repository is canonical; sessions expire but files do not.
- Finance and Maps author verification browsers, 2026-09-29 (all deleted after use): `jgcwk0hsgrtdhhqzzf21rknz`, `qsew0vaytkfkr3x68ei0813q`, `nsu3cbbf1n5jajyc1m6rd76w`, `b3lg8dn63zduxdf16en10tg0`.
