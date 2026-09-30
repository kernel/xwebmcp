# ebay.com

Tools for eBay's public marketplace and signed-in sold-price research.

| tool | file | status | notes |
|------|------|--------|-------|
| get_listing | [get_listing.js](get_listing.js) | draft | Listing price/current bid, stock, shipping, returns, seller and variation menus. |
| get_seller_profile | [get_seller_profile.js](get_seller_profile.js) | draft | Public feedback aggregates; no buyer comments. |
| search | [search.js](search.js) | draft | One page, up to 60 listings; sold filters require sign-in. |

## Scope and safety

All tools are read-only. They never bid, offer, buy, publish, message, sign in, complete onboarding, change
shipping preferences, or mutate carts/watchlists. Listing data supports research and manual handoff, not
transaction approval. No executable consequential action is exposed: the runtime does not enforce trusted
human approval for an exact account, item, quantity, price and terms. A caller-supplied confirmation flag
would not establish that approval.

Cart read/add/remove/update and own-watchlist read/save/remove are omitted rather than guessed. The
already-authorized account redirects cart and account pages to the contact-information step. No address
was entered. A signed-out cart probe on 2026-09-30 reached a verification page; no challenge was solved.
Neither populated line-item schemas nor mutation/postcondition contracts were accessible. No account
mutation or live bid was used for QA, and no new login/account was obtained.

## Native WebMCP and execution kind

No native tools were found on the public home, search, listing, seller, deals, cart or account-gate surfaces
checked on 2026-09-29 and 2026-09-30. The three tools are `kind: "page"`: same-origin fetch, HTML parsing,
structured return, no navigation. They do not need a CDP exception or outlive their registering document.

## URL patterns

All three tools use `https://www.ebay.com/*`. Marketplace search/items/feedback live there; `ebay.com`
redirects there. Cart (`cart.ebay.com`), sign-in, signup and checkout hosts are separate applications.
Relative fetches must not run on those hosts. Every execute function also checks the exact origin and
returns `wrong_page` before requesting anything. Tools are not offered on checkout or sign-in hosts.

## Loading and identifiers

Register **all three files atomically** when replacing `ebay.com`; replacing one file alone deletes its
siblings. Re-discover tool references after navigation or namespace replacement. Use a 60-second deadline
and space normal reads by about ten seconds. Stop on `challenge`, `blocked` or `rate_limited`; do not loop.

- `item_id`: 9–14 digit item number from search or `/itm/<id>`; returned links are canonical and omit tracking.
- `seller_username`: `seller.username` from search/listing; a store's display name is not its username.
- `search`: keyword query, sort, buying format, condition, price range, free shipping, returns, location,
  category and page (1–20), with a return limit of 1–60. Filters use eBay's own URL parameters.
- `sold_only: true`: sold/completed listings, with `ended_recently` available. Needs the current session's
  sign-in. Sold Best Offer card prices are not necessarily the accepted sale price; see `price_caveat`.
- Prices, shipping and currency reflect the session without changing it. Auctions show the **current bid**,
  not a final amount. No tax, checkout total or purchase eligibility is established.
- Inputs are validated in execute before requests or page inspection. Invalid input is not delegated to
  the runtime's schema validator. Output fields are allowlisted; page text remains untrusted data.

## Outcomes and site quirks

Successful outputs are `ok` or search's explicit `no_results`. Failures have `status: "error"`,
`error_kind` and `error_message`:

- `invalid_input`, `wrong_page`, `canceled`: no new requests after the condition is detected. Cancellation
  reaches active fetches; cancellation during backoff is checked before the next request.
- `challenge`: current tab is under `/splashui/`, a followed redirect reaches it, or a returned document
  has eBay's recognized verification title. Challenges are never solved or retried.
- `blocked`: three HTTP 403/error-page attempts with 4/8-second backoff. This is a bounded read retry, not
  challenge bypass. `rate_limited` (429) is not retried.
- `login_required`: sold-search redirect with signed-out header or an inaccessible cross-host destination.
  A signed-out header can mask a verification redirect as `login_required`.
- `not_found`: listing HTTP 404. `profile_unavailable`: feedback error state, which does not prove the seller
  does not exist. `site_changed`: unrecognized markup, not an empty success.
