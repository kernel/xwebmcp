# etsy.com

Tools for Etsy (https://www.etsy.com): search, listing details with the seller's purchase requirements, the cart, and favorites.

| tool | file | status | notes |
|------|------|--------|-------|
| search | [search.js](search.js) | qa_passed | One results page with prices, discounts, shop, shop rating, badges and ad flag; price, sort, free-shipping and page filters. |
| get_listing | [get_listing.js](get_listing.js) | qa_passed | Price, availability, description, images, quantity limit, every variation menu with option ids and sold-out flags, and every personalization field with type, required flag, limit and instructions. |
| get_cart | [get_cart.js](get_cart.js) | qa_passed | Cart lines with line_id, quantity, limit, prices, chosen options and personalization, and cart totals; signed-in or guest cart. |
| add_to_cart | [add_to_cart.js](add_to_cart.js) | qa_passed | Adds one listing with exactly the required options and personalization, or returns a typed error before submitting; confirms the new line by reading the cart. |
| update_cart_item | [update_cart_item.js](update_cart_item.js) | qa_passed | Sets one line's quantity or removes it with 0 through Etsy's cart API; confirms by reading the cart. |
| get_favorite_status | [get_favorite_status.js](get_favorite_status.js) | draft | Signed-in only. Whether listings are in Favorites. Never live-tested signed in. |
| set_favorite | [set_favorite.js](set_favorite.js) | draft | Signed-in only. Presses the listing's favorite button on the current page (listing page or a search page showing it) after recording the initial state; no-op when already in the requested state. Never live-tested signed in. |

Register all seven files together as one array with `forceOverwriteNamespace: true`;
registering one file that way removes the others.

## Scope and loading

The tools browse, read listings, change the cart, and change Favorites. None of them opens
checkout, pays, applies coupons, changes addresses or settings, messages sellers, or signs in.
Cart changes work for the guest cart of a signed-out browser and, through the same endpoints,
for a signed-in account's cart. Favorites need a signed-in session; signed out, both favorites
tools return `not_logged_in` without opening Etsy's sign-in prompt.

```javascript
const fs = await import("node:fs");
const files = ["search", "get_listing", "get_cart", "add_to_cart", "update_cart_item", "get_favorite_status", "set_favorite"];
const tools = files.flatMap(name => eval(fs.readFileSync(`domains/etsy.com/${name}.js`, "utf8")));
await webmcp.addCustomTools({ namespace: "etsy.com", tools, forceOverwriteNamespace: true });
const ref = async name => (await webmcp.listTools()).find(t => t.source.custom?.namespace === "etsy.com" && t.tool.name === name).tool_ref;
await webmcp.invokeTool(await ref("search"), { query: "leather dog collar embroidered name", max_results: 10 }, { timeoutSec: 60 });
await webmcp.invokeTool(await ref("get_listing"), { listing_id: "<listing_id from search>" }, { timeoutSec: 60 });
await webmcp.invokeTool(await ref("add_to_cart"), {
  listing_id: "<listing_id>",
  variations: [{ name: "Size & Color", option: "M - Black" }, { name: "Text Preference", option: "Natural Text" }],
  personalization: [{ field: "Personalization", value: "REX" }]
}, { timeoutSec: 90 });
await webmcp.invokeTool(await ref("get_cart"), {}, { timeoutSec: 60 });
await webmcp.invokeTool(await ref("update_cart_item"), { line_id: "<line_id from get_cart>", quantity: 0 }, { timeoutSec: 60 });
```

The tools are listed only while the tab is on a `www.etsy.com` page (see URL patterns);
re-list after any navigation. Timing seen live: `search` 4 to 8 s (it waits for the lazy-loaded grid),
`get_listing` and `get_cart` about 1 s, `add_to_cart` 10 to 15 s, `update_cart_item` 1 to 3 s.
Use `timeoutSec` 90 for `add_to_cart` and `set_favorite`, 60 for the rest.

How each tool reaches the site, and why it has its `kind`:

| tool | kind | method |
|------|------|--------|
| search | cdp | navigates the tab to `/search?q=…` and returns the destination's result grid (listing ids, titles, prices, discounts, shops, ratings, badges, ad flags). The server sends about 10 cards; the rest arrive through Etsy's lazy-load request, whose body needs per-page logging keys, so reading the rendered destination page is the robust source. |
| get_listing | page | `fetch` of `/listing/<id>` from the current document, parsed from HTML and the `Product` JSON-LD. |
| get_cart | page | `fetch` of `/cart` from the current document. |
| add_to_cart | cdp (exception, needs review) | navigates to `/listing/<id>`, sets the menus and fields through Etsy's own buy box with trusted input (`fillInput`, `click`), watches for the add request, and returns the confirmed cart line (`line_id`, inventory and customization ids, `properties`, `previous_quantity`) read after the add. The concrete constraint: on listings that use Etsy's form path, pressing Add to cart submits the buy-box form, which replaces the listing document with `/cart`, so a page tool registered on the listing page would be destroyed before it could confirm the add. A page-kind redesign is possible but untested: run on the listing page the agent opened, set the fields with DOM events, intercept the form's `submit` after Etsy's handlers fill `listing_inventory_id`, and send the same form data with a same-origin `fetch` instead of letting the document navigate. |
| update_cart_item | page | `POST /api/v3/ajax/bespoke/member/checkout/cart-list/<cart>/cart/<cart>/listing/<listing>/inventory/<inventory>/customization/<customization>/(quantity\|remove)` from the current document with its `csrf_nonce`, the same request Etsy's cart page sends. |
| get_favorite_status | page | `GET /api/v3/ajax/member/users/listings-favorites-collections-map?listing_ids[]=…`, the lookup Etsy's favorite buttons use. |
| set_favorite | page | the same lookup before and after, and one `click()` on the listing's favorite button in the current document. It does not navigate: open the listing (or a search page that shows it) first, otherwise it returns `listing_not_on_page`. |

Every request goes only to `www.etsy.com` with the page's own cookies; nothing is sent
anywhere else. The page tools refuse to run (`wrong_page`) when the document they run in is
not on `https://www.etsy.com`, which can only happen if a runtime registers them on another
site's top document because an embedded Etsy frame matched.

## URL patterns

All seven tools use `["https://www.etsy.com/*"]` instead of the default
`["https://etsy.com/*", "https://*.etsy.com/*"]`. Etsy's marketplace (search, listings, cart,
favorites, sign-in) lives entirely on `www.etsy.com`, and `etsy.com` redirects there. Other
subdomains are unrelated products, for example the help center on `help.etsy.com` and the
community forums; the page tools' relative requests would go to those hosts, and a page tool
cannot navigate the tab away to fix that. With the narrowed patterns the tools are simply not
listed there.

