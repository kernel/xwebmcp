# ubereats.com

Tools for Uber Eats (https://www.ubereats.com). Sign-in is handled by Uber's shared
auth service at `https://auth.uber.com/v2/`, so the login tool also matches that host.

| tool             | file                                         | status    | notes                                                                                   |
|------------------|----------------------------------------------|-----------|-----------------------------------------------------------------------------------------|
| login            | [login.js](login.js)                         | qa_passed | One submission per step; entry, email, chooser, password, and signed-in paths live-verified; SMS code step fixture-only |
| search           | [search.js](search.js)                       | qa_passed | Stores and matching items from the site's search feed, one page per call; needs a delivery address |
| get_store        | [get_store.js](get_store.js)                 | qa_passed | Store details, categories, menu items, or an in-store product search                    |
| get_item         | [get_item.js](get_item.js)                   | qa_passed | Price, availability, and nested option groups for one item                             |
| add_to_cart      | [add_to_cart.js](add_to_cart.js)             | qa_passed | Validates against the live menu, then creates or extends the store's cart; needs sign-in |
| get_cart         | [get_cart.js](get_cart.js)                   | qa_passed | Every cart with priced lines and the site's subtotal and total; needs sign-in           |
| update_cart_item | [update_cart_item.js](update_cart_item.js)   | qa_passed | Set a line's quantity, 0 removes; last removal deletes the store's cart; needs sign-in  |
| register         | [register.js](register.js)                   | draft     | Start a new-account sign-up from a signed-out session; returns the email-code challenge; no live sign-up yet |
| complete_registration | [complete_registration.js](complete_registration.js) | draft | Submit a code once, then phone, name, and required terms; verify the new account by hashed email; fixture-only after the email step |
| resume_registration | [resume_registration.js](resume_registration.js) | draft  | Report and continue a sign-up without ever submitting a code; fixture-only              |

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
`us-mobile`, deleted). This is the sign-off for the sign-in flow. The later signed-in
account check (commit `faae4c5`) was QA'd separately, see the next table.

| case                                                       | account     | result                                   | evidence                                              |
|------------------------------------------------------------|-------------|------------------------------------------|-------------------------------------------------------|
| Entry from home                                            | fabricated  | `enter_email_code`, 17.8 s, 1 submission | search engine → site → Log in → auth in telemetry     |
| Re-invocation with the code step open                      | fabricated  | `enter_email_code`, 0 submissions        | email marker unchanged                                |
| Entry from `/search?q=pizza` (second fabricated email)     | fabricated  | `enter_email_code`, 21.7 s, 1 submission | code step heading named the second address            |
| Two malformed inputs on the home page                      | fabricated  | rejected, no page action                 | all outputs valid under Ajv                           |

Independent QA of the signed-in account check at commit `05b8867` (agent
`agt_61207fb92423b24e591a`, the owner session, already signed in). Verdict: pass.

| case                                                       | account     | result                                   | evidence                                              |
|------------------------------------------------------------|-------------|------------------------------------------|-------------------------------------------------------|
| Signed in, requested email differs                         | fabricated  | failure `unknown`, 1.2 s, 0 submissions  | no input, click, key or unload events; still signed in |
| Signed in, requested email matches                         | owner       | success, 1.5 s, password unused          | hashed-email evidence; no page events; URL unchanged  |

When the account endpoint can't be read or has no email hash, the signed-in path still
reports success with the older header evidence (fail-open, same as before this check).
The two evidence strings tell a verified success from an unverified one.

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
   it can be ordered now (`available`: not sold out, store open, menu section being
   served), and the option groups. Call it whenever `has_options` is true: each
   group has `group_id`, `min`, `max`, and options with `option_id` and `price_minor`;
   an option can carry `child_groups` that open once it is chosen.
4. `add_to_cart({ store_id, item_id, section_id, subsection_id, quantity?, options?, special_instructions? })`
   re-reads the item, rejects sold-out items, items whose store is closed or whose
   menu section is not being served now, and any option set that misses a required
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

