# delta.com

Tools for Delta Air Lines (https://www.delta.com).

| tool | file | status | notes |
| --- | --- | --- | --- |
| continue_to_review_and_pay | [continue_to_review_and_pay.js](continue_to_review_and_pay.js) | draft | Presses Continue to Review & Pay on Trip Summary; no data, no purchase. Unit-tested. |
| get_page_context | [get_page_context.js](get_page_context.js) | draft | Read-only page summary: page type, live tools, unsettled/pending_choice, cart id, suggested next steps. Exercised live. |
| get_trip_summary | [get_trip_summary.js](get_trip_summary.js) | draft | Read-only cart reader on Trip Summary / Review and Pay. Exercised live on Trip Summary. |
| list_flight_results | [list_flight_results.js](list_flight_results.js) | draft | Read-only results-page tool: every visible itinerary with all fare columns, sortable; unit-tested and exercised live once. |
| login | [login.js](login.js) | draft | Homepage-only page tool: opens the top-nav Log in flyout, fills it, and schedules one submit. No output schema; outcome not observed. Live-checked with fabricated credentials and the submit click blocked in-page; no real submission. |
| navigate_to_page | [navigate_to_page.js](navigate_to_page.js) | draft | Schedules a same-tab navigation to a www.delta.com path; description carries a basic site map. Unit-tested; exercised live. |
| search_flights | [search_flights.js](search_flights.js) | draft | Airport entry fixed for macOS Chrome on 2026-09-29 and first successful full live invocation recorded; needs fresh independent QA because the source changed. |
| select_fare | [select_fare.js](select_fare.js) | draft | Opens the experience drawer for one fare on a results row and returns its options. Exercised live. |
| select_fare_experience | [select_fare_experience.js](select_fare_experience.js) | draft | Picks an experience; Basic requires accept_restrictions. Exercised live (consent refusal, Classic). |

## Scope

- Namespace: `delta.com`. Match patterns: `https://delta.com/*` and `https://*.delta.com/*`.
- CDP-backed, read-only flight shopping for one-way and round-trip cash fares, 1–9 adults, within a 330-day booking window. No fare selection, purchases, payments, or personal-data entry.
- On invocation, check for an idle, usable booking form at the exact entry URL. Otherwise navigate to `https://www.delta.com/flightsearch/book-a-flight` before interacting. An unrelated page, a baggage page, results, query-bearing booking state, or an open form overlay does not satisfy this check.
- Return structured first-page outbound options: marketing airline and flight numbers, airports, local times, displayed overnight-arrival date, duration, stops, and lowest available displayed fare per row. Round trips do not return selected outbound/return pairs. Prices are rounded display fares, not passenger totals or guaranteed quotes; the currency symbol is preserved without guessing its ISO code.
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

## Find Flights submit fix (2026-09-29)

In one live run in regular Chrome on macOS, the tool filled the form correctly (origin,
destination, one way, date, passengers) and pressed Find Flights, but no search started; the
run ended in `TIMEOUT: missing idp-search-results…` after about 40 s. A page-level
`.click()` on the visible button started the search immediately. A second live run with the
same input succeeded, so the failure is intermittent, and its cause was not isolated. The page
also renders a hidden 0x0 duplicate `#findFilghtsCta`; the click helper already skips it.

The tool now waits up to 8 s after the trusted press for the search to start (results URL or
results/error element). If it has not, it clicks the visible Find Flights button once from the
page (a search is read-only, so one retry is safe) and waits up to 10 s more. If neither press
starts a search it returns `SUBMIT_FAILED: … form shows: <field labels>` instead of the generic
timeout. Unit tests cover all three paths (`tests/delta-search-flights.test.mjs`); the
fallback path has not yet been observed live.

Likely root cause, found on 2026-09-30: the run happened in a background tab. Chrome does not
deliver synthetic input to hidden tabs (and the helpers stalled on animation frames there).
xwebmcp #95 now makes a cdp tool's tab active before it runs; afterwards the same search
succeeded from a background tab. The fallback stays as a guard.

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
- `login` is `draft` and homepage-only. It never reports the outcome (no output schema): a successful login, a wrong-password message, an MFA step, and a captcha are all unobserved by the tool and unverified live. It has not submitted real or fabricated credentials to Delta; the only live run blocked the click in-page.
- `get_page_context` is `draft`. `signed_in: true` relies on a visible "Log out"/"Sign out" header control and has not been observed on a signed-in page; it may report `null` there. `page_type` is path-based and `page_messages` is a best-effort scan of alert-like elements.
- `navigate_to_page` is `draft`. It only accepts www.delta.com paths and reports that navigation was scheduled, not that the page loaded. The site map in its description is a starting list, not exhaustive.
- Newly installed page tools were not registered on an already-open tab until it reloaded (extension behaviour, seen 2026-09-29); tabs opened afterwards registered them immediately.

- The booking-flow tools (`list_flight_results`, `select_fare`, `select_fare_experience`,
  `get_trip_summary`, `continue_to_review_and_pay`) are `draft`, English desktop layout only,
  1 adult in every live run. Not observed live after the latest fixes: Comfort Basic consent,
  Review and Pay totals, multi-passenger carts, miles fares, and signed-in checkout.
- Prices in results and drawers are rounded display fares (e.g. $399 vs a 398.20 USD cart);
  `get_trip_summary` is the authoritative total.

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

## Booking flow tools

Observed flow (regular Chrome 154 on macOS, xwebmcp extension, signed out, 2026-09-30):
search results → fare cell → "Select an Experience to Continue" drawer → Trip Summary →
Review and Pay. Every tool below is a `kind: "page"` tool, invoked like any other WebMCP tool
by the `tool_ref` its tab lists; tools that navigate return first and schedule the click
100 ms later (cdp-tools.md §2.2), so the caller then calls `get_page_context`
`{wait_for_settled_seconds}` (retrying once if it reports the outcome could not be observed)
before listing tools again.

### list_flight_results

Registered on `https://www.delta.com/flightsearch/search-results*`. Reads the rows already on
screen without searching again, reusing `search_flights`' row parser
(`[id^="flight-results-grid-N"]`, `data-testid` fields with class fallbacks,
`.rounded-amount`, `.brand-name`), and returns every fare column:

- `result_index` is `N` from `flight-results-grid-N`; `brand_code` is the suffix of
  `grid-row-N-fare-cell-desktop-{CODE}` (observed `BMAIN`, `BDCP`, `CDCP`, `CFIRST`, `CD1`).
- `cabin` comes from the column headers `#mach-cabin-header-desktop-*`, which render once in
  the same left-to-right order as each row's cells, so sold-out cells are named too. A cell's
  code can differ from its header's (e.g. `CDCP` under the Comfort header `BDCP`), so the
  mapping is positional. `brand_name` is Delta's in-cell label; "Delta Comfort, Delta Main" is
  a mixed-cabin itinerary (one leg in each cabin).
- `leg` is `outbound` or `return` (`/flightsearch/search-results/return`); on the return page
  `selected_outbound` is Delta's summary of the outbound already chosen. `search` is the round
  trip as Delta stored it in `localStorage["postData" + cacheKeySuffix]`.
- `more_results_available` reports Delta's "See More Results" button; `load_more_results:
  true` presses it (up to 5 times, same page) before reading. Observed 20 → 27 rows.
- `sort_by`: `page_order` (default), `departure`, `arrival` (adds a day per `+N` marker),
  `price`, `duration`; `max_stops`, `limit`. Waits up to `wait_seconds` for loading skeletons;
  returns `not_ready` rather than a partial list and `error` with Delta's message (e.g.
  `SFAF001`) rather than zero flights. Rows missing flight numbers, airports, times or
  duration are skipped and counted in `skipped_rows`.

### select_fare

Registered on the results page. `{result_index, brand_code, expected_flight_numbers?}`; refuses
with `row_changed` if the row shows other flights and `not_available` for sold-out cells. It
clicks the price block (the brand-name link inside the cell opens a Flight Details modal).

- Outbound results: Delta opens `#idp-upsell-drawer-id` inside that row on the same document.
  Main offered Basic / Classic / Extra; Comfort offered Comfort Basic / Classic / Extra on one
  row and Classic / Extra on others; First offered Classic / Extra. The tool returns each
  experience's code, name, tagline, price, detail lines (footnote `<sup>` and labels such as
  "Round Trip From" removed), `seats_left`, and `requires_accepting_restrictions`. Calling it
  again for the already-selected cell (`is-selected`) does not close the drawer. Experience
  codes in the drawer (e.g. `CDCP` = Comfort Classic) are separate from column brand codes.
