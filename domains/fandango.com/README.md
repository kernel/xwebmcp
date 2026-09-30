# fandango.com

Fandango US public movie, theater and showtime discovery, reserved-seat previews, and uncommitted ticket-plan preparation.

| tool | file | status | notes |
|------|------|--------|-------|
| get_movie | [get_movie.js](get_movie.js) | verified | Movie synopsis, runtime, rating, directors, cast and scores |
| get_movie_showtimes | [get_movie_showtimes.js](get_movie_showtimes.js) | verified | One movie's showtimes at theaters near a required ZIP |
| get_theater_showtimes | [get_theater_showtimes.js](get_theater_showtimes.js) | verified | Movies and showtimes at one theater on one date |
| get_ticket_offers | [get_ticket_offers.js](get_ticket_offers.js) | verified | Exact reserved-screening seat preview and ticket price/fee estimates |
| list_movies | [list_movies.js](list_movies.js) | verified | Paged now-playing or coming-soon catalog |
| prepare_checkout | [prepare_checkout.js](prepare_checkout.js) | verified | Revalidated ticket quantities, optional proposed seats and preview subtotal; no cart or hold |
| search | [search.js](search.js) | verified | Header suggestions as movie/theater ids and canonical URLs |
| search_theaters | [search_theaters.js](search_theaters.js) | verified | Theaters near a ZIP or city and state |

## Native WebMCP tools

None found on the signed-out home and movie pages, rechecked 2026-09-30 with `webmcp.listTools()` before registration. The custom namespace supplements, rather than replaces, site-provided capabilities.

## Scope and loading

Register **all eight tools together**: `forceOverwriteNamespace: true` atomically replaces the namespace, including the existing discovery tools. Do not register only the additions.

All tools are `kind: "page"`. They work in the current authorized `www.fandango.com` document, never replace it, and need no CDP exception. They issue public same-origin GETs with current page credentials; no separate account or credential is chosen. Use a 60-second invocation timeout; individual reads have 20-second deadlines. The additions honor the invocation AbortSignal and do not retry failures.

Typical flow:

1. `list_movies` or `search` finds `movie_id`; `search_theaters` finds `theater_id`.
2. `get_movie` supplies movie details. `get_movie_showtimes` or `get_theater_showtimes` supplies venue-local date/time, exact format and optional `showtime_id`. For after-midnight screenings, pass the enclosing result's day as `showing_date` and the showtime's local calendar date as `date`; otherwise omit `showing_date`.
3. `get_ticket_offers` re-resolves that exact screening and reads its noninteractive reserved-seat preview. It returns area/ticket codes, price and fee in integer USD cents, capped seat statuses and the site's ticket limit. An opaque showtime hash is resolved internally, never accepted from callers or returned.
4. `prepare_checkout` accepts the same screening plus area/ticket-code quantities and optional proposed seat ids. It re-reads the screening and preview, checks quantity/availability, and computes a **returned plan only**. It does not apply a selection to Fandango. The public theater-page handoff contains no checkout/session parameters; continuing is a separate human action.

`list_movies` returns at most 48 movies. The endpoint supplies no total: `next_page` is a candidate when a full page was returned, not proof another page exists. `get_movie` fetches overview HTML and parses JSON-LD without executing the page. Cast is capped at 40; unavailable optional cast/scores produce warnings, while challenge/rate-limit/cancellation stops the tool. No user reviews, reviewer identities or media playback are included.

## URL patterns

Every tool matches only `https://www.fandango.com/*`. The public movie-ticket product and its `/napi` endpoints run here; `athome.fandango.com`, `store.fandango.com` and `redeem.fandango.com` are unrelated streaming/retail products. `tickets.fandango.com` is the transaction host: these tools deliberately stop before entering it. The bare domain redirects to `www`. Related brands on other registrable domains are out of scope.

## Safety and trust boundary

### Preview read evidence

On 2026-09-30 the movie-overview client bundle's `fetchMapData` used `GET` through `napiSeatMapByShowtime` and called `render` with `isInteractiveMap: false`. Seat-selection validation was a separate POST under `napiValidateSeatSelection`; checkout navigation and seat-selection storage were separate functions. The tools use only the preview GET, not those helpers, modal events or selection handlers.