Register all ten tools as one array under namespace `ubereats.com`, because
`forceOverwriteNamespace: true` replaces every tool in the namespace:

```javascript
const fs = await import("node:fs");
const tools = ["login", "search", "get_store", "get_item", "add_to_cart", "get_cart", "update_cart_item",
  "register", "complete_registration", "resume_registration"]
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
- **Availability lives on the store, not the item.** The item endpoint has `isSoldOut`
  but no section or store availability, and the site's cart accepts an item from a
  restaurant menu that is not being served (in-store search lists such items with
  `available: false`). `get_item` and `add_to_cart` therefore also read the store:
  a store that is not open and orderable, or (for restaurants) a `section_id` that is
  in neither the store's `sections` nor its catalog, is `unavailable`. Grocery stores
  are exempt from the section check because their catalog is paged and their aisle
  sections are not all listed.
- **Section ids are not stable across reads.** Two back-to-back store reads of the same
  grocery store listed 7 of 73 items under a different `section_id` (same subsection),
  and an item read can echo a different `subsection_id` than it was called with. The
  item endpoint accepted both, so callers should treat the ids as the site's routing
  hints and always pass the trio they last received together.
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
  keyed form, a trailing space in `price_text`) were fixed in `c42641f`. A second pass
  (agent `agt_726228ec63fcc4d15c32`, commit `c42641f`) confirmed all five fixes and every
  contract case, and found that `add_to_cart` accepted an item from a restaurant menu
  section that was not being served; the store-level availability check above fixes
  that, with fixture coverage. A third pass (agent `agt_e6e4e3a2d543600b58b9`, commit
  `c4467fa`, the current tool source) confirmed the fix on both the read and the write
  side and found no defects, so all six are `qa_passed`.
- Not `verified`: every live success so far ran from a `ubereats.com` page, and the
  spec's `verified` status wants a live invocation started from a page of the domain
  other than the tool's entry point; the tools have no entry page as such, so the
  distinction is left for a later pass.
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

Independent QA of commit `c42641f` (agent `agt_726228ec63fcc4d15c32`, same setup: one
fresh `us-mobile` browser for the signed-out paths, deleted afterwards, and the owner
session for the cart paths). All 62 outputs valid under Ajv; cart empty before and after;
no navigation in any call. The five earlier findings were each confirmed fixed.

| tool             | case                                                        | result                                                 |
|------------------|-------------------------------------------------------------|--------------------------------------------------------|
| search           | no address; grocery, restaurant, page 2, zero items per store | as documented                                        |
| get_store        | grocery by both id forms, restaurant `query`, unknown id    | 73 items, none without `price_text`; `not_found`       |
| get_item         | grocery item, restaurant items with and without groups, wrong section | as documented; `not_found`                   |
| cart tools       | signed out                                                  | `not_logged_in`, no cart call                          |
| all              | 13 malformed inputs                                         | rejected by the input-schema gate                      |
| search, get_store| from `/store/…` and `/search?…` pages                      | no navigation                                          |
| add_to_cart      | grocery item twice; restaurant item without, with, and with a foreign option | merged line; one problem per rejection |
| add_to_cart      | item listed with `available: false` (menu not being served) | accepted (defect, fixed in the current source)         |
| update_cart_item | 1 to 3, back to 1, unknown line, quantity 0 on each line    | applied; `not_found`; all carts deleted                |
| get_cart         | before and after                                            | `carts: []` both times                                 |

Independent QA of commit `c4467fa` (agent `agt_e6e4e3a2d543600b58b9`, same setup; this
is the sign-off for the current source). All 25 outputs valid under Ajv; cart empty
before and after; one URL throughout the owner session; no `/checkout`.

| tool             | case                                                        | result                                                 |
|------------------|-------------------------------------------------------------|--------------------------------------------------------|
| get_item         | restaurant item through an unserved menu section, then through the served one | `available: false` naming the section, then `available: true` |
| get_item         | grocery item                                                | `available: true`, `currency` set                      |
| add_to_cart      | the unserved-section item with its option                   | `unavailable`, no cart created                         |
| add_to_cart      | the same item through the served section, then removed      | one cart, quantity 1; `cart_deleted: true`             |
| search           | no address; grocery; restaurant page 2; from a `/store/…` page | as documented, no navigation                        |
| get_store        | grocery by both id forms, restaurant `query`                | listings agree; `available: false` passed through      |
| cart tools       | signed out                                                  | `not_logged_in`                                        |
| all              | 7 malformed inputs                                          | rejected by the input-schema gate                      |
| add_to_cart      | grocery item twice                                          | one line, quantity 2                                   |
| update_cart_item | 2 to 3, unknown line, quantity 0                            | applied; `not_found`; `cart_deleted: true`             |
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

## Registration

Three tools create a new Uber Eats account for a test identity. They never touch an
existing account: they refuse a signed-in session, stop on any sign of an account that
already exists, and never enter a password, payment method, promo code, or address.

### Flow

Uber runs sign-up and sign-in as one flow on `auth.uber.com/v2`: the Sign up and Log in
links go to the same URL, and the first screen asks for a phone number or email either
way. What follows depends on whether the address already has an account.

1. `register({ email })` opens `https://www.ubereats.com/` if needed, confirms the session
   is signed out (Uber's user endpoint then answers HTTP 200 with a failure body carrying
   code 403, `rtapi.forbidden`), follows the header Sign up link,
   and submits the email once. It returns `status: "challenge"` with `channel: "email"` and
   a masked `destination_hint` when Uber emails a code. If Uber instead offers sign-in
   methods, a password step, or a text-message code, the address already has an account
   and it returns `existing_account` without going further.
