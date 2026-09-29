# marriott.com

Tools for Marriott Bonvoy hotels (https://www.marriott.com): public hotel search with per-night cash rates and points, and public facts for one hotel. Both are read-only and work signed out.

| tool | file | status | notes |
|------|------|--------|-------|
| search_hotels | [search_hotels.js](search_hotels.js) | draft | Destination text or place_id, dates, rooms, adults per room, radius, optional points; hotels by distance with rating, lowest displayed cash rate per night and points per room |
| get_hotel | [get_hotel.js](get_hotel.js) | draft | One hotel by property code, slug or overview URL: address, phone, check-in/out times, amenities, coordinates, FAQ answers |

## Native WebMCP tools

None found (checked 2026-09-29 with `webmcp.listTools()` and `document.modelContext.getTools()`, signed out, on the homepage, `/search/default.mi`, `/offers.mi` and a hotel overview page). `document.modelContext` exists with zero registered tools and `navigator.modelContext` is undefined, so the custom namespace `marriott.com` does not overlap with anything the site registers.

## Scope and loading

Register both tools together, because `forceOverwriteNamespace: true` replaces the whole namespace:

```javascript
const fs = await import("node:fs");
const read = name => fs.readFileSync(`domains/marriott.com/${name}.js`, "utf8");
const tools = ["search_hotels", "get_hotel"].flatMap(name => eval(read(name)));
await webmcp.addCustomTools({ namespace: "marriott.com", tools, forceOverwriteNamespace: true });
const live = (await webmcp.listTools()).find(t => t.source.custom?.namespace === "marriott.com" && t.tool.name === "search_hotels");
const result = await webmcp.invokeTool(live.tool_ref, { destination: "Portland, OR", check_in: "2026-11-10", check_out: "2026-11-12", limit: 5 }, { timeoutSec: 60 });
```

Use `timeoutSec: 60`; live calls took 0.2 to 2.5 s (the first call after a page load can take a few seconds longer). Both tools are `kind: "page"`: they run in the current `www.marriott.com` document, send same-origin requests with the page's own cookies and never navigate, so their result always survives.

- **search_hotels** calls three of the site's own persisted GraphQL operations at `POST /mi/query/<operation>`, the ones the search page sends: `phoenixShopSuggestedPlacesQuery` (destination text to suggestions), `phoenixShopSuggestedPlacesDetailsQuery` (place to coordinates and type) and `phoenixShopDatedSearchByGeoQuery` (the hotel list with rates). Nothing is written: they are read queries, and the tool sends no selection, cart or booking request. Amounts are average per night per room in the currency the site reports. `rate_with_mandatory_fees` is the price the site's result list shows; `total` is `rate + other_fees + taxes` as the site reports them (four sampled hotels matched that identity to the cent). `points_rate.points_per_room` is the site's "Points / Stay" for one room (the value was identical for one and two rooms). Results are ordered by distance and include hotels with no bookable rate (`available: false`), as the page does.
- **get_hotel** fetches the hotel's overview page with a same-origin `GET` and reads its schema.org `Hotel` and `FAQPage` JSON-LD. A five-letter property code goes through the site's own `/hotels/travel/<code>/` redirect; the final address must be a `/en-us/hotels/<slug>/overview/` page on `www.marriott.com`, otherwise the tool returns `not_found`. The `url` in the result is rebuilt from that slug, so query strings and fragments in the input never reach the output.

Outputs that contain non-ASCII text (for example a typographic apostrophe in a hotel description) have been observed to arrive from the runtime's page bridge as a JSON string rather than an object; parse the string when `typeof output === "string"`. This is runtime behaviour, not tool code.

Not implemented (candidates from discovery): room and rate listing for one hotel (`/reservation/rateListMenu.mi` opens in a new tab and needs the site's search context), current offers, and every signed-in feature (points balance, trips). Sign-in was not attempted for this domain.

## URL patterns

Both tools match only `https://www.marriott.com/*`, not the default `https://marriott.com/*` and `https://*.marriott.com/*`. The other hosts under the registrable domain are separate products: `help.marriott.com` (customer service), brand sites such as `w-hotels.marriott.com` (which redirects to `whotels.com`), and analytics hosts. The GraphQL and overview requests the tools make are same-origin on `www.marriott.com` only, so a page tool listed on those hosts could not work. Observed 2026-09-29: the tools were not listed on `help.marriott.com`, `w-hotels.marriott.com` or `www.vacationsbymarriott.com`. Country sites (`marriott.fr`, `marriott.de`, `marriott.co.jp`, …) are separate registrable domains and out of scope.

## Site quirks

- **Bot protection.** Marriott sits behind Akamai. On 2026-09-29, homepage, search and hotel pages returned "Access Denied" in three of five Kernel egress setups tried, and a direct request from a datacenter host returned HTTP 403; the two setups on one US residential proxy loaded everything, and the tools ran on that egress. The tools report `challenge` when a page or response is the Access Denied page.
- **Persisted operations.** The site looks operations up by the `graphql-operation-signature` request header and ignores the query text (identical responses with and without it). An unknown signature returns HTTP 404 with `PERSISTED_QUERY_NOT_IN_LIST` (reported as `site_changed`); a missing signature is refused by the WAF with an Access Denied page. The three signatures in `search_hotels.js` were copied from the search page's own requests and must be refreshed if Marriott changes those operations.
- **Validation errors come back as HTTP 200.** The result's `status[].code` is then not `SUCCESS` (for example `INVALID_DISTANCE`, `INVALID_DATE_FORMAT`, `INVALID_NUM_IN_PARTY`); the tool reports these as `invalid_input` or `site_error` and never as an empty list.
- **Warnings are data, not failures.** Codes such as `AMP025` (no availability for some hotels), `AMP013` (closed restriction), `AMP301` (guests exceed a room's occupancy) and `WARN-RATES-1002` (dates outside what the site can price) come back with a successful search. Past or far-future dates (2028-06 was tried) return the hotels without rates and that warning rather than an error; dates in 2027-09 had rates.
- **Destinations.** `phoenixShopSuggestedPlacesDetailsQuery` reports `destinationType` as `Airport`, `City`, `Point of Interest` or `State_Province_Region`. The first three map to the search's `AIRPORT`, `CITY` and `POINT_OF_INTEREST`; region-level places (a state, a prefecture) are refused as `destination_not_supported` with the site's suggestions, because a Texas-style place has no coordinates and in one attempt the site's own search page did not issue the search operation within 25 seconds for a Tokyo-style one. The first suggestion can be surprising (the text "Chicago O'Hare airport" resolved to a heliport); `resolved_destination` and `other_destinations` say what was used and give `place_id`s for a different match.
- **Rooms and guests.** The site's "Guests" number is adults per room (`numberInParty`); rooms map to `quantity`. The site accepts 1 to 12 in `numberInParty`, and its guest control allows 8 guests per room; the tools cap at 9 rooms and 8 adults per room. Children are not supported.
- **Stay shape.** The search request carries a `weekType` of `WEEKDAYS_ONLY`, `WEEKEND_ONLY` or `WEEKDAY_AND_WEEKEND_STAY`. Friday and Saturday nights count as weekend nights in the four combinations captured from the page (Tue-Thu, Fri-Sun, Thu-Sat, Sun-Tue); the tool applies the same rule. Sending `WEEKEND_ONLY` for a Tue-Thu stay did not change the first hotel's rate in one test, so the effect of `weekType` on rates is unknown.
- **Points preference.** The site's search page remembers "Use Points/Awards" between visits. The tools send explicit rate types and neither read nor change that preference.

## Known limitations

- Public, signed-out quotes only. Sign-in was not attempted. The tools always send the anonymous request (`rewardsLevel: ANONYMOUS`, empty `customerId`); what a signed-in session would see is untested, and member-only rates appear only as `members_only: true` flags.
- English United States pages only (`/en-us/` paths, `accept-language: en-US`). Other locales and Marriott's country sites are out of scope. Non-US destinations work but prices come back in whatever currency the site reports (checked for one euro city).
- Destinations: city, airport and point of interest only. No region, state or country searches, no coordinates input, no filters (brand, amenity, price) and no order other than distance.
- Limits set by the tools, not verified as site limits: 1 to 30 nights (31 and 100 nights returned rates with `AMP013` warnings), 1 to 9 rooms, 1 to 8 adults per room, radius 1 to 100 miles (the site accepted 1 to 200), 40 hotels per page, offset up to 1000. Check-in dates before yesterday (browser time) are rejected.
- Rates are the lowest regular cash rate the site lists per hotel (and, with `use_points`, the site's points cluster). No room types, rate plans, special rates (corporate, AAA, promo codes), package or points-plus-cash prices. `available: true` means the site reports the rate as available for sale for that party and dates; it does not prove a room can be booked.
- `site_total` counts hotels the site found in the radius including unavailable ones, so it can exceed the number with a price.
- Taxes and fees are as the site reports them for the search; the search request asks for `includeTaxesAndFees: false`, and the response still carries `taxes` and `total`. Their exact legal basis is not documented by the site.
- `get_hotel` reads only the overview page's structured data: no rating, room list, photos or offers. `property_id` is the first five letters of the slug uppercased (it matched the search result's id for every hotel checked); text fields are the hotel's own copy and may be stale. Some amenity names are site wording that reads oddly (for example entries starting "No ") and are returned verbatim.
- Both tools depend on undocumented site behaviour (persisted operation signatures, JSON-LD). A change on the site surfaces as `site_changed` or `site_error`, not as partial data.
- Not live-verified: the `challenge`, `rate_limited` and `site_changed` outcomes from a real site response (covered by stubbed tests, and the persisted-query 404 shape and Access Denied page shape were observed on 2026-09-29), signed-in sessions, and the Chrome extension runtime.

## QA

Author checks on 2026-09-29 (this is not independent sign-off, so both tools stay `draft`):

- `tests/marriott-hotels.test.mjs` (fabricated hotels, places and codes; no network): input validation before any request, wrong page, Access Denied, request bodies and headers, weekend/weekday rule, rooms/adults/radius/paging mapping, points, unavailable hotels, truncation and bounded output, destination outcomes, every site-failure branch, and `get_hotel` input forms, redirects and failures. Schema conformance is asserted on every output.
- Live on a fresh Kernel browser (stealth, US residential proxy), signed out, registered as one namespace through `webmcp.addCustomTools` and invoked through `webmcp.invokeTool` from the homepage, `/offers.mi` and a hotel overview page: the tab URL and tab count did not change, and neither tool was listed on `help.marriott.com`, `w-hotels.marriott.com` or `vacationsbymarriott.com`.
- The request variables `search_hotels` sends deep-equal the variables the site's own search page sent for the same search in three cases (airport, cash; point of interest, points; international city, points), and the options and `weekType` matched in five more (weekend, mixed, sun-tue, two rooms, three adults).
- Search results matched the page's rendered list for the same search (order, distance, nightly price, points and sold-out hotels) for the first six hotels near an airport with points on.
