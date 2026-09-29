# myntra.com

Tools for Myntra (https://www.myntra.com), an Indian fashion, beauty and home retailer: public product search, product details and reviews. Everything works signed out.

| tool | file | status | notes |
|------|------|--------|-------|
| search_products | [search_products.js](search_products.js) | draft | One page of organic results with the site's sorts, `Group:Value` filters, a rupee price range and an opaque cursor; reports `query_substituted` when the site searches different words |
| get_product | [get_product.js](get_product.js) | draft | Price and MRP in rupees, every size with SKU id, availability and stock, seller, colour variants, attributes, description sections, images, return and cash-on-delivery flags; unknown ids return `not_found` |
| get_product_reviews | [get_product_reviews.js](get_product_reviews.js) | draft | Public reviews, 12 per page, most helpful or most recent, optional exact star filter; page 1 adds the rating summary; reviewer names are not returned |

## Native WebMCP tools

None found. Checked 2026-09-29 with `webmcp.listTools()` and `navigator.modelContext` in guest
sessions on the homepage, a listing page (`/men-running-shoes`), a product page, the reviews
page (`/reviews/<style_id>`), the bag (`/checkout/cart`) and `/wishlist`: no native tool was
listed and `navigator.modelContext` was undefined on each. Myntra does not register anything
itself, so the custom `myntra.com` namespace is the only source of tools on these pages and
nothing here duplicates a native tool.

## Execution kind

All three tools are `kind: "page"`. Each one calls the site's own same-origin endpoints with
`fetch` from the document it is invoked in and returns a structured result from that response;
none navigates the tab, submits a form or needs trusted input, so none meets the `cdp` criteria
in `spec/cdp-tools.md` §2.1 or §2.4. `get_product` reads the product page's HTML with `fetch`
instead of navigating to it, so the caller stays on the page it was on.

## Scope and loading

Register all three files together under namespace `myntra.com`; they use the default patterns
`https://myntra.com/*` and `https://*.myntra.com/*`.

```javascript
const fs = await import("node:fs");
const names = ["search_products", "get_product", "get_product_reviews"];
const tools = names.flatMap(n => eval(fs.readFileSync(`domains/myntra.com/${n}.js`, "utf8")));
await webmcp.addCustomTools({ namespace: "myntra.com", tools, forceOverwriteNamespace: true });
const tab = (await currentTab()).targetId;
const live = async name => (await webmcp.listTools()).find(t => t.source.custom?.namespace === "myntra.com" && t.tool.name === name && t.source.target_id === tab);
const found = await webmcp.invokeTool((await live("search_products")).tool_ref, { query: "men running shoes", sort_by: "price_low_to_high", limit: 5 }, { timeoutSec: 60 });
```

Each tool runs inside the `www.myntra.com` page it is invoked on (any page works, including the
homepage, a listing, a product page or the reviews page) and never navigates. On another
`myntra.com` host it returns `wrong_page` without calling the site; open `https://www.myntra.com/`
in the tab and call again. Requests go only to `www.myntra.com`, use the page's own cookies and
are plain `GET`s. A call takes about 0.3 to 1.4 s; `timeoutSec: 60` is plenty.

What the tools never do: sign in, use or change an account, touch the bag, wishlist, addresses,
orders, coupons or payment, set a delivery pincode, or open checkout. Nothing is written.

Conventions:

- Products are identified by `style_id`, the number before `/buy` in a product URL.
  `search_products` produces it; `get_product` and `get_product_reviews` consume it.
- Prices are rupees (INR) as the site shows them, before coupons and bank offers. They are not
  tied to a delivery pincode. `size_labels` in a search result names whatever the card lists (apparel
  sizes, `10-15 ML`, `Double King`), and only `get_product` says which sizes are available.
- `search_products` sorts: `recommended` (default), `newest`, `popularity`, `better_discount`,
  `price_low_to_high`, `price_high_to_low`, `customer_rating`. They map to the site's own Sort
  menu values. `customer_rating` is the site's ordering and can rank items with very few ratings
  first.
- Filters are strings `Group:Value`, for example `Brand:Puma`, `Color:Black_36454f` or
  `size_facet:UK9`; the site joins several values of one group with `,` (any of them) and
  different groups with `::` (all of them), which the tool does from the array. Call once with
  `include_facets: true` to list the groups and the exact strings (`filter`) the site offers.
  `min_price` and `max_price` (whole rupees, together) are the site's separate price range.
- `next_cursor` continues the same query, sort, filters and price range from where the last page
  ended. It carries the site's pagination token, so it is not portable between queries.
- Sponsored placements are not requested, so `rank` is the position among organic results.
- Failures are explicit: `status: "error"` with `error_kind` (`invalid_input`, `wrong_page`,
  `challenge`, `rate_limited`, `login_required`, `site_error`, `site_changed`) and a message that
  says nothing was changed. Text from the site is reduced to plain text (tags removed, block tags become line breaks, entities decoded once) and is untrusted.

## Site quirks

- **Query substitution.** A query with no matches, for example `zzzqqxxyy`, is answered with HTTP
  200 and results for a similar query (`zzz`, 361 results) plus a notice. The tool returns that
  as `query_substituted` and `site_message` instead of presenting the results as the original
  query's.
- **Pagination needs the site's token.** The search response carries a `Pagination-Context`
  header, and the next page must send it back as the `pagination-context` request header.
  Observed: page 2 without it repeated page 1 (20 of 20 products overlapped); with it and the
  offset advanced by the items consumed, there was no overlap. The offset counts consumed items,
  so the limit can change between pages. A four-page walk with limits 7, 13, 5 and 50 (plus a
  filter, a price range and a sort) returned 75 distinct products with contiguous ranks.
- **Query characters.** `/` in the search path returns HTTP 404, and `#` returns 404 or a bogus
  empty result with a huge total, so `/`, `\` and `#` in a query are replaced by spaces. Other
  punctuation (`? ; : @ = + $ , ! * ( ) [ ] { } | ^ ~ " < > %`, apostrophes, `&`), Devanagari,
  Tamil, Arabic and accented Latin were accepted without error; that does not mean they found
  anything (the site may answer with `query_substituted` or an empty result for a word it does not
  know). CJK characters and emoji are rejected by the site with HTTP 400, which the tool reports as
  `site_error`. Unpaired surrogate characters in `query` or a filter are refused as
  `invalid_input` when they reach the tool (verified in the Chrome extension); the Kernel API
  rewrites them to U+FFFD before the tool runs, so on Kernel they reach the site instead.
- **Filters.** Ordinary facets use `f=Group:Value[_meta],Value2::Group2:Value`, where `_meta` is
  appended for groups that have one (colours). Price is not an `f` group: `f=Price:...` returns
  zero or HTTP 500. The site's own price slider uses a separate `rf=Price:<min>_<max>_<min> TO <max>`
  parameter, which is what `min_price` and `max_price` send. Discount and rating ranges have a
  different form that was not worked out, so they are not offered. An unknown group or value
  returns zero results.
- **Product data is embedded in the page.** The product page HTML contains
  `window.__myx = {...}` with `pdpData`; `get_product` fetches the page (about 400 KB) and reads
  it. An unknown numeric id still answers HTTP 200 with `pdpData: null`, which is reported as
  `not_found`. A non-numeric path is treated as a search and never reaches the tool.
- **Price range and price sort.** Within a price range the site's `price_low_to_high` order is not
  strictly ascending (for example 500 to 580 and then 524); the site's own page shows the same
  sequence.
- **Attribute order.** Multi-value attributes can list their values in a different order between
  two site responses for the same product (`Mesh, Synthetic` against `Synthetic, Mesh`).
- **Multiple sellers.** A size can list several sellers; the count and price come from the
  seller the page has selected.
- **Reviews.** The reviews API answers 12 per page and returns the same empty list for a style
  with no reviews, a page past the last one and a style id that does not exist, so `no_results`
  cannot tell them apart; `get_product` tells whether the product exists. `rating` 0 means all
  stars. Rating totals and stock counts change between calls.
- **Refused networks.** From a datacenter network the site refuses, every myntra.com page and
  API answered HTTP 200 with a 483-byte HTML "Site Maintenance" page, including the homepage (a
  plain `curl` got the same); another datacenter network failed at the connection level with
  `ERR_HTTP2_PROTOCOL_ERROR`. Kernel's stealth browsers were served normally. The tools
  report such a page as `site_error` naming its title, and put the page title in `site_changed`
  messages for any other unexpected HTML.
- **Kernel runtime output type.** When the Kernel API returns an invocation whose output contains
  a character from U+0080 to U+00FF (for example `café` in the echoed `query`), it
  gives `output` as a JSON string instead of an object, independent of these tools. Consumers
  should accept either form.
- **Bot protection.** Myntra runs Akamai Bot Manager. No challenge appeared in any of the live
  checks, which ran from one Kernel stealth browser at a time, but the tools make exactly one
  request per call and stop at a block instead of retrying.

## Known limitations

- Only signed-out browsers were exercised. Myntra sign-in takes an Indian mobile number and an
  SMS one-time code, which was not attempted; nothing here depends on an account, and signed-in
  behaviour (personalised prices or coupons) is untested.
- Not covered: bag, wishlist, addresses, orders, coupons and offers, delivery and pincode
  serviceability, questions and answers, size recommendations, related and cross-sell products.
  Prices and stock are not pincode-specific, so a result does not prove an item can be delivered
  to any address.
- Only Kernel's default egress was tested for live data; no Indian proxy was used.
- `search_products` returns organic results only, so `rank` differs from the order a shopper sees
  with sponsored placements. It offers regular facet groups and the price range; discount and
  rating ranges are not supported. `include_facets` returns at most 20 groups of 30 options
  (`option_count` gives the site's total, and any `Group:Value` string can still be passed);
  options whose value contains `:` or `,` are omitted because the filter syntax cannot express
  them. The cursor is not signed: it is only checked against the query, sort, filters and price
  range it was made for, so a hand-made cursor is sent to the site as is and the site may answer
  with page 1 again. Its server-side lifetime is unknown and it was only walked four pages deep.
  CJK and emoji queries are rejected by the site (HTTP 400).
- `get_product_reviews` returns 12 reviews per page up to page 1000, omits reviewer names and
  images, and returns the rating summary on page 1 only. `updated_at` is null unless the site
  gives a 13-digit epoch in milliseconds.
- Site text (titles, descriptions, attributes, review text) is converted to plain text from its
  first 20,000 characters only, to bound the work on very long fields; a plain `<` not followed by
  a letter, `/` or `!` is kept as text. The named HTML entities decoded are the common ones
  (`nbsp`, `amp`, `lt`, `gt`, `quot`, `apos`, dashes, quotes, `hellip`, `bull`, `middot`, `copy`,
  `reg`, `trade`) plus numeric ones; any other `&name;` is left as written.
- `get_product` depends on the embedded `window.__myx` state; if the site changes it the tool
  returns `site_changed`. It returns the default seller's stock only, no coupons, and at most 60
  sizes, 40 attributes, 6 description sections and 10 images.
- The `challenge`, `rate_limited`, `login_required` and `site_changed` branches, and `wrong_page`
  on other myntra.com hosts, are covered by fixture tests only; none was triggered on the live
  site. The block-page detection (HTTP 403, or a short non-JSON page with "access denied" style
  wording) is a heuristic.

## QA summary

Builder live checks, 2026-09-29, guest sessions on fresh Kernel stealth browsers, the three
files registered as one batch with `forceOverwriteNamespace` and invoked through the WebMCP API:

- The tools were listed on the homepage, a listing, a product page and the reviews page and not
  on an unrelated site; no native tool was listed on any of them; the tab URL was unchanged
  after every call.
- `search_products`: default, all seven sorts (price orders verified, first prices ascending and
  descending), facets, single and two-value filters, brand plus colour, size, price ranges in
  both sort directions, brand plus price, the four-page cursor walk above, cursor rejection for
  another sort or query and for garbage, substitution, empty results, `/` and punctuation in the
  query, and apparel, beauty, home, kids and Devanagari queries. Every output validated against
  its `outputSchema`.
- `get_product`: footwear, beauty, home and apparel products, and `not_found`.
- `get_product_reviews`: helpful and recent, each star filter, page 2, past the end, an unknown
  style, and rating summaries on page 1.
- Malformed input for all three tools was refused without a request.

Fixture tests (`tests/myntra-read-tools.test.mjs`) cover input validation before any request,
`wrong_page`, the request shape and headers, every sort, filters, the price range, cursor
round trips and forgery, substitution, `no_results`, facets, text sanitising, bounds, every error
branch, and that no tool sends anything but `GET`.

Local Chrome extension, 2026-09-29 (Chromium 153 headless with an isolated profile, set up with
`xwebmcp setup chrome`, tools pushed with `xwebmcp dev` and invoked through `xwebmcp mcp`): the three
tools registered on a myntra.com tab and ran there as page tools. The extension
code was not modified; the only change to the throwaway copy was adding Myntra to the manifest's
`host_permissions`, because the extension's grant popup cannot be clicked headless. From the
builder machine's network the site answered with the refusal page above, so live Myntra data was
not obtained through the extension: against the real site the tools returned `site_error` naming
the page and malformed input was refused. The success paths (search with the cursor and the
pagination-context header replayed, substitution, facets, product, `not_found`, reviews) ran against
fabricated responses supplied by CDP request interception. All 12 outputs matched their schemas
and the tools sent only `GET` requests. This shows the tools run in the extension runtime; it does
not show live-site parity there.

Independent QA has not signed off yet, so every tool stays `draft`.

## URL patterns

Default patterns; no narrowing is needed because every tool belongs to the one Myntra shopping
site (Men, Women, Kids, Home and Beauty are sections of the same app and API). The tools return
`wrong_page` on hosts other than `www.myntra.com`.
