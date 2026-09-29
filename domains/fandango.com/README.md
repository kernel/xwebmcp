# fandango.com

Public read tools for Fandango US (https://www.fandango.com): search, theaters near a place, and showtimes by movie or by theater. All four are read-only, work signed out and never touch tickets, seats, prices, carts, favorites or the account.

| tool | file | status | notes |
|------|------|--------|-------|
| get_movie_showtimes | [get_movie_showtimes.js](get_movie_showtimes.js) | draft | One movie's showtimes on one local date at theaters near a required ZIP, grouped by theater and format, with a status per showtime |
| get_theater_showtimes | [get_theater_showtimes.js](get_theater_showtimes.js) | draft | Every movie and showtime at one theater on one local date, plus theater details and the dates that have showtimes |
| search | [search.js](search.js) | draft | Header-search suggestions (movies, theaters, cities, people) as ids and canonical URLs; about four per type |
| search_theaters | [search_theaters.js](search_theaters.js) | draft | Theaters near a ZIP or city and state with distance, chain, amenities and whether tickets are sold online |

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

- Showtimes carry `local_date` and `local_time` parsed from the site's `ticketingDate` (`YYYY-MM-DD+HH:MM`, venue-local), the printed `time_text` (for example `7:00p`), `showtime_id` where the endpoint gives one, and a `status` mapped from the site's `type`: `available`, `sold_out` (`soldout`), `past` (`pastshowtime`, or `expired`), `unavailable` (`disabled`, reason not shown) or `unknown` for any other value. `site_status` keeps the site's own word.
- Screenings group showtimes by the site's format heading (`Standard`, `3D`, `IMAX`, …) and amenity group; `amenities` are the names the site attaches (reserved seating, closed caption, recliners, and policy notes such as "No passes").
- `distance_miles` is what the site reports from the ZIP or city.
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
- **Uneven errors.** An unknown theater, unknown ZIP or unknown movie all answer HTTP 200 with an `error` field or an empty list, not an HTTP error; `nearbyTheaters` returns an empty list for an unknown place. The tools map these to `theater_not_found`, `not_found` or `no_results`.
- **Movie showtimes use a ZIP only.** The endpoint was only observed with a ZIP; there is no city form.
- **Field differences.** `dateLocal`/`dateUtc` appear only in the movie-showtimes endpoint, so the tools parse `ticketingDate`, which both endpoints carry. On the 511 showtimes sampled it matched `dateLocal` every time, but no showtime after midnight was in the sample.
- **Payload size.** One theater day is about 140 KB and one movie in New York City about 190 KB before the tools trim it; the largest tool output seen was about 58 KB.
- **No stability guarantee.** `/napi/*` is an undocumented first-party API. A changed shape returns `site_error` rather than a partial success.

## Known limitations

- US site only (`en-us`, USD not exposed), and only public read data: no seat maps, prices, fees, seat availability, ticket links, favorites, orders, rewards or account tools. Showtimes for streaming (`athome.fandango.com`), FanStore and related brands are out of scope.
- `search` returns the site's suggestion list (about four items per type). It is prefix-style matching on names, so a city plus a chain name can return nothing.
- `search_theaters` cannot distinguish a mistyped ZIP or city from a place with no theaters. Its city and state form was observed only through direct requests, not through a page-initiated call, and its `limit` reached 27 theaters in one live call (`limit=50`).
- `get_movie_showtimes` requires a ZIP, reads only the first page of theaters the site returns (a warning appears when the site reports more pages; the pagination parameter was never observed) and returns no movie title, because that endpoint does not carry one. An unknown movie id and an unknown ZIP are indistinguishable (`not_found`), as are those and a movie with no showtimes near the ZIP when no date is given.
- The `status` values come from four site words seen live (`available`, `soldout`, `pastshowtime`, `disabled`); `disabled` was seen on showtimes for a later date at one theater and its meaning is not shown by the site. Any other word maps to `unknown`.
- `available_dates` is the site's window: about 10 dates for a movie near a ZIP and about 76 for a theater.
- Local times come from `ticketingDate` (venue-local, 24-hour); showtimes after midnight were not observed. Time zones are not returned.
- Not live-verified: HTTP 403 and 429 responses, a bot-protection page, the `wrong_page` and `region_blocked` outcomes beyond stubbed tests and the observed `/region-error` page, signed-in tabs, and a theater that Fandango marks as not selling tickets online (`ticketing_available: false` is covered by fixtures only).
- Runtime behavior: verified against the Kernel browser runtime (see QA). The Chrome extension runtime was not exercised.

## QA

Draft. Independent QA has not run yet.

Sessions (ephemeral): builder browsers were created and deleted by the builder.
