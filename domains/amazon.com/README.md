# amazon.com

Tools for Amazon's US retail shopping site (https://www.amazon.com).

| tool | file | status | notes |
|------|------|--------|-------|
| add_to_cart | [add_to_cart.js](add_to_cart.js) | draft | Add an absent child ASIN with exact price/seller, session and cart expectations; mock writes only |
| get_best_sellers | [get_best_sellers.js](get_best_sellers.js) | verified | Department list or one server-rendered ranking page |
| get_cart | [get_cart.js](get_cart.js) | draft | Retail cart read and opaque session/cart expectations; populated shape tested with fixtures only |
| get_product | [get_product.js](get_product.js) | verified | Product price, availability, public seller, delivery wording and child variations |
| prepare_checkout | [prepare_checkout.js](prepare_checkout.js) | draft | Read-only cart summary and manual handoff; execution unavailable |
| remove_cart_item | [remove_cart_item.js](remove_cart_item.js) | draft | Remove one exact ordinary retail line; fresh-state guards and exact readback; mock writes only |
| search_products | [search_products.js](search_products.js) | verified | One search page with site sorts, price bounds and filter ids |
| update_cart_item | [update_cart_item.js](update_cart_item.js) | draft | Set an exact ordinary retail line to an absolute quantity; mock writes only |

## Scope and loading

Register the **entire eight-tool namespace** together when using `forceOverwriteNamespace`; partial replacement would remove the existing reads. All tools match the shopping host, but refuse unsupported current pages explicitly. New cart tools refuse sign-in, checkout and payment pages; navigate manually to a shopping page first. They never navigate their registering document.

- `search_products`: six site sorts, one page (up to 60 cards), optional facets (30 groups, 25 options each). Select the site's filter ids from `include_facets`; one per group. Prices are US cents. The site's price filter can return prices outside the requested bounds; inspect `price_cents` and `applied_filters_text` rather than inferring strict numeric filtering.
- `get_product`: choose an orderable **child** ASIN, not a variation parent. Returns current/list price, availability, rating/histogram, at most ten bullets, public seller/shipper and bounded variations (100 values per dimension, 200 variants). `variant_filter` matches option wording case-insensitively. The Add to Cart boolean only reports a control, not orderability or a successful purchase.
- `get_best_sellers`: without a category, lists departments; otherwise accepts a category path such as `kitchen/289913` and page 1 or 2. Returns only server-rendered ranks.
- `get_cart`: fetches `/gp/cart/view.html` and validates at most 100 active retail lines and 100 saved-for-later lines. Returns only the active lines, canonical product ids, quantities, visible prices, retail subtotal, and opaque `session_context`/`cart_version`. Saved lines contribute to the version but are not exposed. Unknown or paginated layouts fail instead of silently truncating a cart. Fresh/Whole Foods/other collapsed carts are flagged, not read as retail lines.
- `prepare_checkout`: same bounded cart read, `status: "handoff_only"`, a canonical cart URL, and `execution_available: false`. Does not fetch checkout, select shipping/payment, place an order or hold inventory. Complete checkout manually in Amazon.

The tools use only this document's currently authorized session cookies. They do not read account names, addresses, payment information, messages or order history. Read requests can count as ordinary account browsing and Amazon's own page scripts send their normal telemetry.

## Execution kind and grounding

All tools are `kind: "page"`: their own same-origin GET/POST requests do not replace the registering document. Cart writes use a fixed readback URL, never a form submission or click that could navigate. No CDP exception is needed. Cancellation before dispatch returns `canceled`; after dispatch any unverified outcome is `outcome_unknown`.

Observed 2026-09-30, without changing a cart:

- Public empty cart: `#sc-active-cart`, `#sc-empty-cart`, saved cart container, `meta#cart-sp-csrf`, and collapsed-cart container.
- The cart's `SharedShoppingCartDesktopAsset` script reads `.sc-list-item[data-itemid]`, `data-asin`, `data-quantity`, removed markers and `.sc-product-title`; it posts to `/cart` with `X-AUI-View: Desktop`. Its batch protocol uses `submit.cart-actions`, `pageAction: cart-actions`, and `UPDATE_QUANTITY_START`/`DELETE_START` with an exact item id, list and quantity. The implementation constructs only those action types and summaries, never replays a script-provided action or arbitrary URL.
- Product buy box: `form#addToCart`, explicit ASIN, offer id, merchant id, CSRF, offered quantity options and `submit.add-to-cart`, posting to `/gp/product/handle-buy-box/ref=...`. The same form contains **Buy Now** inputs and pipeline fields. The tool never serializes the whole form: it allowlists add fields and sends `isBuyNow=0`, with no Buy Now submit or pipeline fields.
- Populated cart markup and mutation responses have **not** been observed live. Fixtures combine the observed script contract with fabricated ordinary lines. Successful mutation tests are mocks, not evidence that Amazon accepted a real write.

## Cart-action safety design

Cart writes are reversible but are not development permission to change a user's cart. QA uses only fabricated/intercepted flows unless a dedicated test account is separately approved. No user-cart or wishlist mutation was performed.

