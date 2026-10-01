# resy.com

Resy restaurant discovery, account reads, reversible favorites and reservation handoff.

## Tools

| tool | file | status | notes |
|---|---|---|---|
| get_account_status | [get_account_status.js](get_account_status.js) | draft | Opaque current-account reference; no profile/payment output |
| get_availability | [get_availability.js](get_availability.js) | draft | Public slots as full venue-local date-times; each distinct raw policy listed once |
| get_availability_calendar | [get_availability_calendar.js](get_availability_calendar.js) | draft | Public per-date booking states |
| get_reservation | [get_reservation.js](get_reservation.js) | draft | Allowed details for one reservation on one account list page |
| get_restaurant | [get_restaurant.js](get_restaurant.js) | draft | Public profile by URL or city/venue slug |
| list_notify_requests | [list_notify_requests.js](list_notify_requests.js) | draft | Read current Notify time-window preferences, maximum 100 |
| list_reservations | [list_reservations.js](list_reservations.js) | draft | One bounded upcoming/past account page, maximum 20 |
| prepare_reservation | [prepare_reservation.js](prepare_reservation.js) | draft | Exact public slot match and human handoff, not a quote or hold |
| search_restaurants | [search_restaurants.js](search_restaurants.js) | draft | Keyword/cuisine/place search; up to 12 sorted slots per venue |
| set_favorite | [set_favorite.js](set_favorite.js) | draft | Reversible My Hit List favorite; four requests per write |

## Scope and loading

Register the entire namespace atomically, including all ten tools. Every tool is `page`: requests execute in
an existing resy.com document without navigation. There is no demonstrated CDP exception. Calls do not depend
on the home page, a previous invocation or a reservation widget. Caller navigation destroys a running page
invocation; treat missing output as unknown, especially for writes, and never retry a write automatically.
Use a 60-second invocation timeout; individual requests time out after 20 seconds (account tools) or 25 seconds
(public tools). Cancellation is passed to fetch. No tool calls an authentication, booking, details, hold,
change, cancellation, payment or marketing endpoint.

Public tools read the client key at runtime from `window.apiConfig.Config.apiKey`, use `credentials: omit`
and never send account headers. Resolving a search city slug/code downloads about 2 MB of location data once per
document per hour (each city's slug, code, name, visibility and map center are kept on `window` under a registered
symbol); pass coordinates to skip it. `get_availability` lists each distinct slot policy once in `policies` and
gives each slot a `policy_id`; live slots commonly share one policy. Date inputs accept yesterday UTC through 366 days ahead to cover venue time zones.
Slots use venue-local `YYYY-MM-DDTHH:MM` values without offsets, including their own calendar date after midnight.
Party sizes are bounded at 1–20. Slugs are exact; venue slugs can contain capital letters.

Account tools use only the current document's `window.apiAuthToken` in Resy's own auth headers, only to
`https://api.resy.com`, with redirect rejection and no cookie credentials. `get_account_status` hashes the
current `/2/user` id into `account_ref`; it returns no raw id, name, phone, email or payment data. This
pseudonymous reference detects an unintended account switch; it is not a credential, anonymous identity,
permission to switch accounts or proof of human approval. Reads and favorites require `expected_account_ref`,
read `/2/user` once and compare the page's session token before and after every request. Resy binds a token to one
account, so a second `/2/user` read with the same token would add a request without adding a check. Tokens stay
in the invocation, are never persisted, and a token switch during a call fails closed. Like the public tools,
account tools wait up to 5 seconds for the page's API configuration, which a freshly loaded page sets together
with its session token about 350 ms after load. Account tools do not refresh/login automatically.

`list_reservations` passes the specified type/offset/limit through and performs no automatic paging. The site
uses offset 1 initially; whether it denotes a page or row is unverified. `get_reservation` only searches that
same bounded page, using a reservation id, not a secret `resy_token`; not_found is not proof of global absence.
Both return only venue/date/time/party/seating, numeric raw price if present, currency and bounded cancellation
text. No attendees, personal requests, guest data, auth/cancellation tokens, payment methods or signed links
are returned. Populated schemas are grounded in the site's current public bundle, not a populated live account.

