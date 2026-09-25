# instacart.com

Tools for Instacart (https://www.instacart.com).

| tool | file | status | notes |
|------|------|--------|-------|
| login | [login.js](login.js) | qa_passed | Passwordless email-code login. Email step, code step, already-logged-in check and wrong-account check live-verified on 2026-09-25; independent failure-path QA passed on the current source. |
| list_stores | [list_stores.js](list_stores.js) | qa_passed | Stores serving the account's address, with the `store_slug` and shop id the other tools take. |
| search | [search.js](search.js) | qa_passed | First-page product search in one store; exact matches first, related on request. |
| get_item | [get_item.js](get_item.js) | qa_passed | One item's price, availability, quantity rules and rating for a store. |
| get_cart | [get_cart.js](get_cart.js) | qa_passed | One store's cart with names, prices and subtotal, or a summary of every non-empty cart. |
| add_to_cart | [add_to_cart.js](add_to_cart.js) | qa_passed | Adds or increases a cart line after checking availability and quantity rules; one mutation, never retried. |
| update_cart_item | [update_cart_item.js](update_cart_item.js) | qa_passed | Sets a cart line to an exact quantity; 0 removes; one mutation, never retried. |

Register all seven files together as one array with `forceOverwriteNamespace: true`;
registering one file that way removes the others.

## Native WebMCP tools

None found (checked 2026-09-25, stealth Kernel browser, logged out and logged in):
home `/`, `/login`, `/store`, `/store/account`, search `/store/s?k=milk`,
storefronts `/store/costco/storefront` and `/store/kroger/storefront`, and the
cart control on the search page. On every page `webmcp.listTools()` returned no
page-provided tools and `document.modelContext.getTools()` returned `[]`.
`document.modelContext` exists (Chrome's `ModelContext` interface with
`registerTool`, `getTools`, `executeTool`, `ontoolchange`) but Instacart registers
nothing on it; `navigator.modelContext` is undefined. No `mcp`-related scripts,
`<link>` or `<meta>` tags were present. The custom `login` tool therefore conflicts
with nothing.

## Login flow (as observed)

Instacart's email login has no password step for this account:

1. `/login` shows `Log in`, one `input[type=email][name=email]`, a `Continue` submit
   button, and Google / Facebook / Phone alternatives. The same form opens as a modal
   from the `Log in` header control on other pages.
2. Submitting the email runs an invisible reCAPTCHA v2 (site key on the login page;
   a visible image challenge appeared on some submissions and the stealth browser's
   solver cleared it in about 20 s), then `GET /graphql?operationName=GetEmailAvailability`.
3. Unknown address: `availability: "available"` and the form shows
   **"Enter a valid email address."** under the field (`aria-invalid`,
   `aria-errormessage`). The tool reports this as `invalid_credentials` with the site
   text. Addresses on reserved domains such as `example.com` produce the same message.
4. Known address: `POST /graphql?operationName=SendVerificationCode` emails a six-digit
   code and the page switches to **Verify email** with the text
   "We sent a 6-digit code to <address>", one `input[name=code][autocomplete=one-time-code]`
   (`maxlength=6`, drawn as six boxes) and a resend countdown. Nothing else is offered.
5. Typing the sixth digit submits automatically
   (`POST /graphql?operationName=CreateUserSessionFromVerificationCode`) and the
   page lands on `/store`. `/store/account` shows the account email in plain text
   and a `Log out` link (`/accounts/logout`); logged-out visits to `/store*` redirect
   to `/login?next=...`.

The vault item stores an email and a password. The password is never used: the site
never asked for one. `password` is accepted by the tool for interface parity only.

## Entry path

`https://start.duckduckgo.com/` → query `instacart login` (search box reached through
the accessibility node `combobox "Search with DuckDuckGo"`) → first organic
`[data-testid="result"]` link, accepted only when its destination is an `https`
`www.instacart.com` URL → click. Observed first result: `https://www.instacart.com/login`,
no advertisements, and the landing page kept `document.referrer` =
`https://duckduckgo.com/`. When the browser is already logged in the same click
redirects to `/store/?categoryFilter=homeTabForYou`. If the landing page is not the
sign-in form, the site's own `Log in` control opens it. There is no direct-navigation
fallback; each entry step fails with its own `stage`.

## Usage

```javascript
const source = (await import("node:fs")).readFileSync("domains/instacart.com/login.js", "utf8");
await webmcp.addCustomTools({ namespace: "instacart.com", tools: eval(source), forceOverwriteNamespace: true });
const ref = async () => (await webmcp.listTools()).find(t => t.source.custom?.namespace === "instacart.com" && t.tool.name === "login").tool_ref;
// Step 1: submits the address once; expect mfa_required: true (or authenticated: true if already logged in).
await webmcp.invokeTool(await ref(), { email: "person@example.com" }, { timeoutSec: 120 });
// Step 2: read the code from the inbox, then enter it while the Verify email step is visible.
await webmcp.invokeTool(await ref(), { email: "person@example.com", otp: "123456" }, { timeoutSec: 90 });
```

`forceOverwriteNamespace: true` replaces every `instacart.com` tool; register later
search or cart tools together with this one as a single array. Re-list tools after
any navigation because `tool_ref` values change. Allow 120 s for the email step
(entry plus up to 60 s of solver time) and 90 s for the code step.

## Output contract

- `logged_in: true, authenticated: true, mfa_required: false, next_step: "none"`:
  `/store/account` shows the requested email and a Log out control. `account_name_or_hint`
  is the displayed email.
- `logged_in: true, authenticated: false, mfa_required: true, next_step: "enter_email_otp"`:
  the address was accepted and the Verify email step is open. `account_name_or_hint`
  is the site's "We sent a 6-digit code to …" sentence. This is **not** an authenticated
  session.
- `logged_in: false` with `error_kind` in `invalid_input | invalid_credentials |
  captcha_or_challenge | mfa_failed | locked_or_throttled | unknown`, the site's message
  when `error_source` is `site`, `stage` (`input`, `account_check`, `search_entry`,
  `site_entry`, `before_submit`, `after_submit`), `submission_attempted`, and
  `attempts_remaining_if_shown` (null unless the site shows a count; Instacart showed none).

Safety properties: one email submission or one code entry per invocation, never a retry,
never a "request a new code", never a password entry. A `sessionStorage` marker is
written before the submit click (15 minutes for the email step, 1 minute for the code
step); it blocks a re-invocation in the same tab after an uncertain outcome and is
released only after a conclusive site rejection (`invalid_credentials`, `mfa_failed`).
A browser logged in as another account fails without submitting; both addresses are
masked in the message. Kernel proxy error pages ("proxy error" / "egress-proxy-mitm")
are recognized; the read-only account-page navigation is retried once, submissions never.

## Site quirks

- The `Continue` button and the `Sign up` control are both `type=submit`; only the one
  inside the form that owns the email input is used.
- `fillInput` (physical key events) registers with the React form; the DOM value is
  checked against the requested address before the click.
- The code field is one input, not six; typing six digits auto-submits, so the tool
  never clicks a submit control on that step.
- The `cincy` residential proxy returned two different Kernel error pages during
  development (HTTP 502 `upstream_timeout`, and `egress-proxy-mitm … unexpected EOF`),
  on Instacart and on DuckDuckGo. Both are transient; the tool reports them as `unknown`
  with a proxy message and the stage, at every step including the search entry.
- A site error left on the page by an earlier attempt is not this attempt's verdict.
  `otp` mode first requires a visible Verify email step, then judges only feedback that
  changed or reappeared after the six digits were typed; an unchanged stale error ends
  in `unknown` after 30 s rather than a false `mfa_failed`.
- The stealth browser's solver keeps solving reCAPTCHA challenges on an open `/login`
  tab after the tool returns (independent QA counted 46 solves in one session). No
  extra `GetEmailAvailability` request followed, so it does not resubmit anything.
- Logged-out `/store*` URLs redirect to `/login?next=…`; the account check treats that
  redirect as "not logged in" and continues to the search entry.

## Status and known limitations

Status: see the table at the top and `registry.json`; the QA history is below.

Live-verified on 2026-09-25 (residential `cincy` proxy, stealth, the account's saved
browser profile):

| path | input | result | time |
|------|-------|--------|------|
| already logged in, starting from a Kernel proxy error page | real email | DuckDuckGo entry → landing redirected to `/store` → `/store/account` matched → `authenticated: true`, no submission | 11.5 s |
| already logged in, wrong account | fabricated email | `unknown`, "logged in as a different account (r***@…)", no submission | 0.4 s |
| logged out, fabricated address | fabricated email | DuckDuckGo entry → `/login` → one submission → `invalid_credentials` "Enter a valid email address." | 7.6 s |
| logged out, real address | real email | one submission → `mfa_required: true`, `next_step: enter_email_otp` | 9.0 s |
| Verify email step open | real email + emailed code | six key presses → auto-submit → `/store/account` matched → `authenticated: true` | 6.6 s |

Independent QA, round 1 (agent `agt_3fa02b3438dc8870922b`, its own stealth browser,
`cincy` proxy, no profile, no vault, commit
`c342908`): 8 of 9 checks passed with two fabricated submissions (telemetry showed
exactly two `GetEmailAvailability` requests and no `SendVerificationCode`). Failure
path from `/store/costco/storefront` took 34.7 s including a 23 s solver run on a visible
reCAPTCHA image challenge; from `/help` in a fresh tab it took 9.3 s with no challenge.
All six invalid inputs were rejected by the WebMCP input-schema gate before `execute`
ran; the tool's own checks were exercised locally. The tool was not listed on
non-Instacart pages. Two defects were found and fixed afterwards:

- `otp` mode reported a stale "Enter a valid email address." as `invalid_credentials`
  instead of "No Verify email step is visible", and a stale code error would have
  blocked a corrected code. Fixed by checking for the code step first and judging only
  feedback that changed or reappeared after typing.
- A proxy error page on `start.duckduckgo.com` surfaced as "search controls did not
  become available". Fixed by checking for the proxy page in the search step.

Independent QA, round 2 (same agent, fresh browser with the same settings, deleted
afterwards, commit `2e9708a`): both fixes verified, D1 live and D2 by mock because no
proxy error occurred in that session. A full fabricated failure path from
`/store/costco/storefront` returned schema-valid `invalid_credentials` after one
submission (35.9 s including a solved reCAPTCHA image challenge); the tool was not
listed on non-Instacart pages; the local suite passed. Sign-off: `qa_passed` for the
source at that commit, which is the current source. One non-blocking note remains open
(R1 below). After the sign-off the author re-ran the already-logged-in check and the
`otp`-without-code-step check on the long-lived browser with this exact source:
`authenticated: true` in 0.4 s and "No Verify email step is visible" in 0.4 s.

Unverified:

- Wrong or expired codes (`mfa_failed`), lockout or throttling text, a visible reCAPTCHA
  that the solver fails to clear, and a `Request a new code` resend. These branches have
  mocked coverage only.
- R1 (QA note, not fixed to keep the signed-off source): a Kernel proxy error page on
  the DuckDuckGo *results* page (after the query is submitted) is reported as the generic
  "DuckDuckGo organic results did not become available" rather than as a proxy error, and
  the proxy message says "instead of Instacart" even when the failing page is DuckDuckGo.
  Both outcomes are still `unknown` with no submission.
- The code-step live run (`authenticated: true`) used the revision before the hint
  selection was narrowed and before the QA fixes above; those changes only affect the
  returned hint text and the pre-typing checks, and are covered by the mocked tests.
- The email-step guard blocking a resubmission after an uncertain outcome has mocked
  coverage only; proving it live would cost another real submission.
- Phone, Google, and Facebook logins are out of scope.

Best lead for the next person: the whole flow is GraphQL on `www.instacart.com/graphql`
(`GetEmailAvailability`, `SendVerificationCode`, `CreateUserSessionFromVerificationCode`).
If the DOM changes, those operation names are the stable signals to wait on. The email
step's reCAPTCHA token comes from the site's own `grecaptcha` call, so the tool never
touches the captcha; it only waits for the solver.

Local tests (mocked helpers plus page-reader fixtures; not additional live attempts):

```sh
node --test tests/instacart-login.test.mjs
```

## Shopping tools

Instacart is multi-retailer: catalogs, item ids and carts are all **per store location**.
The flow an agent follows is

1. `list_stores` to pick a `store_slug` (and `service_type`, delivery by default);
2. `search` in that store to get `item_id`s with price, availability and quantity rules;
3. `get_item` for a fresh read of one item (optional);
4. `add_to_cart` / `update_cart_item` to change that store's cart;
5. `get_cart` to read it back.

`item_id` values look like `items_<retailer_location_id>-<product_id>` and only make sense
for the store location that produced them: delivery and pickup variants of the same
retailer have different locations, ids and carts. `get_item` and `add_to_cart` reject an
id whose location does not match the resolved store. Every tool resolves the store from
its slug on each call, so there is no hidden "current store".

All shopping tools work through the site's own persisted GraphQL API
(`https://www.instacart.com/graphql`, `x-client-identifier: web`, page cookies), called
from page context with `fetch`; nothing is scraped from the DOM and no page navigation
is needed beyond opening `/store` when the tab is not on instacart.com. Operations used:
`SharedCurrentUser`, `ShopCollectionUnscoped`, `ShopCollectionScoped`,
`SearchResultsPlacements`, `Items`, `GetProductRatings`, `ActiveCartId`, `CartData`,
`CartTotals`, `PersonalActiveCarts` and the mutation `UpdateCartItemsMutation`. The
persisted-query hashes are pinned in each file; when Instacart rotates one the tool
returns `error_kind: "site_changed"` naming the operation.

The shopper location (address id, zone, postal code, coordinates) is read from the
`GetLastUserLocation` entry of the server-rendered Apollo state (`#node-apollo-state`
on the current page, or fetched from `/store`, with one retry when that fetch fails).
**Every shopping tool needs a logged-in session with a saved delivery address**: in an
anonymous browser `/store` redirects to the login page, so the read-only tools return
`not_logged_in` (redirect seen) or `location_unavailable` (no location anywhere), and
the cart tools return `not_logged_in` before touching anything.

### Usage

```javascript
const fs = await import("node:fs");
const files = ["login", "list_stores", "search", "get_item", "get_cart", "add_to_cart", "update_cart_item"];
const tools = files.flatMap(name => eval(fs.readFileSync(`domains/instacart.com/${name}.js`, "utf8")));
await webmcp.addCustomTools({ namespace: "instacart.com", tools, forceOverwriteNamespace: true });
const ref = async name => (await webmcp.listTools()).find(t => t.source.custom?.namespace === "instacart.com" && t.tool.name === name).tool_ref;
await webmcp.invokeTool(await ref("list_stores"), { query: "kroger" }, { timeoutSec: 60 });
await webmcp.invokeTool(await ref("search"), { store: "kroger", query: "bananas", max_results: 5 }, { timeoutSec: 60 });
await webmcp.invokeTool(await ref("add_to_cart"), { store: "kroger", item_id: "items_165949-2748189", quantity: 1 }, { timeoutSec: 60 });
await webmcp.invokeTool(await ref("get_cart"), { store: "kroger" }, { timeoutSec: 60 });
await webmcp.invokeTool(await ref("update_cart_item"), { store: "kroger", item_id: "items_165949-2748189", quantity: 0 }, { timeoutSec: 60 });
```

The tools are only listed while the tab is on an `instacart.com` page; re-list after any
navigation. Live calls took 1 to 7 seconds each.

### Output contract

Every tool returns either a success object with `status: "ok"` or
`{ status: "error", error_kind, error_message }`. Shared `error_kind` values:
`invalid_input` (rejected before any page access or, for quantity rules, before any
mutation), `navigation_failed`, `not_logged_in`, `location_unavailable`,
`store_not_found`, `site_changed`, `throttled`, `unknown`. `get_item` and `add_to_cart`
add `item_not_found` and (`add_to_cart`) `item_unavailable` and
`cart_update_rejected`; `update_cart_item` adds `not_in_cart`. The two mutating tools
always include `mutation_attempted`, which is true once the cart update was sent even
when the outcome is uncertain; never retry automatically after that.

Items carry `price_string` as displayed (for example `$2.37 each (est.)`), `price_cents`
parsed from the first dollar amount, `available`, `stock_level`, and `quantity`
(`type` "each" or "weight", `min`, `max`, `increment`, `unit`). `add_to_cart` adds to the
existing line (quantity is the increment, and the confirmed total is returned);
`update_cart_item` sets the exact total and `0` removes the line. Both send exactly one
`UpdateCartItemsMutation` and read the resulting cart from the mutation response.

### Site quirks (shopping)

- Search results arrive as ordered "placements": a header (`Results for "…"`,
  `No results for …`, `Related items`), item grids that carry `itemIds` and sometimes
  full items, ad placements, and a `Load more` marker without a cursor. The tool keeps
  grid order, drops ads, hydrates missing items with `Items` (25 ids per request), and
  returns only the first page.
- `Items` silently omits ids it does not know, so an unknown id is `item_not_found`.
  Asked about an id from another store location it returns the product with a null
  price; the tools treat that as `item_not_found` up front.
- A cart may hold lines from a store location the account is no longer assigned to
  (for example after the retailer changed the assigned warehouse). `get_cart` still lists
  them, with names but null prices and `line_total_cents`.
- `UpdateCartItemsMutation` answers an unknown item with a `CartsCartUpdateError`
  (`notFoundBasketProduct`, "Sorry, we couldn't add this item because it is no longer
  available."); a removal of an absent line succeeds with an empty `updatedItemIds`.
  The tools surface the former as `cart_update_rejected` and pre-empt the latter with
  `not_in_cart`.
- Adding certain produce through the site's own button opens a ripeness-preference
  dialog; the API path used here does not, and the tools never set preferences.
- Instacart's own reCAPTCHA covers login only; none of the shopping operations
  triggered a challenge during development.

### Status and known limitations (shopping)

Status: `qa_passed`; see the registry and the QA summary below.

Live-verified on 2026-09-25 in the author's logged-in stealth browser (`cincy` proxy),
using the account's empty Kroger delivery cart and one cheap produce item:

| tool | case | result |
|------|------|--------|
| list_stores | all, `service_type: pickup`, `query: "kro"` | 68 stores at the address; filters and cap applied |
| search | `kroger` / `bananas`, `grapes`, nonsense query, pickup variant | exact matches with prices and quantity rules; a nonsense query returned `exact_match_count: 0` plus related items (the site sometimes returns fuzzy hits as exact matches instead) |
| get_item | known id, unknown id, id under the pickup store | details with stock level; `item_not_found` for both failure cases |
| get_cart | Kroger cart, then all carts | empty Kroger cart with `$0.00` subtotal; three other carts summarized with names and subtotals |
| add_to_cart | add 1, add 2 more, unknown id, fractional quantity | 0→1 then 1→3, subtotal updated; `item_not_found` and `invalid_input` without a mutation |
| update_cart_item | set 2, set 0, set 0 again | 3→2, then removed, then `not_in_cart`; cart back to empty |

Independent QA (agent `agt_6e2dd5dcf4c5b4e04b31`, `smartest` preset, 2026-09-25, commit
`c25ca64`): anonymous stealth browser for the read-only paths plus the author's logged-in
browser for the cart paths. Every output was validated against its output schema; all
input-schema violations were stopped by the WebMCP input gate before any page action; the
tools were not listed on non-Instacart pages and worked from `/help` and `/store/account`.
Cart work used only two cheap items (bananas per-each, one apple sold by weight in 0.25 lb
steps), covered add, increment, set, out-of-stock (`item_unavailable`), wrong-location id,
step-rule rejections, `not_in_cart`, removal, and finished with the carts deep-equal to the
recording. Two findings, both fixed afterwards: the read-only tools' descriptions claimed a
logged-out fallback that does not exist (now they state the login requirement, and a login
redirect is reported as `not_logged_in`), and a transient `/store` fetch failure was
reported as `location_unavailable` (now retried once and, if it still fails, reported as
`unknown` with the HTTP status). QA sign-off: `qa_passed`. The fixes changed only
descriptions, the location fallback, and error wording; they are covered by the local
tests and were re-checked live by the author.

Unverified:

- Ratings with non-zero review counts (only `count: 0` was seen live).
- `throttled`, `site_changed`, and `cart_update_rejected` other than the unknown-item
  case have fixture coverage only.
- Search pagination: only the first page is returned; the `Load more` placement carries
  no cursor and was not followed.
- Extension-host portability was reasoned about (no Node globals; page work runs in the
  page) but only the Node CDP runtime was exercised.
- `cart_item_count` and `item_count` count distinct lines, not units.

Local tests re-create each tool's page-side function in a separate context with a fake
`fetch`, so parsing, quantity rules, single-mutation behaviour and schema conformance
are covered without touching the live site:

```sh
node --test tests/instacart-shopping.test.mjs
```

## Sessions

Browser and agent identifiers used for QA are ephemeral and are recorded in the pull
request conversation rather than here. This repository is canonical; no credentials,
codes, account details or live-view URLs are stored in it.
