# booking.com

Tools for Booking.com stays (https://www.booking.com): search a destination and read a property's rates. Both are read-only and work signed out.

| tool | file | status | notes |
|------|------|--------|-------|
| search_stays | [search_stays.js](search_stays.js) | draft | First results page (up to 25 properties) for a destination, explicit dates, adults, child ages and the currency the site shows, with sort and filters; echoes the dates, guests and currency the site applied |
| get_property | [get_property.js](get_property.js) | draft | One property's facts, reviews and every listed rate for explicit dates and guests, with taxes and fees excluded from each price, cancellation, prepayment and meal terms; rates limited to fewer guests than the party are left out |

## Native WebMCP tools

None found (checked 2026-09-29 with `webmcp.listTools()` and `document.modelContext.getTools()` signed out on the home page, a stays results page, a property page, and the `flights.booking.com` index and results pages). `document.modelContext` exists with zero registered tools and `navigator.modelContext` is undefined, so the `booking.com` custom namespace does not overlap with anything the site registers.

## Execution kind

Both tools are `kind: "page"`. Each makes one same-origin `fetch` of the site's own HTML (`/searchresults.html`, `/hotel/<country>/<slug>.html`) with the document's cookies, parses the returned markup with `DOMParser`, and never navigates the tab, so neither needs to survive a navigation and neither qualifies for `cdp`. The results and the property page are server-rendered, and a same-origin fetch returned the same cards and rate rows the rendered page shows.

## Scope and loading

Register both files together under namespace `booking.com`; `forceOverwriteNamespace: true` replaces the whole namespace.

```javascript
const fs = await import("node:fs");
const tools = ["search_stays", "get_property"].flatMap(name => eval(fs.readFileSync(`domains/booking.com/${name}.js`, "utf8")));
await webmcp.addCustomTools({ namespace: "booking.com", tools, forceOverwriteNamespace: true });
const tab = (await currentTab()).targetId;
const ref = async name => (await webmcp.listTools()).find(t => t.source.custom?.namespace === "booking.com" && t.tool.name === name && t.source.target_id === tab).tool_ref;
const found = await webmcp.invokeTool(await ref("search_stays"), { destination: "Lisbon", check_in: "2026-11-10", check_out: "2026-11-12", adults: 2, currency: "USD", limit: 5 }, { timeoutSec: 60 });
const property = await webmcp.invokeTool(await ref("get_property"), { property_url: "<property_url from search_stays>", check_in: "2026-11-10", check_out: "2026-11-12", adults: 2, currency: "USD" }, { timeoutSec: 60 });
```

Use future dates. Each call took about 1 to 4 seconds live. Do not navigate the tab while a call runs: a page tool stops when its document is replaced, and the result is lost. The Kernel REPL helper returned `output` as an object for most results but as a JSON string for some results containing non-ASCII text (the `no_availability` result did; `ok` results with the same non-ASCII address did not; a schema-less probe tool returning `{"a":"Tomás"}` did too); parse a string `output` before use.

Both tools run on any `https://www.booking.com` page in an English-language session and return `wrong_page` or `unsupported_language` without a request otherwise.

**search_stays** takes `destination`, `check_in`, `check_out`, `adults` and `currency` (all required), plus optional `children_ages`, `sort`, `star_ratings`, `min_review_score`, `free_cancellation_only`, `breakfast_included` and `limit` (1 to 25, default 10). It searches one room. It returns the destination the site resolved (name, `dest_id`, type, country code and breadcrumb) so a caller can spot an ambiguous name, the site's `total_found`, `has_more`, and for each property the canonical `property_url`, area, distance, star rating when the card shows one, review score, the recommended unit, price and deal labels. Only the first results page is read; later pages are not.

**get_property** takes `property_url` (as returned by `search_stays`), `check_in`, `check_out`, `adults` and `currency` (required), plus optional `children_ages` and `max_rates` (1 to 40, default 20). It reads one room's worth of pricing. It returns the property facts and `rooms[]` with each room's `rates[]`. `no_availability` means the page itself says the property has nothing for those dates. `no_rate_for_party` means every rate it lists is limited to fewer guests than the party (per-bed dormitory rates, for example): that is not "no availability", because the site may let you select several such units, which the tool does not price.

### Dates, guests, currency and price basis

The output does not echo the request. `effective` is read from the page: dates, night count and currency from the inline page configuration (`b_checkin_date`, `b_checkout_date`, `b_checkin_checkout_interval`, `b_selected_currency`), the currency also from the header currency picker, adults, children and rooms from the search box, and the sign-in state from the header. A page that applied other dates, another party, or a different currency is an error (`search_not_applied`, `currency_mismatch`), never a result.

`price_basis` states what a price is:

- `search_stays`: `price.total` is the card's displayed price for the whole stay, for the whole party, on the unit the site recommends (`unit`). Results cards do not say what taxes and fees are excluded (`taxes_and_fees: not_itemized_on_results_card`), so use `get_property` for that. `per_night_average` is the card's per-night figure; it can differ from `total` divided by the nights (for example when a one-time charge is included), so do not derive a total from it. When the card shows a strike-through, `original_total` is the price before the deal and `total` the discounted price.
- `get_property`: `price.total` is the displayed total for the stay in one room; the page states that it excludes taxes and fees (`taxes_and_fees: excluded_as_listed_per_rate`), and `taxes_and_fees_excluded` repeats the page's own text for them, which can be in another currency (for example a city tax in EUR on a USD page). `null` there means no such text was found in a form the tool reads, not that none apply, and a warning says so. `total_before_taxes` is the unrounded figure from the page's price breakdown. A rate row shows the page's `Max. people` (no children in the search) or `Max adults` (children in the search); a rate limited to fewer guests than the party (for example a hostel bed "Only for 1 guest") is priced for those guests only, so it is left out and counted in `rates_left_out.party_too_large`, with a warning that several such units may be selectable on the site.

**Members-only prices.** A signed-out visitor is shown some Genius member prices as a preview: a results card carries "Sign in for this members-only price" and a rate's price breakdown lists a "Genius discount" with the same prompt. The displayed price then includes a discount a signed-out visitor is not given. `search_stays` sets `price.members_only` and puts the price without the member discount in `price.original_total`; `get_property` sets `member_discount: { amount, requires_sign_in: true }` on the rate, and the price without signing in is higher by about `amount`. Each case adds a warning. When the browser is signed in, `member_discount.requires_sign_in` is false and the discount is real for that account.

Rooms are fixed at one. With two or more rooms Booking.com recommended a single unit for the whole group on the results page, so multi-room pricing could not be interpreted; the tools do not offer a rooms input. Child ages are sent to the site, but the results page echoes only the number of children (a warning says so); the property page's room form lists the ages, and `children_ages_confirmed` is true only when they matched.

### The tools never change the site's currency

Booking.com keeps the chosen currency for the whole browser session: on 2026-09-29 a request with `selected_currency=GBP` made later requests without it show GBP too. A code the site does not offer made that response show each property's own currency (header `€$£`, prices in mixed currencies) while the page configuration still said USD; that did not persist to the next request. Reading prices in another currency would therefore change a persistent setting, and restoring it afterwards cannot be guaranteed (for example when the tab navigates during the call). So `currency` is required, must be the currency the site is already showing (the header currency picker), and is compared with the page. When it differs the call fails with `currency_mismatch`, naming what the site shows, and nothing was changed; change the currency in the site's own picker (or use the one shown) and call again. A request without cookies is not an alternative: it was answered with Booking.com's bot-protection page (HTTP 202).

## URL patterns

Both tools use `https://www.booking.com/*` instead of the repository default (`https://booking.com/*`, `https://*.booking.com/*`). They read pages with a same-origin fetch, so they only work when the invoking document is on `www.booking.com`. A fetch from `www.booking.com` to `flights.booking.com` or `secure.booking.com` fails with `Failed to fetch` (observed); the reverse direction was not tried. Narrowing to the `www` host keeps the tools off most other Booking.com pages, but it does not remove every one. An independent reviewer observed that `flights.booking.com` redirected to a `www.booking.com` page (where the tools work) and that the Kernel runtime listed the tools on a `secure.booking.com` help page and on `account.booking.com`, most likely because those pages embed a `www.booking.com` frame (spec/cdp-tools.md §6.1); the author did not open those pages. Invoked from such a top document the tools return `wrong_page` without a request. The bare `booking.com` host and other subdomains are not covered.

## Site quirks

- Searches and property pages are sent as GET requests to the site's own URLs (`ss`, `checkin`, `checkout`, `group_adults`, `no_rooms=1`, `group_children`, repeated `age`, `order`, `nflt`). The tools pass neither `lang` nor `selected_currency`; a non-English session is refused rather than switched.
- The results page returned between 15 and 25 property cards for the same query on different loads, and the order of "Our top picks" varies between loads. `offset=25` did not return a second page, so only the first page is read and `has_more` reports the rest.
- A destination the site cannot resolve, a past date, and dates beyond its bookable window all redirect to the home page with HTTP 200; the tools report that as `search_not_accepted` and cannot tell which cause applied, and it may also be how the site answers a client it treats as automated (an independent local run of the extension in a non-stealth Chromium was redirected this way). Yesterday's date (UTC, allowed for time zones) is not redirected: the site drops the dates and returns an undated search, which is `search_not_applied`. On 2026-09-29 the search window ended between 2028-01-10 (accepted) and 2028-03-10 (redirected), about 16 months. `get_property` for a date beyond the window returns `no_availability` (indistinguishable from a sold-out date) or, because the page then shows the party the session last searched instead of the requested one, `search_not_applied`.
- A resolvable destination with no properties (a filter combination nothing matches) is a page saying "0 properties found" and is `no_results`. A destination name is resolved to the site's best match, for example "Springfield" to one US city; check `destination`.
- Filters are sent as the site's `nflt` values: `class=<1-5>`, `review_score=<60|70|80|90>`, `fc=2` (free cancellation) and `mealplan=1` (breakfast included). Stay length up to 30 nights is accepted by the tools.
- A property that does not exist gives HTTP 404 (`property_not_found`). A property with no availability for the dates has no rate table and says "We have no availability here between …" (`no_availability`).
- Rate rows share a room: only the first row of a room carries its name, beds and features. A rate row may have no occupancy cell (`max_guests` and `max_adults` null). A row that cannot be attributed to a readable room is counted in `rates_left_out.unreadable` with a warning, never dropped silently.
- Property pages come in more than one layout. The tool reads the layout with the `#hprt-table` rate table (seen from Kernel browsers with US egress). The author's local non-stealth Chromium was served a different layout without that table, which the tool reports as `site_changed`. The independent reviewer's local extension run was served the table with different price markup: no "Total before taxes" or average-per-night lines, the taxes shown under the price as "+US$18 taxes and fees" (`.prd-taxes-and-fees-under-price`), and a "Partner Offer" room head whose link is `a.hprt-roomtype-link` without `data-room-id`. The tool reads that markup (`total_before_taxes` and `per_night_average` stay null, `room_id` is null) and warns when a rate lists no excluded taxes in a form it reads; the author did not reproduce this layout and relies on the reviewer's sanitized markup.
- Signed in, the same property showed lower prices with an added "Genius discount" line; the tools set `signed_in` from the header and `member_discount_applied` per rate, and add a warning. Public (signed-out) pricing is what the tools were built and checked against.
- Booking.com records every search and page view like a normal visit; there is no way to make these reads invisible to it.
- A request without cookies is answered with HTTP 202 and a small page titled "JavaScript is disabled" carrying an AWS WAF script (observed 2026-09-29). The tools map that shape to `challenge`; they always send the page's own cookies.

## Known limitations

- Not implemented: choosing a room or rate, saving to a list, reserving, checkout, bookings, account pages, review text, photos, maps, flights, cars, taxis and attractions. The tools never click, submit a form, or open `secure.booking.com`.
- One room, up to 30 adults and 10 children. Multi-room searches, flexible dates, map or region drawing, price-range filters and property-type filters are not supported. The site's currency cannot be chosen through the tools (see above).
- Only the first results page is read (at most 25 properties); no later pages.
- The `gated` (sign-in or consent path), `rate_limited` and HTTP-error branches are covered by fixture tests and by simulated failures only; no sign-in wall or 429 was seen. The `challenge` shape was observed live only for a request without cookies, which the tools never send. A cross-origin redirect to a sign-in or consent host would surface as `site_error` ("Failed to fetch") because a page fetch cannot read it.
- The alternate property layouts above are handled by reporting, not by parsing: only the `#hprt-table` layout returns rates.
- Star ratings appeared on cards only when a star filter was applied, so `star_rating` is often null.
- Results, prices and availability change between loads; a returned rate is not a hold or a guarantee, and the displayed total does not include the excluded taxes and fees.
- Only English (`en-us`) sessions were tested; other locales may format prices differently. A non-English session is refused with `unsupported_language`, which was exercised by setting the document language in a test, not with a real non-English session.
- The Booking.com terms of use on automated access were not reviewed.

## QA summary

Author verification on 2026-09-29 (fresh stealth Kernel browsers, US egress, signed out, both tools registered together with `forceOverwriteNamespace` and invoked through `webmcp.invokeTool`):

| Case | Result |
|---|---|
| search_stays Lisbon, 2026-11-10 to 2026-11-12, 2 adults, USD | ok, effective dates/guests/currency from the page, cards parsed (canonical URL, review, unit, total 316 with original 352 and per-night 158 for one property) |
| search_stays with a currency the site is not showing (EUR, XYZ) | `currency_mismatch`, the header currency unchanged |
| search_stays unknown destination, and dates in 2028 | `search_not_accepted` (redirect to the home page) |
| search_stays with yesterday's date | `search_not_applied` (undated search) |
| search_stays with a filter combination nothing matches | `no_results` ("0 properties found") |
| search_stays with two children | ok, children counted from the page, ages warning |
| get_property (apartments and hotels, in Portugal and the US) | ok, rooms and rates, excluded taxes text, cancellation, prepayment, meal, check-in and check-out times |
| get_property for a hotel that lists single-guest rates, 2 adults | those rates left out and counted, with a warning |
| get_property with two children | ages confirmed from the room form, "Max adults" read, larger-party rates only |
| search_stays and get_property for a city and a hotel that show members-only prices to a signed-out visitor | `price.members_only` and `member_discount.requires_sign_in` set, with a warning |
| get_property for a hostel whose rates are all per bed, 2 adults | `no_rate_for_party` (rates only for fewer guests) |
| get_property for New Year's Eve at a property with no availability | `no_availability` |
| get_property nonexistent slug | `property_not_found` (HTTP 404) |
| Invalid property URL | `invalid_input` before any request |
| A signed-in session that was approved for this work (read-only GETs) | ok, `signed_in: true`, member discount flagged with a warning; nothing was changed. Author-only; not independently verified |

Independent QA: pending.

Local tests use fabricated pages modeled on the observed markup, stubbed network and a frozen clock and never contact the live site:

```sh
node --test tests/booking-stays.test.mjs
```

## Sessions

- Author verification browsers: `s1bydf39xrowbx14ni803vsd`, `yqpimf0yygskv8uxo0ov72yf` (deleted after verification).
