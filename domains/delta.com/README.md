# delta.com

Tools for Delta Air Lines (https://www.delta.com).

| tool | file | status | notes |
| --- | --- | --- | --- |
| get_flight_status | [get_flight_status.js](get_flight_status.js) | verified | Public, read-only status lookup for one Delta flight number and date from any www.delta.com page (`page` kind, no navigation). Returns every leg and checks optional origin/destination against them. Independently QA'd and live-verified in Kernel browsers on 2026-09-29; Delta's bot protection makes it unreliable without a warm session. Extension success path untested. |
| get_page_context | [get_page_context.js](get_page_context.js) | draft | Read-only page summary with live tool names and suggested next steps. Unit-tested; exercised live on the homepage and booking form. |
| list_flight_deals | [list_flight_deals.js](list_flight_deals.js) | draft | Read visible advertised cash/SkyMiles deals, with route/pricing filters and bounded pagination. No inventory/quote guarantee. |
| prepare_itinerary | [prepare_itinerary.js](prepare_itinerary.js) | draft | Recheck one visible advertised deal and exact price, then return a public search-form handoff only. No navigation, holds, booking or redemption. |
| search_flight_status | [search_flight_status.js](search_flight_status.js) | draft | First 30 Delta-marketed route schedules/statuses; validates route, date and connected legs. Not seat/fare availability. |
| search_flights | [search_flights.js](search_flights.js) | draft | Cash-fare search with bounded airport-render wait and output, canonical results URL. Current revision requires fresh QA; full success unverified. |
| login | [login.js](login.js) | draft | Homepage-only page tool: opens the top-nav Log in flyout, fills it, and schedules one submit. No output schema; outcome not observed. Live-checked with fabricated credentials and the submit click blocked in-page; no real submission. |
| navigate_to_page | [navigate_to_page.js](navigate_to_page.js) | draft | Schedules a same-tab navigation to a www.delta.com path; description carries a basic site map. Unit-tested; exercised live. |

## Scope

- Namespace: `delta.com`. Default match patterns: `https://delta.com/*` and `https://*.delta.com/*`; `login`, the status tools, fare shopping and advertised-deal tools are narrowed (see URL patterns).
- CDP-backed, read-only flight shopping for one-way and round-trip cash fares, 1–9 adults, within a 330-day booking window. No fare selection, purchases, payments, or personal-data entry.
- On invocation, check for an idle, usable booking form at the exact entry URL. Otherwise navigate to `https://www.delta.com/flightsearch/book-a-flight` before interacting. An unrelated page, a baggage page, results, query-bearing booking state, or an open form overlay does not satisfy this check.
- Return structured first-page outbound options: marketing airline and flight numbers, airports, local times, displayed overnight-arrival date, duration, stops, and lowest available displayed fare per row. Round trips do not return selected outbound/return pairs. Prices are rounded display fares, not passenger totals or guaranteed quotes; the currency symbol is preserved without guessing its ISO code.
- `get_flight_status` is separate from flight shopping: a public, read-only status lookup by flight number and date. It never selects a fare, opens a trip, or touches the account (see the `get_flight_status` section).
- `result_count` counts returned rows, not every matching flight. Failures return `status: "error"`, `flights: []`, and `result_count: null`. An explicit empty state is distinguished from a site error. Input-schema rejections may occur before execution and therefore have no tool output.

## Loading

The tool file is a single self-contained expression evaluating to an array. It has no registration side effects or imports. Read its contents as `source`, then register in the Browser REPL:

```js
await webmcp.addCustomTools({
  namespace: "delta.com",
  forceOverwriteNamespace: true,
  tools: eval(source),
});
const live = (await webmcp.listTools()).find(
  (t) => t.source.custom?.namespace === "delta.com" &&
    t.tool.name === "search_flights",
);
const result = await webmcp.invokeTool(live.tool_ref, {
  origin: "JFK",
  destination: "LHR",
  depart_date: "2026-11-10",
  return_date: "2026-11-18",
  trip_type: "round_trip",
  passengers: 2,
}, { timeoutSec: 120 });
repl.write(JSON.stringify(result));
```

Use future dates within the booking window and obtain a fresh tool reference after navigation. Only evaluate trusted source. Replacing the namespace replaces all its custom tools.

## Site quirks

- Airport codes must be selected from the airport picker; typing a code alone does not select an airport. Dates use a month calendar, and trip type/passenger count use comboboxes.
- Results render client-side at `/flightsearch/search-results?cacheKeySuffix=...`. The corresponding search context stores a round trip in one segment with both `departureDate` and `returnDate`.
- Desktop flight paths differ from mobile test-ID markup. Partner-marketed flight links use an analytics attribute, and an empty badge-only header can precede the actual duration. Hidden rows and fare cells must be excluded.
- Wait for skeleton removal and populated fares, then 1,500 ms of unchanged result DOM. This is a resettable DOM-quiescence check, not proof of completion if another row arrives after a longer silent interval. The execution uses a 105-second wait budget within a 120-second invocation timeout.
- Delta intermittently responds with HTTP 429 and redirects to the booking page with `SFAF001_429` or `SFAF001`. Do not interpret that as zero available flights or retry repeatedly. The current parser targets the English desktop layout. Real zero-results behavior remains unverified.

## Airport entry fix (2026-09-29)

In regular Chrome on macOS, the origin box opened prefilled with the geolocated `CVG`, the tool's
click left the caret inside it, and the extension's `fillInput` clear (Meta+A, Backspace) did
nothing useful: macOS Chrome does not run editing shortcuts for synthetic CDP key events unless
the event carries `commands: ["selectAll"]`. Backspace removed one character and typing `CVG`
produced `CVCVG`, so no airport option matched. Kernel browsers (Linux, Ctrl+A) were unaffected.

The first fix cleared the box through the page and called `typeInto` with `clear: false`. That
workaround is gone: the inlined `lib/input.js` `typeInto` now clears correctly on every platform
(Control held around an `a` rawKeyDown carrying `commands: ["selectAll"]`, then Backspace, then a
read-back of the focused field with a page-side select fallback; it throws rather than typing on
top of leftover text). The tool pauses briefly, calls `typeInto(n, code)` with its default clear,
and still checks the box holds exactly the code before choosing an option; otherwise it returns
`INPUT_MISMATCH` without choosing. Unit tests: `tests/delta-search-flights.test.mjs` and
`tests/input-helper.test.mjs`. The extension's `fillInput` was also fixed to send
`commands: ["selectAll"]` on macOS.

Live, 2026-09-29, regular Chrome 154 on macOS, xwebmcp extension, signed out: CVG→SFO one way,
2026-09-30, 1 adult returned `status: "ok"` with first-page flights (for example DL 393/DL 1715,
7:00 AM–10:53 AM, 1 stop, $399 Delta Main) in about 11 seconds, with no SFAF error. This is the
first successful full live invocation of this tool; it is one case, not a QA pass.

Inlined snippet changed (2026-09-29, same day): after the `typeInto` clear change above, the new
clear sequence was run by hand over CDP on Delta's prefilled origin box (caret inside `CVG`): the
`selectAll` command selected 0–3 and Backspace left the box empty. One invocation of the updated
tool (CVG→SFO one way, three weeks out, 1 adult) returned `status: "ok"` with flights. The tool
stays `draft`; this is not fresh independent QA.

## QA summary

The independent QA below covered the source before the airport entry fix and subsequent bounded-wait changes; it no longer signs off the current file.


Independent QA agent: `agt_b189571b6d300a05921c`, three passes on 2026-09-24. No actionable defect reproduced in the final targeted regression cases of that earlier source.

| Check | Evidence |
| --- | --- |
| Short-haul CVG–ATL round trip / one way, one passenger | Live attempts reached a readiness timeout or provider error; successful output blocked. |
| Long-haul JFK–LHR round trip, two passengers | Parser separately extracted 20 real rendered first-page rows, including connections, overnight dates, and prices. Full final invocations received provider 429 errors. The DOM parse is not an end-to-end invocation success. |
| Far-future LAX–JFK one way, three passengers | Calendar/form flow reached a provider 429; successful output blocked. |
| Zero-results candidate ATL–IPC | Picker accepted IPC; provider error prevented checking real empty-result behavior. |
| Eleven invalid-input cases | All rejected; none reported zero results. |
| Synthetic parser/schema regression | Passed explicit schema checks; excluded hidden rows/fares, handled duplicate empty duration, desktop fields, partner numbers, connections, overnight dates, and rejected mismatched date/passenger context. Synthetic prices are not live fares. |
| Synthetic incremental rendering | Second row at 50 ms and its fare at 300 ms: readiness returned both populated rows after 1,805 ms. |
| Synthetic empty state / unfinished fare | Empty state passed after skeleton removal; unfinished fare reached the shortened test timeout. |

### Domain-convention migration check

On 2026-09-24, re-registered under `delta.com`, removed the old `airline_tools.search_flights` registration, and invoked from `https://www.delta.com/us/en/baggage/overview` rather than the homepage or booking form. The tool navigated to booking, submitted JFK–LHR for 2026-11-10 through 2026-11-18 with two adults, and reached a results URL. After 21.735 seconds, it returned the unchanged explicit error shape with `SITE_ERROR: ... #SFAF001_429`, no flights, and a null count. This verifies entry navigation and failure behavior, not successful flight retrieval.

Local checks also evaluate the file as one array expression, compare both schemas with the previously QA-tested source, and exercise navigation from unsuitable pages versus reuse of a clean booking form.

## Known limitations

- `search_flights` is `draft` because its source changed after QA. Earlier-source live invocations succeeded on 2026-09-29; current-source success remains unverified. Delta's HTTP 444/429 and `SFAF` responses can block searches.
- The new route tool covers the first 30 Delta-marketed schedules only. Deals/preparation cover current visible advertised English-page offers, not calendar inventory or guaranteed quotes; no account/trip mutations or confirmed execution are supported. See the expanded-subset section for evidence and omitted capabilities.
- First results page only; round trips return outbound options, not outbound/return pairs. Prices are rounded display fares, not passenger totals.
- Adults only (1–9), 330-day booking window, English desktop layout only.
- Completeness beyond the 1.5-second DOM-quiescence heuristic and real zero-results behaviour remain unverified.
- `get_flight_status` is `verified` for the Kernel runtime only. Delta's bot protection returns HTTP 444 (reported as `blocked`) to cold sessions and to a session after six to ten lookups (it varied), and the block persisted for minutes in every case tried; a `blocked` result says nothing about the flight. Its success path has not been observed in the xwebmcp Chrome extension (Delta denied that browser). It covers Delta-marketed flight numbers only, reads Delta's response as-is (no cancelled, diverted, or partner-operated example has been observed), and does not cover flights by route, fares, seats, trips, credits, check-in, or notifications.
- `login` is `draft` and homepage-only. It never reports the outcome (no output schema): a successful login, a wrong-password message, an MFA step, and a captcha are all unobserved by the tool and unverified live. It has not submitted real or fabricated credentials to Delta; the only live run blocked the click in-page.
- `get_page_context` is `draft`. `signed_in: true` relies on a visible "Log out"/"Sign out" header control and has not been observed on a signed-in page; it may report `null` there. `page_type` is path-based and `page_messages` is a best-effort scan of alert-like elements.
- `navigate_to_page` is `draft`. It only accepts www.delta.com paths and reports that navigation was scheduled, not that the page loaded. The site map in its description is a starting list, not exhaustive.
- Newly installed page tools were not registered on an already-open tab until it reloaded (extension behaviour, seen 2026-09-29); tabs opened afterwards registered them immediately.

## login

`login` is a `kind: "page"` tool registered **only on the homepage** (`https://www.delta.com/`
and `/us/en`, with or without a query string). On invoke it:

1. checks it is on the homepage and that the top-nav `#login-trigger` ("Log in") is visible;
2. clicks it and waits up to 15 s for the `#login-modal-popup` flyout with `#userId-input` and
   `#password-input`;
3. sets both values with the native input setter plus `input`/`change`/`blur` events (Delta's
   Angular form marks both `ng-dirty ng-valid`), then checks they stuck;
4. returns a plain-text acknowledgment and, 100 ms after settling, clicks the flyout's
   `Log In` button once (cdp-tools.md §2.2: a successful sign-in may reload the document).

It has **no output schema** and does not observe the result: the caller must check the page
(for example with `get_page_context`) before doing anything else, and must not call `login`
again blindly. Failures before submission throw a message prefixed with `invalid_input`,
`wrong_page`, `login_button_missing`, `login_form_not_ready`, `fill_failed`,
`submit_button_missing`, or `submit_disabled`; none of them types into a submitted form.

The previous CDP version entered through a DuckDuckGo search result; that path was removed.
Its live history (Delta answering "login is unavailable right now" to Kernel browsers) is in
git history and is no longer evidence about this tool.

### QA (login)

Draft. Unit tests cover the success path (one scheduled submit, no submit before settling,
password never in the output), reuse of an already-open flyout, and seven failure paths.
Live on 2026-09-29 in a regular Chrome 154 profile via the xwebmcp extension, homepage signed
out: with a capture-phase guard blocking the submit button in-page, the tool opened the flyout,
filled fabricated `QA000000` / a fake password, returned its acknowledgment, and fired exactly
one submit click, which the guard blocked. The fields were then cleared and the flyout closed.
No credentials, real or fabricated, reached Delta.

## navigate_to_page

`kind: "page"`, all Delta pages. Accepts a path beginning with a single `/` (optionally with a
query), resolves it against `https://www.delta.com`, returns
`{status: "navigation_scheduled", from_url, to_url, next_step}`, and calls `location.assign`
100 ms after settling. Anything else returns `{status: "error", error_message}` and does not
navigate. The description lists a basic site map (homepage, booking form, results, My Trips,
flight status, SkyMiles, baggage, check-in, changes, deals, help) with the tools each page
exposes. Every listed path returned HTTP 200 on 2026-09-29 (`/mytrips/` redirects to
`/my-trips/search`).

Live 2026-09-29: `/` → `/flightsearch/book-a-flight` → `/` in an extension-owned tab;
`login` disappeared on the booking form and reappeared on the homepage. `//evil.example/`
returned the error branch without navigating.

## get_page_context

`kind: "page"`, all Delta pages, read-only. Returns `current_url`, `current_path`, `page_title`,
`page_type` (`home`, `booking_form`, `flight_results`, `login`, `my_trips`, `flight_status`,
`skymiles`, `info`, `other`), `available_tools` (tool names from
`document.modelContext.getTools()`, or `null`), `signed_in` (`false` when the top-nav Log in
button is visible, `true` when a Log out/Sign out control is, otherwise `null`),
`login_flyout_open`, `page_messages` (visible alert text and any `SFAF…` error code), and
`suggested_next_steps` tailored to the page, sign-in state, and available tools.

Live 2026-09-29: on the signed-out homepage it returned `page_type: "home"`, all four tools,
`signed_in: false`, and a login suggestion; with the flyout open after the guarded login run it
returned `login_flyout_open: true` and the "never resubmit blindly" step first; on the booking
form it returned `booking_form` without `login` and suggested going home to sign in.

## get_flight_status

`kind: "page"`, registered on `https://www.delta.com/*`, public, read-only. Input: `flight_number`
(1-4 digits, optional `DL` prefix, leading zeros ignored), `date` (`YYYY-MM-DD`, a real calendar
date), and optional `origin` / `destination` (IATA codes). Output on success: `flight_number`,
`departure_date`, `leg_count`, `leg_selection` (`all_legs` or `filtered`), `legs[]`, and a `note`.
Each leg has Delta's status text, `delay`, `cancellation_reason_code`, block `duration_minutes`,
`distance_miles`, `aircraft`, `operating_carrier` (only when Delta names one), `codeshare`, and
`departure` / `arrival` events with airport code, name, city, terminal, gate, baggage claim,
punctuality text, and airport-local scheduled / estimated / actual times (ISO 8601 with offset).
Anything else in Delta's response (tail number, UTC timestamps, coordinates, flight positions) is
dropped by an allowlist, and every string is stripped of control characters and truncated.

Failures are explicit `status: "error"` results with `error_kind`: `invalid_input` (checked before
any request), `flight_not_found`, `route_not_found`, `blocked`, `rate_limited`, `site_error`,
`unexpected_response`, `network_error`. None is ever an empty success, and the tool makes exactly one
request per call and never retries.

### Why `page`, and what it sends

Observed 2026-09-29 by instrumenting the site's own flight-status form in Kernel browsers: the
form's lookup is one `POST https://flightinformation-api.delta.com/flight-status/details` made by the
page, with body `{"flightNumber", "airlineCode": "DL", "departureDate", "legDepartureDate": "",
"originAirportCode": ""}`, credentials included, and the headers `appId: WEB`, `channelId: DCOM`,
`purchasePath: FLIGHTSTATUS` plus JSON content type. The tool sends that same request from the
current `www.delta.com` document. The lookup and its result live in one document, so nothing
navigates and `page` applies (cdp-tools.md section 2.1); no `cdp` helper is needed. Live, the
registering document and URL were unchanged after each invocation.

The results page `/flightstatus/{leg}/{flight}/{date}` was deliberately not used as the mechanism.
Loading it cold in a fresh Kernel browser made the page's own request return HTTP 444 and render
"flight details were not found", which looks like a missing flight but is the bot block below; the
leg number in that URL is also not a reliable index (a third leg number showed the first leg again).

### Multi-leg flight numbers

Delta returns every leg of a flight number in one response (`datedOperatingLegs`); the site itself
shows a "Two Routes Found" picker for such flights. The tool returns all legs by default with a
`note` that says so. With `origin` and/or `destination` it keeps only matching legs and reports
`leg_count` as Delta's count before filtering. If nothing matches it returns `route_not_found` with
`available_routes` (`AAA-BBB` pairs Delta returned) and never substitutes another leg. It also
discards a response whose flight number or origin departure date differs from the request.

### Bot protection and locale limits

- Delta's bot protection denies this endpoint (HTTP 444, an "Access Denied" HTML body) to cold
  sessions: a fresh Kernel browser's first direct lookup, and the site's own page request on a cold
  deep link, both returned 444. After the site's own flight-status form had been used normally,
  lookups succeeded for six to ten calls in a row (it varied by session) and then returned 444 again, and once
  blocked, a session stayed blocked for at least several minutes (25 minutes in one browser) with
  the site's own form failing too ("An unexpected error occurred"). The tool reports this as
  `blocked`, never retries, and its message tells the caller not to loop. Normal use of the site in a
  warm session is the only thing observed to help; the tool does not try to work around the
  protection.
- Some egress (seen from France and Canada) gets a "Welcome to Delta" location and language dialog.
  The tool never clicks it and never changes the location setting. Whether that dialog changes the
  lookup's outcome was not established: the Canada-egress browser that showed it was already denied
  by the bot protection, and the France-egress one was moved to US egress before any lookup.
- Delta returns `flight_not_found` (HTTP 400, code `FLD2300`) when it has no flight for the number and
  date. Observed 2026-09-29: an unknown number (9999), one real number on a day it did not run
  (DL2910 on the previous day, though the same number returned data three days earlier), and a real
  number on a date about ten months out. The previous day was not rejected for every number: the
  reviewer got data for it for another flight. The date window Delta serves was not measured, so
  `flight_not_found` should be read as "no match for this number and date", not as "wrong date".
- Delta's response can carry a delayed status with a null `delay` (the reviewer saw an arrival
  event with status "Delayed" and no delay duration); the tool passes Delta's fields through and
  does not derive a delay.
