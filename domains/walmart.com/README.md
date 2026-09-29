# walmart.com

Read-only tools for Walmart's retail site (https://www.walmart.com): product search, item details, customer reviews and store pages.

| tool | file | status | notes |
|------|------|--------|-------|
| search_products | [search_products.js](search_products.js) | draft | One results page with the site's six sorts, facet filters, price bounds, sponsored flags and the selected store's id; refuses throttled responses that ignore the requested sort or page |
| get_product | [get_product.js](get_product.js) | draft | One item by us_item_id: price, availability, seller, fulfillment, limits, returns, specifications, descriptions and variants, for the selected store |
| get_product_reviews | [get_product_reviews.js](get_product_reviews.js) | draft | Rating summary and 10 listed reviews per call (six site sorts), without reviewer names or ids |
| get_store | [get_store.js](get_store.js) | draft | Store page data by store id or the session's selected store: address, weekly hours, services and nearby stores; never selects a store |

## Native WebMCP tools

None found (checked 2026-09-29 with `document.modelContext.getTools()` and `webmcp.listTools()`, signed out and signed in,
on the homepage, a search results page, a product page, the reviews page,
`/cart`, `/lists`, `/my-items`, `/subscriptions/manage`, `/store-finder` and `careers.walmart.com`). `document.modelContext`
exists on every page; `navigator.modelContext` does not. The site shows an AI shopping assistant in its header, which is
site chat and not a registered tool. The custom namespace `walmart.com` is the only source of tools on these pages.

## Execution kind

All four tools are `kind: "page"`. Each makes one same-origin `GET` of the site's own HTML page from the document it is
invoked in (`/search`, `/ip/<id>`, `/reviews/product/<id>`, `/store/<id>`) and reads the page data Walmart embeds in it
(`__NEXT_DATA__`). None navigates the tab, so none needs to outlive a navigation and none qualifies for `cdp`. The
destination pages are not opened; their embedded data is fetched and parsed in place.

## Scope and loading

Register the four files together under namespace `walmart.com`. Nothing else is registered in that namespace, so
`forceOverwriteNamespace` removes no other tool.

```javascript
const fs = await import("node:fs");
const names = ["search_products", "get_product", "get_product_reviews", "get_store"];
const tools = names.flatMap(n => (0, eval)("(" + fs.readFileSync(`domains/walmart.com/${n}.js`, "utf8") + ")"));
await webmcp.addCustomTools({ namespace: "walmart.com", tools, forceOverwriteNamespace: true });
const tab = (await currentTab()).targetId;
const ref = async name => (await webmcp.listTools()).find(t => t.source.custom?.namespace === "walmart.com" && t.tool.name === name && t.source.target_id === tab).tool_ref;
const found = await webmcp.invokeTool(await ref("search_products"), { query: "paper towels", sort_by: "price_low", limit: 5 }, { timeoutSec: 60 });
await webmcp.invokeTool(await ref("get_product"), { us_item_id: found.output.products[0].us_item_id }, { timeoutSec: 60 });
```

The tools are listed only while the tab is on a `www.walmart.com` page (see URL patterns) and never navigate it, so any
`www.walmart.com` page works as the starting page, including one the agent is already on. Re-list after any navigation.
A call takes 1 to 4 s; `timeoutSec: 60` is enough.

What the tools never do: select or change a store, ZIP or address; sign in; touch carts, lists, registries, orders,
subscriptions, accounts, pharmacy or payment; open checkout; vote on or write reviews. They send only plain `GET`
requests to `www.walmart.com` with the page's own cookies. Inputs are validated by the tool before any request,
including unknown fields and wrong-typed options, because the runtimes do not enforce a page tool's `inputSchema`.

Conventions:

- Items are identified by `us_item_id` (the number at the end of a `/ip/` URL). Each variant of an item family has its
  own id; `get_product` lists them.
