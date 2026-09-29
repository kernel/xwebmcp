# resy.com

Tools for Resy (https://resy.com), the restaurant reservation site: restaurant search with
availability, venue profiles, open slots and booking calendars. All four are read-only, work
signed out, and do not sign in, book, hold a table or join a wait list.

| tool | file | status | notes |
|------|------|--------|-------|
| search_restaurants | [search_restaurants.js](search_restaurants.js) | draft | Keyword, cuisine and place search with optional date, party size and time; lists open slot times per venue; flags Tock-booked venues |
| get_restaurant | [get_restaurant.js](get_restaurant.js) | draft | Venue profile by resy.com venue URL or city and venue slug: cuisine, rating, address, contact, About and Need to Know text, party-size limits |
| get_availability | [get_availability.js](get_availability.js) | draft | Open slots for one venue, date and party size: venue-local times, seating type and each slot's raw cancellation and payment fields; never returns booking handles |
| get_availability_calendar | [get_availability_calendar.js](get_availability_calendar.js) | draft | Per-date reservation, event and walk-in state for one venue and party size inside the venue's booking window |

## Native WebMCP tools

None found (checked 2026-09-29 with `webmcp.listTools()` and `document.modelContext.getTools()`,
signed out and signed in, on the home page, a city search page, a venue page and an event page).
`document.modelContext.getTools()` resolves to an empty list, `navigator.modelContext` is
undefined and no element carries a `toolname` attribute, so the custom namespace `resy.com` does not
overlap with anything the site registers.

## Scope and loading

Register all four together, because `forceOverwriteNamespace: true` replaces the whole namespace:

```javascript
const fs = await import("node:fs");
const read = name => fs.readFileSync(`domains/resy.com/${name}.js`, "utf8");
const tools = ["search_restaurants", "get_restaurant", "get_availability", "get_availability_calendar"].flatMap(name => eval(read(name)));
await webmcp.addCustomTools({ namespace: "resy.com", tools, forceOverwriteNamespace: true });
```

Pick the `tool_ref` whose `source.target_id` is the tab you drive. Runs took 0.1 to 0.8 s; `timeoutSec: 60`
is plenty. Typical flow: `search_restaurants` (returns `venue_id`, `city_slug`, `url_slug`) →
`get_availability_calendar` to find open days → `get_availability` for the times. `get_restaurant`
takes the venue URL or `city_slug` plus `url_slug` and returns `venue_id`. Venue slugs are case-sensitive as
returned (some contain capital letters); city slugs are lowercase.

All four are `kind: "page"`. Each runs inside the current `resy.com` document, reads the site's API client key
from `window.apiConfig.Config.apiKey` at run time, and calls `api.resy.com` with the same header set the site's
own requests use. None of them navigates, so no CDP exception applies.

- **search_restaurants** posts the site's venue search (`POST /3/venuesearch/search`). With `date` it asks
  for availability the way the results page does (`availability`, `slot_filter` with day, party size and an optional
  `time_filter`, `order_by: "availability"`). A `location` is a Resy city slug (`new-york-ny`) or code (`ny`), resolved to the
  city's map center from `GET /3/location/config`, which is Resy's whole city list (about 2 MB); pass
  `latitude` and `longitude` to skip it. `resolved_location` in the output gives the coordinates to reuse.
  Distances are straight-line miles computed from the search center. Page size is at most 20 and at most 12
  slots are listed per venue, sorted earliest first, with the full `slot_count`. Coordinates whose search circle
  reaches longitude +/-180 or comes within 1 degree of a pole are rejected because the site's search answers 502
  there.
- **get_restaurant** reads `GET /3/venue?url_slug=&location=`. It returns a fixed allowlist of fields; the
  venue payload also carries announcements, images, social links, venue group and, when signed in, favorite
  and list membership, none of which are returned. Text fields are truncated to 4000 characters.
- **get_availability** posts `POST /4/find` with the venue id, date and party size (`lat` and `long` are 0, as
  the venue page sends them). Each slot has `local_start` and `local_end` (venue-local `YYYY-MM-DDTHH:MM`, no offset; a
  slot after midnight belongs to the requested date but carries the next calendar date), `seating_type` and a
  `policy` object with the site's raw fields for that slot's template (`requires_payment`,
  `cancellation_fee`, `cancel_cutoff_secs`, `cancel_cutoff_time`, `deposit_fee`, `service_charge`). At most the
  first 300 slots are returned, sorted earliest first, with the full `slot_count` and `slots_truncated`; a venue with a slot
  every five minutes all day has about 288.
- **get_availability_calendar** reads `GET /4/venue/calendar` and returns each date's `reservation`,
  `event` and `walk_in` state plus `last_bookable_date`. Observed reservation values are `available`, `sold-out`
  and `closed`; the strings are passed through as the site sends them.

Every result carries `observed_at` where it reports data. Slots and states are snapshots.

## URL patterns

All four tools match only `https://resy.com/*`, not the default `https://*.resy.com/*`. Other hosts under
the registrable domain are separate products: `blog.resy.com` (editorial), `widgets.resy.com` (the booking widget
and reservation-details step), `helpdesk.resy.com` and `os.resy.com` (which redirects to `resyos.com`, a different
domain). The tools call the API cross-origin from a `resy.com` document and read a page global that only that
origin was seen to expose, and none of them should be listed on a booking or details page. `www.resy.com`
redirects to `resy.com`. The check `window.location.origin === "https://resy.com"` inside each tool returns
`wrong_page` if it is ever invoked elsewhere.

## Safety and trust boundary

- Nothing here selects a slot, opens the reservation-details step, holds a table, books, cancels, joins a wait
  list, requests Notify, saves a restaurant or list, or reads or changes account data. The tests fail if the
  sources reference booking, cancel, account, notify or token endpoints.
- The tools never send the signed-in user's auth token. Requests carry only the site's public client key, so the
  same results come back signed in or out. The client key and the booking handle each slot carries are used or
  dropped inside the page and never returned, logged or committed. The tests assert neither ever appears in
  output.
- Venue and slot text comes from the site and is untrusted: it is returned as data, length-bounded, URLs are
  only returned when they are `http(s)`, and slugs are only put into a URL when they match a conservative
  pattern.
- Dates are validated before any request: the site accepts past dates and out-of-range values and answers with
  empty results rather than errors, and some malformed values (a huge radius, page 0, an invalid latitude, a
  search circle that reaches longitude +/-180 or a pole) make its API answer with a 502 error page. The tools
  reject those inputs themselves. The circle rule is an approximation of where the site failed in testing: it also
  rejects a few coordinates the site accepts (for example exactly on +/-180 at the equator) and may still miss an
  odd combination, which the tool reports as `site_error`. No Resy city is near the antimeridian or the poles.

## Site quirks

- The API's cross-origin requests fail at the network layer unless `Cache-Control: no-cache` is sent, which is
  why every request includes it. `credentials` is omitted; authentication is by the `Authorization` key header.
- Slot times (`date.start`, `date.end`) are the venue's local wall-clock times, and late-night slots after
  midnight are dated the next calendar day, so a request for one date can list slots on the next. The tools return
  the full date-time for that reason and sort by it. A request with a time returns slots roughly an hour either
  side of it.
- `notify_offered` reports whether Resy offers Notify for that venue and date. It does not say whether the
  date is sold out.
- The calendar only reports days inside the venue's booking window (`last_calendar_day`, observed 30 to 33 days
  ahead); a request for later dates returns no days rather than an error.