- Return results (round trips): the cells are already experience-specific ("Delta Main
  Classic", matching the outbound choice) and go straight to Trip Summary, so the tool
  schedules that click and returns `navigation_scheduled`.

### select_fare_experience

Registered on the results page. `{code, accept_restrictions?}` clicks
`#drawer-select-cta-{code}` after settling and returns `next_page`: `trip_summary`, or
`return_results` for a round trip's outbound. **Consent:** Basic experiences carry an "Accept
Restrictions" / "Accept Conditions" checkbox that must be ticked before Select works. Ticking it
agrees to the fare's restrictions (partial eCredit, change fee, last boarding, no miles or
upgrades, seats at check-in), so the tool returns `consent_required` and does nothing unless
`accept_restrictions: true` is passed, which its description reserves for when the user has
seen the restrictions and agreed.

### get_trip_summary

Registered on `https://www.delta.com/completepurchase/*` (Trip Summary and Review and Pay).
Reads `.summary-text__*` / `.flight-*` fields per slice (screen-reader prefixes such as "Flight
number" and operated-by `<sup>` footnotes removed) and `#trip-total-content .line-item`
totals (hidden "opens in a new popup", "(N Passenger)" and "N left at this price" removed;
the AMEX offer block is outside that panel). Returns `step`, `cart_id`, `slices`, `passengers`,
`price_lines`, `amount_due`, `currency`, `refundability`, and `warnings` when the amount is
missing or the lines do not add up.

### continue_to_review_and_pay

Registered on `https://www.delta.com/completepurchase/trip-summary*`. Schedules the
"Continue to Review & Pay" click; enters no data, adds no extras, cannot purchase. Delta moves
to Review and Pay with a same-document route change, so the tool stays listed there and
answers "Already on Review and Pay".

### get_page_context v2

- `page_type` includes `trip_summary`, `review_and_pay`, `confirmation`; `results_leg` is
  `outbound` / `return` on results pages; `cart_id` on checkout pages.
- `unsettled` / `unsettled_reasons` from indicators observed live: `document_loading`
  (`readyState`), `results_loading` (`idp-flight-row-skeleton`), `page_spinner` (`idp-spinner`,
  `.page-loader`, about 3 s between results and Trip Summary), `checkout_loading`
  (`.review-pay-loading-view`, `.spinnerView`, `.spinner-overlay`, about 1 s on Trip Summary),
  `busy_region` (`[aria-busy=true]`, `[role=progressbar]`). None were present on settled
  pages. `wait_for_settled_seconds` waits for no indicators and 1 s without DOM insertions.
- `pending_choice: "fare_experience"` while the drawer is open.
- `signed_in: false` also for a plain header "Log in" control; `true` for "Log out" / "Sign out".
- Delta styling classes named `*alert` (row date labels, seat badges) are not reported as
  `page_messages`.
- Suggestions follow the flow and, on cart pages, never suggest leaving the cart.

### Live checks and subagent QA (2026-09-30)

- Main: row DL 2441/DL 693 BMAIN → drawer Basic $399 (consent flag) / Classic $464 / Extra
  $554; `{code: "BMAIN"}` returned `consent_required` and left the box unticked; `{code:
  "CMAIN"}` reached Trip Summary; `get_trip_summary` returned Main Classic, $407.44 + $55.76 =
  463.20 USD.
- An independent WebMCP-only agent reached Trip Summary in 7 tool calls with no hand-written
  JavaScript (same itinerary and total).
- Four QA agents, run one at a time because they share one Chrome profile (Delta's search
  context and cart are shared), driving only xwebmcp tools and checking outputs against
  read-only screenshots of their own tabs:

| Test | Result | Fixed afterwards |
| --- | --- | --- |
| Main Basic with `accept_restrictions: true` | Pass: refused without consent; with consent reached Trip Summary; Main Basic, 398.20 USD matched the screen | next-step text tells agents to retry `get_page_context` once right after a navigation |
| Comfort and First | Pass for drawers and selection (Comfort Basic also needs consent) | `amount_due` null when a seat badge followed it; "DL 37331" from an operated-by footnote; consent wording |
| Round trip CVG⇄SFO | Reached Trip Summary with both slices | return results / direct return selection, `next_page`, `leg`, `results_leg`, `*alert` false positives, "Round Trip From" leakage |
| Review and Pay | Pass: same cart id, `review_and_pay` page type, safe suggestions, same lines | `amount_due` null (same cause); `continue_to_review_and_pay` answers on Review and Pay |

  After the fixes a round trip reached Trip Summary with both slices, "DL 5280" without the
  footnote, and amount due 777.40 USD with no warnings.

### Re-QA on xwebmcp with tool_ref-only invocation (2026-10-01)

After xwebmcp #95 (every tool, including cdp `search_flights`, listed and invoked by
`tool_ref`; clean extension reloads), five agents ran one at a time with the same rules:

