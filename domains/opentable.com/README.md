# opentable.com

Tools for the OpenTable US diner site (https://www.opentable.com): restaurant search, restaurant profiles, and diner reviews. All three are read-only page tools and work signed out.

| tool | file | status | notes |
|------|------|--------|-------|
| search_restaurants | [search_restaurants.js](search_restaurants.js) | draft | Free-text search with optional date, time and party size; one site results page (up to 50) per call with id, url, cuisine, price band, address, coordinates, rating and review count. No bookable time slots. |
| get_restaurant | [get_restaurant.js](get_restaurant.js) | draft | One profile by restaurant_id or profile URL: address, hours text, amenities, ratings by category with distribution, awards, tags, AI review summary, optional published menus. |
| get_reviews | [get_reviews.js](get_reviews.js) | draft | One page of 10 diner reviews, newest first, with ratings, text, dates and vote counts. No reviewer names or photos. |

Register all three files together as one array with `forceOverwriteNamespace: true`; registering one file that way removes the others.

## Native WebMCP tools

None found (checked 2026-09-29, signed out, with `webmcp.listTools()` and `document.modelContext.getTools()` on the home page, a search results page and a restaurant profile page). `document.modelContext` exists with zero registered tools, `navigator.modelContext` is undefined and no element carries a `toolname` attribute, so the `opentable.com` namespace does not overlap with anything the site registers. The site's own "Concierge" AI assistant is a chat widget, not a WebMCP tool.

## Scope and loading

The tools read public restaurant information. They never select a time slot, request or hold a table, book, modify or cancel a reservation, set an availability alert, save a favorite, write a review, sign in, or open any account, payment, checkout or private-dining page. Availability (bookable time slots) is deliberately not covered: the site loads it through a persisted GraphQL query with a CSRF token and a slot click can take a hold, which needs its own design.

```javascript
const fs = await import("node:fs");
const files = ["search_restaurants", "get_restaurant", "get_reviews"];
const tools = files.flatMap(name => eval(fs.readFileSync(`domains/opentable.com/${name}.js`, "utf8")));
await webmcp.addCustomTools({ namespace: "opentable.com", tools, forceOverwriteNamespace: true });
const ref = async name => (await webmcp.listTools()).find(t => t.source.custom?.namespace === "opentable.com" && t.tool.name === name).tool_ref;
await webmcp.invokeTool(await ref("search_restaurants"), { query: "sushi Chicago", date: "2026-10-16", time: "19:00", party_size: 2 }, { timeoutSec: 60 });
await webmcp.invokeTool(await ref("get_restaurant"), { restaurant_id: 107461, include_menus: true }, { timeoutSec: 60 });
await webmcp.invokeTool(await ref("get_reviews"), { restaurant_id: 107461, page: 2 }, { timeoutSec: 60 });
```

Use future dates. Pick the `tool_ref` whose `source.target_id` is the tab you drive, and use `timeoutSec: 60`.

- **search_restaurants** (`kind: "page"`) fetches the site's own results page (`/s?term=...`, plus `dateTime`, `covers` and `page` when given) from the current `www.opentable.com` document and reads the `multiSearch` results the server rendered into the page. It never navigates. `query` carries the place as words ("pizza Chicago"); the site resolved that to the Chicago metro in live checks. Without a place the site uses the browser's approximate location. `date` alone means 19:00, the site's default. `party_size` (1 to 20, the site's picker) changes which restaurants are returned: a party of 25 cut one query from 117 results to 50. `rank` is the position in the site's ordering across pages of 50.
- **get_restaurant** (`kind: "page"`) fetches the restaurant's profile page (`/restaurant/profile/<id>` for an id, or the given `/r/<slug>` or legacy `/<slug>` path) and reads `restaurantProfile`. The id path serves the profile directly, without a redirect. A returned id that differs from the requested one is an error.
- **get_reviews** (`kind: "page"`) fetches the same profile page with `?page=N` and reads the page of 10 reviews the server rendered for it. The site sorts newest first and this tool exposes no other order.

All three are `kind: "page"` because each one only reads a same-origin document and returns a structured result without navigating the tab; none of them needs post-navigation output.

Outputs:

- Text from the site (descriptions, hours, review summaries, menu items and diner reviews) is untrusted data. HTML tags are stripped, entities decoded, and every text field is length-capped.
- `observed_at` is on every result. Ratings, counts, "booked today" numbers and the ordering change constantly.
- The tools return only an allowlist of fields. The page state also contains account data when signed in (header profile, loyalty status), tracking identifiers, photo URLs, contact email fields, a Google Maps API key inside `coordinates.mapUrl`, and reviewer names and photos; none of it is returned.

## URL patterns

All three tools match only `https://www.opentable.com/*`, not the default `https://opentable.com/*` and `https://*.opentable.com/*`. The other hosts under the registrable domain are separate products: the help centre (`help.`), restaurant-business marketing (`restaurant.`), press (`press.`) and developer pages (`dev.`). The search and profile pages the tools read are same-origin only on `www.opentable.com`, so a page tool on those hosts could not work. Regional OpenTable sites (`opentable.co.uk`, `opentable.ca`, `opentable.com.au`, `opentable.de`, `opentable.jp`, and others) are separate registrable domains and are out of scope. Whether the bare `opentable.com` redirects to `www` was not checked.

## Site quirks