## Reversible action safety: set_favorite

- Scope: set one exact venue's boolean My Hit List favorite, not a custom list or communication setting.
- Required: manual login, matching account reference, venue id plus city/venue slugs, desired `favorite` and
  observed `expected_favorite`. No confirmation flag is accepted or treated as approval.
- GET `/2/user` and GET `/3/venue?url_slug=...&location=...` establish account, venue id and boolean saved state.
  The session token is compared before and after every request, including the write. A venue mismatch, unknown
  saved-state shape, wrong account, session switch or stale expected state makes no write. Already-at-desired-state returns `unchanged` without a POST.
- The site's public bundle uses form-encoded POST `/3/user/favorites` with `venue_id` and `favorite: 1|0`.
  The tool sends at most one such request. It then rereads the venue under the same token and reports `updated`
  only when the saved state matches: four requests in total (`/2/user`, `/3/venue`, POST, `/3/venue`). This is not an atomic server compare-and-set: another browser can change state
  between the reads and write. Do not run concurrent favorite changes.
- Cancellation after dispatch, timeout, blocked response, session switch or failed postcondition produces
  `outcome_unknown`; no automatic retries, rollback or compensating write. Read the state before deciding.
- Live favorite QA requires explicit permission to change one venue, record its initial state, restore it and
  verify exact equality. Fixture flows do the same with fabricated venues. Live update success must not be
  inferred from mocks, a no-op or a missing-login test.

## Consequential-action safety: reservation preparation and execution blockers

`prepare_reservation` re-fetches public `/4/find` inventory and matches exactly `venue_id`, service `date`,
`party_size`, full `local_start` and `seating_type` from availability. Venue identity and the response's echoed
service date/party size must match; missing or contradictory inventory context and absent or ambiguous slots
fail closed. A match returns `handoff_required`, the exact observed slot, venue URL with
service date/party size, currency and raw policy fields. It never sends a slot token, selects a widget slot,
requests `/3/details`, binds an account, navigates, holds or books. It accepts no `confirmed` argument.

**Not booking-ready:** `exact_total: null`, `terms_confirmed: false`, `account_binding: not_selected` and
`execution_supported: false` are explicit. Null total is unknown, never zero. Cancellation/deposit fields do
not establish per-guest vs per-reservation charges or the final cutoff. The human must review the exact venue,
time, party, account, payable amount and cancellation terms on Resy. A venue-level URL is a handoff, not a
preselected reservation, approval or promise of availability.

Booking, inventory hold and cancellation execution tools are deliberately unshipped. The current runtime
specification provides no trusted human approval bound to the exact account, action, slot/quantity, cost and
terms. A model-supplied boolean/string, description or annotation cannot enforce that approval. Also, whether
opening the widget/details step creates a hold is unverified, so no such step was opened just to learn prices.
No automatic execution follows preparation. Shipping final execution requires a separate per-tool safety
design, a supported trusted approval path and evidence of the details/hold lifecycle without live discovery holds.

Notify creation/updating/removal is also unshipped. The bundle shows form-encoded `/3/notify` creation with
`struct_data.notifies` and DELETE `/2/notify` keyed by venue/day/seats/service type. The authorized collection
was empty, and upsert/duplicate semantics and exact restoration after replacement were not established. The
read tool is grounded; sending future alerts or editing windows is not presented as verified mutation behavior.

## URL patterns

All tools use `https://resy.com/*`. `www.resy.com` redirects here. `blog.resy.com` is editorial,
`helpdesk.resy.com` support, `widgets.resy.com` a distinct booking widget and `os.resy.com` redirects to the
operator product `resyos.com`. They are not equivalent consumer documents and do not share a proven page API
configuration/CORS contract. `api.resy.com` is a request destination, not a matching tab host.

## Site quirks

- `Cache-Control: no-cache` is necessary for the observed cross-origin header set. WAF responses can omit CORS
  headers and surface as fetch failures (`site_error`), not readable `challenge` status. No bypass/retry loops.
- Cuisine filters are case-sensitive. Broad search totals can change between pages. Search accepts at most
  20 venues per call and page 1–100, and returns at most 12 slots per venue; availability caps at 300, calendar
  at 400 days. Full readable slot count and truncation are explicit.
