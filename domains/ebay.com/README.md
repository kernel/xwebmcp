# ebay.com

Tools for eBay (https://www.ebay.com): listing search, listing details and seller feedback summaries.

| tool | file | status | notes |
|------|------|--------|-------|
| search | [search.js](search.js) | draft | One results page (up to 60 listings) with eBay's sort and filters; `sold_only` searches sold listings and needs a signed-in session. |
| get_listing | [get_listing.js](get_listing.js) | draft | One listing by item number: price or current bid, availability, condition, shipping, returns, item specifics, seller, sold notice and variation menus. |
| get_seller_profile | [get_seller_profile.js](get_seller_profile.js) | draft | Public feedback summary for a username; buyer comments are not returned. |

All three are read-only. None of them signs in, bids, makes offers, contacts sellers, changes the cart or
Watchlist, opens checkout, or changes any account setting or preference.

## Native WebMCP tools

None found (checked 2026-09-29, headful stealth Kernel browser, signed out and signed in): on the home page, a
search results page, fixed-price, auction, variation and sold item pages, an eBay Store page, a feedback
profile, `cart.ebay.com` and `/deals`, `webmcp.listTools()` returned `[]`, `document.modelContext.getTools()`
returned `{}`, and there were no `[toolname]` elements. The custom tools conflict with nothing.

## Execution kind

All three tools are `kind: "page"`. Each one issues a same-origin `fetch` from the document it is invoked in,
parses the server-rendered HTML with `DOMParser`, and returns; none navigates the tab, so none needs to survive
a navigation and none qualifies for `cdp`. Reading the fetched HTML rather than the live tab also avoids the
search grid's client-side hydration: a tab queried 2.5 s after navigating once had no result cards yet, while
the fetched HTML had all 60.

## Scope and loading

```javascript
const fs = await import("node:fs");
const tools = ["search", "get_listing", "get_seller_profile"].flatMap(name => (0, eval)("(" + fs.readFileSync(`domains/ebay.com/${name}.js`, "utf8") + ")"));
await webmcp.addCustomTools({ namespace: "ebay.com", tools, forceOverwriteNamespace: true });
const ref = async name => (await webmcp.listTools()).find(t => t.source.custom?.namespace === "ebay.com" && t.tool.name === name).tool_ref;
await webmcp.invokeTool(await ref("search"), { query: "mechanical keyboard", sort: "price_shipping_lowest", buying_format: "buy_it_now", limit: 10 }, { timeoutSec: 60 });
await webmcp.invokeTool(await ref("get_listing"), { item_id: "<item_id from search>" }, { timeoutSec: 60 });
await webmcp.invokeTool(await ref("get_seller_profile"), { seller_username: "<seller.username from search>" }, { timeoutSec: 60 });
```

Register the three files together with `forceOverwriteNamespace: true`; registering one file that way removes
the others. The tools are listed only while the tab is on a `www.ebay.com` page; re-list after a navigation.
A call takes 1 to 3 s when eBay answers at once and up to about 15 s when it needs its retries (see Site
quirks). Use `timeoutSec` 60. Space calls by about ten seconds.

Identifiers and conventions:

- `item_id` is eBay's numeric item number (9 to 14 digits, the number in `/itm/<id>` URLs). Returned URLs are
  always the canonical `https://www.ebay.com/itm/<item_id>`, never the tracking-parameter links on results.
- `search` filters use eBay's own parameters: `sort` (`best_match`, `ending_soonest`, `newly_listed`,
  `price_shipping_lowest`, `price_shipping_highest`, and `ended_recently` for sold searches), `buying_format`
  (`all`, `auction`, `buy_it_now`), one `condition`, `price_min`/`price_max` in USD, `free_shipping`,
  `returns_accepted`, `item_location` (`us_only`, `north_america`, `worldwide`), `category_id` (eBay's `_sacat`),
  and `page` (up to 20, up to 60 listings each). Keywords do not filter by themselves.
- Prices are strings as eBay shows them for the session (`price_text`) plus a number when a single amount is
  shown. Shipping, delivery estimates and currency follow the browser session's location; the tools never
  change it, and the ship-to ZIP code eBay appends to a delivery estimate is removed from `delivery_text`
  (a signed-in session's ship-to address is the account's).
- `seller.username` from `search` is the value to pass to `get_seller_profile`. On `get_listing` the seller
  card shows a store's display name for sellers with an eBay Store, so `seller.name` may not be a username;
  `seller.username` is read from the listing's own seller link and can be null.

### Sold listings

`search` with `sold_only: true` adds eBay's sold-and-completed filters. eBay redirects that request to a
sign-in page for a signed-out browser, and the tool reports `login_required` (it cannot read where eBay
redirected, so the message says which state the page header shows). Each sold item carries `sold_date_text`.
For a listing that accepts Best Offer the price on the card is not necessarily what the buyer paid, so those
items have `best_offer: true` and a `price_caveat`. `get_listing` on a sold or
ended listing loads with eBay's notice in `status_message` and `availability: "out_of_stock"`; if eBay has
relisted the item, its `/itm/` URL may later redirect to the new item, and the result is then `redirected` with
the new item number in the message. Clock times in eBay's notices follow eBay's server rendering and may not be
in the browser's time zone; `search` returns auction time left as a countdown and no clock times.

## URL patterns

All three tools use `["https://www.ebay.com/*"]` instead of the default
`["https://ebay.com/*", "https://*.ebay.com/*"]`. The marketplace (search, items, feedback) is on
`www.ebay.com`, and `ebay.com` redirects there. The page tools issue relative requests, so on another host
they would call that host: `cart.ebay.com` (cart), `signin.ebay.com` and `signup.ebay.com` (sign-in and
account completion), `pay.ebay.com` (checkout) and `mesg.ebay.com` (messages) are different applications, and
these tools must never be offered on checkout or sign-in pages. With the narrowed patterns they are simply not
listed there, and each tool also returns `wrong_page` without a request if a runtime registers it on a
document whose origin is not `https://www.ebay.com`.

## Output contract

Every tool returns `status: "ok"` (`search` also `no_results`) or `{ status: "error", error_kind, error_message }`.
Input is validated before any request; a bad input never reaches eBay.

| error_kind | meaning |
|---|---|
| `invalid_input` | the input failed validation; nothing was requested |
| `wrong_page` | the tool ran on a document that is not `https://www.ebay.com` |
| `login_required` | `search` with `sold_only`: eBay redirected to sign-in or account completion |
| `not_found` | `get_listing`: eBay answered HTTP 404 for the item number |
| `profile_unavailable` | `get_seller_profile`: eBay showed its error state; the username does not exist or the page failed to load, and the tool cannot tell which |
| `blocked` | eBay answered its error page (HTTP 403) on all three attempts |
| `rate_limited` | HTTP 429; not retried |
| `challenge` | eBay redirected to a verification page (`/splashui/captcha` or `/splashui/challenge`); a person has to complete it in the browser, the tool never tries |
| `redirected` | any other redirect (for example to sign-in or a regional page); not followed |
| `request_failed` | the fetch failed before any response |
| `site_error` | another HTTP 4xx or 5xx |
| `site_changed` | the page loaded but its markup was not recognized (including a listing that shows variation menus whose data could not be read); nothing is guessed |

`search` returns `no_results` only when eBay's own count says 0 results; a page with no recognizable cards and
no zero count is `site_changed`.

## Site quirks

- **Intermittent 403 "Error Page".** eBay answers same-origin fetches with HTTP 403 and an "Error Page | eBay"
  document ("Something went wrong on our end") in bursts. On 2026-09-29, from one Kernel browser, 8 search
  fetches spaced about 10 s apart all succeeded; fetches sent within a few seconds of each other failed often
  (roughly half in one series), independent of the `Accept` header, and the error cleared within a minute. It
  affected search most and item and feedback pages rarely. Each tool retries an error page up to twice, after 4 s
  and 8 s, then returns `blocked`; in one series of six back-to-back searches through the tool all six
  succeeded, two after retries. The tools do not try to get past a block, and callers should not loop on
  `blocked`.
- **Null does not mean no.** A results card shows a returns line only for "Free returns", so `returns_text` is
  null for cards whose sellers accept paid returns (22 of 60 cards with `returns_accepted` set, in one check);
  and a fixed-price card that offers Best Offer often says neither "Buy It Now" nor a bid count, so
  `buying_format` is null for it (31 of 60 cards with the `buy_it_now` filter, in one check).
- **Time zones.** eBay renders clock times ("Today 05:01 PM") in the fetched HTML in its own time zone, which
  differed from the tab's by three hours in one check. `search` therefore returns only the countdown.
- **Two shipping lines.** An item page can carry the label "Shipping" twice: a short summary ("FREE") and the
  full line with carrier and location. The longer value is returned.
- **Top-level navigation.** In one QA browser every top-level navigation to a `/sch/` URL showed the Error
  Page while page-context fetches worked intermittently; the tools only fetch.
- **Decoy "Sponsored" text.** Every result card ends with the reversed text `derosnopS` in a visually empty
  element. It is not a sponsored flag: all 60 cards on a page carry it. No real sponsored marker was found, so
  `sponsored` is not reported and the decoy text is never returned.
- **Placeholder cards.** Result pages contain promo cards titled "Shop on eBay" with an empty element id and a
  fake link; only cards whose element id starts with `item`, whose `data-listingid` is a 9 to 14 digit number
  and whose link (when present) names the same item are returned.
- **Two seller lines on cards.** Usually the username and feedback are two spans; Top Rated sellers show one
  span ("name 99.8% positive (20.1K)") inside a `sellerOrStoreInfo` badge container. Both are parsed from the
  whole line, and that container is not reported as a badge.
- **Buying format.** A card says `Buy It Now` only for some fixed-price listings, and shows a bid count for
  auctions; `buying_format` is `null` when the card says neither. Use the `buying_format` filter to restrict.
- **Redirects are not followed.** Requests use `redirect: "manual"`: a cross-origin redirect (sign-in) makes a
  followed fetch throw without saying why, and a manual redirect is how eBay signals the sign-in requirement.
  When a manual redirect comes back the tool follows it once to read where it leads: a same-origin target can be
  read (`/splashui/...` is eBay's verification page, reported as `challenge`), a cross-origin one cannot (reported
  as `login_required` for `sold_only`, otherwise `redirected`). The cost is that a benign same-origin redirect
  is reported as `redirected` too. One was seen: the `/itm/` URL of an auction that ended unsold and was relisted
  redirected to the new item a couple of minutes after it ended, and `get_listing` then names the new item number.
- **Verification pages and blocks vary by environment.** In the Kernel browsers used for the checks below no
  verification page appeared. In a separate, non-stealth local Chromium on a datacenter-style egress (used for
  the extension check), eBay redirected search, item and feedback fetches to `/splashui/challenge` or
  `/splashui/captcha` on some calls and answered 4 of 4 spaced search fetches with HTTP 403, so a caller can
  expect `challenge` and `blocked` outcomes where the browser's network is treated as automated.
- **Store sellers on item pages.** The seller card shows the store name (for example a display name with spaces)
  where the username would be; the username is read from the link to the listing's description document
  (`itm.ebaydesc.com/itmdesc/<id>?...&seller=<username>`), which was present for both a store and a
  non-store seller.
- **Description text is not returned.** It is served from `itm.ebaydesc.com`, a different registrable domain that
  a page tool's fetch cannot read.
- **Variation data is private.** Menus come from eBay's inline page model (`MSKU.selectMenus`, `menuItemMap`,
  `variationsMap`). Each option's `out_of_stock` flag is eBay's flag for the option on its own; combinations
  across several menus are not resolved, and the price range is over all variations.
