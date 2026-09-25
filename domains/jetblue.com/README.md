# jetblue.com

Tools for JetBlue (https://www.jetblue.com).

| tool | file | status | notes |
|---|---|---|---|
| search_flights | [search_flights.js](search_flights.js) | verified | Initial outbound flight cards, including round-trip searches; 1–7 adults |
| login | [login.js](login.js) | qa_passed | Email-MFA first step live-observed; completion pending code entry |

## Scope

- Namespace: `jetblue.com`. Matches `https://jetblue.com/*` and `https://*.jetblue.com/*`.
- The file is a single self-contained expression returning a CDP tool-definition array. Register it with `webmcp.addCustomTools({ namespace: "jetblue.com", tools: eval(source), forceOverwriteNamespace: true })`.
- Inputs: distinct uppercase IATA airports, a non-past ISO departure date, `one_way` or `round_trip`, an optional return date required only for round trips, and 1–7 adult passengers (default 1). Children, infants, points, and multi-city searches are not supported.
- Returns every flight card in the initial results batch, its airline and flight numbers, airports, local departure/arrival dates and times, duration, stops, lowest displayed cash fare, result count, results URL, and whether more cards can be loaded. Round trips return outbound options, not return-flight selections or whole-trip totals. The displayed dollar symbol is preserved without inferring an ISO currency or passenger-total basis.
- Read-only search: never selects a fare, loads another batch, books, enters personal data, or purchases. Use one invocation at a time per browser; the tool navigates the current tab.

## Site quirks

- Homepage airport fields use autocomplete: select the exact airport, not a metropolitan-area grouping. Dates accept `MM/DD/YYYY`; trip type and passengers have separate menus. The tool uses the observed booking URL parameters instead of depending on those controls.
- Invocation checks the current URL. The canonical homepage and flight-results path are suitable entry contexts; other pages first navigate to the homepage and wait for its origin input. Every invocation then navigates to a fresh search URL, even if the browser already shows results.
- Results render client-side in `.flight-result-item`. Wait on priced cards or the explicit no-flights message, not a fixed sleep. The initial batch is commonly ten cards; a “more flights” control exposes later options.
- JetBlue may add `IncludeBasic=true` to the URL. The tool verifies the requested parameters while permitting additional site parameters. Overnight `+1 day` markers are in `.arrival-offset`, outside the arrival-time element.
- The site can display “No flights have been found” when its inventory request fails. The tool requires a successful inventory HTTP response and transaction, matching outbound route/date, and agreement between empty/nonempty inventory and visible cards. HTTP failures, timeouts, malformed cards, and inconsistent results produce invocation errors, never successful empty output. Allow 120 seconds for invocation; controlled missing-inventory tests returned errors at about 95 seconds and failed page loads at about 100 seconds.

## QA summary

Independent QA completed three rounds on 2026-09-24. Every successful response was recursively checked against its output schema and compared with every visible initial flight card. No fare or load-more button was selected.

| Coverage | Result |
|---|---|
| Round trip, one way, short haul, long haul, near-term and June 2027 dates | Passed |
| Connecting flight numbers, stops, overnight dates, displayed prices, count and more-results flag | Passed |
| Default one adult, two/three adults, seven-adult boundary | Passed |
| Genuine empty inventory; blocked inventory twice and recovery searches | Passed; failures do not become `no_results` |
| Invalid dates, trip/date combinations, same airports, extra properties, invalid passenger counts | Rejected without navigation |

QA found and verified fixes for false empty results on inventory failure and an incorrect nine-adult maximum; earlier checks also corrected URL canonicalization and overnight-marker parsing. Transient network and site failures remain explicit errors. No actionable defect remained in the tested matrix.

The repository migration was live-verified on 2026-09-24 starting from `https://www.jetblue.com/travel-agents`, not the homepage. A two-adult JFK–LAX round trip for 2026-10-15 through 2026-10-20 returned ten complete outbound cards in 12.7 seconds, with both overnight arrivals dated 2026-10-16. The old `airline_tools` registration was removed. The registered definition and repository definition were compared byte-for-byte after serialization, including the execute function. The prior QA pass covered the search/parser; migration-specific entry routing was checked by local tests and this live invocation.

Run local contract/navigation tests from the repository root:

```sh
node --test tests/jetblue-search-flights.test.mjs
```

These use browser-helper stubs to check expression loading, matching, entry navigation from different hosts/pages, fresh search from suitable pages, and explicit failures. They do not replace live DOM or inventory QA.

## Sessions

- Verification browser: `fe509cugfxs9gqfs1wk1kkne` (24-hour inactivity timeout; left alive).
- Independent QA browser: `vcmmlsr2fph2ydejqtc1h6gs` (24-hour inactivity timeout; left alive).
- Independent QA agent: `agt_8da83a2e489269a5ff05`.
- Source: this repository is canonical; sessions expire but files do not. No authenticated browser URLs or credentials are stored here.

## Login scope

Register `login.js` with namespace `jetblue.com`. It is a single CDP tool-array expression matching the apex and all HTTPS subdomains. Loading one file with `forceOverwriteNamespace: true` removes other tools in that namespace; combine the search and login arrays when registering both.

The tool navigates from unrelated pages, the apex, subdomains, or non-login paths to the canonical `www.jetblue.com/signin` entry. An existing sign-in page is inspected first. Credentials are entered only on that canonical origin. The form calls the identifier **Username**; inputs are `username`, `password`, and optional `remember_me` (default false). Alternatively, `use_filled_form: true` submits an already-filled form without returning field values; it cannot be combined with explicit credentials. Use a fresh flow and allow 60 seconds for invocation.

The typed output distinguishes:

- `logged_in: true, authenticated: true, mfa_required: false`: a visible sign-out control and no password form.
- `logged_in: true, authenticated: false, mfa_required: true`: first-step acceptance with a visible verification prompt and code field or verification action. `next_step` is `complete_mfa`; this is **not** completed authentication.
- `logged_in: false`: `invalid_credentials`, `captcha_or_challenge`, `mfa_failed`, `locked_or_throttled`, `validation_error`, or `unknown`. Site wording is preserved; attempts remaining are null unless explicitly displayed. `submission_attempted` indicates whether the submit action may have started.

The tool makes at most one password submission and never retries it. Explicit credentials receive a pre-submit password-length check; matching length is not proof of character equality. Challenges stop the tool rather than being solved by it. The tool does not request verification emails, enter OTPs, complete MFA, or change credentials. On an existing MFA/authenticated screen, success describes the observed session, not proof that newly supplied credentials were checked.

### Login quirks and fixes

- Both the password and email OTP use `name="credentials.passcode"`. Password selectors now also require `type="password"`, so a code field cannot be mistaken for the password form or filled with a password.
- **Fixed:** the original classifier missed “Get a verification email” / “Send me an email” and returned `unknown` despite first-step acceptance. The repository version recognizes the email-send interstitial and the subsequent “Verify with your email” / “Enter the verification code” screen. Regression fixtures exercise the actual page-reader expression using the observed wording. The patched implementation has not received another live credential submission.
- **Fixed:** plain-text “Verify you are human” outside a heading or alert is recognized. Independent QA found this with a DOM fixture; a parent regression check passed after the fix.
- **Open:** a residential+stealth run did not retain the password during filling and stopped before submission. Its cause remains unconfirmed; the tool does not silently retry a fill or submit incomplete credentials.
- Expired flows display “You have been logged out due to inactivity.” This is `unknown`, not a credential judgment. An already-visible inactivity error stops before submission. A post-submit timeout also remains inconclusive; inspect the page before deciding whether a new test is appropriate.

### Login QA and configuration matrix

Independent failure-path QA used fabricated credentials only. Missing/empty/wrong-type inputs were rejected before submission, blank prefilled mode failed safely, and one live fabricated login returned the exact message “Unable to sign in” as `invalid_credentials`. Challenge and lockout checks used labeled DOM fixtures; real CAPTCHA, lockout, and MFA-error responses remain unverified. The generic sign-in message does not expose the provider's underlying reason.

Configuration checks on 2026-09-25 used separate browsers with the same profile source, vault attachment, and 24-hour timeout. Both ran Chrome 153.0.8010.36. No profile changes were saved, no submission was retried, and no CAPTCHA solver events were recorded in either run.

| Configuration | Submission count | Observed result |
|---|---:|---|
| Residential proxy, stealth enabled | 0 | Password fill/length check failed; `validation_error`; failed browser deleted |
| Mobile proxy, stealth enabled | 1 | Password-length guard passed; live email-MFA first-step success. Original tool returned `unknown` because it missed the interstitial; fixed as described above |
| Residential proxy, stealth disabled | 0 | Not run: matrix stopped after mobile first-step success |

The mobile session remains at email code entry after one separate verification-email request. Full authentication and code submission have not been verified. The repository migration and MFA fix are covered by local regression tests, not a new independent live QA pass.

Run `node --test tests/jetblue-login.test.mjs` for contract, navigation, single-submit safety, failure classification, and page-reader MFA fixtures. Run `node --test tests/*.test.mjs` for the repository suite. These tests use synthetic inputs and browser-helper stubs; they do not submit real logins.

Login verification session: `oh52hpvtipbx16z1hiqlj00n`. Independent failure QA agent: `agt_19fb8339edef5ff82a82`. Mobile first-step session: `qfxmqaoaejscs7qvkcln6ei9`. Session IDs are historical references and may expire.
