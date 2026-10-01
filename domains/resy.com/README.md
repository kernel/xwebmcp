# resy.com

Resy restaurant discovery, curated collections and events, account reads, favorites, custom lists, Notify, and booking, changing, cancelling and rating reservations.

## Tools

| tool | file | status | notes |
|---|---|---|---|
| book_reservation | [book_reservation.js](book_reservation.js) | draft | Book one quoted slot; `confirm: true`, `expected_total`, duplicate guard |
| cancel_reservation | [cancel_reservation.js](cancel_reservation.js) | draft | Cancel one reservation; `confirm: true`, fee guard |
| change_reservation | [change_reservation.js](change_reservation.js) | draft | Move one reservation to another slot at the same venue; `confirm: true` |
| copy_list | [copy_list.js](copy_list.js) | draft | Copy a shared list into the account as a private list |
| create_list | [create_list.js](create_list.js) | draft | One private custom list; duplicate-name guard |
| create_notify | [create_notify.js](create_notify.js) | draft | Turn on Notify inside the venue's offered window; never holds or books |
| delete_list | [delete_list.js](delete_list.js) | draft | Delete one custom list; `confirm: true`, name must match |
| get_account_status | [get_account_status.js](get_account_status.js) | draft | Opaque current-account reference; no profile/payment output |
| get_availability | [get_availability.js](get_availability.js) | draft | Public slots as full venue-local date-times; each distinct raw policy listed once |
| get_availability_calendar | [get_availability_calendar.js](get_availability_calendar.js) | draft | Public per-date booking states |
| get_booking_quote | [get_booking_quote.js](get_booking_quote.js) | draft | Exact-slot total, fees, card requirement and cancellation terms; holds nothing |
| get_collection | [get_collection.js](get_collection.js) | draft | One page of a collection's venues with up to 6 slots each |
| get_list | [get_list.js](get_list.js) | draft | One page (max 20) of a list's venues, including My Hit List |
| get_reservation | [get_reservation.js](get_reservation.js) | draft | Allowed details for one reservation on one account list page |
| get_restaurant | [get_restaurant.js](get_restaurant.js) | draft | Public profile by URL or city/venue slug |
| get_share_link | [get_share_link.js](get_share_link.js) | draft | Share URL for a list; changes nothing |
| get_venues | [get_venues.js](get_venues.js) | draft | Up to 20 venue cards by id |
| list_collections | [list_collections.js](list_collections.js) | draft | A city's curated collections (Climbing, Top Rated, New on Resy, editorial) |
| list_events | [list_events.js](list_events.js) | draft | Ticketed events for a venue or city; handoff URL, no event booking |
| list_lists | [list_lists.js](list_lists.js) | draft | My Hit List and custom lists, optional per-venue membership |
| list_notify_requests | [list_notify_requests.js](list_notify_requests.js) | draft | Read current Notify requests and windows, maximum 100 |
| list_reservations | [list_reservations.js](list_reservations.js) | draft | One bounded upcoming/past account page, maximum 20 |
| rate_reservation | [rate_reservation.js](rate_reservation.js) | draft | 1-5 rating for a past reservation; `confirm: true` |
| remove_notify | [remove_notify.js](remove_notify.js) | draft | Turn off one Notify; `confirm: true` |
| search_restaurants | [search_restaurants.js](search_restaurants.js) | draft | Keyword/cuisine/place search; up to 12 sorted slots per venue |
| set_favorite | [set_favorite.js](set_favorite.js) | draft | Reversible My Hit List favorite; four requests per write |
| set_list_membership | [set_list_membership.js](set_list_membership.js) | draft | Add/remove one venue on one custom list |

## Scope and loading

Register the entire namespace atomically, including all twenty-seven tools. Every tool is `page`: requests execute in
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

## Consequential-action safety: booking, changes, cancellation and ratings

These follow the repository's pattern for outward-facing writes (`send_message` in purelymail.com): the tool
description says to act only when the user asked, `confirm: true` is required, there is one attempt and no retry,
and the outcome is decided by reading the account back. `confirm` states intent; the runtime offers no trusted human
approval, so the user-visible quote and the guards below carry the safety.

- `get_booking_quote` re-reads `/4/find`, matches exactly one slot by `local_start` and `seating_type` (venue id and
  echoed date/party must match), then calls `/3/details` with `commit: 0`. Live on 2026-10-01 that preview returned
  totals, fees, payment type, cancellation fee/cutoffs and policy text and no `book_token`, so it holds nothing. The
  slot's config token never leaves the invocation.