- Each lookup updates Delta's own bot-management cookies (`_abck`, `bm_sv`, `bm_sz`), the same as
  the site's own lookup does. The tool reads and writes no cookies or storage itself.

### QA (get_flight_status)

Independent QA agent `agt_18586dcff5a8cb64565a`, 2026-09-29 (about 21:18-21:40 UTC), reviewed head
`5b3f8950c472b0cf19a2c5394262da58804ac032` and signed off **PASS** for it (no blocker or major
defect; three minor findings, fixed afterwards and re-checked). The tool source has not changed
since that review.

`tests/delta-flight-status.test.mjs` uses fabricated data and a stubbed `fetch`: the exact request
(also with a route filter), schema conformance of every branch, all-legs / filtered /
`route_not_found`, flight-number normalization, 19 invalid inputs rejected with no request, every
site outcome above with one request and no retry, 444/403 without an "Access Denied" body, timeout
value and caller abort, sanitization, that the serialized `execute` runs with no outer scope, and
that the document and location are never read. The reviewer mutation-tested the suite (44 mutants,
36 killed at review time); the five survivors that were real gaps are now covered and killed.

Reviewer checks, all against the source or live: strict Ajv compile of both schemas; 30,000 hostile
responses with no schema violation and no throw; the tool's request is identical on the wire to the
site's own form request (method, URL, header names and values, body, credentials, preflight); the
whole `delta.com` namespace registered atomically (5 tools, no other tool invoked); the tool is
listed on `/us/en/baggage/overview`, the homepage, `/flightstatus/search`, the results page, and the
schedule page, and not on `shop.delta.com` (its 11 native tools unaffected, no collision); an old
`tool_ref` is refused after navigation.

