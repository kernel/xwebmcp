# amazon.com

Tools for Amazon's US store (https://www.amazon.com): search, product details and Best Sellers, all read-only.

| tool | file | status | notes |
|------|------|--------|-------|
| search_products | [search_products.js](search_products.js) | verified | One results page with the site's sorts, price bounds and filters by id; ASIN, price, list price, rating, sponsored flag and delivery wording per product |
| get_product | [get_product.js](get_product.js) | verified | Price, availability, rating, bullets, shipper and seller, delivery wording and variations with the ASIN of each combination for one ASIN |
| get_best_sellers | [get_best_sellers.js](get_best_sellers.js) | verified | A department or category ranking (the ranks the page itself contains) and the categories to open next; without a category, the department list |

## Native WebMCP tools

Amazon registers none. `webmcp.listTools()` returned no tools on the homepage, a search results page, a product page, `/cart` and the Fresh storefront (checked 2026-09-29 signed out; a signed-in session showed the same result, which independent QA did not repeat). The browser exposes `document.modelContext.registerTool`, so the API exists; the site does not use it. These tools therefore do not collide with or duplicate native tools.

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
- `search_products` sorts are the site's Sort menu: `relevance` (Featured), `price_low_to_high`, `price_high_to_low`, `highest_rated`, `newest`, `bestselling`. Keywords do not filter; to restrict brand, rating, delivery, seller, condition or department, call with `include_facets: true` and pass option ids in `facet_ids`, one per group. `min_price_cents`/`max_price_cents` use the same price filter the site does, which can still return items whose shown price is outside the bounds (seen with discounted items; the cause is not established), so check `price_cents`. Bounds outside the range the site offers for the query are clamped (`applied_filters_text` shows what was applied).
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

Independent QA signed off all three tools on 2026-09-29 at the final tool source (the commit that introduced the last `domains/amazon.com/*.js` change), after two rounds of fixes. The first round found and the builder fixed: Amazon's AI-agent notice reported as `site_changed` or `not_found` instead of `access_gated`; `add_to_cart_available` false on a page whose control uses a second element id; a valid filter id hiding an ignored one (now checked per id against the site's own echo); a mislabelled price filter group; README and description inaccuracies; and test gaps found by mutation testing (75 of 76 mutants killed; the survivor is equivalent). The reviewer ran signed out on the Kernel runtime with the whole namespace registered atomically.

Live cases (2026-09-29, Kernel runtime, signed out, US), each invoked through the WebMCP API:

- Start pages: every tool from the homepage, a product page, a Best Sellers page, `/cart` and the sign-in page (15 of 15 calls); the tab URL and cart count never changed; the tools are not listed on `aws.amazon.com` or an unrelated site; a tool reference from an earlier page is rejected after navigation.
- `search_products`: all six sorts; price bounds; page 2 and `limit`; facet ids from two groups plus price bounds (results and the site's "Selected filters" summary narrowed as asked); an ignored filter id, alone or beside a valid one, returned `filter_not_applied` naming it; a nonsense query and a page past the end returned `no_results`; queries containing `&`, `#`, quotes and Unicode.
- `get_product`: a variation child, its parent, a discounted item, a plain item and a third-party-seller item; price, availability, rating, seller and delivery matched the live tab on two products; `variant_filter`, `max_variants`, an unknown variation name and an unknown ASIN.
- `get_best_sellers`: the department list, a department, a subcategory and its page 2, and unknown categories.
- 50 malformed inputs across the tools (including `__proto__` and wrong types) returned `invalid_input` with no request to Amazon; 44 live outputs validated against their `outputSchema`; a network log showed only `GET` requests to `www.amazon.com` from the tools; outputs contained no location label, session, cookie, CSRF or tracking strings; largest outputs were about 40 KB.

Builder checks that led to fixes: the live runs also found single-page totals worded "31 results", out-of-range pages that carry the "No results" wording, blank buy-box price text in the server HTML, and delivery messages glued together; the fixtures in `tests/amazon-shopping.test.mjs` now cover each.

Not tested: signed-in behaviour; other Amazon country sites; a real robot-check page; the `access_gated` notice on the Kernel runtime (it never appeared there; it was seen once in a plain local Chromium and is otherwise covered by fixtures); a currently unavailable product's add-to-cart control; and the success paths of all three tools in the local Chrome extension. In the extension only registration on the granted `www.amazon.com` tab, page-tool execution and typed error outcomes (validation errors and `access_gated`) were checked, so cross-runtime parity is not claimed.
