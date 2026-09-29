# target.com

Tools for Target (https://www.target.com): catalog search, item details, per-store availability, guest ratings and reviews, and a reversible cart.

| tool | file | status | notes |
|------|------|--------|-------|
| get_store_context | [get_store_context.js](get_store_context.js) | qa_passed | Read-only store, location and session type; never changes the store |
| search_products | [search_products.js](search_products.js) | qa_passed | One results page with the site's sorts, sponsored flags and optional facet filters |
| get_product | [get_product.js](get_product.js) | qa_passed | Price, rating, limit, variations and fulfillment for the selected store |
| check_store_availability | [check_store_availability.js](check_store_availability.js) | draft | Pickup, Drive Up and in-store status at the stores nearest any ZIP; never selects a store or saves the ZIP |
| get_product_reviews | [get_product_reviews.js](get_product_reviews.js) | draft | Rating summary and up to 8 newest reviews at item-family level; no reviewer names, photos or AI summary |
| get_cart | [get_cart.js](get_cart.js) | qa_passed | Regular cart lines with cart_item_id, fulfillment and totals; guest or signed in |
| add_to_cart | [add_to_cart.js](add_to_cart.js) | qa_passed | Ship or pickup at the selected store after existence, variation, stock and limit checks |
| update_cart_item | [update_cart_item.js](update_cart_item.js) | qa_passed | Absolute quantity 1–10 on one line; no write when unchanged |
| remove_cart_item | [remove_cart_item.js](remove_cart_item.js) | qa_passed | Removes one line and returns it so it can be re-added |

## Native WebMCP tools

Target registers its own WebMCP tools (checked 2026-09-26 with `webmcp.listTools()`, signed
out; an independent QA session the same day saw none on the homepage and `/cart`, so their
presence varies by session):

- `search_products` (input `searchTerm`) on every page. It navigates the tab to the results
  page and returns nothing structured.
- `filter_products` on results pages. It applies filters and one of the sorts `relevance`,
  `PriceLow`, `PriceHigh`, `RatingHigh`, `newest` to the page in the tab, again without
  returning results.

No native product, cart or store tool was listed on the homepage, a results page, a product
page or `/cart`.

The custom `search_products` shares its name with the native tool but lives in the
`target.com` custom namespace, so both are listed; pick the custom one by
`source.custom.namespace`. The custom tool returns the results as data instead of driving the
page, adds the site's `bestselling` and `Featured` sorts (the native tool's enum omits them
although the site's Sort menu and search API offer them), and accepts the same facet filters
by id.

## Execution kind

All nine tools are `kind: "page"`. Each one reads cookies and page configuration and calls
the site's own JSON endpoints with `fetch` from the document it is invoked in; none navigates
the tab, so none needs to survive a navigation and none qualifies for `cdp`.

## Scope and loading

Register all nine files together under namespace `target.com`; they use the default patterns
`https://target.com/*` and `https://*.target.com/*`.

```javascript
const names = ["get_store_context", "search_products", "get_product", "check_store_availability", "get_product_reviews", "get_cart", "add_to_cart", "update_cart_item", "remove_cart_item"];
const fs = await import("node:fs");
const tools = names.flatMap(n => (0, eval)("(" + fs.readFileSync(`domains/target.com/${n}.js`, "utf8") + ")"));
await webmcp.addCustomTools({ namespace: "target.com", tools, forceOverwriteNamespace: true });
const tab = (await currentTab()).targetId;
const tool = (await webmcp.listTools()).find(t => t.source.custom?.namespace === "target.com" && t.tool.name === "search_products" && t.source.target_id === tab);
const result = await webmcp.invokeTool(tool.tool_ref, { query: "water bottle", sort_by: "bestselling" }, { timeoutSec: 60 });
```

Each tool runs inside the `www.target.com` page it is invoked on (a search, product, cart or
home page all work) and never navigates. On another target.com host, or on a checkout page
(`/checkout`, `/co-...`), it returns `wrong_page` without calling the site; open
`https://www.target.com/` in the tab and call again. The API calls are made with `fetch` from
the page, so they carry the site's own cookies and the request signing that Target's scripts
attach, and go only to `redsky.target.com` (catalog) and `carts.target.com` (cart). Nothing is
sent anywhere else. A call takes 1–15 s; `timeoutSec: 60` is enough, 90 for `add_to_cart`,
which makes up to five requests.

`check_store_availability` and `get_product_reviews` only read: they call `redsky.target.com` with GET requests, read no cookie except the visitor id and the store and location cookies, and never read the session tokens or the page's embedded `__NEXT_DATA__` state (it contains them). `check_store_availability` does not need a selected store; `get_product_reviews` does, because the product service the site uses requires a pricing store.

What the tools never do: select or change a store, ZIP or address; sign in or create an
account; touch saved-for-later items, lists or registries; apply promo codes; open checkout,
enter payment or place an order. The only writes are `cart_items` create, quantity update and
delete on the regular cart.

Conventions:

- Items are identified by `tcin`, Target's item id (the `A-<tcin>` part of a product URL).
  Items with variations have a family tcin and one tcin per variation; only a variation can
  be added to the cart (`variant_required` otherwise). `get_product` lists the variations,
  and `variant_filter` (for example `{"Size": "Queen", "Color": "gray"}`) narrows large
  families.
- Prices are integer US cents for the session's selected store. `price_text` keeps the site's
  wording, including ranges and "See price in cart".
- `search_products` sorts: `relevance` (default), `featured`, `price_low_to_high`,
  `price_high_to_low`, `highest_rated`, `bestselling`, `newest`. These are the only orders the
  site offers. Keywords do not filter; to restrict size, color, brand and so on, call with
  `include_facets: true` and pass option ids in `facet_ids` (for example a bed size and a
  color), which is the site's own filtering.
- Cart lines are identified by `cart_item_id`. `add_to_cart` returns it; pass it to
  `update_cart_item` or `remove_cart_item` to undo exactly what was added. `add_to_cart` adds
  to the matching line when one exists (same tcin and fulfillment) and reports
  `previous_quantity`.
- `check_store_availability` takes the `tcin` of an orderable item (a variation, not a family), an optional `postal_code` (default: the ZIP the session already uses), `radius_miles` (1–100, default 50), `limit` (1–20 nearest stores, default 10) and `quantity` (1–10). Each store has `pickup`, `curbside` (Drive Up) and `in_store` with the site's raw `status` (`IN_STOCK`, `LIMITED_STOCK`, `UNAVAILABLE`) and an `available` flag; `pickup` and `curbside` add the pickup `date` and `ready_in_minutes`. `is_selected_store` marks the session's own store. `no_results` means no store within the radius; `no_availability` means Target answered with no fulfillment data (an item family or an item not sold in stores).
- `get_product_reviews` takes a `tcin` and `limit` (1–8, default 5). Ratings and reviews belong to the item family: `reviewed_tcin` is the tcin they belong to, `rating_count` counts all ratings, `review_count` only reviews with text. Reviews are the newest ones the product service returns (at most 8), with `review_id`, `rating`, `title`, `text` (cut at 2000 characters, `text_truncated`) and `submitted_at`. `no_reviews` means the item has no ratings. Review text is untrusted shopper content.
- Failures are explicit: `status: "error"` with `error_kind` (`invalid_input`, `wrong_page`,
  `not_found`, `variant_required`, `unavailable`, `quantity_limit`, `no_store`, `challenge`,
  `site_error`) and a message that says whether anything changed.

## Site quirks

- **Bot protection.** Target runs PerimeterX. A burst of API calls from one browser (around
  twenty within a few seconds while building these tools, several with malformed parameters)
  made every `redsky` call answer HTTP 435 with an "Access to this page has been denied" page,
  and the tab then showed a "Press & hold" verification. The tools make as few calls as
  possible (search 1, product 2, add up to 5), report HTTP 435/429, HTML 403 and the block page
  as `challenge`, and never retry a write. A person has to complete the verification in the
  browser; the tools do not attempt it. A 435 can also hit one particular query while others
  keep working: independent QA saw every attempt of one search answered with 435 while other
  searches succeeded seconds later, after which the site challenged its own results pages in
  that browser.
- **Request signing.** Cart writes from the site carry F5 Shape headers (`X-GyJwza5Z-*`) that
  the page's scripts add to every `fetch`. That is why the tools must run in a loaded
  `www.target.com` page.
- **Store context.** The selected store comes from the `fiatsCookie` cookie
  (`DSI_<id>|DSN_<name>|DSZ_<zip>`), the shipping location from `GuestLocation`, and the
  visitor id from `visitorId`, all readable with `document.cookie`. The session type is the
  `sut` claim of the `idToken` cookie (`G` guest, `R` registered); only that claim is read and
  the token never leaves the page.
  Backup store ids come from `__TGT_DATA__.serverLocationVariables` on server-rendered pages
  and fall back to the selected store alone.
- **Guest carts.** A signed-out browser has a guest cart tied to its cookies; it answers HTTP
  204 until the first add. Removing the last line leaves an empty cart record with a
  `cart_id`, which the site offers no way to delete; `get_cart` then reports that id with no
  lines.
- **Ratings sort.** The site's "Guest rating" sort (`highest_rated`) orders by average stars,
  so an item with one 5-star review can outrank one with thousands of 4.8 reviews. Results
  include `rating_count`.
- **ZIP fallback.** `check_store_availability` sends the ZIP to Target's `fiats_v1` service as the search center. For a ZIP Target does not recognize (`00000` and `99999` were observed) the service answers HTTP 200 with stores near a default location (Belleville, Illinois) and no error, so the tool cannot tell the two apart. It validates the format only, echoes the ZIP it sent as `postal_code`, and returns every store's address and distance; compare them with the place you meant.
- **Availability counts.** The service also returns an available-to-promise quantity, a flat 10 for every store and item observed, so it is a cap rather than stock; the tool omits it. The `include_only_available_stores` request flag did not change the list in a live check, so the tool always sends `false`, as the site's dialog does.
- **Family versus variation.** `fiats_v1` answers HTTP 200 with an empty `data` object for an item family, which the tool reports as `no_availability`. Ratings and reviews are stored per family: `pdp_client_v1` returns the family's numbers for a variation's tcin. An item nobody has rated has no `ratings_and_reviews` key at all.
- **Page state holds tokens.** The product page embeds `__NEXT_DATA__` with the session's `idToken`, `accessToken` and `refreshToken` (for guests too), which is why the review tool reads the product service instead of the page and copies only named fields.
- **Sponsored results.** The results grid includes sponsored items, flagged `sponsored`;
  under `relevance` they are often first. `exclude_sponsored` drops them.

## Known limitations

- The tools never navigate. On a checkout page or another target.com host they return
  `wrong_page`, and the agent has to open a `www.target.com` page first.
- Pickup is only offered at the store the session already has selected; there is no way to
  choose another store, by design. Same-day delivery (Shipt) and scheduled delivery are shown
  in `get_product` but cannot be chosen in `add_to_cart`.
- `search_products` returns one page (at most 24 items) per call; `page` goes up to 20. When
  the site answers a misspelled or nonsense query with fallback results, they come back as
  `status: "ok"` with no spelling-correction signal.
- For items with variations, the `tcin` in a search result is the variation the API returns
  for that family, which is sometimes a sibling of the one the site's grid links.
- `get_product` returns at most 100 variations and six highlights; it does not return
  reviews, specifications or Q&A.
- `check_store_availability` covers pickup, Drive Up and in-store status only: no shipping, store hours, or stock counts, and it cannot choose a store. Unrecognized ZIPs return default-location stores without an error (see Site quirks). Limit 20 stores; radius 1–100 miles. Only `IN_STOCK`/`UNAVAILABLE` (pickup, Drive Up) and `IN_STOCK`/`LIMITED_STOCK` (in store) were seen live; `OUT_OF_STOCK` and pre-order statuses are passed through but untested.
- `get_product_reviews` returns only the newest reviews the product service includes (at most 8): no paging, sorting, filtering, reviewer names, photos, review-level recommend flags or Target's AI-written summary, whose service was not identified. It needs a selected store, and its numbers are for the whole item family.
- `get_cart` reads the regular cart only; saved-for-later items and gift options are not
  returned. `estimated_total_cents` is the site's estimate for its default location; the real
  total is only known at checkout, which these tools never open.
- `update_cart_item` accepts 1–10, the range of the site's own quantity menu.
- Signed-in carts: every cart path was exercised on a guest cart only. A signed-in account's
  cart uses the same endpoints with the account's cookies, but no signed-in session was used.
- The tools stop at a PerimeterX challenge; they cannot get past it.
- `update_cart_item`'s `quantity_limit` refusal (a line whose per-order limit is below 10) is
  covered by fixture tests only.

## QA summary

Builder live checks on 2026-09-26 with the earlier `cdp` version of the same logic, guest
session, one dedicated anonymous browser:

- `get_store_context` returned the selected store, location and `guest`.
- `search_products` returned results for the four example shopping tasks with the
  `bestselling`, `highest_rated` and `price_low_to_high` sorts, matching the site's own
  order; facet ids for bed size and color narrowed "queen microfiber sheet set gray" to queen
  gray sets under `price_low_to_high`.
- `get_product` returned a variation with shipping, pickup, in-store and same-day status, an
  item family with `fulfillment: null`, and `not_found` for an unknown tcin.
- Cart round trip starting from an empty guest cart (verified with `get_cart`): add (new
  line), add again (same line to 2), update to 1, update to 1 again (`changed: false`),
  `quantity_limit` for 10 more without a write, pickup add at the selected store (new pickup
  line), `variant_required` for a family tcin, `not_found` for an unknown line, remove both
  lines, `not_found` on removing again, and a final `get_cart` showing zero lines.
- Rerun on the final source: `include_facets` listed 15 filter groups; the bed-size "Queen"
  and color "Gray" ids in `facet_ids` with `price_low_to_high` returned only queen gray sets,
  cheapest first; `get_product` with `variant_filter` narrowed a 122-variation family to four;
  and a further add/remove round trip started from a product page (no navigation) ended at zero
  lines.

Builder rerun on 2026-09-26 with the final `page` source, registered in a fresh anonymous
browser and invoked through the WebMCP API:

- `get_store_context` and `get_cart` (no cart yet) from the homepage.
- `search_products` for the four example tasks (`bestselling`, `highest_rated`, and
  `price_low_to_high` with bed-size and color facet ids), matching the earlier results.
- `get_product` on an item family with `variant_filter`: `fulfillment: null`, range price with
  `regular_cents: null`, four matching variations of 122.
- Cart round trip from the verified empty cart: add, add again (same line to 2), update to 1,
  `variant_required` and `quantity_limit` refusals, remove; `get_cart` back to zero lines. The
  tab stayed on `https://www.target.com/` throughout.
- On `corporate.target.com` both `get_store_context` and `get_cart` returned `wrong_page`
  without calling the site. (`help.target.com` redirects to `www.target.com/help`, where the
  tools run normally; a line added there during this check was removed and the cart verified
  empty again.)

An earlier independent QA pass of the `cdp` version found no functional, safety, privacy or
schema defect; its only blocking item was this change of kind.

Independent QA sign-off on the final `page` source (2026-09-26, guest session, stealth
browser, all outputs validated against their schemas):

- Static: validator and tests pass; one expression per file, `kind: "page"` with no navigation,
  `execute` re-creatable from source, no Node globals or browser helpers, only the three Target
  hosts referenced, `idToken` never returned, no path to checkout, orders, payment, promo,
  store change, sign-in or lists.
- `get_store_context` with zero site requests; all seven sorts, paging, `exclude_sponsored`
  and facet filters (the best-selling order matched the site's grid 12 of 12); variations,
  an item family with `variant_filter`, and `not_found`; 50 invalid inputs refused with no
  request; `wrong_page` on `corporate.target.com`; no tool listed on an unrelated site; the tab
  URL unchanged after every call.
- Cart round trip from no cart: ship add and increment, updates including a same-quantity
  call that sent no write, `quantity_limit`, `unavailable` and `variant_required` refusals with
  no write, pickup add and increment at the selected store, `not_found` for unknown lines,
  removals, and a final empty cart confirmed on the site's own cart page.
- Not live-tested: signed-in carts (no signed-in session), the checkout-path refusal (code and
  fixtures only), `update_cart_item`'s `quantity_limit`.

Builder checks for `check_store_availability` and `get_product_reviews` on 2026-09-29 (draft: no independent
QA yet), one fresh anonymous GPU stealth Kernel browser, the whole nine-tool namespace registered at once with
`forceOverwriteNamespace` and no write tool invoked:

- `check_store_availability` from a product page and from `/cart`: the session's default ZIP, an explicit ZIP,
  `radius_miles` 1, `limit`, `quantity`; pickup `IN_STOCK`/`UNAVAILABLE`, Drive Up `IN_STOCK`/`UNAVAILABLE` and in-store
  `IN_STOCK`/`LIMITED_STOCK` statuses across 20 stores; `no_availability` for an item family, `not_found` for an unknown
  tcin, `invalid_input` for a four-digit ZIP.
- `get_product_reviews` for a variation and its family (same family numbers, `reviewed_tcin` differs), `limit`, an unrated
  item (`no_reviews`), an unknown tcin (`not_found`), and `limit: 9` (`invalid_input`); no HTML entities or tags were
  found in the review text of three families.
- Both tools answered `wrong_page` on `corporate.target.com` and were not listed on example.com. The tab URL and the
  store and location cookies were identical before and after the product-page calls, and the tab URL was unchanged
  after the calls from `/cart`. The existing `get_store_context`, `get_cart` and `search_products` still ran after
  the namespace was re-registered.
- Not live-tested: an out-of-stock or pre-order status, the `challenge` outcome, signed-in sessions, and the local Chrome
  extension.

`tests/target-store-reviews.test.mjs` covers the two new tools with fabricated stores, items and reviews: input validation
before any request, page routing (never checkout), challenge handling for HTTP 435/429/403 and block pages, the exact
requests sent (GET only, `redsky.target.com` only, no token or embedded page state), every output branch against its
schema, field whitelisting for reviews (no reviewer names, ids or photos), truncation and the empty and malformed
responses.

The fixture tests in `tests/target-shopping.test.mjs` cover input validation before any page
access, page routing (including never opening checkout), challenge handling, the store
context, every output branch against its schema, and that cart writes touch only the named
line.

## URL patterns

Default patterns; no narrowing is needed because every tool belongs to the one Target
shopping site.