Live cases, 2026-09-29, Kernel browsers, warmed with the site's own form (calls made from the pages
named, none of them an entry point for this tool):
- DL2910 with no route, from `/us/en/baggage/overview`: two legs and the multi-leg note, 2260 B, about
  1.1 s. With `origin: IND`, `destination: MSP` (from the flight-status results page): one leg,
  `leg_count: 2`, `leg_selection: filtered`.
- A single-leg flight (DL0404 on the next day): one leg.
- `origin: JFK` on DL2910: `route_not_found` with `available_routes`. Number 9999: `flight_not_found`
  (`FLD2300`, HTTP 400).
- 24 malformed inputs: `invalid_input` and zero requests to Delta (counted through fetch, XHR and
  resource timing).
- A cold browser: `blocked` (HTTP 444), exactly one fetch. A warmed browser at its tenth lookup:
  `blocked`, one fetch, no retry.
- Per invocation the document, URL, dialog state, and focus were unchanged, and exactly one fetch
  went to `flightinformation-api.delta.com` (plus the browser's CORS preflight, which the site's own
  form also triggers). With Delta's location dialog open (Canada egress) it was
  identical before and after a lookup.

Local Chrome extension (Chromium 153, throwaway profile, extension loaded unpacked, site access
granted through its own prompt): the namespace registered, `get_flight_status` was listed on
`www.delta.com/flightstatus/search` and `login` was not (homepage-only), 10 malformed inputs returned
`invalid_input` with no requests, and one real invocation returned `blocked` after exactly one
request with the document unchanged. The extension success path was **not** observed: Delta denied
that local browser, including its own form. Native messaging, the `xwebmcp attach` path, and the
CSP fallback for page tools were not exercised. No extension parity beyond the above is claimed.

