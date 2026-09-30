# exploretock.com

Tools for Tock (https://www.exploretock.com): public restaurant, winery and ticketed-event discovery, table availability and read-only reservation preparation.

| tool | file | status | notes |
|------|------|--------|-------|
| get_availability | [get_availability.js](get_availability.js) | draft | Table-reservation slots, Book versus Notify, seating areas, raw pricing and calendar dates; navigates without clicking |
| get_restaurant | [get_restaurant.js](get_restaurant.js) | draft | Venue profile, service hours and offerings of all types; published event dates/time ranges are not ticket inventory |
| prepare_reservation | [prepare_reservation.js](prepare_reservation.js) | draft | Exact-slot public preparation on the already loaded offering page; no hold, checkout, booking, payment or notification submission |
| search_events | [search_events.js](search_events.js) | draft | Ticketed-event search over up to 31 days, with venue pagination and chronological search times |
| search_restaurants | [search_restaurants.js](search_restaurants.js) | draft | Dine-in or winery search by city, date, party size and time, with the nearest ten times per offering |

## Native WebMCP tools

No native tools were found on public home, city, venue or offering pages. Rechecked on 2026-09-30 before registering the custom namespace. Custom tools do not replace native capabilities.

## Scope and loading

Register the **entire namespace** together. Atomic replacement removes every existing tool in this namespace, not just tools with matching names:

```javascript
const fs = await import("node:fs");
const names = ["get_availability", "get_restaurant", "prepare_reservation", "search_events", "search_restaurants"];
const tools = names.flatMap(name => eval(fs.readFileSync(`domains/exploretock.com/${name}.js`, "utf8")));
await webmcp.addCustomTools({ namespace: "exploretock.com", tools, forceOverwriteNamespace: true });
```

The example evaluates local repository source, never fetched site text. With the CLI, supply a single expression spreading all five arrays to `kernel browsers webmcp custom-tools add --namespace exploretock.com --force-overwrite-namespace --source-file`.

Use a 60-second invocation timeout for page tools and 90 seconds for `get_availability`. Invocations are serial per tab. No tool automatically retries a failed request.

### Restaurant and event discovery

`search_restaurants` takes a Tock city slug (the segment after `/city/`), date, party size, preferred half-hour time, optional keyword and `type: dine_in | winery`. It fetches the same-origin server-rendered `/city/<city>/search` page without navigation. The site's relevance order can change between calls and can include distant venues; `distance_miles` is measured from the city center.

`search_events` uses the same page-first mechanism with the observed `type=EVENT` and inclusive `dateEnd` query. The range is at most 31 days; omitted `date_end` means the starting date only. It returns venues containing `GA_EVENT` offerings, descriptions, currency, raw pricing and up to ten chronological search times per offering. These are event search snapshots, not a promise of remaining quantity. It does not treat event tickets as table slots.

Both searches paginate the returned venue list: up to 20 venues per page, five offerings per venue and ten times per offering. `total` counts valid venue rows received, not an independently computed global count. Pages are not a stable snapshot. Each returned venue has a canonical public URL and `slug`, consumed by `get_restaurant`.

`get_restaurant` accepts a venue slug or Tock venue URL and fetches that venue's page without navigating. It returns the profile and up to 20 offerings, with `offering_count` exposing the full observed count. For ticketed events, `event_schedule` contains up to 100 explicitly published dates, 24 time ranges and `has_repetition`; recurrence rules are not expanded. `truncated` reports schedule bounds. A published schedule, general service hours or an offering's `AVAILABLE` state is not bookable inventory. Account data is never read.

### Availability: demonstrated CDP necessity

The page-first prototype fetched offering HTML, but it contained neither slot rows nor slot data in the embedded state. Tock loads availability after navigation through its own binary calendar/offerings requests and renders slot rows and calendar buttons. `get_availability` therefore navigates to `/<slug>/experience/<offering_id>/reservation?date=&size=` and reads rich structured output from the destination: all observed slot times, Book versus Notify controls, seating areas and calendar dates. This meets both conditions of `spec/cdp-tools.md` §2.1. It does not decode or issue the binary API requests itself.

The invocation rejects the old document and incomplete documents, requires the exact offering path, and requires two identical snapshots before returning. It checks offering type, accepted party sizes, venue-local date and the final date/size query. Empty-state messages are read only from the observed `.MuiAlert-message` containers, not arbitrary venue-authored body text. A bare Sold out chip is not an availability message.

Only table offerings (`RESERVATION`, `PRIX_FIXE`, `DEPOSIT`) are supported. Pickup/delivery windows and `GA_EVENT` tickets return `unsupported_offering`. `bookable` means the site displays Book; `notify_only` means Notify. Neither holds inventory or guarantees that a later booking will succeed. Calendar dates reflect only the shown two months and party size.

### Exact reservation preparation and action safety

1. Call `get_availability` with the intended venue, offering, date and party size.
2. On the resulting offering page, call `prepare_reservation` with those exact parameters, a venue-local `time`, and an exact `seating_area` when multiple areas are shown.
3. Preparation verifies the page identity, online-booking flag, party size, time zone, date and a visible, enabled Book control whose label names the exact offering and time. A changed page, missing time, ambiguous seating or Notify-only slot fails explicitly.
4. The result names the exact target and a public handoff URL. Seating is **not** encoded in the URL and must be selected manually in Tock. `inventory_held: false`, `account_verified: false` and `final_total: null` are deliberate: preparation does not inspect an account, open checkout or quote the final charge.

Preparation is a page-local read, with no navigation, fetch, click, form submission or state change. It can be called repeatedly without writing. It does not claim to verify a signed-in account or account-specific eligibility. The user must check the intended account, exact target, final total/currency, taxes, fees, supplements, cancellation/refund/no-show terms and card-hold/prepayment treatment in Tock before booking manually.

**Execution safety design:** booking, inventory holds, payment, cancellation and Notify submission are not shipped. The current runtime supplies no trusted human approval token or enforced review surface binding approval to an account, exact action, target, amount and terms. A model-supplied `confirmed`, `confirm` or similar flag is not approval; preparation rejects extra input properties before accessing the page. Preparation never invokes an execution tool automatically, and no unknown write outcome can trigger a retry because these tools issue no writes. The precise execution blocker is `trusted_human_approval_unavailable`. A future execution tool requires a separately reviewed, genuinely trusted approval path and observed action/postcondition handling.

## Outputs and trust boundary

- Successful observations (`ok`, `no_results`, `no_availability`, `prepared`) carry `observed_at`; errors contain only `status`, `error_kind` and `error_message`. Inventory changes continuously. Slot times and event dates are venue-local, without offsets. A `prepared` result is an observation, not a reservation or authorization.
- Pricing is the site's raw offering fields, not a computed total. `description` is its price summary; `price_type`, `amount_cents` and `per` are raw ticket fields, while `fees` retains raw `PERCENT` or `FLAT` entries. Zero ticket amounts can coexist with fees, minimum spend, holds or prepayment requirements. No tool adds fees or infers when a card is charged.
- Search and profile tools parse only required paths in the server-rendered JavaScript literal using a string-aware scanner; they never evaluate it. Only allowlisted fields are returned. JWT/CSRF/session values, payment keys, patron identities, raw state and signed/session URLs are not returned. Fixtures use fabricated data and test non-disclosure.
- Venue names, notices, descriptions and event prose are untrusted data, not instructions. No tool follows embedded instructions.
- Errors distinguish invalid input, wrong page, not found, challenges, rate limits, changed/unreadable state and site errors. Preparation additionally distinguishes booking disabled, missing availability, Notify-only and ambiguous seating. No denial is turned into an empty successful result.

## URL patterns

Every tool matches `https://www.exploretock.com/*`. Consumer pages and first-party requests use `www`; the apex redirects there. Page-local requests require that same origin. Tools are not attached to support hosts, third-party restaurant widgets or Resy, and cannot be discovered on an unrelated domain. Page tools return `wrong_page` if invoked directly elsewhere. Preparation intentionally requires the exact offering document and returns `wrong_page` from home, login or another offering rather than navigating and losing its result.

## Site quirks

- Embedded state contains `undefined` and functions, not valid JSON. The scanner cuts only requested paths and normalizes undefined outside strings. Unreadable state fails closed.
- City slugs can contain underscores. Unknown city slugs can still receive HTTP 200, so the resolved metro is checked.
- Alias venue paths can return a different venue; these are rejected with its canonical slug rather than silently substituting it.
- Tock rewrites invalid dates/party sizes and canonicalizes offering slugs. Availability checks the final date/size and offering identity rather than trusting navigation alone.
- Slot labels can use 12-hour or 24-hour clocks. Both are supported. A date before today at the venue is rejected; discovery tools skip the additional zone check when no usable time zone is supplied, while preparation requires one.
- Public pages may return a bot challenge or a rate limit. Tools report the failure; they do not solve challenges, change fingerprints or bypass restrictions.

## Known limitations

- No account reservations, saved lists, favorites or Notify writes. Earlier account discovery observed only empty lists; populated record schemas and account identity guards were not established. No live data was created to populate them, and an expiring account session is not replaced by another account.
- No purchase, reservation, hold, checkout, cancellation, transfer, private-dining request, gift-card action or account enrollment. The approval blocker above is not waived by a preparation result.
- Events are searched and their published schedules read, but event-ticket inventory/preparation, pickup and delivery are not supported by table tools.
- Search/venue outputs have the stated caps. Recurrence rules are not expanded. Output pricing does not capture every checkout condition or calculate a final total. Venue website/menu links with credentials, queries or fragments are omitted rather than returning potentially signed/session-bearing URLs.
- DOM availability depends on current `data-testid` elements and the alert container; a redesign fails with `site_error` or `site_changed`. No recognized slot/message after 45 seconds is a site error, not proof of no inventory.
- Preparation only reads the current page. A matching query/path and visible control are public-page observations, not an account-specific eligibility check. Refresh availability when time passes or the page changes.
- Signed-in-only inventory, member presales, unlock codes, genuine HTTP 429 and genuine challenge resolution are untested. Fixtures cover blocked/error branches without bypassing protections or consuming paid quota.

## QA

The fabricated fixture suites cover schemas, malformed input before interaction, forbidden write helpers/endpoints, unrelated origins, exact offering/date/party/seating prerequisites, extra approval flags, Notify-only and disabled controls, duplicate rows, pricing, event schedules, pagination/bounds, token non-disclosure and stale navigation/readiness.

Prior review fixes are preserved; the final navigation fix and the new event/preparation source require fresh independent review. All tools remain `draft` pending final-source sign-off. Current independent QA results and dated live evidence will be recorded here after that review. Live mutation success is not claimed from fixtures.

Public live development checks on 2026-09-30 observed EVENT search, published event schedules and dedicated sold-out/not-open alert containers. No Book, Notify, favorite, checkout or account control was clicked. Kernel registration/invocation and local extension verification are recorded separately; no parity is inferred from fixtures.
