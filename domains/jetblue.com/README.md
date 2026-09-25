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

## Login status and known limitations

Status: `draft`. The independent QA pass covered failure paths on an earlier revision; the packaged DuckDuckGo entry has not had an independent pass.

- **Live-verified (2026-09-25):** a fabricated login returns `invalid_credentials` ("Unable to sign in"); real credentials reach the email-MFA first step (`mfa_required: true`) on mobile+stealth with direct entry and on residential+stealth after a manually driven DuckDuckGo entry.
- **Unverified:** the packaged DuckDuckGo entry end to end, MFA completion, and real CAPTCHA, lockout, or MFA-error responses. Residential without stealth was never run.
- **Known blocker:** the first live run of the packaged entry stopped at the search step with "DuckDuckGo search controls did not become available". DuckDuckGo's search box is not reachable with `document.querySelector`, although the accessibility tree exposes it as `combobox "Search with DuckDuckGo"`. The tool now waits on those accessibility nodes; that change has unit coverage only.
- **Next lead:** register `login.js` in a residential+stealth browser and invoke it once with fabricated credentials. Expect `invalid_credentials` after search entry. If it stops at the results step instead, the `[data-testid="result"]` selector needs the same accessibility-tree treatment.

## Login scope

Register `login.js` with namespace `jetblue.com`. It is a single CDP tool-array expression matching the apex and all HTTPS subdomains. Loading one file with `forceOverwriteNamespace: true` removes other tools in that namespace; combine the search and login arrays when registering both.

The tool enters through `https://start.duckduckgo.com/`, searches `jetblue login`, and clicks the **first organic result**, not an advertisement. It accepts that result only when it is `https://www.jetblue.com/signin` (optional trailing slash, no query or fragment), then verifies the actual DuckDuckGo document referrer before entering credentials. Unexpected results, search failures, missing referrers, and changed login destinations stop with a typed failure; there is no direct-navigation fallback or spoofed referrer.

There are no starting-page assumptions: unrelated pages, the apex, subdomains, non-login paths, and direct sign-in entries use the search route. A canonical sign-in page already reached through DuckDuckGo can be reused. Existing challenges, errors, MFA, or authenticated state are reported without restarting the flow. Credentials are entered only on the canonical sign-in page. Inputs are `username`, `password`, and optional `remember_me` (default false). Alternatively, `use_filled_form: true` uses an already-filled canonical sign-in page without navigating or requiring a search referrer; it cannot be combined with explicit credentials and fails on other pages. Allow 120 seconds for invocation.

The typed output distinguishes:

- `logged_in: true, authenticated: true, mfa_required: false`: a visible sign-out control and no password form.
- `logged_in: true, authenticated: false, mfa_required: true`: first-step acceptance with a visible verification prompt and code field or verification action. `next_step` is `complete_mfa`; this is **not** completed authentication.
- `logged_in: false`: `invalid_credentials`, `captcha_or_challenge`, `mfa_failed`, `locked_or_throttled`, `validation_error`, or `unknown`. Site wording is preserved; attempts remaining are null unless explicitly displayed. `submission_attempted` indicates whether the submit action may have started.

The tool makes at most one password submission and never retries it. Explicit credentials receive a pre-submit password-length check; matching length is not proof of character equality. Challenges stop the tool rather than being solved by it. The tool does not request verification emails, enter OTPs, complete MFA, or change credentials. On an existing MFA/authenticated screen, success describes the observed session, not proof that newly supplied credentials were checked.

### Login quirks and fixes

- Both the password and email OTP use `name="credentials.passcode"`. Password selectors now also require `type="password"`, so a code field cannot be mistaken for the password form or filled with a password.
- **Fixed:** the original classifier missed “Get a verification email” / “Send me an email” and returned `unknown` despite first-step acceptance. The repository version recognizes the email-send interstitial and the subsequent “Verify with your email” / “Enter the verification code” screen. Regression fixtures exercise the actual page-reader expression using the observed wording. The corrected classifier subsequently returned typed first-step success during the live DuckDuckGo-referrer experiment below.
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

The original mobile session reached email code entry after one separate verification-email request. Full authentication and code submission have not been verified. The independent QA pass predates the repository migration and referrer-entry changes; those changes have local regression coverage and the live evidence below, not a new independent QA pass.

### DuckDuckGo-referrer experiment — 2026-09-25

A fresh residential+stealth browser opened `start.duckduckgo.com`, searched `jetblue login`, and clicked the first organic result, **Sign In | JetBlue**, linking to `https://www.jetblue.com/signin`. The landing page reported `document.referrer === "https://duckduckgo.com/"`. The corrected login tool then made one password-length-checked submission and returned:

```json
{
  "logged_in": true,
  "authenticated": false,
  "landing_url": "https://www.jetblue.com/signin",
  "account_name_or_hint": null,
  "mfa_required": true,
  "next_step": "complete_mfa",
  "evidence": "Get a verification email",
  "submission_attempted": true
}
```

| Configuration | Direct-entry baseline | DuckDuckGo-entry rerun |
|---|---|---|
| Residential proxy, stealth enabled | Fill failure; no submission | Email-MFA first-step success; one submission; no CAPTCHA solver events |
| Mobile proxy, stealth enabled | Email-MFA first-step success; one submission | Not run: stopped after residential first-step success |
| Residential proxy, stealth disabled | Not run | Not run: stopped after residential first-step success |

**Interpretation:** search-referrer entry worked, but reduced bot detection is **not established**. The failed residential baseline never submitted credentials, no CAPTCHA was observed in either run, and egress IP, time, page readiness, and login URL parameters were not held constant. This is a successful alternative entry path, not a controlled proof that the referrer changed detection behavior.

The live run used native search interactions followed by the registered login tool on the referred page. The repository now packages those search interactions into `execute`; its new orchestration and strict destination/referrer checks have local tests. No extra password submission was made to retest the packaged entry branch. An initial blank search homepage required one read-only reload during exploration; the packaged tool instead returns `unknown` when search controls do not load.

Run `node --test tests/jetblue-login.test.mjs` for contract, navigation, single-submit safety, failure classification, and page-reader MFA fixtures. Run `node --test tests/*.test.mjs` for the repository suite. These tests use synthetic inputs and browser-helper stubs; they do not submit real logins.

Login verification session: `oh52hpvtipbx16z1hiqlj00n`. Independent failure QA agent: `agt_19fb8339edef5ff82a82`. Mobile first-step session: `qfxmqaoaejscs7qvkcln6ei9`. These login sessions have been deleted.
