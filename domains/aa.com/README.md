# aa.com

Tools for American Airlines (https://www.aa.com).

| tool | file | status | notes |
|---|---|---|---|
| search_flights | [search_flights.js](search_flights.js) | verified | First-page outbound options; round-trip fares do not select a return flight. |
| login | [login.js](login.js) | qa_passed | DDG-only entry; CAPTCHA is a typed failure. Full authentication remains unverified. |

## Scope and loading

`search_flights.js` is a single expression returning the tool-definition array, with no imports or external dependencies. Register it with namespace `aa.com`:

```js
const source = (await import("node:fs")).readFileSync("domains/aa.com/search_flights.js", "utf8");
await webmcp.addCustomTools({
  namespace: "aa.com",
  tools: eval(source),
  forceOverwriteNamespace: true,
});
```

The CDP tool matches `https://aa.com/*` and `https://*.aa.com/*`. It checks the current origin, path, form action, and visible enabled search controls. If the page is unsuitable, it navigates to `https://www.aa.com/homePage.do` before interacting with the form. It does not depend on prior search state.

Inputs are uppercase IATA codes, ISO dates, `roundTrip` or `oneWay`, and 1–9 adult passengers (default 1). Round trips require a return date; one-way searches reject one. Runtime date validation permits today through 331 days ahead, using UTC dates. This is a cash-fare search, not an award search. It never selects a fare, books, pays, or enters personal data.

Outputs include every rendered first-page option, result counts, the results URL, marketing flight numbers/carrier codes, published operator labels, transport modes, local departure/arrival times, arrival-day offset, duration, stops, and the lowest displayed per-person from-fare. A displayed `$` is preserved as a currency symbol rather than guessed to mean a particular ISO currency. Round-trip prices do not identify a selected return itinerary or guarantee the total for all passengers.

## Site quirks

- Results render client-side. The tool waits for result/error signals, with a 105-second execution budget; invoke with `timeoutSec: 120`. Await the invocation in the same REPL cell, configured with enough execution time. Use a dedicated tab and invoke serially.
- American can include nearby airports and airline-marketed buses. Check each row's `matchesRequestedAirports` and `transportTypes`, plus `exactMatchCount` and `nearbyAirportCount`. `alternatives_only` means none of the returned rows matches both requested airports.
- `no_results` requires an explicit empty-state signal. Challenges and access denial return `blocked`; missing results return `timeout`; validation or parsing failures return `error`. An empty failure output is not evidence of no availability.
- Non-stealth sessions encountered human verification. Stealth enabled successful searches but did not prevent later access denial. Connection failures also occurred on long-haul round-trip searches.
- A one-way radio reset was observed intermittently. The tool waits for homepage load and reasserts the requested trip type before validating the form. Repeated independent verification of that mitigation was prevented by access denial.

## QA summary

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
- Adults only (1–9); no children, infants, award searches, or later result pages.
- Nearby-airport and bus alternatives can be returned; check `matchesRequestedAirports`, `transportTypes`, and `exactMatchCount` before treating a row as an exact match.
- American serves human-verification and access-denial pages; these return `blocked`, and a long-haul round trip can also fail on connection errors.
- Independent repeated-transition coverage of the trip-type radio mitigation and long-haul round-trip coverage remain incomplete.

## Sessions

- Development and migration-verification browser: `qer6pzs0jzhw3r5j9bx7yse4` (24-hour inactivity timeout, left alive).
- Independent QA browser: `herknyf87s7zdzhwscc6g224` (24-hour inactivity timeout, left alive).
- Independent QA agent: `agt_dbdb039786be4bed1121`.
- This repository is canonical; browser sessions and registrations expire, but the source does not.

## Login scope and loading

### Status and known limitations

`qa_passed`: independent QA passed the frozen behavior locally (208 repository tests and 22 additional checks). Last real live check: **2026-09-25**. Live DDG entry reached the login form, and an earlier referred submission reached MFA. Full authentication and live solver completion remain unverified; historical direct entry encountered CAPTCHA. All login-work browsers and their artifacts were deleted at closeout.

Most useful lead: MFA delivery selection is the furthest verified credential-flow stage. A future authorized end-to-end check should retain the DDG organic-click entry and verify progression from MFA to actual account UI; do not treat MFA alone as logged in.

`login.js` is a self-contained tool-definition array. Register it with namespace `aa.com`, using `tools: eval(source)` as above. Omit `forceOverwriteNamespace` when adding it alongside the search tool so the other registration is not removed. Both apex and wildcard subdomains match; the actual sign-in flow redirects from `www.aa.com/loyalty/login` to `login.aa.com/login`.

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