- `book_reservation` refuses unless `expected_total` equals a fresh preview total, and returns
  `duplicate_suspected` when an upcoming reservation exists at the venue that day (unless `allow_duplicate`). Then it
  calls `/3/details` with `commit: 1`, which is what clicking a slot on resy.com sends and which returns a short-lived
  `book_token`, and sends one form POST `/3/book` with `book_token`, `venue_marketing_opt_in=0` and, when the quote
  requires a card, `struct_payment_method={"id":<default card>}`. No card on file is `rejected` before booking. It
  reports `booked` only when exactly one new upcoming reservation matches venue, date, time and party.
- `change_reservation` follows the bundle's Modify flow: details with the reservation's `resy_token`, then POST
  `/3/change` with `book_token`, `resy_token` and `replace=1`; same venue only.
- `cancel_reservation` looks the `resy_token` up from the reservation id and sends POST `/3/cancel`. The
  reservation's live `cancellation` block is `{allowed, date_refund_cut_off, fee: {amount, applies, date_cut_off}}`:
  `allowed: false` is `rejected`, and when `fee.applies` is true (or the block is missing) it returns `fee_applies`
  until the caller passes `accept_cancellation_fee`. `change_reservation` likewise refuses `change.allowed: false`.
- `rate_reservation` posts `rating`, optional `comments` and `resy_token` to `/3/rate/reservation`, as the site's
  rating page does. Already rated is `conflict`; `rating.expired` is `rejected`.
- Tokens (`resy_token`, `book_token`, slot config tokens) and payment method details are never returned.

Evidence: on 2026-10-01 the builder booked, changed and cancelled one real reservation with the user's approval:
a free slot with no card, deposit or fee, eight days out, cancelled within minutes. `/3/details` with `commit: 1`
answers HTTP 201. `/3/change` keeps the reservation_id. `rate_reservation` remains fixture-only (no past reservation). Whether `commit: 1` itself holds
inventory is not established; the tool only calls it immediately before booking. Captcha-gated venues
(`feature_recaptcha`) are not handled and should surface as `rejected`.