- **Account setup gate (not used by these tools).** With a signed-in test account that had not completed eBay's
  contact-information step, My eBay pages, the signed-in cart and bid history redirected to a "Complete your
  account info" page while sold search worked. The tools never enter contact information.

## Known limitations

- **Untested surfaces.** `rate_limited` (HTTP 429), `redirected` for a non-verification redirect on a public
  search, and `site_error` were never seen live and are covered by fixtures only. A verification page served
  with HTTP 200 instead of as a redirect would be reported as `site_changed`, never solved.
- `new_listing` was true for newest-first keyboard results in one builder check and absent in a QA sample of
  about 900 cards, so treat it as best effort. Page 2 can repeat items from page 1 because rankings shift between
  requests, and a card's condition label can differ from the item page's ("New (Other)" versus "New without box").
- `search` returns one results page per call (up to 60 listings); eBay's total is text such as `57,000+`, and
  `total_results_approximate` is true when it ends with `+`.
- Not reported: sponsored placement, product ratings shown on some cards, coupon prices, seller descriptions,
  multi-quantity or multi-condition filters, distance sorting, and per-combination variation prices.
- `top_rated` on `get_seller_profile` is true when the page carries eBay's Top-rated line; false means the line
  was absent, which was not checked against a seller known not to be Top-rated.