| Test | Result |
| --- | --- |
| WebMCP-only end-to-end "earliest CVG→SFO tomorrow" | Reached Trip Summary: DL 2441/DL 693 Fri Oct 02 6:00am–10:21am, Main Classic, 398.20 USD; no missing tools |
| Main Basic consent (Oct 8; Delta offered no Main Basic on Oct 2) | Pass: refused without consent; with consent Trip Summary showed Main Basic, 291.16 + 47.04 = 338.20 USD |
| Comfort and First | Pass, no mismatches (Comfort Classic / Extra; First Classic / Extra) |
| Round trip | Pass: return results, `next_page`, `results_leg`, direct return selection, both slices on Trip Summary |
| Review and Pay | Pass: same slices and amount due (398.20 USD) on Trip Summary and Review and Pay |

Follow-ups applied: `experience_not_offered` with `offered_codes`; `basis_display` and
`badges` on experiences; deterministic sort tie-breaks; round-trip price note; B-prefixed
codes documented as Basic; next-step text aligned with xwebmcp #98's message for read-only
tools cut off by navigation and its re-matching on same-document route changes (which removes
`continue_to_review_and_pay` from Review and Pay).

## URL patterns

`login` is narrowed to the homepage (`https://www.delta.com/`, `/us/en`, `/us/en/`, each also
with `?*`) because it drives the homepage header flyout and should only be offered where that
flyout exists. `list_flight_results`, `select_fare` and `select_fare_experience` are narrowed to
`https://www.delta.com/flightsearch/search-results*`, `get_trip_summary` to
`https://www.delta.com/completepurchase/*`, and `continue_to_review_and_pay` to Trip Summary,
because they only work there. `search_flights`, `navigate_to_page` and `get_page_context` keep
the default domain-wide patterns.

## Sessions

- Development browser: `blp6z5n5xt2fuw0sf0pthv8u` (86,400-second inactivity timeout; left alive).
- Independent QA browser: `vw2lg1cj5leg275iuf5jmul1` (86,400-second inactivity timeout; left alive).
- Source: this repository is canonical; sessions expire but files do not. No credential-bearing live-view URL is stored here.
