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
takes the venue URL or `city_slug` plus `url_slug` and returns `venue_id`.

All four are `kind: "page"`. Each runs inside the current `resy.com` document, reads the site's API client key
from `window.apiConfig.Config.apiKey` at run time, and calls `api.resy.com` with the same header set the site's
own requests use. None of them navigates, so no CDP exception applies.

- **search_restaurants** posts the site's venue search (`POST /3/venuesearch/search`). With `date` it asks
  for availability the way the results page does (`availability`, `slot_filter` with day, party size and an optional
  `time_filter`, `order_by: "availability"`). A `location` is a Resy city slug (`new-york-ny`) or code (`ny`), resolved to the
  city's map center from `GET /3/location/config`, which is Resy's whole city list (about 2 MB); pass
  `latitude` and `longitude` to skip it. `resolved_location` in the output gives the coordinates to reuse.
  Distances are straight-line miles computed from the search center. Page size is at most 20 and at most 12
  slots are listed per venue, with the full `slot_count`.
- **get_restaurant** reads `GET /3/venue?url_slug=&location=`. It returns a fixed allowlist of fields; the
  venue payload also carries announcements, images, social links, venue group and, when signed in, favorite
  and list membership, none of which are returned. Text fields are truncated to 4000 characters.
- **get_availability** posts `POST /4/find` with the venue id, date and party size (`lat` and `long` are 0, as
  the venue page sends them). Each slot has venue-local `local_time` and `end_local_time`, `seating_type` and a
  `policy` object with the site's raw fields for that slot's template (`requires_payment`,
  `cancellation_fee`, `cancel_cutoff_secs`, `cancel_cutoff_time`, `deposit_fee`, `service_charge`).
- **get_availability_calendar** reads `GET /4/venue/calendar` and returns each date's `reservation`,
  `event` and `walk_in` state plus `last_bookable_date`.

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
  empty results rather than errors, and some malformed values (a huge radius, page 0, an invalid latitude)
  make its API answer with a 502 error page. The tools reject those inputs themselves.

## Site quirks

- The API's cross-origin requests fail at the network layer unless `Cache-Control: no-cache` is sent, which is
  why every request includes it. `credentials` is omitted; authentication is by the `Authorization` key header.
- Slot times (`date.start`, `date.end`) are the venue's local wall-clock times; a request with a time returns
  slots roughly an hour either side of it.
- `notify_offered` reports whether Resy offers Notify for that venue and date. It does not say whether the
  date is sold out.
- The calendar only reports days inside the venue's booking window (`last_calendar_day`, observed 30 to 33 days
  ahead); a request for later dates returns no days rather than an error.
- Some venues list their tables through Tock. Search returns them with `is_tock_inventory: true` and lists
  informational slot times without a Resy booking handle, but the venue, find and calendar endpoints answer
  with 404/400 for them exactly as for a nonexistent id, so `get_restaurant`, `get_availability` and
  `get_availability_calendar` return `not_found` with that caveat. Closed venues and wrong slugs look the same.
- A search with a `query` and no `location` covers every Resy city. With a location the default radius is
  16100 m (about 10 miles). `radius_meters` of 0 means no limit on the site, so the tools do not accept it.
- The `cuisine` filter is case-sensitive: `Italian` matches, `italian` returns nothing.
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
  the API is known to use for them (401/419, 403, 429) are mapped.
- `search_restaurants` reads at most 20 venues per call and pages up to 100; very broad searches need
  narrowing. The site's `total` can shrink between pages.
- `get_availability_calendar` returns at most 400 days.
- Nothing signs in, so wait-list, Notify, favorites, reservations and payment surfaces are out of scope.
- Not verified in the local Chrome extension runtime; see QA.

## QA

Draft: fixture tests only so far, plus a live read-only smoke run on a Kernel browser on 2026-09-29 from resy.com
search, venue and home pages (all four tools succeeded; the failure paths for an unknown location, an unknown or
Tock-backed venue id, a sold-out day, a booking-window miss and malformed input returned the documented
statuses). No independent QA has run yet, so no tool has a QA status above `draft`.

Sessions (ephemeral): builder browsers were created and deleted during the build.