Not observed anywhere: HTTP 429, a `site_error`, an `unexpected_response`, a `network_error`, or a
caller abort against the live site (fixtures only); a cancelled, diverted, or partner-operated flight; more than two legs; a successful non-US
locale lookup; a signed-in session.

## Public route and advertised-fare exploration (2026-09-30)

### `search_flight_status`

Page-first prototype: Delta's route schedule page sends one POST to
`https://flightinformation-api.delta.com/flight-status/schedules`. The new `page` tool sends the
observed body/headers from the current authorized www.delta.com document, with records 1–30 and
availability disabled. It does not navigate, access an account or retry. Output contains only
allowlisted flight numbers, operating-carrier display text, stops, duration and airport-local
scheduled/estimated/actual times/status. Route echoes, first departure date, itinerary endpoints,
leg numbers, airport continuity and chronological connections must match; a mismatched or
malformed itinerary fails the entire call as `site_changed`, never substitutes another route.
The 20-second request timer and caller cancellation are handled. HTTP 403/444 is `blocked`, 429
is `rate_limited`; network/site/shape errors are not empty results. An echoed empty `trip` array
is `no_results` (fixture-only). No pagination beyond the observed first 30 records is claimed.

Builder live case on 2026-09-30: invoked from `/us/en/baggage/overview`, ATL–LGA for 2026-09-30
returned 15 itineraries; document and URL unchanged. Connections, no-results, caller abort and
HTTP failures remain fixture-only for this new tool.