2. `complete_registration({ email, code, phone, first_name, last_name, accept_terms: true })`
   submits that code once. For a new address Uber then asks for a phone number; the tool
   fills it (the E.164 number must start with the country code Uber preselects, `+1` for a
   US session; changing the country is not supported), submits once, and returns the next
   challenge with `channel: "sms"`.
3. `complete_registration` again with the text-message code submits it, then fills the
   name and terms screens. Uber can show them separately or combined. `accept_terms: true`
   checks only the required `LEGAL_ACCEPT_TERMS` box; any other box on that screen (for
   example marketing) is left unchecked. On landing back on ubereats.com signed in, it
   compares a SHA-256 of the requested email with the site's hashed account email and
   returns `status: "registered", account_verified: true` only on a match.
4. `resume_registration({ email, ...profile })` reports the current state at any point and
   continues phone, name, and terms screens when their fields are given. It never submits
   a code and never navigates.

Any field a screen asks for that was not given yields `status: "needs_input"` with `needs`
(and the site's `terms_text` when it is the terms), and the caller continues with
`resume_registration`. Every result lists `steps_submitted` for that call.

### Stops without changes

- `signed_in`: the tab is signed in to any Uber account (`register` only reads the account
  endpoint to find out).
- `existing_account`: Uber offered sign-in methods or a password for the email; Uber asked
  for a text-message code before any phone was entered; or the email code signed the tab
  in to an account without showing any sign-up screen. That last case is inherent to
  Uber's single flow: an existing passwordless account also receives an email code, and it
  is only after the code that the difference shows. The tab is then signed in to that
  account, but nothing on it is changed.
- `phone_conflict`: after the phone number Uber says it is in use, or offers to sign in to
  the account that owns it. The tool does not follow Uber's offer to move the number.
- `phone_rejected`, `email_rejected`: any other refusal of the number or address, with the
  site's message (phone numbers and addresses in it are replaced by `[number]`/`[email]`).
- `code_rejected`, `code_expired`: the code was wrong or old. It is not retried, and the
  same code is refused if passed again (`duplicate_submission`).
- `unsupported_step`: any screen the tools do not handle. Uber's sign-up client also has
  `UBER_MARKETING_CONSENT`, `AGE_VERIFICATION`, `ADD_PASSWORD`, `ADD_PAYMENT`, `ADD_PROMO`,
  voice or WhatsApp codes, and a Korean "consent to all" terms button; none of them is
  answered.
- `wrong_account`: the final signed-in account's hashed email differs, or a code screen
  names another address. A signed-in page without a readable hashed email is `unknown`,
  never success.
- `captcha_or_challenge`, `locked_or_throttled`, `other_registration_in_progress`,
  `no_registration_in_progress` as named.

### Why these are CDP tools

The repository default is `kind: "page"`; `cdp` is reserved for tools that trigger a
navigation themselves and need a structured result read after it. All three qualify:
`register` goes from any site page to ubereats.com and then, through the Sign up link, to
a different origin (`auth.uber.com`), and its result is the challenge read there.
`complete_registration` and `resume_registration` submit the screen (a code or the terms)
after which Uber redirects the tab from `auth.uber.com` back to ubereats.com, and their
result is the account verification done on that new document. A page tool would be torn
down by those navigations before it could return. Screens that stay on the same document
(phone to SMS code, name to terms) would suit a page tool, but the same call continues
into the redirect, so splitting them would only move the navigation to another tool.

### Duplicate and stale invocations

The tools keep a marker per tab in `sessionStorage` on `auth.uber.com`
(`webmcp.ubereats.register`) holding a SHA-256 of the email, timestamps, SHA-256s of the
codes already submitted, and the last two digits of the phone for the SMS hint. It holds
no email, phone number, or code in clear. With it:

- `register` for the same email while its sign-up is open returns the current state
  without submitting, and refuses to request a second email code within 15 minutes.
- `complete_registration` refuses a code it already submitted and any second code within
  15 seconds of the last.
- a phone, name, or terms screen is not submitted twice within a minute.
- `complete_registration` and `resume_registration` on any page without a recorded
  sign-up, or after Uber returned to its first screen, report
  `no_registration_in_progress` and do nothing.

When a sign-up finishes on ubereats.com the tools also leave
`webmcp.ubereats.register.done` in that origin's `sessionStorage` (email hash and whether
sign-up screens were seen), which is how `resume_registration` on the site tells a new
account from a sign-in to an existing one.