Not shipped: event ticket purchases, concierge bookings, party invites (they need another guest's invite token),
following lists (Resy's bundle has no unfollow) and payment or profile changes.

## Write safety: lists and Notify

These follow the repository's write conventions. Reversible writes (`set_list_membership`, `create_list`,
`create_notify`) take an expected state or check for duplicates and do nothing when already at the desired state.
Deletions (`delete_list`, `remove_notify`) also require `confirm: true`, meaning the user asked for this exact
removal; it is a statement of intent, not trusted approval. Every write requires `expected_account_ref`, sends at
most one request, never retries, and decides its outcome by reading the state back:

- the requested state is observed: success;
- Resy answered 4xx and the state is unchanged: `rejected`, with Resy's bounded message;
- anything else after dispatch (timeout, cancellation, session switch, 2xx without the change, unreadable
  readback): `outcome_unknown`. Read current state before deciding; never retry automatically.

Endpoints and encodings come from the site bundle and were confirmed live on 2026-10-01:

- Lists: GET `/3/user/lists` and `/3/user/lists/venue/{venue_id}` (with `is_venue_on_list`); GET
  `/3/user/lists/{list_id}?offset&limit`; POST `/3/user/lists` (JSON `name`, `description`); DELETE
  `/3/user/lists/{list_id}`; POST `/3/user/venues/{venue_id}/lists` (JSON `list_ids`) adds without touching other
  lists; DELETE `/3/user/venues/{venue_id}/lists?list_ids={list_id}` removes. A JSON-array `list_ids` on the DELETE
  is answered with HTTP 400. New lists are private. My Hit List (`is_legacy_hitlist`) is the favorites list: it is
  refused by `set_list_membership` and `delete_list` in favor of `set_favorite`. `set_list_membership` also verifies
  the venue's membership in every other list is unchanged.
- Notify: POST `/3/notify` form field `struct_data` = JSON `{"notifies":[{venue_id, day, time_preferred_start,
  time_preferred_end, num_seats, service_type_id}]}` with `HH:MM:SS` times; DELETE
  `/2/notify?venue_id&day&num_seats&service_type_id`. `/3/notify` items carry the request in `specs` (with
  `party_size`, not `num_seats`) beside a find-style block for the venue. `create_notify` validates the window
  against `notify_options` from `/4/find` (also returned by `get_availability`): start and end on the step,
  inside earliest/latest, start before end; times before the earliest time are read as the next calendar day.
  Upsert semantics for a second window on the same venue/date/party/service are not established, so that case
  returns `conflict` without sending.

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

- Availability and quotes are snapshots, not a hold; no_availability does not say why.
- Raw policies and numeric reservation price do not establish exact final charges or cancellation eligibility.
- The account's reservation collection was empty when inspected; reservation item success and pagination beyond the
  initial page are not live verified. Notify items were live verified on 2026-10-01. Unknown required item shapes fail `site_changed` rather than raw dumping.
- The client's reservation field mappings include cancellation text; bounded text is untrusted data, not instructions.
  Count/text caps do not guarantee a small byte payload: synthetic Unicode policy results exceeded 240 KiB
  (up to about 1.2 MB) and returned through Kernel; local extension handling of those sizes is unverified.
- No list sharing, following or copying, payment/profile/marketing settings, concierge/on-behalf bookings, membership-only inventory
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

### Lists and Notify revision (2026-10-01)

Added `list_lists`, `get_list`, `set_list_membership`, `create_list`, `delete_list`, `create_notify` and
`remove_notify`; `get_availability` gained `notify_options`. The first live `/3/notify` read with a populated
item showed the fixtures modeled a flat item Resy does not return; `list_notify_requests` now reads `specs`, adds
`venue_name` and reports `HH:MM` windows, and a flat item is `site_changed`.

Builder live run on the same signed-in account, starting from no custom lists, an empty Hit List and no Notify:
`create_list` created a private list and refused a case-insensitive duplicate; `set_list_membership` added two
venues (one of them also favorited, whose Hit List membership stayed), returned unchanged on a repeat, refused the
Hit List and removed both; `get_list` honored offset/limit; `delete_list` refused a missing confirm, a wrong name
and the Hit List, then deleted the list. The first removal attempt used a JSON-array query, got HTTP 400 and was
reported as `rejected` with nothing changed; the encoding was fixed. `create_notify` rejected an off-step window and
an unoffered service, created a dinner Notify (initially reported `outcome_unknown` because of the old item shape
above, then verified), returned unchanged and conflict as designed; `remove_notify` refused a missing confirm,
removed it and then reported absent. A lunch Notify was created and removed after the reader fix. The account ended
with exactly its initial lists, favorites and Notify state. This is builder testing, not independent QA.

### Booking, discovery and concise-metadata revision (2026-10-01)

Added `get_booking_quote` (replacing `prepare_reservation`), `book_reservation`, `change_reservation`,
`cancel_reservation`, `rate_reservation`, `get_share_link`, `copy_list`, `get_venues`, `list_events`,
`list_collections` and `get_collection`. Tool and input-property descriptions were rewritten to be short: the 27
tools now send about 20,100 characters of description and input schema, against about 24,400 for the earlier 17.

Live discoveries: `/3/details` with `commit: 0` returns a full quote with no `book_token`; `/3/user/lists/{id}/share`
returns the existing slug and leaves `is_public` false, and any list is readable anonymously by slug, so the share
tool is a link lookup, not publication; `/3/events/location` and `/3/collection/venues` treat `offset` as a 1-based
page (`offset=0` returns nothing for events), while list venues use a 0-based row offset.

Builder live run (signed in, venue pages, 2026-10-01): quote returned total 0 with a $50-per-guest late-cancel fee
and `card_required`; `book_reservation` refused a missing confirm, a stale `expected_total` (one preview request, no
commit or booking) and an unlisted slot; cancel and rate returned not_found on the empty account; venues, city and
venue events, collections and a collection page succeeded; a test list was created, given a share link, copied
(duplicate refused first, then allowed) and both lists deleted. The account ended with its initial lists,
favorites, Notify and reservations. Booking, change, cancel and rating success paths remain fixture-only.

### Live booking run (2026-10-01)

With the user's approval, on a free slot (total 0, `card_required` false, no cancellation fee) eight days out:
`book_reservation` first stopped with `site_error` because the commit-1 `/3/details` request returns HTTP 201 and
account reads accepted only 200; nothing was booked. After accepting any 2xx for reads, it booked one reservation
(seven requests, one `/3/book`, 2.1 s) and verified it by readback; a second booking at the venue that day returned
`duplicate_suspected` with no write. `change_reservation` moved it from 18:00 to 19:00 through `/3/change` (2.7 s; same
reservation_id). `cancel_reservation` refused a missing confirm and a wrong date, then cancelled it (1.4 s) and
verified removal. The account ended with no reservations. No card was attached and nothing was charged.
