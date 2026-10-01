# target.com

Tools for Target (https://www.target.com): catalog search, item details, per-store availability, guest ratings and reviews, and a reversible cart.

| tool | file | status | notes |
|------|------|--------|-------|
| get_store_context | [get_store_context.js](get_store_context.js) | qa_passed | Read-only store, location and session type; never changes the store |
| search_products | [search_products.js](search_products.js) | qa_passed | One results page with the site's sorts, sponsored flags and optional facet filters |
| get_product | [get_product.js](get_product.js) | qa_passed | Price, rating, limit, variations and fulfillment for the selected store |
| check_store_availability | [check_store_availability.js](check_store_availability.js) | verified | Pickup, Drive Up and in-store status at the stores nearest any ZIP; never selects a store or saves the ZIP |
| get_product_reviews | [get_product_reviews.js](get_product_reviews.js) | verified | Rating summary and up to 8 newest reviews at item-family level; no reviewer names, photos or AI summary |
| prepare_cart_item | [prepare_cart_item.js](prepare_cart_item.js) | verified | Read-only quantity/fulfillment preview; requires the exact selected store and ZIP; no cart change or checkout approval |
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
page or `/cart`. A fresh homepage check on 2026-09-30 again listed only native
`search_products`; none of the three additions duplicates it.

The custom `search_products` shares its name with the native tool but lives in the
`target.com` custom namespace, so both are listed; pick the custom one by
`source.custom.namespace`. The custom tool returns the results as data instead of driving the
page, adds the site's `bestselling` and `Featured` sorts (the native tool's enum omits them
although the site's Sort menu and search API offer them), and accepts the same facet filters
by id.

## Execution kind

All ten tools are `kind: "page"`. They read cookies and page configuration; service calls use
`fetch` from the document the tool is invoked in. `get_store_context` needs no request. None navigates
the tab, so none needs to survive a navigation and none qualifies for `cdp`.

## Scope and loading

Register all ten files together under namespace `target.com`; they use the default patterns
`https://target.com/*` and `https://*.target.com/*`.

```javascript
const names = ["get_store_context", "search_products", "get_product", "check_store_availability", "get_product_reviews", "prepare_cart_item", "get_cart", "add_to_cart", "update_cart_item", "remove_cart_item"];
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

### Fulfillment preparation and action safety

`prepare_cart_item` requires `tcin`, `quantity` (1–10), `fulfillment` (`ship` or `pickup`),
`expected_store_id` and `expected_postal_code`. Get those last two from `get_store_context`
(use `location.postal_code`, falling back to `store.postal_code` only when the location has
no ZIP). The tool checks them before any request and again before returning. A mismatch
returns `context_mismatch`; it does not silently choose a store or change the shipping ZIP.
It reads the existing product and fulfillment services, without navigating, and reports
`prepared`, `cart_changed: false`, an item-only price estimate, limit and current fulfillment
dates, plus a canonical `product_url` for human review. Two GETs, no cart or account reads.
A family tcin requires choosing a variation; unavailable fulfillment or an excessive
per-order quantity is refused. Cancellation stops before interaction or between reads.

This is not a stock reservation, final checkout quote or approval. It does not check the
quantity already in the cart and cannot establish that multiple units are available. Read
`get_cart` before a separately requested cart action. The existing cart tools remain
unchanged; repeated `add_to_cart` calls increment rather than deduplicate. Never retry an
uncertain write automatically: inspect the cart first. Current store/ZIP must be reviewed
again before a later action because a preview does not bind the state of another invocation.
No live cart, wishlist or setting was changed in the current QA; action behavior is not
claimed from the preview's read-only success. The earlier guest-cart tests below are historical.

Checkout/payment execution remains unshipped: the runtime does not provide trusted human
approval bound to the exact account, item, quantity, cost and terms. A model-supplied
confirmation field is not approval. The preview rejects extra fields, including `confirmed`,
and never invokes an action after preparation. Final purchase review and submission belong
in the site's human UI.

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
- `check_store_availability` takes the `tcin` of an orderable item (a variation, not a family), an optional `postal_code` (default: the ZIP the session already uses), `radius_miles` (1–100, default 50) and `limit` (1–20 nearest stores, default 10). Each store has `available_to_promise` (the site's unit count for the store, 0–10 seen), and `pickup`, `curbside` (Drive Up) and `in_store` with the site's raw `status` (`IN_STOCK`, `LIMITED_STOCK`, `OUT_OF_STOCK`, `NOT_SOLD_IN_STORE`, `UNAVAILABLE`) and an `available` flag; `pickup` and `curbside` add the pickup `date` and `ready_in_minutes`. `is_selected_store` marks the session's own store. `no_results` means no store within the radius; `no_availability` means Target answered with no fulfillment data, which was seen only for an item family; an item a store does not sell answers `ok` with `available_to_promise` 0 and in-store `NOT_SOLD_IN_STORE`.
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
- **Availability counts and quantity.** The service returns a per-store available-to-promise count, which the tool passes through as `available_to_promise`. Values 0–10 were seen; 10 is the largest and looks like a cap (47 of 106 positive counts in independent QA's sample equal 10 and none exceed it), so compare the count with the units you need only up to 10. Target.com shows low counts on a product page as "Only N left" (seen for counts of 1 and 3). In the builder's 60 store rows from two items, a count of 0 always came with in-store `OUT_OF_STOCK` and a positive count with in-store `IN_STOCK`. Independent QA's larger sample (164 store rows, six items) found all 58 rows with a count of 0 in-store `OUT_OF_STOCK` or `NOT_SOLD_IN_STORE`, and 105 of 106 positive counts `IN_STOCK`; the exception was one store with a count of 1 and in-store `LIMITED_STOCK`. The count is not tied to the pickup status: counts of 2, 3 and 4 appeared with both `IN_STOCK` and `UNAVAILABLE` pickup. The request's `requested_quantity` had no effect: statuses and counts for 1 and 10 units were identical, including for stores whose count was 3, so the tool always sends 1 and offers no quantity input. The `include_only_available_stores` flag did not change the list in a live check either, so the tool always sends `false`, as the site's dialog does.
- **In-store status versus the page.** `in_store` is the availability service's answer. For one item `NOT_SOLD_IN_STORE` (count 0) came with a product page that still read "In stock | Visit store to purchase" for that store, so the two can disagree.
- **Non-ASCII output on the Kernel API.** When a tool's output contains some non-ASCII characters (`é`, `®`, `ü`, a non-breaking space; observed with a review text), the Kernel API returned `output` as a JSON string instead of an object (it parses and conforms to the schema); `’`, `™`, `€`, `—` and emoji came back as objects, and the local extension returned an object in the same case. This is runtime behavior, not tool behavior, and any tool that returns shopper text can hit it: parse a string `output` before use.
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
- `check_store_availability` covers pickup, Drive Up and in-store status only: no shipping or store hours and no per-quantity request (the site returns the same statuses and counts for any quantity; compare `available_to_promise` with the units needed), and it cannot choose a store. Unrecognized ZIPs return default-location stores without an error (see Site quirks). Limit 20 stores; radius 1–100 miles. Seen live: pickup and Drive Up `IN_STOCK`, `OUT_OF_STOCK` and `UNAVAILABLE`; in store `IN_STOCK`, `LIMITED_STOCK`, `OUT_OF_STOCK` and `NOT_SOLD_IN_STORE`; pre-order statuses are passed through but untested. `available_to_promise` is null when the site omits it.
- `get_product_reviews` returns only the newest reviews the product service includes (at most 8): no paging, sorting, filtering, reviewer names, photos, review-level recommend flags or Target's AI-written summary, whose service was not identified. It needs a selected store, and its numbers are for the whole item family.
- `get_cart` reads the regular cart only; saved-for-later items and gift options are not
  returned. `estimated_total_cents` is the site's estimate for its default location; the real
  total is only known at checkout, which these tools never open.
- `prepare_cart_item` uses the session's current pricing store and ZIP only. It does not
  choose other stores, check cart-wide purchase limits, apply coupons, read membership
  benefits, compute taxes/shipping, or support same-day delivery/time slots. It never
  guarantees stock or authorizes a subsequent action. Range/missing prices return null.
- Account orders and populated wishlist items lack authorized populated-response evidence;
  no order/list mutations, wishlist writes, store/ZIP preference changes, holds or checkout
  execution are supplied. No new login or account mutation was performed for this increment.
- `update_cart_item` accepts 1–10, the range of the site's own quantity menu.
- Signed-in cart mutations were not exercised. Historical signed-in discovery confirmed an
  empty `get_cart` read only; populated account carts and wrong-account cases remain unverified.
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

Builder checks for `check_store_availability` and `get_product_reviews` on 2026-09-29, on fresh anonymous GPU stealth
Kernel browsers with the whole nine-tool namespace registered at once with `forceOverwriteNamespace` and no write tool
invoked (the signed-in and local-extension runs are the last two bullets):

- `check_store_availability` from a product page and from `/cart`: the session's default ZIP, an explicit ZIP,
  `radius_miles` 1, `limit`; pickup `IN_STOCK`/`UNAVAILABLE`, Drive Up `IN_STOCK`/`UNAVAILABLE` and in-store
  `IN_STOCK`/`LIMITED_STOCK`/`OUT_OF_STOCK`/`NOT_SOLD_IN_STORE` statuses across 20 stores, with `available_to_promise`
  matching the raw service counts; `no_availability` for an item family, `not_found` for an unknown tcin,
  `invalid_input` for a four-digit ZIP or a `quantity` key.
- `get_product_reviews` for a variation and its family (same family numbers, `reviewed_tcin` differs), `limit`, an unrated
  item (`no_reviews`), an unknown tcin (`not_found`), and `limit: 9` (`invalid_input`); no HTML entities or tags were
  found in the review text of three families.
- Both tools answered `wrong_page` on `corporate.target.com` and were not listed on example.com. The tab URL and the
  store and location cookies were identical before and after the product-page calls, and the tab URL was unchanged
  after the calls from `/cart`. The existing `get_store_context`, `get_cart` and `search_products` still ran after
  the namespace was re-registered.
- One read-only run of both tools in a signed-in (registered) session on the same day returned `ok`, with the store and
  location cookies and the tab URL unchanged; no account data is recorded here.
- Local Chrome extension (scratch Chromium 153 profile, guest, site access granted in its permission dialog, tools installed
  with `xwebmcp add` at the reviewed commit and invoked through `xwebmcp mcp` with `open_tab`): both tools were listed next to
  the site's native `search_products` and returned the same shapes and values as on the Kernel browser.
- Not live-tested: pre-order statuses, the `challenge` outcome, wrong-account behavior, `no_store` and `no_location` (fixtures only), and counts of 4–9 against the "Only N left" text.

Independent QA (agent `agt_42e61f3b686a87d4bfb7`) reviewed three revisions on 2026-09-29 and did not sign off on any. It
found a real quantity-semantics defect in the first revision and documentation/test gaps later;
its live Kernel and local-extension runs otherwise matched the builder's. The first revision
offered a `quantity` input the site ignores (removed);
the second and third had documentation overclaims about availability counts, item-not-sold behavior and untested cases (all
corrected). The last correction pass (wording, one error message, the `in_store` description and a test) was made after the
final review round and was not re-reviewed in that pass.

### Current increment (2026-09-30)

The availability and reviews additions now support cancellation, sanitize request/site error
messages rather than echoing raw errors, report JSON 401/403 as denied session access, and
reject malformed store lists/product objects instead of reporting empty results. Availability
status/date text is bounded and invalid distances/timing are nulled. `prepare_cart_item` is
new; the original seven tools are byte-identical to the base.

Builder Kernel checks, a fresh anonymous GPU browser, whole ten-tool namespace registered
atomically: native discovery, shipping and pickup previews for one item from the homepage
(a page other than its product entry point), explicit-ZIP store availability and one recent
review returned success. Selected-store/location cookies and tab URL were unchanged. No
cart writes were invoked. Additional builder failure checks passed for mismatched store/ZIP,
extra confirmation input (zero requests), excessive quantity (one GET), unknown item, rural
`no_results`, corporate `wrong_page` and unrelated-site discovery. The empty guest cart read
still worked; no writer was invoked.

Independent final-source QA by `agt_42e61f3b686a87d4bfb7` passed on 2026-09-30 for source SHA
`704744779080338119b01bb377f443d672480a65`, after one fix/recheck round. The initial increment
review found three fixture-only defects (stale-context second GET, Unicode range estimates,
empty data-array classification); all reproductions passed after the fixes. The 69 independent
scratch checks, 1769-test full Node suite, 82-tool validator, extension sidepanel and Go suites
passed. No concrete defect remained. All three additions qualify for `verified`; metadata-only
status/evidence updates leave the reviewed tool source unchanged.

- **Kernel, fresh anonymous browser:** all ten tools registered atomically. From the homepage,
  `prepare_cart_item` for `95060636`, shipping quantity 1, returned `prepared` with a 6999-cent
  item estimate, limit 2 and `cart_changed: false`; `check_store_availability` with limit 2
  returned `ok`; `get_product_reviews` with limit 1 returned `ok`, family `95289882`. Pickup
  was `unavailable` at that browser's selected store. Quantity/family/unknown/unrated/unavailable
  failures, zero-request context/input guards, corporate refusal and unrelated-site discovery
  passed. Across 26 recorded calls, schema validation passed, URL/context cookies stayed
  unchanged, new-tool requests were GET-only, and no writer was invoked. Native tools were
  absent in this session; string-form review output parsed correctly.
- **Local extension, separately pinned to the same SHA:** scratch Chromium 153, entire
  ten-tool namespace. Native `search_products` present. Homepage shipping and pickup previews
  and reviews succeeded. Availability gave `no_results` for its own guest ZIP, then `ok` for
  explicit ZIP `10001` without changing location. Guards, quantity/family/not-found failures,
  corporate refusal and unrelated-site discovery passed; outputs validated and URL/context
  cookies stayed unchanged. Its guest location differed from Kernel, so identical store/date
  values are not claimed.
- **Fixture-only:** cancellation, context drift, malformed/denied/challenge responses and
  range/hidden prices. **Untested live:** signed-in/wrong-account behavior, preorders, checkout
  guards and long-review truncation. No mutation success is claimed. Both current QA browsers
  were deleted and their artifacts removed; local scratch Chromium/Xvfb and profiles were cleaned up.

`tests/target-preparation.test.mjs` uses fabricated data for explicit context/missing location
guards, malformed input before page access, unrelated and checkout pages, family/variation
identity, price bounds, purchase limits, missing/unavailable fulfillment, canceled requests,
challenge/denied/malformed responses, sanitized errors and GET-only requests. It tests no
live mutation. Account identity and signed-in mutation success are not claimed.

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