### Evidence for the screens

Nothing past the email step has been seen live, because no registration may be submitted
until a supervised test slot. The screens after the email code come from Uber's own
sign-up client, read on 2026-09-26 from the scripts `auth.uber.com/v2` loads: its screen
types (`EMAIL_OTP_CODE`, `PHONE_NUMBER`, `PHONE_NUMBER_PROGRESSIVE`, `PHONE_OTP`,
`FULL_NAME`, `LEGAL`, `NAME_LEGAL`, `NAME_PHONE_LEGAL`, plus the unsupported ones above),
its field ids (`PHONE_NUMBER` with a country picker, `FIRST_NAME`, `LAST_NAME`), and its
terms checkbox id (`LEGAL_ACCEPT_TERMS`, text `accept-terms-text`). The email code and SMS
code screens, the per-box ids `EMAIL_OTP_CODE-n` and `PHONE_SMS_OTP-n`, pasting a whole code
into the first box, and the sign-in chooser's `alt-action-help-v2` control were seen live
during the login work; none of those appear in the static client, so they could change
without a script change. Which screens a new account
actually gets, and in what order, is unconfirmed.

### ClawBench and repeated use

The shared test mailbox and its forwarded phone number can hold one Uber account. After
one successful registration, later runs must sign in to it with `login` (email code to
the same inbox) instead of registering again, and they inherit that account's carts and
saved address; Uber will also refuse the same phone number for a second account
(`phone_conflict`). Registration only lets a browser agent reach a signed-in state on a
test identity; it does not complete any scored task by itself, and the food-order task
checks in ClawBench V1 use a placeholder that no run matches.

### Status and known limitations

- All three are `draft`: no live registration has been submitted. Live-checked on
  2026-09-26 without submitting anything: `register` refuses a signed-in session
  (`signed_in`); from a store page in a signed-out profile-less browser it confirmed the
  signed-out state, followed Sign up, recognized the email screen, and stopped at its
  duplicate guard with the field empty; `resume_registration` reports `wrong_account` on
  a session signed in to another account and `no_registration_in_progress` on Uber's first
  screen; `complete_registration` reports `no_registration_in_progress` with no recorded
  sign-up. The tools are listed on `auth.uber.com` and ubereats.com pages only.
