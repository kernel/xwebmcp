# aa.com

Tools for American Airlines (https://www.aa.com).

| tool | file | status | notes |
|---|---|---|---|
| search_flights | [search_flights.js](search_flights.js) | verified | First-page outbound options; round-trip fares do not select a return flight. |
| login | [login.js](login.js) | qa_passed | CAPTCHA explicitly requires human assistance; manual-login browser prepared, full authentication pending. |

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

## Sessions

- Development and migration-verification browser: `qer6pzs0jzhw3r5j9bx7yse4` (24-hour inactivity timeout, left alive).
- Independent QA browser: `herknyf87s7zdzhwscc6g224` (24-hour inactivity timeout, left alive).
- Independent QA agent: `agt_dbdb039786be4bed1121`.
- This repository is canonical; browser sessions and registrations expire, but the source does not.

## Login scope and loading

`login.js` is a self-contained tool-definition array. Register it with namespace `aa.com`, using `tools: eval(source)` as above. Omit `forceOverwriteNamespace` when adding it alongside the search tool so the other registration is not removed. Both apex and wildcard subdomains match; the actual sign-in flow redirects from `www.aa.com/loyalty/login` to `login.aa.com/login`.

The tool checks the current page before interacting. From an unsuitable page, including another subdomain or unrelated origin, it opens `https://start.duckduckgo.com/`, issues the fixed public query `american airlines login` through the search URL, and clicks the first organic result. It proceeds only if that result is `https://www.aa.com/loyalty/login` or `https://login.aa.com/login`; changed rankings, unrelated destinations, and unavailable results return typed `unknown` without filling or submitting. The search query contains no account input, and no referrer header is spoofed. A suitable existing login form or MFA screen is reused. A detected CAPTCHA stops the flow before any search navigation, filling, or further submission; the referrer route is never retried to work around a challenge. Supply an AAdvantage number or username and password, explicitly set `use_prefilled: true` after a human or vault fills both fields, or use `manual_assist: true` for observation only. Prefilled mode cannot recover values lost when an unsuitable page is replaced. The tool does not support email identifiers, OTP submission, MFA-method selection, account recovery, or account registration. Automated CAPTCHA solving and bypass are intentionally not implemented; manual assistance is the supported path. Run in a headful, solver-free browser (`stealth: false`) and verify that no CAPTCHA-solving extension is loaded. No remember-me or third-party SSO control was observed.

The output schema separates `authenticated`, `mfa_required`, `human_assist_required`, and `failure` outcomes rather than treating login as binary success/failure. `first_step_succeeded: true` with `mfa_required: true` means the credential stage reached MFA, not a fully authenticated session; `logged_in` stays false until authentication completes. `observation` and `submission_attempted` distinguish a pre-existing screen from this invocation's result. A pre-existing account or MFA screen is not proof that the supplied account was authenticated.

CAPTCHA is a distinct `human_assist_required` outcome with `reason: captcha_or_challenge`, `logged_in: false`, the observed message, a query-free landing URL, and `next_step: complete_login_manually_in_browser`. It is not an invalid-credentials error or an instruction to retry. `manual_assist: true` can also return this outcome with `reason: manual_login` when login is still needed. This intentionally changes the earlier CAPTCHA failure output; callers must handle the new branch.

Failures distinguish `invalid_credentials`, `mfa_failed`, `locked_or_throttled`, and `unknown`, plus local `invalid_input` and `submission_already_attempted`. Site evidence is returned separately from tool-generated diagnostics. Remaining attempts are null unless explicitly shown. The tool does not return filled field values.

### Login quirks and safety

- Inputs are nested in open `adc-text-input` shadow roots. Inner IDs are randomized; the implementation finds visible inputs by their stable `username` and `password` names, uses the native value setter, and dispatches composed input/change events. Length equality is checked before proceeding, without returning field values.
- The `Log in` control is an `adc-button` host with an inner shadow-root button. A rendering race previously checked it before the application enabled it. The fixed implementation polls for up to 10 seconds, returning typed `unknown` without submission if readiness never arrives.
- A sessionStorage marker is written before the single click. Re-invocation in that login tab cannot submit again. This guard does not cover another tab or cleared browser storage; callers must enforce account-wide attempt limits. Unknown outcomes must not be retried automatically.
- Post-submission observation lasts up to 45 seconds only while no terminal state is visible. CAPTCHA returns immediately on its first observation: there is no solver grace period, automatic solution, bypass, retry, or credential guessing/enumeration. The observed challenge is a visible iframe titled `Challenge Content`, served from `/challenge-assets/v7/captcha.html`; `Loading...` is not authentication success or evidence of bad credentials. Search-result readiness is bounded to 20 seconds. Invoke with `timeoutSec: 180` and a sufficiently long enclosing REPL timeout to cover search navigation, form preparation, and post-submission observation.

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

The successful manual search-entry sequence is now implemented for tools invoked from unsuitable pages. The packaged route and corrected wording have local regression coverage; the automated search-entry code has not been followed by an additional live credential submission. The existing independent QA reference predates this change.

Referrer experiment browser: `bqpgqp8xwmh46xu6addo3je1` (left alive at MFA with a 24-hour inactivity timeout). These historical matrix and referrer experiments predate the explicit no-solving policy. They were not repeated for the manual-assist change.

### Supported manual-assist path

1. Open a dedicated headful browser with `stealth: false`, no CAPTCHA solver extension, and a 24-hour inactivity timeout. Give the human its private live view through the caller's secure browser handoff, not through repository content. Do not log credentials or enable authentication network-body capture.
2. Let the human complete login, any CAPTCHA, and MFA in that browser. The automation does not solve the challenge, select MFA delivery, register an account, guess credentials, or resubmit after handoff.
3. Invoke `login` with `{ manual_assist: true }` to inspect the existing page. This mode never navigates, fills, clicks, or submits; it reports the current handoff, MFA, or authenticated state. An authenticated result still requires positive account UI, not merely the absence of a form or presence of cookies.
4. Only after human confirmation and verified authentication, capture the identified AA session cookie/token in private browser runtime memory or a separately approved secure store if needed. Cookie presence alone does not identify an authentication token; do not mistake analytics or challenge cookies for it, assume there is a single transferable token, or dump all browser cookies. Never return session-token values in the tool output, chat, logs, tests, README, or PR. The tool intentionally does not export tokens.
5. Keep the authenticated browser alive for authorized continuation. Do not clear its challenge or session state to restart automation. Any subsequent action remains subject to the human's authorization.

Manual-assist browser: `bjcsg0na3ht6hklf6v2ziamo` (24-hour inactivity timeout; only the Kernel extension was observed, no CAPTCHA solver). The registry now points to this browser. Live `{ manual_assist: true }` inspection returned `human_assist_required`, `reason: manual_login`, and `submission_attempted: false`. The human has not yet completed this session's login, so token capture and full authentication are **pending**, not claimed as tested. No additional credential submission was made for this change.

Local regressions cover immediate frame/text CAPTCHA handoff, no navigation from an existing challenge, manual inspection without side effects, and the authenticated-after-human-login output using synthetic UI. Live CAPTCHA evidence remains the earlier challenge observations; the new branch does not claim a new independent QA pass.

```sh
node --test tests/aa-login.test.mjs
```
