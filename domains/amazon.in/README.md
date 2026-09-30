# amazon.in

Tools for Amazon India (https://www.amazon.in): public catalog search, product details, Best Sellers charts, guest-cart reads and a limited reversible guest-cart add.

| tool | file | status | notes |
|------|------|--------|-------|
| search_products | [search_products.js](search_products.js) | draft | One results page with the site's departments, sorts, rupee price bounds and filter options (`include_facets`, then `facet_ids`); sponsored flag and `exclude_sponsored`. |
| get_product | [get_product.js](get_product.js) | draft | Product page by asin: rupee price and M.R.P., rating, availability, seller, bullets, overview and detail tables, and variation asins. |
| get_cart | [get_cart.js](get_cart.js) | draft | Guest active-cart items and dedicated recommendations; populated rows have fixture coverage only. |
| add_to_cart | [add_to_cart.js](add_to_cart.js) | draft | One recommendation into an empty guest cart; fresh price/state checks, one POST and exact readback. Write success is fixture-only. |
| list_bestsellers | [list_bestsellers.js](list_bestsellers.js) | draft | Best Sellers chart for a department or category node, with the subcategories to drill into. |

## Scope and loading

The three catalog tools read public pages, one GET per call. `get_cart` reads only a recognisable signed-out English guest cart. `add_to_cart` is a reversible action restricted to one recommended item in an empty guest cart; see its safety contract below. None signs in, changes the delivery location, touches wishlists or orders, opens checkout, or pays. Delivery estimates, private addresses, account identifiers and offer/session tokens are never returned. Login remains deferred.

Prices and availability use the browser's effective fulfillment context at request time, not an assumed Indian pincode or account. Cart outputs explicitly mark `currency: "INR"` and `fulfillment_context: "current_session_undisclosed"`; no address is disclosed or changed.

Register all five files together as one namespace:

```javascript
const fs = await import("node:fs");
const names = ["search_products", "get_product", "list_bestsellers", "get_cart", "add_to_cart"];
const tools = names.flatMap(name => (0, eval)("(" + fs.readFileSync(`domains/amazon.in/${name}.js`, "utf8") + ")"));
await webmcp.addCustomTools({ namespace: "amazon.in", tools, forceOverwriteNamespace: true });
const ref = async name => (await webmcp.listTools()).find(t => t.source.custom?.namespace === "amazon.in" && t.tool.name === name).tool_ref;
const found = await webmcp.invokeTool(await ref("search_products"), { query: "stainless steel water bottle", sort_by: "highest_rated", limit: 5 }, { timeoutSec: 60 });
const details = await webmcp.invokeTool(await ref("get_product"), { asin: found.output.results[0].asin }, { timeoutSec: 60 });
const chart = await webmcp.invokeTool(await ref("list_bestsellers"), { category: "kitchen" }, { timeoutSec: 60 });
```

The tools are listed while the tab is on a `www.amazon.in` page. A call took about 1 to 2 s live; `timeoutSec: 60` is plenty.

### Execution kind

All five are `kind: "page"`. Each issues same-origin requests from the registering document and parses HTML. `add_to_cart` uses the observed dedicated recommendation POST, with redirects refused, then reads the cart once; it does not submit or click the mixed product buy-box form. None navigates the tab or needs to outlive its document, so CDP is not justified. In the checks made, the fetched HTML matched the rendered page: a sorted search had the identical set of asins fetched and rendered (16 of 16), another query gave the same count (22 of 22), and a Best Sellers chart has 30 tiles in both the fetched HTML and the rendered page before scrolling (50 after).

### search_products

```json
{ "query": "water bottle", "department": "kitchen", "sort_by": "highest_rated", "min_price_inr": 200, "max_price_inr": 400, "page": 1, "limit": 24, "exclude_sponsored": true, "include_facets": true, "facet_ids": ["p_123:340438", "p_72:1318476031"] }
```

- `department` is one of the search aliases in the site's department menu, copied from that menu on 2026-09-29 (`kitchen` = Home & Kitchen, `stripbooks` = Books, `hpc` = Health & Personal Care, and so on). The list is fixed in the schema because the site silently ignores an unknown alias and searches every category instead.
- `sort_by`: `relevance` (Featured), `price_low_to_high`, `price_high_to_low`, `highest_rated` (Avg. Customer Review), `newest` (Newest Arrivals), `bestselling` (Best Sellers): the site's own `s=` values.
- `min_price_inr` and `max_price_inr` are whole rupees, sent as the site's `low-price` and `high-price`.
- Filters: call once with `include_facets: true`; each option comes back as `{ id, name, selected }` where `id` is the site's own filter token (`p_123:340438` is a brand, `p_72:1318476031` is "4 Stars & Up"). Pass chosen ids as `facet_ids`. Ids that share a key (two brands) are ORed and different keys are ANDed, which is how the site's own filter links combine them. Ids belong to one query and department; take them from an `include_facets` response for the same search. Ids use the site's own value text (for example `p_lbr_books_authors_browse-bin:J.K.+Rowling`, where `+` stands for a space) and every id the tool returns is accepted back as input. The "Delivery Day" options are neither offered nor accepted (`p_90` ids are refused), because they filter by the session's delivery location, and category ids (`n:`) are refused because the department sets them. Lists are capped at 40 groups, 40 options per group and 600 options in all, and `facets_truncated` is `true` when the page listed more than that, an option had no readable name (swatch options such as colours are named from their `title` attribute), a filter link changed several filters at once or was malformed, or its id could not be worked out or could not be passed back. In a list where only one option can apply (Discount, for example) the other options swap the applied one; they are listed normally, with the applied option `selected: true`. The price-band list has no heading and is not offered (`min_price_inr` and `max_price_inr` cover it), and the department's Category links are navigation, not filters, and are skipped without counting as truncation. An applied option is always listed with `selected: true`, including when it is the only applied filter (the site's remove link then has no `rh`).
- Prices are numbers in rupees and can carry paise (`1189.5`); `price_text` keeps the site's wording. `mrp_inr` is the struck-through M.R.P., not a per-unit price. `rating_count` is the exact count from the card's ratings link, `bought_past_month` is the site's abbreviated figure.
- `url` is always the canonical `/dp/<asin>` address. Sponsored cards link through the site's `/sspa/click` tracker; the tool never returns those links.
- Cards come in two layouts. Grid cards show the title; list cards (seen for phones) show a brand line above the title, returned as `brand`.

