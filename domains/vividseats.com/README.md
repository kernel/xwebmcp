# vividseats.com

Tools for the Vivid Seats US marketplace (https://www.vividseats.com): event search and live ticket listings with all-in prices. Both tools are public and read-only.

| tool | file | status | notes |
|------|------|--------|-------|
| get_ticket_offers | [get_ticket_offers.js](get_ticket_offers.js) | verified | Listings for one event, cheapest first, with quantity, all-in price range, zone and section filters, zone/section grouping and the site's stated price basis |
| search_events | [search_events.js](search_events.js) | verified | Events by text, place, dates, category, performer, venue and lowest-price ceiling, one bounded page at a time |

## Native WebMCP tools

None found (checked 2026-09-29 with `webmcp.listTools()` and `document.modelContext.getTools()` signed out on the home page, Explore, a performer page, an event page and a venue page, and signed in on the account pages). `document.modelContext` exists with zero registered tools and `navigator.modelContext` is undefined, so the custom namespace `vividseats.com` does not overlap with anything the site registers.

## Scope and loading

Register both tools together, because `forceOverwriteNamespace: true` replaces the whole namespace:

```javascript
const fs = await import("node:fs");
const read = name => fs.readFileSync(`domains/vividseats.com/${name}.js`, "utf8");
const tools = ["search_events", "get_ticket_offers"].flatMap(name => eval(read(name)));
await webmcp.addCustomTools({ namespace: "vividseats.com", tools, forceOverwriteNamespace: true });
```

Both tools are `kind: "page"`. They run in the current `www.vividseats.com` document, call the site's own same-origin JSON endpoints with `fetch`, and never navigate. Use `timeoutSec: 60`; live calls took well under 5 s.

- **search_events** calls `GET /hermes/api/v1/productions`, the endpoint behind the site's Explore and search pages. With `location`, it first resolves the place through the site's three-call place lookup (`/location/search/token`, `/location/search/query`, `/location/<placeId>`, with the `x-places-session-token` header the lookup requires) and uses the first match, returned as `resolved_location`. Coordinates can be given directly instead. Dates are the venue's local calendar dates; `end_date` is inclusive and both dates are optional. `radius_miles` is sent to the site in metres (miles × 1609) and is approximate: independent review found venues up to about a third farther away than a 25-mile radius (Joliet at 33.7 mi from central Chicago), so the tool warns when a returned event is beyond it and `distance_miles` (the site's per-event `distance`, metres on the wire) is the value to filter on. The site serves only the first 1000 matches: a `page` whose first result would be past the 1000th is rejected as `invalid_input` before any request (the site answers those with HTTP 400), and a `page` past the last page of a smaller result set returns `no_results`, because the site would otherwise answer with the last page again under a new page number. Results carry the event's `production_id`, which `get_ticket_offers` takes.
- **get_ticket_offers** calls `GET /hermes/api/v1/listings?productionId=…`, the endpoint the event page itself uses. The site returns every listing at once; quantity, price, zone and section filtering and the grouping are done in the tool, so `limit` bounds only `offers` and the counts and groups cover all matches. A listing's `purchasable_quantities` come from the site's per-listing quantity list (a listing of 4 can be sold as 1, 2 or 4 but not 3); with `quantity` set, the tool keeps listings whose list contains it. On two theatre events the builder checked (2026-09-29) this reproduced the page's "Any Quantity" and 2-ticket views: the same listing count and the same first twelve rows (section, row, price to the dollar). The page groups same-section general-admission listings into one row ("GA Floor 1–15 tickets from $1,342"), so on an event with such listings the page's "N listings" is smaller than `matching_listings` while the ordinary rows still match. Listings are ordered by all-in price ascending; equal prices keep the site's order.
- **Price basis.** Prices are per ticket in USD. `price_basis.includes` is built from the site's own `aipIncludedPrices` for that event (`CUSTOMER_PRICE` → `listing_price`, `SERVICE_FEE` → `service_fee`, `ELECTRONIC_DELIVERY_FEE` → `electronic_delivery_fee`, `HARDSTOCK_DELIVERY_FEE` → `hardstock_delivery_fee`; unknown components are passed through in lower case) and `vat_included` from `vatAddedToAip`. On the observed events the components differed: a US theatre event listed three components without VAT, and a London event listed four with VAT. The tool refuses (`price_basis_unavailable`) instead of guessing when the site does not say what its all-in price contains. The site also states that taxes and delivery are not included "where applicable"; the tool cannot see checkout and says so in `price_basis.note`.
- **Price group.** Vivid Seats prices per browser session: the page sends a `priceGroupId` equal to its `pgid` cookie. Sessions observed had `pgid` 416, where all-in prices differed from the same request without the parameter by about 2% (higher on one event, lower on another), and 21, where they were identical. `get_ticket_offers` sends the page's `pgid` and returns it as `price_group_id`; without the cookie it omits the parameter and warns.
- **Search prices are an index.** `search_events` prices, listing counts and ticket counts come from the site's search index, which refreshes periodically (`pricing_refreshed_at`). On 2026-09-29 an evening show the same day still showed 25 listings and a "from" price in the index while its event page said "no tickets available" and the listings endpoint returned none. Treat search prices as a guide and quote from `get_ticket_offers`.
- Everything site-authored that is returned (event, venue, section, row, delivery type, badge and perk labels) is control-character-stripped and length-bounded. Seller notes, seller identity and the listing's cost components are not returned.

