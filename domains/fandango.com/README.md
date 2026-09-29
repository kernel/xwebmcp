# fandango.com

Public read tools for Fandango US (https://www.fandango.com): search, theaters near a place, and showtimes by movie or by theater. All four are read-only, work signed out and never touch tickets, seats, prices, carts, favorites or the account.

| tool | file | status | notes |
|------|------|--------|-------|
| get_movie_showtimes | [get_movie_showtimes.js](get_movie_showtimes.js) | verified | One movie's showtimes on one local date at theaters near a required ZIP, grouped by theater and format, with a status per showtime |
| get_theater_showtimes | [get_theater_showtimes.js](get_theater_showtimes.js) | verified | Every movie and showtime at one theater on one local date, plus theater details and the dates that have showtimes |
| search | [search.js](search.js) | verified | Header-search suggestions (movies, theaters, cities, people) as ids and canonical URLs; about four per type |
| search_theaters | [search_theaters.js](search_theaters.js) | verified | Theaters near a ZIP or city and state with distance, chain, amenities and whether tickets are sold online |

## Native WebMCP tools

None found (checked 2026-09-29 with `webmcp.listTools()` on the homepage, signed out, and on the FanClub page, signed in). `document.modelContext` exists with zero registered tools and `navigator.modelContext` is undefined, so the custom namespace `fandango.com` does not overlap with anything the site registers.

## Scope and loading

Register all four together, because `forceOverwriteNamespace: true` replaces the whole namespace:

```javascript
const fs = await import("node:fs");
const read = name => fs.readFileSync(`domains/fandango.com/${name}.js`, "utf8");
const tools = ["search", "search_theaters", "get_movie_showtimes", "get_theater_showtimes"].flatMap(name => eval(read(name)));
await webmcp.addCustomTools({ namespace: "fandango.com", tools, forceOverwriteNamespace: true });
```

All four are `kind: "page"`: each runs in the current `www.fandango.com` document, issues same-origin `fetch` reads against the site's own `/napi/*` JSON endpoints with the page's cookies, and never navigates. A default timeout is enough (live calls took about 1 s; each request is also limited to 20 s).

A typical chain: `search` (or `search_theaters` for a ZIP) finds a `movie_id` or `theater_id`; `get_movie_showtimes` (movie plus ZIP) or `get_theater_showtimes` (theater) lists showtimes.

- **search** calls `/napi/home/autocompleteDesktopSearch?search=<text>`, the request the site's own search box script makes for its suggestion list. The site returns about four items per type, so this is not the full results page (`search_url` is). Ids are parsed from the item links (`…-<movie id>/movie-overview`, `…-<THEATERID>/theater-page`); the ids in the raw response are opaque and unused.
- **search_theaters** calls `/napi/nearbyTheaters?limit=<n>&zipCode=<zip>` (the request the theater page makes for its nearby list) or the same path with `city` and `state`. The site returns an empty list for an unknown place without an error, so `no_results` cannot tell a mistyped ZIP from a place with no theaters.
- **get_theater_showtimes** calls `/napi/theaterMovieShowtimes/<THEATERID>` (with `startDate` when a date is given) and `/napi/theaterCalendar/<THEATERID>` in parallel, as the theater page does. `chainCode` is sent empty; live checks returned the same showtimes as the page's `chainCode=AMC`.
- **get_movie_showtimes** calls `/napi/theaterShowtimeGroupings/<movie id>/<date>` with `postalCode` and `zip` both set to the ZIP, the request the movie page makes, and `/napi/movieCalendar/movie-<movie id>?postalCode=<zip>&zip=<zip>` for the site's current showing day (when no date is given) and for `available_dates`. The title segment of the calendar path is not used by the site (a placeholder and the real slug returned the same dates), so a fixed placeholder is used.

Outputs:

- Showtimes carry `local_date` and `local_time` parsed from the site's `ticketingDate` (`YYYY-MM-DD+HH:MM`, venue-local), the printed `time_text` (for example `7:00p`), `showtime_id` when the site gives one (it omits it for some theaters), and a `status` mapped from the site's `type`: `available`, `sold_out` (`soldout`), `past` (`pastshowtime`, or `expired`), `unavailable` (`disabled`) or `restricted`, neither with a reason from the site, or `unknown` for any other word. `site_status` keeps the site's own word.
- Screenings group showtimes by the site's format heading (`Standard`, `3D`, `IMAX`, …) and amenity group; `amenities` are the names the site attaches (reserved seating, closed caption, recliners, and policy notes such as "No passes").
- `distance_miles` is what the site reports from the ZIP or city.
- `search` returns theater and city links in the form that resolves without a redirect (theater paths in lower case, `+` in city paths as `-`, and apostrophes dropped from city paths because the site's own link for such names is a 404), the same theater URLs `search_theaters` returns. `search_theaters` echoes the normalized input in `place` (hyphens kept, state in upper case), not the spelling it sent to the site.
- Every result carries `observed_at`. Showtimes and sold-out flags change during the day.
- Output is bounded: `limit` on theaters (movie showtimes, at most 40) or movies (theater showtimes, at most 60), `total_*` and `truncated` report what was cut, and lists such as `available_dates` are capped.
- The ticketing link and hash the site attaches to each showtime (which point into the ticket-selection site) are not returned, and no tool opens them. Movie and theater URLs are rebuilt as `https://www.fandango.com/<path>` and links that leave the site are dropped.

## URL patterns

All four tools match only `https://www.fandango.com/*`, not the default `https://fandango.com/*` and `https://*.fandango.com/*`. The other hosts under the registrable domain are separate products: `tickets.fandango.com` is the ticket-selection and checkout funnel, `athome.fandango.com` is the Fandango at Home streaming store (a different app backed by `api.vudu.com`), and `store.fandango.com` and `redeem.fandango.com` sell merchandise and bundles. The `/napi/*` endpoints the tools call are same-origin on `www.fandango.com`, so a page tool on those hosts could not work, and none of the tools should be listed on checkout pages. The bare `fandango.com` redirects to `www`. Related brands on other registrable domains (`fandangomovietickets.com`, `movietickets.com`, `flixster.com`, `fandangostream.com`) are out of scope.

## Safety and trust boundary

- The tools only read: every request is a `GET` to `/napi/*` on the current origin with no body and no credentials override. No tool sends a `POST`, opens a ticketing link, touches the site's cart, purchase-channel or `/snapi` account endpoints, reads a seat map, or reads or sets favorites. The tests assert this and search the source for those surfaces.
- Signed-in state is neither required nor used: no favorite, account or order data is read or returned, even when the tab is signed in (the site adds fields such as `isFavorite` to signed-in payloads; the allowlisted outputs drop them).
- Page data is untrusted. Only the fields listed above are copied, strings are not evaluated, and site-relative links are accepted only when they resolve to `https://www.fandango.com`.
- An `available` status does not guarantee tickets can be bought: prices, fees and seat availability are outside these tools.

## Site quirks

- **US only.** From a non-US network location the site redirects pages to `https://www.fandango.com/region-error` ("Fandango is not available outside the United States"). That page is on `www`, so the tools are registered there and return `region_blocked` without a request. A Kernel browser needs a US proxy; the default stealth exit was observed once landing on that page and once not.
- **Location defaults to the visitor's network address.** The movie page picks its ZIP from the network location, so `get_movie_showtimes` requires an explicit ZIP.
- **Parameter traps (observed).** `theaterShowtimeGroupings` needs both `postalCode` and `zip` (with only `postalCode` it answers "unable to retrieve movie showtimes"); an invalid `startDate` on `theaterMovieShowtimes` silently becomes today, which is why dates are validated before any request; a date without showtimes returns HTTP 200 with an empty movie list and `date: null`.
- **Uneven errors.** An unknown theater, unknown ZIP or unknown movie answer HTTP 200 with `error: true` (theater showtimes), `hasShowtimes: false` (movie showtimes) or an empty list (`nearbyTheaters` with a ZIP); `nearbyTheaters` with a city it does not recognize answers HTTP 404 with an error object. The tools map these to `theater_not_found`, `not_found` or `no_results`, and treat any other unexpected shape as `site_error`.
- **City spelling is strict.** `nearbyTheaters` matched `Winston Salem` and `Wilkes Barre` but not the hyphenated forms, matched `St. Louis` but not `St Louis`, and did not match `Coeur d'Alene` in any spelling tried. `search_theaters` sends hyphens as spaces, keeps periods and returns `no_results` (with a hint to use a ZIP) when the site answers 404.
- **Old dates fall back to today.** A date about four weeks back or more (checked: 2026-08-15 on 2026-09-29; 2026-09-01 was still answered as empty) makes both showtime endpoints return the current day's showtimes instead. The tools compare the date in the answer with the requested one and, when the site's calendar does not list the requested date, return `no_showtimes` with `available_dates`.
- **Movie showtimes use a ZIP only.** The endpoint was only observed with a ZIP; there is no city form.
- **Field differences.** `dateLocal`/`dateUtc` appear only in the movie-showtimes endpoint, so the tools parse `ticketingDate`, which both endpoints carry. It matched `dateLocal` on all 511 showtimes sampled at first, and a later check saw showtimes after midnight (12:15a to 4:30a for a far-off release) carry the next calendar date with the right time. The site omits the showtime `id` for some theaters (all 77 showtimes at one AMC theater on one day at first, later 4 of 229 for one movie in New York City), so `showtime_id` can be null.
- **Output shape through the Kernel API.** The Kernel API returned some outputs as a JSON string instead of an object (seen for larger outputs and for outputs with non-ASCII text); parse it when `typeof output === "string"`. This is runtime behavior, not tool code.
- **Payload size.** One theater day is about 140 KB and one movie in New York City about 190 KB before the tools trim it; the largest tool output seen was about 58 KB.
- **No stability guarantee.** `/napi/*` is an undocumented first-party API. A changed shape returns `site_error` rather than a partial success.

## Known limitations

- US site only (`en-us`, USD not exposed), and only public read data: no seat maps, prices, fees, seat availability, ticket links, favorites, orders, rewards or account tools. Showtimes for streaming (`athome.fandango.com`), FanStore and related brands are out of scope.
- `search` returns the site's suggestion list (about four items per type). It is prefix-style matching on names, so a city plus a chain name can return nothing.
- `search_theaters` cannot distinguish a mistyped ZIP or city from a place with no theaters, and the site does not resolve some real cities (apostrophes, some spellings), so the ZIP form is the reliable one. Its city and state form was observed only through direct requests, not through a page-initiated call. It returns no total or truncation flag; the site returned 27 theaters for `limit=50` around one ZIP, so a result shorter than `limit` does not prove the list is complete.
- `get_movie_showtimes` requires a ZIP, reads only the first page of theaters the site returns (a warning appears when the site reports more pages; the pagination parameter was never observed) and returns no movie title, because that endpoint does not carry one. An unknown movie id and an unknown ZIP are indistinguishable (`not_found`), as are those and a movie with no showtimes near the ZIP when no date is given.
- The `status` values come from five site words seen live (`available`, `soldout`, `pastshowtime`, `disabled`, `restricted`); the site gives no reason for `disabled` or `restricted` (a `restricted` showtime had no message, and QA saw a theater page render a buy link for one), so neither is mapped to available or unavailable. Any other word maps to `unknown`.
- `available_dates` is the site's window, capped at 120 dates: about 10 dates for a movie near a ZIP and between 76 and 98 for a theater.
- Local times come from `ticketingDate` (venue-local, 24-hour). Time zones are not returned.
- Not live-verified: HTTP 403 and 429 responses, a bot-protection page, the `wrong_page` and `region_blocked` outcomes beyond stubbed tests and the observed `/region-error` page, signed-in tabs, and a theater that Fandango marks as not selling tickets online (`ticketing_available: false` is covered by fixtures only).
- Runtime behavior: see QA for what was exercised on the Kernel browser runtime and in a local Chromium with the extension.

## QA

Independent QA agent `agt_7481b4b4b98a44369c89`. All live checks were signed out, from a US network, on 2026-09-29; the reviewer never signed in, clicked on the site or opened a ticket-selection page.

Round 1 on the first revision (`search.js` blob `0ef6b98`, `search_theaters.js` `3f89885`, `get_movie_showtimes.js` `f6351eb`, `get_theater_showtimes.js` `ce32ddc`): **FAIL**. Findings, all fixed in the next commit:

1. `search_theaters` answered a hyphenated, apostrophe or unknown city with `site_error` because the site returns HTTP 404 for it (and rejects hyphenated spellings that work with spaces). Hyphens are now sent as spaces and the 404 becomes `no_results` with a spelling hint.
2. Unrecognized response shapes could turn into fabricated `no_showtimes`, `not_found` or `theater_not_found` outcomes (found with page-local stubs). Empty and not-found outcomes now require the site's own signals (`hasShowtimes: false`, a boolean `hasCalendar`, `error: true`); anything else is `site_error`.
3. Dates about four weeks back or more made both showtime tools report `site_error`, because the site answers with the current day. They now return `no_showtimes` with `available_dates`.
4. The site's fifth showtime word `restricted` was mapped to `unknown`; it now has its own status.
5. Descriptions claimed every showtime has an id; many are null.
6. Stale README claims (after-midnight showtimes, calendar sizes) and missing tests.
7. `search` returned theater links with an upper-case id and city links with `+`, which the site redirects; they are now returned in their final form.

Round 2 on `8243fb1` (blobs `78827d6`, `53f15c0`, `37ac694`, `ced08a2`): **PASS**, with minor items: `search` passed through the site's own 404 links for city names with an apostrophe (fixed by dropping the apostrophe, which resolved for every such city checked), an internally inconsistent QA paragraph in this README, and six surviving mutants in the tests (tests added; all seven mutants of that set are now killed). What round 2 verified live, on the Kernel runtime and in a local Chromium 153 with the unpacked extension:

- Outputs matched the site: 77 and 95 showtimes at one theater on two days, identical to the theater page; nine theaters for one movie near one ZIP, identical to the movie page including times, formats and states; `time_text` and `local_time` agreed on all 1386 showtimes checked.
- 88 saved Kernel outputs and 30 extension outputs all validated against their output schemas with a real JSON Schema validator, covering `ok`, `no_results`, `no_showtimes`, `invalid_input`, `not_found` and `theater_not_found`.
- From the home, a movie, a theater and a 404 page on `www.fandango.com`, all four tools returned success and the tab URL never changed; on `/region-error` all four returned `region_blocked` with no request; no tool was listed on the `tickets.` or `athome.` landing pages; the tools' own requests were only `GET /napi/...` with no body and no navigation (measured with an in-page fetch/XHR wrapper; the CDP log on content pages also shows the page's own ad and analytics traffic, which the tools do not produce), and cookie and storage key names and counts were unchanged.
- The largest output was about 61 KB (110 KB as the Kernel API wraps it), under the 240 KiB API limit.
- The extension run used a scratch copy of the extension whose manifest lists `https://www.fandango.com/*` as a host permission, because the site-access prompt cannot be driven headlessly; it otherwise matched the repository. Of 12 cases diffed against the Kernel runtime, 10 were identical, one differed only in amenity order and one was not comparable; the other extension outputs were schema-checked only.

Not exercised in any round: live HTTP 403 and 429 responses and bot-protection pages (stubbed only), a real non-US network location (only the `/region-error` page), signed-in tabs, and theaters with `ticketing_available: false`. The `restricted` status was seen live in round 1 and not re-observed live in rounds 2 or 3; its mapping was checked on the live runtime with an overridden response and by tests.

Round 3 on the final source (`search.js` blob `7569261`; the other three tools unchanged and byte-identical to round 2): **PASS** for all four tools, with no code defects (three README wording corrections, applied here). Live, 2026-09-29, signed out, US network:

- 21 `search` queries returned 46 city links and 20 theater links; fetching all 66 returned URLs without following redirects gave 66 responses of 200, and the 24 apostrophe cities the tool returned (for example `/coeur-dalene_id_movietimes`) resolve, while the site's own `+` links for the same cities are 404. No returned URL contains an apostrophe, a `+` or an upper-case theater path.
- A smoke pass of all four tools from a movie page, the home page, a theater page and a 404 page succeeded with the tab URL unchanged; `/region-error` gave `region_blocked` with no request; 21 outputs validated against their schemas; the largest output was about 61 KB; `time_text` matched `local_time` on all 469 showtimes checked.
- 61 mutants were run against the tests; five survived (three equivalent, the movie tool's default `limit` and the `search_theaters` amenity cap), which are documented gaps rather than defects.
- In the local extension, 16 cases run from a movie page were `completed`, byte-identical to the Kernel outputs for the same inputs apart from `observed_at`, schema-valid, with the tab URL unchanged, and all four tools returned `region_blocked` on `/region-error`.

Sessions (ephemeral): builder and QA browsers were created and deleted by their owners.