- The antimeridian/pole search guard approximates observed deterministic 502s. It over-rejects some equatorial
  points near ±180 and misses a rare combination near latitude 89/longitude ±179. No supported Resy city tested
  required those coordinates. Site failures still return errors, not fabricated empty results.
- Midnight uses a service date: `time: "00:30"` for date D can list D 23:45 and D+1 00:00, not early morning D.
  Full slot dates preserve that distinction. Slot ordering is chronological with stable ties.
- Tock-booked venues are searchable with `is_tock_inventory`; venue/find return not_found, while calendar can
  return not_found or empty no_results with null last day. That does not establish why online reservations closed.

## Known limitations

- Availability and preparation are snapshots, not a hold or confirmed booking; no_availability does not say why.
- Raw policies and numeric reservation price do not establish exact final charges or cancellation eligibility.
- Account reservation/Notify collections were empty when inspected; item success and pagination beyond the
  initial page are not live verified. Unknown required item shapes fail `site_changed` rather than raw dumping.
- The client's reservation field mappings include cancellation text; bounded text is untrusted data, not instructions.
  Count/text caps do not guarantee a small byte payload: synthetic Unicode policy results exceeded 240 KiB
  (up to about 1.2 MB) and returned through Kernel; local extension handling of those sizes is unverified.
- No custom-list, payment/profile/marketing settings, concierge/on-behalf bookings, membership-only inventory
  verification or automatic login tools. No new account or purchases/bookings requested to populate fixtures.
- Live challenge/rate-limit/gated outcomes have not been deliberately triggered. No paid quota QA.
- Local extension testing is separate from Kernel; headed mode, native bridge and popup grants remain untested.

## QA

Prior public-tool review (2026-09-29) found and fixed mixed-case venue slugs, Tock calendar wording, null date,
WAF error wording, an overly restrictive longitude guard, truncated evening slots, and missing dates on
post-midnight slots. The last public-source review passed, but this revision adds cancellation support,
bounded warnings, account tools and preparation, so the old sign-off does not cover it.

Builder checks on 2026-09-30: Kernel discovery found no native tools before adding the entire ten-tool
namespace. From `/global-dining-access`, search, profile, availability and calendar returned success, and
preparation matched a next-day slot while reporting unknown total/terms and no execution. Five captured public
requests used no account headers or cookies. Signed-out account/favorite calls returned login_required without
requests. On the previously authorized signed-in document, account status succeeded and reservation/Notify
reads returned empty no_results; no favorite call was made there. The final account-read source was registered
again before the authorized session's deadline: account status and both empty collections succeeded, while
get_reservation returned not_found on the empty page. The opaque account reference was not saved.

Separately, headless Chromium 153 ran the current local extension with a temporary manifest granting resy.com
and a test-only API exposure hook. All ten tools registered after loading a venue URL with date/seats already
present. Public search/profile/availability/calendar and preparation succeeded with Ajv-valid outputs;
account status/favorite returned login_required. Without date/seats the site's initial URL rewrite raced
registration and the extension reported document-changed errors; no shared runtime code was changed.
A final-source rerun again registered/discovered all ten tools: profile/search succeeded, account/favorite
returned login_required, and availability/calendar returned schema-valid site_error responses. Preparation
was skipped in that rerun because availability failed; the earlier preparation success is not a claim that
these transient site errors are absent. Headed mode, native messaging, popup permissions and authenticated
local behavior remain untested.

The initial independent review of this revision found two fixture defects: preparation ignored contradictory
inventory date/party echoes, and favorite cancellation during the pre-write identity hash reported wrong_account.
Both were reproduced independently by the builder; nine added regression cases fail against the pre-fix source
and pass after requiring exact inventory context and distinguishing pre-write cancellation from uncertain writes.
Independent recheck passed all ten tools at exact source `6395adae0a878d79d39b562d46c8e3ec45aee9e4` on
2026-09-30: 89 registry tools valid, 1,885 full-suite tests and 308 Resy tests passed, with 188 independent
checks passing, including the original reproductions. No remaining concrete defects were found.