- Some venues list their tables through Tock. Search returns them with `is_tock_inventory: true` and lists
  informational slot times without a Resy booking handle. The venue and find endpoints answer with 404/400 for
  them exactly as for a nonexistent id, so `get_restaurant` and `get_availability` return `not_found` with that
  caveat; closed venues and wrong slugs look the same. The calendar endpoint answers 404 for about half of the
  Tock venues tried and 200 with no days and a null `last_calendar_day` for the rest, which
  `get_availability_calendar` reports as `no_results` with `last_bookable_date` null and a message saying so.
- A search with a `query` and no `location` covers every Resy city. With a location the default radius is
  16100 m (about 10 miles). `radius_meters` of 0 means no limit on the site, so the tools do not accept it.
- The `cuisine` filter is case-sensitive: `Italian` matches, `italian` returns nothing.
- Resy's bot protection (Imperva) can answer a request with a 403 page that carries no cross-origin headers. The
  browser then rejects the `fetch` and the page never sees the status, so such blocks surface as `site_error`
  ("failed before a response arrived"), not `challenge`. A few inputs with markup or SQL-like text were blocked
  this way consistently in QA, and one ordinary query failed once and then passed.
- On the Kernel runtime, `webmcp.invokeTool` returns a page tool's output as a JSON string when the value
  contains non-ASCII characters (restaurant names with accents); parse it when `typeof output === "string"`.
  This is runtime behavior, not tool code.
- Search can list the same restaurant name more than once when a group has several venue ids.

## Known limitations

- US and international cities are supported only as Resy lists them; locations the site hides on the web are
  treated as unknown.
