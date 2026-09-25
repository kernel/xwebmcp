# delta.com

Tools for Delta Air Lines (https://www.delta.com).

| tool | file | status | notes |
| --- | --- | --- | --- |
| search_flights | [search_flights.js](search_flights.js) | qa_passed | Independent targeted QA passed; successful full live invocation remains blocked by intermittent HTTP 429 responses. |
| login | [login.js](login.js) | draft | Unit-tested and exercised live on two egresses. Both live attempts reached the form and submitted once; Delta answered with its own "login is unavailable right now" message, so no successful login has been observed. |

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

## QA summary

Independent QA agent: `agt_b189571b6d300a05921c`, three passes on 2026-09-24. No actionable defect reproduced in the final targeted regression cases. This is **qa_passed**, not **verified**: there is still no successful final full-tool live invocation.

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

- `search_flights` is `qa_passed`, not `verified`: a successful full live invocation is still blocked by intermittent Delta HTTP 429 / `SFAF001` responses. The live check reached results and preserved the explicit error shape; it did not return flights.
- First results page only; round trips return outbound options, not outbound/return pairs. Prices are rounded display fares, not passenger totals.
- Adults only (1–9), 330-day booking window, English desktop layout only.
- Completeness beyond the 1.5-second DOM-quiescence heuristic and real zero-results behaviour remain unverified.
- `login` is `draft`: not independently QA-tested. Every Kernel browser tried gets Delta's "login is unavailable right now"; a successful login, an MFA step, and a real captcha are unverified. See the login section below.

## login

`login` signs in with a SkyMiles number or username and password. It performs at most one
submission per invocation and never retries. Two modes:

- `credentials` — enters the site through a DuckDuckGo search result, then fills and submits
  the Delta login form.
- `prefilled_password` — submits the login form that is already visible and filled on the
  current Delta page, without reading the value and without navigating anywhere.

`status: "success"` means this invocation's submission reached authenticated or verification
UI. `authentication_complete: false` with `mfa_required: true` is a first-step success, not a
completed session. Failures are explicit: `error_kind` plus `failed_step`, `error_source`
(`site` or `tool`) and `submitted`, so a caller can always tell whether a password actually
reached Delta. A captcha or bot challenge is reported as `error_kind: "captcha_or_challenge"`.

### Status and known limitations

**Draft.** Not independently QA-tested; last live check 2026-09-25.

- **Live-verified:** search-result entry reaches `https://www.delta.com/skymiles/login` on
  residential and mobile egress, the form fills, exactly one submission happens, and the
  failure reports the step and `submitted: true`.
- **Unverified:** a successful login, an MFA step, and a real captcha. Every Kernel browser
  tried, including one with no profile attached, gets Delta's "login is unavailable right now"
  while the same credentials work in an ordinary browser.
- **Lead for the next person:** profile state is ruled out, so the block keys on egress or the
  browser fingerprint. Compare what Delta's login page collects from a Kernel browser against an
  ordinary browser, without submitting, before spending more real attempts; each one counts
  against the account's lockout budget.

### Search-result entry path

In `credentials` mode the entry path is DuckDuckGo only. The tool opens
`https://start.duckduckgo.com`, searches (default `delta skymiles login`), and clicks the
first organic, non-ad result whose host is `delta.com` or `www.delta.com`, arriving with
`document.referrer` set to `https://duckduckgo.com/`. The first organic result is the
dedicated login page `https://www.delta.com/skymiles/login`, which renders `#userId-input`
and `#password-input` directly, so no homepage login popup is involved.

There is deliberately **no direct-navigation fallback**. Each entry step fails with its own
`error_kind` — `search_engine_unreachable`, `search_box_missing`, `search_results_missing`,
`no_delta_result`, `entry_navigation_failed` — and the tool never silently reaches Delta another
way. Every one of those failures is returned before any credential is typed.

Because `match.url_patterns` is Delta-only, the tool is listed and invocable **only while the
browser is already on a delta.com page**. That is a registration precondition, not the login
entry path: on invoke the tool leaves for DuckDuckGo and re-enters through the search result.

### Entry-path comparison

Same implementation of the form interaction, same profile, same credentials, one submission per
run. Direct navigation is the earlier baseline; search-result entry is the current tool.

| entry path | egress | form reached | submitted | outcome |
| --- | --- | --- | --- | --- |
| direct navigation | residential | yes | yes | Site answered "login is unavailable right now". |
| direct navigation | mobile | no | no | Login form not ready within a 15-second budget; the form was present on later inspection. |
| search result | residential | yes | yes | Site answered "login is unavailable right now". |
| search result | mobile | yes | yes | Site answered "login is unavailable right now". |

The search-result path is what changed the mobile-egress run from "never reached the form" to
"reached the form and submitted". It did not change Delta's answer on either egress, so it is not
evidence that the search referrer defeats a site-side block. The readiness budget was also raised
from 15 seconds to 45 seconds of polling (plus 20 seconds after an in-page login trigger), which
is the other reason the mobile run no longer reports a false timeout.

### Profile state is not what Delta is keying on

Every attempt above ran in a browser with a saved, reused profile, so the obvious suspicion was
that Delta had flagged that profile's cookies. A control run says otherwise.

| profile | egress | form reached | submitted | outcome |
| --- | --- | --- | --- | --- |
| saved, reused | residential | yes | yes | "login is unavailable right now" |
| saved, reused | mobile | yes | yes | "login is unavailable right now" |
| none, clean browser | mobile | yes | yes | "login is unavailable right now" |

The same account and password sign in normally in an ordinary incognito window on a personal
machine, so neither the credentials nor Delta's login service is the problem. A profile-free
browser carrying no cookies and no history gets the identical refusal. That rules out cookie or
profile contamination and points the signal at something every automated run shares regardless of
stored state: egress reputation or the browser's own fingerprint. Rotating profiles or clearing
cookies is not a fix here, and the same control is worth running before blaming profile state on
any other airline.

### Site quirks

- Delta answers some login submissions with `We're sorry, but login is unavailable right now.`
  This is a site-side condition rather than a credential verdict; it classifies as
  `error_kind: "unknown"`, `error_source: "site"`, `submitted: true`, with Delta's exact wording
  preserved in `error_message`. Do not read it as a wrong password and do not retry in a loop.
  It also does not mean Delta login is down: the same credentials succeed in an ordinary browser
  at the same time. Read it as Delta declining this particular client.
- Wrong credentials produce `Login credential is incorrect. Please try again.`, which classifies
  as `invalid_credentials`. Real accounts lock out, so the tool submits once per invocation.
- The login page keeps a stale error banner visible after a failed attempt. Reload the entry
  before another attempt rather than resubmitting over a stale banner.
- Delta exposes no remember-me control and no automatable OTP step, so neither is implemented.
  An MFA step is reported back to the caller as a first-step success.

### QA

Not independently QA-tested; this is **draft**. What was exercised:

| Check | Evidence |
| --- | --- |
| Input validation | Four rejected shapes return `invalid_input` at `failed_step: "input"` with no navigation. |
| Entry-step failures | Five synthetic cases (unreachable engine, missing search box, missing results, no delta.com result, navigation that never reaches delta.com) each return their own `error_kind`, `submitted: false`, and only ever navigate to `https://start.duckduckgo.com`. |
| Site-error classification | `invalid_credentials`, `locked_or_throttled`, `mfa_failed`, the login-unavailable text, and a shown attempt count classify from real Delta wording. |
| Challenge handling | A challenge before submitting stops with no credential fill; a challenge after submitting reports `submitted: true`. |
| Success branches | Completed authentication and a verification step map to the two success sub-branches; a pre-existing signed-in page is not reported as this invocation's success. |
| `prefilled_password` | Never navigates, requires a filled visible form, and submits once. |
| Live, residential egress `76.46.4.177` | Search entry reached `https://www.delta.com/skymiles/login`, submitted once, site returned the login-unavailable message. |
| Live, mobile egress `99.74.53.113` | Same, from an independent browser running the identical implementation. |
| Live, mobile egress `172.56.29.114`, no profile | Same, from a browser with no profile attached; see the profile-state control above. |

Both live runs executed this file's logic; the committed version differs from the one that ran
only by an indentation change made afterwards. No captcha telemetry was recorded in either live session. A successful login, an MFA step, and a
real captcha remain unverified.

## Sessions

- Development browser: `blp6z5n5xt2fuw0sf0pthv8u` (86,400-second inactivity timeout; left alive).
- Independent QA browser: `vw2lg1cj5leg275iuf5jmul1` (86,400-second inactivity timeout; left alive).
- Source: this repository is canonical; sessions expire but files do not. No credential-bearing live-view URL is stored here.
