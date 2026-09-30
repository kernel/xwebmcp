# opentable.com

OpenTable US diner tools on `https://www.opentable.com`. Public restaurant reads, account summary and Favorites reads, and non-executing exact reservation preparation.

| tool | file | status | notes |
|------|------|--------|-------|
| get_account_summary | [get_account_summary.js](get_account_summary.js) | draft | Authorized dining points, eligibility and reservation/invitation counts on the current dashboard page. No private item details. |
| get_availability | [get_availability.js](get_availability.js) | draft | Up to 50 standard slots within 120 minutes of a restaurant-local date/time. No slot selection or hold. |
| get_restaurant | [get_restaurant.js](get_restaurant.js) | draft | Public profile, ratings, hours, features and optional published menus. Arrays capped at 50, menus at 100 items, output at 200 KB. |
| get_reviews | [get_reviews.js](get_reviews.js) | draft | One page of 10 reviews, newest dining date first, without diner identity. |
| list_saved_restaurants | [list_saved_restaurants.js](list_saved_restaurants.js) | draft | Favorites restaurant IDs, 50 per page, fresh account validation before and after the read. |
| prepare_reservation | [prepare_reservation.js](prepare_reservation.js) | draft | Exact date/time/party/seating preparation with public profile handoff; no reservation or inventory hold. |
| search_restaurants | [search_restaurants.js](search_restaurants.js) | draft | Free-text search with optional date/time/party, up to 50 per page; does not prove availability. |

Register **all seven files together** when replacing the `opentable.com` namespace. `forceOverwriteNamespace` replaces the entire namespace atomically, not a single tool.

## Native WebMCP tools

None found on public home, search or restaurant profile pages on 2026-09-29. Rechecked on a public restaurant profile and the authorized account home on 2026-09-30 before adding custom tools: `webmcp.listTools()` returned no tools. Concierge is a chat widget, not a WebMCP registration; no messages were sent.

## Scope and loading

Every tool is `kind: "page"`: it issues same-origin reads and returns without navigation. The registering document survives. No CDP exception is needed. Calls are serial per tab; use a 60-second invocation deadline and avoid rapid repeated content requests. All seven honor cancellation and pass the signal through to fetch.