- `request_failed`: request/body failure. `site_error`: other direct HTTP errors. `redirected`: other or
  unreadable redirect destinations; no success is inferred from a redirect.

Requests start with `redirect: "manual"`. Except for signed-out sold searches, a redirect triggers one
additional fetch with `mode: "same-origin"`; that fetch follows the **same-host chain**, potentially issuing
multiple GETs. Chrome refuses a cross-host redirect before sending credentials there. Previous independent
network checks confirmed no requests/Set-Cookie reached the sign-in host. Reads may refresh ordinary eBay
cookies. A challenge can cost three GETs; repeated 403 follow-ups cost six over three attempts; an emulated
redirect loop previously cost 22. The tools never perform non-GET requests. Empty/malformed follow-up URLs
now return a typed `redirected` failure rather than throwing.

Result cards include hidden reversed "Sponsored" text even when not sponsored, so no sponsored flag is
reported. Promo/mismatched cards are skipped. Store seller names and usernames are distinguished. A null
returns/buying-format field means the card did not show it, not that returns/offers are unavailable.

## Known limitations

- Account/cart/watchlist tools and consequential execution remain unavailable for the reasons above.
- `sold_only` success has been observed by the builder only; independent signed-in QA is untested. Access
  to another account is not implied. Other country sites are separate registrable domains and unsupported.
- Recognized US ZIP/ZIP+4, Canadian and UK postal codes after "to" are removed, including mid-shipping
  sentences. Six-digit numeric destinations are also removed. Other addresses/formats may remain;
  non-US redaction is fixture-only. Text such as "up to 100" and "3 to 5 days" is retained.
- Variations return each menu option's individual stock flag and an overall price range, not combination
  stock/price. Visible menus without readable data fail closed. No variation is selected.
- Seller descriptions are cross-origin and omitted. Images require an exact ebayimg.com host/subdomain,
  HTTPS and an `/images/` path; credentials, ports, query strings and fragments are not returned.
- Search rankings can drift/overlap between pages. A price-filtered variation card can show a lower price
  than the selected range. `new_listing` is best effort. No sponsored/coupon/product-rating fields.
- Seller `top_rated: false` means the page's line is absent. Feedback errors cannot distinguish a missing
  username from a page failure. Relisted-item detection is fixture/emulation-covered, not repeatably live.
- Clock times in listing notices use eBay's rendering time zone; search returns only countdowns.
- An HTTP-200 verification page with an unrecognized title can still be `site_changed`.

## QA summary

Prior implementation had independent sign-off on sources at `2149c9b`, with signed-out public success/failure
and schema tests. That sign-off does **not** cover the updated sources. Historical findings reviewed before
these changes included cross-host redirect credential leakage (already fixed), incomplete postal-code
redaction, malformed follow-up URL throws, request-count wording and fixture gaps.

Updated fixtures: `node --test tests/ebay-tools.test.mjs` — 64 passing. Full tool suite — 1641 passing;
registry validator — 82 tools valid. Tests use fabricated HTML and mocked fetches, not real account state.
They cover malformed inputs before interaction, same-origin requests, bounded outputs, sold caveats,
redaction, exact image hosts, cancellation before/during reads, body errors, bad redirect URLs, verification
pages, redirects, retries, stock menus, seller aggregates and buyer-comment omission.

Fresh independent review of the updated source is pending; statuses are `draft` until that review completes.

## Verification

**Kernel, updated source, 2026-09-30:** all three files registered together. In the authorized session,
`search` with `sold_only`, `ended_recently` and limit 1 returned one sold item successfully; temporary
registrations were then removed. No account/cart/watchlist mutation occurred. A signed-out scratch browser
on the verification page discovered all three custom tools and each returned `challenge` with no request.
Public success, namespace replacement and unrelated-start-page checks are pending independent review.

**Local Chrome extension:** 14 unit tests pass. Historical extension success covered search/listing on the
old source, while independent runs hit verification pages. Updated-source live extension verification is
pending; no cross-runtime success parity is claimed from unit tests or historical results.

## Sessions

QA browsers and identifiers are ephemeral. No credentials, private account content, user identifiers or
live-view URLs are stored in this repository. Existing login-expiry schedules are preserved.
