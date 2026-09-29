# sevenrooms.com

Tools for SevenRooms (https://www.sevenrooms.com), the reservation widget many restaurants embed or link to: a
venue's public booking details and the table times its widget lists for a date and party size. Both are read-only,
work signed out, and do not sign in, hold a table, book, cancel, or use Alert Me.

| tool | file | status | notes |
|------|------|--------|-------|
| get_restaurant | [get_restaurant.js](get_restaurant.js) | draft | One venue's public widget details by `venue_url_key`: address, website, party sizes, booking window, currency, languages |
| get_availability | [get_availability.js](get_availability.js) | draft | Bookable times for one venue, date and party size as venue-local and UTC starts with the widget's label, shift, card and payment fields and deduplicated plain-text venue policies; lists only the site's `book` entries |

## Native WebMCP tools

None found (checked 2026-09-29 with `webmcp.listTools()`, `document.modelContext.getTools()` and a `[toolname]`
attribute scan, signed out, on `www.sevenrooms.com` booking, experiences and events pages, an `fp.sevenrooms.com`
booking page and an `eu.sevenrooms.com` booking page). No site-native tool was listed on any of them,
`navigator.modelContext` is undefined and no element carries a `toolname` attribute, so the custom namespace
`sevenrooms.com` does not overlap with anything the site registers.

## Scope and loading

There is no search across venues on SevenRooms (`https://www.sevenrooms.com/explore` alone is a 404 page), so both tools
take a venue's `venue_url_key`: the path segment in its booking links, `https://www.sevenrooms.com/reservations/<venue_url_key>`
or `/explore/<venue_url_key>/reservations/create/search`. The key is case-sensitive (the same key in different letter
case returned `not_found`). This namespace covers standard dining reservations only: not experiences or ticketed
events (`/experiences/...`, `/events/...`), private dining and large-group times, gift cards, the guest profile or the
operator app.

Register both together, because `forceOverwriteNamespace: true` replaces the whole namespace:

```javascript
const fs = await import("node:fs");
const read = name => fs.readFileSync(`domains/sevenrooms.com/${name}.js`, "utf8");
const tools = ["get_restaurant", "get_availability"].flatMap(name => eval(read(name)));
await webmcp.addCustomTools({ namespace: "sevenrooms.com", tools, forceOverwriteNamespace: true });
```

Pick the `tool_ref` whose `source.target_id` is the tab you drive. Runs took about 0.1 to 2 s (median under 1 s, including
the REPL round trip); `timeoutSec: 60` is plenty. Typical flow: `get_restaurant` (party-size limits, booking window, the key as
the site reports it) then `get_availability`. Outputs that contain non-ASCII text (accented names or policy text) have been
observed to arrive from the Kernel runtime's page bridge as a JSON string rather than an object, and the extension always
returns a string; parse the string when `typeof output === "string"`. This is runtime behavior, not tool code.

Both are `kind: "page"`. Each runs inside the current SevenRooms document and issues same-origin `GET` requests to the
site's own widget API with cookies omitted, so results are the same signed in or out. Neither navigates, so no CDP
exception applies.

- **get_restaurant** reads `GET /api-yoa/dining/widget_info?venue_url_key=<key>` and returns a fixed allowlist of
  fields from `data.base_venue` and `data.widget_settings`. The payload also carries payment keys and account ids, a map
  embed URL with a key, analytics ids and marketing settings, none of which are returned.
  `booking_window_days` is the widget's `maxDaysOut`; `start_of_day_time` is the venue's reservation-day start (see
  Site quirks); `party_size` is `min_guests` and `max_guests`.
- **get_availability** first reads the same `widget_info` (to validate the party size against the venue's online limits,
  which the availability endpoint does not enforce, and to get the venue name and the key as the site reports it), then reads
  `GET /api-yoa/availability/ng/widget/range?venue=<key>&party_size=<n>&halo_size_interval=100&num_days=1&channel=SEVENROOMS_WIDGET&exclude_pdr=true&start_date=<date>&intent=search`,
  the request the widget sends (`exclude_pdr=true` leaves out private dining). Only entries of type `book` become slots.
  Each slot has `local_start` (`YYYY-MM-DDTHH:MM`, venue-local, no offset), `start_utc` (the site's `utc_datetime`),
  `duration_minutes`, `label` (the text the widget prints next to the time), `description_title` (the site's title for the
  slot, which the widget does not print), `shift`, `service` (the shift category), `card_required`, the raw
  `card_payment_rule`, `charge_type` and `cost` (values seen: `save_for_later`, `advanced_payment`, `person`,
  `reservation`), and `policy_id` into `policies`, which holds each distinct venue-written booking and cancellation text
  once, converted from HTML to plain text (at most 10 distinct, 2000 characters each, with `truncated` and a warning
  when a text was cut or was too long to read in full). At most 300 slots are returned, earliest first, with the full
  `slot_count`, and fewer if the output would exceed a 150,000-byte budget (`slots_truncated` and a warning say so).
  `request_only_count` counts the entries the widget does not offer as times (see Site quirks).

Every result carries `observed_at`. Times are snapshots, not holds.

## URL patterns

Both tools match only the guest booking routes on the three hosts where they were observed, twelve patterns:
`https://www.sevenrooms.com/`, `https://fp.sevenrooms.com/` and `https://eu.sevenrooms.com/`, each with the paths
`/reservations/*`, `/explore/*`, `/experiences/*` and `/events/*`. The default `https://*.sevenrooms.com/*` was not used:
the registrable domain also hosts the marketing site (`sevenrooms.com`, which redirects `/reservations/<venue>` to
`www`), the operator sign-in (`/login`) and the operator application, none of which these tools belong on. Each host
answers the widget API for the venues it serves (a venue on `eu` was not found on `www` or `fp`, while other venues
answered on both `www` and `fp`), so the tools call the host of the current page and do not list a venue's host
in advance. Other hosts were not seen; on one the tools are not registered. Inside each tool, a page whose protocol,
host or first path segment falls outside these routes returns `wrong_page` without a request. The checkout step
(`/explore/<venue>/reservations/create/...` beyond `search`) was never visited: the routes it lives on match these
patterns, and the tools were only exercised on the search step, an experiences page and an events page.

## Safety and trust boundary

- Nothing here selects a time, opens the details or checkout step, holds a table, books, cancels, uses Alert Me or a
  request flow, signs in, or reads account data. The tests fail if a source references an endpoint other than the two above,
  uses any method but `GET`, sends cookies, touches storage, clicks, submits or navigates.
- The tools add no cookies, headers or body of their own and only call the current origin's `/api-yoa/` paths. The site's
  own `fetch` wrapper, if any, is outside their control; on the pages checked it added none. Each request has a 25 second
  deadline that is raced against the request, so a page whose `fetch` ignores the abort signal still ends in `site_error`.
- The booking handle each entry carries (`access_persistent_id`), capacity fields (pacing), and the site's payment,
  map and analytics values are never read into output. The tests assert none of them ever appears.
- Venue names, addresses, labels and policy text come from the venue: they are returned as data, bounded in length (cuts
  never split a surrogate pair, and lone surrogates are replaced), with control characters, bidirectional overrides,
  zero-width spaces, word joiners, direction marks and Unicode tag characters replaced by spaces (zero-width joiners and
  non-joiners are kept because some scripts and emoji need them), policy HTML reduced to plain text (see Site quirks), and a
  website URL is only returned when it is `http(s)`. The tool and schema descriptions say the text is data, not instructions;
  the outputs themselves carry no such notice.
- Malformed input is rejected before any request: the availability endpoint answers past dates with an empty success,
  accepts party sizes the venue refuses, and returns only `request` entries for dates beyond the booking window.
- Failures are explicit: `not_found`, `wrong_page`, `login_required` (HTTP 401), `challenge` (HTTP 403 or a bot-protection
  page), `rate_limited` (HTTP 429), `site_changed` (a response shape the tool does not recognize) and `site_error`.
  Never an empty success.

## Site quirks

- `time_iso` on an entry carries the *service* date, so a slot after midnight keeps the requested date there
  (a Toronto venue listed 1:00 AM with `time_iso` dated the service date and `real_datetime_of_slot` the next
  day). `real_datetime_of_slot` is the true local date-time and is what `local_start` uses; `utc_datetime` agreed with it.
  `book` entries carried `real_datetime_of_slot` on every venue checked; an entry without one is skipped with a warning
  rather than dated from `time_iso`. The venue's `start_of_day_time` (06:00:00 on every venue seen) is the boundary between
  service dates.
- `request` entries exist next to `book` entries on many venues. On the six venues compared (in Toronto, Budapest,
  Singapore, New York and two in Las Vegas) the widget listed exactly the `book` entries as time buttons, one button per
  entry (37, 59, 72 and 1 buttons for 37, 59, 72 and 1 `book` entries), and where a venue had only `request` entries it
  showed "There is no availability that meets your search criteria" plus an "Alert Me" control. The tools therefore list `book`
  entries only and count the rest in `request_only_count`. What a `request` entry offers a guest beyond that was not
  verified, and no request or Alert Me control was used.
- The widget's visible label next to a time is the slot's `public_time_slot_description` ("Covered Al Fresco" and
  "Indoor Dining" at the same time at one Melbourne venue, "Patio" or "Sushi Bar" beside an unlabeled default table at a
  West Hollywood venue, "Free Valet Parking" at a Bahamas venue), which
  `label` returns. `public_description_title` is a different field, often a seating type ("Indoor Table", "Patio") and
  sometimes a policy title; the widget prints neither the default table's title nor a policy title next to the time.
  Two slots at the same time can therefore differ only in `label`.
- Policy text (`policy`, `cancellation_policy`) is HTML on many venues and long: one venue's texts were about 17,900 raw
  characters (roughly 6,500 of text), so they are converted to plain text and cut at 2000 characters with `truncated: true`;
  the venue's booking page has the full terms. The conversion drops comments, scripts, styles and tags (a `>` inside a quoted
  attribute value does not end a tag, and an unquoted `<` does not continue one), turns block-level tags (`p`, `div`, `li`,
  `ul`, `ol`, `h1` to `h6`, `tr`, `table`, `hr`, `br` and a few others) into line breaks, so adjacent block tags leave a blank
  line, and table cells into spaces, decodes numeric references and the common named entities (the Latin-1 set and a few
  punctuation names; unknown names stay as written), and leaves a bare `<` or `&` in ordinary prose alone. Only the first
  20,000 characters of each raw text are read (a cut through the middle of a tag drops the partial tag), at most 60 distinct
  raw texts are read per call, and each is converted once; beyond that a warning says the rest was not read.
- The availability endpoint returns an empty `availability` object, or an empty list for the date, for closed days
  and past dates, and only `request` entries beyond a venue's booking window (`maxDaysOut`: 8 to 365 days on the venues
  seen), so dates past the window report `no_availability`. `/api-yoa/availability/dates` omitted only two holiday closures
  for one venue and not a venue's weekly closure, so it is not used.
