# aa.com

Tools for American Airlines (https://www.aa.com).

| tool | file | status | notes |
|---|---|---|---|
| get_fare_options | [get_fare_options.js](get_fare_options.js) | qa_passed | Current-page cabin fares and nearby-date calendar; cash or miles; no interaction. |
| prepare_itinerary | [prepare_itinerary.js](prepare_itinerary.js) | qa_passed | No-write preview and manual handoff; never selects, books or holds. |
| get_flight_status | [get_flight_status.js](get_flight_status.js) | qa_passed | Public status for one American-marketed flight number and origin-local date; page tool, `www.aa.com` pages only. |
| search_flights | [search_flights.js](search_flights.js) | qa_passed | First-page outbound options; round-trip fares do not select a return flight. |
| login | [login.js](login.js) | qa_passed | DDG-only entry; CAPTCHA is a typed failure. Full authentication remains unverified. |

## Scope and loading

Every file is one expression containing one definition. Register the **entire** namespace atomically; replacing it with just one file removes the other tools:

```js
const fs = await import("node:fs");
const names = ["get_fare_options", "get_flight_status", "login", "prepare_itinerary", "search_flights"];
const tools = names.flatMap(name => (0, eval)("(" + fs.readFileSync(`domains/aa.com/${name}.js`, "utf8") + ")"));
await webmcp.addCustomTools({ namespace: "aa.com", tools, forceOverwriteNamespace: true });
```

The CDP tool matches `https://aa.com/*` and `https://*.aa.com/*`. It checks the current origin, path, form action, and visible enabled search controls. If the page is unsuitable, it navigates to `https://www.aa.com/homePage.do` before interacting with the form. It does not depend on prior search state.

Inputs are uppercase IATA codes, ISO dates, `roundTrip` or `oneWay`, and 1–9 adult passengers (default 1). Round trips require a return date; one-way searches reject one. Runtime date validation permits today through 331 days ahead, using UTC dates. Cash remains the default; `pay_with: "miles"` requests awards with miles and displayed taxes. It never selects a fare, books, pays, or enters personal data.

Outputs include up to 100 rendered first-page options, result counts, the results URL without session queries or fragments, marketing flight numbers/carrier codes, published operator labels, transport modes, local departure/arrival times, arrival-day offset, duration, stops, and the lowest displayed per-person from-fare. A displayed `$` is preserved as a currency symbol rather than guessed to mean a particular ISO currency. Round-trip prices do not identify a selected return itinerary or guarantee the total for all passengers.

## Fare exploration and itinerary preparation

`get_fare_options` and `prepare_itinerary` are page tools. They inspect only the current document; no fetch, navigation, click, form write or browser storage. Both require the outbound `/booking/choose-flights/1` page on `www.aa.com`; other pages return `wrong_page`. Default URL patterns are preserved. No native tools were found on the public homepage or booking results on 2026-09-30.

`search_flights` still uses CDP: submitting the search replaces the homepage document and its result contains structured flight rows parsed after arrival. A page prototype of the same public form submission demonstrated that transition. `pay_with` accepts `cash` (default, historical price shape) or `miles` (price contains `miles`, `tax_amount`, `currency_symbol`, `basis`, `per_person`, `fare_label`). Both create a search session but never select a fare, hold inventory, or change account data. Before the final parser fix, public award searches succeeded without sign-in; the final-source live recheck was blocked. This is not a promise that every search will work anonymously. The award layout does not expose cash-layout transport icons, so `transportTypes` is `unknown` when no mode is published, not an inferred aircraft flight.

`get_fare_options({offset: 0, limit: 10})` reads up to 20 per-cabin offers per call, across at most 100 rendered flight rows and six tiers per row. `next_offset` paginates those already-rendered offers; it does not fetch more flights. An offset beyond the list returns an empty page with the positive `total_options`, not `no_results`. The same response includes at most 31 already-loaded calendar dates (13 observed). No date or carousel control is clicked. Calendar amounts omit award taxes because the calendar does not display them. A cash currency symbol is not asserted to be an ISO currency. Flight times are airport-local and row airports may be nearby alternatives; inspect them before preparing.

`prepare_itinerary({option_id})` re-reads the current results and returns one outbound quote with `status: prepared`, `booking_performed: false`, `execution_available: false`, and three manual handoff steps. Each `option_id` is a SHA-256 digest of the observed date, row/tier position, flight, route, times, fare and price; it is a content snapshot, not a reservation, persistent draft, human identity or approval token. Changed inputs to that digest cause `stale_selection`. Reordering rows also invalidates IDs. The preview does not establish passenger count, a return itinerary, a party total, complete fare rules, refund/change eligibility or miles sufficiency. Re-read after any change.

### Per-tool safety design

- **Search:** bounded form preparation and one search submission; observed payment mode checked before submission. No fare button, passenger identity, seat, payment or confirmation action. Cancellation stops before submission or returns unknown search observation without retries. Results URLs strip query strings and fragments; arbitrary website errors and thrown exception text are not returned.
- **Fare reads:** current-page allowlist only; no arbitrary scripts, raw page state, member balances, names, session URLs or account endpoints. Input is validated before any page read. Unsupported/missing layouts return `site_changed`, not fabricated availability. Site labels are untrusted data.
- **Preparation:** read-only computation. No inventory action or write exists, so repeat calls cannot duplicate a booking. Pretend confirmation fields (`confirmed`, `confirm`, extra properties) are rejected. It does not collect credentials or booking identifiers; wrong-account checks are not applicable because no account-specific content or action is used.
- **Execution withheld:** booking, inventory holds, cancellation, check-in, seats and paid changes need exact account/action/date/price/terms approval and postcondition design. Current runtime spec does not enforce trusted human approval for those parameters. A model boolean, hash or annotation cannot replace that enforcement. No final execution tool or automatic continuation from preparation is shipped, and none of those actions was exercised live.
- **Authorized trip reads omitted:** prior authorized discovery showed only an empty reservations table; populated row schemas and account/target verification remain unobserved. No reservation identifiers were fabricated, no trip was created for QA, and no new login was pursued. Generic account-summary/preferences tools are outside this increment.

### Broad implementation QA

Independent QA signed off on final source `de4079eeaeb870c4f6a74919452de640520e2060` on 2026-09-30. The four changed/new tools are `qa_passed`, not `verified`; the PR remains draft. Reviewer provenance: `agt_8e0c8369e539ef0b8159`. Builder and reviewer used `pi / openai-codex/gpt-6.1-sol`, thinking `high`, fast `false`, context `272k`, with Codex auth confirmed present. Older QA sections below record historical revisions only.

The initial review of `6147534` found malformed comma grouping was silently normalized into cash/miles/tax quotes. The fix rejects malformed grouping and punctuation across search, fare/calendar reads and preparation. All 1,628 repository tests, 14 extension tests, Go tests, 48 independent quote cases, 33 calendar cases, 875 status fixtures and 735 incoming-flight/date variants passed. Reverting any quote parser fails 11 regression tests. Safety mutants and schema checks passed; fabricated fixtures do not establish live availability or mutation success.

| Final-source runtime check | Kernel | Local Chrome extension |
|---|---|---|
| Atomic replacement/discovery, preserving login | All five tools listed; native discovery empty; login not invoked | All five installed sources hash-identical; namespace intact |
| Flight status | AA 100 succeeded from flight-status search page; one status POST | Successful status query untested |
| Cash/award search | Cash timed out before submission; one controlled readiness retry submitted once, then returned `blocked`; award not attempted after denial | Homepage showed Access Denied; no search invoked |
| Fare exploration / preparation | Blocked-page, malformed-input and pretend-confirmation rejection passed; successful final-source flows and live stale-ID rejection untested | Blocked/malformed/confirmation rejection passed; successful flows untested |

Final QA validated 17 runtime outputs against their schemas. There were zero fare-selection clicks; settled readers/rejection checks made no tool requests or clicks. Ambient site analytics still generated traffic/storage activity. No booking, hold, login, account or payment action occurred. Denial ended live search testing without proxy/fingerprint rotation or bypass loops. No successful Kernel/extension parity is claimed. The reviewer's initial and recheck browsers and scratch extension resources were deleted; existing/shared resources were not touched.

Author live checks before the final parser fix on 2026-09-30 in one public signed-out Kernel browser: full five-tool namespace replacement; public cash and award DFW–ORD one-way 2026-10-15 returned 40 outbound flight rows; fare exploration returned 117 cash tiers and 79 award tiers, a 13-date carousel, and a 20-option output of about 11 KB. Cash and award preview invocations returned `prepared` with no booking/hold. Unknown option ID returned `stale_selection`; `confirmed: true` returned `error`. Migrated flight status returned `ok` from the flight-status search page for AA 100 on 2026-09-30. Login was registered but not invoked. No account or trip mutation occurred.

Local fixtures cover cash/miles parsing, dates and currency, bounded pagination, no-write preparation, stale fare/date/route/flight/label/disabled guards, malformed input before page reads, pretend confirmation, unrelated pages, challenges/login/rate-limit states, missing layout and cancellation. They are fabricated, not live mutation evidence. Independent Kernel and local Chrome extension evidence is recorded separately above; neither fixture tests nor installed source equality imply successful runtime parity.

### Additional known limitations

- Only current rendered outbound results are supported, not return selection, multi-city itineraries, full-month availability or calendar paging.
- Cash buttons show cabin-group **from** prices, not a fully specified fare product or committed quote. Award values are displayed miles plus taxes, not group totals or a promise of availability.
- Calendar price availability and search session expiry are site-controlled; missing selected-date or fare signals fail closed. No brute-force date sweeps or access-bypass loops.
- Three-decimal K-miles values such as `1.001K` and `8.001K` can fail closed due to floating-point conversion. This was found in fabricated fixtures, not observed live; no incorrect quote is returned.
- No populated trip reads, generic account tools, booking/hold execution, cancellation, check-in, seats, paid bags or account writes.
- Flight-status input/output fields now use snake_case per current main's repository contract (for example `flight_number`, `flight_count`, `status_page_url`, `http_status`). This replaces the earlier unmerged camelCase contract. Site request/response payload names remain unchanged.

## Site quirks

- Results render client-side. The tool waits for result/error signals, with a 105-second execution budget; invoke with `timeoutSec: 120`. Await the invocation in the same REPL cell, configured with enough execution time. Use a dedicated tab and invoke serially.
- American can include nearby airports and airline-marketed buses. Check each row's `matchesRequestedAirports` and `transportTypes`, plus `exactMatchCount` and `nearbyAirportCount`. `alternatives_only` means none of the returned rows matches both requested airports.
- `no_results` requires an explicit empty-state signal. Challenges and access denial return `blocked`; missing results return `timeout`; validation or parsing failures return `error`. An empty failure output is not evidence of no availability.
- Non-stealth sessions encountered human verification. Stealth enabled successful searches but did not prevent later access denial. Connection failures also occurred on long-haul round-trip searches.
- A one-way radio reset was observed intermittently. The tool waits for homepage load and reasserts the requested trip type before validating the form. Repeated independent verification of that mitigation was prevented by access denial.

## Historical cash-search QA summary

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

## Known limitations

- First results page only; round-trip searches return outbound options with per-person from-fares and never a selected return flight or a party total.
- Adults only (1–9); no children, infants, or later result pages.
- Nearby-airport and bus alternatives can be returned; check `matchesRequestedAirports`, `transportTypes`, and `exactMatchCount` before treating a row as an exact match.
- American serves human-verification and access-denial pages; these return `blocked`, and a long-haul round trip can also fail on connection errors.
- Independent repeated-transition coverage of the trip-type radio mitigation and long-haul round-trip coverage remain incomplete.

## Sessions

- Development and migration-verification browser: `qer6pzs0jzhw3r5j9bx7yse4` (24-hour inactivity timeout, left alive).
- Independent QA browser: `herknyf87s7zdzhwscc6g224` (24-hour inactivity timeout, left alive).
- Independent QA agent: `agt_dbdb039786be4bed1121`.
- This repository is canonical; browser sessions and registrations expire, but the source does not.

## Flight status

`get_flight_status` returns the public flight status American shows on its flight-status page for one American-marketed flight number on one date. It needs no login. Its earlier camelCase source was verified; the current snake_case migration is `qa_passed` under the broad final-source review above.

### Native WebMCP

No native WebMCP tools were found on the sampled homepage, flight-status search and travel-alerts pages on 2026-09-29, or the public booking results on 2026-09-30. Custom registrations were checked separately; nothing collided with their names.

### Execution kind

`kind: "page"`. The tool reads the answer with one same-origin `fetch` from the document it is invoked in and never navigates, so it has nothing to survive and does not meet the `cdp` rule (a navigation plus a structured result read after it). American's own page reads the same data by loading a results page and then issuing that request; the tool skips the navigation and issues the request directly.

### Scope and loading

Register the whole namespace together. The patterns are the domain default (`https://aa.com/*`, `https://*.aa.com/*`), so the tool is also listed on other aa.com hosts (for example `login.aa.com`), but it only works on a `https://www.aa.com` page and returns `wrong_page` elsewhere without sending anything.

```js
const names = ["get_fare_options", "get_flight_status", "login", "prepare_itinerary", "search_flights"];
const fs = await import("node:fs");
const tools = names.flatMap(n => (0, eval)("(" + fs.readFileSync(`domains/aa.com/${n}.js`, "utf8") + ")"));
await webmcp.addCustomTools({ namespace: "aa.com", tools, forceOverwriteNamespace: true });
const live = (await webmcp.listTools()).find(t => t.source.custom?.namespace === "aa.com" && t.tool.name === "get_flight_status");
const result = await webmcp.invokeTool(live.tool_ref, { flight_number: "1938", date: "2026-10-15" }, { timeoutSec: 60 });
```

Input: `flight_number` (1–9999, optionally prefixed `AA`, as in the American-marketed entries of `search_flights` `flightNumbers`) and `date` (the flight's departure date at its origin airport, `YYYY-MM-DD`). Other carriers, airport pairs and reservation data are not accepted. The tool rejects malformed input itself before any request; American's service answers a malformed date with HTTP 500, so a bad date must not reach it.

Output on success: `flights[]` (at most 10 rows; `flight_count` is the number American returned) with status text and key, `canceled`/`diverted`/`landed`/`in_flight`, departure and arrival airport, city, terminal, gate, baggage claim, scheduled/estimated/actual times as ISO 8601 with the airport's UTC offset, aircraft name and code, `operated_by` for American Eagle flights, wifi and power flags, the incoming flight number (leading zeros removed; the site's `0000` placeholder becomes `null`) and date, and `status_page_url`, American's own page for the flight. Fields outside this list, including tail number and everything the site returns about the signed-in member, are dropped. Other outcomes are `no_results`, `blocked`, `rate_limited`, `site_changed`, `wrong_page` and `error`, each with a message and the HTTP status when a request was made. The tool sends exactly one request per call and never retries.

### Observed mechanism

Public pages, observed by the author on 2026-09-29 (Kernel stealth browser on a US residential proxy):

- `https://www.aa.com/travelInformation/flights/status` → **Flight number** tab → Search loads `https://www.aa.com/travelInformation/flights/status/detail?search=AA|100|2026,9,29&ref=search`. That page issues `POST https://www.aa.com/flightinfo/v1.2/` with the JSON body `[{"airlineCode":"AA","destAirportCode":"","flightNumber":"100","fltOrgDate":"2026-09-29","orgAirportCode":""}]` and answers `{"flights":[…]}`.
- The same request sent with `fetch` from a `www.aa.com` page returned the same shape. American's service answered HTTP 400 unless both the `locale: en` and `Client-Details: aa-ct-aacom/flifoui` request headers were present, so the tool sends them; the second is the flight-status page's own client identifier.
- `fltOrgDate` is the origin-local departure date: independent QA found a Sydney departure at 09:10 local, which falls on the previous UTC day, under its local date. A date about 60 days ahead returned the scheduled times with `Flight status not available`; dates a year or more ahead also returned rows. A date 7 days back returned `Arrived at gate` with actual departure and arrival times and a baggage claim; a date 60 days back returned an empty list. An unknown flight number returned an empty list with HTTP 200. An unparseable date returned HTTP 500.
- The detail page shows no flight unless the `ref=search` parameter is present, so `status_page_url` includes it.
- An American Eagle flight returned `codeShareInfo.operatedBy: "American Eagle"`.

### Flight status QA

Historical status was `verified` (2026-09-29). Independent QA (agent `agt_8e0c8369e539ef0b8159`) reviewed three commits and signed off on each: `0f9b673` (one minor defect: the site's `0000` placeholder and zero-padded numbers leaked into `incoming_flight`, plus README claims that overstated the evidence), `cf023d6` (fixes verified; two nits) and `3defa44`, the final tool source. That sign-off applies to the historical camelCase revision, not the current snake_case migration.

Fixture tests (`tests/aa-flight-status.test.mjs`, 21 tests, fabricated flights, stubbed page): input rejection before any request, the exact request, wrong host, challenge pages, field allowlist and cleaning, schedule-only rows, cancellation, incoming-flight normalization, the 10-row cap, no-results, every HTTP failure mapping, the 20 second abort, no navigation, and negative cases against the output schema. QA also mutation-checked the tests and fuzzed the real output schema with about 900 adversarial fixtures (no schema violations, one request per case).

Independent live cases on that historical source, 2026-09-29, public and signed out, in a Kernel stealth browser on a US residential proxy with the whole `aa.com` namespace registered together:

| Case | Result |
|---|---|
| Registration | All three tools listed, `get_flight_status` is `page`, no native tool present |
| AA 100 on 2026-09-29, invoked from `/homePage.do` and from `/travelInformation/flights/status` | `ok`; identical apart from `observed_at` |
| AA 4500 on 2026-09-30 | `ok`, two rows (two separate flights sharing the number, one in each direction), `operated_by` an American Eagle operator, `incoming_flight` null |
| AA 100 on 2026-09-22 | `ok`, `Arrived at gate` with actual times, `incoming_flight` 101 |
| AA 9999 on 2026-09-29 | `no_results`, HTTP 200 |
| Invoked from `creditcards.aa.com` | `wrong_page`, no request |
| Malformed input | `error`, no request |

Every live output validated against the output schema; each call sent exactly one `/flightinfo/v1.2/` POST and the tab's URL did not change. `about:blank` and `example.com` did not list the tool (checked on the first commit).

Runtime parity. Kernel browser runtime: ran, as above. Local Chrome extension runtime: ran on the final source (installed file byte-identical to the checkout): AA 100 success from the same two pages and three malformed inputs, with the same results as Kernel. Not run in the extension: `no_results`, `wrong_page`, Eagle, past-date and `blocked` cases. Parity is claimed only for what ran in both.

Author live checks on 2026-09-29 covered the same cases plus a schedule-only date about 60 days ahead. `blocked` was observed live once: after about an hour of repeated author probing, `www.aa.com/homePage.do` began returning Akamai's "Access Denied" page to that browser and to a fresh browser on the same proxy; the tool returned `blocked` without sending a request. A different proxy loaded the homepage normally. QA confirmed the same behavior with a synthetic denied page.

Not observed live: `blocked` or `rate_limited` answered by the flight-status service itself, `passenger_message` with text, and a cancelled or diverted flight. These paths are covered by fixtures only.

### Flight status known limitations

- American-marketed flight numbers only, by number and date. There is no route or airport search; use `search_flights` to find flight numbers.
- The service is American's own web endpoint, not a documented API. Both required request headers were found by observation and could change; the tool reports `site_changed` when the answer is not in the observed shape.
- `Flight status not available` means American publishes only the schedule; it is not evidence of a delay or cancellation. On such rows `canceled`, `diverted`, `landed` and `in_flight` are `false` because nothing has been reported, not because the flight is confirmed as operating normally. `no_results` is not proof that the flight never operates: American keeps only a limited window of past dates.
- Wifi and power flags are American's values. `false` was seen on schedule-only rows and on a departed flight, so it does not prove the aircraft lacks them.
- Only `www.aa.com` pages work. The tool is listed on other aa.com hosts because the namespace uses the domain default patterns.
- Bot protection can block the page or the request. This is reported as `blocked` and is not an answer about the flight. The page-level denial was seen during the author checks; a denial of the flight-status request itself was not.

## Login scope and loading

### Status and known limitations

`qa_passed`: independent QA passed the frozen behavior locally (208 repository tests and 22 additional checks). Last real live check: **2026-09-25**. Live DDG entry reached the login form, and an earlier referred submission reached MFA. Full authentication and live solver completion remain unverified; historical direct entry encountered CAPTCHA. All login-work browsers and their artifacts were deleted at closeout.

Most useful lead: MFA delivery selection is the furthest verified credential-flow stage. A future authorized end-to-end check should retain the DDG organic-click entry and verify progression from MFA to actual account UI; do not treat MFA alone as logged in.

`login.js` is a self-contained tool-definition array. Include it when registering the entire `aa.com` namespace as shown above. Both apex and wildcard subdomains match; the actual sign-in flow redirects from `www.aa.com/loyalty/login` to `login.aa.com/login`.

The tool checks the current page before interacting. From an unsuitable page, including another subdomain or unrelated origin, it opens `https://start.duckduckgo.com/`, issues the fixed public query `american airlines login` through the search URL, and clicks the first organic result. This is the only entry path, using a real organic click rather than a spoofed referrer header. It clicks only if that first result is `https://www.aa.com/loyalty/login` or `https://login.aa.com/login`; it never skips to a later result or navigates directly to AA. Missing results time out after 20 seconds. An unsuitable result, selector miss, unexpected origin, or uncertain navigation/click returns a step-specific failure and stops. Search-page challenges return failure with `error_kind: captcha_or_challenge`; reaching a challenge, MFA, or error on AA never triggers another entry attempt. The search query contains no account input, and no referrer header is spoofed. A suitable existing login form or MFA screen is reused. A detected CAPTCHA stops the flow before any search navigation, filling, or further submission; the referrer route is never retried to work around a challenge. Supply an AAdvantage number or username and password, or explicitly set `use_prefilled: true` after a human or vault fills both fields. Prefilled mode cannot recover values lost when an unsuitable page is replaced. The tool does not support email identifiers, OTP submission, MFA-method selection, account recovery, or account registration. The stealth browser's built-in solver may run normally; the tool does not disable it. No remember-me or third-party SSO control was observed.

The output schema has successful `authenticated` and `mfa_required` outcomes, or `failure`. `first_step_succeeded: true` with `mfa_required: true` means the credential stage reached MFA, not a fully authenticated session; `logged_in` stays false until authentication completes. `observation` and `submission_attempted` distinguish a pre-existing screen from this invocation's result. A pre-existing account or MFA screen is not proof that the supplied account was authenticated.

Failures use exactly five `error_kind` values: `invalid_credentials`, `captcha_or_challenge`, `mfa_failed`, `locked_or_throttled`, and `unknown`. A CAPTCHA is not evidence of invalid credentials. Local validation errors and blocked repeat submissions use `unknown` with an explanatory message. Site evidence is returned separately from tool-generated diagnostics. Remaining attempts are null unless explicitly shown. The tool does not return filled field values. All landing URLs omit query strings and fragments, including MFA and authenticated outcomes.

Entry failures use `error_kind: unknown` and name the failed step in `error_message`: `ddg_home_navigation_failed`, `ddg_search_navigation_failed`, `ddg_inspection_failed`, `ddg_result_missing`, `ddg_result_unapproved`, `ddg_unexpected_origin`, or `ddg_result_click_failed`. A missing form is identified as `login_form_unavailable` in the message. None of these errors authorize a direct entry or retry.

### Login quirks and safety

- Inputs are nested in open `adc-text-input` shadow roots. Inner IDs are randomized; the implementation finds visible inputs by their stable `username` and `password` names, uses the native value setter, and dispatches composed input/change events. Length equality is checked before proceeding, without returning field values.
- The `Log in` control is an `adc-button` host with an inner shadow-root button. A rendering race previously checked it before the application enabled it. The fixed implementation polls for up to 10 seconds, returning typed `unknown` without submission if readiness never arrives.
- A sessionStorage marker is written before the single click. Re-invocation in that login tab cannot submit again. This guard does not cover another tab or cleared browser storage; callers must enforce account-wide attempt limits. Unknown outcomes must not be retried automatically.
- Post-submission observation lasts up to 45 seconds, allowing the built-in solver to run without another click. An unresolved CAPTCHA at the observation deadline returns `captcha_or_challenge`; authentication or MFA reached during observation is reported normally. Pre-existing and search-page challenges return `captcha_or_challenge` before any credential submission. No account creation or credential guessing/enumeration is performed. The observed challenge is a visible iframe titled `Challenge Content`, served from `/challenge-assets/v7/captcha.html`; `Loading...` is not authentication success or evidence of bad credentials. Search-result readiness is bounded to 20 seconds. Invoke with `timeoutSec: 180` and a sufficiently long enclosing REPL timeout to cover search navigation, form preparation, and post-submission observation.

### Login QA and configuration matrix

Independent failure-path QA rejected missing/empty/conflicting inputs without submission, checked failure-schema conformance, and made one fabricated-account submission that reached the real CAPTCHA. Two static findings were fixed: cross-invocation submission guarding and explicit pre-existing-state attribution. Author synthetic regressions covered those fixes and the readiness race. Local migration tests additionally cover entry-point navigation, shadow input writes, output branches, and timeout behavior. These synthetic checks do not verify real successful authentication.

The direct-entry baseline matrix on 2026-09-25 used Chrome 153.0.8010.36, separate headful browsers copied from the same requested profile, and no profile save-back. It made one tool invocation per configuration, without retries. No successful login, MFA interstitial, or confirmed invalid-credentials response occurred.

| Configuration | Actual submissions | Result | Solver evidence |
|---|---:|---|---|
| A: residential proxy, stealth enabled | 1 | `captcha_or_challenge`; challenge persisted | CapMonster loaded; firing unconfirmed because the observation buffer overflowed. |
| B: mobile proxy, stealth enabled | 0 | `unknown` during preparation; subsequent read-only page evaluation timed out | CapMonster loaded; no firing observed. |
| C: residential proxy, stealth disabled | 1 | `captcha_or_challenge`; challenge persisted | No solver loaded. |

All three baseline outputs matched the schema. Direct-entry residential CAPTCHA classification is live-verified with and without stealth. In that baseline, successful login, MFA, invalid-credential and lockout behavior were unverified on the real site; synthetic classification tests are not a substitute. The mobile failure does not establish that the credentials were rejected or identify the underlying browser failure. The migration was tested locally, without additional live credential submissions.

Historical login test references (not credentials or live-view links):

- Independent QA agent: `agt_64d5890885db30858fc8`; browser: `k9c0lcjrhbzhdh3o888bvqfp`.
- Original development browser: `avy9sn160f5xke2jcwa0sa31`.
- Matrix A: `jnke5q5m45anfru9og3bqjre`; B: `tzeo1hakca2ftlky6dla7n2p`; C: `tgi1xo9b54ffa22wj2lotcbp`.

All three direct-entry matrix browsers were deleted after testing.

### DuckDuckGo-referrer experiment

On 2026-09-25, the residential-stealth configuration was tested again in a fresh browser copied from the same profile, using Chrome 153.0.8010.36. The search homepage initially did not render its controls, so the public query was issued through its search URL. The first organic result was `https://www.aa.com/loyalty/login`. Clicking it reached the login form with the `document.referrer` origin `https://start.duckduckgo.com`; the existing tool reused that form without direct renavigation.

| Configuration | Credential submissions | Result | Solver evidence |
|---|---:|---|---|
| A: residential proxy, stealth enabled | 1 | MFA delivery-choice screen; no visible CAPTCHA | CapMonster loaded; no start or success signal observed, and no observation-buffer loss. |
| B: mobile proxy, stealth enabled | 0 | Not run: stopped after the first MFA success. | Not observed. |
| C: residential proxy, stealth disabled | 0 | Not run: stopped after the first MFA success. | Not observed. |

AA displayed `Let's confirm it's really you` and `To keep your account safe, we'll send a verification code. How should we send your code?`, with text and email delivery choices. The prior classifier missed this wording and returned `unknown` after 45 seconds despite the successful first step. The classifier now recognizes the observed wording. Re-registering and invoking against the existing screen returned schema-conforming `mfa_required`, `first_step_succeeded: true`, `logged_in: false`, `observation: pre_existing`, and `submission_attempted: false`. That verification did not resubmit credentials or send a code.

This run changed the observed outcome from the direct-entry baseline's `captcha_or_challenge` to first-step MFA success. It does **not** prove the referrer caused the change: the residential egress IP and test time also changed, and only one referred attempt was made. Full authentication still requires human MFA completion; invalid-credential and lockout behavior remain unverified live. No automatic MFA delivery selection, code request, or OTP submission was added.

The successful manual search-entry sequence is now the only entry path for tools invoked from unsuitable pages. Local regressions cover first-result validation, step-specific failures for missing/unsuitable results and navigation/inspection/click failures, search-page challenges, and challenge classification after the organic click. The earlier direct-entry results above remain the comparison baseline; they are not re-run. No additional live credential submission was made. Improved bot-detection resistance is a goal, not a measured guarantee.

Referrer experiment browser: `bqpgqp8xwmh46xu6addo3je1` (deleted at closeout; last observed at MFA). These experiments remain historical evidence and were not repeated for the schema restoration.

### Independent DDG-only re-test

Independent QA re-tested commit `ee2a19e614ebcf837622326c9c5d02f53c89ef5f`: **213 repository tests and 14 independent temporary regressions passed**, with no remaining actionable findings. The re-test covered DDG step-specific failures, challenge stops, URL query/fragment stripping, pre-existing MFA/authentication attribution, and the one-submission guard. No direct-entry cases were run.

A guarded live execution from `about:blank` reached the AA login form in 10.7 seconds. The observed first organic href was `https://www.aa.com/loyalty/login`, followed by a link transition to `https://login.aa.com/login`; the final sanitized referrer was `https://start.duckduckgo.com/`. No direct AA navigation, credential filling, or submission occurred. The hash-verified source ran with a read-only first-link observer and a test-only early return at the form to prevent credential actions; this was not an unmodified WebMCP invocation. Full authentication remains untested.

The fresh QA browser and artifact were deleted, while existing sessions were untouched. The earlier direct-entry experiments remain the historical baseline, not a new comparison run.

### Independent schema-restoration re-test

Independent QA re-tested commit `d9bf1ec0d5986d86efde85cdff6dc806e7a3587e`: **208 repository tests and 22 independent temporary regressions passed**, with no remaining actionable findings. Checks covered the exact five failure kinds, DDG step names in error messages, persistent CAPTCHA timeout, CAPTCHA clearing into MFA/authentication without another submission, unknown outcomes, URL sanitization, origin confinement, and the sessionStorage guard.

This re-test was local/synthetic only. No browser was launched, no credentials were submitted, and no direct-navigation cases were run. The live DDG evidence above belongs to the earlier revision; full authentication and live built-in solver behavior remain unverified.

```sh
node --test tests/aa-login.test.mjs
```
