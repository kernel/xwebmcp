# seats.aero

Seats.aero public, cached award flight availability and mileage-program reference data.

| tool | file | status | notes |
| --- | --- | --- | --- |
| list_award_programs | [list_award_programs.js](list_award_programs.js) | draft | Program names, cabins, alliances and transfer-partner keys; one reference-data read |
| search_award_availability | [search_award_availability.js](search_award_availability.js) | draft | Cached program/cabin minima within the conservative public date window; one search read |
| get_award_trips | [get_award_trips.js](get_award_trips.js) | draft | Cached itinerary segments, local times, miles and taxes; one enrichment read, no booking links |

## Scope and loading

These are `kind: "page"` tools. They read the same-origin JSON that the public page
uses, without changing the document, clicking, submitting forms, storing state or
navigating. They require the public navigation's Login link and refuse pages without
it, including signed-in pages. They do not sign in, read account data, create alerts,
change saved searches, open booking links, refresh inventory or request paid live
searches. No action or execution tool is included.

Register the entire namespace atomically:

```javascript
const fs = await import("node:fs");
const names = ["list_award_programs", "search_award_availability", "get_award_trips"];
const tools = names.flatMap(name => eval(fs.readFileSync(`domains/seats.aero/${name}.js`, "utf8")));
await webmcp.addCustomTools({ namespace: "seats.aero", tools, forceOverwriteNamespace: true });
```

Open a public `https://seats.aero/` page before discovery. Invoke serially using the
live registration's `tool_ref` and `timeoutSec: 25`. Each invocation makes at most one
GET, with a 15-second fetch/body deadline and a 2 MiB response-body limit. HTTP
redirects are not followed; challenges, access denials and rate limits are reported
without retries. The tools do not solve or bypass challenges.

