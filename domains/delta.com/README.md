# delta.com

Tools for Delta Air Lines (https://www.delta.com).

| tool | file | status | notes |
| --- | --- | --- | --- |
| get_flight_status | [get_flight_status.js](get_flight_status.js) | draft | Public, read-only status lookup for one Delta flight number and date from any www.delta.com page (`page` kind, no navigation). Returns every leg and checks optional origin/destination against them. Fixture-tested and exercised live; Delta's bot protection makes it unreliable without a warm session. Not independently QA'd. |
| get_page_context | [get_page_context.js](get_page_context.js) | draft | Read-only page summary with live tool names and suggested next steps. Unit-tested; exercised live on the homepage and booking form. |
| search_flights | [search_flights.js](search_flights.js) | draft | Airport entry fixed for macOS Chrome on 2026-09-29 and first successful full live invocation recorded; needs fresh independent QA because the source changed. |
| login | [login.js](login.js) | draft | Homepage-only page tool: opens the top-nav Log in flyout, fills it, and schedules one submit. No output schema; outcome not observed. Live-checked with fabricated credentials and the submit click blocked in-page; no real submission. |
| navigate_to_page | [navigate_to_page.js](navigate_to_page.js) | draft | Schedules a same-tab navigation to a www.delta.com path; description carries a basic site map. Unit-tested; exercised live. |

## Scope

- Namespace: `delta.com`. Match patterns: `https://delta.com/*` and `https://*.delta.com/*`.
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

The independent QA below covered the source before the airport entry fix; it no longer signs off
the current file.


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

- `search_flights` is `draft` again because its source changed after QA. One full live invocation succeeded on 2026-09-29 (CVG→SFO one way); Delta's intermittent HTTP 429 / `SFAF001` responses can still block searches.
- First results page only; round trips return outbound options, not outbound/return pairs. Prices are rounded display fares, not passenger totals.
- Adults only (1–9), 330-day booking window, English desktop layout only.
- Completeness beyond the 1.5-second DOM-quiescence heuristic and real zero-results behaviour remain unverified.
- `get_flight_status` is `draft` and not independently QA'd. Delta's bot protection returns HTTP 444 (reported as `blocked`) to cold sessions and to a session after roughly six or seven lookups, and the block persisted for minutes in every case tried; a `blocked` result says nothing about the flight. It covers Delta-marketed flight numbers only, reads Delta's response as-is (no cancelled, diverted, or partner-operated example has been observed), and does not cover flights by route, fares, seats, trips, credits, check-in, or notifications.
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
  lookups succeeded for about six or seven calls in a row and then returned 444 again, and once
  blocked, a session stayed blocked for at least several minutes (25 minutes in one browser) with
  the site's own form failing too ("An unexpected error occurred"). The tool reports this as
  `blocked`, never retries, and its message tells the caller not to loop. Normal use of the site in a
  warm session is the only thing observed to help; the tool does not try to work around the
  protection.
- Some egress (seen from France and Canada) gets a "Welcome to Delta" location and language dialog.
  The tool never clicks it and never changes the location setting. Whether that dialog changes the
  lookup's outcome was not established: the Canada-egress browser that showed it was already denied
  by the bot protection, and the France-egress one was moved to US egress before any lookup.
- Delta returns `flight_not_found` (HTTP 400, code `FLD2300`) both for an unknown number and for a
  date it no longer serves: yesterday's date for a flight that operates today returned it. Other
  date windows were not measured because the session was blocked.

### QA (get_flight_status)

Draft; no independent QA pass yet. `tests/delta-flight-status.test.mjs` uses fabricated data and a
stubbed `fetch`: the exact request, schema conformance of every branch, all-legs / filtered /
`route_not_found`, flight-number normalization, 19 invalid inputs rejected with no request, every
site outcome above with one request and no retry, timeout and caller abort, sanitization, and that
the document and location are never read.

Live, 2026-09-29, fresh Kernel browsers on US egress, invoked from `/us/en/baggage/overview` after the
whole `delta.com` namespace was registered together with `forceOverwriteNamespace` (no existing tool
was invoked): DL2910 with no route returned both legs (MSP-IND complete, IND-MSP in flight) in
about 1.2 s; `origin: IND, destination: MSP` returned only the second leg with `leg_count: 2`;
`origin: JFK` returned `route_not_found` with both routes; an unknown number returned
`flight_not_found` with `FLD2300`; malformed and impossible-date inputs returned `invalid_input`;
two sessions already denied by Delta returned `blocked`. On `shop.delta.com` the tool is not listed
(its 11 native tools are unaffected). Not observed: a cancelled, delayed, diverted, or
partner-operated flight, more than two legs, a signed-in session, non-US locale behavior, and the
xwebmcp Chrome extension.

## URL patterns

`login` is narrowed to the homepage (`https://www.delta.com/`, `/us/en`, `/us/en/`, each also
with `?*`) because it drives the homepage header flyout and should only be offered where that
flyout exists. `get_flight_status` is narrowed to `https://www.delta.com/*`: it belongs to the
airline site and its request carries that site's session, while `shop.delta.com` is an unrelated
storefront with its own native WebMCP tools. It was not tried from other Delta hosts, so it is not
offered there. The remaining Delta tools keep the default domain-wide patterns.

## Sessions

- Development browser: `blp6z5n5xt2fuw0sf0pthv8u` (86,400-second inactivity timeout; left alive).
- Independent QA browser: `vw2lg1cj5leg275iuf5jmul1` (86,400-second inactivity timeout; left alive).
- Source: this repository is canonical; sessions expire but files do not. No credential-bearing live-view URL is stored here.