### get_product

`{ "asin": "B0CXNSCCVW" }` fetches `/dp/<asin>`. `asin` in the result is the id the page declares for itself; `requested_asin` echoes the input. The page's `<link rel="canonical">` is not used, because it pointed at a different product than the page being shown in one observed case. `variations` lists each dimension shown (Colour, Size, ...) with one asin per option; call `get_product` again with an option's asin to read that variant. `in_stock` is `true` only when the page has an add-to-cart button, `false` when it shows the "currently unavailable" notice, and `null` otherwise.

### list_bestsellers

`category` is a department slug (`kitchen`) or `department/node-id` (`kitchen/1379960031`). Every `subcategories[].category` value can be passed back in. Without `category` the tool returns only the list of departments. Bestsellers department slugs are not always the search aliases (Books is `books` here and `stripbooks` in search). The fetched page contains ranks 1 to 30 (page 1) and 51 to 80 (page 2) of each chart; ranks 31 to 50 and 81 to 100 are loaded by the site's scripts as the page scrolls and are not returned.

### get_cart and add_to_cart safety

`get_cart({})` returns active retail-cart lines (asin, title, quantity, canonical URL) and at most 12 recommendations with dedicated single-item POST forms. Saved-for-later items and other carts are not included. Cart selectors were corroborated against the public cart's client templates; only the empty-cart case and recommendations were read live, and populated rows remain fixture-only. Missing/unreadable rows fail as `site_changed`, never as an empty success.

