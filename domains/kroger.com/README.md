# kroger.com

Tools for Kroger (https://www.kroger.com).

| tool | file | status | notes |
|------|------|--------|-------|
| login | [login.js](login.js) | qa_passed | One submission maximum; live success, already-signed-in, account mismatch and invalid credentials verified; MFA, lockout and CAPTCHA synthetic only |
| search_products | [search_products.js](search_products.js) | qa_passed | First results page for the selected store and fulfillment method, with prices, availability and sponsored flags; works signed out |
| get_product | [get_product.js](get_product.js) | qa_passed | One product by 13-digit UPC: price, promotion, availability, per-order limit |
| get_cart | [get_cart.js](get_cart.js) | qa_passed | Active cart with priced lines, saved-for-later lines and an estimated subtotal; requires sign-in |
| add_to_cart | [add_to_cart.js](add_to_cart.js) | qa_passed | Adds by UPC after checking existence, availability and the per-order limit; increments an existing line; requires sign-in |
| update_cart_item | [update_cart_item.js](update_cart_item.js) | qa_passed | Sets an absolute quantity by UPC, 0 removes; never touches saved-for-later lines; requires sign-in |

The login sections below are unchanged from the login PR. The shopping tools are
documented in [Shopping tools](#shopping-tools) at the end of this file.

## Native WebMCP tools

None found (checked 2026-09-25 with `webmcp.listTools()` and
`document.modelContext.getTools()` on the homepage, a search results page
(`/search?query=milk`), a product page (`/p/...`), the cart (`/cart`), the sign-in
redirect (`/signin`) and `/account/profile`, which is a 404). Re-checked signed in
on 2026-09-25 while building the shopping tools: still none on the homepage,
search results, a product page and the cart.

`document.modelContext` exists on every page as the browser's `ModelContext` API
(`registerTool`, `getTools`, `executeTool`, `ontoolchange`) with zero registered
tools; `navigator.modelContext` is undefined. Kroger does not register anything
itself, so there is no native login, search or cart tool to conflict with, and the
custom namespace `kroger.com` is the only source of tools on these pages.

## Scope and loading

`login.js` is a single self-contained array expression (no imports, no trailing
semicolon). Register it under namespace `kroger.com`; it is CDP-backed and matches
`https://kroger.com/*` and `https://*.kroger.com/*`, which covers the identity
provider host `login.kroger.com` where the form lives.

```javascript
const source = (await import("node:fs")).readFileSync("domains/kroger.com/login.js", "utf8");
await webmcp.addCustomTools({ namespace: "kroger.com", tools: eval(source), forceOverwriteNamespace: true });
const tab = (await currentTab()).targetId;
const tool = (await webmcp.listTools()).find(t =>
  t.source.custom?.namespace === "kroger.com" && t.tool.name === "login" && t.source.target_id === tab
);
const result = await webmcp.invokeTool(tool.tool_ref, {
  email: "qa@example.invalid",
  password: "fabricated"
}, { timeoutSec: 120 });
repl.write(JSON.stringify(result));
```

`listTools()` returns one `tool_ref` per open kroger.com tab; pick the one whose
`source.target_id` is the tab the Browser REPL is attached to, because the tool
drives the attached tab. Straight after a navigation `listTools()` can return an
empty list for a few seconds while the registration is reconciled; wait and list
again rather than treating it as missing. `forceOverwriteNamespace: true` replaces every tool in the
namespace, so later search and cart tools must be registered together with this one
as a single array. `invokeTool` accepts at most `timeoutSec: 120`. The tool keeps a
110-second budget of its own: every wait (20 s search controls, 20 s results, 30 s
landing, 30 s form, 45 s observation) is capped at the time remaining, and the form
is not submitted when fewer than 20 s remain, so a slow entry ends with an explicit
`unknown` before any submission rather than a runtime timeout after one.

Inputs: `email` (required), and exactly one of `password` or `otp`
(4–8 digits, for a verification step that is already visible). `keep_signed_in`
defaults to `true`, matching the site's default. Never print, persist or commit the
values you pass.

## Entry path

The tool never navigates straight to a Kroger URL:

1. If the attached tab is already signed in on kroger.com, it returns success
   without touching the page (`entry_path: "already_signed_in"`).
2. If the `login.kroger.com` sign-in form is already visible, it uses it
   (`already_open`).
3. Otherwise it opens `https://start.duckduckgo.com/`, searches `kroger login`
   through the accessibility tree (the search box is only reachable as the
   `combobox "Search with DuckDuckGo"`), and clicks the first organic result
   (`article[data-testid="result"]`; ad rows are `[data-layout="ad"]` and
   `article[data-testid="ad"]`). The result is only followed if it is an `https`
   link to `kroger.com` or a subdomain. On 2026-09-25 the first organic result was
   `https://www.kroger.com/signin`, which redirects server-side to the Azure AD B2C
   authorize URL on `login.kroger.com` (policy `b2c_1a__ciam_signin_signup`), so the
   B2C page sees `document.referrer = https://www.kroger.com/` (`search_referrer`).
4. If the organic result lands on a kroger.com page without the form, the tool
   opens sign-in from the site's own header: `#welcome-menu-open-close-button`
   (reads "Sign In" when signed out) and then `#welcome-menu-sign-in-out-button`
   ("Sign in") inside the menu (`site_navigation`). The first header click sometimes
   does not open the menu, so the tool retries once.

Each entry step fails with its own named message (`search_controls_unavailable`,
`search_origin_unexpected`, `search_result_missing`, `search_result_unapproved`,
`site_entry_failed`, `sign_in_control_missing`, `login_form_unavailable`), each
quoting the wait it actually allowed, and never falls back to direct navigation. A
DuckDuckGo bot challenge is reported as `captcha_or_challenge` before any Kroger
request. `https://www.kroger.com/signin` occasionally stalls on a loading spinner
behind the consent modal when its sign-in bundle fails to load (independent QA saw
`net::ERR_ABORTED` on `account-sign-in.*.js` once); the tool then returns
`site_entry_failed` with nothing submitted, and a fresh invocation is safe.

## Output contract and safety

- Success: `logged_in: true` with `authenticated`, `mfa_required`, `next_step`
  (`none` or `enter_otp`), `landing_url`, `account_name_or_hint` (the first name
  from the header, or the masked code destination), `account_check`
  (`email_confirmed` or `unverified`), `entry_path`, `submission_attempted` and
  `evidence`. `mfa_required: true` means the password was accepted and a code step
  is showing; it is never reported as `authenticated`.
- Failure: `logged_in: false` with `error_kind` (`invalid_input`,
  `invalid_credentials`, `captcha_or_challenge`, `mfa_failed`,
  `locked_or_throttled`, `unknown`), the site's `error_message` when
  `error_source` is `site`, the `step` that failed, the `entry_path` taken so far
  (`none` before any page action), `attempts_remaining_if_shown` (only when the
  site prints a count) and `submission_attempted`.
- Account check: the `kroger-si-customer-data-token` cookie on `.kroger.com` is a
  JWT whose payload carries `emailAddress`. Success compares it (case-insensitively)
  with the supplied email; a mismatch is a failure at step `account_check` rather
  than a success for the wrong account. When the cookie is absent or unreadable the
  result is `account_check: "unverified"`.
- Double-submit guard: before clicking Sign In the tool writes a
  `kroger.com.login.submission.v1` marker to `sessionStorage` on
  `login.kroger.com`. A pending marker younger than 15 minutes blocks another
  submission from the same tab; a conclusive site response marks it `concluded` so a
  corrected retry in the same tab is allowed. There is exactly one click per
  invocation and no internal retry. Never invoke again after an `unknown` result
  without inspecting the browser.
- Input is validated before any page access; the runtime's JSON Schema gate rejects
  most malformed input before `execute` runs, and the tool re-checks it.

## Site quirks

- The form is plain DOM on `login.kroger.com`: `form#attributeVerification`,
  `input#signInName` (`autocomplete=username`), `input#password`,
  `input#kr_remember_me_adi_true` ("Keep me signed in", checked by default) and
  `button#continue` ("Sign In"). No shadow roots, no iframes.
- Errors render in place without navigation: `.error.pageLevel` (for example
  `#claimVerificationServerError`) and `.error.itemLevel` (`#signInName-error`,
  `#password-error`). Hidden error containers carry `aria-hidden="true"` and a
  `hidden` class, so visibility is checked before reading them. A heading "We can't
  sign you in" is present but hidden on every B2C page; headings are only trusted
  when visible.
- An unknown account returns the page-level message `Invalid email address`, which
  the tool classifies as `invalid_credentials`. A wrong password for a real account
  was not exercised.
- Success flow: the B2C page posts to `/SelfAsserted`, then navigates to
  `https://www.kroger.com/connect-auth#code=...` where MSAL (PKCE) exchanges the
  code, sets `loggedIn=yes` on `.kroger.com` and redirects to the original URL. The
  tool waits for `loggedIn=yes` plus a header welcome button that is not "Sign In";
  the whole round trip took about 16 s live.
- The signed-in header is `#welcome-menu-open-close-button` with the first name
  (`data-testid="WelcomeButtonDesktop"`); the menu contains
  `#welcome-menu-sign-in-out-button` ("Sign out", `data-testid`
  `WelcomeMenuButtonSignOut`) and links such as My Account and My Purchases.
- **Do not open `/signin` or `/account/dashboard/` while signed in.** Both start an
  MSAL redirect through `login.kroger.com` and `connect-auth`; navigating away
  before that round trip finishes dropped the session and the `loggedIn` cookie in
  this browser. The tool never visits those URLs on a signed-in tab.
- Akamai Bot Manager cookies (`_abck`, `bm_*`, `ak_bmsc`) are set on both hosts.
  No challenge appeared during three submissions from one residential stealth
  browser; the CAPTCHA branches are synthetic only.
- The customer data token expires roughly 30 minutes after it is issued and is
  refreshed by the app; `loggedIn` outlives it. After expiry the account check
  degrades to `unverified` rather than failing.
- A CDP browser context created with `Target.createBrowserContext` shares the
  browser's tool registration but not its cookies. This is how the failure path was
  exercised in the same browser without a fresh fingerprint.

## Status and known limitations

Status: `qa_passed`. Two independent failure-path QA passes ran against the
branch (see the QA matrix); the final commit differs from the second pass only in
the wording of entry-step timeout messages, which a third no-submission pass
re-checked.

Live-verified on 2026-09-25 (one residential stealth browser, personal profile,
`us-east`):

- Fabricated credentials, entry from a product page in an isolated context:
  DuckDuckGo search, first organic result, B2C form, one submission,
  `invalid_credentials` with `Invalid email address`, 10.2 s, marker `concluded`.
- Real credentials, entry from a product page: `search_referrer`, one submission,
  no MFA, `authenticated: true`, the header first name, landing `https://www.kroger.com/`,
  16.6 s.
- Already signed in: invoked from the cart page with the account email, no
  navigation or submission, `already_signed_in` with `email_confirmed`; invoked with
  a different email, failure at `account_check` with nothing submitted.

Unverified:

- MFA. Kroger never showed a verification step for this account; `otp` mode and
  `mfa_required` detection are generic (visible code input, no visible password
  field) and covered by mocked tests only.
- Lockout, remaining-attempt counters, CAPTCHA and the solver extension. Nothing
  challenged the browser during testing.
- A wrong password for an existing account (only an unknown email was submitted),
  and `keep_signed_in: false`.
- Behaviour on the other proxy configurations. Only the residential `cincy` proxy
  was used; no hard block was seen, so no second configuration was needed.
- Cosmetic: if an earlier step overruns the 110 s budget (for example a hung
  browser call), the entry timeout messages can quote a zero or negative number of
  seconds. The outputs stay schema-valid and nothing is submitted in that state.

Best lead for the next person: the signed-in identity, store and loyalty number all
sit in the `kroger-si-customer-data-token` JWT, and the header first-name button is
rendered on every page, so search and cart tools can reuse `read()`'s
`signedIn`/`accountEmail` check unchanged. The site's own surfaces for those tools
are `/search?query=<term>&searchType=default_search`, `/p/<slug>/<upc>` product
pages with `Add to Cart: <name>` buttons, and `/cart`.

## Live QA matrix

| # | case | browser | entry | result |
|---|------|---------|-------|--------|
| 1 | fabricated email + password from a product page | isolated context of the main browser | search_referrer | `invalid_credentials` "Invalid email address", 1 submission |
| 2 | real credentials from a product page | main browser | search_referrer | `authenticated: true`, 1 submission, no MFA |
| 3 | real email while already signed in, from the cart | main browser | already_signed_in | `authenticated: true`, `email_confirmed`, 0 submissions |
| 4 | different email while already signed in | main browser | already_signed_in | failure `account_check`, 0 submissions |
| 5 | independent QA pass 1 (`agt_b45e69419d64ca15c913`, browser `agtt2pr9yv4twl1ewkobsw0v`, commit `5990a80`): 8 malformed inputs rejected by the runtime schema gate, otp-only input rejected by the tool, fabricated submission from a product page via DuckDuckGo, second fabricated submission from `/cart` (server redirect to the form, `already_open`), stale `tool_ref` on example.com | QA browser, no profile | search_referrer, already_open | both submissions `invalid_credentials` "Invalid email address", exactly one `POST /SelfAsserted` each; no blockers; three findings fixed (110 s budget, README snippet, `entry_path` on failures) |
| 6 | independent QA pass 2 (`agt_2abe214c89e45307dfec`, browser `lmu9vb5mpgn45fb5yzcq2ygt`, commit `2e764b7`): schema gate, otp-only input, one fabricated submission via DuckDuckGo, budget review, stale `tool_ref` | QA browser, no profile | search_referrer | `invalid_credentials`, one `POST /SelfAsserted`, 24.3 s; one earlier attempt stopped at `site_entry_failed` when `/signin` stalled, nothing submitted; no blockers; two wording/docs findings fixed |
| 7 | independent QA pass 3 (`agt_81701554c70a9f25b7e6`, browser `l9vvy5ve38v384wkveufq8rj`, commit `8ec94c6`, no submissions): schema gate, otp-only input, stale `tool_ref` on two unrelated pages, diff review of the timeout wording | QA browser, no profile | none | no blockers; 79/79 local tests; one low wording nit recorded under known limitations |

Local contract tests (mocked helpers, no live traffic):

```sh
node --test tests/kroger-login.test.mjs
```

They cover the single-expression contract, the registry entry, input rejection
before page access, search-entry routing from unrelated and non-login pages, every
named entry failure, pre-existing lockout and challenge, fresh-versus-stale error
handling, the redirect to a signed-in home page, the code step, account
confirmation and mismatch, the sessionStorage guard, an uncertain click, and `otp`
mode.

## Sessions

- Independent QA browsers were deleted by their agents after each pass.
- Source: this repository is canonical; sessions expire but files do not.

## Shopping tools

`search_products`, `get_product`, `get_cart`, `add_to_cart` and `update_cart_item`
let an agent go from "I want X" to "X is in my cart" and inspect or adjust the cart.
They call the JSON endpoints the site's own pages use, from page context with the
page's cookies, rather than scraping the DOM. Register all six kroger.com tools as
one array (`forceOverwriteNamespace` replaces the whole namespace):

```javascript
const fs = await import("node:fs");
const names = ["login", "search_products", "get_product", "get_cart", "add_to_cart", "update_cart_item"];
const tools = names.flatMap(n => eval(fs.readFileSync(`domains/kroger.com/${n}.js`, "utf8")));
await webmcp.addCustomTools({ namespace: "kroger.com", tools, forceOverwriteNamespace: true });
const tab = (await currentTab()).targetId;
const tool = (await webmcp.listTools()).find(t => t.source.custom?.namespace === "kroger.com" && t.tool.name === "search_products" && t.source.target_id === tab);
repl.write(JSON.stringify(await webmcp.invokeTool(tool.tool_ref, { query: "bananas", limit: 5 }, { timeoutSec: 120 })));
```

### Flow

1. `search_products({ query, limit })` returns the first results page for the
   store and fulfillment method the session has selected, each result carrying the
   13-digit `upc`, `price_cents`, `promo_price_cents`, `available`,
   `max_order_quantity`, `sponsored` and `rank`. It works signed out.
2. `get_product({ upc })` returns the same record for one product (use it to
   confirm availability or read the per-order limit before adding).
3. `add_to_cart({ upc, quantity })` verifies the product exists and is sellable for
   the active fulfillment method, then writes the cart. Adding a UPC that is
   already an active line **increments** it, so two calls add twice. Requires a
   signed-in session; use `login` first.
4. `get_cart()` returns the active cart with priced lines, the saved-for-later
   lines (which the tools never change), `item_count` and an estimated
   `subtotal_cents`. If the cart read succeeds but the product lookup that adds
   descriptions and prices fails (for example a rate limit), the lines are still
   returned with `product_details: "unavailable"` and null prices.
5. `update_cart_item({ upc, quantity })` sets an absolute quantity; `0` removes the
   line. A UPC that is not an active line is `not_in_cart`.

None of the tools checks out, changes the store, address or fulfillment method,
applies coupons or touches memberships, and none exposes those actions.

### Output contract

Every output has a `status`: `ok`, `no_results` (search only) or `error`. Errors
carry `error_kind` and the site's or the tool's `error_message`:

| error_kind | meaning |
|---|---|
| `invalid_input` | Rejected before any page access (the runtime's JSON Schema gate rejects most of these first). |
| `not_authenticated` | The `loggedIn` cookie is not `yes`, or the site answered 401/403. Cart tools only. |
| `not_found` | No catalog record with a description for that UPC (`get_product`, `add_to_cart`). |
| `unavailable` | The product exists but is not sellable for the active fulfillment method at the selected store (`add_to_cart`). |
| `quantity_limit` | The resulting quantity would exceed the site's `maxOrderQuantity` (`add_to_cart`, `update_cart_item`). |
| `not_in_cart` | The UPC is not an active line; saved-for-later lines count as not in the cart (`update_cart_item`). |
| `challenge` | HTTP 429 or a `cpr_chlge` body from Akamai Bot Manager, twice in a row (one retry after 5 s is built in). |
| `site_error` | Any other failure: non-JSON body, HTTP error, no active cart, header capture failure, or a write the site accepted but did not apply. |

All prices are integers in US cents. `price_cents` is the regular price for the
active fulfillment method; `promo_price_cents` is set when the site shows a
promotion below the regular price (a promotion block at the regular price is
reported as no promotion), and cart line totals use it. For produce sold by weight,
`sold_by_weight` is true and `price_cents` is the site's estimate for one unit
(`price_note` carries wording such as "about $1.03 each", `unit_price_text` the
per-pound price). `fulfillment` in every success output names the fulfillment
`type` (`DELIVERY`, `PICKUP` or `IN_STORE`), `store_id`, `postal_code` and, for
pickup, `store_name`, because prices, availability and the cart are tied to it.

### How the tools talk to the site

- Search: `GET /atlas/v1/search/v1/products-search?filter.query=…&filter.locationId=<store>&filter.fulfillmentMethods=IN_STORE&filter.fulfillmentMethods=PICKUP&filter.fulfillmentMethods=DELIVERY&option.groupBy=PRODUCT_VARIANT&option.quickFacets=true&option.personalization=PURCHASE_HISTORY&page.size=<limit>`,
  the same query the site's own results page sends, so the first page and its
  order match what the shopper sees (with `option.personalization=RELEVANCE` and
  a single method the order differed badly: independent QA saw eggs ranked first
  for "oat milk"). Hits carry only `upc`, `description` and rank; paid placements
  have a `placementId` and rank 0. Prices and `available` (for the active
  fulfillment method) come from the product endpoint.
- Products: `GET /atlas/v1/product/v2/products?filter.gtin13s=<upc>&…&projections=items.full,offers.compact,inventory.projected,variantGroupings.compact`.
  `fulfillmentSummaries[]` holds per-method `regular.price`, optional `promo.price`,
  `availability.sellable`, `availability.inventoryLevel` and `maxOrderQuantity`.
  The endpoint also returns placeholder records for unknown codes; the tools treat
  a record without `item.description` as not found.
- Cart: `GET /atlas/v1/carts` returns `data.carts[]`; the tools use the one with
  `type: "ACTIVE"`. Writes are `PUT /atlas/v1/carts/<cartId>` with
  `{ lineItems: [...] }`: a new line is `{ gtin13, modalityType, quantity, channel: "WEB", substitutionPolicy: "SHOPPER_CHOICE" }`,
  an existing line is `{ id, gtin13, modalityType, quantity }`, and quantity `0`
  removes it. The response is the whole cart, which the tools use to confirm the
  write. A PUT for a UPC that is already a line does **not** increment; that is
  why `add_to_cart` reads the cart first and writes by line id.
- Required headers: `x-kroger-channel: WEB` and `x-laf-object`, a JSON array of
  the session's location-and-fulfillment context (one entry per fulfillment
  method, each with `sources[].storeId`). Without it the API answers
  `LAF_OBJECTS_REQUIRED`. The page builds this object in memory from
  `POST /atlas/v1/modality/preferences`, which answered a page-context call with
  an Akamai challenge (HTTP 429, `cpr_chlge`), so the tools never call it. Instead
  they capture the header from the site's own next request: enable CDP network
  events, arm a one-shot `Network.requestWillBeSent` wait, reload the current
  kroger.com page, and read `x-laf-object` from the first `/atlas/v1/` request.
  The value is cached in `sessionStorage` (`kroger.com.laf.v1`) for 30 minutes,
  keyed by the fulfillment type, location id, postal code and coordinates from
  the `x-active-modality` cookie plus the `StoreCode` and `DD_modStore` cookies,
  so a store or fulfillment change invalidates it. The cookie also carries a
  timestamp that is rewritten on every load in signed-out sessions; it is
  deliberately left out of the key, otherwise every call would reload the page. The capture is retried once; live it
  took 2 to 5 seconds. The tools also send `x-facility-id`, `x-modality-type` and
  `x-modality` derived from that object, as the page does.
- The active fulfillment method is read from the `x-active-modality` cookie; if it
  is absent the first entry of the captured object is used. `store_name` is only
  reported for pickup and in-store entries (those with a `handoffLocation`); the
  delivery entry's address block is never surfaced beyond its postal code.
- The cached header object contains the session's delivery address, as the
  site's own header does on every request. It lives in the tab's `sessionStorage`
  (cleared when the tab closes) for at most 30 minutes; treat that storage as
  part of the signed-in session.
- The cart tools check the `loggedIn` cookie before any navigation or header
  capture, so a signed-out tab gets `not_authenticated` without a reload.

### Site quirks

- If the attached tab is not on `www.kroger.com`, or is on `/signin` or
  `/account/dashboard/`, the tools open the homepage first before any header
  capture. They never reload those two paths (see the login notes: reloading them
  starts an MSAL redirect that dropped the session once).
- Akamai Bot Manager rate-limits the JSON endpoints per exit address. During the
  independent QA pass a fresh browser on the same residential proxy got a
  "Too many requests" page on the homepage, and one product lookup in the
  signed-in session answered HTTP 429 with a challenge iframe that reloaded the
  page; the limit cleared within about ten minutes. The tools report this as
  `challenge`. A 429 is answered at the edge before the origin sees the request,
  so each API call is retried once after 5 seconds (safe for writes too), and the
  tools wait 3 seconds after a header-capture reload because calls made before the
  page's sensor has run are the ones that get challenged. Two challenges in a row
  are reported as `challenge`; wait a few minutes rather than looping.
- A product search for nonsense still returns fuzzy matches, so `no_results` is
  rare; `total_count` and `available_count` come from the site.
- `page.size` is a hint: the site returns a few paid placements beyond it. The
  tools look up all returned UPCs and cut the list to `limit` after dropping
  records without a description.
- `maxOrderQuantity` is per fulfillment method and can be very large (thousands
  for shelf-stable items); for bananas it is absent, so no limit is enforced.
- Right after a navigation `listTools()` can be empty for a few seconds; list
  again. Each open kroger.com tab has its own `tool_ref`.
- The tools rely on CDP helpers (`cdp`, `waitForEvent`) for the header capture,
  so they need a runtime that exposes those helpers to `kind: "cdp"` tools.

### Known limitations

- Store and fulfillment selection is read, never changed. If no store or address
  is selected, the tools return `site_error` asking for one to be chosen on the
  site.
- Only the first results page is returned (`limit` up to 40).
- Substitution preferences, special instructions, coupons, saved-for-later moves
  and the checkout total are out of scope; `subtotal_cents` is an estimate from
  current prices, not the checkout total.
- `add_to_cart` for a UPC that only exists as a saved-for-later line creates a new
  active line; whether the site merges the two was not tested live.
- Signed-out cart behaviour was not tested; the cart tools refuse unless
  `loggedIn=yes`.
- Kroger's bot protection was not triggered during testing except by the one
  `modality/preferences` probe; a `challenge` result means wait, not retry.
- Live verification used one residential stealth browser signed in to one
  account with a delivery address; independent QA also used fresh signed-out
  browsers with a pickup store. In-store mode is covered by the fixture tests only.
- Sponsored placements are returned where the site's API interleaves them, so
  they occupy `limit` slots and can rank ahead of organic hits; the organic order
  itself matches the site's results page. Filter on `sponsored` if you only want
  organic results.
- In the signed-in session, 2 of 14 cart calls in the last QA pass re-captured
  the header (one extra page reload each) although the store and fulfillment
  cookies looked unchanged; the cause was not isolated. The cost is one reload.
- `get_product` reports a catalog placeholder such as the "Bag Holder" record as
  `status: "ok"` with `available: false` and no price; `add_to_cart` refuses it
  as `unavailable`. Treat `available` and `price_cents`, not `status`, as the
  signal that something can be bought.

### QA summary

Fixture tests (no live traffic; fabricated address, cart and products):

```sh
node --test tests/kroger-shopping.test.mjs
```

They cover the single-expression and no-Node-globals contract, registry entries,
input rejection before page access for every tool, homepage routing from
unrelated pages, header capture, caching and retry, API error mapping (401, 403,
429, non-JSON, challenge body), search ordering, deduplication, sponsored flags,
limits and `no_results`, product lookup and not-found, cart pricing with
promotions and saved-for-later separation, add (new line, increment, limit,
unavailable, unknown, silently ignored write) and update (set, remove,
not-in-cart, saved-for-later refusal, limit, ignored write).

Live verification is recorded in the table below as it happens.

| # | case | result |
|---|------|--------|
| 1 | `get_product` for a gallon of milk, signed in, delivery | ok: price, unit price text, inventory HIGH, max order quantity |
| 2 | `get_cart`, signed in | ok: 0 active lines, 1 saved-for-later line with a promotional price |
| 3 | `get_product` for a placeholder code | ok with `available: false` and no price (the code is a real "Bag Holder" record) |
| 4 | `search_products` "bananas", limit 4, header cache cleared (cold) | ok in 10.0 s including the header capture: 509 matches, a sponsored yogurt first, bananas second with `sold_by_weight`, promo prices on other rows |
| 5 | `add_to_cart` bananas, quantity 1, on an empty active cart | ok: new line, `previous_quantity` 0, `quantity` 1, 2.1 s |
| 6 | `add_to_cart` bananas again, quantity 1 | ok: same line id, `previous_quantity` 1, `quantity` 2 (increment, written by line id) |
| 7 | `get_cart` | ok: 1 active line at 2 × 103 cents, `subtotal_cents` 206, saved-for-later line listed separately |
| 8 | `update_cart_item` bananas to 1, then to 0 | ok: quantity 1, then `removed: true`, `line_item_id` null, `cart_item_count` 0 |
| 9 | `update_cart_item` bananas to 0 again | `not_in_cart`, no write |
| 10 | `update_cart_item` on the saved-for-later UPC | `not_in_cart` with the saved-for-later hint, saved line unchanged |
| 11 | `add_to_cart` for the "Bag Holder" placeholder and for an unknown code | `unavailable` and `not_found`, no writes |
| 12 | `get_cart` at the end | 0 active lines; the saved-for-later line exactly as before the session |
| 13 | Re-run on the final source (login-first check, degraded cart read, store-name gating, 429 retry): `search_products` cold from a product page, `add_to_cart` ×1, `update_cart_item` to 0, `get_cart` | search ok in 11.3 s including capture and settle; add ok (quantity 1); removed; final cart 0 active lines with `product_details: "complete"` and the saved-for-later line unchanged |
| 16 | Re-run after the QA pass 2 fixes: `search_products` "oat milk" cold, then "bananas" warm, then `add_to_cart` ×1, `update_cart_item` to 0, `get_cart` | cold search ok in 21.7 s with the site's own order (sponsored Silk, then Planet Oat and Oatly, a promotion only on Oatly); warm search ok in 1.8 s with no reload; add ok; removed; final cart 0 active lines, saved-for-later line unchanged |
| 17 | Independent QA pass 3 (`agt_def5f2f10a89acbeeec4`, commit `01181ae`, the signed-off source): ordering compared with the site's own results page for two queries at a pickup store (organic order identical), three consecutive signed-out calls (cache hit on the second and third), 38 malformed inputs at the gate, stale `tool_ref` on an unrelated page, product-page invocation, signed-out cart tools, then the full cart flow including an out-of-stock avocado refused as `unavailable` | no blockers, no majors; 66 outputs schema-valid; cart restored byte-identical; three minor findings recorded under known limitations |
| 15 | Independent QA pass 2 (`agt_8b7f0522e17f2f1d16e8`, commit `07a9215`): 40 malformed inputs at the gate, stale `tool_ref` on two unrelated pages, read-only tools signed out in a fresh browser (pickup store), signed-out cart tools, then the full cart flow in the signed-in session | no blockers; 23 live outputs schema-valid; cart restored byte-identical; three findings fixed in the next commit: search order now mirrors the site's own query, the header cache no longer misses on the cookie timestamp, a promotion at the regular price is reported as none |
| 14 | Independent QA pass 1 (`agt_58a2b36b09f3e89c56bd`, commit `e2de074`) | Akamai blocked its fresh browser on the homepage and answered one `get_cart` enrichment call with 429, so the live plan stopped before any cart write; 38 malformed inputs rejected at the schema gate, stale `tool_ref` on an unrelated page failed fast; no defects in what ran; five minor code findings, all fixed in the next commits |

### Sessions

- Browser sessions used for live verification are ephemeral and listed in the
  hand-off report, not here.