- Availability is a snapshot. `no_availability` does not say whether a venue is fully booked, does not take
  that party size or date online, or has closed reservations; the site does not distinguish them.
- Slot policy fields are the site's raw values. The API does not say whether a fee is per guest or per
  reservation, and how `cancel_cutoff_secs` and `cancel_cutoff_time` apply is stated by the site during booking
  and was not verified, so callers must not present them as exact terms.
- The slot-level `exclusive` eligibility flag and the venue announcement text are not returned: what
  `is_eligible: false` means was not established (it was seen on Tock-listed slots), and announcements were
  stale.
- Tock-booked venues can be found by `search_restaurants` but nothing else in this namespace works for them.
- `gated` (the site's `gating_errors` object) was never observed live; it is covered by stubbed tests only.
  `login_required`, `challenge` and `rate_limited` were never triggered live either, and only the statuses
  the API is known to use for them (401/419, 403, 429) are mapped. Because the page cannot read a bot-protection
  403 (see Site quirks), `challenge` is only reachable when a readable response says so.
- `search_restaurants` reads at most 20 venues per call and pages up to 100; very broad searches need
  narrowing. The site's `total` can shrink between pages.
- `get_availability_calendar` returns at most 400 days.
- Nothing signs in, so wait-list, Notify, favorites, reservations and payment surfaces are out of scope.
- Not verified in the local Chrome extension runtime; see QA.

## QA

Independent QA round 1 (QA agent `agt_221f5a5f11361477ff09`, revision `2a97e7e`): **FAIL**. It ran the whole
namespace live on a Kernel browser (322 schema-validated outputs from tool calls on six resy.com starting pages,
about 143 captured API requests) and in a local headless Chromium 153 with the repo extension. Findings, fixed in
the next commit with new tests:

1. `get_restaurant` rejected venue slugs with capital letters, which `search_restaurants` can return.
2. `get_availability_calendar` returned `no_results` (200, no days, null last day) rather than `not_found` for
   about half of the Tock-listed venues, contradicting the docs. The docs and the result message now describe both
   outcomes.
3. `search_restaurants` accepted `date: null` as if omitted.
4. A bot-protection block on the API is invisible to the page (no cross-origin headers) and surfaces as
   `site_error`; the error message and this README now say so.
5. Longitudes near +/-180 made the site answer 502; they are rejected (see finding 8).
6. The 100-slot cap in `get_availability` cut off the evening for a venue with 144 slots; the cap is now 300 and
   documented, with `slot_count` and `slots_truncated`.

Independent QA round 2 (same agent, revision `6f23528`): **FAIL**, with all six round-1 fixes confirmed live and in
the extension, and these new findings, fixed in the next commit with new tests:

7. A slot that starts after midnight lost its calendar date because only `HH:MM` was returned, so the list looked
   unsorted and a caller combining `date` and time got a slot 24 hours early. Slots now carry `local_start` and
   `local_end` as full venue-local date-times and are sorted by start.
8. The `abs(longitude) <= 179` guard was a heuristic that rejected coordinates the site accepts and missed
   `{latitude: 45, longitude: 179, radius_meters: 100000}` and a pole case. It is now a check on whether the
   search circle reaches +/-180 or comes within 1 degree of a pole, documented as an approximation.

Smaller round-2 corrections: the null-window calendar message no longer claims a cause it did not verify, the
network-failure message says a block can repeat for the same input, and this section's request counts were
corrected. Twenty-six mutants were tried in round 2; those that survived were turned into tests.

Verified live by QA (signed out, 2026-09-29): discovery of exactly four custom page tools registered atomically,
no native tools on the pages checked, tools not listed on `blog.`, `widgets.`, `helpdesk.` or an unrelated site,
all four tools from several starting pages, 105 of 106 malformed inputs rejected with no network request (the
exception was finding 3), slot times and profile fields against four public venue pages (New York, Los Angeles,
Chicago), venue-local times, no cookies or account headers sent and no key or booking handle in any output, and a
largest live output of about 48 KB. Kernel-runtime and local-extension results were kept separate: in the extension
the four tools registered and returned completed results on resy.com with the same findings reproducing; headed
mode, `xwebmcp setup chrome`, the native-messaging bridge and the popup grant UI were not tested. Not tested at
all: signed-in behavior, live `challenge`, `rate_limited`, `login_required` and `gated` outside the bot-protection
case, and a live venue with more than 300 slots (the cap is stub-tested).

No tool has a QA status above `draft` yet; a re-review of the fixed source is pending.

Sessions (ephemeral): builder and QA browsers were created and deleted.