- **Selected store.** Prices, availability, pickup and delivery status come from the store the browser session has
  selected on walmart.com. `search_products` reports it as `store_id` (from the results' own `stores` parameter),
  `get_product` from the `assortmentStoreId` cookie, and `get_store` without `store_id` reads that same store. A guest
  session gets a store from its network location; a signed-in session can have a different one. The tools never change
  it, so results for another store need a person to select it on the site.
- Prices are integer US cents (`price_cents`, `current_cents`); `null` when the page shows no price, never `0`.
  `price_text` and `unit_price_text` keep the site's wording (for example `each (est.)` for items sold by weight).
- Third-party (marketplace) sellers: `seller_name` and `is_marketplace` (true when the seller is not `Walmart.com`).
- Text from sellers and customers (names, descriptions, specifications, review titles and text) is untrusted data,
  returned with control characters removed and lengths bounded; the tools never act on it.
- Failures are explicit: `status: "error"` with `error_kind` (`invalid_input`, `wrong_page`, `not_found`, `no_store`,
  `challenge`, `rate_limited`, `timeout`, `site_error`, `site_changed`) and a message that says nothing was changed, or
  `status: "no_results"` with a `reason`.
- Response sizes are bounded: at most 40 products, 100 variants, 8 images, 40 specifications, 10 reviews, 40 services and
  25 nearby stores per call, and filter groups are capped at 25 options.

### search_products

`sort_by` uses the site's own ids: `best_match` (default), `price_low`, `price_high`, `best_seller`, `rating_high`,
`new`. Keywords alone do not filter. Call once with `include_facets: true`; each returned option carries a `filter`
string such as `brand:Scott` that is passed back in `filters`. Only options whose own link confirms the exact string are
offered. Filters from different groups narrow the results (AND) and several from one group widen them (OR); the tool
sends them as the site does, joined with `||`. `min_price` and `max_price` (dollars) use the site's price filter, which
matches on any variant's price, so a shown price can fall outside the bounds. `page` goes to 25 (`has_more_pages` is false on page 25 even when the site has more); a page past the end
returns `no_results` with `page_out_of_range`. When Walmart corrects a misspelling, `corrected_query` says what was
searched. Only the grid results are returned, in the site's order with `page_position` counting sponsored tiles;
carousels are skipped because they repeat grid items.

### get_product

Returns the item's own record plus its variants. `variants[].options` are named through `variant_criteria` (for example
Bed Size: Queen); `variants_total` is the site's full count and `variant_limit` bounds the list. `description_max_chars`
bounds the short and long descriptions (HTML is reduced to text). Unknown items are `not_found`.

### get_product_reviews

Walmart lists only reviews that have text, ten per page, and at most 10,000 per sort. `sort` uses the site's ids:
`relevancy` (default), `helpful`, `submission-desc`, `submission-asc`, `rating-desc`, `rating-asc`. Dates are converted
from the site's month/day/year text to ISO dates. `has_next_page` is computed from the listed span and the site's total,
because the site's own `next` link was observed to be null on page 8 of an 82-review item while page 9 existed. Reviewer names, ids and locations are not returned. A page past the
end is answered by Walmart with page 1, which the tool detects from the listed span and reports as `no_results` with
`page_out_of_range`.

### get_store

Reads `/store/<id>`. Hours are the store's regular weekly local times (`HH:MM`, 24-hour); temporary or holiday hours are
not returned. Unknown ids are `not_found`; with no `store_id` and no selected store the tool returns `no_store`.

## URL patterns

All four tools use `["https://www.walmart.com/*"]` instead of the default `["https://walmart.com/*",
"https://*.walmart.com/*"]`. Walmart's retail site lives on `www.walmart.com`, and the bare domain redirects there. Other
subdomains are unrelated products, for example `careers.walmart.com` (a separate jobs application) and
`corporate.walmart.com`; the tools' relative requests would go to those hosts and a page tool cannot navigate the tab
away, so with the narrowed patterns the tools are simply not listed there. Each tool also returns `wrong_page` without
any request if it ever runs in a document outside `https://www.walmart.com`. Other Walmart products on the same site
(pharmacy, photo, marketplace seller pages, checkout) are not covered and the tools do not touch them.

