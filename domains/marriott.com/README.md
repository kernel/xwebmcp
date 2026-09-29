# marriott.com

Tools for Marriott Bonvoy hotels (https://www.marriott.com): public hotel search with per-night cash rates and points, and public facts for one hotel. Both are read-only and work signed out.

| tool | file | status | notes |
|------|------|--------|-------|
| search_hotels | [search_hotels.js](search_hotels.js) | verified | Destination text or place_id, dates, rooms, adults per room, radius, optional points; hotels by distance with rating, lowest displayed cash rate per night and points per room |
| get_hotel | [get_hotel.js](get_hotel.js) | verified | One hotel by property code, slug or overview URL: address, phone, check-in/out times, amenities, coordinates, FAQ answers |

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

- **search_hotels** calls three of the site's own persisted GraphQL operations at `POST /mi/query/<operation>`, the ones the search page sends: `phoenixShopSuggestedPlacesQuery` (destination text to suggestions), `phoenixShopSuggestedPlacesDetailsQuery` (place to coordinates and type) and `phoenixShopDatedSearchByGeoQuery` (the hotel list with rates). Nothing is written: they are read queries, and the tool sends no selection, cart or booking request. Amounts are average per night per room in the currency the site reports. `rate_with_mandatory_fees` is `rate + mandatory_fees`, the price the site's result list shows per night (the list truncates it to whole currency units). `fees` is the site's total of all per-night fees and already contains `mandatory_fees`; `total` is `rate + fees + taxes`, so it includes the mandatory fee. Measured on 2026-09-29 over 93 hotels in three resort-heavy markets, `total` equalled `rate + fees + taxes` within one cent for every hotel, and for all 30 hotels with a mandatory fee `fees` was at least `mandatory_fees` (equal in the Las Vegas ones) while `rate + mandatory_fees + fees + taxes` never matched `total`. `points_rate.points_per_room` is the site's "Points / Stay" for one room (the value was identical for one and two rooms). Results are ordered by distance and include hotels with no bookable rate (`available: false`), as the page does. An offset past the last hotel returns `status: "ok"` with an empty page.
- **get_hotel** fetches the hotel's overview page with a same-origin `GET` and reads its schema.org `Hotel` and `FAQPage` JSON-LD. A five-letter property code goes through the site's own `/hotels/travel/<code>/` redirect; the final address must be a `/en-us/hotels/<slug>/overview/` page on `www.marriott.com`, otherwise the tool returns `not_found`. The `url` in the result is rebuilt from that slug, so query strings and fragments in the input never reach the output.

Outputs that contain non-ASCII text (for example a typographic apostrophe in a hotel description) have been observed to arrive from the runtime's page bridge as a JSON string rather than an object; parse the string when `typeof output === "string"`. This is runtime behaviour, not tool code.

Not implemented (candidates from discovery): room and rate listing for one hotel (`/reservation/rateListMenu.mi` opens in a new tab and needs the site's search context), current offers, and every signed-in feature (points balance, trips). Sign-in flows were not explored.

## URL patterns

Both tools match only `https://www.marriott.com/*`, not the default `https://marriott.com/*` and `https://*.marriott.com/*`. The other hosts under the registrable domain are separate products: `help.marriott.com` (customer service), brand sites such as `w-hotels.marriott.com` (which redirects to `whotels.com`), and analytics hosts. The GraphQL and overview requests the tools make are same-origin on `www.marriott.com` only, so a page tool listed on those hosts could not work. Observed 2026-09-29: the tools were not listed on `help.marriott.com`, `w-hotels.marriott.com` or `www.vacationsbymarriott.com`. Country sites (`marriott.fr`, `marriott.de`, `marriott.co.jp`, …) are separate registrable domains and out of scope.

## Site quirks

- **Bot protection.** Marriott sits behind Akamai. On 2026-09-29, homepage, search and hotel pages returned "Access Denied" in three of five Kernel egress setups tried, and a direct request from a datacenter host returned HTTP 403; the two setups on one US residential proxy loaded everything, and the tools ran on that egress. The tools report `challenge` when a page or response is the Access Denied page.
- **Persisted operations.** The site looks operations up by the `graphql-operation-signature` request header and ignores the query text (identical responses with and without it). An unknown signature returns HTTP 404 with `PERSISTED_QUERY_NOT_IN_LIST` (reported as `site_changed`); a missing signature is refused by the WAF with an Access Denied page. The three signatures in `search_hotels.js` were copied from the search page's own requests and must be refreshed if Marriott changes those operations.
- **Validation errors come back as HTTP 200.** The result's `status[].code` is then not `SUCCESS` (for example `INVALID_DISTANCE`, `INVALID_DATE_FORMAT`, `INVALID_NUM_IN_PARTY`); the tool reports these as `invalid_input` or `site_error` and never as an empty list.
- **Warnings are data, not failures.** Warning text is stripped of markup and cut at 200 characters (possibly mid-word). An empty page past the last hotel carries the site's `WARN-SEARCH-1002` ("we may not have a property within a 50-mile radius") even though `site_total` is non-zero; read it together with `site_total` and `offset`. Codes such as `AMP025` (no availability for some hotels), `AMP013` (closed restriction), `AMP301` (guests exceed a room's occupancy) and `WARN-RATES-1002` (dates outside what the site can price) come back with a successful search. Past or far-future dates (2028-06 was tried) return the hotels without rates and that warning rather than an error; dates in 2027-09 had rates.
- **Destinations.** `phoenixShopSuggestedPlacesDetailsQuery` reports `destinationType` as `Airport`, `City`, `Point of Interest`, `State_Province_Region`, `Country` or `Leisure Region`. The first three map to the search's `AIRPORT`, `CITY` and `POINT_OF_INTEREST`; region-level places (a state, a prefecture, a country) are refused as `destination_not_supported` with the site's other matches for the same text (never the refused place itself), because a Texas-style place has no coordinates and in one attempt the site's own search page did not issue the search operation within 25 seconds for a Tokyo-style one. The first suggestion can be surprising (the text "Chicago O'Hare airport" resolved to a heliport); `resolved_destination` and `other_destinations` say what was used and give `place_id`s for a different match.
- **Rooms and guests.** The site's "Guests" number is adults per room (`numberInParty`); rooms map to `quantity`. The site accepts 1 to 12 in `numberInParty`, and its guest control allows 8 guests per room; the tools cap at 9 rooms and 8 adults per room. Children are not supported.
- **Stay shape.** The search request carries a `weekType` of `WEEKDAYS_ONLY`, `WEEKEND_ONLY` or `WEEKDAY_AND_WEEKEND_STAY`. Friday and Saturday nights count as weekend nights in the four combinations captured from the page (Tue-Thu, Fri-Sun, Thu-Sat, Sun-Tue); the tool applies the same rule. Sending `WEEKEND_ONLY` for a Tue-Thu stay did not change the first hotel's rate in one test, so the effect of `weekType` on rates is unknown.
- **Points preference.** The site's search page remembers "Use Points/Awards" between visits. The tools send explicit rate types and neither read nor change that preference.

## Known limitations

- Public, signed-out quotes only. Sign-in flows were not explored. The tools always send the anonymous request (`rewardsLevel: ANONYMOUS`, empty `customerId`); what a signed-in session would see is untested, and member-only rates appear only as `members_only: true` flags.
- English United States pages only (`/en-us/` paths, `accept-language: en-US`). Other locales and Marriott's country sites are out of scope. Non-US destinations work but prices come back in whatever currency the site reports (checked for one euro city).
- Destinations: city, airport and point of interest only. No region, state or country searches, no coordinates input, no filters (brand, amenity, price) and no order other than distance.
- Limits set by the tools, not verified as site limits: 1 to 30 nights (31 and 100 nights returned rates with `AMP013` warnings), 1 to 9 rooms, 1 to 8 adults per room, radius 1 to 100 miles (the site accepted 1 to 200), 40 hotels per page, offset up to 1000. Check-in dates before yesterday (browser time) are rejected.
- Rates are the lowest regular cash rate the site lists per hotel (and, with `use_points`, the site's points cluster). No room types, rate plans, special rates (corporate, AAA, promo codes), package or points-plus-cash prices. `available: true` means the site reports the rate as available for sale for that party and dates; it does not prove a room can be booked.
- `site_total` counts hotels the site found in the radius including unavailable ones, so it can exceed the number with a price.
- Taxes and fees are as the site reports them for the search; the search request asks for `includeTaxesAndFees: false`, and the response still carries `taxes` and `total`. `total` is an average per night and can differ from the sum of its parts by one cent. The site does not document the basis of the tax figure.
- Some properties in search results have no overview page (a residences property returned 404), so `get_hotel` reports `not_found` for their `url`.
- `get_hotel` reads only the overview page's structured data: no rating, room list, photos or offers. `property_id` is the first five letters of the slug uppercased (it matched the search result's id for every hotel checked); text fields are the hotel's own copy and may be stale. Some amenity names are site wording that reads oddly (for example entries starting "No ") and are returned verbatim.
- Both tools depend on undocumented site behaviour (persisted operation signatures, JSON-LD). A change on the site surfaces as `site_changed` or `site_error`, not as partial data.
- Heavy use of one browser session triggers Akamai: after roughly 60 searches in about an hour an independent test session began receiving Access Denied on the search operation, which the tool reported as `challenge`. Whether it clears after a wait was not tested.
- One HTTP 429 (reported as `rate_limited`) was seen after four quick searches in one session and cleared within about two minutes.
- Not live-verified: `site_changed` from a real site response (covered by stubbed tests and a fixture; the persisted-query 404 shape was observed on 2026-09-29), signed-in sessions, and the Chrome extension against the live site.

## QA

Author checks on 2026-09-29:

- `tests/marriott-hotels.test.mjs` (fabricated hotels, places and codes; no network): input validation before any request, wrong page, Access Denied, request bodies and headers, weekend/weekday rule, rooms/adults/radius/paging mapping, points, unavailable hotels, truncation and bounded output, destination outcomes, every site-failure branch, and `get_hotel` input forms, redirects and failures. Schema conformance is asserted on every output, and the same outputs also pass the Chrome extension's own schema validator (`extension/sandbox/schema.js`, run in Node).
- Live on a fresh Kernel browser (stealth, US residential proxy), signed out, registered as one namespace through `webmcp.addCustomTools` and invoked through `webmcp.invokeTool` from the homepage, `/offers.mi` and a hotel overview page: the tab URL and tab count did not change, and neither tool was listed on `help.marriott.com`, `w-hotels.marriott.com` or `vacationsbymarriott.com`.
- The request variables `search_hotels` sends deep-equal the variables the site's own search page sent for the same search in three cases (airport, cash; point of interest, points; international city, points), and the options and `weekType` matched in five more (weekend, mixed, sun-tue, two rooms, three adults).
- Search results matched the page's rendered list for the same search (order, distance, nightly price, points and sold-out hotels) for the first six hotels near an airport with points on.

Independent QA round 1 (agent `agt_969930ee72c8218556a6`, 2026-09-29, head `25159cb`): **FAIL**, no blocker. It re-ran the validator and full suite, 32 source mutants (29 killed), and about 80 live invocations (Portland, Seattle, Paris, Orlando, Maui; paging, points, rooms, weekend and 30-night stays, region and country destinations, malformed input, every `get_hotel` input form), a side-by-side comparison with the site's own results page for two searches (all hotels matched), side-effect and leakage scans (only the documented operations, no storage changes, no secrets in outputs), and a partial run of the unpacked Chrome extension in Chromium 153 against a fabricated local HTTPS fixture (both files registered as page tools and ran there; never against live Marriott). Its findings and the changes made for them:

1. The reviewer suspected `per_night.total` left out the mandatory fee, and the field `other_fees` was misleadingly named. The author's data (93 quotes) and the reviewer's own (159, then 133 more in round 2) show `fees` contains the mandatory fee and `total = rate + fees + taxes` includes it, so the only defect was the name and description: `other_fees` became `fees` and the descriptions were corrected.
2. `destination_not_supported` offered the refused place back as a suggestion; it now lists only the site's other matches and omits `suggestions` when there are none.
3. A changed response shape on the suggestion or details operation was reported as `destination_not_found`; it is now `site_changed`.
4. `get_hotel` said `www.marriott.com` is "a different site" for an `http://` URL; it now asks for https. A slug length mismatch (166 accepted, 160 usable) was aligned.
5. An offset past the last hotel returned `no_results` with a non-zero `site_total`; it is now an empty `ok` page.
6. Three surviving mutants (region type mapping, `next_offset` without `hasNextPage`, `url` built from the final address) and the loose `http://` assertion got tests.
7. README wording: the site's list price is truncated, not rounded; a live `challenge` was observed; some listed properties have no overview page. Warning text from the site is stripped of markup (author addition).

Independent QA round 2 (same agent, 2026-09-29, head `0726e05`, the source of both tools as registered): **PASS**, tools set to `verified`. It re-ran the validator and full suite (1688 pass), 55 source mutants (52 killed; the three survivors, a fifth-suggestion slice, the empty-host fallback and the tag-strip replacement, now have tests), and a bounded live matrix on fresh stealth browsers on the same US residential proxy, signed out. Live cases, all 2026-09-29:

- Start pages `/default.mi`, `/offers.mi` and a hotel overview page each gave normal `search_hotels` and `get_hotel` results with the tab URL and tab count unchanged; the tools were not listed on `help.marriott.com` or `example.com`; `document.modelContext` on the www pages showed only the two custom tools.
- Fee arithmetic: 133 more quotes across Las Vegas, Orlando, Honolulu and Seattle satisfied `total = rate + fees + taxes` within one cent, `fees >= mandatory_fees` for all 34 hotels with a mandatory fee, and `rate_with_mandatory_fees = rate + mandatory_fees`.
- Las Vegas, Thursday to Saturday, 2 rooms, 2 adults, points on: the first 10 hotels matched the site's own results list in order, name, distance, truncated list price, points and fee note; `site_total` equalled the site's 48; the tool's request variables deep-equalled the page's.
- Region and country destinations (Texas, France, Tokyo) by text and by `place_id`, 11 odd destination strings, 5 unknown `place_id`s, `http://`, `ftp://`, `javascript:` and 160/161-character slugs, and offsets 40, 100 and 1000 behaved as specified.
- Leakage scan of 56 outputs: only canonical overview addresses; no cookies, tokens, session values, photo addresses or `__typename`. Side-effect scan: only the three documented POST operations and one GET; no user-visible storage keys changed.
- One real HTTP 429 (see Known limitations) and, in round 1, one real Access Denied were reported as `rate_limited` and `challenge`.

Local Chrome extension: the reviewer ran the unpacked extension in Chromium 153 against a fabricated local HTTPS fixture for `www.marriott.com` (never live Marriott): both files registered as page tools, ran, and the new branches behaved as specified with no tab change; the extension's own schema validator compiled both schemas and accepted all recorded outputs. Cross-runtime parity on the live site was not observed.

Sessions (ephemeral): the author's and reviewers' Kernel browsers were deleted after use.
