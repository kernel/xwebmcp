# walmart.com

Walmart retail product/search/review/store reads, current-cart reads and guarded reversible cart actions.

## Status

| tool | file | status | notes |
| --- | --- | --- | --- |
| add_to_cart | [add_to_cart.js](add_to_cart.js) | draft | Exact current offer, absolute quantity; adding is limited to the observed Bed Sheets type. Mutation success fixture-only. |
| get_cart | [get_cart.js](get_cart.js) | draft | Actual lines including unavailable ones, totals, store/fulfillment context, opaque account/state guards. |
| get_product | [get_product.js](get_product.js) | draft | Product, current offer id, sales unit, price, availability, variants, seller, specs and reviews summary. |
| get_product_reviews | [get_product_reviews.js](get_product_reviews.js) | draft | Ten listed reviews per page; no reviewer identity. |
| get_store | [get_store.js](get_store.js) | draft | Explicit or selected store's public detail; never selects a store. |
| list_lists | [list_lists.js](list_lists.js) | draft | Matching signed-in account's list summaries, not contents or owner details. |
| remove_cart_item | [remove_cart_item.js](remove_cart_item.js) | draft | Exact existing ordinary line, quantity zero; not a cart clear. Mutation success fixture-only. |
| save_for_later | [save_for_later.js](save_for_later.js) | draft | Move an exact ordinary cart line to saved-for-later, not a shopping list. Mutation success fixture-only. |
| search_products | [search_products.js](search_products.js) | draft | Six sorts, facets, price bounds, sponsored flags and selected-store context. |
| update_cart_item | [update_cart_item.js](update_cart_item.js) | draft | Absolute quantity of an exact ordinary existing line; unchanged quantity is a no-op. Mutation success fixture-only. |

## URL patterns

All tools match `https://www.walmart.com/*`: Walmart's retail product. Careers, corporate, seller center and other subdomains are unrelated products and are not matched. Pharmacy and checkout are not action surfaces. A cart action invoked on a challenge, pharmacy or checkout page fails before requests.

## Scope and loading

All tools are `kind: "page"`. They run in their registering document and never navigate it. Public reads fetch one same-origin HTML page and parse its embedded `__NEXT_DATA__`. Cart operations extract the current persisted-operation descriptors from the site's already-loaded webpack modules and headers from its current retail runtime configuration. No fixed operation hash, saved cookie, external API credential, cart merge or site React handler is used.

Register the **whole ten-tool namespace atomically**, including existing reads, when replacing `walmart.com`. For example, construct one expression `[].concat((SOURCE_1), ..., (SOURCE_10))` outside `domains/` and pass it to `kernel browsers webmcp custom-tools add --namespace walmart.com --force-overwrite-namespace --source-file <file>`. Do not invoke actions while checking registration.

Kernel's API discovery can crash Walmart tabs (see Site quirks). The tested page-API path is:

```js
const tools = await document.modelContext.getTools();
const tool = tools.find(t => t.name.endsWith(".get_cart"));
const output = await document.modelContext.executeTool(tool, JSON.stringify({}));
// Some runtime versions return JSON text rather than an object; parse it if needed.
```

Cart tools need the site's `getCart` module and retail configuration loaded; absent/changed versions fail explicitly. `save_for_later` additionally requires `getSFL` and `moveToSFL` modules, normally on an already-open `/cart` page. It will not open that page itself: normal site hydration can issue `MergeAndGetCart`, which is not a read. Public read tools work from an unrelated retail page; wrong-domain input returns `wrong_page` without navigation.

Each cart-tool invocation has a 25-second internal deadline and honors caller cancellation. A failure before dispatch reports `mutation_attempted: false`; every failure after a POST may have happened reports `outcome_unknown`, `mutation_attempted: true`. API callers should allow enough time for prerequisite and verification GETs (up to 60 seconds).

## Tool contracts