- Seen once on 2026-09-29: a New York venue's widget, opened on a date whose entries were all `request` (2026-10-08), jumped
  to the nearest date with a `book` entry (2026-10-06), so `no_availability` should not be read as "the venue is closed".
- `num_days` is accepted only as 1 or 3 by the API (2, 4 to 30 returned HTTP 400), and the tool always asks for 1.
- Some venues resolve on both `www` and `fp`; a venue seen on `eu` did not resolve on the others. Venue names can carry
  trailing whitespace (a tab was seen), which the tools trim. Some venue-written seating titles are not seating areas
  (a Las Vegas venue's slot title read "<venue> Reservation Policy"); they are passed through as written.
- Slot texts such as `policy` and `cancellation_policy` repeat per slot, hence the deduplicated `policies` list; two slots
  share a policy only when both plain texts and their `truncated` flags are equal.
- Party sizes: the availability endpoint accepts sizes a venue refuses (it answered 200 for a party of 100 with `request`
  entries only). For some large parties the widget also lists separate private-dining or large-group times from another
  endpoint (`experience_type=PDR`); those are not covered, so `no_availability` for a large party does not mean the widget
  shows nothing.

## Known limitations

- Standard dining reservations for one venue and one date per call. No search across venues, no experiences or events
  availability, no private dining or large-group times (`exclude_pdr=true`; the widget can show such times for some
  large parties), gift cards, guest profile, reservation lookup or cancellation.
- `venue_url_key` is case-sensitive. A lookup with different letter case returned `not_found`.
- Hosts other than `www`, `fp` and `eu` were not seen and are not registered. A `not_found` can mean the venue lives on
  another host; the tool cannot tell.
- `request` entries are counted, not listed, and their meaning was not verified. The widget's "Alert Me" and request
  flows are not covered.
- The site's service charge, gratuity and minimum-spend slot fields are not returned (units and whether they apply were not
  verified; `min_spend` was null on every entry seen). `cost`, `charge_type` and `card_payment_rule` are the site's
  raw values: `cost` was 0, 185, 300 or 700 on the entries seen, and the venue's policy text is the authority on terms.
