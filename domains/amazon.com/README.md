# amazon.com

Tools for Amazon's US store (https://www.amazon.com): search, product details and Best Sellers, all read-only.

| tool | file | status | notes |
|------|------|--------|-------|
| search_products | [search_products.js](search_products.js) | draft | One results page with the site's sorts, price bounds and filters by id; ASIN, price, list price, rating, sponsored flag and delivery wording per product |
| get_product | [get_product.js](get_product.js) | draft | Price, availability, rating, bullets, shipper and seller, delivery wording and variations with the ASIN of each combination for one ASIN |
| get_best_sellers | [get_best_sellers.js](get_best_sellers.js) | draft | A department or category ranking (the ranks the page itself contains) and the categories to open next; without a category, the department list |

## Native WebMCP tools

Amazon registers none. `webmcp.listTools()` returned no tools on the homepage, a search results page, a product page, `/cart` and the Fresh storefront (checked 2026-09-29 signed out, with the same result in a signed-in session). The browser exposes `document.modelContext.registerTool`, so the API exists; the site does not use it. These tools therefore do not collide with or duplicate native tools.

## Execution kind

All three tools are `kind: "page"`. Each fetches an HTML page from the document it is invoked in with a same-origin `fetch` (the page's own cookies), parses it with `DOMParser`, and returns structured fields. None navigates the tab, so none needs to survive a navigation and none qualifies for `cdp`. The results page, product page and Best Sellers pages are server-rendered, which is why fetching them is enough; fields that only appear after page scripts run are not read.

## Scope and loading

Register all three files together as one namespace; `forceOverwriteNamespace` replaces the namespace, so include every amazon.com tool.

```javascript
const fs = await import("node:fs");
const files = ["search_products", "get_product", "get_best_sellers"];
const tools = files.flatMap(name => eval(fs.readFileSync(`domains/amazon.com/${name}.js`, "utf8")));
await webmcp.addCustomTools({ namespace: "amazon.com", tools, forceOverwriteNamespace: true });
const ref = async name => (await webmcp.listTools()).find(t => t.source.custom?.namespace === "amazon.com" && t.tool.name === name).tool_ref;
const found = await webmcp.invokeTool(await ref("search_products"), { query: "insulated water bottle", sort_by: "price_low_to_high", include_facets: true }, { timeoutSec: 60 });
await webmcp.invokeTool(await ref("get_product"), { asin: "<asin from search_products>", variant_filter: { Size: "32 Ounces" } }, { timeoutSec: 60 });
await webmcp.invokeTool(await ref("get_best_sellers"), { category: "kitchen" }, { timeoutSec: 60 });
```

Each tool runs inside the `www.amazon.com` page it is invoked on and never navigates. On any other host (the tools are not listed there, see URL patterns) it returns `wrong_page` without a request. A call takes 1 to 5 s; `timeoutSec: 60` is plenty. Every request the tools make is a `GET` to `www.amazon.com` with the page's own cookies, and nothing is written. Amazon's own page scripts still send their usual telemetry while a page is open, and in a signed-in browser these fetches count as ordinary browsing and search activity on that account.

What the tools never do: add to a cart or list, buy, sign in, create an account, change the delivery location, open any account, order, address or payment page, or read the account name or delivery-location label.

Conventions:

- Products are identified by `asin`, Amazon's 10-character item id (the `/dp/<asin>` part of a product address). A product with variations has one asin per option combination; `get_product` lists them and `variant_filter` narrows large families, for example `{"Size": "32 Ounces"}`.
- Prices are integer US cents plus the site's own wording (`price_text`). `price_cents` is null when a card or page shows no price (a "see options" card, a variation parent, an unavailable item).
- `search_products` sorts are the site's Sort menu: `relevance` (Featured), `price_low_to_high`, `price_high_to_low`, `highest_rated`, `newest`, `bestselling`. Keywords do not filter; to restrict brand, rating, delivery, seller, condition or department, call with `include_facets: true` and pass option ids in `facet_ids`, one per group. `min_price_cents`/`max_price_cents` use the same price filter the site does, which filters on the price before any discount, so a returned `price_cents` can be below the minimum (the struck-through `list_price_cents` is the one inside the bounds).
- Failures are explicit: `status: "error"` with `error_kind` (`invalid_input`, `wrong_page`, `challenge`, `access_gated`, `rate_limited`, `login_required`, `not_found`, `filter_not_applied`, `site_changed`, `site_error`) and a message that says nothing was changed. Empty search results are `status: "no_results"` with a reason.
- Prices, delivery wording and availability depend on the delivery location of the browser session. The tools neither read nor change it and do not return its label; QA and comparisons should fix a location first.

## Site quirks

- **Conditions of Use gate for automated access.** Amazon can answer a request with a page reading "Continued access by an unauthorized AI agent violates Amazon's Conditions of Use" and a Continue button instead of the requested page. It was seen once on 2026-09-29 for fetched results in a plain local Chromium (a datacenter address, not a Kernel stealth browser) while the same tab's homepage loaded normally, and never in the Kernel stealth browsers used for the live checks. The tools report it as `access_gated`, return no data and never click, accept or dismiss it; a person has to decide about it in the browser. It is a policy notice, not a rate limit, so retrying does not help.
- **Unknown filter ids.** Amazon drops an id from an unknown filter group and shows results for the filters it kept (unfiltered results when nothing was kept). It echoes the filters it kept in hidden `rh` form fields, and `search_products` compares those with what was requested and returns `filter_not_applied`, naming the dropped ids, instead of results that are not filtered as asked. An unknown option value inside a known group is not dropped: Amazon returns zero results, which is `no_results` with reason `no_matches`. If a page lacks those fields, the site's own "Selected filters" summary is the only signal.
- **Server-rendered results differ from the live tab.** Ad placements are inserted by page scripts, so the fetched page has fewer or different sponsored cards than a tab shows, and the order of organic results can differ slightly. The size of the fetched page also varies between calls and queries (16 to 60 cards were seen, and sponsored cards appeared in some fetches and not in others), so `products` is what the server sent for that request, not always a full 48.
- **Best Sellers pages hold 30 of every 50 ranks.** Ranks 1-30 (page 1) and 51-80 (page 2) are in the page; ranks 31-50 and 81-100 load through page scripts and are not returned, so `rank` is not contiguous. The department list is `/gp/bestsellers`; category paths look like `kitchen` or `kitchen/289913`. An unknown category node answers HTTP 200 with no products and a "Best undefined" title, which the tool reports as `not_found`.
- **Result counts.** The site words large totals as "over 40,000 results" (`total_is_lower_bound` is true then), mid-size ones as "1-48 of 185 results" and small ones as "31 results". Pagination often stops at 7 pages; a page past the end still carries the "No results" wording plus a count, and is returned as `no_results` with `page_out_of_range`. A results page with no count but the "No results" wording is `no_matches`, even if it shows recommended products.
- **Buy-box price text.** In the server-rendered product page the accessible price text of the buy box is blank (page scripts fill it in), while the visible price parts are present; `get_product` composes `price_text` from the symbol, whole and fraction parts, and from the accessible text when it is there. An incomplete price is returned as null rather than guessed.
- **Variation parents.** `/dp/<parent asin>` answers with a page that has no price, availability or buy box; `get_product` returns those fields as null and `is_variation_parent: true`. Pick a child from `variants`.
- **Card text can contain script and style text.** The tools read text without script and style elements.
- **Prime.** The tested sessions showed "Join Prime" wording and never a Prime badge on a card, so there is no Prime flag; Prime delivery wording is only available inside `delivery_text`.

## Known limitations

- No cart, account, order, address, payment, review, offers or wish-list tools; the reviews page requires sign-in, and no cart mutation was exercised. Adding `get_cart` needs a populated cart shape established without changing an account.
- `search_products` returns one page (the products the fetched page holds, at most `limit`, never more than 60) per call; `page` goes up to 20 but Amazon often ends at 7. Facet lists return at most 30 groups and 25 options per group, and skip options already applied.
- `get_best_sellers` cannot return ranks that load through page scripts (see Site quirks).
- `get_product` returns at most 10 bullets, 100 option texts per dimension and 200 variations; it does not return per-variation prices or availability (call it again with the variant's asin), reviews, questions, specifications, images or other sellers.
- Robot-check handling (`challenge`) and the sign-in redirect are covered by fixture tests only; no robot check appeared in the live checks and none was provoked. `access_gated` was observed live once (see Site quirks) and is otherwise covered by fixtures. Amazon's stronger bot defences under heavy use are untested. Keep call volume low.
- Only the US storefront (`www.amazon.com`) was inspected. Other Amazon country sites are different registrable domains and are not covered.
- Live QA used a small number of query and product examples; category, brand and layout variants beyond them are covered by fixtures only.

## URL patterns

All three tools use `["https://www.amazon.com/*"]` instead of the default `["https://amazon.com/*", "https://*.amazon.com/*"]`. `amazon.com` hosts unrelated products on other subdomains (AWS, Seller Central, Pharmacy, Music, the developer portal and more). The shopping tools issue relative requests, so registered on those hosts they would query the wrong site; a page tool cannot navigate the tab away to fix that. The shopping site, Fresh and Whole Foods storefronts, and Amazon's sign-in all live on `www.amazon.com`, and `amazon.com` redirects there. With the narrowed patterns the tools are simply not listed on other Amazon hosts. If a runtime registers a tool on another host's top document because an embedded `www.amazon.com` frame matched, the tool returns `wrong_page`.

## QA summary

Not yet independently reviewed; all three tools are `draft`.

Builder checks (2026-09-29, signed out, US, Kernel stealth browsers, all three files registered together as namespace `amazon.com` through the Kernel API and invoked through the WebMCP API):

- `search_products`: keyword search from the homepage with `include_facets` (25 groups, exact rating counts, badges, delivery wording); brand facet id plus price bounds plus low-to-high sort returned the site's own "Selected filters" summary and prices inside the bounds in that check; an unknown facet group returned `filter_not_applied`; a nonsense query returned `no_matches`; page 20 of a filtered query returned `page_out_of_range` with the total.
- `get_product`: a variation child, its family parent (`is_variation_parent`, null price, no buy box), a discounted item (list price), a plain item, a third-party-seller item, `variant_filter` narrowing 117 variations to one, an unknown variation name (`invalid_input`) and an unknown ASIN (`not_found`).
- `get_best_sellers`: the department list, a department (ranks 1-30) and a subcategory page 2 (ranks 51-80), and an unknown category node and an unknown department (`not_found`).
- Starting pages: homepage, a product page, a Best Sellers page, `/cart` and the sign-in page all work and leave the tab URL unchanged; the tools are not listed on `aws.amazon.com` or an unrelated site; a tool reference from an earlier page is rejected after navigation.
- Largest outputs seen: 40 KB (48 products with all filter groups), 18 KB (117 variations), 14 KB (a full Best Sellers page), each in under 3 s.
- Fixture tests in `tests/amazon-shopping.test.mjs` (fabricated pages shaped like the observed markup) cover input validation before any request, every output branch against its schema, request construction for sorts, price bounds, paging and filters, that only `GET` requests to `www.amazon.com` are made, and that the delivery-location label never appears in output. Several of the live checks above found real defects that the fixtures now cover (total-count wordings, out-of-range pages, blank buy-box price text, glued delivery text).