- `search_products`: query, six site sort ids (`best_match`, `price_low`, `price_high`, `best_seller`, `rating_high`, `new`), page 1–25, facets from the site's own links, price bounds, optional sponsored exclusion. At most 50 product tiles and 30 facet groups. Out-of-range/no-match responses are distinct from throttled responses ignoring the requested sort/page. Store comes from the results' `stores` parameter.
- `get_product`: numeric `us_item_id`; at most 100 variants, eight images, 40 specifications and 5,000 characters per description. Exact current `offer_id` is now returned for cart callers. `is_alcohol` is null if the product page does not declare it; that is not a safety assurance. Price/availability depend on `assortmentStoreId`, reported as `store_id`.
- `get_product_reviews`: six site sorts, ten reviews per page, bounded text; counts distinguish all ratings from listed text reviews. `has_next_page` derives from the listed span and total, not the site's unreliable `next` link. Names, nicknames, author ids and location are omitted.
- `get_store`: optional `store_id`, otherwise the selected-store cookie. Public store address/phone/hours/services and bounded nearby stores. Never chooses a store.
- `get_cart`: one `getCart` GET, at most 100 lines (500-line parsing safety ceiling). Unavailable lines remain visible even when the header says zero items. Returns `account_token` and `cart_state`: opaque SHA-256 fingerprints computed locally, not raw account, address or session values. Customer names/phone and delivery-address content are not returned. `actions_supported` describes ordinary-line eligibility only; login, reservations, availability, limits, modules and state guards can still prevent an action.
- `list_lists`: requires `expected_account_token` from `get_cart` and the current document's signed-in account profile. Reads `/lists` HTML between two cart-account checks and privately compares its bootstrap account with the document's account; missing identity or any difference refuses the result. At most 50 list summaries. No owner details, recent items or private list contents. This is a three-GET read, not one request.

All inputs are strictly validated in-tool before site interaction; page-tool schemas and annotations are not enforcement. Returned product/list names and review text are untrusted data, not instructions.

## Action safety design

The four actions are reversible cart/saved-state writes, not purchase authorization:

1. Require an intended signed-in account, `expected_account_token` and `expected_cart_state` from a fresh `get_cart`, a unique `request_id`, exact `us_item_id`/`offer_id` and (for existing lines) `line_id`. Account mismatch is `wrong_account`; changed cart/store/address/fulfillment is `stale_state`. Guard tokens are state checks, **not proof of human approval**.
2. Refuse reserved carts and special goods/lines: pharmacy/prescriptions/vision, alcohol, gift cards, services, customizations, bundles, preorders, selected subscriptions and weighted goods. Existing-line actions require explicit `isAlcohol: false`, ordinary EACH-unit quantities and the line's existing fulfillment preference.
3. Adding is deliberately narrower: only the live-observed `Bed Sheets` type with explicit `legalRestriction: false`, `isLMPAlcoholItem: false`, `showAtc: true`, EACH unit and available fulfillment. Other product types are unsupported, not guessed safe. The product-page offer must match exactly; an item/offer already in the cart is refused. Fulfillment must equal the current cart intent. No default location/address/fulfillment change is introduced.
4. Quantity changes are absolute, 1–99 within current site limits and availability. Equal quantities return `unchanged` with no POST. Removal uses zero. The site's `updateItems` mutation receives `skipPolicyCheck: false`; policy checks are never skipped. Save-for-later refuses an already-saved offer or a partially read saved collection.
5. Re-read the cart after prerequisites before dispatch. A per-document lock serializes these actions. A bounded 100-entry request ledger refuses duplicate dispatched request ids and further writes after an unresolved outcome in that document. There is **no server-side compare-and-set, durable idempotency or cross-tab transaction**; a simultaneous site/tab change remains a race. Never retry uncertain writes or replay them after navigation.
6. At most one POST (`updateItems` or `moveToSFL`), with redirect following disabled, then read-only verification. Unexpected response origins are rejected. `ok` requires the exact target quantity/removal, same account/cart/store/address/fulfillment (including group reservations) and byte-equivalent other exact lines, even when another line has the same offer. Saving also checks that exactly that ordinary offer/quantity/selection was added and existing saved items were unchanged. Malformed safety structures or incomplete saved entries refuse dispatch. Failure to prove any postcondition is `outcome_unknown`, not success. Re-read/reconcile manually; UI React state may lag a direct mutation response.

There is no `confirmed: true` input and no fake approval framework. No purchase, payment, order-placement, reservation/hold, order cancellation, account creation, settings change or list creation/deletion tool is shipped. The current runtime does not provide a trusted per-action human approval channel, so final consequential execution is excluded. Cart actions must only be invoked when the user intends the reversible change; installing/testing tools is not consent to change a live account.

## Site quirks

