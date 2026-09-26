# ticketmaster.com

Tools for Ticketmaster US (https://www.ticketmaster.com): event search, event details and
ticket availability with prices. All three are read-only and work signed out.

| tool | file | status | notes |
|------|------|--------|-------|
| search_events | [search_events.js](search_events.js) | draft | Keyword, city or ZIP, radius and local date/time filters; flags events sold on partner sites |
| get_event | [get_event.js](get_event.js) | draft | One event record by id or URL: local time, venue, category, on-sale and presale windows, limits, terms notice |
| get_ticket_offers | [get_ticket_offers.js](get_ticket_offers.js) | draft | Section, row, seats and price per ticket for a quantity, lowest price or Best Seats; never selects, holds or buys |

## Native WebMCP tools

None found (checked 2026-09-26 with `webmcp.listTools()` and
`document.modelContext.getTools()` signed out on the homepage, a search results page
(`/search?q=comedy`), a classic event page and a newer-layout event page).
`document.modelContext` exists with zero registered tools and `navigator.modelContext`
is undefined, so the custom namespace `ticketmaster.com` does not overlap with anything
the site registers.

## Scope and loading

Register all three together, because `forceOverwriteNamespace: true` replaces the whole
namespace:

```javascript
const fs = await import("node:fs");
const read = name => fs.readFileSync(`domains/ticketmaster.com/${name}.js`, "utf8");
const tools = ["search_events", "get_event", "get_ticket_offers"].flatMap(name => eval(read(name)));
await webmcp.addCustomTools({ namespace: "ticketmaster.com", tools, forceOverwriteNamespace: true });
```

Pick the `tool_ref` whose `source.target_id` is the tab you drive. Use
`timeoutSec: 60` for `search_events` and `get_event`, and `timeoutSec: 90` for
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

## URL patterns

All three tools match only `https://www.ticketmaster.com/*`, not the default
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

## Known limitations

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
- Not live-verified: the queue redirect, a highest-price starting order on the newer
  layout, and events redirecting to another host. They are covered by stubbed tests.

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

Round 4 on the fixed source: pending.
