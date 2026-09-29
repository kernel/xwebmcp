# exploretock.com

Tools for Tock (https://www.exploretock.com): restaurant, bar and winery reservations. All three are read-only and work signed out.

| tool | file | status | notes |
|------|------|--------|-------|
| search_restaurants | [search_restaurants.js](search_restaurants.js) | draft | Dine-in or winery search in one Tock city for a date, party size and time: venues with offerings, party limits, payment terms and slots near the requested time |
| get_restaurant | [get_restaurant.js](get_restaurant.js) | draft | One venue's profile, service hours, booking flags and offerings (`offering_id`, party sizes, seating areas, payment terms) |
| get_availability | [get_availability.js](get_availability.js) | draft | Every slot for one offering on a date and party size (Book versus Notify, seating areas), payment terms and the calendar's open dates |

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

or, from the CLI, `kernel browsers webmcp custom-tools add <browser> --namespace exploretock.com --force-overwrite-namespace --source-file <file>` with a file that spreads the three arrays into one. Use `timeoutSec: 60` for `search_restaurants` and `get_restaurant`, and `timeoutSec: 90` for `get_availability` (live runs took 1 to 3 s for the page tools and 5 to 6 s for `get_availability`).

- **search_restaurants** (`kind: "page"`) fetches `https://www.exploretock.com/city/<city>/search?date=&size=&time=&type=DINE_IN_EXPERIENCES` from the current document, which is the URL the site's own search form opens, and reads the results out of the page's embedded state. `type: "winery"` adds `businessType=winery`, `query` adds `q=`. It never navigates. Results keep the site's relevance order, which can put venues outside the city first; `distance_miles` is measured from the city center. `time` is on a half hour because that is what the site's time picker offers (when it is omitted the site picks its own default time and lists different slots, so the tool always sends one, default 19:00). Dates before the current day are rejected because the site silently rewrites them to today.
- **get_restaurant** (`kind: "page"`) fetches `https://www.exploretock.com/<slug>` the same way and reads the venue record and the offerings out of the embedded state. It never navigates.
- **get_availability** (`kind: "cdp"`) opens `https://www.exploretock.com/<slug>/experience/<offering_id>/reservation?date=&size=` in the tab and reads the slot list and calendar the page renders once it has loaded. It only reads: it never clicks a slot, Book, Notify or a seating area.

### Why `get_availability` is `cdp` and the other two are `page`

The two page tools do their work with a same-origin `fetch` of a server-rendered page and never replace their document. Slots are different: on every page that shows them (the venue page, its `/search` page and the offering page) Tock loads them after the page loads, from a binary (protobuf) `POST /api/consumer/calendar/full/v2` whose request scope is carried in `x-tock-*` request headers, and renders them into the DOM. The server-rendered HTML does not contain them (checked on one venue: no slot data in the fetched HTML or in `$REDUX_STATE`). So the tool has to navigate to a page that loads them, which replaces the registering document, and the structured result (slot times, Book versus Notify, seating areas, calendar) exists only in the destination document after navigation. That meets both conditions of `spec/cdp-tools.md` §2.1. It could be split into phased page tools (§2.3), but the caller would then have to wait for a destination tool, match its `tool_ref`, and drive the date and party size through the page's own controls; one call that returns the answer is what makes the tool useful here. The tool decodes nothing from the binary API and calls no endpoint itself.

## URL patterns

All three tools match only `https://www.exploretock.com/*`, not the default `https://exploretock.com/*` and `https://*.exploretock.com/*`. Tock is one product, but every page and its first-party API (`https://www.exploretock.com/api`) are served from `www`, and the two page tools use same-origin `fetch`, which would fail from another host. The bare `exploretock.com` redirects to `www` (checked 2026-09-29: it landed on `https://www.exploretock.com/`), and the tools are listed after that redirect and not on other sites. `get_availability` uses the same host so the namespace stays on one host and it navigates only within `www.exploretock.com`. If the tab is on another site, open `https://www.exploretock.com/` first. Restaurant pages that embed Tock's booking widget, Resy (`resy.com`, where Tock's business sign-up now lives) and other Tock host names were not examined and are not covered.

## Outputs and conventions