## URL patterns

Both tools match only `https://www.vividseats.com/*`, not the default `https://vividseats.com/*` and `https://*.vividseats.com/*`. The registrable domain hosts unrelated products: `corporate.vividseats.com` (company site, careers, press, partners) and `investors.vividseats.com` (investor relations) have no event marketplace and no `/hermes` endpoints. The JSON endpoints the tools call are same-origin on `www.vividseats.com`, so a page tool on those hosts could not work. The bare `vividseats.com` redirects to `www`; open `https://www.vividseats.com/` first when the tab is elsewhere.

## Safety and trust boundary

- The tools issue only `GET` requests to `/hermes/api/v1/productions`, `/hermes/api/v1/listings` and the three `/hermes/api/v1/location/…` place-lookup endpoints. A test fails if the source references any other `/hermes` path or sets a request method. Nothing selects a listing, opens the event's purchase flow, adds to a cart, reads or changes an account, favorites, rewards or seller listings, or touches payment.
- Requests are made with the page's ordinary same-origin cookies; the tools add no credentials and never read the site's account cookies or headers. The place-lookup session token is used inside the page and never returned.
- Results are quotes at `observed_at`, not reservations. A listing being returned does not prove it can still be bought.
- The listing id (`listing_id`) is the site's own identifier; the tools never build listing or checkout URLs from it.

## Site quirks

- Location and currency are chosen from the browser's IP address. The tools always request USD and refuse (`site_changed`) a response that says its prices need a currency conversion. With `currency=EUR` the same numeric fields came back unchanged alongside a conversion rate, which is why only USD is supported. International events are priced in USD by the site (a London theatre listing showed "$139 USD" on its page and `allInPricePerTicket` 139.00).
- The site's bot protection cookies (Akamai-style names) and a first-party obfuscated script are present on every page. Several hundred same-origin reads from stealth Kernel browsers with US residential egress were never blocked. A 403 is reported as `challenge` and a 429 as `rate_limited`; both are also possible on other IPs or at higher rates than were tried.
- The search endpoint's `total` stops at 1000 on broad searches (a performer or venue search reported its real count, 856 and 291 in testing). `pageSize` values above 100 were accepted by the site, but the tool stops at 50.
- The site's "under $N" price filter (`minListingPriceCeiling`) compares the lowest all-in price in the index and keeps events with no listings (index price 0). Its parameter takes whole dollars only.
- Sorting by price exists on the site but orders by the pre-fee price and puts unpriced events first, so the tool offers only popularity and date.
- A date range that ends before today answers HTTP 404 with the message "Event date has passed" (checked 2026-09-29 for yesterday and for 2020 dates); the tool reports `no_results` for exactly that message and treats any other 404 as `site_error`. A range that starts in the past but ends today or later works. Reversed or impossible dates are rejected by the site with 400 and by the tool before any request. An unknown performer or venue id answers 200 with no items.
- The parking passes the site sells as separate events are hidden with `excludeParking`; without it a plain search returns them mixed in.
- Category ids observed: 2 concerts, 3 sports, 4 theater (comedy is theater, subcategory 11). The tool supports the three categories, not subcategories.
- Events that have already started stay in the search index for the rest of the day with prices and listing counts that can be stale, so a plain search for today can list them first; the tool warns when it returns any. `delay_type` values seen live are `NONE` and `RESCHEDULED`. Events with a date or time still to be announced exist (`date_tbd`, `time_tbd`) and can match a date filter through the site's placeholder date.
- A query containing HTML or script-like text drew a 403 from the site's bot protection in one review probe; the tool reports it as `challenge`.
- On the Kernel runtime, an output that contains non-ASCII text (for example a query for an accented performer name) can reach the caller as a JSON string instead of an object, as the ticketmaster.com README also notes; parse the string when `typeof output === "string"`. The Chrome extension returned an object.
- A cookie-consent banner can appear on a fresh session. The tools do not interact with it, and the endpoints they read answered while it was showing.

## Known limitations