### `list_flight_deals` and `prepare_itinerary`

Both are page-local reads on `/us/en/flight-deals/current-flight-deals` or
`/us/en/flight-deals/skymiles-award-deals`. From other www.delta.com pages they return `wrong_page`
without navigation; the caller must navigate separately and rediscover. No fetch, clicks, form
changes or storage writes occur. Native discovery on the public deals page found no site tools.

`list_flight_deals` reads visible `.fares-table__row` data rows (excluding the header). Optional
route/pricing filters apply only to the current visible rows, not Delta's page filters. Offset
pagination returns up to 20 fare cells, not an invented inventory total. Header/hidden rows are
excluded; unsupported prices, targets, duplicate identifiers or malformed routes fail closed
rather than silently return partial data. A filter/page with no matches is `no_results`, but an
absent table is `site_changed`. Error/schema fixtures use fabricated routes and fares.

Delta's tracking links place the full search URL in an **unencoded** `redirecturl` suffix;
encoded equivalents are supported too. Only the exact tracking host/path and www.delta.com search
host/path are accepted. The tool checks link route against row labels, real ordered dates,
round-trip, one adult, cabin and money/miles pairing. It returns no tracking link or raw state.
`travel_period_display` is separate from `depart_date`/`return_date`: live, an advertised
Oct 31–Nov 6 period linked to a Nov 3–Nov 9 search. Prices are displayed advertised minima, not
live fare inventory, passenger totals, ISO currency assertions or guaranteed quotes.