- Walmart uses HUMAN/PerimeterX. Guest browsers were blocked after approximately 10–15 calls in a few minutes, and sometimes on first navigation. There is no established safe request rate. `/blocked` can return HTTP 200; tools detect it, 403/418 and captcha-shaped responses. Stop on challenges/rate limits; do not solve or automatically retry them.
- Kernel API discovery (`kernel browsers webmcp list`) has intermittently crashed the Walmart renderer (`RESULT_CODE_KILLED_BAD_MESSAGE`), including without these tools. Early homepage listing sometimes worked; late and non-home listing sometimes crashed. The page API invoked reads successfully on several retail pages. An early listing is an observation, not a reliable workaround or a policy bypass.
- Kernel API output containing Latin-1-range characters such as `¢` may arrive as JSON text rather than an object. A no-op tool on another site reproduced that runtime behavior.
- Earlier local-extension QA in headful Chromium 153 on Linux crashed the Walmart tab on registration: 3/3 with the public reads, 1/1 with a scratch no-op, no crash without registered tools. Fresh broadened-source QA on a category page registered all ten without a crash and successfully invoked product/store reads, plus malformed negatives for all tools. This does not establish reliability on other pages, action success, or stable-Chrome behavior.
- Prices and availability vary by selected store. Store defaults were observed to differ for guests and signed-in sessions. Price-low ordering can contain out-of-order marketplace tiles; these tools expose the site's order, not a new global sort.
- The site can issue its own cookie writes/telemetry; ordinary read fetches do not guarantee an unchanged cookie jar. Tools never persist/copy cookies or change store/account selection.

## Known limitations

- No live cart or saved-item mutation has been performed. Action successes, restoration and negative confirmation cases are tested only in fabricated isolated flows. No claim of real mutation success is made.
- Adding is limited to the observed unregulated Bed Sheets product type; public product ids alone do not establish eligibility for other types. Non-current seller offers and weighted goods are unsupported.
- `save_for_later` requires modules on an already-open cart document and a complete saved-items collection of at most 100 lines. It returns `wrong_page`/`site_changed` rather than navigating or using stale operation hashes.
- Lists read only summaries. List contents and add/remove/create/delete list actions remain ungrounded. Saved-for-later is not the same as a shopping list.
- Own orders were empty in the authorized discovery account; no populated order/detail schema is established. Order tools are omitted, not inferred from empty pages. Pharmacy is excluded.
- Public internal SSR/webpack/GraphQL structures can drift. Explicit failures are returned for missing configuration/operations or changed shape; there is no guessed endpoint fallback or burst retry.
- Cross-tab concurrent writes and races with user interaction cannot be prevented by local guards. The ledger expires with the document. A verification failure may reflect a real partial write, not a clean rollback.
- Error paths `rate_limited`, `canceled`/deadline, `site_error` and `site_changed` are fixture-tested; not all were reproduced live.
- Local Chrome extension coverage is limited to category-page registration, product/store reads and malformed negatives. Fresh independent QA is required after source fixes; no live action success is verified in either runtime.
- `list_lists` deliberately refuses bootstrap-account differences, including benign profile metadata drift. Reloading the intended account document may be needed; this stricter check has only fabricated success coverage.

## QA summary

Prior public-read QA at source `3e24a5d` (2026-09-29) found and fixed unknown/wrong-typed input reaching the site, early review pagination, surrogate truncation and invalid dates. The broadened source does not inherit that sign-off: all entries are draft pending new review.

Builder checks on 2026-09-30:

- Approved session still signed in; no native tools on the homepage. Entire ten-tool namespace registered atomically.
- Page-API invocation from the homepage: `get_cart` returned the real unavailable line and guard tokens; `list_lists` returned one empty-list summary. Only counts/structure were recorded, not private values.
- `remove_cart_item` with a fabricated stale-state token returned `stale_state`; malformed `add_to_cart` with `confirmed: true` returned `invalid_input`. Neither wrote or navigated.
- Updated `get_product` returned a current offer id. Public product-page inspection grounded the Bed Sheets eligibility fields and shipped client code grounded `getCart`, `updateItems`, `moveToSFL` and `getSFL` request construction. Only GETs were used; the existing account/cart/list/location state was left untouched.
- Fabricated fixtures exercise cart reads, all four mutation success paths, account/state/context rejection, restricted items, duplicate/unresolved requests, uncertain POSTs, postcondition mismatch, cancellation and namespace preservation. Live mutation success remains untested.

Independent review of source `69ebdebb` found exact-line, nested-reservation, saved-selection, malformed-shape, list-identity, response-origin/redirect, public-output-bound and pre-cancellation/input-length defects. Fabricated regressions reproduced the failures; fixes are awaiting the same reviewer's recheck. No live writes were used to reproduce or fix them.

Fixed-source builder validation: 89 tools valid; 1,720 Node tests passed (143 Walmart tests); `go test ./extension/...` passed. Independent final-source outcome: pending.