- US marketplace only, USD only. Other country sites and the `/es*` locales were not assessed.
- `get_ticket_offers` returns section, row, zone and prices, not seat numbers: the listings endpoint has none, and the seat map and listing detail views were not opened. It does not read the event's date; take that from `search_events`.
- `quantity` accepts 1 to 8, the counts the site's quantity picker lists individually; the picker's "8+" is not covered.
- Deal scores, the site's "Best Value" style ordering, sold-listing history and resale price alerts exist on the page and are not exposed. Sorting is cheapest all-in price first only.
- The lowest-price ceiling and search prices depend on the index described above; `listing_count` 0 in search does not prove there are no tickets and a positive count does not prove there are.
- A place name resolves to the site's first match with no disambiguation input (a bare "Springfield" or "Portland" resolves to whichever state the site ranks first); check `resolved_location`, use 'City, ST', or pass coordinates.
- The listing endpoint returns every listing in one response; an event with about one thousand listings (a stadium game) was read in a single call in testing. Much larger responses were not seen.
- Waiting rooms, purchase-time holds, sign-in-gated inventory and member pricing were not assessed. The tools are public reads; in one signed-in session the listings endpoint returned the same listings and prices as signed out, but the tools themselves were only run signed out.
- Only the response fields listed in the output schemas were observed and used. If the site renames them the tools return `site_changed` rather than partial data.
- Not live-verified (stubbed tests only): the `challenge` and `rate_limited` branches for a genuine block, the `site_changed` and `price_basis_unavailable` branches, and the currency-conversion refusal (the site does convert when a non-USD currency is requested, which the tools never do). Events priced in a non-US currency were checked for a London event (builder) and Paris and Toronto events (reviewer); all came back in USD.

## QA

Both tools are `verified` as of 2026-09-29: an independent reviewer (`agt_0257fb751e04553b9365`) signed off on the final source (`search_events.js` and `get_ticket_offers.js` as of `62722a2`) after three review rounds, and live success was shown on the real site from pages other than an event page. The status describes the Kernel browser runtime; the Chrome extension was only exercised headlessly with a simulated site grant (below).

Independent QA round 1 (Hypeship reviewer `agt_0257fb751e04553b9365`, 2026-09-29) on `d759de8`: **FAIL**. About 230 live invocations on Kernel browsers (US residential, default stealth and Japan residential egress), 23 more through the Chrome extension, and 168 outputs validated against the output schemas with no violations. Findings, all fixed in the next commit:

1. (blocking) `search_events` with a `page` past the last page of a small result set returned `ok` with the last page's events under new ranks, because the site clamps to its last page. It now returns `no_results`.
2. A `page` past the 1000-match window was reported as `site_error` (the site answers HTTP 400). It is now `invalid_input` before any request.
3. `radius_miles` is approximate on the site; the description now says so and the tool warns when an event is beyond it.
4. Events that had already started lead a plain search for today with stale index data; the tool now warns.
5. `get_ticket_offers` accepted `quantity: null`; it now rejects it.
6. README and schema text that live behavior contradicted (`RESCHEDULED` and TBD events do occur; the direction of the price-group difference varies by event; the page collapses same-section general-admission rows so its listing count can be smaller; the bare apex redirects to `www`) were corrected. `purchasable_quantities` is no longer cut off at 20.

Independent QA round 2 (same reviewer, 2026-09-29) on `7300723`: **PASS**. All six round-1 findings reproduced as fixed on Kernel and, for 1, 2 and 5, in the extension; about 280 more outputs validated against the output schemas with no violations; paging was checked at the window edges and at exact-multiple totals. One minor finding, fixed in the next commit: the "already started" warning also fired for time-TBD events, whose placeholder start instant (23:59Z on the local date) is not a stated start time. The past-the-end message also now reads "N page(s) at page_size M".

Independent QA round 3 (same reviewer, 2026-09-29) on `62722a2`: **PASS**, no defects. The time-TBD warning fix was checked by frozen-clock replay of a live response and by scanning 797 live events for today through 1 October (the warning count equalled the events with a stated start time before the observation on every page); a time-TBD event whose placeholder instant is already past could not be found live, so that suppression is proven by replay and the unit test only. The past-the-end message, window edges and `has_more` arithmetic were unchanged. `get_ticket_offers.js` was byte-identical to round 2.

Live end-to-end success cases (2026-09-29, Kernel, signed out): `search_events {query: "olivia rodrigo", page_size: 3}` and `get_ticket_offers {event: "6969246", limit: 3}` from `/explore`; both tools from a performer page (`/olivia-rodrigo-tickets/performer/130861`), from a 404 page, and from the home page; in the extension, both from `/explore` (`get_ticket_offers {event: "6969246", quantity: 2}` returned 3 offers from 44 matching listings). Page-versus-tool comparison: the reviewer matched the event page's first 12 rows (section, row, price) at quantity 1 and 2 on event 6969246, and the page's listing counts on two theatre events (136 for any quantity and 112 for two tickets on one, 44 and 44 on the other); the builder matched 41 of 41 listings and the first 12 rows at quantity 2 on another event. The page groups same-section general-admission rows, so its count is smaller than the tool's on events that have them.

The reviewer's Kernel and extension results matched each other apart from two runtime differences: non-ASCII output reaches the caller as a JSON string on Kernel and as an object in the extension, and a navigation that interrupts a call ends as `outcome_unknown` immediately in the extension and after the full timeout on Kernel. The extension run was headless Chromium 153 with the site-access grant simulated by a `host_permissions` entry in a scratch copy of the manifest, so the interactive grant, the popup and the side panel are unverified.

Builder checks (2026-09-29): 121 stubbed-fixture tests in `tests/vividseats-events.test.mjs`, live read-only calls to every endpoint used from stealth Kernel browsers, and a separate run of both tools through the repo's Chrome extension on a local headless Chromium 153 profile (same grant caveat). Sessions were created and deleted by the builder and are not recorded here.