`add_to_cart({"asin":"B0TESTAAA1","expected_price_inr":299.50})` consumes a recommendation from `get_cart` whose `can_add_to_empty_cart` is true. This example asin is fabricated. Quantity is fixed at one. It freshly reads the cart, requires a recognisable guest account and an empty active cart, a unique recommendation, the exact expected INR price, a dedicated `/cart/add-to-cart` POST route, valid offer/CSRF fields and no other named action/customizer controls. A sole matching line already at quantity one returns `already_present` without a POST; any other nonempty cart is refused.

At most one POST is sent. The tool does not follow a POST redirect, and treats HTTP or transport outcomes as insufficient evidence: one subsequent cart GET must show exactly the requested sole line at quantity one. Only that observed postcondition returns `ok`; it does not prove stock, fulfillment eligibility, purchase or the final checkout price. Readback failure, cancellation after the POST starts, account change or mismatched contents returns `outcome_unknown`. A sessionStorage pending guard then blocks another write in that tab; inspect `get_cart` and resolve manually, never retry automatically or create a new tab to bypass uncertainty. Cancellation before the write causes no POST. No model-provided confirmation flag is accepted or presented as human approval.

This is a reversible cart action, not a financial execution tool. Mutation success was tested only with fabricated fixtures. Live development and QA performed no cart mutations. No checkout/order/payment execution exists: those require a separate trusted human approval path for the exact account, item, quantity, total and terms, which the current runtime does not supply.

### Output contract

Optional fields must be omitted, not passed as `null`. Tools return `status: "ok"`, `status: "no_results"` where that applies, or `{ status: "error", error_kind, error_message }`. `add_to_cart` additionally returns `already_present` and always includes `write_attempted`. Shared `error_kind` values: `invalid_input` (checked before any request), `wrong_page`, `login_required`, `challenge`, `rate_limited`, `site_error`, `site_changed`; `get_product` and `list_bestsellers` add `not_found`. Nothing is retried. A challenge or `rate_limited` result means Amazon is throttling the browser; a person has to deal with it in the browser.

## Site quirks

- The HTML the tools parse embeds session ids, CSRF tokens and offer-listing tokens, and the header and buy box show the delivery location ("Delivering to ..."); signed-in pages are expected to carry the delivery address and purchase-history notes as well (not observed, no account was used). The tools read named fields only and never pass through raw attributes or unlabelled text; the fixture tests plant these values and assert that none is returned.
- The number of results per search page is whatever the site serves for that query: 16, 22, 24, 48 and 60 were seen. `page` is the site's own page number.
- Sponsored placements are mostly absent from the fetched HTML, although the rendered grid shows them: about twenty identical requests from one browser returned one page with twelve, and an independent reviewer's 19 calls (about 760 cards) returned none while the rendered page showed twelve. So the tool's list usually omits the ads a person sees, and its order can differ from the screen for that reason. Sponsored cards that are present are flagged with structural markers (`.puis-sponsored-label-text`, `.AdHolder`, an `/sspa/` link) rather than the word "Sponsored", so the flag does not depend on the page language.
- On the Kernel runtime, `webmcp.invokeTool` returned `output` as a JSON string instead of an object when the result text contained certain non-ASCII characters (`é`, `×`, `®`, `°` and a no-break space were observed; ASCII text and `€` or `₹` stayed objects). A probe tool in a scratch namespace behaved the same and the extension returned an object for the same text, so this comes from the runtime, not from these tools; parse `output` when it is a string.
- An independent reviewer's first browser was served the site's robot-check page for the home and a product page and HTTP 503 for the tool's fetch, which the tool reported as `rate_limited`; a fresh browser was not blocked. Nothing here tries to get past either.
- The site can show the same product on adjacent pages, and a filter list can lose an option once another is applied (a colour with no results, for example); the tool reports what the page's own links show. The site's own relevance order is not stable: the same request twice can return the same results in a different order.
- In filter links the site encodes an ORed value twice (`%257C`), so once two options of one key are applied the option ids have to be decoded again; the tool does this. With price bounds every link also carries a `p_36:` price-range token, and in a department search a browse-node `n:` token; both are ignored when working out which option a link adds or removes. Filter links keep the search's department, so links that leave it (the department's Category list, "Any Department") are not filter options.
- An unknown `department` alias is ignored by the site instead of failing (it searches every category), and a page number past the last page returns an empty page with a nonsense result count; the tool validates department up front and reports an empty page as `no_results`.
- When a valid department has nothing for the query (for example `bottle` in `hpc` or `sporting`), the site widens the search to every category (`i=aps`), either with a page that redirects by script and meta refresh or with an HTTP redirect. A page-side `fetch` follows the HTTP redirect but not the script one. The tool reports `no_results` in both cases, by checking the department the site actually served, and never returns the all-categories search under the requested department's name. A tab opened on the same URL ends up on the all-categories results.
- An unknown Best Sellers category answers HTTP 200 with the top-level page's navigation and no chart; the tool reports it as `not_found`.
- Text fields (availability, "bought in past month", badges) are in the page's language. Parsing that depends on English wording (`bought in past month`, the `of N results` count) returns `null` in another language rather than guessing.
- The site sets an AWS WAF cookie. The tools send one request per call and report `challenge` or `rate_limited` instead of retrying.
- Reading pages while signed in can add the visits and searches to that account's browsing history, as any normal page view does.