1. Supply exact `expected_session_context` and `expected_cart_version` from `get_cart`. For update/removal also supply the exact `cart_item_id`, ASIN and `expected_quantity`. A fresh read must match; a second read immediately before dispatch must still match. The opaque context hashes selected session cookies and does **not** verify a named person's identity. A human must ensure this is the authorized browser/account. Session/context changes fail as `wrong_account`.
2. Add checks the chosen child's form, offered quantity, exact public seller and visible unit price (`expected_sold_by` and `expected_unit_price_cents` from `get_product`). Existing ASINs are refused, not incremented or duplicated; use their exact line with `update_cart_item`. Quantities are absolute, from 1 to 10; removal has its own tool, not quantity zero.
3. Writes refuse other cart types and related/protection-plan, subscription or variable-weight items. Add also refuses subscription/customization/gift-wrap/add-on forms. Missing prerequisites refuse the write.
4. There is exactly one explicit cart-only POST and no automatic retry. POST redirects are not followed. Add can read the fixed cart URL after an opaque redirect; update/removal treat redirects as unknown. A tab-local attempt ledger reserves each cart version before dispatch, refuses reuse (including after an exact restore), and fails closed if storage is unavailable. This is a conservative duplicate guard, **not** cross-tab locking or server-side idempotency. Serialize actions and do not act concurrently in other tabs.
5. Success requires a fresh matching session and exactly the requested target change, including its quantity (and price on add), with all other active/saved lines unchanged. Missing readback, extra changes, cancellation, HTTP failure or ambiguity after dispatch returns `outcome_unknown` with `mutation_attempted: true`; inspect manually, never retry or restore automatically. The UI is not refreshed or mutated by the tool; reload it manually after reviewing the result.

`confirmed: true` and other undeclared inputs are rejected. There is **no confirmed purchase execution**: descriptions, annotations and model-supplied strings are not human approval, and the runtime offers no trusted per-purchase approval path. Shipping/payment selection, order placement, Buy Now, subscriptions, returns and cancellations are unshipped.

## Native WebMCP tools

No native tools were registered on the public cart or product page on 2026-09-30, before custom registration. The browser exposes `document.modelContext`; the earlier 2026-09-29 pass also found none on the homepage, search, Best Sellers and Fresh. Tools are added only for the missing capabilities.

## Site quirks

- A real robot check, throttle or denied/access-notice response is returned as a failure, not empty results or permission to bypass it. An AI-agent Conditions of Use notice appeared in a local Chromium during the earlier read-tool checks; nothing clicked or accepted it. Its presence on that surface does not prevent building/testing authorized tools on available public surfaces or mocks.
- Best Sellers HTML holds ranks 1–30 and 51–80, not all 100. Unknown category nodes can answer 200 with a "Best undefined" title; those are `not_found`.
- Search drops unknown filter groups but keeps valid ones. The tool checks every requested id against hidden `rh` echoes and refuses silently ignored filters. Unknown values in known groups usually yield `no_matches`. Server-rendered results and ad placements can differ from the visible tab.
- Product buy-box accessible price text can be blank; the reader composes visible symbol/whole/fraction parts. Variation parents lack a buy box/price; select a child.
- Prices/availability/delivery follow the session's location, which these tools do not read or change. Subtotals are cart estimates, not an approved checkout total.

## Known limitations

- New cart actions have **no live mutation success evidence**. No approved disposable/test account exists; real user carts must not be changed to establish shapes. Populated and special-item layouts remain fixture-only and unfamiliar shapes fail closed.
- Only ordinary isolated retail carts are supported for writes; other carts are flagged but not parsed. Large/paginated carts and unknown saved-line shapes fail. The session digest cannot certify a named account, and preflight/readback cannot make a server-side atomic transaction or prevent another tab changing state during a write.
- Wishlist actions are omitted: the authorized discovery account had no lists, so owner/list/item shapes and mutation postconditions are unobserved. Orders/account reads are omitted: it had no orders, so populated cards, tracking and pagination are unobserved. No new account or purchases were created for discovery.
- No checkout/order-placement, payments, subscriptions, returns, account/settings writes or login tool. Checkout has a read-only manual handoff only.
- Search/product/Best Sellers bounds and server-rendered limitations above remain. Other Amazon country sites are separate registrable domains and are not covered.
- Challenge and login failures use fabricated fixtures where no live case occurred. Extension success evidence must be recorded separately; Kernel registration is not extension parity.

## URL patterns

Every tool uses `["https://www.amazon.com/*"]`. The default apex/wildcard patterns would incorrectly attach shopping tools to unrelated AWS, Seller Central, Pharmacy, Music and developer applications. US retail shopping, Fresh/Whole Foods and sign-in share the shopping host; unsupported cart types still fail explicitly. If a runtime attaches tools on another host due to a matching frame, `wrong_page` prevents requests from the wrong top document.

## QA summary

Historical reads: independent QA signed off the three public reads on 2026-09-29, after fixing access-notice classification, the `-ubb` control, per-id filter checks, facet labels, docs and fixture gaps. Dated live cases included each tool invoked from the homepage, product, Best Sellers, cart and sign-in pages with unchanged tab URL/cart count; six search sorts and filters; variation child/parent and public seller; department/category/page-two rankings. The prior optional price-bound wording nit remains in the read tool; callers should use the echoed filter text and shown prices rather than assume strict clamping.

Broad cart increment: independent QA is pending. The new tools are draft. Live read/guard checks, intercepted mutation tests, and local extension checks are recorded separately after completion; no live mutation success is claimed.
