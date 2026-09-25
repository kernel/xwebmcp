# ubereats.com

Tools for Uber Eats (https://www.ubereats.com). Sign-in is handled by Uber's shared
auth service at `https://auth.uber.com/v2/`, so the login tool also matches that host.

| tool             | file                                         | status    | notes                                                                                   |
|------------------|----------------------------------------------|-----------|-----------------------------------------------------------------------------------------|
| login            | [login.js](login.js)                         | qa_passed | One submission per step; entry, email, chooser, password, and signed-in paths live-verified; SMS code step fixture-only |
| search           | [search.js](search.js)                       | draft     | Stores and matching items from the site's search feed, one page per call; needs a delivery address |
| get_store        | [get_store.js](get_store.js)                 | draft     | Store details, categories, menu items, or an in-store product search                    |
| get_item         | [get_item.js](get_item.js)                   | draft     | Price, availability, and nested option groups for one item                             |
| add_to_cart      | [add_to_cart.js](add_to_cart.js)             | draft     | Validates against the live menu, then creates or extends the store's cart; needs sign-in |
| get_cart         | [get_cart.js](get_cart.js)                   | draft     | Every cart with priced lines and the site's subtotal and total; needs sign-in           |
| update_cart_item | [update_cart_item.js](update_cart_item.js)   | draft     | Set a line's quantity, 0 removes; last removal deletes the store's cart; needs sign-in  |

## Native WebMCP tools

None found. Checked on 2026-09-25, signed out and signed in, on the home page,
the `auth.uber.com` sign-in steps, `/search?q=pizza`, a `/store/...` page, and the
cart page: `webmcp.listTools()` returned only custom tools, `navigator.modelContext`
is undefined, `document.modelContext` is only the Kernel runtime shim, and no element
carries a `toolname` attribute. Re-checked the same day while signed in, from the feed
and a search page, when the search and cart tools were registered: still none. There is
nothing to conflict with, so every tool here is custom.

## Login

### Entry path

1. Open `https://start.duckduckgo.com/`, search `uber eats login`, click the first
   organic result. Its host must be `ubereats.com` or a subdomain.
2. On the site, click the header `Log in` link (an `<a href="https://auth.uber.com/...">`).
   If Uber's email step is already open in the tab, the tool submits there instead.
3. `auth.uber.com/v2/` shows the identifier step: `#PHONE_NUMBER_or_EMAIL_ADDRESS`
   and `#forward-button` (Continue). Submitting the email leads to one of:
   - the **email code step**: four boxes `#EMAIL_OTP_CODE-0..3` under
     "Enter the 4-digit code sent to you at <email>" (accounts without a password);
   - the **method chooser**: "Welcome back, <email>" with `#alt-action-help-v2`
     (More options) → `#alt-more-options-modal-see-all-options` →
     `#alt-more-options-modal-password` / `#alt-more-options-modal-email`
     (accounts with a linked social login);
   - the **password step**: `#PASSWORD` (`autocomplete=current-password`) under
     "Welcome back. Sign in to continue." The email is not repeated on this step.
4. After the password Uber sends a second factor. For the account tested it was an
   SMS: four boxes `#PHONE_SMS_OTP-0..3` under "Enter the 4-digit code sent via SMS
   at ********NN". More options offered only phone call, WhatsApp, and Google, no
   email code.
5. Success redirects to `https://www.ubereats.com/feed?...`; the header loses its
   `Log in` link and `sid` cookies exist on `.ubereats.com` and `.uber.com`.

### Loading and invoking

Register the file's array expression under namespace `ubereats.com`.
`forceOverwriteNamespace: true` replaces every tool in the namespace, so once search
or cart tools exist they must be registered together as one array.

```javascript
const source = (await import("node:fs")).readFileSync("domains/ubereats.com/login.js", "utf8");
await webmcp.addCustomTools({ namespace: "ubereats.com", tools: eval(source), forceOverwriteNamespace: true });
const tool = (await webmcp.listTools()).find(t =>
  t.source.custom?.namespace === "ubereats.com" && t.tool.name === "login"
);
const first = await webmcp.invokeTool(tool.tool_ref, { email: "qa@example.invalid" }, { timeoutSec: 120 });
// first.output.next_step is "enter_email_code", "enter_password", or "none".
```

One invocation performs at most one step and at most one submission. Drive the flow
by calling again with the field the previous result asked for:

| result `next_step`   | next call                                                                                                  |
|----------------------|------------------------------------------------------------------------------------------------------------|
| `enter_email_code`   | `{ email, otp }` with the 4-digit code from the inbox                                                      |
| `enter_password`     | `{ email, password }`, or securely fill `#PASSWORD` (vault fill) and call `{ email, use_prefilled_password: true }` |
| `enter_sms_code`     | `{ email, otp }` with the 4-digit code the account owner received by SMS                                   |
| `none`               | done; `authenticated` is `true`                                                                            |

Re-list tools and take a fresh `tool_ref` after any navigation or re-registration.
The tool never reads the password field back, never returns cookies or tokens, and
never solves challenges. `logged_in: true` with `authenticated: false` means a step
was accepted, not that the session is signed in.

### Output contract

Success (`logged_in: true`): `authenticated`, `mfa_required`, `next_step`
(`none` | `enter_email_code` | `enter_sms_code` | `enter_password`), `landing_url`,
`account_hint` (the email the code went to, the masked phone number, or the header
account text), `evidence`, and `submission_attempted`.

Failure (`logged_in: false`): `error_kind` (`invalid_input`, `invalid_credentials`,
`captcha_or_challenge`, `mfa_failed`, `locked_or_throttled`, `unknown`), `error_message`,
`step` (`input`, `search_entry`, `site_entry`, `open_login`, `email`, `choose_method`,
`code`, `password`, `verify`), `attempts_remaining` (parsed from the message when Uber
shows one, otherwise null), and `submission_attempted`.

### Site quirks

- **Auth host through the `cincy` proxy.** `www.ubereats.com` loads, but the
  `auth.uber.com` redirect came back as a Kernel proxy error page
  (HTTP 502, `provider_unreachable`) on every attempt. The `us-mobile` proxy
  reaches it; the long-lived session uses that proxy for this reason.
- **Hydration replaces the header.** The server-rendered `Log in` link is visible while
  the document is still loading, and client hydration swaps that node out roughly 2.5 s
  after landing. A link resolved before the swap is detached by click time and the click
  fails as "not actionable". The tool waits for `readyState === "complete"`, re-resolves
  the link, requires it to survive a 1.5 s settle interval, and re-resolves again if the
  click still misses (three attempts, no submission involved).
- **Tool listing.** Per the repository convention, `match.url_patterns` covers
  `ubereats.com`, its subdomains, and `auth.uber.com`, so the tool is listed only on
  those pages. From an unrelated page such as a search engine it is not invocable at
  all; the fixture tests that start from unrelated URLs exercise `execute` directly.
- **Continue starts disabled.** On `auth.uber.com` the Continue control renders disabled
  for roughly the first second after the identifier step appears (observed enabled at
  about 1.5 s, `readyState` complete at about 6.7 s). The email and password steps poll
  up to 10 s for the filled field plus an enabled control before submitting.
- **Code boxes.** Each box holds one digit and focus advances automatically; entering
  the fourth digit submits the form on its own. The tool pastes the whole code into the
  first box (`fillInput`), waits, and clicks Next only if the form is still there.
  Typing digit by digit into separate boxes is not needed and not used.
- **Steps that do not name the account.** The password and SMS steps never repeat the
  email. The tool records each of its own submissions per email in `sessionStorage`
  (`webmcp.ubereats.login.email`, `.password`, `.code`) and only resumes a password or
  SMS step when this tab submitted the email or password for that address within the
  last 30 minutes. Otherwise it starts the entry path over. The same markers stop a
  second email request within 15 minutes, a second password within 1 minute, and a
  second code within 20 seconds.
- **Back button.** `#back-button` on the code steps opens a "Start Over?" dialog
  (`#alt-action-yes` / `#alt-action-no`) rather than returning to the previous step.
- **Stale feedback.** Alerts from an earlier attempt persist. A `MutationObserver` armed
  before each submission marks alert changes; only changed feedback is classified.
- **Saved address.** The feed opens with the profile's saved delivery address, which
  need not be where an order should go. The search and cart tools read it and never
  change it; results and prices depend on it.
- **Marketing overlays.** A cookie notice ("Opt out" / "Got it") sits bottom-right on
  the feed. It does not block the login flow, and the search and cart tools use the
  site's JSON endpoints rather than the page, so it never blocks them either.
- **Account check.** The already-signed-in path calls the site's user endpoint, which
  returns a SHA-256 of the account email rather than the address. The tool hashes the
  requested email in page context and compares; a mismatch is reported as a different
  account without any submission, and the email is never read back from the site.

### Status and known limitations

- Independent QA (agent `agt_b94bb0a4b4d20af839ae`, commit `aae5cc0`) found the
  hydration defect above: the tool never reached Uber's email step on its own in 5 of 6
  live runs. A second pass (agent `agt_c4fd2ee51e0ad730bd35`, commit `84a9be7`) confirmed
  the fix (Log in clicked on its own in 2 of 2 runs that reached the auth page) and found
  the disabled-Continue race above, which stopped 1 of 2 runs before submitting. A third
  pass (agent `agt_2d00f6bdd86545dc85b6`, commit `4c544ca`, the current tool source)
  found no defects: two entries from the home page and from `/search?q=pizza` reached
  the email code step with one submission each.
- The SMS code step is classified and accepted by the tool (`enter_sms_code`, then
  `otp`), but that path has only fixture coverage. When the live password submission
  reached the SMS step, the tool at that revision did not recognize it and returned
  `unknown` after 45 s; the code was then entered by hand through CDP
  (`Input.insertText` into the first box auto-submitted) and the session signed in.
  The exact tag Uber uses for the "sent via SMS at" line was not captured, so
  `account_hint` on that step may be null; the step itself is detected from the box ids.
- Wrong password, lockout, and CAPTCHA classification are fixture-only. The one live
  password submission was correct.
- The `password` input path (plain string) is fixture-only; the live submission used
  vault fill plus `use_prefilled_password`.
- Whether Uber offers an email code instead of SMS for other accounts, or ever skips
  the second factor on a trusted profile, is unknown.
- Best lead for the next person: reproduce a wrong-password submission on a
  throwaway account to capture Uber's exact error text and confirm the
  `invalid_credentials` classification, and capture the SMS-step DOM
  (`h1,h2,h3,label,p` texts) to pin down `account_hint`.

### Live QA matrix

Recorded 2026-09-25. Owner runs used the long-lived session described under Sessions
on the `us-mobile` proxy; fabricated runs used a separate stealth browser on the
`cincy` proxy with no profile, since deleted.

| case                                                       | account     | result                                   | evidence                                              |
|------------------------------------------------------------|-------------|------------------------------------------|-------------------------------------------------------|
| DuckDuckGo entry → Log in → email step → code requested    | fabricated  | `enter_email_code`, 11 s, 1 submission   | code step heading named the fabricated address        |
| Re-invocation while the code step is open                  | fabricated  | `enter_email_code`, 0 submissions        | no second code request                                |
| Wrong 4-digit email code                                   | fabricated  | `mfa_failed`, 1 submission               | fresh inline error on the code step                   |
| Email step → method chooser → Password method              | owner       | `enter_password`, 1 submission           | `#PASSWORD` visible, empty                            |
| Vault fill of `#PASSWORD` + `use_prefilled_password`       | owner       | submitted once; tool then reported `unknown` (SMS step unrecognized at that revision) | SMS code step rendered with `#PHONE_SMS_OTP-0..3` |
| SMS code entry                                             | owner       | done by hand over CDP, not through the tool | redirect to `/feed`, `sid` cookies set             |
| Already signed in                                          | owner       | `authenticated: true`, 0.8 s, 0 submissions | no `Log in` link, menu present, `sid` cookie       |
| Native tool survey (5 surfaces, signed out and in)         | n/a         | none                                     | see above                                             |

Independent QA of commit `aae5cc0` (agent `agt_b94bb0a4b4d20af839ae`, two stealth browsers
without profile or vault, one on `cincy` replaced by one on `us-mobile` after the proxy
error page; both deleted):

| case                                                       | account     | result                                   | evidence                                              |
|------------------------------------------------------------|-------------|------------------------------------------|-------------------------------------------------------|
| Six malformed inputs                                       | fabricated  | rejected by the WebMCP input-schema gate | URL and `webmcp.*` storage unchanged                  |
| `otp` with no code step open                               | fabricated  | `invalid_input`, 0 submissions           | URL unchanged                                         |
| Entry from home, search page, and the open email step      | fabricated  | `unknown` at `open_login`, 0 submissions (5 of 6 runs) | detached `Log in` node after hydration   |
| Entry landing on the proxy error page (`cincy`)            | fabricated  | `unknown` at `open_login`, 0 submissions | fails closed                                          |
| Re-invocation with the code step open                      | fabricated  | `enter_email_code`, 0 submissions        | code step opened by hand for this and the next rows   |
| `otp` for a different email on that code step              | fabricated  | `invalid_input`, 0 submissions           |                                                       |
| Wrong 4-digit code                                         | fabricated  | `mfa_failed`, 1 submission               | "The email passcode you've entered is incorrect."     |
| Same wrong code again immediately                          | fabricated  | `unknown` (20 s guard), 0 submissions    |                                                       |

Independent QA of commit `84a9be7` (agent `agt_c4fd2ee51e0ad730bd35`, one browser on
`cincy` and one on `us-mobile`, both deleted):

| case                                                       | account     | result                                   | evidence                                              |
|------------------------------------------------------------|-------------|------------------------------------------|-------------------------------------------------------|
| Entry from home (`cincy`)                                  | fabricated  | `unknown` at `open_login`, 0 submissions | proxy error page recognized and named                 |
| Entry from home (`us-mobile`), run 1                       | fabricated  | `unknown` at `email`, 0 submissions      | Continue still disabled when read once                |
| Entry from home (`us-mobile`), run 2                       | fabricated  | `enter_email_code`, 26 s, 1 submission   | code step heading named the fabricated address        |
| Re-invocation with the code step open                      | fabricated  | `enter_email_code`, 0 submissions        |                                                       |
| Wrong 4-digit code, then the same again                    | fabricated  | `mfa_failed`, then 20 s guard            | 1 submission                                          |
| Four malformed inputs on the home page                     | fabricated  | rejected, no page action                 | all outputs valid under Ajv                           |
| Listing on `/search?q=pizza`                               | n/a         | listed once the page settled             | one empty listing mid-navigation                      |

Independent QA of commit `4c544ca` (agent `agt_2d00f6bdd86545dc85b6`, one browser on
`us-mobile`, deleted). This is the sign-off for the login tool source; the later change
to the signed-in account check is covered by fixtures and a live owner run, see below.

| case                                                       | account     | result                                   | evidence                                              |
|------------------------------------------------------------|-------------|------------------------------------------|-------------------------------------------------------|
| Entry from home                                            | fabricated  | `enter_email_code`, 17.8 s, 1 submission | search engine → site → Log in → auth in telemetry     |
| Re-invocation with the code step open                      | fabricated  | `enter_email_code`, 0 submissions        | email marker unchanged                                |
| Entry from `/search?q=pizza` (second fabricated email)     | fabricated  | `enter_email_code`, 21.7 s, 1 submission | code step heading named the second address            |
| Two malformed inputs on the home page                      | fabricated  | rejected, no page action                 | all outputs valid under Ajv                           |

Local contract and fixture tests:

```sh
node --test tests/ubereats-login.test.mjs
```

They mock the DOM and CDP helpers (fake clock, `sessionStorage`, mutation observer) and
cover schema branches, input rejection before any page action, entry from unrelated
and non-login pages, entry failures, stale feedback, uncertain clicks, the chooser,
password and prefilled-password handling, both code steps, and the per-step guards.
They are not live evidence.

## Search and cart

Six read and cart tools built on the JSON endpoints the site itself calls from the page
(`/_p/api/*`, POST with the page's cookies and the site's own `x-csrf-token: x` header).
None of them scrape or click; each checks that the tab is on `ubereats.com`, opens the
home page if it is not, and then calls the endpoints from the page's context. They never
open checkout, never place an order, never touch payment, promotions, memberships, or
the delivery address.

### Flow

1. `search({ query })` returns stores, each with `store_id`, and for product queries
   (groceries, convenience) the matching items with `item_id`, `section_id`, and
   `subsection_id`. Restaurant queries return stores only.
2. `get_store({ store_id })` returns the store's categories and menu items with the same
   three ids; `get_store({ store_id, query })` searches inside the store instead, which is
   the way to find a specific product in a large grocery store.
3. `get_item({ store_id, item_id, section_id, subsection_id })` returns the price, whether
   it is sold out, and the option groups. Call it whenever `has_options` is true: each
   group has `group_id`, `min`, `max`, and options with `option_id` and `price_minor`;
   an option can carry `child_groups` that open once it is chosen.
4. `add_to_cart({ store_id, item_id, section_id, subsection_id, quantity?, options?, special_instructions? })`
   re-reads the item, rejects sold-out items and any option set that misses a required
   group, exceeds a group's `max`, names an option outside its group, or picks a sold-out
   option, and only then creates the store's cart or adds to it. Uber Eats keeps one cart
   per store, and adding an item that is already in that cart with the same options
   raises that line's quantity instead of adding a second line; the tool reports the
   resulting `line_id` and `quantity` either way.
5. `get_cart({})` lists every cart with `cart_id`, lines with `line_id`, unit prices with
   options, and the site's subtotal and total (fees included).
6. `update_cart_item({ cart_id, line_id, quantity })` sets a line's quantity; `0` removes
   it, and removing the last line deletes that store's cart (`cart_deleted: true`).

Ids come only from these tools. A `store_id` may be given either as the UUID the tools
return or as the 22-character id at the end of a store URL (it is the base64url form of
the same UUID bytes). Every other id must be the UUID as returned. Prices are integers in
the minor unit of the returned `currency` (`price_minor`, `unit_price_minor`,
`subtotal_minor`, `total_minor`), with the site's formatted text alongside.

### Loading and invoking

Register all seven tools as one array under namespace `ubereats.com`, because
`forceOverwriteNamespace: true` replaces every tool in the namespace:

```javascript
const fs = await import("node:fs");
const tools = ["login", "search", "get_store", "get_item", "add_to_cart", "get_cart", "update_cart_item"]
  .map(name => eval(fs.readFileSync(`domains/ubereats.com/${name}.js`, "utf8"))[0]);
await webmcp.addCustomTools({ namespace: "ubereats.com", tools, forceOverwriteNamespace: true });
const ref = name => (await webmcp.listTools()).find(t => t.source.custom?.namespace === "ubereats.com" && t.tool.name === name).tool_ref;
const found = await webmcp.invokeTool(await ref("search"), { query: "bananas" }, { timeoutSec: 60 });
```

`search`, `get_store`, and `get_item` work signed out as long as the session has a
delivery address (the `uev2.loc` cookie); without one `search` returns
`no_delivery_address`. The three cart tools require a signed-in session and return
`not_logged_in` otherwise. Live calls took 1 to 3 s for reads and 3 to 8 s for cart
changes, which re-read the cart afterwards; `timeoutSec: 60` is enough.

### Output contract

Every output is `{ ok: true, ... }` or `{ ok: false, error_kind, error_message }` with
`error_kind` one of `invalid_input`, `not_logged_in`, `no_delivery_address`,
`not_found`, `unavailable`, `invalid_options`, `site_error`, `unknown`. Input problems
are rejected before any page or site call, and the message says what, if anything, was
changed (`Nothing added.`, `Nothing changed.`). Cart tools return the cart they touched
in the same shape `get_cart` uses, read back from the site after the change, so the
reported quantities are what the site holds, not what was requested.

### Site quirks

- **The cart endpoints do not validate.** The site accepts an add with any item UUID,
  a missing required option, or a removal of a line that does not exist, and only fails
  later at checkout (its per-order read then errors with "Found invalid item"). The
  tools therefore validate every add against `getMenuItemV1` and every update against
  the current cart before calling a mutation.
- **Ids.** Store pages use the base64url form of the store UUID; the search feed and
  the endpoints use the UUID. Item reads need `sectionUuid` and `subsectionUuid` as well
  as the item UUID (`invalid_uuid` otherwise), which is why the three ids travel
  together.
- **Option payload.** Chosen options are sent as a map keyed by
  `<group uuid>+<groupId>` (the site's key format; `groupId` is 0 for the groups seen)
  to a list of `{ uuid, price, quantity, title, defaultQuantity, customizationMeta }`.
  Child groups use their own keys in the same map.
- **Prices.** Menu prices are integers in minor units, except that grocery items priced
  by weight can carry fractional values; the tools round them. Lines in the eater's
  cart list carry `price: 0`; the per-order read (`getDraftOrderByUuidV1`) has the real
  unit prices and `getCheckoutPresentationV1` (called with only the subtotal, total, and
  basket-size payloads; it is a read, not the checkout page) has the totals.
- **Merging.** Adding an item that is already in the cart with the same options returns
  a new line id in the add response, but the cart keeps the original line with the
  summed quantity. The tools locate the line by item and options after the add.
- **Removing the last line** deletes the draft order on the site's side; no separate
  discard call is needed.
- **Search feed.** Grocery and convenience queries return `MINI_STORE_WITH_ITEMS`
  entries (store plus matching items); restaurant queries return `REGULAR_STORE`
  entries with no items. Twenty entries per page, `meta.offset` is the next offset.
- **In-store search.** `getInStoreSearchV1` needs `isGrocery` to match the store's
  merchant type; restaurant results can carry `isAvailable: false` for items in a
  menu section that is not currently being served, which the tools pass through as
  `available: false`.
- **Signed out, the user endpoint answers HTTP 403 `rtapi.forbidden`** rather than
  `isLoggedIn: false`. The cart tools treat that as `not_logged_in`; any other failure of
  that endpoint is a `site_error`.
- **Grocery listings carry no price text.** Store catalog items in grocery stores have
  `price` but an empty `priceTagline`; the tools format `price_minor` in the store's
  currency for `price_text` when the site gives none. Restaurant listings and item reads
  have the site's own text (trimmed).
- **The checkout page.** `/checkout` shows "Place order" controls and upsell modals.
  Nothing here navigates to it; the cart drawer on any store page and the endpoints
  above are the only cart surfaces used.

### Status and known limitations

- Independent QA (agent `agt_48810e77599257408338`, commit `faae4c5`) passed every
  contract case live except the signed-out cart tools, which reported the site's 403 as
  `site_error`; that and four minor findings (empty grocery `price_text`, a spurious
  second problem in one `add_to_cart` rejection, cart option `group_id` in the site's
  keyed form, a trailing space in `price_text`) are fixed in the current source with
  fixture coverage. Status stays `draft` until a QA pass signs off the current source.
- Live-verified on 2026-09-25 through the registered tools on the owner's signed-in
  session (`us-mobile` proxy): search for a grocery product and for a restaurant
  cuisine including a second page; a grocery store listing, a restaurant in-store
  search, and an unknown store; item reads with and without option groups and an
  unknown item; an empty cart; adding a grocery item, adding it again (quantity merged
  to 2), a restaurant item with a required option (rejected without the option,
  accepted with it), a wrong option set (three distinct problems reported); a
  quantity change; a missing line; removing each line (both carts deleted); and the
  cart empty afterwards. The cart was empty before the work and empty after it.
- Fixture-only: child option groups in the add payload (the site's own add of a
  nested option was not observed), the signed-out `not_logged_in` and
  `no_delivery_address` paths, `site_error` paths, and entry from a page outside the
  site (the tools are only listed on `ubereats.com` pages by their `url_patterns`, so
  that path can only be exercised by calling `execute` directly).
- Sold-out items and options were not seen live; the classification uses the
  `isSoldOut` flags the endpoints return.
- Search results depend on the session's delivery address, and prices are per store.
  `search` covers the first page (20 entries) per call; `get_store` on a large grocery
  store returns only the featured carousels, so use `query` there.
- Pickup mode, scheduled delivery, group orders, business profiles, and special
  instructions beyond a free-text note are not supported.
- Best lead for the next person: run one live add with a nested child option on a
  restaurant item (a pizza with a topping) and compare the resulting cart line's
  `customizations` with the payload the site sends when the same choice is made in
  the item modal.

### Live QA matrix

Owner session, 2026-09-25, through the registered tools:

| tool             | case                                                        | result                                                 |
|------------------|-------------------------------------------------------------|--------------------------------------------------------|
| search           | grocery product query                                       | 19 stores with items, `has_more`, 2.5 s                |
| search           | restaurant cuisine query, `offset: 20`                      | 20 stores, no items, 2.4 s                             |
| get_store        | grocery store by URL id, `max_items: 5`                     | `grocery`, 30 categories, 5 items, truncated, 1.6 s    |
| get_store        | restaurant with `query`                                     | `restaurant`, 4 matching items with options, 3.1 s     |
| get_store        | unknown store                                               | `not_found`                                            |
| get_item         | grocery item, restaurant item with a required group          | prices and groups as on the site, about 1 s each       |
| get_item         | unknown item                                                | `not_found`                                            |
| get_cart         | before any change                                           | `carts: []`                                            |
| add_to_cart      | grocery item, then the same item again                      | one line, quantity 1 then 2, subtotal £1.35 then £2.70 |
| add_to_cart      | restaurant item without its required option                 | `invalid_options`, nothing added                       |
| add_to_cart      | restaurant item with the option and a note                  | second cart, unit price 100, option listed             |
| add_to_cart      | two picks in a pick-one group plus an unknown option        | `invalid_options` naming all three problems            |
| get_cart         | two carts                                                   | both listed with the site's subtotal and total         |
| update_cart_item | quantity 2 to 3                                             | applied, subtotal £4.05                                |
| update_cart_item | unknown line                                                | `not_found`, nothing changed                           |
| update_cart_item | quantity 0 on each cart's only line                         | removed, `cart_deleted: true`, `cart: null`            |
| get_cart         | after the removals                                          | `carts: []`                                            |

Independent QA of commit `faae4c5` (agent `agt_48810e77599257408338`): one fresh stealth
browser on `us-mobile` without profile or vault for the signed-out paths (address set on
the site's own home page to a public landmark, browser deleted afterwards), and the
owner session for the cart paths. All 71 outputs were valid under Ajv; the cart was
empty before and after; no call navigated anywhere, and none touched `/checkout`.

| tool             | case                                                        | result                                                 |
|------------------|-------------------------------------------------------------|--------------------------------------------------------|
| search           | no address, then grocery, restaurant, page 2, `max_items_per_store: 0` | `no_delivery_address`, then as documented; page 2 had no repeats |
| get_store        | grocery by UUID and by URL id, restaurant with `query`, unknown id | identical listings for both id forms; `not_found`  |
| get_item         | grocery item, restaurant item with one group, item with nested child groups, wrong `section_id` | groups and children as on the site; `not_found` |
| cart tools       | signed out                                                  | `site_error` instead of `not_logged_in` (fixed since)  |
| all              | 15 malformed inputs                                         | rejected by the input-schema gate, no page action      |
| search, get_store| from a `/store/…` page and a `/search?…` page              | worked without navigating                              |
| add_to_cart      | grocery item twice, restaurant item without and with its option, foreign option, two picks | one merged line; `invalid_options` for each rejection |
| update_cart_item | 1 to 3 and back, unknown line, quantity 0 on both lines     | applied; `not_found`; both carts deleted               |
| get_cart         | before and after                                            | `carts: []` both times                                 |

Local contract and fixture tests:

```sh
node --test tests/ubereats-search-cart.test.mjs
```

They stub the page helpers and the site's endpoints (no DOM is needed because the tools
do not scrape) and cover the single-expression contract, registry agreement, portability
(no Node-only globals), input rejection before any page action for every tool, feed
parsing and paging, the missing-address and off-site entry paths, store listing and
in-store search, option group parsing, every add rejection, cart creation and extension,
the option payload format, merged-line detection, priced and unpriced cart reads,
quantity updates, removal, and cart deletion. They are not live evidence.

## URL patterns

The search and cart tools use the default `https://ubereats.com/*` and
`https://*.ubereats.com/*`. `login` uses the same pair plus `https://auth.uber.com/*`. Uber Eats signs in on Uber's shared auth service at
`auth.uber.com`, which is on the `uber.com` registrable domain. The email-code, password,
and SMS-code steps all render there, so the tool has to stay listed on that host for a
follow-up call with `otp` to find it. No other `uber.com` host is matched.

## Sessions

- Owner session: one long-lived stealth browser with the owner's profile (read-only),
  the credential vault, and the `us-mobile` proxy. Signed in on 2026-09-25 and kept
  alive for the search and cart work. Session ids are ephemeral and live in the run
  reports, not here.
- Independent QA sessions for the login tool: five stealth browsers without profile or
  vault, deleted after their runs.
- Source: this repository is canonical; sessions expire but files do not.