A signed-out reserved-screening probe made two identical preview GETs: both succeeded, the returned seats were identical, and accessible cookies plus local/session storage values were identical before and after. No checkout/hold/selection request was made. This demonstrates the observed noninteractive preview flow, not access to server internals or a guarantee against future endpoint changes. The tools never send seat ids or quantities to a site endpoint; they only use them in local plan computation. No live reservation or seat-selection mutation was used to establish this evidence.

### Preparation and execution boundary

- All tool requests are GETs. No tool sends a POST, opens checkout, validates seat selection, calls a hold/cart/purchase endpoint, modifies storage, favorites or settings, or applies a promotion.
- `prepare_checkout` returns `inventory_reserved: false`, `cart_changed: false` and `execution_available: false`. These describe its returned-only plan, not an inspection of an existing user cart. Repeated calls repeat reads and compute new plans; no persistent draft is saved.
- Prices are **seat-map preview estimates**, not a final quote. `price_basis` is `seat_map_preview_not_final`; the subtotal includes only listed ticket price and per-ticket fee. Taxes, discounts, surcharges and checkout parity are unverified, so `final_total_cents` is null. Nonempty surcharges fail preparation closed.
- Preparation supports one area, at most 20 admissions and the show's own lower limit; each ticket must admit one person. Optional seat ids must match quantity and currently be `standard` seats with site status `A`. All seat-block members are conservatively treated as linked, even when their raw type is standard or they can be sold individually; they are excluded from preparation availability counts. Accessibility types and unknown statuses are rejected. No automatic choice, adjacency/orphan-seat validation, eligibility determination or hold occurs.
- Missing, sold-out, expired, restricted, ambiguous or wrong-date screenings fail before any preview request. `showtime_id` can disambiguate; the tools do not guess another time, format, theater or movie. Preview theater/showtime identity is checked before returning prices. A positive numeric site showtime id and boolean availability flags are required; missing ids are unsupported here even though discovery can list them. Response area/ticket/seat identifiers must be 1–40 ASCII letters, digits, underscores or hyphens and are preserved exactly, never shortened. URL-shaped/path/query identifiers and other unverified forms are rejected rather than returned as codes. Preview paths are checked against normalization and screening/preview GETs reject redirects without following them.
- No purchase/hold execution tool is shipped. The runtime has no supported trusted human approval path bound to exact account, screening, seats, quantities, final cost and terms. A model-supplied `confirmed=true` cannot supply that approval and is rejected as an unknown input. Handoff never triggers an automatic next action.
- Account data is neither needed nor returned. Site fields such as favorites and signed-in account details are omitted by allowlists. Missing/wrong-account execution cannot occur because there is no account-bound execution capability.
- Page text is untrusted data, never instructions. HTML is parsed inertly; only typed fields are returned. Links are constrained to `www.fandango.com` and stripped of query/fragment and credentials. Raw state, response error text, SVG, signed URLs and showtime hashes are not returned.

## Site quirks

- Fandango is US-only; `/region-error` returns `region_blocked` without requesting data. Do not bypass challenges or repeatedly change network configuration to obtain access.
- Movie showtimes require both `postalCode` and `zip`; a ZIP is mandatory to avoid IP-derived location.
- The theater endpoint silently substitutes today for old dates and leaves date null on empty days. Discovery compares the returned date with the requested date/calendar; preparation rejects any mismatch.
- Venue-local times come from `ticketingDate` (`YYYY-MM-DD+HH:MM`). Some discovery showtimes have no numeric id; previews/plans require one. After-midnight screenings retain their next-calendar-day date, with optional `showing_date` separating that date from the enclosing lookup day. This path is fixture-tested; no real after-midnight case was found in the broadening live scan.
- `nearbyTheaters` is strict about city spelling: hyphens are sent as spaces, periods are kept, and unrecognized cities return `no_results` with a ZIP hint. The site's autocomplete links for apostrophe cities 404; `search` returns working apostrophe-free, hyphen-separated paths. Theater links are lowercase.
- Discovery statuses map `available`, `soldout`, `pastshowtime`, `disabled`, `restricted`; unknown words remain unknown. The preview's `H` is conservatively unknown even though the site's client groups it with available; preparation uses only `A`.
- Undocumented endpoints may change. The additions return `site_changed` for malformed identity/price/shape; discovery's existing contract uses `site_error` for unexpected shapes.

