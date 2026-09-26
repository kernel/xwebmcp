# target.com

Tools for Target (https://www.target.com): catalog search, item details and a reversible cart.

| tool | file | status | notes |
|------|------|--------|-------|
| get_store_context | [get_store_context.js](get_store_context.js) | draft | Read-only store, location and session type; never changes the store |
| search_products | [search_products.js](search_products.js) | draft | One results page with the site's sorts, sponsored flags and optional facet filters |
| get_product | [get_product.js](get_product.js) | draft | Price, rating, limit, variations and fulfillment for the selected store |
| get_cart | [get_cart.js](get_cart.js) | draft | Regular cart lines with cart_item_id, fulfillment and totals; guest or signed in |
| add_to_cart | [add_to_cart.js](add_to_cart.js) | draft | Ship or pickup at the selected store after existence, variation, stock and limit checks |
| update_cart_item | [update_cart_item.js](update_cart_item.js) | draft | Absolute quantity 1–10 on one line; no write when unchanged |
| remove_cart_item | [remove_cart_item.js](remove_cart_item.js) | draft | Removes one line and returns it so it can be re-added |

## Native WebMCP tools

Target registers its own WebMCP tools (checked 2026-09-26 with `webmcp.listTools()`, signed
out):

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

## Scope and loading

Register all seven files together under namespace `target.com`; they are CDP-backed and use
the default patterns `https://target.com/*` and `https://*.target.com/*`.

```javascript
const names = ["get_store_context", "search_products", "get_product", "get_cart", "add_to_cart", "update_cart_item", "remove_cart_item"];
const fs = await import("node:fs");
const tools = names.flatMap(n => (0, eval)("(" + fs.readFileSync(`domains/target.com/${n}.js`, "utf8") + ")"));
await webmcp.addCustomTools({ namespace: "target.com", tools, forceOverwriteNamespace: true });
const tab = (await currentTab()).targetId;
const tool = (await webmcp.listTools()).find(t => t.source.custom?.namespace === "target.com" && t.tool.name === "search_products" && t.source.target_id === tab);
const result = await webmcp.invokeTool(tool.tool_ref, { query: "water bottle", sort_by: "bestselling" }, { timeoutSec: 60 });
```

Every tool works from any page. When the attached tab is not an ordinary `www.target.com`
page (another site, `about:blank`, or a Target checkout, sign-in, account or orders page) the
tool opens `https://www.target.com/` first; it never opens any other URL. The API calls are
made with `fetch` from that page, so they carry the site's own cookies and the request
signing that Target's scripts attach, and go only to `redsky.target.com` (catalog) and
`carts.target.com` (cart). Nothing is sent anywhere else. A call takes 1–15 s; `timeoutSec: 60`
is enough, 90 for `add_to_cart`, which makes four requests.

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
- Failures are explicit: `status: "error"` with `error_kind` (`invalid_input`, `not_found`,
  `variant_required`, `unavailable`, `quantity_limit`, `no_store`, `challenge`, `site_error`)
  and a message that says whether anything changed.

## Site quirks

- **Bot protection.** Target runs PerimeterX. A burst of API calls from one browser (around
  twenty within a few seconds while building these tools, several with malformed parameters)
  made every `redsky` call answer HTTP 435 with an "Access to this page has been denied" page,
  and the tab then showed a "Press & hold" verification. The tools make as few calls as
  possible (search 1, product 2, add 4), report HTTP 435/429, HTML 403 and the block page as
  `challenge`, and never retry a write. A person has to complete the verification in the
  browser; the tools do not attempt it.
- **Request signing.** Cart writes from the site carry F5 Shape headers (`X-GyJwza5Z-*`) that
  the page's scripts add to every `fetch`. That is why the tools call from a loaded
  `www.target.com` page rather than from the CDP side.
- **Store context.** The selected store comes from the `fiatsCookie` cookie
  (`DSI_<id>|DSN_<name>|DSZ_<zip>`), the shipping location from `GuestLocation`, and the
  visitor id from `visitorId`. The session type is the `sut` claim of the `idToken` cookie
  (`G` guest, `R` registered); only that claim is read and the token is never returned.
  Backup store ids come from `__TGT_DATA__.serverLocationVariables` on server-rendered pages
  and fall back to the selected store alone.
- **Guest carts.** A signed-out browser has a guest cart tied to its cookies; it answers HTTP
  204 until the first add. Removing the last line leaves an empty cart record with a
  `cart_id`, which the site offers no way to delete; `get_cart` then reports that id with no
  lines.
- **Ratings sort.** The site's "Guest rating" sort (`highest_rated`) orders by average stars,
  so an item with one 5-star review can outrank one with thousands of 4.8 reviews. Results
  include `rating_count`.
- **Sponsored results.** The results grid includes sponsored items, flagged `sponsored`;
  under `relevance` they are often first. `exclude_sponsored` drops them.

## Known limitations

- Pickup is only offered at the store the session already has selected; there is no way to
  choose another store, by design. Same-day delivery (Shipt) and scheduled delivery are shown
  in `get_product` but cannot be chosen in `add_to_cart`.
- `search_products` returns one page (at most 24 items) per call; `page` goes up to 20.
- `get_product` returns at most 100 variations and six highlights; it does not return
  reviews, specifications or Q&A.
- `get_cart` reads the regular cart only; saved-for-later items and gift options are not
  returned. `estimated_total_cents` is the site's estimate for its default location; the real
  total is only known at checkout, which these tools never open.
- `update_cart_item` accepts 1–10, the range of the site's own quantity menu.
- Signed-in carts: every cart path was exercised on a guest cart only. A signed-in account's
  cart uses the same endpoints with the account's cookies, but no signed-in session was used.
- The tools stop at a PerimeterX challenge; they cannot get past it.
- Status is `draft`: live checks so far were made by the builder only (see below).

## QA summary

Builder live checks on 2026-09-26, guest session, one dedicated anonymous browser:

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

The fixture tests in `tests/target-shopping.test.mjs` cover input validation before any page
access, page routing (including never opening checkout), challenge handling, the store
context, every output branch against its schema, and that cart writes touch only the named
line.

## URL patterns

Default patterns; no narrowing is needed because every tool belongs to the one Target
shopping site.
