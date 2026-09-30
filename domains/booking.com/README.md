# booking.com

Tools for Booking.com stays (https://www.booking.com): search a destination, compare dated room rates and prepare an exact rate for manual booking. All three are read-only and work signed out.

| tool | file | status | notes |
|------|------|--------|-------|
| search_stays | [search_stays.js](search_stays.js) | verified | First results page (up to 25 properties) for a destination, explicit dates, adults, child ages and the currency the site shows, with sort and filters; echoes the dates, guests and currency the site applied |
| get_property | [get_property.js](get_property.js) | verified | Dated room rates, IDs and global comparison ranks; optional lowest-price ordering before the cap, excluded fees and policies; smaller-party rates are left out |
| prepare_booking | [prepare_booking.js](prepare_booking.js) | qa_passed | Current-page-only exact-rate handoff for one room and adults without children; checks price, dates, party, sign-in state and terms; never selects, reserves or opens checkout |

## Native WebMCP tools

None found (checked 2026-09-29 with `webmcp.listTools()` and `document.modelContext.getTools()` signed out on the home page, a stays results page, a property page, and the `flights.booking.com` index and results pages). `document.modelContext` exists with zero registered tools and `navigator.modelContext` is undefined, so the `booking.com` custom namespace does not overlap with anything the site registers.

## Execution kind

The two read tools are `kind: "page"`. Each makes one same-origin `fetch` of the site's own HTML (`/searchresults.html`, `/hotel/<country>/<slug>.html`) with the document's cookies, parses the returned markup with `DOMParser`, and never navigates the tab, so neither needs to survive a navigation and neither qualifies for `cdp`. `prepare_booking` only reads the current document and makes no request or navigation; it is also `page`. The results and the property page are server-rendered, and a same-origin fetch returned the same cards and rate rows the rendered page shows.

## Scope and loading

Register all three files together under namespace `booking.com`; `forceOverwriteNamespace: true` replaces the whole namespace.

```javascript
const fs = await import("node:fs");
const tools = ["search_stays", "get_property", "prepare_booking"].flatMap(name => eval(fs.readFileSync(`domains/booking.com/${name}.js`, "utf8")));
await webmcp.addCustomTools({ namespace: "booking.com", tools, forceOverwriteNamespace: true });
const tab = (await currentTab()).targetId;
const ref = async name => (await webmcp.listTools()).find(t => t.source.custom?.namespace === "booking.com" && t.tool.name === name && t.source.target_id === tab).tool_ref;
const found = await webmcp.invokeTool(await ref("search_stays"), { destination: "Lisbon", check_in: "2026-11-10", check_out: "2026-11-12", adults: 2, currency: "USD", limit: 5 }, { timeoutSec: 60 });
const property = await webmcp.invokeTool(await ref("get_property"), { property_url: "<property_url from search_stays>", check_in: "2026-11-10", check_out: "2026-11-12", adults: 2, currency: "USD" }, { timeoutSec: 60 });
```

Use future dates. Each call took about 1 to 4 seconds live. Do not navigate the tab while a call runs: a page tool stops when its document is replaced, and the result is lost. The Kernel REPL helper returned `output` as an object for most results but as a JSON string for some results containing non-ASCII text (the `no_availability` result did; `ok` results with the same non-ASCII address did not; a schema-less probe tool returning `{"a":"Tomás"}` did too); parse a string `output` before use.

The read tools run on any `https://www.booking.com` page in an English-language session and return `wrong_page` or `unsupported_language` without a request otherwise. `prepare_booking` requires the exact dated property page already open; an unrelated page returns `wrong_page` without navigation.

**search_stays** takes `destination`, `check_in`, `check_out`, `adults` and `currency` (all required), plus optional `children_ages`, `sort`, `star_ratings`, `min_review_score`, `free_cancellation_only`, `breakfast_included` and `limit` (1 to 25, default 10). It searches one room. It returns the destination the site resolved (name, `dest_id`, type, country code and breadcrumb) so a caller can spot an ambiguous name, the site's `total_found`, `has_more`, and for each property the canonical `property_url`, area, distance, star rating when the card shows one, review score, the recommended unit, price and deal labels. Only the first results page is read; later pages are not.

**get_property** takes `property_url` (as returned by `search_stays`), `check_in`, `check_out`, `adults` and `currency` (required), plus optional `children_ages`, `max_rates` (1 to 40, default 20) and `sort` (`page_order` or `price_low_to_high`). It scans at most 400 rows, sorts before applying the cap and keeps rooms grouped. Each rate's `comparison_rank` is its global order, and `rate_id` is the row's `data-block-id` (null if missing or malformed). Comparison uses displayed totals only: it neither adds excluded fees nor treats a member preview as an obtainable public price. It reads one room's worth of pricing. It returns the property facts and `rooms[]` with each room's `rates[]`. `no_availability` means the page itself says the property has nothing for those dates. `no_rate_for_party` means every rate it lists is limited to fewer guests than the party (per-bed dormitory rates, for example): that is not "no availability", because the site may let you select several such units, which the tool does not price.

### Exact booking preparation and execution safety

`prepare_booking` takes the canonical `property_url`, numeric `property_id`, `rate_id`, `check_in`, `check_out`, `adults`, `currency`, `expected_total` (the exact displayed total) and `expected_signed_in` from the read. Manually open the dated property page first. It requires the same property ID, dates, night count, adult party, zero children, one room, currency and unambiguous header sign-in state. Explicit ISO codes or recognized currency markers in the rate price must not contradict that currency. The exact rate must occur once, have a numeric room ID, enough stated capacity, a selectable one-unit option (including inherited fieldset/optgroup disabling), no selected units anywhere in the table, and readable cancellation, prepayment and excluded-fee text. Member-only previews fail with `login_required`; changed prices fail with `price_changed`.

The output is an allowlisted snapshot of those terms and a dated property URL with no selection, checkout, tracking or session parameters. There is no request, click, form fill, selection or persistent draft. `inventory_reserved: false` means this tool reserved nothing; it is not an assertion about prior reservations elsewhere. Repeating preparation merely reads again. Canceling before execution returns `canceled`. `expected_signed_in` is only a sign-in-state check, not proof of the intended account; manual account review is required.

**No execution tool ships.** Room selection/holds, booking, cancellation and payment are consequential. The runtime does not provide a trusted approval path bound to the exact account, rate, guests, dates, final all-in cost and full terms. `confirmed=true`, a confirmation string, annotations and this snapshot cannot establish approval. Such inputs are rejected before page interaction. Preparation does not authorize any subsequent automated Reserve click; completion stays manual. No account mutation is needed to QA these tools.

### Dates, guests, currency and price basis

The output does not echo the request. `effective` is read from the page: dates, night count and currency from the inline page configuration (`b_checkin_date`, `b_checkout_date`, `b_checkin_checkout_interval`, `b_selected_currency`), the currency also from the header currency picker, adults, children and rooms from the search box, and the sign-in state from the header. A page that applied other dates, another party, or a different currency is an error (`search_not_applied`, `currency_mismatch`), never a result.

`price_basis` states what a price is:

- `search_stays`: `price.total` is the card's displayed price for the whole stay, for the whole party, on the unit the site recommends (`unit`). Results cards do not say what taxes and fees are excluded (`taxes_and_fees: not_itemized_on_results_card`), so use `get_property` for that. `per_night_average` is the card's per-night figure; it can differ from `total` divided by the nights (for example when a one-time charge is included), so do not derive a total from it. When the card shows a strike-through, `original_total` is the price before the deal and `total` the discounted price.
- `get_property`: `price.total` is the displayed total for the stay in one room; the page states that it excludes taxes and fees (`taxes_and_fees: excluded_as_listed_per_rate`), and `taxes_and_fees_excluded` repeats the page's own text for them, which can be in another currency (for example a city tax in EUR on a USD page). `null` there means no such text was found in a form the tool reads, not that none apply, and a warning says so. `total_before_taxes` is the unrounded figure from the page's price breakdown. A rate row shows the page's `Max. people` (no children in the search) or `Max adults` (children in the search); a rate limited to fewer guests than the party (for example a hostel bed "Only for 1 guest") is priced for those guests only, so it is left out and counted in `rates_left_out.party_too_large`, with a warning that several such units may be selectable on the site.

**Members-only prices.** A signed-out visitor is shown some Genius member prices as a preview: a results card carries "Sign in for this members-only price" and a rate's price breakdown lists a "Genius discount" with the same prompt. The displayed price then includes a discount a signed-out visitor is not given. `search_stays` sets `price.members_only` on the card; the card does not say how large the discount is, and `price.original_total` is only the pre-deal price (on a card that also has a deal it is well above the price without the member discount), so use `get_property` for the amount. `get_property` sets `member_discount: { amount, requires_sign_in: true }` on the rate, and the price without signing in is higher by about `amount`. Each case adds a warning. When the browser is signed in, `member_discount.requires_sign_in` is false and the discount is real for that account.

Rooms are fixed at one. With two or more rooms Booking.com recommended a single unit for the whole group on the results page, so multi-room pricing could not be interpreted; the tools do not offer a rooms input. Child ages are sent to the site, but the results page echoes only the number of children (a warning says so); the property page's room form lists the ages, and `children_ages_confirmed` is true only when they matched.

### The tools never change the site's currency

Booking.com keeps the chosen currency for the whole browser session: on 2026-09-29 a request with `selected_currency=GBP` made later requests without it show GBP too. A code the site does not offer made that response show each property's own currency (header `€$£`, prices in mixed currencies) while the page configuration still said USD; that did not persist to the next request. Reading prices in another currency would therefore change a persistent setting, and restoring it afterwards cannot be guaranteed (for example when the tab navigates during the call). So `currency` is required, must be the currency the site is already showing (the header currency picker), and is compared with the page. When it differs the call fails with `currency_mismatch`, naming what the site shows, and nothing was changed; change the currency in the site's own picker (or use the one shown) and call again. A request without cookies is not an alternative: it was answered with Booking.com's bot-protection page (HTTP 202).

## URL patterns

All tools use `https://www.booking.com/*` instead of the repository default (`https://booking.com/*`, `https://*.booking.com/*`). The two read tools fetch pages same-origin and preparation reads the current page, so all only work when the invoking document is on `www.booking.com`. A fetch from `www.booking.com` to `flights.booking.com` or `secure.booking.com` fails with `Failed to fetch` (observed); the reverse direction was not tried. Narrowing to the `www` host keeps the tools off most other Booking.com pages, but it does not remove every one. An independent reviewer observed that `flights.booking.com` redirected to a `www.booking.com` page (where the tools work) and that the Kernel runtime listed the tools on a `secure.booking.com` help page and on `account.booking.com`, most likely because those pages embed a `www.booking.com` frame (spec/cdp-tools.md §6.1); the author did not open those pages. Invoked from such a top document the tools return `wrong_page` without a request. The bare `booking.com` host and other subdomains are not covered.

## Site quirks

- Searches and property pages are sent as GET requests to the site's own URLs (`ss`, `checkin`, `checkout`, `group_adults`, `no_rooms=1`, `group_children`, repeated `age`, `order`, `nflt`). The tools pass neither `lang` nor `selected_currency`; a non-English session is refused rather than switched.
- The results page returned between 15 and 25 property cards for the same query on different loads, and the order of "Our top picks" varies between loads. `offset=25` did not return a second page, so only the first page is read and `has_more` reports the rest.
- A destination the site cannot resolve, a past date, and dates beyond its bookable window all redirect to the home page with HTTP 200; the tools report that as `search_not_accepted` and cannot tell which cause applied, and it may also be how the site answers a client it treats as automated (an independent local run of the extension in a non-stealth Chromium was redirected this way). Yesterday's date (UTC, allowed for time zones) is not redirected: the site drops the dates and returns an undated search, which is `search_not_applied`. On 2026-09-29 the search window ended between 2028-01-10 (accepted) and 2028-03-10 (redirected), about 16 months. `get_property` for a date beyond the window returns `no_availability` (indistinguishable from a sold-out date) or, because the page then shows the party the session last searched instead of the requested one, `search_not_applied`.
- A resolvable destination with no properties (a filter combination nothing matches) is a page saying "0 properties found" and is `no_results`. A destination name is resolved to the site's best match, for example "Springfield" to one US city; check `destination`.
- Filters are sent as the site's `nflt` values: `class=<1-5>`, `review_score=<60|70|80|90>`, `fc=2` (free cancellation) and `mealplan=1` (breakfast included). Stay length up to 30 nights is accepted by the tools.
- A property that does not exist gives HTTP 404 (`property_not_found`). A property with no availability for the dates has no rate table and says "We have no availability here between …" (`no_availability`).
- Rate rows share a room: only the first row of a room carries its name, beds and features. A rate row may have no occupancy cell (`max_guests` and `max_adults` null). A row that cannot be attributed to a readable room is counted in `rates_left_out.unreadable` with a warning, never dropped silently.
- Property pages come in more than one layout. The tool reads the layout with the `#hprt-table` rate table (seen from Kernel browsers with US egress). The author's local non-stealth Chromium was served a different layout without that table, which the tool reports as `site_changed`. The independent reviewer's local extension run was served the table with different price markup: no "Total before taxes" or average-per-night lines, the taxes shown under the price as "+US$18 taxes and fees" (`.prd-taxes-and-fees-under-price`), and a "Partner Offer" room head whose link is `a.hprt-roomtype-link` without `data-room-id`. The tool reads that markup (`total_before_taxes` and `per_night_average` stay null, `room_id` is null) and warns when a rate lists no excluded taxes in a form it reads; the author did not reproduce this layout and relies on the reviewer's sanitized markup.
- Signed in, the same property showed lower prices with an added "Genius discount" line that is real for the account (`member_discount.requires_sign_in` false); signed out, some prices are members-only previews (see Members-only prices). The tools set `signed_in` from the header, add a warning when it is true, and were built and checked mostly signed out. Signed-in behavior was checked read-only by the author on an approved session and only simulated by the independent reviewer.
- Booking.com records every search and page view like a normal visit; there is no way to make these reads invisible to it.
- A request without cookies is answered with HTTP 202 and a small page titled "JavaScript is disabled" carrying an AWS WAF script (observed 2026-09-29). The tools map that shape to `challenge`; they always send the page's own cookies.

## Known limitations

- Not implemented: room/rate selection, saving to a list, holds, booking/cancellation/payment execution, checkout, account reads, review text, photos, maps, flights, cars, taxis and attractions. Populated saved-list/reservation structures and account identity guards have not been validated, so those candidates are omitted rather than fabricated. No bookings or saved items were created for testing. The tools never click, submit a form, or open `secure.booking.com`.
- Preparation supports only one room with adults and no children. It refuses missing capacity, fees, policies, room IDs, changed state or existing selections, including layouts that public reads can partially parse. It does not calculate a final all-in cost or independently establish account identity.
- One room, up to 30 adults and 10 children. Multi-room searches, flexible dates, map or region drawing, price-range filters and property-type filters are not supported. The site's currency cannot be chosen through the tools (see above).
- Only the first results page is read (at most 25 properties); no later pages.
- The `gated` (sign-in or consent path), `rate_limited` and HTTP-error branches are covered by fixture tests and by simulated failures only; no sign-in wall or 429 was seen. The `challenge` shape was observed live only for a request without cookies, which the tools never send. A cross-origin redirect to a sign-in or consent host would surface as `site_error` with a sanitized request-failure message because a page fetch cannot read it.
- Only the `#hprt-table` rate-table layouts return rates; a page without that table is reported as `site_changed`.
- With children in the party, the party check compares only the adults with the page's "Max adults"; whether a rate's price covers the children is not stated on the page, and the tool does not claim it.
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

Independent QA (agent `agt_dd7f389d3c2826a1698e`, three rounds on 2026-09-29, each in a fresh stealth Kernel browser with US egress, plus the local Chrome extension in a non-stealth Chromium with Canadian egress) did not sign off. It compared cards, property pages and rate rows field by field with the rendered pages (0 mismatches on the results cards), ran an 84-case malformed-input sweep (no request sent for any), checked output-schema conformance for every reachable branch, navigation lifetime, an all-GET network audit, the header currency before and after, and simulated bot-protection, 429, 500, timeout and network failures.

| Head | Findings | Outcome |
|---|---|---|
| `4d1c680` | 8: rates for smaller parties priced as the whole party's price; taxes and fees dropped silently on an alternate price markup; rows without a room link dropped silently; display currency left changed if the tab navigated mid-call; yesterday's date reported as a markup change; README claims about URL patterns, the bookable window and bot-protection redirects | fixed: the tools no longer touch the site's currency, smaller-party rates are left out and counted, unreadable rows and missing tax text are counted and warned about, wording corrected |
| `6f5baae` | 5: members-only preview prices returned as ordinary prices; a per-bed hostel reported as no availability; a slug beginning with `login` reported as a gate; beyond-window dates depending on the session's last party; README inaccuracies | fixed: `members_only` and `member_discount`, `no_rate_for_party`, path check, README |
| `a7c189c` | 3: the members-only warning and `original_total` description said `original_total` is the price without the member discount, which is false for cards that also carry a deal; a stale field name and a contradicting README bullet; the members-only signals depended on exact markup in two places | fixed afterwards without a further review (no fix round remained): wording, README, and the two signals now also match the visible prompt text |

The earlier final source (`0cf42f0`) added those last fixes after review, without sign-off. The current increment adds comparison IDs/order, exact preparation, safe date validation, bounded fields and cancellation. Independent final-source sign-off for this increment is recorded below; the earlier rounds remain historical evidence.

What was and was not verified, by runtime:

- Kernel runtime (both tools registered together, invoked through `webmcp.invokeTool`): all of the above, signed out. Not exercised: signed-in behavior beyond the author's read-only check, a real non-English session, a cookieless request through the tools, and the `flights.`, `secure.` and `account.` hosts.
- Local Chrome extension (built from this repository, both tools installed): registration and listing on `www.booking.com`, `invalid_input`, `currency_mismatch`, and `get_property` on the alternate price markup (rates, taxes text, Partner Offer room, hostel `no_rate_for_party`). `search_stays` results could not be verified there: the site redirected the search to its home page for that client. No parity between the two runtimes is claimed; the markup differs.

Local tests use fabricated pages modeled on the observed markup, stubbed network and a frozen clock and never contact the live site:

```sh
node --test tests/booking-stays.test.mjs
```

### Current increment verification (2026-09-30)

- Fixtures: 128 Booking.com tests pass, including exact preparation success, malformed inputs before any page access, changed price/dates/currency/property/sign-in state, missing capacity/policies/fees, existing selections, duplicate/missing rates, member previews, cancellation, and document/selection equality. Real mutation success is not inferred from fixtures.
- Full suite: 1705 tests pass on the current branch; registry validation reports 82 valid tools. Structured read outputs have a 200,000-byte cap. Warnings may count rates scanned beyond the returned cap.
- Author Kernel check: all three files registered atomically; no native tools found before registration. Initial `get_property` invocation returned `outcome_unknown`, followed by a page-evaluation timeout. No automatic retry or booking action was made; the scratch browser was deleted.
- Independent round 1 reviewed `7ce8096`: Kernel search and property reads succeeded from the home page; preparation returned `wrong_page` there but `outcome_unknown` on its property page. The local extension returned live property data with matching sorted ranks and a `prepared` handoff with zero requests and unchanged HTML/selections; local search redirected home. These results do not establish cross-runtime parity.
- Three isolated-fixture defects were found (contradictory row currency, inherited disabled control, conflicting sign-in markers), reproduced in detached Chromium and jsdom without changing live controls. Their original reproductions passed recheck on `6de3e25`. That recheck found two additional fixture-only currency gaps (codes adjacent to digits, and spaced search-card original prices); both passed the final recheck on `6e0126248f3b44d6981372f95a02a2ee2400c259`.

### Independent final-source sign-off

Agent `agt_dd7f389d3c2826a1698e` independently signed off all three tools on source head `6e0126248f3b44d6981372f95a02a2ee2400c259`, 2026-09-30, after the initial review and two fix rechecks. All five findings passed final recheck. It ran 310 independent fixture probes, 19 detached-Chromium cases and validated 278 recorded outputs against the schemas. Malformed inputs before page access, cancellation, approval-flag rejection, conflicting sign-in state, disabled ancestry (including the first-legend exception), exact rate/party/price/terms guards, currency contradictions, UTF-8 bounds, privacy and sorting passed. Entire three-tool replacement, duplicate conflicts and synthetic native-tool preservation passed. Fixture and detached-document tests did not modify live controls.

| Final-source live case (2026-09-30) | Kernel | Local Chrome extension |
|---|---|---|
| `search_stays` from the home page, Lisbon, 2026-11-10 to 2026-11-12, 2 adults, USD | success: three cards; safe failures and document lifetime passed | blocked: redirected home, `search_not_accepted`; no workaround/retry |
| `get_property` from the home page, Santa Catarina, same dates/party | success: 22 fitting rates with IDs | success: rates and global ordering matched independently parsed markup |
| `prepare_booking`, signed-out dated property page | `account_state_changed`, not `prepared`; earlier-head timeouts unexplained | success: exact CAD 475 rate with CAD 26 excluded fees, zero requests, unchanged HTML/selections; negative cases passed |

`search_stays` and `get_property` meet `verified`: independent success/failure coverage plus dated live success from a different page of the domain. `prepare_booking` meets `qa_passed`; no successful Kernel preparation or cross-runtime parity is claimed. Signed-in final-source behavior, account identity, real non-English sessions and all consequential actions remain untested. No live selection, booking, hold, payment or account mutation was performed. The PR stays draft. Subsequent status/documentation edits do not change the three reviewed tool sources.

## Sessions

- Author verification browsers: `s1bydf39xrowbx14ni803vsd`, `yqpimf0yygskv8uxo0ov72yf` (deleted after verification).
- Independent QA browsers: `ao8pe7cki4f2al8lcwsxfgdx`, `qerwit5y8wv3qqxu4t5rnkt3`, `toqyl23786al406728x256pa` (deleted by the reviewer).
- Independent QA agent: `agt_dd7f389d3c2826a1698e`.