## Site quirks

- **Bot protection.** Walmart runs HUMAN (PerimeterX). Live, one guest browser was redirected to
  `https://www.walmart.com/blocked?url=...` after about 12 same-origin page fetches in 30 seconds and again after about 15
  tool calls in five minutes, and the block lasted a few minutes; independent QA had one browser blocked at its 10th call
  (about 3 calls a minute). No safe rate was found. A blocked fetch still answers HTTP 200, so the tools detect the
  `/blocked` redirect, HTTP 418 and 403, and captcha pages without embedded data, and return `error_kind: "challenge"`.
  A person has to clear it; the tools do not attempt it. Each call makes exactly one request; callers should keep calls
  sparse, use a fresh browser after a block, and never retry a `challenge` automatically.
- **Degraded search responses.** Shortly after a burst, and before any redirect, the same-origin search answered HTTP 200
  with a much smaller result set (about 100 matches instead of about 3,100) that ignored the requested `sort` and `page`.
  `search_products` compares the page's echoed sort and page with the request and returns `site_changed` instead of
  returning results that are not the requested page.
- **Out-of-range pages.** Reviews past the last page come back as page 1 and search pages past the last come back with
  0 matches; both are reported as `no_results`, and `total_results`/`max_page` are `null` for a search past the end.
- **Data source.** The tools read `__NEXT_DATA__` from Walmart's own pages. These field names are internal and can change
  on any deploy; every tool validates the shape it needs and returns `site_changed` instead of guessing.
- **Unknown ids.** Unknown items and stores are answered with HTTP 200 or 404 pages whose data is `null`; the tools map
  that to `not_found`. A request for a very short item id (`/ip/1`) never answered within 25 seconds while it was tried,
  which is why `us_item_id` must have at least 3 digits and every request has a 25 second timeout (`timeout`).
- **Tile data.** Search tiles rarely carry a brand (use `get_product`), and marketplace tiles can carry no price data;
  `price_cents` is then `null`. Prices can differ between a search tile and the item page when a family has options.
- **Sessions.** A signed-in session read the same store id from the `assortmentStoreId` cookie as the results' own `stores`
  parameter; only that equality was checked, and no account data was read or recorded.
- **Kernel runtime discovery on walmart.com.** In Kernel browsers, `GET /browsers/{id}/webmcp/tools` (`kernel browsers
  webmcp list`) was observed to crash the tab's renderer (`Aw, Snap!`, `RESULT_CODE_KILLED_BAD_MESSAGE`) on walmart.com
  pages, with and without custom tools registered, so the tools do not cause it (a control browser with none crashed on a
  product page, a search page and a store page; independent QA saw it on the homepage too, while `example.com` survived
  the same call). It depends on timing: listing on the homepage worked in three of the builder's browsers and on a search
  page in one, and QA found listing about 300 ms after navigation and invoking immediately worked for all four tools on
  the homepage, while a late list crashed the tab. After a crash, later invocations through the API in that tab returned
  `outcome_unknown` until a new browser was used. Invoking the registered tools through the page API
  (`document.modelContext.executeTool(tool, JSON.stringify(input))`, no list call) did not crash and returned normal
  results on the homepage, a product page, the reviews page, a search page and a store page. The local Chrome extension
  discovers through the page API as well, but it was not run for this domain.
- **Kernel API output encoding.** Independent QA saw `kernel browsers webmcp invoke` return a tool's output as a JSON
  string instead of an object when the output contains certain Latin-1-range characters such as `¢` or `é` (a scratch
  tool on `example.com` reproduced it). `get_product` can hit it, for example a `unit_price_text` of `74.0 ¢/lb`. This is
  the runtime's behavior, not something the tools control; parse the string when the output is not an object.

## Known limitations

