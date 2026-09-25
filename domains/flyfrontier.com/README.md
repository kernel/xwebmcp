# flyfrontier.com

Tools for Frontier Airlines (https://www.flyfrontier.com).

| tool | file | status | notes |
|---|---|---|---|
| search_flights | [search_flights.js](search_flights.js) | verified | Core search matrix and live invocation verified; intermittent failures remain. Use supervised searches. |
| login | [login.js](login.js) | draft | First-step sign-in live-verified on two network configurations; the emailed-code step does not work yet. Self-QA only. |

## login

### Scope

- Signs in to FRONTIER Miles with an email address or Miles number and password, or submits a form whose password was filled by a vault or a person, or completes an already visible emailed-code step.
- One submission per invocation, never a retry, never a code resend, no account creation, no password reset.
- Namespace `flyfrontier.com`; matching `https://flyfrontier.com/*` and `https://*.flyfrontier.com/*`.
- Output is a success branch (`logged_in: true`, with `authenticated`, `mfa_required`, `next_step`) or a failure branch (`logged_in: false`, with `error_kind`, `error_message`, `error_source`, `stage`, `submitted`, `attempts_remaining_if_shown`). `logged_in: true` with `mfa_required: true` means the password was accepted and the site emailed a code; it does not mean the session is authenticated.

### Entry path: search engine only

`credentials` mode always enters the site the same way: navigate to `https://start.duckduckgo.com`, search for the account page, and click the first organic `flyfrontier.com` result. There is deliberately **no direct-navigation fallback**. Each step of that entry has its own `error_kind` — `entry_search_failed`, `entry_result_missing`, `entry_navigation_failed` — so a broken entry is reported instead of being silently replaced by a different entry.

Two consequences worth knowing before use:

- The tool's `match.url_patterns` are Frontier-only, so the tool is only discoverable while the browser is already on a Frontier page. Invocation therefore begins on Frontier, leaves for the search engine, and returns through the organic result.
- The search result link carries a `referrer` meta policy of `origin`, so Frontier receives `https://duckduckgo.com/` as the referrer on that request. The first organic result redirects (`/myfrontier` to `/frontiermiles/`), and after that redirect `document.referrer` reads empty. The sign-in panel is present on the landed page, so no further navigation is needed.

### Entry-path comparison

Same account, same profile, same two proxies, same browser build. Direct navigation is the earlier baseline; it was not re-run for this comparison.

| entry path | proxy | stealth | outcome |
|---|---|---|---|
| direct | residential | off | `invalid_credentials` (site wording) |
| direct | mobile | on | password accepted, code emailed |
| direct | residential | on | password accepted, code emailed |
| direct (same session, later, same exit address) | residential | on | `invalid_credentials` (site wording) |
| search engine | residential | on | password accepted, code emailed |
| search engine | mobile | on | password accepted, code emailed |

Exit addresses were recorded per run outside this repository.

### The inconsistency is unresolved

The same unchanged credentials produced two different site responses across attempts: an emailed verification code in four submissions and `Your login information is incorrect. Please check your details and try again or reset your password now.` in two. Nothing in the tool's input differed between them — every submission verifies, before clicking, that the identifier field matches exactly and that each character of the password reached the password field, including a trailing punctuation character.

Both search-engine attempts landed on the code step and neither reproduced the incorrect-credentials wording. Two attempts are not enough to conclude that the entry path is the cause: the account, session age, and egress address all varied too, and residential egress rotates between sessions (the same proxy presented two different addresses hours apart). Treat the cause as unknown, and treat `invalid_credentials` from this site as the site's wording rather than proof about the credentials.

### Known limitations

- **The emailed-code step does not work.** In `otp` mode the sixth code field never keeps its digit: the first five fields populate, the sixth stays empty and focused, the site shows no error, and no code is evaluated. Two entry techniques failed the same way — one `fillInput` per field, and typing the whole code into the focused first field while the component advances focus. The fields are not disabled or read-only, so the component appears to reject or reset the final synthetic keystroke. The tool now reports this as `login_form_unavailable` with the count of empty fields instead of a vague failure, and a live end-to-end sign-in therefore remains **unverified**.
- A first-step success only means the password was accepted and a code was sent.
- Live captcha, lockout, and wrong-code behavior were never observed; those branches are covered by mocked tests only.
- `prefilled_password` mode was not exercised live.

### Site quirks

- A marketing overlay renders inside a shadow root (`[id^="wisepops-instance-"]`); its close button must be clicked through `shadowRoot` before the header is clickable. The tool does this before opening the sign-in panel.
- Sign-in is a slide-over panel opened from `.user-background`, not a separate page. The panel's fields are scoped with `data-vv-scope="login-fields"`; several hidden sign-up and password-reset panels reuse the same field names, so unscoped selectors match the wrong form.
- Error text lives in `.login-container .error-message` and is not inside a live region. When the code panel is open, only its own `.mfa-error-message` is read, so a stale sign-in error is never reported as a wrong-code error.
- The code panel becomes visible before the paragraph naming the masked address renders. Treating the panel alone as the success signal is required; an earlier build waited for the address text and misreported a real first-step success as `unknown`.
- Both proxies reached the site without a captcha; the stealth solver extension was loaded but never recorded a detection or solve event.

### QA summary

Self-QA, no independent QA agent.

- `node --test tests/flyfrontier-login.test.mjs` — 16 tests over mocked browser helpers: input validation, each search-entry failure, search-engine challenge, site error classification, lockout precedence over a remaining-attempts count, captcha after submission, completed session, code panel without its address hint, half-rendered code panel, code fields that refuse a digit, prefilled-form account binding, and fill verification.
- Live: one submission per configuration, two total, both reaching the emailed-code step. The residential run exposed the code-panel race described above; the fix was validated by replaying the tool's page reader against that live page and by the mobile run, which returned the corrected success output directly.
- The registered source in both live sessions was hash-checked byte-for-byte against this file.

### Sessions

- Search-entry residential session: `tic6ksap9ppc5uh91wr2rg0y` (24h inactivity timeout; left alive).
- Search-entry mobile session: `o9wmzrbmk59dx46t9l8lqiki` (24h inactivity timeout; left alive).
- Both sessions sit on an open code panel from their single attempt; those codes have expired.
- This repository is canonical; sessions and registration IDs expire, the source does not.

## search_flights

### Scope

- Read-only flight search for 1–9 adults, one-way or round-trip, using uppercase IATA codes and ISO dates. No children, infants, flight selection, purchases, or personal-data entry.
- Returns all displayed first-page flight rows, including separate outbound and return alternatives, flight numbers, local dates/times, duration, stops, and prices. Rows are not paired round-trip itineraries.
- Namespace: `flyfrontier.com`. Matching: `https://flyfrontier.com/*` and `https://*.flyfrontier.com/*`.
- Before searching, checks the current URL and expected form. A loaded homepage search form or booking results form is suitable; other pages, including unrelated origins, first navigate to the homepage entry point. Matching still limits normal tool discovery to Frontier hosts.
- The file is a single self-contained expression evaluating to the definition array. Register it with `webmcp.addCustomTools({ namespace: "flyfrontier.com", tools: eval(source), forceOverwriteNamespace: true })`, following the root README. This replaces all registrations in this domain namespace.

### Site quirks

- Homepage airports require autocomplete selection. The UI uses calendar pickers and separate adult/child/infant counters. Search navigation goes through `booking.flyfrontier.com/Flight/InternalSelect` to `/Flight/Select`.
- Results render asynchronously. The tool waits for document replacement and populated flight metadata, a visible no-flights message, or a visible site error. It validates the requested route, dates, trip type, and passenger count before returning rows.
- `price.amount` is the per-person Basic Standard leg fare from the row's `basicstandardfare` metadata. `displayedAmount` is the rounded UI fare or null when the UI shows `--`. Round-trip displayed amounts are indicative totals; do not sum them. Metadata amounts are not checkout quotes or standalone one-way quotes for a round-trip search.
- Durations may contain a `day(s)` prefix and an overnight suffix. Local timestamps come from segment sell keys because the separate display-date metadata can reflect a different calendar day.
- A search beyond the published schedule can explicitly show no flights. Only that visible signal produces `no_results`. Timeouts, site errors, parser failures, and mismatched search state remain explicit errors. Departure-date validation uses today's UTC date.

### QA summary

Independent QA agent: `agt_7944f6b168e2b52c685d`.

The final pre-migration QA pass made 33 calls: 24 valid-route searches, one unknown-route search, and eight invalid-input calls. All 366 returned rows passed output-schema and field-by-field DOM comparisons. This verifies returned data, not uninterrupted reliability: the longer alternation run had three stale-state failures and one timeout, detailed below.

| Search | Adults | Core-case outcome |
|---|---:|---|
| DEN–LAS round trip, 2026-10-15 / 2026-10-18 | 1 | 50 rows, 25 each direction |
| DEN–LAS one-way, 2026-10-15 | 2 | 25 rows |
| PHL–LAS one-way, 2026-10-20 | 1 | 12 rows, including multi-day connections |
| CVG–DEN one-way, 2026-09-26 | 1 | 16 rows |
| DEN–MCO one-way, 2027-03-15 | 3 | 23 rows |
| DEN–LAS one-way, 2027-09-15 | 1 | Explicit `no_results` |
| DEN–AAA one-way, 2026-10-15 | 1 | Explicit `SITE_ERROR` |

Invalid calendar dates, past dates, identical airports, reversed return dates, inconsistent trip types, and passenger counts outside 1–9 were rejected. Multi-day duration parsing, return-price metadata handling, and prompt invalid-station errors were fixed during development.

Migration verification on 2026-09-24 started at `https://www.flyfrontier.com/optional-services`, not the homepage. The domain-scoped tool automatically established the entry point and returned 50 DEN–LAS round-trip rows (2026-10-15 / 2026-10-18, one adult) in 10.974 seconds. The input and output schemas were compared to the previous version and are unchanged. The old `airline_tools` registration was removed.

Local tests: `node --test tests/flyfrontier-search-flights.test.mjs`. These exercise source loading, matching, entry-point control flow, and explicit failures using mocked browser helpers; they do not replace the live DOM/parser QA above.

### Known limitations

- **Intermittent stale state:** 3 of 24 valid-route calls in the final independent alternation run displayed the preceding search's form. Reproduction included PHL–LAS → CVG–DEN → DEN–MCO. Validation returned an error rather than substituted flights. The document gate and `IsEdited=true` did not eliminate this issue; the namespace/entry-point migration does not claim to fix it.
- **Intermittent timeout:** one zero-results → DEN–MCO transition returned `RESULTS_TIMEOUT` after 65.725 seconds without flight rows or a no-flights signal. Cause was unconfirmed. An earlier pass separately observed a proxy error page; generic timeouts do not identify the underlying cause.
- The full 120-second invocation deadline, other routes/schedules, and checkout-confirmed pricing remain unverified. Invoke serially with `{ timeoutSec: 120 }`; do not automatically retry an `outcome_unknown` result.

### Sessions

- Live verification browser: `wok7l4bkxn6ptqe0mf3rig15` (24-hour inactivity timeout; left alive).
- Independent QA browser: `kkmt7tlnsbzkxl0kc8y78wo9` (24-hour inactivity timeout; left alive).
- Last live verification: `2026-09-24T23:09:25.555Z`.
- This repository is canonical; browser sessions and registration IDs expire, but the source does not.