- `get_seller_profile` returns `profile_unavailable` both for a username that does not exist and for a page that
  failed to load.
- `sold_only` was verified live only with one signed-in test session on a US eBay site; other eBay country sites
  (`ebay.co.uk`, `ebay.de`, ...) are different registrable domains and are not covered.
- Only the Kernel browser runtime was exercised live for the builder checks below; the Chrome extension runtime
  is described under Verification.

## QA summary

Builder live checks, 2026-09-29, fresh headful stealth Kernel browser, signed out, all three tools registered
as one namespace batch through the custom-tools API (the runtime accepted the schemas), invoked through the
WebMCP invoke API:

| tool | case | result |
|------|------|--------|
| search | broad query with `limit` 60; price, free shipping, returns, condition (new, used), `us_only`, category and page filters; price and newest sorts; auction sort by time left | 60 clean items; every filter narrowed the results as documented (for example 160,000+ to 85,000+ with `returns_accepted`); auction bids and time left parsed; a Top Rated seller line and a `New Listing` tag were found and fixed during these checks |
| search | nonsense query; invalid `limit`; `sold_only` signed out | `no_results` (`0 results for ...`); `invalid_input`; `login_required` |
| search | `sold_only` and `ended_recently` in a signed-in test session (tools registered temporarily there, removed afterwards) | 6 sold items with dates and Best Offer items flagged with the caveat; 5 items sorted by `ended_recently`, all dated the day of the check |
| get_listing | fixed-price with Best Offer; store seller; variation listing with 11 variations; sold listing; unknown item number | all fields parsed; store-name and username split fixed; variation menus and price range; `status_message` and `out_of_stock`; `not_found` |
| get_seller_profile | a public seller; an unknown username | counts, ratings, top-rated; `profile_unavailable` |
| all | tools listed on `www.ebay.com` only | not listed on `cart.ebay.com` or `example.com` |