- `list_award_programs`: optional `query` (name, program key, airline code or alliance)
  and `limit` 1–80, default 40. Reads `/_api/vuerefdata?v=<build>` using only the build
  hash observed in the current document's resource timing. If that request is absent,
  returns `wrong_page`; it never guesses a version or navigates to find one. Returns
  `program_id`, names, `airline_code`, `alliance`, supported `cabins`, `has_trip_data`
  and enabled bank `transfer_partners` (the site's keys, not normalized bank names).
- `search_award_availability`: `origins` and `destinations` contain 1–2 distinct
  uppercase airport or site-defined metro codes each, `depart_date` is YYYY-MM-DD,
  `additional_days` is 0–7 on either side, `cabin` is any/economy/premium/business/first,
  `min_seats` is 1–9 and `limit` is 1–40 (default 20). Reads `/_api/search_partial`
  with the observed public request parameters, including the site's default
  `max_fees=40000` and `disable_live_filtering=false`; these are not user-configurable.
  Returns rows with opaque `availability_id`, `program_id`, actual airports, departure
  date, last-seen hours and per-cabin mileage minima, direct-availability flag, seat
  count, carriers and taxes. The minimum may be for a connecting itinerary even when
  direct availability exists. The endpoint's response order is preserved.
- `get_award_trips`: takes `availability_id` **and the row's `depart_date`**, optional
  `cabin`, and `limit` 1–20 (default 10). Reads
  `/_api/enrichment_modern/<availability_id>` once. It checks the returned date, row
  identity, program, airports and segment identities before returning trip data.
  Returns up to 20 cached itineraries with at most six segments each. A mismatched
  departure date returns `gated`, not a record with an unrelated date. It deliberately
  excludes the endpoint's booking URLs and revalidation identifiers.

Successful outputs include `attribution`, `observed_at`, `total_matches`, `has_more`
and the bounded `programs`, `rows` or `trips` array. `no_results` only means no matches
in the cached, site-filtered response. Neither availability nor seat counts prove a
flight can be booked; verify separately with the mileage program.

Failures use a separate `{status, message}` shape: `invalid_input`,
`invalid_airports`, `wrong_page`, `challenge`, `login_required`, `gated`,
`rate_limited`, `not_found`, `site_changed`, `site_error`, `response_too_large`,
`timeout` or `canceled`. Error messages are fixed strings, not raw server responses.

## Native WebMCP tools

No native tools were found on the signed-out homepage on 2026-09-30:
`document.modelContext.getTools()` and `webmcp.listTools()` both returned empty arrays
before custom registration. The public search page also exposed none during discovery
on 2026-09-29. Native registrations behind login were not inspected.

## URL patterns

Only `https://seats.aero/*` is matched. `developers.seats.aero` is API documentation
and `docs.seats.aero` is the help center, not the award-search application. Page-local
`/_api/` requests on those hosts would be wrong. `www.seats.aero` redirects to the
apex; `rooms.aero` is a separate hotel-award product and namespace. No pattern is
added for airline booking sites.

## Observed mechanisms and units

Signed-out discovery on 2026-09-29 observed the search page calling
`/_api/search_partial` and its trip modal calling `/_api/enrichment_modern/<id>`
without navigation. The bare enrichment path returned the same body as the modal's
query-bearing request. The page's reference-data call was observed again on
2026-09-30, with 33 program keys (reference data changes over time).

- Search response cabin prefixes are `y` economy, `w` premium, `j` business and `f`
  first. The tools allowlist fields, rather than returning raw metadata or nested
  alternate-stop data.
- Tax values are preserved as `amount_hundredths` and `currency`. For the observed
  USD case, 41433 matched $414.33 on the page. No currency conversion is performed;
  interpretation for currencies with different ISO minor-unit conventions remains
  unverified.
- Trip and segment timestamps had a `Z` suffix but matched airport-local wall-clock
  labels on the page. Outputs remove that suffix, retain the date/time without a
  timezone conversion, and report `time_basis: "airport_local"`. Duration is the
  site's minutes, not a subtraction of local timestamps.
- An omitted search seat count is `null`. With `min_seats > 1`, unknown counts are
  excluded. Trip `remaining_seats=0` can mean the count is unknown; it must not be
  interpreted as sold out.
- Searches beyond the signed-out horizon returned empty JSON with no error while the
  UI displayed a PRO upsell. To avoid false empty successes and date-boundary ambiguity,
  both tools require the entire window to be today through **57 UTC days ahead**.
  Later dates return `login_required` before making a request, even if a particular
  site account might support them. No PRO shapes are assumed.

## Known limitations

- Signed-out only; no PRO, live search, paid quotas, account, alert, seat-map or saved
  search tools. No booking, purchase, hold or handoff to an airline URL is performed.
- Only cached records are returned. Coverage can be incomplete, stale or phantom;
  the default fee filter can omit otherwise available trips. `total_matches` is the
  parsed match count, not comprehensive airline inventory.
- Output is capped without pagination or automatic continuation. Overlarge responses
  fail explicitly; narrow the inputs rather than repeatedly scanning broad regions.
- Internal `_api` contracts are undocumented and can change. Missing expected fields
  fail as `site_changed`, not empty availability. Lists cannot run on a document that
  lacks an observed reference-data request.
- Cloudflare challenges, authwalls, PRO gates and rate limits are not bypassed.
- The site's terms at `https://seats.aero/terms` restrict automated use of the Service
  and commercial API use without written permission; they also restrict automated Pro
  subscription use. These tools do not establish site permission or a commercial
  agreement. The separately documented Partner API is not used by these page tools.
- Unverified: PRO response shapes, logged-in behavior, non-USD tax presentation,
  currencies with zero decimal minor units, and changed site date-window boundaries.

## QA summary

Fixture tests: `node --test tests/seats-aero-public.test.mjs`. Fabricated records cover
success, empty results, malformed inputs before requests, signed-in refusal,
wrong-origin and missing-reference guards, invalid airports, HTTP/access challenges,
redirect denial, cancellation/timeouts, byte/output bounds, date guards, source-shape
changes and allowlisted output. They re-create each execute function in an isolated
page context to check it does not depend on tool-schema closures.

Author live checks on 2026-09-30: the entire namespace was registered and discovered
on a signed-out Kernel homepage. `list_award_programs` returned 33 programs (five
returned with `limit: 5`, `has_more: true`), with the URL unchanged. A program without
an airline code is represented by `airline_code: null`. A far-date search returned
`login_required`; a malformed trip id returned `invalid_input`. After navigation to
`example.com`, no seats.aero tools were listed.

A cookie-free public search request returned Cloudflare HTTP 403; that path was
stopped without retries or configuration changes. Final-source search/trip success
has not been live-verified; their success parsing is grounded in the 2026-09-29
observations and fabricated fixtures. Independent QA is pending; all tools remain
draft. Extension fixture tests pass, but that alone does not verify installation or
invocation in a real local Chrome extension.