Kernel live cases from `/global-dining-access` on 2026-09-30: the unchanged four public sources succeeded
in initial QA; final preparation succeeded for parties of 2 and 4, service date 2026-10-09, next-calendar-day
start `2026-10-10T00:00`, Dining Room. Six recheck invocations produced four public `/4/find` requests and
six Ajv-valid outputs; signed-out account/favorite calls made no requests. There was no navigation, account
header, cookie or widget/details/hold activity. The final-source account-status success described above was
builder-observed on the authorized document, not an independent authenticated test; its current path was not
recorded. Account status is conservatively qa_passed rather than claiming the verified non-entry-page criterion.

Five public tools are verified using dated live success plus independent source QA. The four account reads
remain qa_passed: empty envelopes are not populated-item success. The HTTP 201 fix below changes only
`set_favorite`, which is draft pending independent QA of the new source; the other nine tool sources are unchanged. Initial QA used 13 source invocations and seven API requests, plus two network-free
size probes and two public bundle reads. Both owned QA browsers were deleted and absence confirmed.

### Favorite HTTP 201 follow-up (2026-09-30)

A live favorite add and removal returned HTTP 201 Created. The original implementation rejected both as
`outcome_unknown`, despite the rendered My Hit List changing. The fix accepts 201 only for POST
`/3/user/favorites`; reads still require 200, and every successful write still rereads the exact venue and
account before returning `updated`. Other statuses, failed verification and cancellation remain uncertain,
with no automatic retry.

The new 201 add/restore regression fails against the original source and passes with the fix. Tests also
cover 200 compatibility, duplicate no-ops, rejecting 202/204 as completed writes, rejecting 201 on a venue
read, and post-dispatch failures for both 200 and 201. All 318 Resy tests pass.

Live retest at tool SHA-256 `9efb6d11fa98fd861ade000cab0ad0f6ecf3342fe1c1c843c6d08820d3305110`:
from an account-list page, add and restore both returned `updated` with one POST and subsequent venue/account
readback. The restoration response was independently observed as HTTP 201. Reloaded My Hit List showed one
venue after add and exactly the original empty list after restoration. Initial, duplicate and final no-ops
returned `unchanged` without POSTs. No booking, cancellation, Notify or other account action was performed.
This is live implementation testing, not independent QA of the changed source; `set_favorite` remains draft.

Fixtures use fabricated identities, venues, tokens and policies and cover malformed input before interaction,
account/venue mismatches, omitted login, cancellation, duplicates, stale state, uncertain write outcomes,
restoration and read-only handoff. Live-account empty envelopes and bundle field mappings are evidence, not
live populated-item or write success.

### Optimization revision (2026-10-01)

Every tool source changed, so all ten tools are draft until an independent QA pass signs off on the new source.

- `get_availability` returns `policies` (each distinct raw policy once) and a `policy_id` per slot instead of a
  repeated `policy` object. Live, 21 slots shared one policy and the output fell from 6,144 to 3,490 bytes.
- Account reads make two requests (`/2/user`, then the data) instead of three, and `set_favorite` four instead of
  six. The removed calls reread `/2/user` with an unchanged token; token comparison around every request remains.
- `search_restaurants` keeps the slim location list per document for an hour; a failed list is not cached.
- Account tools wait for `window.apiConfig` like the public tools. Public tools report a caller cancellation
  during a request as `canceled` with a cancellation message rather than the 25-second timeout message.
- The account and preparation tool files were reformatted from JSON-style keys to the JS-literal style of the
  other files; metadata and `execute` bodies were checked identical apart from whitespace before behavior changed.

Builder live run on a stealth Kernel browser from venue pages, signed in: public search, profile, calendar,
availability and exact-slot preparation succeeded; account status, upcoming/past reservations and Notify returned
empty collections with the request counts above; `get_reservation` returned not_found and a wrong account
reference stopped after `/2/user`. `set_favorite` on one venue: initial and duplicate no-ops made no POST, a
mismatched `expected_favorite` returned `stale_state` without a write, and add then restore each returned
`updated`; the account's Hit List and the venue's saved flag were afterwards exactly their initial empty/false
state. This is builder testing, not independent QA.