- A slot's `duration_minutes`, `label`, `description_title` and policy fields are whatever the venue configured; either title
  field can be null or not a seating area at all, and only `label` is what the widget prints beside the time.
- No time zone name is available; `local_start` is venue-local and `start_utc` is the site's `utc_datetime` when present.
- `guest_login_required` (the site's `is_global_client_login_required`) was false on every venue checked; what `true` does to
  the API was not observed, so `login_required` is only mapped from HTTP 401 and was never seen live.
- Live `challenge`, `rate_limited`, `login_required` and `site_changed` outcomes were never observed (fixture tests only).
  All live runs came from Kernel stealth browsers; non-stealth browsers and heavy repeated use were not tried.
- At most 300 times (fewer when the output would exceed 150,000 bytes) and 10 distinct policy texts of 2000 characters are
  returned per call; longer policy text is cut and flagged, and a venue with more than 60 distinct policy texts has the rest
  left unread. A venue whose policy text is very long, or has more than 10 distinct versions, therefore returns
  `policy_id: null` for some times.
- The HTML conversion is a text filter, not an HTML parser: malformed markup such as `a<b and c>d` reads `b and c` as a tag,
  and text hidden with CSS (not with tags) is not recognized. Invisible characters other than the classes listed under
  Safety are passed through.
- The local Chrome extension runtime was not exercised by the author.
- The `intent=search` request parameter mirrors the widget's own requests; whether it affects the site's analytics was not
  investigated.

## QA

Both tools are `draft`: the current source has not been signed off by an independent reviewer.

Author checks (not independent, 2026-09-29, signed out, Kernel stealth browsers, read-only): both tools were registered
through `webmcp.addCustomTools` and invoked through `webmcp.invokeTool` from booking, experiences and events pages on `www`,
from an `fp` page and from an `eu` page; slot counts matched the widget's visible time buttons on three venues; unknown
venues, cross-host misses, a party size over the venue's maximum, a closed day, a request-only date, a date beyond the booking
window and a late-night venue behaved as described above; the tab's URL was unchanged after every call; the tools
were not listed on `/login` or on the marketing root. The tests (`tests/sevenrooms-dining.test.mjs`) use fabricated venues
and never contact the site. Independent QA round 1 (head `f9d4006`) failed on two major findings (the widget's
label field was not returned, and text sanitization was narrower than documented) plus minor ones. Round 2 (head `6a70637`)
found both fixed and no major defect, and failed on minor items only: surviving test mutants, a stale README number, half
surrogate pairs from length cuts, block boundaries and quoted attributes in the HTML conversion, and a slow worst case on
hostile policy text. Those are fixed in the current revision, which is not yet independently re-reviewed.

## Sessions

Ephemeral Kernel browsers used while building were created and deleted by the builder.
