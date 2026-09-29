# booking.com

Tools for Booking.com stays (https://www.booking.com): search a destination and read a property's rates. Both are read-only and work signed out.

| tool | file | status | notes |
|------|------|--------|-------|
| search_stays | [search_stays.js](search_stays.js) | draft | First results page (up to 25 properties) for a destination, explicit dates, adults, child ages and currency, with sort and filters; echoes the dates, guests and currency the site applied |
| get_property | [get_property.js](get_property.js) | draft | One property's facts, reviews and every listed rate for explicit dates and guests, with taxes and fees excluded from each price, cancellation, prepayment and meal terms |

## Native WebMCP tools

None found (checked 2026-09-29 with `webmcp.listTools()` and `document.modelContext.getTools()` signed out on the home page, a stays results page, a property page, and the `flights.booking.com` index and results pages). `document.modelContext` exists with zero registered tools and `navigator.modelContext` is undefined, so the `booking.com` custom namespace does not overlap with anything the site registers.

## Execution kind

Both tools are `kind: "page"`. Each calls one same-origin `fetch` of the site's own HTML (`/searchresults.html`, `/hotel/<country>/<slug>.html`) with the document's cookies, parses the returned markup with `DOMParser`, and never navigates the tab, so neither needs to survive a navigation and neither qualifies for `cdp`. Reading the same pages by navigating would only add a document swap: the results and the property page are server-rendered, and a same-origin fetch returned the same cards and rate rows the rendered page shows.

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

Use future dates. Each call took about 1 to 4 seconds live. The Kernel REPL helper returned `output` as an object for most results but as a JSON string for some results containing non-ASCII text (the `no_availability` result did; `ok` results with the same non-ASCII address did not; a schema-less probe tool returning `{"a":"Tomás"}` did too); parse a string `output` before use.

Both tools run on any `https://www.booking.com` page in an English-language session and return `wrong_page` or `unsupported_language` without a request otherwise.

**search_stays** takes `destination`, `check_in`, `check_out`, `adults` and `currency` (all required), plus optional `children_ages`, `sort`, `star_ratings`, `min_review_score`, `free_cancellation_only`, `breakfast_included` and `limit` (1 to 25, default 10). It searches one room. It returns the destination the site resolved (name, `dest_id`, type, country code and breadcrumb) so a caller can spot an ambiguous name, the site's `total_found`, `has_more`, and for each property the canonical `property_url`, area, distance, star rating when the card shows one, review score, the recommended unit, price and deal labels. Only the first results page is read; later pages are not.

**get_property** takes `property_url` (as returned by `search_stays`), `check_in`, `check_out`, `adults` and `currency` (required), plus optional `children_ages` and `max_rates` (1 to 40, default 20). It reads one room's worth of pricing. It returns the property facts and `rooms[]` with each room's `rates[]`. `no_availability` means the site itself says the property has nothing for those dates and guests.

### Dates, guests, currency and price basis

The output does not echo the request. `effective` is read from the page: dates, night count and currency from the inline page configuration (`b_checkin_date`, `b_checkout_date`, `b_checkin_checkout_interval`, `b_selected_currency`), adults, children and rooms from the search box, and the sign-in state from the header. A page that applied other dates, another party, or another currency is an error (`search_not_applied`, `currency_not_applied`), never a result.

`price_basis` states what a price is:

- `search_stays`: `price.total` is the card's displayed price for the whole stay, for the whole party, on the unit the site recommends (`unit`). Results cards do not say what taxes and fees are excluded (`taxes_and_fees: not_itemized_on_results_card`), so use `get_property` for that. `per_night_average` is the card's rounded per-night figure. When the card shows a strike-through, `original_total` is the price before the deal and `total` the discounted price.
- `get_property`: `price.total` is the displayed total for the stay in one room; the page states that it excludes taxes and fees (`taxes_and_fees: excluded_as_listed_per_rate`), and `taxes_and_fees_excluded` repeats the page's own "Excluded:" text, which can be in another currency (for example a city tax in EUR on a USD page). `total_before_taxes` is the unrounded figure from the page's price breakdown.

Rooms are fixed at one. With two or more rooms Booking.com recommended a single unit for the whole group on the results page, so multi-room pricing could not be interpreted; the tools do not offer a rooms input. Child ages are sent to the site, but the results page echoes only the number of children (a warning says so); the property page's room form lists the ages, and `children_ages_confirmed` is true only when they matched.

### Currency is session state

Booking.com keeps the chosen currency for the whole browser session: a `selected_currency` in one request also applies to later requests without it, and an unsupported code silently switches the site to each property's own currency. To price in the requested currency the tools ask for it, verify the page shows it, and then load `/index.html?selected_currency=<previous>` to put the previous currency back, verified from the header. `session_currency` reports `requested`, `previous`, `switched` and `restored`; `restored: false` means the previous currency could not be confirmed back. The previous currency is read from the header of the page the tool is invoked on, so it is stale if the currency was changed in another tab after that page loaded.

## URL patterns

Both tools use `https://www.booking.com/*` instead of the repository default (`https://booking.com/*`, `https://*.booking.com/*`). Booking.com serves flights from `flights.booking.com`, account and checkout pages from `secure.booking.com` and `account.booking.com`, and car and taxi products from other hosts. The tools read pages with a same-origin fetch, so they only work from `www.booking.com`: a fetch from `www.booking.com` to `flights.booking.com` or `secure.booking.com` fails with `Failed to fetch` (observed), and the reverse direction was not tried. Attaching them to every subdomain would list them on pages where they cannot work. The bare `booking.com` host and non-`www` hosts are not covered.

## Site quirks

- Searches and property pages are sent as GET requests to the site's own URLs (`ss`, `checkin`, `checkout`, `group_adults`, `no_rooms=1`, `group_children`, repeated `age`, `selected_currency`, `order`, `nflt`). The tools never pass `lang`; a non-English session is refused rather than switched.
- The results page returned between 15 and 25 property cards for the same query on different loads, and the order of "Our top picks" varies between loads. `offset=25` did not return a second page, so only the first page is read and `has_more` reports the rest.
- A destination the site cannot resolve, a past date, and dates more than about a year ahead all redirect to the home page with HTTP 200; the tools report that as `search_not_accepted` and cannot tell which cause applied. A resolvable destination with no properties (a filter combination nothing matches) is a page saying "0 properties found" and is `no_results`. A destination name is resolved to the site's best match, for example "Springfield" to one US city; check `destination`.
- Filters are sent as the site's `nflt` values: `class=<1-5>`, `review_score=<60|70|80|90>`, `fc=2` (free cancellation) and `mealplan=1` (breakfast included). Stay length up to 30 nights is accepted by the tools.
- A property that does not exist gives HTTP 404 (`property_not_found`). A property with no availability for the dates has no rate table and says "We have no availability here between …" (`no_availability`).
- Rate rows share a room: only the first row of a room carries its name, beds and features. A rate row may have no "Max. people" cell (`max_guests: null`).
- Signed in, the same property showed lower prices with an added "Genius discount" line; the tools set `signed_in` from the header and `member_discount_applied` per rate, and add a warning. Public (signed-out) pricing is what the tools were built and checked against.
- Booking.com records every search and page view like a normal visit; there is no way to make these reads invisible to it.

## Known limitations

- Not implemented: choosing a room or rate, saving to a list, reserving, checkout, bookings, account pages, reviews text, photos, maps, flights, cars, taxis and attractions. The tools never click, submit a form, or open `secure.booking.com`.
- One room, up to 30 adults and 10 children. Multi-room searches, flexible dates, map or region drawing, price-range filters and property-type filters are not supported.
- Only the first results page is read (at most 25 properties); no later pages.
- The `challenge`, `gated` (sign-in or consent path), `rate_limited` and HTTP-error branches are covered by fixture tests only. No block, challenge, sign-in wall or 429 was seen live; a cross-origin redirect to a sign-in or consent host would surface as `site_error` ("Failed to fetch") because a page fetch cannot read it.
- Star ratings appeared on cards only when a star filter was applied, so `star_rating` is often null.
- Results, prices and availability change between loads; a returned rate is not a hold or a guarantee, and the displayed total does not include the excluded taxes and fees.
- Only English (`en-us`) sessions were tested; other locales may format prices differently. Currency codes were exercised with USD and EUR live, and the unsupported-code refusal with a made-up code.
- The Booking.com terms of use on automated access were not reviewed.

## QA summary

Author verification on 2026-09-29 (fresh stealth Kernel browser, US egress, signed out, page tools registered together with `forceOverwriteNamespace` and invoked through `webmcp.invokeTool`):

| Case | Result |
|---|---|
| search_stays Lisbon, 2026-11-10 to 2026-11-12, 2 adults, USD | ok, effective dates/guests/currency from the page, 2,978 found, cards parsed (canonical URL, review, unit, total 316 with original 352 and per-night 158 for one property) |
| search_stays with EUR | ok, prices in euros; the header currency was USD before and USD again after (`restored: true`) |
| search_stays with the made-up currency XYZ | `currency_not_applied`, session restored |
| search_stays unknown destination, and dates in 2028 | `search_not_accepted` (redirect to the home page) |
| search_stays with a filter combination nothing matches | `no_results` ("0 properties found") |
| search_stays with two children | ok, children counted from the page, ages warning |
| get_property (two apartments and one hotel, one in a US city) | ok, rooms and rates, excluded taxes text, cancellation, prepayment, meal, check-in and check-out times |
| get_property EUR with one child | ok, ages confirmed from the room form, currency restored |
| get_property for New Year's Eve at a property with no availability | `no_availability` |
| get_property nonexistent slug | `property_not_found` (HTTP 404) |
| Invalid property URL | `invalid_input` before any request |
| A signed-in session that was approved for this work (read-only GETs, currency already USD) | ok, `signed_in: true`, member discount flagged with a warning; nothing was changed |

Independent QA: pending.

Local tests use fabricated pages modeled on the observed markup, stubbed network and a frozen clock and never contact the live site:

```sh
node --test tests/booking-stays.test.mjs
```

## Sessions

- Author verification browser: `s1bydf39xrowbx14ni803vsd` (deleted after verification).
