# southwest.com

Tools for Southwest Airlines (https://www.southwest.com).

| tool | file | status | notes |
|------|------|--------|-------|
| search_flights | [search_flights.js](search_flights.js) | verified | First outbound results page; round trips return outbound options only |
| login | [login.js](login.js) | qa_passed | One submission maximum; live success and invalid credentials verified; MFA/lockout synthetic only |

## Scope and loading

Register the file's array expression under namespace `southwest.com`, with
`forceOverwriteNamespace: true` when replacing it. Its CDP definition matches
`https://southwest.com/*` and `https://*.southwest.com/*` and survives navigation.

```javascript
const source = (await import("node:fs")).readFileSync(
  "domains/southwest.com/search_flights.js", "utf8"
);
await webmcp.addCustomTools({
  namespace: "southwest.com",
  tools: eval(source),
  forceOverwriteNamespace: true
});
const tool = (await webmcp.listTools()).find(t =>
  t.source.custom?.namespace === "southwest.com" &&
  t.tool.name === "search_flights"
);
const result = await webmcp.invokeTool(tool.tool_ref, {
  origin: "DAL",
  destination: "HOU",
  departureDate: "2026-10-15",
  returnDate: "2026-10-18",
  tripType: "roundtrip",
  passengers: 1
}, { timeoutSec: 120 });
repl.write(JSON.stringify(result));
```

Use future dates within the site's current booking horizon. Run searches serially
and obtain a fresh tool reference for each invocation. The tool checks for the
canonical homepage's airport inputs; if absent or on another page, it opens that
entry point before navigating to a fresh results URL. It does not rely on prior
form values or prior results.

Inputs support uppercase IATA airport codes, one-way or round-trip dates, and
1–9 adult passengers. Output includes all visible first-page outbound rows,
flight numbers, local departure/arrival times, arrival day offsets, durations,
stops, and the lowest enabled displayed fare. Prices are USD per adult per
direction, not party totals or round-trip totals. This is a read-only search:
it never selects a fare, adds to a cart, purchases, or enters personal data.

## Site quirks

- Results render client-side at `/air/booking/select-depart.html`. The tool waits
  for fare rows or explicit failure/empty states rather than a fixed sleep.
  Entry-form loading has a 30-second limit within the 95-second search budget.
- Return options require selecting an outbound fare. The tool deliberately stops
  at the first outbound page, including for round-trip searches.
- Fares are displayed rounded up to whole dollars. Unavailable fare classes are
  excluded from the minimum; a completely unavailable row retains its flight
  data with a null price. Times are airport-local; next-day arrivals are explicit.
- Unsupported routes or dates can redirect to the low-fare calendar. Unknown
  airport codes can redirect to a validation form while destroying the page
  execution context. These return `site_error`, not false empty availability.
- Input-schema violations may be rejected before execution. Semantic date/route
  checks return `invalid_input`; date validation uses the current Eastern date.

## QA summary

Verified on 2026-09-24. Independent QA agent: `agt_8afff9b68b132cd8ce86`.

Before the namespace migration, independent QA compared 408 live flight rows
across initial testing and retesting with the rendered DOM: no schema violations,
count mismatches, or field discrepancies. Coverage included DAL–HOU round trips
and one-way searches, 1 versus 3 adults, HNL–SJU connecting overnight flights,
near-term dates, future dates within the booking horizon, out-of-horizon dates,
unsupported routes, and invalid inputs. The unknown-airport navigation race was
fixed and independently retested successfully three times.

The migrated tool was invoked from an existing results page, not the homepage:
DAL–HOU on 2026-10-15, returning 2026-10-18, one adult. It returned `ok` with 26
flights in 11.7 seconds, matching all 26 rendered rows; the first fare was $99.
The legacy `airline_tools` registration was removed from the live browser.

Independent migration QA loaded the canonical array expression and started from
`/air/low-fare-calendar/`. DAL–HOU round trip returned 26 flights in 10.2 seconds;
HNL–SJU one-way for two adults returned five overnight flights in 6.8 seconds;
ZZZ–HOU returned a schema-valid `site_error` in 4.7 seconds. All 31 flight rows
matched the live DOM and full output schema, with no new defects found.

Synthetic CDP document fixtures separately verified `no_results`, `parse_error`,
all-unavailable fares, and a schema-valid `timeout` after 95.84 seconds. These
are fault-injection tests, not evidence of live Southwest availability.

Local contract and navigation tests:

```sh
node --test tests/southwest-search-flights.test.mjs
```

These mock page responses to test the single-expression contract, page-entry
routing, passenger/date query parameters, and explicit failures. Live QA covers
the flight DOM parser. The input/output schemas remain unchanged from the
independently tested implementation.

### Known limitations

- No genuine live zero-flight page was found. Empty-result classification has
  synthetic coverage only.
- An outer Browser REPL request can time out before delivering the tool's
  95-second timeout response, even when a larger timeout is requested. Splitting
  an invocation across REPL cells did not fix delivery and produced canceled or
  uncertain outcomes. Await within one cell; never automatically retry an
  `outcome_unknown` invocation.

## Sessions

- Live browser: `fx7wthoc7hk61tlbj91rhuq0` (24-hour inactivity timeout).
- Independent QA browser: `styc5ynixcw173holdcvm4dx` (24-hour inactivity timeout).
- Source: this repository is canonical; sessions expire but files do not.

## Login

### Scope and loading

`login.js` is a single self-contained array expression, registered under namespace
`southwest.com`. It is CDP-backed and matches the apex plus wildcard subdomains.
The tool opens `https://www.southwest.com/` when the current page is unsuitable,
waits for the login entry, and enters credentials only on that canonical origin.
An off-origin redirect after submission returns `unknown` without further action.
An already authenticated page returns success without another submission.

```javascript
const source = (await import('node:fs')).readFileSync(
  'domains/southwest.com/login.js', 'utf8'
);
await webmcp.addCustomTools({ namespace: 'southwest.com', tools: eval(source) });
const tool = (await webmcp.listTools()).find(t =>
  t.source.custom?.namespace === 'southwest.com' && t.tool.name === 'login'
);
// After securely filling the current login form:
const result = await webmcp.invokeTool(tool.tool_ref, {
  use_prefilled: true,
  remember_me: false
}, { timeoutSec: 90 });
repl.write(JSON.stringify(result));
```

Alternatively supply `username` and `password` directly through an authorized
caller. Never print, persist, or commit those values. Do not combine credential
arguments with `use_prefilled: true`. Prefilled mode never reads values back to the
caller; if navigation is needed, it opens the entry but requires a fresh secure
fill before submission. `remember_me` defaults to false.

Run invocations serially and obtain a fresh `tool_ref` after navigation or
re-registration. Remove only the prior login registration when replacing it.
`forceOverwriteNamespace: true` replaces **all** Southwest tools, including flight
search: use it only with the complete combined tool array.

### Output contract and safety

Both input and output are typed JSON Schemas. The output is a discriminated union:

- Authenticated: `logged_in: true`, `authenticated: true`, `mfa_required: false`,
  `next_step: "none"`, landing URL, nullable account hint, and DOM evidence.
- First step accepted, MFA pending: `logged_in: true`, `authenticated: false`,
  `mfa_required: true`, `next_step: "complete_mfa_in_browser"`, and visible evidence.
  **`logged_in` alone does not mean the session is fully authenticated.**
- Failure: `logged_in: false`, `error_kind`, `error_message`, nullable remaining
  attempt count, `submitted`, and `submission_state`. Kinds are `invalid_input`,
  `invalid_credentials`, `captcha_or_challenge`, `mfa_failed`,
  `locked_or_throttled`, and `unknown`. Failures never masquerade as empty success.

There is at most one submit click per invocation and no internal authentication
retry. `submitted` means a click was attempted, not that the server received it.
`submission_state` distinguishes `not_dispatched`, a DOM submit event
(`dispatched`), and an uncertain click (`unknown`). DOM dispatch is not proof of
server receipt. Never automatically retry an uncertain result, transport error,
or `outcome_unknown`. Readiness and result polling do not submit again.

### Login site quirks and limitations

- The identifier is an account number or username, not email. Observed constraints
  are 4–20 characters for the identifier and 8–16 for the password. No third-party
  SSO controls were shown. The form uses `display: contents`; visibility must be
  determined from the actual inputs, not the form's bounding rectangle.
- Login feedback can persist from an earlier attempt. A mutation observer tracks
  feedback updates after submission so unchanged old errors are not returned as
  a new rejection. Disabled submission is rejected before the click.
- Success detection uses a visible logout control and absent login fields. The
  live success was independently checked for both “My Account” and “Log out”. The
  account hint is currently null. MFA detection requires a visible OTP field and
  code-delivery/entry text with no visible credential form; other MFA layouts may
  return `unknown`. The tool does not generate or submit OTPs or solve captchas.
- Genuine CAPTCHA, MFA, lockout, and remaining-attempt counters were not exercised
  live. Those classifications have synthetic coverage only. English UI text and
  observed selectors are required; changed layouts, localization, unrelated alert
  messages, and unrecognized challenges may produce `unknown` rather than a
  definitive result. No session cookies or tokens are returned.
- Secure vault fill populated the identifier but timed out on the password during
  testing; the successful live run used explicitly authorized direct tool input.
  This was a fill-path limitation, not a successful prefilled-mode end-to-end test.

### Login verification

Recorded on 2026-09-25. Independent failure-only QA agent:
`agt_b130ea47c33f86843968`; its browser: `fhjihe08hgrz3laowlofedsk`.
Live success browser: `jav7en141p05pbvrx59k9i14` (left alive with a 24-hour inactivity
timeout; no profile changes saved).

Independent QA checked missing/zero-field inputs, malformed types, conflicting
input modes, empty prefilled fields, and synthetic challenges/errors. Seven
invalid argument cases were rejected by the WebMCP input-schema gate rather than
returning execute output; all nine completed failure outputs matched the output
schema. The initial version's form-visibility defect prevented that QA agent
from making any live submissions.

Five findings were fixed before the real success test: `display: contents`
visibility, entry-button readiness, stale feedback, disabled/uncertain submission
reporting, and CAPTCHA-heading detection. Parent regression tests verified all
five. The fixed live tool returned `invalid_credentials` with the actual text
“The username/account number and/or password are incorrect.” No remaining-attempt
counter was shown. Synthetic captcha, disabled-submit, and stale-error results
also conformed to the output schema.

The human-approved success run passed credentials as direct tool input and made
**exactly one submission**, with no retry and no MFA:

```json
{
  "logged_in": true,
  "authenticated": true,
  "landing_url": "https://www.southwest.com/",
  "account_name_or_hint": null,
  "mfa_required": false,
  "next_step": "none",
  "evidence": "Visible Log out control and no visible login form."
}
```

This output conformed to the schema. A separate read confirmed “My Account” and
“Log out”, no visible login fields, and the registration still available. The
live success preceded the repository's namespace/pattern/entry-routing adaptation;
no additional real-account submission was made for that adaptation.

Local tests cover the canonical array expression, schema branches, navigation
from booking/apex/subdomain/unrelated pages, prefilled navigation safety,
readiness failures, stale errors, disabled submission, explicit failures,
synthetic MFA/lockout, document replacement, and at-most-one-submit semantics:

```sh
node --test tests/southwest-login.test.mjs
```

These tests mock the browser DOM and helpers; they are not additional live login
attempts or evidence of real MFA/lockout behavior.