- Independent QA (agent `agt_5e8da1c9d9c6dfff2c05`, commit `ab75f6c`) reviewed the sources
  statically, confirmed the screen types and ids above in Uber's client, and repeated the
  live no-submission checks with every sign-up POST blocked (none fired): all refusals as
  documented, the duplicate guard stopping `register` with the field empty, and eight
  malformed inputs rejected by the schema gate. It found no blockers; its three minor
  findings (a fixture that could not see stray checkbox clicks, the signed-out response
  described as HTTP 403, and page text in `destination_hint` and `terms_text` not
  scrubbed) were fixed in `05e5cf1`. A final pass (agent `agt_8f7178bcd04460ebdbd3`, commit
  `05e5cf1`, the current tool source) confirmed the three fixes, repeated the static
  review and the no-submission live checks with every sign-up POST blocked (none fired),
  and signed the source off to stay `draft` pending a supervised live test. Its remaining
  notes (a fixture for the scrub, the two screens and the possible double code POST
  below) are covered by later documentation and test commits that leave the tool files
  unchanged.
- Everything after the email submission is fixture-only: the phone, SMS, name, and terms
  handling, the conflict and rejection messages (their wording is a guess from Uber's
  error names), and account verification after sign-up.
- The phone country picker's selected code is read from text next to the field; if Uber
  renders it differently the phone step stops with `unsupported_step` before typing.
- Uber may refuse VoIP numbers; that shows as `phone_rejected` and is not worked around.
- A marketing-consent or age screen stops the flow; answering them is left to a person.
- Uber's client also has `NAME_EMAIL_LEGAL` (name, email, and terms on one screen) and
  `PHONE_MISMATCH` screens. On the first the tools fill the name and terms but not the
  email field, so Uber's own error ends the call in `unknown`, never a false success; the
  second is reported as `unsupported_step`.
- After pasting a code the tools click Next only if the code screen is still showing
  1.5 s later, the same pattern `login` uses live. If Uber's own auto-submit were still in
  flight at that moment it would send the code twice in one call; watch for a second
  `submit-form` request during the supervised run.
- Best lead for the next person: during the supervised live slot, record the heading and
  input ids of each screen after the email code and compare them with the fixtures in
  `tests/ubereats-register.test.mjs` before trusting a second run.

Local fixture tests:

```sh
node --test tests/ubereats-register.test.mjs
```

They simulate each Uber screen by its element ids and cover input rejection before any
page action, entry from unrelated pages, the signed-in refusal, every existing-account
signal, the email and SMS challenges, phone, name, terms, and combined screens,
`needs_input`, the preselected country code check, phone conflicts and rejections, wrong
and expired codes and their non-retry, duplicate and stale invocations, wrong-account and
unverifiable results, scrubbing of numbers and addresses from site messages, and that no
output contains a code or phone number. They are not live evidence.

## URL patterns

The search and cart tools use the default `https://ubereats.com/*` and
`https://*.ubereats.com/*`. `login`, `register`, `complete_registration`, and
`resume_registration` use the same pair plus `https://auth.uber.com/*`. Uber Eats signs in on Uber's shared auth service at
`auth.uber.com`, which is on the `uber.com` registrable domain. The email-code, password,
and SMS-code steps all render there, and so do the sign-up phone, name, and terms
screens, so these tools have to stay listed on that host for a follow-up call with a
code to find them. No other `uber.com` host is matched.

## Sessions

- Owner session: one long-lived stealth browser with the owner's profile (read-only),
  the credential vault, and the `us-mobile` proxy. Signed in on 2026-09-25 and kept
  alive for the search and cart work. Session ids are ephemeral and live in the run
  reports, not here.
- Independent QA sessions for the login tool: five stealth browsers without profile or
  vault, deleted after their runs.
- Source: this repository is canonical; sessions expire but files do not.
