# jetblue.com

Tools for JetBlue (https://www.jetblue.com).

| tool | file | status | notes |
|---|---|---|---|
| search_flights | [search_flights.js](search_flights.js) | verified | Initial outbound flight cards, including round-trip searches; 1–7 adults |
| login | [login.js](login.js) | qa_passed | Four-state output; CAPTCHA is a human-assist handoff, never solved. Email-MFA first step live-observed |

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

The primary entry path goes through `https://start.duckduckgo.com/`, searches `jetblue login`, and clicks the **first organic result**, not an advertisement. It accepts that result only when it is `https://www.jetblue.com/signin` (optional trailing slash, no query or fragment), then verifies that the page landed on the canonical sign-in path with an actual DuckDuckGo document referrer. The referrer is never spoofed.

If any step of the search route fails (search form or controls missing, search leaving DuckDuckGo, no organic results, an unapproved first result, a landing page off the sign-in path, a missing referrer, or an interrupted search), the tool falls back to navigating directly to `https://www.jetblue.com/signin`. An unapproved first result is never clicked. The fallback runs before any credential is typed, and the usual origin, form, and challenge checks apply to the directly loaded page. A failed fallback stops with a typed failure.

Login-mode results carry `entry` with `path` (`search_referral`, `direct_fallback`, or `existing_page`) and `fallback_reason` (the search-route failure, or null), so a caller can tell which path produced an outcome. Results returned before navigation, such as input validation failures, omit it.

There are no starting-page assumptions: unrelated pages, the apex, subdomains, non-login paths, and sign-in pages without a DuckDuckGo referrer try the search route first. A canonical sign-in page already reached through DuckDuckGo is reused as `existing_page`. Existing challenges, errors, MFA, or authenticated state are reported without restarting the flow. Credentials are entered only on the canonical sign-in page. Allow 150 seconds for invocation.

### Modes

`mode` selects one of three behaviours and defaults to `login`.

- `login` submits credentials at most once. Supply `username` and `password` with optional `remember_me` (default false), or `use_filled_form: true` to submit an already-filled canonical sign-in page without navigating or requiring a search referrer. The two forms cannot be combined.
- `await_human_login` watches a bounded `wait_seconds` window (10–600, default 180) while a person signs in through the live view. It never types, clicks, or navigates.
- `capture_session` reads the current page once and records the resulting session. It accepts no credential fields and performs no interaction.

### Output states

The output is a four-way discriminated union on `status`, not a success/failure boolean. A challenge is a state of its own, so `captcha_or_challenge` is deliberately **not** a member of `error_kind`.

- `authenticated`: a visible sign-out control and no password form. Carries `session` with `cookie_read_ok`, `cookie_count`, `cookie_names`, and `values_returned: false`.
- `mfa_required`: first-step acceptance with a visible verification prompt and a code field or verification action. `next_step` is `complete_mfa`; this is **not** completed authentication.
- `human_assist_required`: the flow needs a person. `assist_reason` is `captcha_or_challenge`, `unsupported_verification_method` (for example a passkey-only prompt, which Kernel browsers cannot satisfy), or `pending_human_login` when a bounded wait elapsed. Always carries `automated_solving: "not_implemented"` and a `handoff` block naming the page and the manual step.
- `failed`: `invalid_credentials`, `mfa_failed`, `locked_or_throttled`, `validation_error`, or `unknown`. Site wording is preserved; attempts remaining are null unless explicitly displayed.

Every state carries `submission_attempted`, indicating whether the submit action may have started.

### CAPTCHA policy: manual assist is the only supported path

Automated CAPTCHA solving is **intentionally not implemented** and is not a gap to be filled later. The tool does not call a solving service, does not retry against a challenge, does not attempt to evade or wear down a challenge, and does not register accounts or guess credentials to route around one. `mode` has no value that expresses solving, so a caller cannot request it.

When a challenge appears, the supported recovery is a person:

1. The tool returns `human_assist_required` with the challenge wording and the page URL.
2. The operator opens that browser session's Kernel live view and signs in by hand, completing the challenge and any MFA.
3. The operator calls the tool again with `mode: "capture_session"`, or uses `mode: "await_human_login"` to wait for the same result, and the session is recorded.

The tool runs inside the browser and cannot know its own Kernel live-view URL, so `handoff.page_url` is the page it is on; the caller pairs it with the session's live view.

**Session capture returns metadata, never secrets.** `session` lists the names and count of cookies scoped to `jetblue.com` and its subdomains, with `values_returned` pinned to `false`. Cookie values, tokens, and storage contents are never placed in tool output, because that output is relayed through chat transcripts and notifications. The authenticated credential material stays in the browser profile, which is the supported way to reuse the session; persist it with `save_profile_changes` on the browser rather than copying a token out. A test asserts that no cookie value reaches the output.

The tool makes at most one password submission and never retries it. Explicit credentials receive a pre-submit password-length check; matching length is not proof of character equality. The tool does not request verification emails, enter OTPs, complete MFA, or change credentials. On an existing MFA or authenticated screen, the reported state describes the observed session, not proof that newly supplied credentials were checked.

### Login quirks and fixes

- Both the password and email OTP use `name="credentials.passcode"`. Password selectors now also require `type="password"`, so a code field cannot be mistaken for the password form or filled with a password.
- **Fixed:** the original classifier missed “Get a verification email” / “Send me an email” and returned `unknown` despite first-step acceptance. The repository version recognizes the email-send interstitial and the subsequent “Verify with your email” / “Enter the verification code” screen. Regression fixtures exercise the actual page-reader expression using the observed wording. The corrected classifier subsequently returned typed first-step success during the live DuckDuckGo-referrer experiment below.
- **Fixed:** plain-text “Verify you are human” outside a heading or alert is recognized. Independent QA found this with a DOM fixture; a parent regression check passed after the fix. Challenge wording now also covers press-and-hold, “I am not a robot”, and Turnstile/Arkose/FunCaptcha frames, and routes to `human_assist_required` instead of an error kind.
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

The live run used native search interactions followed by the registered login tool on the referred page. The repository now packages those search interactions into `execute`; its new orchestration and strict destination/referrer checks have local tests. No extra password submission was made to retest the packaged entry branch. The successful referrer session is retained at the email-MFA first step: `a17cnzyab9ape5q7k92d4a1i`. An initial blank search homepage required one read-only reload during exploration; the packaged tool instead returns `unknown` when search controls do not load.

### Human-assist verification — 2026-09-25

The four-state build was registered into the retained referrer session and exercised read-only against the live JetBlue sign-in page, with no credential submitted:

| Invocation | Live result |
|---|---|
| `{"mode":"capture_session"}` | `mfa_required`, `mfa_prompt: "Get a verification email"`, `submission_attempted: false` |
| `{"mode":"await_human_login","wait_seconds":10}` | `human_assist_required`, `assist_reason: "pending_human_login"`, `automated_solving: "not_implemented"`, page unchanged |
| `{"mode":"capture_session","username":…,"password":…}` | Rejected by input schema before execution |
| `{"mode":"solve_captcha"}` | Rejected by input schema; no such mode exists |

A live CAPTCHA has not been observed on this account yet, so `assist_reason: "captcha_or_challenge"` is covered by unit fixtures over the real page-reader expression rather than by a live challenge. The `authenticated` state and its cookie-metadata capture are likewise verified by tests; the live account is still at the email-verification step, so no end-to-end manual-assist capture has been recorded.

Run `node --test tests/jetblue-login.test.mjs` for contract, navigation, single-submit safety, failure classification, and page-reader MFA fixtures. Run `node --test tests/*.test.mjs` for the repository suite. These tests use synthetic inputs and browser-helper stubs; they do not submit real logins.

Login verification session: `oh52hpvtipbx16z1hiqlj00n`. Independent failure QA agent: `agt_19fb8339edef5ff82a82`. Mobile first-step session: `qfxmqaoaejscs7qvkcln6ei9`. Session IDs are historical references and may expire.
