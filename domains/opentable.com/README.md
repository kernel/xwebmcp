# opentable.com

Tools for the OpenTable US diner site (https://www.opentable.com): restaurant search, restaurant profiles, and diner reviews. All three are read-only page tools and work signed out.

| tool | file | status | notes |
|------|------|--------|-------|
| search_restaurants | [search_restaurants.js](search_restaurants.js) | draft | Free-text search with optional date, time and party size; one site results page (up to 50) per call with id, url, cuisine, price band, address, coordinates, rating and review count. No bookable time slots. |
| get_restaurant | [get_restaurant.js](get_restaurant.js) | draft | One profile by restaurant_id or /r/<slug> URL: address, hours text, amenities, ratings by category with distribution, awards, tags, AI review summary, optional published menus. |
| get_reviews | [get_reviews.js](get_reviews.js) | draft | One page of 10 diner reviews, newest first, with ratings, text, dates and vote counts. No reviewer names or photos. |

Register all three files together as one array with `forceOverwriteNamespace: true`; registering one file that way removes the others.

## Native WebMCP tools

None found (checked 2026-09-29, signed out, with `webmcp.listTools()` and `document.modelContext.getTools()` on the home page, a search results page and a restaurant profile page). `document.modelContext` exists with zero registered tools, `navigator.modelContext` is undefined and no element carries a `toolname` attribute, so the `opentable.com` namespace does not overlap with anything the site registers. The site's own "Concierge" AI assistant is a chat widget, not a WebMCP tool.

## Scope and loading

The tools read public restaurant information. They never select a time slot, request or hold a table, book, modify or cancel a reservation, set an availability alert, save a favorite, write a review, sign in, or open any account, payment, checkout or private-dining page. The only paths the tools ever request are `/s` (search), `/restaurant/profile/<id>` and `/r/<slug>`; a `url` input that is anything else, or carries credentials or a port, is rejected before any request. Availability (bookable time slots) is deliberately not covered: the site loads it through a persisted GraphQL query with a CSRF token and a slot click can take a hold, which needs its own design.

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
- **get_restaurant** (`kind: "page"`) fetches the restaurant's profile page (`/restaurant/profile/<id>` for an id, or the given `/r/<slug>` path) and reads `restaurantProfile`. The id path serves the profile directly, without a redirect. A returned id that differs from the requested one is an error. Older restaurants link to `/<slug>` instead of `/r/<slug>`; those links are refused because a single-segment path cannot be told apart from any other site page (`/private-dining`, `/logout`, and so on) and the request carries the browser's cookies, so pass `restaurant_id` for them. `search_restaurants` returns the id for every restaurant.
- **get_reviews** (`kind: "page"`) fetches the same profile page with `?page=N` and reads the page of 10 reviews the server rendered for it. The site's default "newest" order follows the dining date, not the posting date (independent QA checked 20 reviews: `dined_at` never increased, `submitted_at` did), and this tool exposes no other order.

All three are `kind: "page"` because each one only reads a same-origin document and returns a structured result without navigating the tab; none of them needs post-navigation output.

Outputs:

- Text from the site (descriptions, hours, review summaries, menu items and diner reviews) is untrusted data. Free-text fields such as descriptions, hours, transit, parking, menu items and the review summary have HTML tags stripped and entities decoded; names, cuisines, addresses and review text are returned as the site gives them. Free-text and name-like strings are length-capped: names 200, descriptions and the review summary 1500 (300 in search), review text 3000, hours, parking details, transit, entertainment, menu and item descriptions 500, review ids 100, everything else 300 or less. Ids and timestamps are validated instead: URLs longer than 300 path characters fall back to the `/restaurant/profile/<id>` URL, and a timestamp that is not a plain ISO 8601 value becomes null. `website` and `external_menu_url` are returned only when the site gives an http(s) URL, with the query string and fragment removed.
- `observed_at` is on every result. Ratings, counts, "booked today" numbers and the ordering change constantly.
- The tools return only an allowlist of fields. The page state also contains account data when signed in (header profile, loyalty status), tracking identifiers, photo URLs, contact email fields, a Google Maps API key inside `coordinates.mapUrl`, and reviewer names and photos; none of it is returned.

## URL patterns

All three tools match only `https://www.opentable.com/*`, not the default `https://opentable.com/*` and `https://*.opentable.com/*`. The other hosts under the registrable domain are separate products: the help centre (`help.`), restaurant-business marketing (`restaurant.`), press (`press.`) and developer pages (`dev.`). The search and profile pages the tools read are same-origin only on `www.opentable.com`, so a page tool on those hosts could not work. Regional OpenTable sites (`opentable.co.uk`, `opentable.ca`, `opentable.com.au`, `opentable.de`, `opentable.jp`, and others) are separate registrable domains and are out of scope. Whether the bare `opentable.com` redirects to `www` was not checked.

## Site quirks

- **Bot protection.** OpenTable runs Akamai Bot Manager. After roughly 40 page fetches in about ten minutes from one stealth browser session (unpaced, while probing), the site answered HTTP 403 with an "Access Denied" page and a `Reference #`, and kept doing so for at least five minutes for that session. A new session on Kernel's default stealth egress was not blocked: several dozen calls spaced 6 or more seconds apart went through. From an ordinary cloud VM's IP in a plain Chromium, `/s` searches returned 403 on all three attempts while a profile page and a review page succeeded (a later probe of an unknown slug was also refused). Independent QA on another network got 200 for `/s`, so whether a request is refused depends on the network and the browser. Akamai also serves a small challenge page (about 2.5 KB, no `<title>`, elements named `sec-if-cpt-container` and `sec-bc-tile-parent`) with HTTP 200; independent QA saw it on a fresh session's first searches and `/r/<slug>` pages while `/restaurant/profile/<id>` still worked. The tools report a 403, an "Access Denied" page and that challenge page as `challenge`, and HTTP 429 as `rate_limited`; they never retry. Avoid rapid repeated calls.
- **Same page, different data.** Every read is a server-rendered HTML page (search about 230 to 400 KB, profiles about 370 to 570 KB) whose `<script id="primary-window-vars">` holds JSON with `windowVariables.__INITIAL_STATE__`. A 200 without that script is reported as `challenge` when it is the Akamai challenge page above and as `site_changed` otherwise, and a 404 is `not_found`.
- **Review paging past the end.** For `?page=N` beyond the last page the site does not fail: it answered HTTP 200 with page 1, 40 reviews and a different `totalPages`. `get_reviews` therefore requires the returned page number to equal the requested one and returns `no_results` otherwise.
- **Result counts vary with the request.** `total_count` in search changed with date, time and party size (117, 112 and 50 for one query). A `page` past the last one returns an empty list with a total of 0 (not page 1, unlike review pages), reported as `no_results`.
- **Restaurant URLs.** Newer restaurants live at `/r/<slug>`; older ones at `/<slug>` (for example a downtown DC restaurant), which the tools do not accept as `url`. `restaurant_id` is the stable key and works with `/restaurant/profile/<id>`. `/restref/...` links redirect into an availability path and are never used.
- **Menus.** Many restaurants have no menu on OpenTable (`menus` is null) and only link one on their own site; that link is `external_menu_url` with its query string removed.
- **Non-ASCII text.** Other repository page tools have seen outputs with non-ASCII text arrive from the page bridge as a JSON string instead of an object. It did not happen here (a search for "café Montréal" returned a normal object on the Kernel runtime); if a caller sees a string, parse it when `typeof output === "string"`.
- **Transient responses.** One live `get_reviews` call for an out-of-range page came back with a profile but without review data and was reported `site_changed`; three repeats and the same call again returned the normal `no_results`, and the response state was not captured; independent QA could not reproduce it in 8 out-of-range calls. Retry once before treating a `site_changed` that mentions review data as a real site change. A response with the site's own `reviewsData.error` flag set is reported as `site_error`.

## Known limitations

- US site only (`opentable.com`, USD, `en-US`).
- No availability. The tools cannot say whether a table is free; `recent_reservation_count` is only the number the site says were booked today.
- `search_restaurants` returns one site page (up to 50) per call, at most 100 pages, and has no cuisine, price, neighborhood or sort filters; the filter parameter names were not verified.
- The `date` and `time` inputs only steer the site's own ranking and filtering. A past date was accepted by the site and gave the same count as no date on one query; the tool does not reject past dates.
- `get_restaurant` returns hours as the site's free text, not a schedule. Menu item prices are passed through as the site gives them: strings such as `"12.00"` on the one priced menu independent QA checked, `null` for most items elsewhere, with no currency per item. Menus are capped at 300 items.
- `get_reviews` shows the site's newest order only (by dining date), returns `dined_at` as the site gives it (one review showed a +00:00 offset for a Chicago restaurant), omits reviewer identity and the text of restaurant replies (the reply shape was not observed in 80 reviews), and reports `verified_by_opentable` only as whether the site tags the review `OPENTABLEVERIFIED`; other tag values were not seen.
- Every call fetches a whole HTML page (see above), so latency is that of a page fetch (0.3 to 2.3 s per call in live checks on a Kernel browser) and heavy use can trigger the bot protection.
- Signed-in behavior was not tested: pages fetched while signed in carry account data in the same state object. The tools ignore it, but no independent check has confirmed that with a real account.
- Not live-verified: a permanently closed restaurant and redirects to another host. They are covered by stubbed tests only. A restaurant with zero reviews was checked live by independent QA and returns `no_results`.

## QA

Draft. All three tools stay `draft` until an independent pass signs off on the final source.

Author checks on 2026-09-29, signed out, on a stealth Kernel browser (`webmcp custom-tools add` with the whole namespace in one call, `webmcp list`, `webmcp invoke`):

- Registration: the three tools were listed once each on `www.opentable.com` pages, and on no tab of `example.com` or `help.opentable.com`.
- Live success: `search_restaurants` (with date, time and party size, pages 2 and 3, no-results and non-ASCII queries), `get_restaurant` (by id with menus), `get_reviews` (pages 1 to 3 and an out-of-range page). Seven live outputs were validated against their `outputSchema` with a JSON Schema 2020-12 validator.
- Live failure: unknown slug and unknown id (`not_found`), out-of-range review and search pages (`no_results`), malformed input (`invalid_input`, no request sent).
- Starting pages: invoked from `/private-dining`, a 404 page and another restaurant's profile page. A marker set on the document before each call was still there after it, and the URL did not change, so the calls do not navigate.
- Local Chrome extension (`xwebmcp setup chrome` and `mcp`, Chromium 153, an isolated profile granted only `www.opentable.com`): live, `get_restaurant` and `get_reviews` succeeded and `search_restaurants` returned `challenge` because that network's requests to `/s` were refused with 403. Against fabricated pages served locally for `www.opentable.com`, all three tools returned their success, `not_found` and `no_results` outputs and leaked nothing from the fabricated state.

Independent QA round 1 (agent `agt_af9a78c90e1647b33555`, first revision `4f0f109`): **FAIL**. About 45 live outputs on Kernel and 13 in the extension conformed to their schemas, the automated suites passed, and no account data, tokens, photo URLs, maps key, reviewer identity or contact email appeared in any output. Findings, all fixed in the next revision:

1. (major) `url` accepted any single-segment path (`/private-dining`, `/s`, `/logout`) and fetched it with the browser's cookies before reporting `not_found`, so the tools could request account and booking pages, contrary to this README and the authoring skill. `url` now accepts only `/r/<slug>` and `/restaurant/profile/<id>`, rejecting everything else, including older `/<slug>` links, before any request; `restaurant_id` covers those restaurants.
2. The README claimed all text fields were tag-stripped and length-capped. Names, addresses and review text were returned as given with no cap (a 20,000-character name passed through), and `website` kept tracking parameters. Every string field is now capped, links lose their query string, and the README says which fields are cleaned.
3. The review order follows the dining date, not the posting date, and one `dined_at` carried a +00:00 offset for a Chicago restaurant; the description promised the restaurant's offset. Both are now described as observed.
4. The `unsupported_host` message for a non-https URL said the site was a different one. Non-https URLs now get their own `invalid_input` message.
5. README facts were stale: page sizes, and two "never seen live" cases (a priced menu and a zero-review restaurant) that work live.
6. The 3000-character review text cap had no test; it does now, along with the string caps and the URL allowlist.

Independent QA round 2 (same agent, revision `e4fee55`): **PASS** with no blocking or major defects. It fuzzed 119 `url` shapes in Node and in Chrome's URL parser, then ran 42 rejected invocations on Kernel, 36 on the live extension and 30 dangerous paths against a local fixture: none produced a request. It ran 55 mutants against the tests and about 45 real outputs against their schemas. Minor findings, fixed in the next revision:

1. Akamai's HTTP 200 challenge page was reported as `site_changed`; it is now `challenge`.
2. Review ids, URLs and timestamps were unbounded and the README's cap statement was wrong; they are now bounded and the README lists the caps.
3. Test gaps that mutants exposed (the `^` anchor of the `/r/<slug>` pattern, the id lower bound in `get_reviews`, the slug length, fragment-only links, blank names, the returned-page and page-size guards) are now covered, and a `url` with credentials or a port is rejected.

Not covered: signed-in behavior and the exact Akamai behavior at volume.
