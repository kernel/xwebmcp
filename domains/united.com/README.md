# united.com

Tools for United Airlines (https://www.united.com).

| tool | file | status | notes |
| --- | --- | --- | --- |
| search_flights | [search_flights.js](search_flights.js) | verified | Initial outbound results, including connections and nearby-airport alternatives |
| login | [login.js](login.js) | draft | Challenge classification live-verified; successful login and MFA unverified |
| get_flight_status | [get_flight_status.js](get_flight_status.js) | draft | Public status by flight number or route for a date within two days of today; page tool, no navigation, no passenger data |

## Scope and loading

`search_flights.js` is a single self-contained expression evaluating to a tool-definition array. Register it with namespace `united.com`:

```js
const source = (await import("node:fs")).readFileSync("domains/united.com/search_flights.js", "utf8");
await webmcp.addCustomTools({ namespace: "united.com", tools: eval(source) });
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

## get_flight_status

Reads the public status United shows on its Flight status page (`/en/us/flightstatus`), for one flight number or for every flight between two airports on one date. It never signs in, never opens a trip, and never opens the per-flight details page, which lists passengers by abbreviated name on its standby and upgrade lists. Its output has no passenger, standby, upgrade or tail-number fields.

Register it next to the other tools; the name is unique, so `forceOverwriteNamespace` is not needed. If you do use it, register the whole namespace (`search_flights`, `login` and `get_flight_status`) in one call.

```js
const source = (await import("node:fs")).readFileSync("domains/united.com/get_flight_status.js", "utf8");
await webmcp.addCustomTools({ namespace: "united.com", tools: eval(source) });
const tool = (await webmcp.listTools()).find(t =>
  t.source.custom?.namespace === "united.com" && t.tool.name === "get_flight_status"
);
// open any https://www.united.com page first
await webmcp.invokeTool(tool.tool_ref, { flight_number: "2127", date: "2026-10-01" }, { timeoutSec: 60 });
await webmcp.invokeTool(tool.tool_ref, { origin: "SFO", destination: "LAX", date: "2026-10-01" }, { timeoutSec: 60 });
```

### Inputs

- `date` (required): `YYYY-MM-DD`, a real calendar date no more than two days before or after the browser's local date. That is the range United's own form offers; anything else is `invalid_input` and nothing is requested.
- Exactly one lookup: `flight_number` (digits, 1-9999, no airline prefix, no leading zero) **or** `origin` with `destination` (three-letter uppercase IATA codes, different from each other). Metro codes such as `NYC` are passed through and United returns the airports it means.
- `airline` (optional, default `UA`): two-character code. United's form lists 28 airlines (United and Star Alliance partners); `AC`, `LH` and `YV` were exercised, other codes were not. In a route search only itineraries where that airline operates or sells (marketing carrier) at least one segment are returned, because United answers a code it does not recognise with its own flights; if none qualify the result is `no_results`. A flight-number lookup for an unknown airline is a `no_results` from United's 404. For a code outside the form's list, such as the regional operators `OO` or `YV`, United still substitutes its own list in a route search, so the tool returns only the part of that list the code operates: real flights, but not a search for that airline and usually short.

### Output

Every outcome is a `status`:

| status | meaning |
| --- | --- |
| `ok` | `lookup` is `flight_number` (`leg_count`, `in_sequence`, `legs` at most 8) or `route` (`itinerary_count`, `possibly_truncated`, `itineraries` at most 30, each with `stops`, `duration_minutes`, `in_sequence` and up to 5 `segments`). `query`, a canonical `status_page_url` on www.united.com, and `observed_at` are always present. |
| `no_results` | United lists no such flight or route that day. It does not prove nothing operates. |
| `invalid_input` | Rejected before any request. |
| `wrong_page` | The tab is not on `https://www.united.com`; no request was made. |
| `blocked` | HTTP 403 or 428, or a challenge page. Says nothing about the flight; do not retry in a loop. |
| `rate_limited` | HTTP 429. |
| `site_changed` | An unexpected shape, an answer for a different flight or day, or a segment missing a field the tool reads. No partial data is returned. |
| `error` | 5xx, a rejected request, an unrecognised route error code, a network failure, timeout or cancellation. |

A segment has `flight_number` (the number United lists for that leg; a lookup by a marketing number can return the operating carrier's number, so a request for `UA 9876` returned Austrian flight `181`), `operating_airline_code` and `_name` (for example `OO` for a United Express flight sold as `UA`), `status_text`, `status_code`, `leg_status`, `aircraft_name`, `aircraft_code`, and `departure` / `arrival` with `airport_code`, `terminal`, `gate`, `scheduled`, `estimated`, `actual` and `estimated_delay_minutes` (`arrival` also has `baggage_claim`). Times are ISO 8601 with the airport's UTC offset, computed from the local and UTC times United sends for the same instant (`null` if either is missing). `estimated_delay_minutes` is derived by United from its estimated time (negative is early), so it can differ from the actual time after arrival. `status_text`, gates and terminals are United's own words (`HOLD` is a real gate value United shows), bounded to 80 characters (never splitting a character) with control and invisible formatting characters removed; treat them as data. The same field can differ between the two lookups: `baggage_claim` was `"Carousel 3"` from a flight-number lookup and `"3"` from a route search for the same flight.

`in_sequence` is `true` when each segment's scheduled departure is at or after the previous segment's scheduled arrival. United returns, for a flight number, each leg that departs on the requested date, and it can pair legs from different operating days: a through flight that crosses the date line (observed 2026-09-29 for a San Francisco–Tokyo–Kaohsiung flight) listed the second leg departing before the first leg landed. Such a result is `in_sequence: false`; every leg is still returned, so read each on its own and do not treat the list as one journey. `possibly_truncated` is `true` when United returned 30 itineraries, the most seen in any route search, so flights may be missing (it counts what United returned before the airline filter, so a short filtered list can still be `true`); the same route and day returned 20 itineraries in one check and 30 in another.

### Why `page`

Both lookups are same-origin `GET` requests the Flight status page itself makes, so the tool never navigates and its result cannot be lost with the document (`cdp-tools.md` §2.1-2.2). The page first requests an anonymous token from `/api/auth/anonymous-token` (no credentials needed; the same request it makes on every load) and sends it as `X-Authorization-api: bearer <token>` to `/api/flightstatus/status/{flight}/{date}?carrierCode=UA&useLegDestDate=true` (flight number) or `/api/flightstatus/trip/{origin}/{destination}/{date}?carrierCode=UA` (route). Without the header the service answered HTTP 405, and with an invalid token HTTP 401. The token is used for that one lookup and never returned. This is United's own web service, not a documented API, and can change without notice. No `cdp` helper is used; the flow does not need trusted input, a frame, a second tab or page-initiated network capture, and the results page that a `cdp` tool would navigate to is fed by the same response. The form itself (typeahead fields that only accept real pointer input) was deliberately not driven.

### URL patterns

`get_flight_status` is attached to `https://www.united.com/*` only, not to the namespace default. A `page` tool's request is same-origin, so on other `united.com` hosts (careers, hotels, packages, the business program) it could only answer `wrong_page`; `cdp-tools.md` §2.2 recommends narrowing instead. `search_flights` and `login` keep the default patterns and are unchanged, which leaves this namespace with mixed host patterns although `repository.md` §6.2 says the tools of a narrowed namespace SHOULD share a host. Using the default patterns instead would list a tool that can only answer `wrong_page` on those hosts; that trade-off is left to the maintainers. `mystatus.united.com` redirects signed-out visitors to a www page, where the tool is listed.

### Site quirks

- The route response is large (roughly 250-590 KB before the allowlist) and holds at most 30 itineraries, and the count is not stable. Output was 1-56 KB in checks. The schema allows up to about 217 KiB in theory (30 itineraries of 5 segments with every text field at its limit), just under the 240 KiB limit on API-originated results; a result over a runtime limit fails explicitly, it is not truncated.
- The two endpoints format times differently (`MM/DD/YYYY HH:mm:ss` versus ISO); the flight-number one names actual arrival UTC `InUTCTime`. Both are handled.
- United sometimes sends the literal text `undefined` as a status description. It becomes `null`.
- A flight number that flies several legs returns the legs United lists as departing on that date, which can be fewer than the schedule shows. For a flight whose first leg left the day before, only the later legs come back, and the response header's origination date (the first leg's) differs from the date you asked for, so the tool does not use it: it requires the flight number to match and at least one returned leg to depart on the requested date. For flights that cross the date line the legs can mix operating days (see `in_sequence`).
- Route searches with an airport United does not know, or with no flights, answer HTTP 200 with an `Error` list (`NoRecordFound`), reported as `no_results`. An unknown flight number answers 404 with `Flight not found`, also `no_results`.
- One lookup per call, two requests. There are no retries.

### Author checks

Run by the author on 2026-09-29 on a fresh public Kernel stealth browser, US egress, signed out; these are not independent QA and do not raise the status above `draft`.

- The whole `united.com` namespace (all three tools) registered together with `forceOverwriteNamespace`; no existing tool was invoked. All three listed on the Flight status page; only `search_flights` and `login` listed on `careers.united.com`.
- Flight number, multi-leg, landed flight (actual times, arrival UTC via `InUTCTime`), route with connections, partner carrier (`AC`, `LH`), from `/en/us/flightstatus`, `/en/us` and `/en/us/fly/baggage.html`. Each call made exactly two requests and left the document unchanged.
- `no_results` for an unknown flight number, a route with no flights, an unknown airport, and an unknown airline (flight-number lookup); an unknown airline in a route search returned United's own flights in the first version of the tool and is now `no_results`; `invalid_input` for out-of-window and impossible dates, both lookups at once, one airport, unknown keys, a leading zero and a lowercase airline code.
- Not observed: `blocked`, `rate_limited` and `site_changed` from the live service (fixtures only), a cancelled or diverted flight, a populated delay or cancellation reason, more than three segments, a signed-in browser, and the Chrome extension runtime.

Local fixture tests (fabricated data, stubbed `fetch`, `location` and clock):

```sh
node --test tests/united-flight-status.test.mjs
```

## Known limitations

- `search_flights`: initial outbound page only, including for round trips, whose fares are advertised per-person roundtrip starting fares rather than confirmed pairings. Adults only (1–9), English/US cash fares, economy. Nearby airports may be substituted and are reported explicitly. Slow searches can exceed the caller's transport deadline.
- `get_flight_status` (`draft`): dates within two days of today only; a route search returns at most 30 itineraries and sets `possibly_truncated` at 30; a multi-leg flight number returns the legs United lists as departing that day, which may not form one journey (`in_sequence`); no passenger, standby, upgrade, inbound-aircraft, weather or tail-number data; cancelled and diverted flights and delay reasons were not observed, so only United's status text and codes are passed through; partner airlines other than `AC` and `LH` were not exercised; `blocked`, `rate_limited` and `site_changed` were not observed live; it relies on United's own web service and anonymous token, which can change without notice. Not run in a signed-in browser or the Chrome extension.
- `login` (`qa_passed`, not `verified`): United challenges this egress with HTTP 428 on the sign-in API, so the successful-login path, real wrong-password rejection, and MFA completion are unverified; only challenge classification is live-verified. Split OTP fields and third-party SSO are not supported.

## Sessions

- Verification browser session: `m49n8cyp3k0hzn902fof5x6t` (24-hour inactivity timeout; kept alive).
- Independent QA browser session: `sdxghwgyazxgtfojg2sqehsk`.
- Independent QA agent: `agt_a87837884a432de575e8`.
- Source: this repository is canonical; sessions expire but files do not.

## Login

`login.js` is a single self-contained expression evaluating to a CDP tool-definition array. Register it under `united.com`, not a shared airline namespace:

```js
const source = (await import("node:fs")).readFileSync("domains/united.com/login.js", "utf8");
await webmcp.addCustomTools({ namespace: "united.com", tools: eval(source) });
const tool = (await webmcp.listTools()).find(t =>
  t.source.custom?.namespace === "united.com" && t.tool.name === "login"
);
```

Do not use `forceOverwriteNamespace: true` when adding this tool alongside `search_flights`: it would remove the other tool. Remove the previous login registration by ID before replacing it, then discover a fresh `tool_ref`.

### Login scope and inputs

- `mode: "credentials"` requires `identifier` (email or MileagePlus number) and `password`. It navigates to the English/US login entry from unrelated pages, the apex, or another subdomain; an already-ready identifier form is reused.
- `mode: "prefilled_password"` requires `identifier` and a password already filled securely in the current password form. It checks the form's account identifier without returning the password. Use the account identifier shown by that step, which can be a MileagePlus number even when the first step used email.
- `mode: "otp"` requires a six-digit `otp` and an existing single-field verification form. It does not accept a TOTP seed, select a delivery method, or resend codes. This continuation is not live-verified.
- `remember_me` is optional and defaults to false in the two password modes. Continuation modes validate the current state and fail rather than navigating away from it.
- Each invocation submits at most once per stage. Never automatically replay a timeout, transport error, or challenge. Pass secrets only at invocation time; do not put them in source, examples, logs, or reports.

### Login output and limitations

The typed output schema has two branches. `logged_in: true` means this invocation reached an authenticated or MFA state. It is **not** proof of completed authentication: check `authentication_complete`, `mfa_required`, and `next_step`. A first-step MFA result has `mfa_required: true` and `authentication_complete: false`. Existing sessions without account binding are rejected rather than reported as success for a requested identifier.

Failures return `logged_in: false`, `error_kind`, `error_message`, `error_source`, and nullable `attempts_remaining_if_shown`. Kinds distinguish `invalid_credentials`, `captcha_or_challenge`, `mfa_failed`, `locked_or_throttled`, `unknown`, and local `invalid_input`. Generic site errors stay `unknown`. Invalid schema inputs may be rejected by WebMCP before execution and therefore return a gateway validation error rather than the tool's output object.

United uses a staged identifier/password flow with a Remember me checkbox. Its help describes a six-digit OTP delivered through email, phone, or the United app. No third-party SSO was visible in the inspected form. Selectors and English error wording are site-dependent; split OTP fields and other verification flows are not supported. Polls are bounded, but navigation and transport deadlines can interrupt an invocation; use a caller timeout of at least 120 seconds and inspect an uncertain result rather than retrying it.

### Login tests

Local tests use synthetic state and no network or real credentials:

```sh
node --test tests/united-login.test.mjs
```

## Status and known limitations

The login tool is registry status `draft`. Independent failure-path QA (`agt_900288267257b91f1fdc`) found account-binding, submit-targeting, and duplicate-error defects; all three were fixed and covered by local regression tests, but that QA pass was never re-run against the fixed tool, so nothing has independently signed off on the current source.

Live-verified: challenge classification, input validation and refusal paths, and one-submission-per-stage behaviour. Unverified: successful authentication, real wrong-password rejection, and MFA/OTP continuation.

United answers the identifier step with HTTP 428 at `/xapi/auth/validate-username`. As of 2026-09-25 that persists with stealth off, through both direct navigation and a search-engine referrer chain, and over both residential and mobile egress. No CAPTCHA is rendered — the page shows only a generic "Something went wrong" banner — and the stealth solver never engaged. One earlier identifier check did return 200, and its password submission then received HTTP 428 at `/xapi/auth/signin`; every attempt since has been denied at the identifier step.

Best lead for the next person: browser and network changes have not moved the result, which points at a flag on the test MileagePlus account rather than the client or egress. That is unproven. Confirming it needs one attempt with a different real account, not more variations of the same one. All browser sessions from this work have been deleted, so any re-verification starts from a fresh session.