Fixture tests in `tests/ebay-tools.test.mjs` run each page-side function from its source (re-created in a fresh
context, as the runtime does) against fabricated markup with a fake `fetch`, using the test-only DOM shared
with the etsy.com tests. They cover input validation before any request, origin refusal, every output branch
against its schema, the filter parameters sent, retry and backoff, redirects, both seller-line layouts,
decoy and placeholder handling, text-noise removal, and that only relative GET-style requests are made:

```sh
node --test tests/ebay-tools.test.mjs
```

Independent QA, round 1 (agent `agt_d977f53d650492ebf073`, pi / Sonnet 5.5, own Kernel browser, signed out, head
`04aa9b3`): NOT SIGNED OFF. About 70 live tool calls, 61 outputs validated against their schemas with no
failures, 37 malformed inputs made no request, results were identical from five starting pages with the tab URL
unchanged, and the largest output (60 results) was 56,706 bytes. Findings, all addressed in the next revision:

- D1 (blocking): `seller_username` `..` passed validation and requested `/fdbk/`; usernames must now contain a
  letter or digit.
- D2 (medium): `delivery_text` ended with the session's ship-to ZIP; it is removed.
- D3 (medium): the relisted-auction redirect above; the result now names the new item and the README says so.
- D4 to D9 (minor): bare "Ends in" countdown label on ended auctions, `gtin` "Does not apply", the short "FREE"
  shipping row winning over the full line, clock times without a time zone (`ends_text` removed), undocumented
  nulls, and `null` accepted for `sort`, `page`, `limit`, `buying_format` and `sold_only` because the Kernel
  runtime does not validate page-tool input against the schema (the tool's own checks are the only gate there).

Independent QA, round 2: not yet run; all three tools stay `draft`.

## Verification

Kernel runtime: the builder checks and QA round 1 above. `sold_only` success was never QA-tested (no
authorized signed-in session); the builder verified it once in one signed-in test session.

Chrome extension runtime (Chromium 153, this repository's `extension/` built at the reviewed commit, a scratch
profile, tools installed with `xwebmcp dev` and invoked through `xwebmcp mcp` with `open_tab` and `invoke_tool`,
because the CLI refuses tabs it did not open): the builder got successful `search` and `get_listing` results and
a successful `get_seller_profile` result, `invalid_input` and signed-out `login_required` outcomes, and, on
other calls in the same session, `challenge` outcomes where eBay redirected to its verification page (the
builder had pre-granted `https://www.ebay.com/*` in the scratch copy of the manifest instead of using the popup's
Grant access prompt; no runtime code was changed). QA's own extension run granted the site through the prompt,
but eBay served a verification page to its network, so it saw only error paths (`redirected` in that revision)
and `..` reproduced D1. Parity with the Kernel runtime is therefore shown only for the cases listed here:
not for every input, not for unrelated starting pages, and not for the navigation-lifetime case.

## Sessions

Browser and agent identifiers used for QA are ephemeral and are recorded in the pull request conversation
rather than here. This repository is canonical; no credentials, account details or live-view URLs are stored
in it.