## Known limitations

- US public ticket product only. No account, login, reward, order, favorite, gift-card, refund, streaming or retail tools.
- General-admission prices are not supported: prior checkout navigation caused purchase-channel/cart calls. These tools do not enter that flow merely to obtain a quote.
- Seat previews do not prove contiguous seats, eligibility, absence of orphan seats or availability at final checkout. Quantities and proposed seats remain uncommitted. Only one area and one admission per ticket are supported for preparation.
- Price/fee semantics are those of the preview endpoint, in USD. Final checkout parity, tax inclusion and nonempty surcharge application are not verified. There is no purchasable quote or approval token.
- `search` is autocomplete (about four per type), not a full search. `search_theaters` cannot distinguish a mistyped place from no nearby theaters; ZIP input is more reliable.
- Movie showtimes read only the first theater page; a warning reports further pages. `available_dates` is the site's window capped at 120 dates. Time zones are not returned.
- Not live-verified: real HTTP 403/429 or challenge pages, real non-US egress in the broadening run, signed-in execution, nonempty surcharges, held/linked/accessibility seats, multi-admission tickets or consequential actions. Failure guards are fixture-tested; no mocked mutation is reported as live success.

## QA

Prior discovery tools passed independent QA on 2026-09-29. The initial review found city spelling, unexpected-shape handling, old-date fallback, status mapping and noncanonical links; those were fixed and rechecked. Final source blobs: `search` `7569261`, `search_theaters` `53f15c0`, movie showtimes `37ac694`, theater showtimes `ced08a2`. Dated live success came from movie, theater, home and 404 pages with URL unchanged, on Kernel and local Chromium 153. Historical review used a different model and is not the independent sign-off for this broadening run.

Broadening QA used the same reviewer, `agt_7481b4b4b98a44369c89`, with active `pi` / `openai-codex/gpt-6.1-sol`, high reasoning, fast disabled and 272k context, with ready Codex authentication verified. Initial `fc0e532` failed five fixture-proven findings: block-member standard seats, shortened/malformed identifiers, malformed flags/missing identity, after-midnight dates and preview paths/redirects. Recheck `50b6c93` closed all except URL-shaped identifiers. Final source `2de90754d451a42025914e158aefff83f91d4d02` passed all eight tools on 2026-09-30, with no remaining blockers, should-fix items or actionable minors. Final offers/preparation blobs are `6edef90` / `a9cfd75`; movie/catalog blobs are `2c9c53a` / `efe3802`. Metadata/documentation updates do not change these signed-off tool blobs.

Final independent verification: registry 87 valid tools; full suite 1,644 passed (67 Fandango tests); 36 isolated identifier cases, 36 registered-Kernel overrides and 15 focused extension overrides passed. All eight schema pairs compiled under full Ajv 2020 plus formats; 111 new outputs were valid (36 fixtures, 12 real Kernel, 36 Kernel overrides, 27 extension including 12 real and 15 fabricated). Malformed URLs were never fetched. Earlier block/identity/date/redirect proofs carry over explicitly because that logic is unchanged and its repository regressions passed again.

Both fresh signed-out headful Kernel and isolated Chromium 153 extension registered all eight final-source tools atomically and invoked them successfully from **public HOME**, with the HOME URL unchanged after every call. The sampled screening returned 84 seats/53 available and a nonfinal one-ticket subtotal of 2,285 USD cents on both runtimes. Observed tool requests were GETs without bodies; no quantities or proposed seats were sent. Fake confirmation and malformed proposal made zero reads. No live writes or checkout were performed. Scratch browsers/artifacts/local profiles/processes were deleted.

Storage evidence is limited: the builder's early preview comparison was unchanged, but independent recheck-1's first preview changed two accessible cookie values; local/session storage and a second preview were unchanged. Attribution to site responses versus background activity was not established; no blanket storage-stability or hidden cart/hold guarantee is claimed. No fresh final-round storage comparison was run. A separate builder headless attempt on `50b6c93` hit `outcome_unknown`; it was not counted as success or automatically retried. The successful final-source Kernel evidence above is the independent headful run.