- Every result carries `observed_at` (`search_restaurants`, `get_restaurant`, `get_availability`). Inventory changes by the minute.
- Slot times are venue-local with no offset. `search_restaurants` returns `local_datetime` (`YYYY-MM-DDTHH:MM`) from the site's own data; `get_availability` returns `local_time` on the requested date parsed from the page's label (`5:00 PM` or `17:00`, whichever the page's locale shows) and keeps the label.
- `payment` is the site's raw payment fields: `price_type` (`PAYMENT_CARD_HOLD`, `PREPAID` and `FREE` were observed), `amount_cents` and `per` (`PER_TICKET`). The tool does not interpret them; it does not say whether a card is charged. For `get_availability` and `get_restaurant` the entry for the smallest applicable party range is used; `search_restaurants` reports the payment fields of the first listed slot.
- `bookable` means the page shows a Book button and `notify_only` means it shows Notify instead. Neither is a held table. The tool does not say why a time is Notify-only.
- `no_availability` (from `get_availability`) carries the site's own message: `not_offered_on_date` ("... is not offered on Oct 9") or `not_open_yet` ("... has not opened reservations for Jun 10"). Both messages were observed live; other empty states were not seen.
- Errors are explicit: `invalid_input`, `not_found` (unknown city slug, venue or offering; an unknown city lists similar slugs), `wrong_page` (page tools off `www.exploretock.com`), `challenge` (Cloudflare's "Just a moment" page), `rate_limited`, `site_changed` (the embedded state or the offering list is not where the tool expects it) and `site_error`.
- Page tools that return non-ASCII text (accented names) have been observed to arrive from the Kernel runtime's page bridge as a JSON string rather than an object; parse the string when `typeof output === "string"`. This is runtime behaviour, not tool code.

## Safety and trust boundary

- Nothing here selects a slot, clicks Book or Notify, opens checkout, holds a table, joins a Notify list, accepts terms, changes party size or date through the page's controls, or signs in. `get_availability` navigates the tab to an offering page by URL, which loads it as a shopper would; the page's party-size and date come from the URL. The tests fail if a click helper is called.
- The page tools read HTML from `www.exploretock.com` with the page's own cookies and cut only the paths they need out of the embedded state literal (`availability.result`, `metroArea.selectedMetroArea`, `app.config.business`, `app.config.metroArea` for suggestions, `calendar.offerings.experience`). The same state also holds the session and CSRF tokens, the payment-processor key and, when signed in, account data. None of those paths is read, the raw state is never returned, and fields are allowlisted. Tests assert fabricated tokens and an email never appear in output.
- Venue text (names, descriptions, notices) is written by the venues and is returned as data; no tool follows instructions found in it.
- No tool signs in or needs a session. During discovery a signed-in browser's search, venue and offering pages made the same requests as signed-out ones, but signed-in-only inventory (member presales, unlock codes) was not examined.

## Site quirks

- The site's state is embedded as a JavaScript literal (`window.$REDUX_STATE = {...}` with `undefined` values and function values), not JSON. The page tools locate a path by scanning keys and skipping other values with a string-aware scanner, replace `undefined` outside strings with `null`, and parse just that value. A change to the key order or an unbalanced function body makes a path unreadable and returns `site_changed`.
- The bare city search returns venues from the whole region: a Chicago search lists a venue about 70 miles away first. The site's `city` query parameter is not needed; the city comes from the path, and an unknown slug still returns 200 with results but no `selectedMetroArea`, which is how the tool detects it.
- City slugs are the metro list's `slug` values (`chicago`, `new-york-city`, `san_juan` with an underscore); the list is in `app.config.metroArea` on every page.
- The site rewrites inputs it does not accept: a party size above the offering's maximum becomes `size=2`, a past date becomes today, and the offering slug in the URL is ignored (any slug reaches the same offering; an unknown offering id falls back to the venue page with no slot list). `get_availability` compares the final URL with the request and reports `invalid_input` instead of returning another day's or party's slots.
- The offering page shows the whole day. The venue's `/search` page shows only the slots nearest a time behind a "N more times" control, which the tool does not use.
- The site's time picker showed 24-hour options (`11:00`) in a session whose IP resolved to the UK and 12-hour labels in a US session. Slot labels probably follow the same locale, so `get_availability` accepts both; 24-hour slot labels were not seen live.
- Cloudflare challenges direct requests without a real browser (`curl` and a non-stealth headless browser both received "Just a moment..."). Use stealth browsers; the tools report `challenge` rather than returning empty data.
- Availability differs by party size (a party of 4 returned fewer slots than a party of 2 for the same offering and day). The calendar's open dates are returned as the page shows them for the requested party size; whether they change with party size was not compared.

## Known limitations

- Dine-in and winery reservations only. Pickup, delivery, ticketed events, gift cards, merchandise and private-dining requests are not covered, though the site's search supports some of them (searching for them worked with other `type` values during discovery but they were not built).
- US-style city slugs were exercised; non-US metros, other currencies and locales other than the one live sessions used were not tested.
- `search_restaurants` returns at most 20 venues per page (site returned about 140 for a large metro), up to 5 offerings per venue and 10 slots per offering. Slots are those the site lists near the requested time, not the whole day. `get_availability` returns at most 96 slots.
- `get_availability` needs the offering's page to render a slot list or a message within 45 seconds and reads the DOM (`data-testid` values such as `search-result-list-item` and `consumer-calendar-day`); a redesign returns `site_error` or `site_changed`, not a guess.
- `payment` fields are raw site values and their meaning (deposit, hold, prepayment, whether per person) is not interpreted.
- Calendar dates come from the page's day buttons: available means the site's `is-available` class on an in-month day, unavailable means an aria-label containing "no availability". Days that are neither (past days, days after the booking window) are omitted.
- The bare `not found` case for a venue page relies on HTTP 404; a venue that redirects to another slug returns `site_changed` if the record's slug differs.
- Not live-verified: non-US metros, 24-hour slot labels, an offering that shows a control other than Book or Notify (`other`), a Notify-only day with no Book slots, events and pickup offerings passed to `get_availability`, a fully booked message, signed-in-only inventory, and how the tools behave when Cloudflare presents a challenge mid-session (covered by stubbed tests).

## QA

Fixture tests in `tests/exploretock-restaurants.test.mjs` cover input validation before any site access, the state scanner (including `undefined` values, function bodies and string contents that look like state syntax), pagination and bounds, city suggestions, error mapping, the fake-DOM parsing of slots and calendars, stale-document handling, party-size and date rewrites, secret non-disclosure and the absence of click helpers.

Live checks by the builder on 2026-09-29, signed out, stealth Kernel browser, invoked through the Kernel API with the whole namespace registered: a dine-in search for a large US city (about 140 venues), `query` and winery variants, a zero-result query, a page beyond the last, an unknown city slug (suggestions returned), a venue page by slug and by URL, a missing venue; availability for a party of 2 and 4, a day the offering is not offered, a date beyond the booking window, an unknown offering, an unknown venue, a party size above the offering's maximum, and invocation from the login page. The tools were not listed on `example.com`. No slot, Book, Notify or checkout control was clicked.

No independent QA has been done yet; all three tools are `draft`.

Sessions (ephemeral): builder browsers were created and deleted during the work.
