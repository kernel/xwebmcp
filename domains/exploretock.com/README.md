# exploretock.com

Tools for Tock (https://www.exploretock.com): restaurant, bar and winery reservations. All three are read-only and work signed out.

| tool | file | status | notes |
|------|------|--------|-------|
| search_restaurants | [search_restaurants.js](search_restaurants.js) | draft | Dine-in or winery search in one Tock city for a date, party size and time: venues with offerings, accepted party sizes, pricing and the ten times nearest the request with their seating areas |
| get_restaurant | [get_restaurant.js](get_restaurant.js) | draft | One venue's profile, service hours, booking flags and offerings (`offering_id`, party sizes, seating areas, pricing, whether `get_availability` can read them) |
| get_availability | [get_availability.js](get_availability.js) | draft | Every slot for one table-reservation offering on a date and party size (Book versus Notify, seating areas), pricing and the calendar's open dates |

`search_restaurants` returns `slug`, which `get_restaurant` takes. Both return `offering_id`, which `get_availability` takes together with the venue `slug`.

## Native WebMCP tools

None found (checked 2026-09-29, with `webmcp.listTools()` and `document.modelContext.getTools()`, on the home page, a city search page, a venue page, an experience page and `/login`). `document.modelContext` exists with zero registered tools and `navigator.modelContext` is undefined, so the custom namespace `exploretock.com` does not overlap with anything the site registers.

## Scope and loading

Register all three together, because `forceOverwriteNamespace: true` replaces the whole namespace:

```javascript
const fs = await import("node:fs");
const read = name => fs.readFileSync(`domains/exploretock.com/${name}.js`, "utf8");
const tools = ["search_restaurants", "get_restaurant", "get_availability"].flatMap(name => eval(read(name)));
await webmcp.addCustomTools({ namespace: "exploretock.com", tools, forceOverwriteNamespace: true });
```

or, from the CLI, `kernel browsers webmcp custom-tools add <browser> --namespace exploretock.com --force-overwrite-namespace --source-file <file>` with a file that spreads the three arrays into one. Use `timeoutSec: 60` for `search_restaurants` and `get_restaurant`, and `timeoutSec: 90` for `get_availability` (live runs took 1 to 3 s for the page tools and 3 to 12 s for `get_availability`, the slowest being venues with several seating areas).

- **search_restaurants** (`kind: "page"`) fetches `https://www.exploretock.com/city/<city>/search?date=&size=&time=&type=DINE_IN_EXPERIENCES` from the current document, which is the URL the site's own search form opens, and reads the results out of the page's embedded state. `type: "winery"` adds `businessType=winery`, `query` adds `q=`. It never navigates. Results keep the site's relevance order, which can put venues outside the city first and can differ between calls a few seconds apart, so consecutive pages are not a stable snapshot; `distance_miles` is measured from the city center. `time` is on a half hour because that is what the site's time picker offers (when it is omitted the site picks its own default time and lists different slots, so the tool always sends one, default 19:00). Each offering lists the ten times nearest the requested time, merged across seating areas (a time offered in three areas is one entry with three `seating_areas`), not the whole day; `slot_count` is the number of distinct times the site listed.
- **get_restaurant** (`kind: "page"`) fetches `https://www.exploretock.com/<slug>` the same way and reads the venue record and the offerings out of the embedded state. It never navigates. Offerings of every type are listed with their `type`; `slots_supported` is true for table reservations (`RESERVATION`, `PRIX_FIXE`, `DEPOSIT`), which `get_availability` can read, and false for pickup, delivery, ticketed events and any other type.
- **get_availability** (`kind: "cdp"`) opens `https://www.exploretock.com/<slug>/experience/<offering_id>/reservation?date=&size=` in the tab and reads the slot list and calendar the page renders once it has loaded. It only reads: it never clicks a slot, Book, Notify or a seating area. Once the page state is present it checks the offering's type, accepted party sizes and the date against the venue's time zone, and returns at once for an unsupported type, a party size the offering does not accept or a date before today at the venue, instead of waiting for a slot list that will not come.

### Why `get_availability` is `cdp` and the other two are `page`

The two page tools do their work with a same-origin `fetch` of a server-rendered page and never replace their document. Slots are different: on every page that shows them (the venue page, its `/search` page and the offering page) Tock loads them after the page loads, from a binary (protobuf) `POST /api/consumer/calendar/full/v2` whose request scope is carried in `x-tock-*` request headers, and renders them into the DOM. The server-rendered HTML does not contain them (checked on one venue: no slot data in the fetched HTML or in `$REDUX_STATE`). So the tool has to navigate to a page that loads them, which replaces the registering document, and the structured result (slot times, Book versus Notify, seating areas, calendar) exists only in the destination document after navigation. That meets both conditions of `spec/cdp-tools.md` §2.1. It could be split into phased page tools (§2.3), but the caller would then have to wait for a destination tool, match its `tool_ref`, and drive the date and party size through the page's own controls; one call that returns the answer is what makes the tool useful here. The tool decodes nothing from the binary API and calls no endpoint itself.

## URL patterns

All three tools match only `https://www.exploretock.com/*`, not the default `https://exploretock.com/*` and `https://*.exploretock.com/*`. Tock is one product, but every page and its first-party API (`https://www.exploretock.com/api`) are served from `www`, and the two page tools use same-origin `fetch`, which would fail from another host. The bare `exploretock.com` redirects to `www` (checked 2026-09-29: it landed on `https://www.exploretock.com/`), and the tools are listed after that redirect and not on other sites. `get_availability` uses the same host so the namespace stays on one host and it navigates only within `www.exploretock.com`. If the tab is on another site, open `https://www.exploretock.com/` first. Restaurant pages that embed Tock's booking widget, Resy (`resy.com`, where Tock's business sign-up now lives) and other Tock host names were not examined and are not covered.