## Output contract

Every tool returns `status: "ok"` or `{ status: "error", error_kind, error_message }`.
Shared `error_kind` values: `invalid_input` (checked before any page access), `navigation_failed`,
`blocked` (Etsy's bot protection showed a verification page), `throttled`, `site_changed`,
`unknown`. The mutating tools always include `mutation_attempted`: true once a submission,
cart request or favorite press happened, even when its outcome is uncertain. Never retry
automatically after that; read the cart or the favorite state first.

Page tools add `wrong_page`; `set_favorite` adds `listing_not_on_page`.

Identifiers: `listing_id` is Etsy's numeric listing id (string). A cart line is
`line_id = cart_id|listing_id|inventory_id|customization_id`, the same key Etsy uses in its
own cart page; lines of one listing with different options or personalization have
different line ids, so `update_cart_item` changes exactly one of them.

### Variations and personalization (add_to_cart)

`get_listing` reports what the seller requires, and `add_to_cart` accepts only exact
matches of it; it never picks an option or fills a field on its own.

- Every variation menu (`variations[]`) must receive one entry, by `name` (or `index` for an
  unnamed menu), with `option` equal to the option's `option_id`, `label`, or `display_text`
  (case and surrounding spaces ignored; `label` is the displayed text without Etsy's trailing
  price range or `[Sold out…]` marker). Anything else is `variation_required`,
  `unknown_variation`, `variation_option_not_found` (with the allowed options in
  `requirements`), or `variation_option_unavailable` for sold-out options, including
  `[Sold out, waitlist available]` options that Etsy leaves selectable and options that
  become sold out after an earlier menu is chosen (the tool re-reads the menus after setting
  each one).
- Every required personalization field must be given a non-blank value
  (`personalization_required`, with the field's `instructions` in `requirements`). A
  `text_input` value must fit Etsy's `max_chars` (`personalization_too_long`); a `dropdown`
  value must be one of the field's options (`personalization_option_not_found`). Fields of
  any other type (Etsy's `unlabeled_upload`, or the older single-box personalization) are
  `personalization_unsupported` when required or given. A value for a listing without
  personalization is `personalization_not_offered`; a field that does not exist is
  `unknown_personalization_field`. The field may be omitted only when the listing has
  exactly one personalization field.
- `quantity` must be in the listing's quantity menu; a listing without one accepts only 1
  (`quantity_unavailable`).
- Sellers often write a tighter limit or format in the field's `instructions` than Etsy's
  `max_chars` (one live listing allows 512 characters but asks for at most 15). The tools
  return the instructions; following them is up to the caller.

Before pressing Add to cart, the tool checks what Etsy's form will actually send: the chosen
menu values, the hidden quantity, and each personalization value inside Etsy's
`multiple_personalizations` field. A mismatch is `site_changed` with nothing submitted. After
the press it reads the cart and returns the one line of this listing whose quantity grew,
with `previous_quantity` (non-zero when Etsy merged the add into an identical existing line)
and `personalization_confirmed` (every text appears in the line as Etsy displays it).

## Site quirks

- **Two add-to-cart paths.** Some listings post the buy-box form to `/cart/listing.php` and
  land on `/cart`; others add through `fetch POST /api/v3/ajax/member/carts/add`, stay on the
  listing page and open a sidebar cart. Which path a listing takes was not tied to anything
  observable (listings on both paths reported `neu_buy_box_type: "offerings"`), so the tool
  watches for both and decides success only from the cart contents.
- **Menus need real events.** Etsy's newer buy box records dropdown personalization on
  `input` events and ignores a bare `change`; the tool dispatches both for every menu and
  types personalization text with key events (`fillInput`).
- **Hidden validation templates.** The buy box ships "Please select an option" and "This
  field is required" messages in the DOM from the start, hidden with
  `wt-validation__message--is-hidden`; only messages without that class count as Etsy
  refusing the choices.
- **Lazy search grid.** `/search` HTML carries about 10 cards; the rest (60 per page including
  ads) come from `POST /api/v3/ajax/bespoke/member/neu/specs/listingCards`, whose body needs
  per-page logging keys. The tool therefore renders the page and waits until the card count
  stops changing. Etsy returns fuzzy results for nonsense queries rather than an empty page.
- **Search params** verified live: `min`, `max` (inclusive), `order` = `most_relevant`,
  `price_asc`, `price_desc`, `date_desc`, `free_shipping=true`, `page`.
- **Shop rating, not listing rating.** Search cards show the shop's rating and review count;
  the listing page's JSON-LD `aggregateRating` also appears to be shop-wide on many listings.
- **Bot protection.** Etsy uses DataDome. A headless stealth browser on the `cincy`
  residential proxy got "Access is temporarily restricted"; a headful stealth browser on the
  same proxy got a slider challenge that the browser's solver did not attempt. Headful
  stealth browsers on Kernel's default stealth network loaded every page without a
  challenge. The tools report a verification page as `blocked` and never try to solve it.
- **Waitlisted options.** Some sold-out options read `… [Sold out, waitlist available]` and are
  not disabled; both tools treat any `[Sold out…]` marker as sold out.
- **Signed-out favorites.** Pressing a favorite button signed out opens Etsy's sign-in
  overlay (`Join_Neu_Controller`); the tools check `Etsy.Context.data.user_id` first and
  never press it signed out. Etsy's scripts also contain a guest-favorites path
  (`/api/v3/ajax/public/guest/favorites/listings`), switched off (`guest_favorites_enabled`
  false) in every session seen; the tools do not use it.
- **Favorites state.** `listings-favorites-collections-map` answers
  `{ map: { <listing_id>: [<collection keys>] }, favorites_key }`; a listing is favorited when
  its entry contains `favorites_key` (Etsy's own button code reads it the same way). Signed
  in, adding a favorite goes through `POST /api/v3/ajax/bespoke/member/neu/specs/favoriteConfirmationToast`
  (spec class `Favorites_ApiSpecs_UpdateLists`); the tool presses the button rather than
  replaying that spec, whose arguments were not observable without an account. Whether
  Etsy's handler accepts a script `click()` (an untrusted event) signed in is unverified.

## Native WebMCP tools

None found (checked 2026-09-26, headful stealth Kernel browser, signed out): on the home page,
search results, listing pages and the cart, `document.modelContext.getTools()` returned `[]`
and `navigator.modelContext` was undefined; no `form[toolname]` elements. The custom tools
conflict with nothing.

## Status and known limitations

Status: `search`, `get_listing`, `get_cart`, `add_to_cart` and `update_cart_item` are
`qa_passed` (independent QA round 3 signed off their current source); `get_favorite_status`
and `set_favorite` stay `draft` because no signed-in session was available.

- **Favorites are unverified.** No Etsy account was available (no credential in the vault,
  and the configured browser profile has no Etsy session), so `get_favorite_status` and
  `set_favorite` ran live only signed out (`not_logged_in`, nothing pressed). The signed-in
  code path, the lookup's `listing_ids[]` parameter encoding, whether Etsy accepts the
  script `click()` on its favorite button, removing a favorite that belongs to other
  collections, and Etsy's first-favorite privacy prompt are covered by mocked tests only.
  They stay `draft` until run against a signed-in account. `set_favorite` needs the
  listing's favorite button on the current page and never navigates.
- **Signed-in cart unverified.** Cart tools were verified live on guest carts only. The
  endpoints are the ones Etsy's signed-in pages use (`/member/` paths), but saved-for-later
  lines of a signed-in cart were not seen live; `get_cart` skips elements whose id or class
  contains `saved-for-later`.
- `search` returns only one results page per call, and at most 64 cards; card badges are
  limited to a fixed list (Bestseller, Star Seller, Popular now, Etsy's Pick, Limited stock,
  Only 1 left).
- `get_listing` reads the page as first rendered; per-option prices appear only in
  `price_text` of each option, not as the final price of a combination.
- `add_to_cart` adds at most 10 units per call, and only 1 for listings without a quantity
  menu although the cart may allow more (add, then use `update_cart_item`).
- **Paid add-on personalization is not modeled.** Some listings put an optional
  personalization field behind a paid add-on checkbox (for example "Text +$3.80",
  `li[data-add-on-amount]` with `input[data-selector="perso-add-on-checkbox"]`).
  `get_listing` reports such a field as an ordinary optional field without its surcharge, and
  `add_to_cart` cannot reveal it: a value for it fails with `unknown` ("not visible") before
  anything is submitted. Leave add-on fields out.
- `add_to_cart` reports a DataDome block during its initial cart read as `unknown` ("Could not
  read the cart before adding (HTTP 403)") rather than `blocked`; nothing is submitted.
- On a listing with both a required text field and a required upload field, `add_to_cart`
  first asks for the text (`personalization_required`) and only then reports the upload as
  `personalization_unsupported`; no input can succeed for such listings (`get_listing` shows
  `personalization.supported: false`).
- `get_cart.subtotal_text` is usually null for guest carts: Etsy's cart page shows "Item(s)
  total" and a "Shop discount" row but no "Subtotal" row. Use `items_total_text` and the
  lines' `unit_price`.
- `add_to_cart` cannot fill upload-type personalization or Etsy's older single-box
  personalization, does not support gift options, and cannot change the options of an
  existing cart line (remove it with `update_cart_item` and add again).
- `update_cart_item` changes quantity only; it never saves for later or moves lines.
- Shipping country, currency and language come from the browser session; the tools do not
  change them.
- Only the Kernel browser runtime was exercised (page and cdp kinds); extension-host
  portability was reasoned about (no Node globals, page work runs in the page) but not
  tested. `search` and `add_to_cart` are `cdp` by design (see the kind table above).

## QA summary

Live checks by the author on 2026-09-26 (headful stealth Kernel browser, default stealth
network, signed out, guest cart that started and ended empty), first revision:

| tool | case | result |
|------|------|--------|
| search | vase under $50; bookshelf under $300 sorted high to low with ads; nonsense query; page 2; min above max; unknown field | 58 cards, typed fields; prices $300, $300, $299.99; fuzzy results; page 2 URL; `invalid_input`; rejected by the input schema |
| get_listing | personalized collar; engraved wallet with dropdown personalization; missing listing | 2 menus (15 and 4 options), required text field with 512 limit and instructions; 2 menus, required text + dropdown; `listing_not_found` |
| add_to_cart | collar with every requirement error | `variation_required` (twice), `variation_option_not_found`, `personalization_required`, `unknown_variation`, `personalization_too_long`; nothing submitted, cart unchanged |
| add_to_cart | collar M - Black / Natural Text / "REX" | form path; new line with the three properties, `personalization_confirmed: true` |
| add_to_cart | wallet 1 Wallet / Initials / "AB" / Bottom right; dropdown typo; quantity 2 | `carts/add` path; new line with four properties; `personalization_option_not_found`; `quantity_unavailable` |
| update_cart_item | 1→2, 2→2, 500, unknown line, remove both lines | `changed`; no-op without a request; `quantity_unavailable` (limit 194); `not_in_cart`; removed, cart empty |
| get_favorite_status, set_favorite | signed out | `not_logged_in`, no request, nothing pressed |

Defects found by the author's live runs and fixed before QA: on a newer-buy-box listing the
first version reported `mutation_attempted: false` although Etsy had added the item (it
watched only for the classic form post); dropdown personalization was not recorded because
only `change` was dispatched; hidden validation templates were reported as Etsy's refusal;
fetch-based tools on `help.etsy.com` read that host's `/cart`. Each has a regression test.

Independent QA, round 1 (agent `agt_33b54e2c132ec5d67552`, `smartest` preset, its own
headful stealth browser, guest cart, commit `8efbba1`): 120 live invocations, every output
valid against its schema; 45 invalid inputs rejected with no navigation or cart change;
tools not listed on `example.com`; 15 `add_to_cart` requirement errors with nothing
submitted; a personalized collar (classic form path) and an engraved wallet (`carts/add`
path) added and confirmed against the cart page; quantity updates, no-op, limits, absent
line, and removal; favorites signed out returned `not_logged_in` with no request; the cart
ended exactly as it started (empty). `search` was signed off on that commit. Findings, all
addressed in the next revision:

- D1 (medium): options marked `[Sold out, waitlist available]` (not disabled by Etsy) were
  reported as available, so `add_to_cart` would have tried them. Both tools now treat any
  `[Sold out…]` marker as sold out; a fixture option and a refusal test cover it.
- K1/K2: under the repository's kind rule the fetch-based tools and `set_favorite` should be
  `kind: "page"`, and a page tool cannot move a tab off `help.etsy.com`. The five tools are
  now page tools, all patterns are narrowed to `www.etsy.com`, and page tools return
  `wrong_page` outside it.
- M1 (minor): `update_cart_item` reported `mutation_attempted: true` for failures before its
  request; it now tracks whether the request was sent.

Author re-check of the revised source on 2026-09-26 (same browser setup): all seven tools
registered, the five page tools ran on the live site (Etsy's CSP did not block them);
`get_listing` reported the waitlisted options of a live listing as `sold_out: true`; guest
cart 0 → add collar (form path, confirmed) → `update_cart_item` 1→2 → remove → 0; favorites
signed out `not_logged_in`; no tools listed on `help.etsy.com`.

Independent QA, round 2 (agent `agt_a4c726c8629f206349a7`, `smartest` preset, its own
browser, guest cart, commit `bb2f7c8`): 184 live invocations, all outputs schema-valid; D1,
K1/K2 and M1 verified fixed (waitlisted options `sold_out: true` and refused by
`add_to_cart`; page tools worked in place from home, listing, cart and search pages; no
tools on `example.com` or `help.etsy.com`; exactly one request per cart change); agreed with
every tool's kind; cart restored to empty. Signed off `search`, `get_listing`, `get_cart`,
`add_to_cart`, `update_cart_item` on that commit. Three low findings, fixed in the next
revision: `set_favorite` detected its request through the resource-timing buffer, which is
full on listing pages (now a `PerformanceObserver`); a required upload field was reported as
`personalization_required` instead of `personalization_unsupported`; `get_cart` could read an
unrecognized layout as an empty cart because Etsy always ships the hidden "Your cart is
empty" heading (now it cross-checks Etsy's `in_cart_count` and any unparsed line elements).
Author live re-check of those fixes: a listing with a required upload field returned
`personalization_unsupported` with nothing submitted; `get_cart` read 0 lines empty and 1
line (quantity 2) after an add, then the line was removed.

Independent QA, round 3 (agent `agt_1358f22a8d418affa8c6`, `smartest` preset, its own
browsers, guest cart, commit `630db23`, the current tool source): validator and 1031 tests
pass; 111 live outputs, all schema-valid, plus 21 inputs stopped by the runtime schema gate;
47 invalid inputs rejected; no tools on `example.com` or `help.etsy.com`, page tools worked
in place from home, listing, cart and search pages; waitlisted options refused; required
upload refused with `personalization_unsupported`; a collar (form path) and a wallet
(`carts/add` path) added and confirmed on the cart page; quantity change, no-op, limit,
absent line and removals with exactly one request each; `get_cart` agreed with Etsy's
`in_cart_count` at every step; favorites signed out sent nothing; one browser was
DataDome-blocked and every tool except `add_to_cart` reported `blocked`; the cart ended
exactly as it started (empty). Signed off `search`, `get_listing`, `get_cart`,
`add_to_cart`, `update_cart_item`; the favorites tools were not signed off (no account). Its
findings (paid add-on fields, `add_to_cart`'s `blocked` reporting, requirement ordering on
required-upload listings, the missing subtotal row, and the add-path explanation) are
recorded under Known limitations and Site quirks rather than changed in the signed-off
source.

Local tests run every page-side function from its source against fabricated HTML in a small
test-only DOM (`tests/etsy-dom.mjs`), with a fake `fetch` and simulated buy-box scripts:

```sh
node --test tests/etsy-tools.test.mjs
```

## Sessions

Browser and agent identifiers used for QA are ephemeral and are recorded in the pull request
conversation rather than here. This repository is canonical; no credentials, account details
or live-view URLs are stored in it.