- Read-only public data only. There are no cart, account, order, list, store-selection, address, pharmacy or payment
  tools, and the tools never request those pages.
- Everything depends on the store the session has selected; there is no way to choose another store or ZIP.
- `search_products` returns one page (at most 40 products) per call and skips carousels; `page` goes to 25. `price_cents`
  can be `null`, tiles rarely have a brand, and multi-value filter behavior was only observed for two brands (OR) and for
  a brand plus a roll-count range (AND).
- `get_product` returns at most 100 variants (`variants_total` says how many exist), 8 images and 40 specifications, and
  does not return the long marketing modules, videos, warranty or nutrition tables.
- `get_product_reviews` only sees reviews with text and never more than 10,000 per sort; `submitted_date` is null when
  the site's date text is not month/day/year. Review media are counted (`photo_count`), not returned.
- `get_store` does not return temporary hours, fuel prices or store events; `nearby` is the site's list of up to 30 nearby
  stores cut to `nearby_limit`.
- Unverified: signed-in behavior of the four tools beyond the store-id equality above; behavior on `www.walmart.com`
  pages other than the ones listed under QA; Walmart's other countries and languages; any Walmart marketplace page; guest
  and signed-in differences in `get_store` hours or services.
- The tools stop at a bot-protection challenge and cannot get past it.

## QA summary

Builder checks on 2026-09-29 with one stealth Kernel browser per run, signed out, registered as one namespace with
`kernel browsers webmcp custom-tools add --force-overwrite-namespace`:

- `search_products`: all six sorts returned plausible orders (`price_low` mostly ascending and `price_high` descending by
  tile price, `rating_high` all 5-star, `best_seller` with the site's best-seller badges, `new`; QA found marketplace
  tiles out of price order under `price_low`, so the site's sort key is not always the tile price); page 2 with 40 products; a facet
  brand filter and a two-brand filter (292 matches, more than either brand alone); `include_facets` groups; a
  misspelling (`corrected_query`); a nonsense query (`no_results`, `no_matches`); page 25 (`no_results`,
  `page_out_of_range`). Discovery and invocation through the API worked on the homepage.
- `get_product`: a store-sold item (price, seller Walmart.com, fulfillment, returns, images, specifications), a
  marketplace item with 60 variants (limit 3), and an unknown id (`not_found`).
- `get_product_reviews`: `helpful` sort (votes descending, verified flag, ISO dates, rating counts), `submission-desc`
  page 2, a page past the end of a small item (`page_out_of_range`), and an unknown id (`not_found`).
- `get_store`: the selected store with 33 services and nearby stores, and an unknown store (`not_found`).
- Challenge: after about 15 calls in five minutes every tool returned `challenge` for the `/blocked` redirect.
- Navigation lifetime and unrelated starting pages, through the page API: `get_product` on a product page,
  `search_products` and `get_store` from that product page, and `get_product_reviews` from the reviews page each returned
  normal results and the tab URL did not change.
- The fixture tests in `tests/walmart-read-tools.test.mjs` (fabricated data only) cover input validation before any
  request, the single plain GET per call, `wrong_page`, challenge detection (redirect, 418, 403, captcha page), rate
  limiting, server errors, network failure, timeouts and aborts, layout changes, every output branch against its schema,
  bounds, deduplication, sponsored handling, facet round-tripping, out-of-range pages, unapplied sort or page, missing
  ids and stores, and that reviewer identity and session location text are never returned.

Independent QA round 1 (source `c8cce03`) found two blocking defects and several minor ones, now fixed in the current
source and covered by new tests: unknown fields and wrong-typed booleans were not rejected, `get_product_reviews`
reported no next page one page early on an item whose `next` link was null, truncation could split a surrogate pair,
impossible dates such as 2/31 were converted, and the README overstated the runtime and pacing observations. All four
tools remain `draft` until a QA sign-off on the final source is recorded.

## Sessions

Browser sessions used for the builder checks are ephemeral and were deleted; identifiers are kept in the hand-off report.