## Known limitations

- Only signed-out public sessions were inspected. Login remains deferred and amazon.com account portability has not been established. Signed-in carts, orders, addresses, wishlists and full reviews are unsupported.
- Cart additions are limited to quantity-one recommendations into an empty guest retail cart. Arbitrary product adds are not grounded: the observed product form mixes `submit.add-to-cart` with buy-now fields and a `/gp/product/handle-buy-box` action. Populated-cart updates/removals need authenticated or separately approved populated-cart evidence; they are omitted, not guessed. Write success and populated cart rows are fixture-only, not live-verified.
- Availability and prices follow the delivery location the browser session already has; the tools neither read nor change it. Live checks used a guest session in Kernel's us-east region with the default stealth proxy (the egress country was not checked); its default location was a Mumbai pincode. Results from an Indian address, or for another pincode, were not compared.
- `search_products` returns one results page per call, at most 60 results. `rating_count` and `bought_past_month` are null when the card does not show them; cards for items with too few ratings show no rating at all.
- `get_product` reads the fields listed above from the templates seen (a plain product, a product with colour and size variants, and an unavailable phone). Books, Kindle, fashion, Fresh and other templates were not checked. Variation options carry an asin and a label only, not a price or stock status per option. The `details` table includes the manufacturer, packer and importer lines the page prints. Only a bottle with colour and size variants and an unavailable phone were run through the tool; another variant layout (a t-shirt's) was inspected in raw HTML only.
- `list_bestsellers` returns 30 of every 50 ranks (see above). Other charts on the same site (New Releases, Movers & Shakers, Most Wished For) are not covered.
- The sponsored flag was checked structurally against one raw fetch that contained twelve sponsored cards and against fixtures; no tool invocation that returned a sponsored card was observed live, because ads are rarely present in the fetched HTML.
- Page-side fetches follow Amazon's redirects; a redirect to another host, to sign-in, or a robot check is reported, not followed.
- The new cart tools have not yet been live-checked in the Chrome extension runtime (see QA summary).

## QA summary

Restart checks, 2026-09-30: the full five-tool namespace was replaced atomically and remained listed. `get_cart` read the empty guest cart and six INR recommendations. `add_to_cart` returned `not_available` for an absent recommendation and `price_changed` for a mismatched expected price, both with `write_attempted: false`; the tab URL stayed unchanged. The cart GET requires the browser's default Accept header: explicitly sending `Accept: text/html` returned HTTP 406, whereas the ordinary GET returned 200. The new fixtures cover populated reads, a mocked exact add/readback, malformed inputs, account checks, unsupported forms, hidden empty markers, duplicate prevention, cancellation and uncertain outcomes with no retry. No live POST was performed. The current independent review is pending; the prior review below did not cover the new cart tools.

Builder checks, 2026-09-29, guest session on a stealth Kernel browser (region us-east), on the final source. The whole namespace was registered through the WebMCP API and the tools were invoked from `www.amazon.in` pages other than any entry point (the cart page, a product page and a Best Sellers page); every output was checked against its schema:

- Discovery: the three tools were listed on each of those pages and not listed on `example.com`; no native WebMCP tool was listed on any amazon.in page; the tab URL was unchanged after every invocation and the tools stayed listed with the same names.
- `search_products`: keyword search; price bounds alone and together (200 to 400 returned 209 to 400); every sort (price ascending and descending followed the site's order, which has occasional out-of-order prices, for example a 205 between 149 and 159); departments `electronics`, `kitchen`, `stripbooks` and `shoes` with results, and `hpc`, `toys`, `sporting` and `pets` reporting `no_results` for a query the department has nothing for (including the HTTP-redirect widening); page 2 (no overlap with page 1 in one run; in a later run the site's own HTML repeated four asins across pages 1 and 2 and the tool returned exactly those); page 20 and a nonsense query reporting `no_results`; `include_facets` returning filter groups named from their own headings, with no delivery-day options and a group count equal to the page's own named lists (also under price bounds and after one and after two brands are applied); a lone applied brand, rating or colour reported as selected; department, sort, price and brand together with the Category list ignored; colour swatch options listed by name; a brand plus "4 Stars & Up" through `facet_ids` returning only that brand at 4 stars or above (about 185 results against 50,000+ unfiltered), with both options reported as selected; two brands ORed returning both brands and more results than one; brand ids derived correctly inside a department; list-layout cards returning `brand`; no M.R.P. below its price across a 48-result page; canonical urls and Amazon image hosts only.
- `get_product`: a plain in-stock product with colour and size variations; an unavailable phone (`in_stock: false`, no price); an unknown asin (`not_found`).
- `list_bestsellers`: the department list, the `kitchen` chart pages 1 and 2, a node category, an unknown department and unknown node (`not_found`), a malformed category (`invalid_input`).
- No robot check or throttling response was seen during these checks (requests were made one at a time from a single browser).

Fixture tests (`tests/amazon-in-shopping.test.mjs`) cover malformed input (including `null`, delivery-day filter ids and every out-of-range value) before any request, running on other hosts, the exact query parameters for every option, field mapping for each card layout and product template, paise, the per-unit price, image-host and tracking-link filtering, each sponsored marker on its own, filter ids with the site's doubly encoded OR, swatch names and the truncation flag, department widening by meta refresh and by HTTP redirect, result counts, every size cap and the price, M.R.P., rating and rank guards, each error kind, that only `GET` requests to the tools' own paths are made, and that planted session, CSRF, delivery-address and purchase-history text never appears in any output. Around ninety deliberate source changes, made across the review rounds, were each caught by at least one test.

Independent QA: one reviewer made an initial review and two rechecks, finding eight defects (one major, the rest minor), then three minor ones (filters under price bounds, a lone applied filter, input schemas not pinned by tests), then three more minor ones (single-select filter lists, a hand-supplied category id, returned ids that could not be passed back). All fourteen were fixed. The review budget ended with the third report, so the final commit (which contains the fixes for that report, verified by tests and live checks) was not independently re-reviewed; the tools stay `draft` until it is. Chrome extension runtime: on the revision before the last one, the reviewer loaded the extension unpacked in a local headless Chromium with the manifest's host permission for `www.amazon.in` set directly (the permission prompt cannot be answered headless) and drove its runtime messages directly. The three tools were listed, each ran, the outputs were schema-valid, the tab did not navigate, and group counts and `selected` flags matched the Kernel runtime for the same inputs. The popup, the native-host bridge and the CLI path were not exercised, and the final commit was not run in the extension.

## URL patterns

All five tools use `["https://www.amazon.in/*"]` instead of the default `["https://amazon.in/*", "https://*.amazon.in/*"]`. The shop (search, products, charts, sign-in) lives on `www.amazon.in`, and `amazon.in` redirects there. Other hosts under the registrable domain are unrelated products (for example seller and advertising consoles); the page tools' relative requests would go to those hosts, so the tools are simply not listed there.