- **Bot protection.** OpenTable runs Akamai Bot Manager. After roughly 40 page fetches in about ten minutes from one stealth browser session (unpaced, while probing), the site answered HTTP 403 with an "Access Denied" page and a `Reference #`, and kept doing so for at least five minutes for that session. A new session on Kernel's default stealth egress was not blocked: several dozen calls spaced 6 or more seconds apart went through. From an ordinary cloud VM's IP in a plain Chromium, `/s` searches returned 403 on all three attempts while a profile page and a review page succeeded (a later probe of an unknown slug was also refused). The tools report a refusal as `challenge` and HTTP 429 as `rate_limited`; they never retry. Avoid rapid repeated calls.
- **Same page, different data.** Every read is a server-rendered HTML page (200 to 400 KB) whose `<script id="primary-window-vars">` holds JSON with `windowVariables.__INITIAL_STATE__`. A 200 without that script is reported as `site_changed`, and a 404 is `not_found`.
- **Review paging past the end.** For `?page=N` beyond the last page the site does not fail: it answered HTTP 200 with page 1, 40 reviews and a different `totalPages`. `get_reviews` therefore requires the returned page number to equal the requested one and returns `no_results` otherwise.
- **Result counts vary with the request.** `total_count` in search changed with date, time and party size (117, 112 and 50 for one query). A `page` past the last one returns an empty list with a total of 0 (not page 1, unlike review pages), reported as `no_results`.
- **Restaurant URLs.** Newer restaurants live at `/r/<slug>`; older ones at `/<slug>` (for example a downtown DC restaurant). `restaurant_id` is the stable key and works with `/restaurant/profile/<id>`. `/restref/...` links redirect into an availability path and are never used.
- **Menus.** Many restaurants have no menu on OpenTable (`menus` is null) and only link one on their own site; that link is `external_menu_url` with its query string removed.
- **Non-ASCII text.** Other repository page tools have seen outputs with non-ASCII text arrive from the page bridge as a JSON string instead of an object. It did not happen here (a search for "café Montréal" returned a normal object on the Kernel runtime); if a caller sees a string, parse it when `typeof output === "string"`.
- **Transient responses.** One live `get_reviews` call for an out-of-range page came back without review data and was reported `site_changed`; three repeats and the same call again returned the normal `no_results`, and the response state was not captured. Retry once before treating `site_changed` as a real site change. A response with the site's own `reviewsData.error` flag set is reported as `site_error`.

## Known limitations

- US site only (`opentable.com`, USD, `en-US`).
- No availability. The tools cannot say whether a table is free; `recent_reservation_count` is only the number the site says were booked today.
- `search_restaurants` returns one site page (up to 50) per call, at most 100 pages, and has no cuisine, price, neighborhood or sort filters; the filter parameter names were not verified.
- The `date` and `time` inputs only steer the site's own ranking and filtering. A past date was accepted by the site and gave the same count as no date on one query; the tool does not reject past dates.
- `get_restaurant` returns hours as the site's free text, not a schedule. Menu item prices are passed through as the site gives them; the menu price format was not observed on a priced menu, so treat `price` as unverified. Menus are capped at 300 items.
- `get_reviews` shows newest-first only, omits reviewer identity and the text of restaurant replies (the reply shape was not observed in 80 reviews), and reports `verified_by_opentable` only as whether the site tags the review `OPENTABLEVERIFIED`; other tag values were not seen.
- Every call fetches a whole HTML page (search about 230 KB, profile about 550 KB), so latency is that of a page fetch (0.3 to 2.3 s per call in live checks on a Kernel browser) and heavy use can trigger the bot protection.
- Signed-in behavior was not tested: pages fetched while signed in carry account data in the same state object. The tools ignore it, but no independent check has confirmed that with a real account.
- Not live-verified: a permanently closed restaurant, a restaurant with zero reviews, a profile with a priced menu, and redirects to another host. They are covered by stubbed tests only.

## QA

Draft. No independent QA has run yet, so all three tools stay `draft`.

Author checks on 2026-09-29, signed out, on a stealth Kernel browser (`webmcp custom-tools add` with the whole namespace in one call, `webmcp list`, `webmcp invoke`):

- Registration: the three tools were listed once each on `www.opentable.com` pages, and on no tab of `example.com` or `help.opentable.com`.
- Live success: `search_restaurants` (with date, time and party size, page 2, no-results and non-ASCII queries), `get_restaurant` (by id with menus, by URL for a legacy `/<slug>` restaurant), `get_reviews` (pages 1 to 3 and an out-of-range page). Seven live outputs were validated against their `outputSchema` with a JSON Schema 2020-12 validator.
- Live failure: unknown slug and unknown id (`not_found`), out-of-range review page (`no_results`), malformed input (`invalid_input`, no request sent).
- Starting pages: invoked from `/private-dining`, a 404 page and another restaurant's profile page. A marker set on the document before each call was still there after it, and the URL did not change, so the calls do not navigate.
- Local Chrome extension (`xwebmcp setup chrome` and `mcp`, Chromium 153, an isolated profile granted only `www.opentable.com`): live, `get_restaurant` and `get_reviews` succeeded and `search_restaurants` returned `challenge` because that network's requests to `/s` were refused with 403. Against fabricated pages served locally for `www.opentable.com`, all three tools returned their success, `not_found` and `no_results` outputs and leaked nothing from the fabricated state. The live search success path was therefore not shown in the extension.

Not covered: signed-in behavior, the extension against live search results, and everything in Known limitations marked not live-verified.
