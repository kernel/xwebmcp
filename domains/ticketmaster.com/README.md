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

- **search_events** calls the site's own search API (`/api/search/events`) and
  location lookup (`/api/discovery/location/city`, `/api/discovery/location/code`)
  from a `www.ticketmaster.com` page, with the site's client headers. It opens the
  homepage first only when the tab is not on `www.ticketmaster.com`. Dates are the
  venue's local calendar dates; `local_time_from`/`local_time_to` filter on the
  venue's local start time.
- **get_event** reads `/api/eventinfo/<id>`, the record the event page itself loads.
  It never opens the event page.
- **get_ticket_offers** opens `https://www.ticketmaster.com/event/<id>` (unless the
  tab is already there) and reads the listings the page shows. Ticketmaster serves
  two event page layouts:
  - *Classic* (`__NEXT_DATA__.page` `/naevent/[eventId]`, most sports and many
    concerts): the tool issues the same `quickpicks` request the page sends to
    `offeradapter.ticketmaster.com`, with `sort=-quality` for Best Seats and
    `sort=noTaxTotalprice` for Lowest Price. The service key and secret are the
    page's public client configuration in `__NEXT_DATA__`; they are read and used
    inside the page and never returned, logged or committed. The request uses
    `XMLHttpRequest` with credentials and a `TMPS-Correlation-Id` header like the page;
    `fetch` without that header fails CORS.
  - *Newer* (`/globalevent/[eventId]`, including partner-inventory theatre such as
    Broadway houses): listings are computed inside the page from a WebAssembly SDK, so
    the tool reads the listing panel through the accessibility tree. It clicks only the
    quantity filter ("Open quantity filters…", "Set quantity to: N Tickets") and, if
    the panel is in highest-price order, the price-order control. The quantity choice
    is remembered by the site as a display preference, like a shopper changing it.

Outputs:

- Prices are per ticket including fees, before taxes (the site's "All In" price),
  plus `estimated_total` = price × quantity. The classic layout also returns base
  price, fees, face value, seat numbers, the site's seat-quality score and sellable
  quantities; the newer layout's panel only shows ticket type, section, row and price,
  so those fields are `null`.
- Every result carries `observed_at`. Inventory changes by the minute; treat prices
  as quotes at that time.
- `no_tickets` means nothing is available for that quantity (a different quantity may
  have seats) or the page says the event is sold out; the `reason` says which.

## Safety and trust boundary

- Nothing here selects a listing, clicks a "Select …" seat row, accepts the event's
  ticket terms dialog ("I Agree"), reserves, holds, adds to cart or opens
  `checkout.ticketmaster.com`. The tests fail if any listing is clicked. No tool
  exposes a mutation.
- URL patterns are the default `https://ticketmaster.com/*` and
  `https://*.ticketmaster.com/*`. The tools read JSON from `www.ticketmaster.com`
  and, on classic event pages, from `offeradapter.ticketmaster.com`, both inside
  the ticketmaster.com registrable domain, using only the page's own cookies.
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
  distant events across pages, so `search_events` reads the nearby block first and
  falls back to up to 6 date-filtered pages only when the nearby block ends before
  the requested dates. Results outside `radius_miles` (straight-line distance from
  the site's location match) are dropped. Page 49 returned HTTP 400.
- The search index's `soldOut`/`limitedAvailability` flags lag live inventory. A
  preseason NBA game listed as not sold out showed "Tickets are sold out now" on its
  page and zero offers; `get_ticket_offers` is the source of truth.
- Search result ids for partner-inventory events differ from the id in their event
  URL; the tools use the URL id.
- Classic pages show a league or venue terms dialog on load; the offer request works
  without accepting it. The newer layout offers only price orders (low to high, high
  to low), not Best Seats.
- Ticket quantity limits are per event (the newer layout listed 1–6 for one show and
  1–8 for another); a quantity the picker does not offer returns `invalid_input` with
  the offered quantities.

## Known limitations

- US site only (`region=200`, `en-us`, USD).
- `search_events` reads at most 10 location-only pages and 6 date-filtered pages
  (20 events each); a very large market far in the future can miss events.
  `site_total` is the site's rough count; it is `null` when a location and a date
  range were given and the date-filtered fallback was not needed.
- On the newer layout `best_seats` is not available and falls back to lowest price
  with a warning; seat numbers, fees and face value are not shown there. The panel
  may render fewer listings than its "N Results" count; a warning says so.
- On the newer layout `include_resale: false` can only drop listings whose type
  mentions resale; primary/resale is otherwise unlabelled (`inventory_type: null`).
- Waiting rooms (`queue`) and bot-protection pages are detected and reported, not
  passed. Accessible-seating inventory is excluded, as on the site's default view.
- Signed-in-only inventory (member presales, unlock codes) was not tested; the tools
  do not sign in.
- Not live-verified: the queue redirect, a highest-price starting order on the newer
  layout, and events redirecting to another host. They are covered by stubbed tests.

## QA

Pending independent QA.