## Outputs and conventions

- Every result carries `observed_at`. Inventory changes by the minute.
- Slot times are venue-local with no offset. `search_restaurants` returns `local_datetime` (`YYYY-MM-DDTHH:MM`) from the site's own data; `get_availability` returns `local_time` on the requested date parsed from the page's label (`5:00 PM` or `17:00`, whichever the venue's page shows) and keeps the label.
- `pricing` is the site's own pricing fields for an offering: `description` is the site's price text for guests (for example `$594 per person`, which already includes a 20% service charge, `Starting at $450 per person` or a flat `$500`), `price_type`, `amount_cents` and `per` are its raw ticket fields (`PAYMENT_CARD_HOLD`, `DEPOSIT`, `PREPAID` and `FREE` were observed), and `fees` are its raw fee entries (`PERCENT` values are percents, `FLAT` values are cents). The ticket amount can be 0 or lower than the price shown while fees or a minimum spend apply, so read `description` and `fees` with it. The tool does not add these up and does not say whether a card is charged. `search_restaurants` and `get_availability` use the party range that covers the requested party size; `get_restaurant` uses the smallest range.
- `party_sizes` lists every size the offering accepts and can skip sizes (some offerings take only 2 or 4).
- `bookable` means the page shows a Book button and `notify_only` means it shows Notify instead. Neither is a held table. The tool does not say why a time is Notify-only. A day can list only Notify-only slots while the calendar marks it "no availability".
- `no_availability` (from `get_availability`) carries the site's own message: `not_offered_on_date` ("... is not offered on Oct 9") or `not_open_yet` ("... has not opened reservations for Jun 10"). Both messages were observed live; other empty states were not seen.
- Errors are explicit: `invalid_input`, `not_found` (unknown city slug, venue or offering; an address that is only an alias of another venue, with the canonical slug named; an unknown city lists similar slugs), `unsupported_offering` (`get_availability` for a pickup, delivery or event offering), `wrong_page` (page tools off `www.exploretock.com`), `challenge` (Cloudflare's "Just a moment" page, or an HTTP 403 from the site's firewall), `rate_limited`, `site_changed` (the embedded state or the offering list is not where the tool expects it) and `site_error`.
- Page tools that return non-ASCII text (accented names) have been observed to arrive from the Kernel runtime's page bridge as a JSON string rather than an object; parse the string when `typeof output === "string"`. This is runtime behaviour, not tool code.

## Safety and trust boundary

- Nothing here selects a slot, clicks Book or Notify, opens checkout, holds a table, joins a Notify list, accepts terms, changes party size or date through the page's controls, or signs in. `get_availability` navigates the tab to an offering page by URL, which loads it as a shopper would; the page's party size and date come from the URL. The tests fail if a click helper is called.
- The page tools read HTML from `www.exploretock.com` with the page's own cookies and cut only the paths they need out of the embedded state literal (`availability.result`, `metroArea.selectedMetroArea`, `app.config.metroArea`, `app.config.business`, `calendar.offerings.experience`). The same state also holds the payment-processor key (`app.config.stripeApiKey`), the session and CSRF token fields (empty when signed out, populated when signed in) and, when signed in, account data. None of those paths is read, the raw state is never returned, and fields are allowlisted. Tests assert fabricated tokens and an email never appear in output.
- Venue text (names, descriptions, notices) is written by the venues and is returned as data; no tool follows instructions found in it.
- No tool signs in or needs a session. During discovery a signed-in browser's search, venue and offering pages made the same requests as signed-out ones, but signed-in-only inventory (member presales, unlock codes) was not examined.

## Site quirks

- The site's state is embedded as a JavaScript literal (`window.$REDUX_STATE = {...}` with `undefined` values and function values), not JSON. The page tools locate a path by scanning keys and skipping other values with a string-aware scanner, replace `undefined` outside strings with `null`, and parse just that value. A change to the key order or an unbalanced function body makes a path unreadable and returns `site_changed`.
- The bare city search returns venues from the whole region: a Chicago search lists a venue about 70 miles away first. The site's `city` query parameter is not needed; the city comes from the path, and an unknown slug still returns 200 with results but no `selectedMetroArea`, which is how the tool detects it.
- City slugs are the metro list's `slug` values (`chicago`, `new-york-city`, `san_juan` with an underscore); the list is in `app.config.metroArea` on every page.
- The site rewrites inputs it does not accept: a past date on the search page becomes today, a party size above the offering's maximum becomes `size=2` on the offering page, and the offering slug in the URL is ignored (any slug reaches the same offering; an unknown offering id falls back to the venue page with no slot list). The tools reject these inputs first where the page state allows it and otherwise compare the final URL with the request, so they never return another day's or party's slots.
- A party size that falls between accepted sizes (an offering that takes only 2 and 4, or 1 to 10 and 12) leaves the offering page without a slot list; `party_sizes` and the early check exist for that.
- Ticketed-event offerings redirect the offering URL to `/<slug>/event/<offering_id>/...`, and pickup and delivery offerings render a different picker; `get_availability` refuses both by type.
- Some short paths on the site (for example `/about`) serve an unrelated venue; the tools report those as an alias with the canonical slug instead of returning that venue under the requested slug. Non-HTML paths such as `/robots.txt` are `not_found`.
- The offering page shows the whole day. The venue's `/search` page shows only the slots nearest a time behind a "N more times" control, which the tool does not use.
- The site's time picker showed 24-hour options (`11:00`) in a session whose IP resolved to the UK. Independent QA saw 24-hour slot labels for London venues and 12-hour labels for Toronto and Sydney venues, so the label format follows the venue; `get_availability` accepts both.
- Cloudflare challenges direct requests without a real browser (`curl` and a non-stealth headless browser both received "Just a moment..."). Use stealth browsers; the tools report `challenge` rather than returning empty data. The site's firewall also answers some inputs (SQL-looking search text) with HTTP 403, which is reported as `challenge` too.
- Availability differs by party size (a party of 4 returned fewer slots than a party of 2 for the same offering and day). The calendar's open dates are returned as the page shows them for the requested party size; whether they change with party size was not compared.

## Known limitations

- Dine-in and winery table reservations only. Pickup, delivery, ticketed events, gift cards, merchandise and private-dining requests are not covered, though the site's search supports some of them (searching for them worked with other `type` values during discovery but they were not built).
- `search_restaurants` returns at most 20 venues per page (the site returned about 140 for a large metro), up to 5 offerings per venue and 10 times per offering. Its `total` is the site's count for that call and the order can change between calls. `get_availability` returns at most 96 slots.
- `get_availability` needs the offering's page to render a slot list or a message within 45 seconds and reads the DOM (`data-testid` values such as `search-result-list-item` and `consumer-calendar-day`); a redesign returns `site_error` or `site_changed`, not a guess. A past date at the venue is rejected once the page state is known; before that only dates more than a day old are rejected.
- `pricing` fields are raw site values; what a deposit, hold or prepayment means, and whether it is per person, is not interpreted beyond the site's own `description`.
- Calendar dates come from the page's day buttons: available means the site's `is-available` class on an in-month enabled day, unavailable means an aria-label containing "no availability". Days that are neither (past days, days after the booking window) are omitted.
- The `not found` case for a venue page relies on HTTP 404 and on the page state's venue record.
- Not live-verified by the builder: a real Cloudflare challenge or HTTP 429 (both are covered by stubbed tests and by synthetic responses in independent QA), an offering that shows a control other than Book or Notify (`other`), a fully booked message, signed-in-only inventory, pickup or event listings passed to `get_availability` beyond the type refusal, and the `x-tock-*` header claim above (only that the POST exists and that the fetched pages carry no slot rows).

## QA

Fixture tests in `tests/exploretock-restaurants.test.mjs` cover input validation before any site access (including impossible calendar dates), the state scanner (including `undefined` values, function bodies and string contents that look like state syntax), pagination and bounds, nearest-time slot selection with several seating areas, pricing with fees and party ranges, city suggestions, error mapping, the fake-DOM parsing of slots and calendars, stale-document handling, party-size, type and date checks, secret non-disclosure and the absence of click helpers. A set of source mutations (comparison operators, caps, party-range choice, error kinds, control matching, calendar filters) was run against the suite and every one failed a test.

Live checks by the builder on 2026-09-29, signed out, stealth Kernel browser, invoked through the Kernel API with the whole namespace registered: a dine-in search for a large US city (about 140 venues), `query` and winery variants, a zero-result query, a page beyond the last, an unknown city slug (suggestions returned), a venue page by slug and by URL, a missing venue; availability for a party of 2 and 4, a day the offering is not offered, a date beyond the booking window, an unknown offering, an unknown venue, a party size above the offering's maximum, and invocation from the login page. The tools were not listed on `example.com`. No slot, Book, Notify or checkout control was clicked.

An independent QA agent reviewed the first revision and reported defects, all addressed in the revision this README describes: dropped slots on multi-seating offerings, prices that ignored fees, pickup and event offerings read as table slots, party-size gaps that waited 45 s, impossible calendar dates that threw, past dates, alias slugs, and stale documentation. Independent QA of the final revision is recorded below when done; until then every tool stays `draft`.

Sessions (ephemeral): builder and QA browsers were created and deleted during the work.