`prepare_itinerary` consumes the returned `deal_id` plus `expected_price_display`, rechecks the
exact visible target and price, and constructs a public search-form URL from allowlisted values.
Unknown targets, changed prices or ambiguous identifiers do not prepare. Tracking/session/unknown
query fields are discarded. The result says `prepared`, `execution_supported: false`, not booked.
Repeated calls make no writes. Extra confirmation flags are invalid inputs, not human approval.

Builder live checks on 2026-09-30: the complete eight-tool namespace was replaced atomically,
with existing definitions preserved and no legacy login tool invoked. Deals returned advertised
cash and miles fares; preparation returned the cash handoff and a stale price returned
`price_changed`. Document/URL unchanged. A separately opened advertised award search populated
route, dates and miles mode, but Delta returned `SFAF052_444`. Its `datesFlexible=true` link flag
did **not** check the form's flexible-date checkbox. Accordingly, the handoff explicitly requires
manual form verification; it does not claim a populated fare calendar or successful award search.
No booking, fare selection, inventory hold, check-in, payment or account mutation was performed.

### Safety and omitted capabilities

There are no new reversible account actions or confirmed-execution tools. Booking, cancellation,
seat changes, check-in and payment need a trusted human approval path tied to the exact account,
trip/action, dates, cost and terms; the runtime does not provide it. A model-supplied boolean or
annotation cannot supply that approval. Preparation never transitions automatically to execution.

