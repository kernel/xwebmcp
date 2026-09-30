# ticketmaster.com

Tools for Ticketmaster US (https://www.ticketmaster.com): event search, event details,
ticket availability with prices, artist (attraction) and venue lookup, and public ticket-choice
preparation. No tool purchases, transfers or holds inventory. Public reads work signed out.

| tool | file | status | notes |
|------|------|--------|-------|
| search_events | [search_events.js](search_events.js) | qa_passed | Keyword, city or ZIP, radius and local date/time filters; flags events sold on partner sites |
| get_event | [get_event.js](get_event.js) | qa_passed | One event record by id or URL: local time, venue, category, on-sale and presale windows, limits, terms notice |
| get_ticket_offers | [get_ticket_offers.js](get_ticket_offers.js) | qa_passed | Section, row, seats and price per ticket for a quantity, lowest price or Best Seats; never selects, holds or buys |
| search_attractions | [search_attractions.js](search_attractions.js) | draft | Name typeahead returning numeric ids for artist-type attractions (performers, teams, shows) and venues |
| get_artist | [get_artist.js](get_artist.js) | draft | One attraction by id or URL: type, category, plain-text synopsis, optional about/FAQ/news/experience excerpts, and its events by offset and limit |
| get_venue | [get_venue.js](get_venue.js) | draft | One venue by id or URL: address, coordinates, policy text blocks, optional seat-map images, and its events by offset and limit |
| prepare_ticket_choice | [prepare_ticket_choice.js](prepare_ticket_choice.js) | draft | Public quote-based preparation on the current classic event page; quantity, exact seat/type criteria and USD budget; no selection, queue or hold |

## Native WebMCP tools

None found (checked 2026-09-26 with `webmcp.listTools()` and
`document.modelContext.getTools()` signed out on the homepage, a search results page
(`/search?q=comedy`), a classic event page and a newer-layout event page).
`document.modelContext` exists with zero registered tools and `navigator.modelContext`
is undefined, so the custom namespace `ticketmaster.com` does not overlap with anything
the site registers. Re-checked 2026-09-29 signed out on the homepage, an artist page, a
venue page and a discover page with the runtime's tool discovery: still no site-registered tools.
Re-checked 2026-09-30 on the homepage and a classic event page before registration:
no native tools were listed.

## Scope and loading

Register all seven together, because `forceOverwriteNamespace: true` replaces the whole
namespace:

```javascript
const fs = await import("node:fs");
const read = name => fs.readFileSync(`domains/ticketmaster.com/${name}.js`, "utf8");
const tools = ["search_events", "get_event", "get_ticket_offers", "search_attractions", "get_artist", "get_venue", "prepare_ticket_choice"].flatMap(name => eval(read(name)));
await webmcp.addCustomTools({ namespace: "ticketmaster.com", tools, forceOverwriteNamespace: true });
```

Pick the `tool_ref` whose `source.target_id` is the tab you drive. Use
`timeoutSec: 60` for `search_events`, `get_event`, `search_attractions`, `get_artist` and
`get_venue` (live invocations took 1 to 2 s), and `timeoutSec: 90` for
`get_ticket_offers` (the event page load dominates; live runs took 1 to 11 s).

- **search_events** (`kind: "page"`) runs in the current `www.ticketmaster.com`
  document and calls the site's own search API (`/api/search/events`) and location
  lookup (`/api/discovery/location/city`, `/api/discovery/location/code`) with the
  site's client headers. It never navigates. Dates are the venue's local calendar
  dates; `local_time_from`/`local_time_to` filter on the venue's local start time.
- **get_event** (`kind: "page"`) reads `/api/eventinfo/<id>`, the record the event
  page itself loads, from the current `www.ticketmaster.com` document. It never
  navigates.
- **get_ticket_offers** (`kind: "cdp"`) opens `https://www.ticketmaster.com/event/<id>`
  (unless the tab is already there) and then reads the listings that page shows. It
  is a CDP tool because it navigates and needs the destination's structured offers
  (section, row, seats, prices, fees, ticket type) after that navigation; a page tool
  would be destroyed with the document it navigates away from. Ticketmaster serves
  two event page layouts:
  - *Classic* (`__NEXT_DATA__.page` `/naevent/[eventId]`, most sports and many
    concerts): the tool repeats the `quickpicks` request the page itself sent to
    `offeradapter.ticketmaster.com` (read from the page's resource timing entries, so
    event-specific parameters such as ticket types and featured-listing rules match),
    changing only `qty`, `sort` (`-quality` for Best Seats, `noTaxTotalprice` for
    Lowest Price), `includeResale`, `limit` and `offset`. If the page has not sent one
    within 8 s it builds the same query from the page configuration and warns that
    featured listings may be missing. The service key and secret are the page's
    public client configuration; they are used only inside the page and never
    returned, logged or committed. The request uses `XMLHttpRequest` with credentials
    and a `TMPS-Correlation-Id` header like the page; `fetch` without that header fails
    CORS. With `max_price_per_ticket` it reads up to three pages of 40 listings.
    Featured listings (the service's `promoted` picks, often general-admission lawn
    tickets or primary seats) come first with `featured: true`, as on the page.
  - *Newer* (`/globalevent/[eventId]`, including partner-inventory theatre such as
    Broadway houses): listings are computed inside the page from a WebAssembly SDK, so
    the tool reads the listing panel through the accessibility tree. It clicks only the
    quantity filter ("Open quantity filters…", "Set quantity to: N Tickets") and, if
    the panel is in highest-price order, the price-order control. The quantity choice
    is remembered by the site as a display preference, like a shopper changing it.


Outputs:

- Prices are per ticket including fees, before taxes (the site's "All In" price),
  plus `estimated_total` = price × quantity. On the classic layout the offer service's
  `totalPrice` also includes taxes for some primary tickets; the tool subtracts
  charges of type `tax` and reports them as `taxes_per_ticket`. The classic layout
  also returns base price, fees, face value, seat numbers, the site's seat-quality
  score and sellable quantities; offers that cannot be bought in the requested
  quantity (for example a four-pack when asking for two) are skipped. The newer
  layout's panel only shows ticket type, section, row and price, so the other fields
  are `null`.
- Page-tool outputs that contain non-ASCII text (accented performer names) have been
  observed to arrive from the runtime's page bridge as a JSON string rather than an
  object; parse the string when `typeof output === "string"`. This is runtime
  behaviour, not tool code.
- Every result carries `observed_at`. Inventory changes by the minute; treat prices
  as quotes at that time.
- `no_tickets` means nothing is available for that quantity (a different quantity may
  have seats) or the page says the event is sold out; the `reason` says which.

The attraction tools (`search_attractions`, `get_artist`, `get_venue`), all `kind: "page"`:

- **search_attractions** (`kind: "page"`) runs the site's typeahead (`/api/search/search-suggest`)
  from the current `www.ticketmaster.com` document and never navigates. It returns the
  numeric id that `get_artist` and `get_venue` take, parsed from each suggestion's page
  URL. The site returns at most 10 suggestions per query and only two suggestion types
  were seen (`ARTIST`, `VENUE`), so a type filter can return fewer results than exist;
  it is applied after the site answers. "Artist" is the site's word for any attraction:
  performers, sports teams, touring shows, festivals, tribute acts, parking passes and
  stadium tours all appear as artists, so results carry the site's minor category and
  `get_artist` reports the exact type. A one-character query is HTTP 400 (rejected by
  the tool first); symbol-only or emoji-only queries can also be HTTP 400 and are
  reported as `query_rejected`, while a query the site simply has no match for is
  `no_results`.
- **get_artist** (`kind: "page"`) reads `/api/artist/<id>/info`, the same-origin record the
  artist page itself loads, then the attraction's events from
  `/api/search/events/artist/<id>` (the page's own events query, 20 per site page). With
  `include` it also reads `/api/artist/<id>/enhanced/details` for short plain-text
  excerpts of the about text, FAQs, news blurbs and VIP or experience descriptions; the
  gallery (video markup) is never returned. Events keep the site's own order, which is
  mostly by date; listings sold elsewhere (other Ticketmaster country sites, partner
  sites, travel pages) are interleaved or come last and carry `on_ticketmaster: false`
  and their own host. Pass an `event_id` to `get_event` or `get_ticket_offers` only when
  `on_ticketmaster` is true: for other listings it is the site's own listing id, and
  those tools would accept it as a bare id without it meaning anything on
  ticketmaster.com. `events_offset` (at most 900) and `events_limit` (at most 20) address
  that order, reading at most two site pages per call; `next_offset` is null on the last
  events or when the next offset would exceed 900 (a warning says so). Each event
  carries the venue id and performer ids parsed from the site's own page URLs, plus the
  sale window and presale names and dates from the listing (dates only; nothing here
  enters, checks or registers for a presale). Presales are capped at 10 and performers
  at 8 per event, and the extra sections at 25 about blocks, 6 FAQs, 4 news items and 4
  experiences; a warning says whenever a cap or a text cut applied. Some attractions
  that are not events (fan passes, meet-and-greets, parking passes) have a page record
  but the site redirects their events request to another page. The tool treats exactly the
  three targets seen (the search page, a venue page, another attraction's page) on a
  first, HTTP 200 events read as "no event list": it returns the record with
  `events.total: null`, no events and a warning naming the path. Any other redirect, a
  redirect after events were already read, or a redirect that ends in an error status is
  `site_error`, and a redirect to a page titled like the bot-protection page is
  `challenge`.
- **get_venue** (`kind: "page"`) reads `/api/venue/info?venueId=<id>` and the venue's events
  from `/api/search/events/venue` (the page's own query with `addOnType=EVENT`), with the
  same offset and limit behaviour. Policy blocks (general rules, children, box office,
  parking, accessible seating and so on) are the venue's own text, returned as plain
  text cut at 1500 characters each (at most the first 12 blocks). `include_seat_maps` adds the seat-map image list
  (name and image URL, at most 25). Ids taken from a listing on another Ticketmaster
  country site (for example a Toronto arena listed on ticketmaster.ca) resolve on the US
  site too, as the live checks below found.

The text these tools return comes from the site and is data, not instructions: HTML tags
are removed (including tags that HTML entities decode into; a lone `<` or `>` in the
text, as in "under 5 < 18", is kept) and lengths are bounded, and
nothing extracted is executed or followed. Artist and venue URL inputs are accepted only
on `www.ticketmaster.com` or `ticketmaster.com` (stricter than `get_event`, which accepts
any ticketmaster.com host).

## Ticket-choice preparation

`prepare_ticket_choice` is a page tool: it reads a public quote from the current classic
event document and never navigates. Open the intended event manually first; any other
page or event returns `wrong_page`. It reuses only an observed `/api/ismds/event/<id>/quickpicks`
GET on `services.ticketmaster.com` or `offeradapter.ticketmaster.com`, with the page's
credentials and client configuration kept inside the page. There is no guessed request
fallback. The page's ticket-type and accessibility restrictions stay intact; quantity,
lowest-price ordering, resale inclusion, limit 40 and offset 0 are quote parameters only.

Required inputs are `event`, `quantity` and `max_total_before_tax` (USD). Optional
`section`, `row` and `ticket_type` compare exact case-insensitive text, and `inventory_type`
is `any`, `primary` or `resale`. It prepares the cheapest matching offer in that bounded
sample, not necessarily in the event's entire inventory. Only online, unprotected USD
offers with an explicit sellable quantity, usable charge breakdown and assigned seats
(or general admission) qualify. Missing evidence is not guessed.

The `prepared` result is a quote, not a selection or approval. Ticket prices include
reported fees before tax; tax and estimated totals are separate, and unknown per-order
fees are excluded. The budget checks the before-tax total only. Seat numbers, section,
row and ticket type are plain bounded data. No offer identifiers, client secrets, signed
URLs, barcode or transfer data are returned. Availability is observed at `observed_at`
and can change immediately. The tool does not automatically call another tool.

Purchase, reservation and transfer execution are deliberately absent. The current
runtime has no supported trusted human approval path bound to exact account, action,
seat/recipient, quantity, final cost/date and terms. A model's `confirmed: true` or
confirmation string is not approval and is rejected as malformed input. Review event
terms and final checkout charges manually through the site. No live purchase, hold,
transfer or settings write is part of development or QA.

## URL patterns

All seven tools match only `https://www.ticketmaster.com/*`, not the default
`https://ticketmaster.com/*` and `https://*.ticketmaster.com/*`. The other hosts under
the registrable domain are separate products: the help centre (`help.`), sign-in
(`identity.`), Account Manager (`am.`), the waiting room and
checkout (`checkout.`). The search and event APIs the page tools call are same-origin
only on `www.ticketmaster.com`, so a page tool on those hosts could not work, and none
of the tools should be listed on checkout pages. The bare `ticketmaster.com` redirects
to `www`. The CDP tool uses the same host so the namespace stays on one host, and it
navigates only within `www.ticketmaster.com`. If the tab is on another host, open
`https://www.ticketmaster.com/` first.

## Safety and trust boundary

- The attraction tools only issue same-origin GET requests to the site's public artist,
  venue, search and typeahead endpoints. They never read or write anything tied to the
  signed-in account (orders, tickets, barcodes, favorites, alerts, transfers, resale
  listings), never call reserve, checkout, waiting-list or presale endpoints, and never
  navigate. Presale names and dates in listings are returned as plain data.
- Preparation changes no browser filters or preferences. The existing newer-layout
  `get_ticket_offers` does remember quantity and price-order display preferences; it
  must not be live-tested on a user's session without separate permission. Preparation
  instead returns `unsupported_page` on that layout. All new-tool QA is read-only.
- Nothing here selects a listing, clicks a "Select …" seat row, accepts the event's
  ticket terms dialog ("I Agree"), reserves, holds, adds to cart or opens
  `checkout.ticketmaster.com`. The tests fail if any listing is clicked. No tool
  exposes a mutation.
- The tools read JSON from `www.ticketmaster.com` and, on classic event pages, from
  `offeradapter.ticketmaster.com`, both inside the ticketmaster.com registrable domain,
  using only the page's own cookies. Nothing is sent anywhere else.
- Some search results are sold on other sites Ticketmaster links to, for example
  `www.ticketweb.com` (Ticketmaster's partner box office) and
  `concerts.livenation.com`. Search returns them with `on_ticketmaster: false` and
  their `ticketing_host`; `get_event` and `get_ticket_offers` refuse those URLs, and
  `get_ticket_offers` stops if an event page redirects off ticketmaster.com. No
  pattern was added for those hosts: they are different registrable domains with
  their own checkout flows. Ticketmaster country sites (`ticketmaster.ca`,
  `ticketmaster.co.uk`, …) are separate registrable domains and are also out of
  scope.
- `inventory_source: "partner"` in `get_event` means Ticketmaster lists seats from a
  connected partner system (for example a Broadway box office); the prices still come
  from the Ticketmaster event page.

## Site quirks

- The site's `fetch` is wrapped by its bot-protection SDK, which adds its own headers.
  Calls made through the page's `fetch` from a loaded `www.ticketmaster.com` page
  work; calls before that SDK loads, or from a browser the site has flagged, return
  HTTP 403 `{"response":"block"}` and the page title becomes "Your Browsing Activity
  Has Been Paused". The tools report that as `challenge`. One of three fresh
  residential stealth browsers used while building was blocked this way on the
  homepage; a new session was not.
- `/api/search/events` needs `x-tmplatform: global` and related client headers
  (HTTP 500 without them). With a location, the location-only query lists nearby
  events first in date order (about 10 pages), then restarts with distant events.
  Adding the site's `startDate`/`endDate` filter keeps the date range but interleaves
  distant events across pages, and some in-radius events appear only there (on page
  6 or 7 of 28 for comedy in Los Angeles on a Saturday). With a location and dates,
  `search_events` reads the nearby block (up to 10 pages, stopping once it passes
  `end_date`) and up to 40 date-filtered pages four at a time, merges them, and adds a
  warning when it stops at that cap. Results outside `radius_miles` (straight-line
  distance from the site's location match) are dropped. Page 49 returned HTTP 400.
- The search index's `soldOut`/`limitedAvailability` flags lag live inventory. A
  preseason NBA game listed as not sold out showed "Tickets are sold out now" on its
  page and zero offers; `get_ticket_offers` is the source of truth.
- Search result ids for partner-inventory events differ from the id in their event
  URL; the tools use the URL id. About a fifth of New York theatre ids contain `_` or
  `-` (for example `Z1r9uZ…Je0_`).
- Classic pages show a league or venue terms dialog on load; the offer request works
  without accepting it. The newer layout offers only price orders (low to high, high
  to low), not Best Seats.
- When a shopper changes the tab or quantity on a classic page, the page sends a new
  `quickpicks` query with its default price band (for example
  `any(totalprices,$and(gte(@,42),lte(@,245)))` on tax-inclusive totals) and without
  the featured-listing parameters. `get_ticket_offers` mirrors the page's initial-load
  query instead, with the filter reset to `not('accessible')`, so it ranks every
  listing: below the featured rows its Best Seats list can include expensive resale
  seats the page's BEST SEATS tab hides behind that price band, and for other
  quantities it can include offers (such as a four-pack) the tab omits. The page's
  resource-timing buffer holds 250 entries, so the tool reads the initial query early
  in the page's life; when none is found it falls back to the default query with a
  warning.
- Event pages for past or off-sale performances show "This event is no longer on sale"
  instead of a listing panel; the tool returns `no_tickets` for them.
- Ticket quantity limits are per event (the newer layout listed 1–6 for one show and
  1–8 for another); a quantity the picker does not offer returns `invalid_input` with
  the offered quantities.
- Unknown ids answer differently by endpoint: `/api/artist/<id>/info` and
  `/api/venue/info?venueId=<id>` are HTTP 404 with an empty body (the tools report
  `not_found`), while the events endpoints answer HTTP 200 with `total: 0` for an id that
  does not exist, so the tools read the info record first. An events page past the last
  one is HTTP 200 with an empty list, and a page index of 49 or more is HTTP 400 (pages
  46 to 48 were empty 200s for a venue with 457 events, page 50 was 400). `events_offset`
  is capped at 900 (page 45) to stay below that.
- The events endpoints intermittently answer HTTP 200 with `total: 0` and no events for a
  page in the middle of a list (seen live for page 3 of a 457-event arena, on and off
  within minutes; the neighbouring pages were normal). A page after the first that comes
  back empty is therefore checked against page 0's total: if page 0 says that page should
  hold events, the tool returns `site_error` ("empty events page although it reports N
  events; try again") instead of a short or empty result; if page 0's total is at or
  below the page's start, with no larger total already observed, it is a genuine end of
  list and costs one extra request. A missing or contradictory cross-check total is an
  error rather than a guessed empty result. A flake
  on page 0 itself (or on a page with events) cannot be detected this way.
- Artist and venue events include listings sold on other Ticketmaster country sites
  (Canadian shows appeared in a US artist's list with `www.ticketmaster.ca` URLs and
  absolute venue URLs). Other hosts seen in these lists include `.dk`, `.pl` and
  `theatre.ticketmaster.co.uk` pages, partner sites such as `www.gofevo.com` (interleaved
  by date with the US events), and `travel.ticketmaster.com` pages, which have no
  `/event/<id>` path. The tools mark all of these `on_ticketmaster: false`, keep the
  site's own listing id, and return the link as listed with only per-response tracking
  parameters (`_uid`, `utm_*`) removed, so one link never stands for many performances
  (a London show listed each performance as a fragment of the same page).
- The artist `synopsis` and the enhanced-details prose can contain HTML paragraphs;
  venue policy blocks were plain text. All prose is reduced to plain text and bounded.
  The enhanced details for some attractions (a touring show was seen) are an almost
  empty record.
- The typeahead's `event_count` and the events endpoints' `total` are the site's own
  rough counts and do not always match (456 against 457 for one arena); `event_count` can
  be 0 for an attraction that does have events (two show attractions were seen with 0 in
  the typeahead and 132 and 32 events in `get_artist`, and two small project pages with 1
  and 2). The
  category queries the site uses elsewhere are capped at 10000.
- Repeated calls in a short burst can trip the site's bot protection: about 14 calls
  (roughly 40 requests) within a minute produced an HTTP 403 in one review run. The tools
  report that as `challenge` and discard partial results; wait a few minutes.
- While a tool runs, the page's own scripts can send analytics and advertising requests
  (POSTs to third-party hosts were seen after tool calls). Those come from the site, not
  from the tools, which only send the GETs listed above.
- `type` and `sub_type` are present for some attractions (seen for a baseball team and
  for a band) and absent for others (another band, a tribute act and touring shows); one
  show returned a type in an early read and none later the same day. Treat null as "not
  given" and use `category` for grouping.
- The site's search suggestions include more than performers: sports teams, shows,
  tribute acts, parking passes and stadium tours are all typed `ARTIST`.

## Known limitations

- `prepare_ticket_choice` requires the matching classic event page and its already-observed
  public quote request. Newer-layout offers, queues, protected offers and signed-in-only
  inventory are unsupported. It samples at most 40 listings, retains the observed query's
  restrictions, does not include promoted-only listings, and cannot guarantee the lowest
  price or continued availability. Final taxes, per-order fees and terms remain manual.
  A 401 is `login_required`, 403 `challenge`, 429 `rate_limit`; no automatic retries.
  Cancellation aborts its single GET; there are no writes or uncertain action outcomes.
- Own-order reads are omitted: the authorized account previously returned empty orders,
  so populated ticket schemas and safe field selection have not been established. No
  new login, account selection or account mutation is performed.
- US site only (`region=200`, `en-us`, USD).
- `search_events` reads at most 10 location-only pages and 40 date-filtered pages
  (20 events each) and warns when it stops at the date-filtered cap; without dates a
  very large market can still hide events beyond the nearby block. `site_total` is the
  site's rough count (capped by the site at 10000).
- The page tools need a `www.ticketmaster.com` tab; on any other page they return
  `wrong_page`. A tab showing the bot-protection page returns `challenge`.
- On the newer layout `best_seats` is not available and falls back to lowest price
  with a warning; seat numbers, fees and face value are not shown there. The panel
  may render fewer listings than its "N Results" count; a warning says so.
- On the newer layout `include_resale: false` can only drop listings whose type
  mentions resale; primary/resale is otherwise unlabelled (`inventory_type: null`).
- On the classic layout `max_price_per_ticket` checks at most 120 listings in the
  requested order; with `best_seats` a warning says when cheaper seats may exist
  further down. `best_seats` is the offer service's seat-quality order after the
  featured listings, over all prices, not the page tab's price-banded list.
- Waiting rooms (`queue`) and bot-protection pages are detected and reported, not
  passed. Accessible-seating inventory is excluded, as on the site's default view.
- Signed-in-only inventory (member presales, unlock codes) was not tested; the tools
  do not sign in.
- On the classic layout, listings with the same price can be ordered differently from
  the page's Lowest Price list (the page breaks ties by seat quality; the tool keeps the
  offer service's order). Sections, rows and prices match.
- With `include_resale: false` the offer service returns no featured picks, so
  `featured` is false for listings the page would feature; they still come first when
  they are the cheapest.
- `get_event`'s `terms_notice` comes from the event record; some pages (for example an
  NBA game) show a terms dialog whose title is not in the record, and then it is `null`.
- Not live-verified: the queue redirect, a highest-price starting order on the newer
  layout, events redirecting to another host, a bot-protection page that renders late,
  and another date's "Sold Out" badge next to a loading listing panel. They are covered
  by stubbed tests.
- `search_attractions` sees at most 10 suggestions per query and cannot page; a type
  filter applies after that. It does not surface trending attractions or category
  browsing (a category events query exists on the site and was not built here).
- `get_artist` and `get_venue` accept numeric ids only (an id with leading zeros is
  `not_found`). Ids in the site's other URL forms were not seen. `events_offset` is capped
  at 900, so an attraction with more events than that is only partly reachable, and each
  call reads at most two site pages. Date filters on the artist events endpoint appear in the site's own
  queries but were not verified, so there is no date filter; use `search_events` for a
  date range. Review ratings on the artist page were not built (endpoint not verified).
- Listing status flags come from the search index and lag live inventory.
- Long text is cut (synopsis 1200 characters, venue blocks 1500, about blocks 500, FAQ
  answers 600) and a warning says so; the page has the full text.
- The attraction tools were exercised signed out only. Behaviour while signed in was not
  tested; they do not use the account.

## QA

Independent QA round 1 (smartest preset) on the first revision of the tools (`get_ticket_offers.js` blob `7fabc0a`): **FAIL**, with the
following findings, all fixed in the next commit:

1. Event ids containing `_` or `-` were unreachable (search fell back to the index
   id). Ids now accept `[A-Za-z0-9_-]` everywhere and ticketmaster.com results always
   use the URL id.
2. `include_resale: false` on the classic layout filtered only the first 40 listings
   client-side and could return `no_tickets` although primary seats existed. The flag
   is now sent to the offer service, and `max_price_per_ticket` reads up to three pages.
3. Location plus dates missed in-radius events that only the site's date-filtered
   search lists. Both queries now run and are merged (round 2 found the 6-page cap
   still too small; see below).
4. A flagged session with a momentarily empty event document was reported as
   `unsupported_page`; the tool now re-checks and reports `challenge`.
5. `search_events` and `get_event` became `kind: "page"` tools (same-document fetch,
   no navigation), with URL patterns narrowed to `www.ticketmaster.com`.

Round 1 also verified live: classic-layout Best Seats and Lowest Price against the
page's own tabs (exact match), newer-layout listings against the panel, the
unsupported-quantity path, price filters, not-found ids, the challenge path in two
flagged sessions, schema conformance of 35 live outputs, and no listing clicks,
terms acceptance, checkout, cart or reserve requests.

Independent QA round 2 on the second revision (`get_ticket_offers.js` blob `50fca6d`): **FAIL**. Round-1 findings 1, 2 and 4
were confirmed fixed live; the new findings, fixed in the next commit:

1. Classic-layout primary prices included the service's `face_value_tax` while being
   labelled "before taxes" (for example $244.29 against the page's $231.70). Taxes are
   now subtracted and reported separately.
2. The page's featured listings (general-admission lawn tickets, promoted primary
   seats) were never returned, because the tool built its own query without the
   page's `ticketTypes` and `promoted` parameters and ignored the response's
   `promoted` picks. The tool now reuses the page's own query and lists featured
   picks first; offers not sellable in the requested quantity are skipped.
3. The dated Los Angeles search still missed two in-radius shows on date-filtered
   pages 6 and 7. The date-filtered pass now reads up to 40 pages and warns at the cap.
4. Best Seats did not match the page tab on a promoted-primary concert: documented
   above (round 3 corrected the explanation: the tab applies a price band).
5. Non-ASCII page-tool output arriving as a JSON string: documented above as runtime
   behaviour.

Round 2 also verified: kinds and the narrowed URL patterns, page tools executing
in-page from five kinds of `www` page and not listed on `help.ticketmaster.com` or
other sites, 111 schema-valid live outputs, 31 invalid inputs, the unsupported
quantity path, sold-out reporting, and no clicks other than the quantity filter, no
terms acceptance and no checkout, cart, hold or reserve requests.

Independent QA round 3 on the third revision (`get_ticket_offers.js` blob `9e67dc4`):
**FAIL**. All round-1 and round-2 fixes were confirmed live (the dated Los Angeles
search returned exactly the 7 in-radius shows an independent enumeration of all 28
date-filtered pages found; prices matched the page to the cent in New Jersey and
Chicago; featured lawn listings came first as on the page). New findings, fixed in
the next commit:

1. Off-sale newer-layout pages ("This event is no longer on sale") returned
   `site_error` after 25 s; they now return `no_tickets` as soon as the message shows.
2. A bot-protection page that rendered about 10 s after navigation was reported as
   `unsupported_page`; the empty-document re-check now waits up to 15 s.
3. The README misdescribed why Best Seats differs from the page tab; corrected above.
4. Dead code removed; the tool now prefers the page's initial query (with featured
   parameters) and resets any shopper price band.

Independent QA round 4 on the fourth revision (`search_events.js` blob `c13711d`,
`get_event.js` blob `d94eb27`, `get_ticket_offers.js` blob `c66c961`): **PASS**
(QA agent `agt_cb155ebc4a11ce54cc4c`, 2026-09-26). The registered source was checked
byte-identical to those files. Live, signed out, from the homepage, search, discover,
event and 404 pages:

- Every round-1, round-2 and round-3 finding re-verified fixed: ids with `_`/`-`,
  primary-only offers (32 listings), the dated Los Angeles comedy search (7 events,
  equal to an independent enumeration of all 28 date-filtered and 14 nearby pages),
  tax-free All In prices (New Jersey $231.70 with $12.59 tax reported separately),
  featured lawn listings first to the cent, and off-sale matinees returning
  `no_tickets` in about 5 s.
- 62 live outputs schema-valid; 32 invalid inputs rejected without navigation; tools
  not listed on `help.ticketmaster.com`, `business.ticketmaster.com` or other sites.
- Safety: no listing selected, terms dialogs left unaccepted, tab stayed on the event
  page, no checkout, reserve, cart or hold requests, and the page's service key never
  appeared in output. Signed out throughout; no cart or favourites exist to restore.
- Minor findings, documented under Known limitations rather than changed: tie order
  among equal prices, `featured` with `include_resale: false`, and `terms_notice` on
  pages whose record lacks the dialog title.

Sessions (ephemeral): QA browsers were created and deleted by each QA agent; the
builder's browser was deleted after the final run.

### Attraction tools (`search_attractions`, `get_artist`, `get_venue`)

Historical rounds below predate ticket-choice preparation. The expanded source remains
`draft` pending a new independent review.

Independent QA round 1 (agent `agt_7efe7ebf564202d6ad44`, 2026-09-29) on the first revision
(commit `20829bf`): **FAIL**, with 1 major and 8 minor findings, fixed in the next commit:

1. (major) Lists were capped without a warning: presales at 10 and performers at 8 per
   event, the extra sections, and the policy blocks. Every cap now adds a warning, and
   the README lists the caps.
2. `get_artist` returned `site_error` for attractions such as fan passes, meet-and-greets
   and parking passes, whose events request the site redirects to another HTML page (a
   search page, a venue add-ons page, the parent attraction's page). It now returns the
   record with `events.total: null`, no events and a warning.
3. The `event_count` description said 0 means nothing on sale; the site's count can be 0
   for attractions that have events. Corrected.
4. Links to other sites lost their query and fragment, so 218 London performances shared
   one URL. Only `_uid` and `utm_*` are removed now.
5. Overstated documentation: the ordering of events (partner listings are interleaved),
   which attractions carry a `type`, and that `get_event` "does not accept" other-site ids
   (it accepts any bare id; the id is just not meaningful there). Corrected.
6. A missing `canonicalUrl` produced `https://www.ticketmaster.com/undefined`; the url is
   null now.
7. `next_offset` could be larger than the allowed `events_offset`; it is null now, with a
   warning.
8. Entity-encoded markup decoded into literal tags; tags are removed after decoding too
   (only tag-like text: a lone `<` or `>` is kept).
9. Cutting long text could split a surrogate pair; it cannot now.

Independent QA round 2 (same agent) on `2a252a4`: **FAIL**, 3 minor fixture-only findings
in the code added for fixes 2 and 8, plus one README overstatement, all fixed in the next
commit: a redirect on a later events page discarded events already read (now `site_error`);
a redirect ending in an error status was reported `ok` (now `site_error`, and only the
three redirect targets seen live count as "no event list"); tag stripping removed text
between a literal `<` and `>` (only tag-like text is removed now); the `event_count`
example was overstated. Its mutation run also listed 17 surviving mutants, which new tests
now cover.

Independent QA round 3 (same agent) on `323e029`: **FAIL**, one major finding. Everything
changed in round 2 checked out (the redirect allow-list rejected none of 111 sampled
attraction ids; 8 redirected ids all returned the documented `ok`/`total: null` result;
live synopses, policy blocks and about/FAQ text had no differences from an independent
parse), but the reviewer found that the site's intermittent empty-page response (see Site
quirks) made both list tools return a wrong `ok` with a shortened list and a zero total.
The builder fixed it in the next commit (cross-check against page 0, with fixture tests
and mutation checks) after the two allowed recheck rounds had been used, so that change had no independent sign-off at the previous handoff. The next review cycle
covers that fix and the expanded preparation tool; statuses remain `draft` until it passes.

Round 1 also reported, live: the whole namespace registered atomically with metadata equal
to the checked-out files; no site-registered tools and no name collisions on six page
types; 37 `search_attractions` cases; artist, team and touring-show inputs; pagination
compared with the raw endpoint for five entities with no skipped or duplicated events at
page boundaries; 209 events compared field by field with the raw records (no
differences); 147 outputs validated against the output schemas (error branches
included); the largest output was 30.9 KB; 139 invocations issued only GETs to the
documented endpoints; no keys, tokens or tracking ids in outputs; the tab never navigated
from six starting pages; one real HTTP 403 mapped to `challenge`. Round 1 could not
exercise `wrong_page` or HTTP 429 live (fixtures only).

Local Chrome extension, round 1: **partial**. The CLI was built from the checkout, the six
tools were installed pinned to the commit, site access was granted, and all six tools
registered (the page tools only after a reload following the grant). The new tools returned
`invalid_input` for bad input with no requests, and `challenge` on the site's
"Your Browsing Activity Has Been Paused" page, which the site served to that VM's
datacenter IP. No success path could run in the extension. Kernel results do not transfer
to the extension.

Builder checks, 2026-09-29, signed out, on a fresh Kernel stealth browser. The whole
`ticketmaster.com` namespace (all six tools) was registered atomically with
`forceOverwriteNamespace`, and the three existing tools were not invoked.
- Native tool discovery showed no site-registered tools on the homepage, an artist page,
  a venue page and a discover page.
- `search_attractions`: "madison square garden" (venues and an attraction, ids and counts),
  a `type` filter, an empty result, a rejected `%%` query, a 1-character query rejected
  before any request.
- `get_artist`: a band (48 events across three site pages, including events on
  `www.ticketmaster.ca`), a window spanning site pages 1 and 2 (offset 38, limit 20;
  10 events, `next_offset` null), a sports team with all four `include` sections
  (bounded text, warning on the cut synopsis), an unknown id (`not_found`), a URL input,
  a non-Ticketmaster host and out-of-range inputs.
- `get_venue`: an arena with all policy blocks and 28 seat maps (25 returned with a
  warning), an unknown id (`not_found`), a venue id first seen on a `.ca` listing, and
  bad inputs.
- Invoked from a discover page, an event page and a 404 page under `www`: the tab did not
  navigate and each returned `ok`. The tools were not listed on
  `help.ticketmaster.com`.
- Tool lists are briefly empty right after a navigation while the runtime registers them
  again; retry the discovery.
- Fixture tests (`tests/ticketmaster-attractions.test.mjs`) cover schemas, malformed
  input, challenge and error mapping, pagination, other-country listings, text bounds
  and that no unlisted field leaves the page.
- Not exercised live by the builder: the bot-protection page and HTTP 403/429 paths
  (stubbed tests only), signed-in use, and the Chrome extension runtime.

### Expanded public preparation, 2026-09-30

Builder Kernel checks, signed out: all seven tools atomically replaced the namespace,
including the three untouched existing tools. From a classic event page,
`search_attractions` returned arena suggestions, `get_artist` returned a genuine
past-the-end window (total 270, no events), and `get_venue` returned five events at
offset 60 (total 457). The intermittent empty-page failure did not occur during this
bounded live check; its negative path is fixture-covered. `prepare_ticket_choice`
returned a two-ticket primary choice at $93.70 per ticket before tax, $7.10 reported tax
per ticket, estimated totals $187.40 before tax and $201.60 with reported taxes. The
page stayed put, terms remained unaccepted, and no listing or preference was clicked.
From a discover page preparation returned `wrong_page` without navigation. The quote
request was a public GET to `services.ticketmaster.com`, matching the page's own request.

Fixture coverage includes malformed input before page access, wrong event/host, queues,
protection and rate limits, no-match versus changed schemas, protected/unsupported offers,
integer-cent price arithmetic, explicit quantity, cancellation and secret omission.
No mocked test establishes live mutation success. No new account or order tool is shipped.
Independent review on `704366c`: **FAIL**, three minor findings. An empty events page
with a positive total could lose that total when its page-0 cross-check reported zero;
both list tools now retain the largest total including the empty page itself. Fractional-cent
budgets could round upward; preparation now compares its cent-derived total directly to
the supplied dollar ceiling. Duplicate assigned seats could form a choice; normalized
seat labels must now be unique. Regression fixtures cover all three; recheck pending.

The independent review ran the full suite (1,804 passing), actual AJV checks on 90 fixture
and 12 live outputs, and bounded Kernel reads. All seven tools remained registered;
artist past-end, venue mid-list and preparation success matched the site. The intermittent
empty-page response was not provoked; negative cases remain fixture-only. No old tool,
selection, preference, terms, hold or execution action was invoked.

Current local Chrome extension: **partial**, separate from Kernel. Exact-head installation
and all seven registrations succeeded in isolated signed-out profiles. The settled page
showed "Your Browsing Activity Has Been Paused"; builder invocations returned `challenge`
and `invalid_input`, and the reviewer stopped after registration on that protection page.
No successful local-extension public-data path or runtime parity is claimed. Temporary
public browsers and local profiles were removed.
