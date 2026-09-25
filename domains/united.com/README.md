# united.com

Tools for United Airlines (https://www.united.com).

| tool | file | status | notes |
| --- | --- | --- | --- |
| search_flights | [search_flights.js](search_flights.js) | verified | Initial outbound results, including connections and nearby-airport alternatives |
| login | [login.js](login.js) | draft | Challenge classification live-verified; successful login and MFA unverified |

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

## Known limitations

- `search_flights`: initial outbound page only, including for round trips, whose fares are advertised per-person roundtrip starting fares rather than confirmed pairings. Adults only (1–9), English/US cash fares, economy. Nearby airports may be substituted and are reported explicitly. Slow searches can exceed the caller's transport deadline.
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