- `search_restaurants` fetches `/s?term=...` with optional `dateTime`, `covers`, `page`, then parses `windowVariables.__INITIAL_STATE__.multiSearch` from the JSON state script. Include a place in the query, such as `pizza Chicago`; otherwise the site uses approximate browser location. Results are not bookable slots.
- `get_restaurant` and `get_reviews` fetch `/restaurant/profile/<id>` or an allowlisted `/r/<slug>` path. Legacy `/<slug>` links are ambiguous with account routes and are rejected before interaction; use the restaurant ID returned by search. Query and fragment are ignored. Review pagination adds `page=N`; the returned page must match because the site falls back to page 1 beyond the end. The default newest order is by dining date, not submission date.
- `get_availability` fetches the requested public profile document with date/time/party parameters. It parses the current query credential and profile availability token, reads the first-party `restprofilepage` module and static imports to find the current `RestaurantsAvailability` **query** document ID, then sends the observed same-origin `/dapi/fe/gql?optype=query&opname=RestaurantsAvailability` POST. Source text is inspected, never executed. Only first-party `/static/cfe/<version>/js/` entry/chunk paths are fetched, with no redirects, at most 260 modules, 2 MB per module and 20 MB total text. The profile is capped at 2 MB and query response at 1 MB. Unknown formats fail explicitly; no static deployment hash is hardcoded. No slot hash/token is returned.
- Availability requests use `requireTypes: ["Standard"]`, no privileged-access programs, no loyalty redemptions, zero forward days, and a bounded minute window. Times are computed from the requested restaurant-local time plus the observed minute offset, never interpreted as UTC. Cross-midnight slots are omitted. A mandatory experience is flagged; experience-only inventory is omitted.
- `get_account_summary` reads `/user/dining-dashboard`, checks fresh authenticated state and `expected_account_email`, then returns dining points and container counts only. It never opens an unread notification or invitation. `past_reservation_count_on_page` and `past_invitation_count_on_page` are not lifetime totals; `has_more_past` only indicates another server page. Reservation item shapes were not observed and are not fabricated.
- `list_saved_restaurants` first validates the same fresh dashboard identity, reads `/user/favorites` and its current first-party module query ID, and runs the observed `UserWishlist` query with `wishlistName: "Favorites", gpid: 0` (the site's own session-bound query). Its public module selection is `userWishlist.restaurants.rid`. It validates the account again before releasing IDs, drops duplicates and pages locally at 50. A null wishlist was observed on the empty authorized account. Missing fields, query errors or identity changes are errors, not empty success. Restaurant details are obtained separately through `get_restaurant`.

All returned site text is untrusted data, not instructions. Outputs are field allowlists: no email, phone/account identity, Sift data, profile names, hashes, session URLs, maps API key, query credentials, slot tokens or raw page state are returned by the new account/availability tools. The account email input is not echoed; callers should treat invocation inputs as private.

## Reservation action safety

`prepare_reservation` repeats the public inventory read and requires an **exact** requested time and seating type. It returns `unavailable` rather than selecting a nearby time. Mandatory experiences are gated; unknown seating-specific mandatory fields fail explicitly. Preparation scans the entire returned day up to 200 slots, independent of the availability display cap, and fails on larger inventories rather than reporting an incomplete exact match. It returns only a public profile URL with date/time/party parameters; it does not open that URL or click any slot.

`prepared` means an exact standard slot was observed, not reserved or held. The result explicitly says `account_verified: false`, `terms_status: "not_checked"`, `hold_created: false`, `reservation_created: false`, and `execution_blocker: "trusted_human_approval_unavailable"`. Availability does not establish deposits, prices, card requirements, cancellation or no-show fees. A human must verify the intended account and restaurant's current terms on the site **before selecting a slot**, since selecting a slot can create an inventory hold.

There are no book, hold, cancel, modify or notify execution tools. The current runtime does not provide a trusted exact-action approval path. A model-provided `confirmed: true` is rejected as an unknown input; annotations and descriptions are not approval enforcement. Preparation never automatically executes or retries a write. Favorite save/unsave is not shipped: no grounded final write mechanism or authorized live mutation test was obtained. Favorites reads do not change the list.

## URL patterns

All tools match only `https://www.opentable.com/*`. Other subdomains are unrelated products: `help.` is help content, `restaurant.` is business marketing, `press.` and `dev.` are separate surfaces. The public profiles and account documents read here are same-origin only on `www`. Regional registrable domains such as `opentable.co.uk` and `opentable.ca` are out of scope. Bare-domain redirects are not verified.

## Site quirks

- Akamai can return HTTP 403, an Access Denied title, or HTTP 200 with challenge markers `sec-if-cpt-container` / `sec-bc-tile-parent`. Tools report `challenge` when the fetched document lacks the legitimate state script; marker words inside valid state are not challenges. HTTP 403 is always a challenge; HTTP 429 is `rate_limited`. No automatic retries or bypass loops.
- Pages expose a server-rendered JSON state script even though availability and Favorites load separately. Client-side account pages can have signed-out SSR snapshots; the fresh authenticated dining dashboard, not a visible header button, is the account identity gate.
- A missing state script/query module is `site_changed`, a missing restaurant is `not_found` where observed, and query errors are not converted into no-results.
- Published menu prices are passed through as listed, often strings or null, without per-item currency. Menu links have query/fragment removed; no external menu is fetched.

## Known limitations

- Availability is standard inventory only, same requested date, no privileged programs, no experience-only slots, no cross-midnight or multi-day results. Points are reported inventory values, not verified eligibility. Date validation uses the current UTC calendar date as the non-past floor, which can reject a restaurant-local previous date near midnight.
- Module parsing is bounded and tied to the observed current first-party bundle format. A deployment changing that format fails `site_changed`. Static-module requests can be numerous on a cold cache; the same-origin document's current credentials are the only credentials used.
- Account reads require an already authorized signed-in session and the exact expected email. Populated reservations, invitation contents, rewards tiers/redemption and populated Favorites were not live observed. Only container counts are returned for reservations. Populated Favorites IDs are covered with fabricated fixtures, not live account mutation.
- Search supports no cuisine/price/neighborhood/sort filters and at most 100 pages. Date/time only steer ranking/filtering; search is not availability. Past dates remain accepted for search.
- Profile arrays are capped at 50 each; published menus at 100 items. Outputs exceeding 200,000 UTF-8 bytes fail `site_changed` rather than relying on runtime limits. Calendar-impossible review timestamps become null. Review text is capped at 3,000 characters; reviewer identities, photos and restaurant reply text are omitted.
- No login automation, saved-list writes, account changes, payments, booking/holds, cancellation, modification, notifications or review submission. No live reservation or hold tests were performed.
- Bot protection and rate limits are environment dependent. No promise of runtime parity is made for cases not actually run on both Kernel and the local extension.

## QA

The original three-tool source passed historical independent public QA on 2026-09-29 at revision `49f3289`. That evidence does **not** approve this revised source. Prior findings reviewed before changes included an unsafe profile URL allowlist (already fixed), uncapped profile arrays (now capped), calendar-impossible timestamps (now rejected), and test-strength gaps. All seven current entries are initially draft pending fresh independent QA.

Author checks on 2026-09-30, revision `52d625f` (before subsequent review fixes):

- Kernel: all seven definitions registered together and discovered once each. From the public home page, availability returned five standard slots; exact preparation returned `prepared` without navigation or any slot/hold/booking request. A party above the restaurant's limit returned `no_results` with `AboveMaxPartySize`.
- Authorized account, from its home page: account summary returned zero reservation/invitation counts and current points; Favorites returned `no_results` with total 0. No account item or token was returned, and no list or account state was changed. The empty account is not live evidence for populated item shapes.
- Automated: registry validator passed (86 tools); repository and site test results are recorded per revision below. Go tests and all 14 extension unit tests passed. Fixtures cover malformed inputs before requests, wrong host/account, missing login, cancellation, query errors, namespace membership, strict query-only discovery, output bounds, populated Favorites, exact preparation, and the absence of execution tools.

Account access used only the already authorized session, without renewing its expiry or making account changes. Temporary public browsers are separate and deleted after testing.

### Independent revision review — 2026-09-30

Revision `52d625f`: **FAIL**, 1610 repository tests, 33 site test blocks, 14 extension unit tests and Go tests passed. An independent reviewer completed 153 additional Node-fixture probes and schema-validated 153 fixture, seven Kernel-live and eight extension-live outputs. Findings: exact preparation could miss a slot after the 50-slot display cap; the retained three tools ignored cancellation; malformed seating-specific mandatory data was treated as optional; marker words inside valid state could be misclassified as a challenge. These are fixed in the subsequent source, pending a final-source recheck.

- Kernel live: all seven discovered; from `/private-dining`, availability, exact preparation, profile/menu, reviews and search succeeded, plus unknown-ID and out-of-range errors. No navigation or writes. A first browser became renderer-unresponsive and returned `outcome_unknown`; it was not automatically retried. A separate public browser completed these calls. Namespace replacement was accepted; discovery on the unresponsive document was inconclusive.
- Extension live: all seven discovered together; availability, preparation, party-size no-results, profile/menu, reviews, search and two failure cases succeeded without navigation or writes. Forced namespace replacement end-to-end was not completed in this pass.
- Account success, populated Favorites, wrong-account and identity-change paths were independent **Node-fixture-only**. No extension account fixture matrix or independent live account success was obtained in this pass. Author live account evidence was empty-only and is not evidence for populated item schemas.
- Inventory reads traversed 173 static modules per invocation, within the bound. The three inventory POSTs in the extension were read queries.
- Both owned public browsers and the isolated extension profile/processes were cleaned up. No original account browser was used by the reviewer.

Final-source review is pending. Historical approvals and this intermediate live evidence do not approve changed source. All seven registry statuses remain draft until the final recheck.