Own-trip/credit reads are omitted: authorized discovery saw only empty account states, not
populated schemas; an empty or expired session does not verify real trip access. No new login or
account was used. Calendar inventory and full award-result parsing are omitted because the
public search was concretely denied and their result structure was not established. No bypass,
retry loop or invented endpoint/schema was used. Non-English deals, other cabins/pricing formats
and populated account flows remain unverified.

### Cash-search updates and kind

`search_flights` remains `cdp`: its established flow navigates from an unrelated page to the
booking form, submits a public search that replaces the document, and reads structured fares from
the destination. New code waits at most 20 × 150 ms for the asynchronous airport textbox, rather
than snapshotting it immediately. The existing trusted typing snippet is unchanged. Invalid
object/passenger types fail before site interaction, cancellation is checked at bounded steps,
and output is capped at 60 rows with bounded parsed text. `results_url` is now the canonical
results path without `cacheKeySuffix`/session parameters; it is not a resumable search link.
No shared input/runtime files changed. The final search revision's live success is unverified;
prior successes do not sign off this source. The 1.5-second readiness heuristic and Delta gates
remain limitations.

### QA for the expanded subset

Pending fresh independent review of the final source. Existing flight-status QA above is historical;
`get_flight_status.js` is unchanged. New fixtures cover schema conformance, serialized execution,
malformed inputs before interaction, wrong pages, network gates, route/date/connection mismatch,
response bounds, advertised deal filtering/pagination, raw and encoded tracking links,
price-change/target ambiguity, secret-query removal and confirmation-negative cases. Fixtures
are not evidence of live mutation success. Kernel live successes above are builder observations;
local extension verification of the additions is not yet established.

## URL patterns

`login` is narrowed to the homepage (`https://www.delta.com/`, `/us/en`, `/us/en/`, each also
with `?*`) because it drives the homepage header flyout and should only be offered where that
flyout exists. `get_flight_status` is narrowed to `https://www.delta.com/*`: it belongs to the
airline site and its request carries that site's session, while `shop.delta.com` is an unrelated
storefront with its own native WebMCP tools. It was not tried from other Delta hosts, so it is not
offered there. `search_flight_status`, `search_flights`, `list_flight_deals` and `prepare_itinerary`
use the same www.delta.com airline-product scope; they do not list on the unrelated shop storefront.
`get_page_context` and `navigate_to_page` retain their existing domain-wide patterns.

## Sessions

- Development browser: `blp6z5n5xt2fuw0sf0pthv8u` (86,400-second inactivity timeout; left alive).
- Independent QA browser: `vw2lg1cj5leg275iuf5jmul1` (86,400-second inactivity timeout; left alive).
- Source: this repository is canonical; sessions expire but files do not. No credential-bearing live-view URL is stored here.
