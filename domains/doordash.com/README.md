# doordash.com

Tools for DoorDash (https://www.doordash.com).

| tool | file | status | notes |
|------|------|--------|-------|
| login | [login.js](login.js) | qa_passed | Email + password sign-in with a two-step guided flow; existing sessions verified against the profile page; `otp` mode for the 2-Step Verification modal |
| get_store | [get_store.js](get_store.js) | qa_passed | Page tool: store hours, service modes, delivery and pickup availability with estimates and fee strings, and menu ids, with the delivery basis (selected address, none selected, unknown) stated explicitly and delivery figures returned only for a selected address; never changes the address |

## Native WebMCP tools

Checked on 2026-09-25 in a stealth browser with a signed-in profile. DoorDash ships its own
tools through a `[WebMCP Polyfill]` that it installs on `navigator.modelContext`
(`registerTool`, `unregisterTool`, `callTool`, `listTools`, plus a `_registeredTools` map).
On that date the polyfill was page JavaScript that `webmcp.listTools()` in the Kernel REPL did not
list, so the tools had to be read with `await navigator.modelContext.listTools()` from page context.
**That has changed (rechecked 2026-09-29, see below).** The polyfill can take a few seconds to load
after `load`. The custom tool names in this namespace do not collide with any native name.

Rechecked 2026-09-29 on the Kernel runtime, signed out, on `/store/29417/`: `kernel browsers webmcp
list` and the REPL's `webmcp.listTools()` list the page's native tools (`add_to_cart`,
`get_item_details`, `get_page_context`, `get_restaurant_menu`, `navigate_to_page`) from about 3 to
5 seconds after the page loads (none at 3 s in the first poll, five at 5 s), and `document.modelContext`
exposes `registerTool`, `getTools` and `executeTool`. Rechecked the same day through
`navigator.modelContext.listTools()`, the lists per page type in the table were unchanged. The earlier "not visible" reading was either a timing artifact or a runtime difference; it
is not the case now.

| page | URL checked | native tools |
|------|-------------|--------------|
| home | `/home` | `search_restaurants`, `search_global_products`, `navigate_to_page`, `get_page_context` |
| search results | `/search/store/pizza/` | `search_restaurants`, `search_global_products`, `navigate_to_page`, `get_page_context` |
| profile | `/consumer/edit_profile/` | `navigate_to_page`, `get_page_context` |
| cart | `/en-US/cart` | `navigate_to_page`, `get_page_context` |
| convenience store | `/convenience/store/walgreens-702588` | `get_convenience_store`, `search_retail_products`, `get_item_details`, `add_to_cart`, `navigate_to_page`, `get_page_context` |
| restaurant store | `/store/{storeId}` | advertised by `navigate_to_page` as `get_restaurant_menu`, `get_item_details`, `add_to_cart` (not visited) |
| sign-in | `identity.doordash.com/auth` | none; `navigator.modelContext` is undefined on the identity host |

Schemas as read from the polyfill (inputs only; the polyfill exposes no output schemas):

- `search_restaurants({ query, lat?, lng?, maxResults?, filters?: { cuisine?, priceRange?, minRating?, maxDeliveryTime? } })`
  returns restaurant names, ratings, delivery times, and URLs.
- `search_global_products({ query, maxResults? })` returns product results across nearby stores
  with item IDs, prices, store info, and the `menuId` needed by `add_to_cart`.
- `navigate_to_page({ url })` accepts site-relative paths only (`/search/store/{query}`,
  `/store/{storeId}`, `/convenience/store/{slug}`, `/consumer/checkout/?order_cart_id={cartId}`)
  and rejects absolute or external URLs.
- `get_page_context({})` returns the page type, the tools available there, and suggested next steps.
- `get_convenience_store({ storeId })`, `search_retail_products({ storeId, query, limit? })`,
  `get_item_details({ storeId, itemId })`.
- `add_to_cart({ storeId, menuId, itemId, itemName, quantity, unitPrice, specialInstructions?, cartId?, options?, purchaseTypeOptions? })`
  with nested option selections; `unitPrice` is in cents.

None of the native tools sign in, so `login` is custom. Search, item options and adding to the cart
are covered natively. The native tools give no store details (hours, address, availability, fees,
estimates) and no cart read or edit, address, or order tools; `get_store` below covers the first
gap only.

## Entry path and flow

1. If the browser already holds the `dd_cx_logged_in=true` cookie or a header Account control, the
   tool opens `/consumer/edit_profile/` and compares the email input there with the requested
   email. A match returns success without any submission; a different account is an explicit
   `unknown` failure. A stale cookie that redirects to sign-in continues with the normal flow.
2. Otherwise the tool opens `https://start.duckduckgo.com/`, searches `doordash login` through the
   accessibility-tree combobox, and clicks the first organic result. On 2026-09-25 that was
   `https://www.doordash.com/consumer/login`, which redirects to
   `https://identity.doordash.com/auth?...` with `document.referrer === "https://duckduckgo.com/"`.
   A first organic result on any other host is a `search_entry` failure; a DoorDash page without
   a sign-in form is entered through the site's own Sign In control.
3. The identity page is a guided flow: `form[data-testid="login-form-guided-email"]` with only the
   email field visible and a `#guided-submit-button` ("Continue to Sign In"). The password input
   exists in the DOM but sits in an `opacity: 0` panel; `checkVisibility({ checkOpacity: true })`
   is required to tell the steps apart.
4. For an unknown email the site renders a banner with no `role=alert`: "Incorrect email We couldn't
   find an account with the email you entered. Try a different email or sign up." The tool reports it
   as `invalid_credentials` at `email_step` without ever submitting a password.
5. For a known account the next step is `form#guided-email-phone-form` ("Login with phone number",
   "Enter the phone ending in ...") with a **Use password instead** button. The tool clicks it and
   waits for `form#login-form`, whose hint reads "Enter your password to finish logging into your
   account with <email> (Switch)". That email is compared with the requested one before the
   password is filled and `#login-submit-button` is clicked once.
6. After the password DoorDash showed a `[role=dialog][aria-modal=true]` "2-Step Verification"
   modal: "We sent a code to +1 ******NNNN", one `input[type=number][autocomplete=one-time-code][maxlength=6]`,
   and Resend Code / Send to Email / Get Help / Cancel / Submit (disabled until six digits). The tool
   returns `logged_in: true, authenticated: false, mfa_required: true, next_step: "submit_otp"`.
   The password form stays visible underneath the modal, so the code step is detected from the
   code input alone.
7. `otp` mode sets the code with the native value setter plus `input`/`change` events, then clicks
   the Submit button **inside the dialog** (the underlying form's Sign In button is still visible
   and must not be clicked). Success is the redirect to `www.doordash.com/?...code=...&action=Login`
   followed, several seconds later, by `/home` with `dd_cx_logged_in=true` and a header Account
   control. The tool waits for the header control (Account or Sign Out outside the footer) and
   reports the cookie as supporting evidence only; the footer's Account Details link exists on
   signed-out pages too and is ignored.

Endpoints observed: `POST https://identity.doordash.com/v2/auth/guided/email` for the email step
(HTTP 200 even for an unknown email; the outcome is in the body and the DOM). The page loads an
invisible reCAPTCHA Enterprise anchor (`www.google.com/recaptcha/enterprise/anchor`); no visible
challenge appeared in any run.

## Loading

```javascript
const fs = await import("node:fs");
const tools = ["login", "get_store"].map(name => eval(fs.readFileSync(`domains/doordash.com/${name}.js`, "utf8"))[0]);
await webmcp.addCustomTools({ namespace: "doordash.com", tools, forceOverwriteNamespace: true });
const tool = (await webmcp.listTools()).find(t => t.source.custom?.namespace === "doordash.com" && t.tool.name === "login");
const result = await webmcp.invokeTool(tool.tool_ref, { email: "qa@example.invalid", password: "fabricated" }, { timeoutSec: 120 });
// Second step, once the code arrives:
// await webmcp.invokeTool(tool.tool_ref, { email: "qa@example.invalid", otp: "123456" }, { timeoutSec: 120 });
```

`forceOverwriteNamespace: true` replaces every tool in `doordash.com`, so register `login` and `get_store`
together as one array. Take a fresh `tool_ref` after navigation. Use `timeoutSec: 120`
(the WebMCP maximum); the post-submit observation window is 45 seconds and a full search-entry run
took about 15 seconds. The runtime only lists a CDP tool on pages matching its `url_patterns`, so
`login` is invocable from any `doordash.com` page (including `help.` and `identity.`) but not from
`about:blank` or another site; the tool itself makes no assumptions about which DoorDash page it starts on.

## Input and output

Input: `email` (required) plus exactly one of `password` or a six-digit `otp`. Anything else is
rejected by the input schema or returned as `invalid_input` before any page action.

Success (`logged_in: true`): `authenticated`, `mfa_required`, `next_step` (`none` |
`submit_otp`), `landing_url`, masked `account_hint`, `evidence`, `submission_attempted`. An MFA
modal after the password is first-step success only; never treat it as authenticated.

Failure (`logged_in: false`): `error_kind` (`invalid_input` | `invalid_credentials` |
`captcha_or_challenge` | `mfa_failed` | `locked_or_throttled` | `unknown`), the site's own
`error_message`, `attempts_remaining` (null unless the site shows a count), `submission_attempted`,
and `step` (`input`, `session_check`, `search_entry`, `site_entry`, `email_step`, `password_option`,
`password_step`, `otp_step`).

## Site quirks

- Dynamic element ids (`fieldWrapper-:r3:`); select by form id/test id and input type instead.
- The email-step error banner and the 2-Step modal text have no ARIA roles; the reader scans
  visible text blocks on the identity host only and excludes `footer`/`nav`/`header`.
- The identity page redirects back to `www.doordash.com/?state=none&code=...` and the site exchanges
  the code client-side; the signed-in cookie appears a few seconds after the redirect.
- The signed-in home page shows marketing dialogs (for example a DashPass fee notice with a
  "Got it" button). They do not affect login but will need dismissing for search or cart tools.
- A password submission is guarded per tab in `sessionStorage` (`doordash.com.login.submitted.v1`,
  ten minutes). A fresh site rejection clears it; an uncertain outcome keeps it so a re-invocation
  cannot submit again. Inspect the browser instead of retrying.
- `attempts_remaining` parsing and the `locked_or_throttled`/`captcha_or_challenge` wording are
  synthetic; DoorDash never showed those states in testing.
- Success after a submission requires a signed-in header control (Account or Sign Out, outside the
  footer) on a non-identity DoorDash page. The `dd_cx_logged_in` cookie alone is not proof: it can
  be stale from an earlier session, so it is only reported as supporting evidence.
- A `MutationObserver` armed before each submission records feedback-like text that DoorDash adds
  to the page; a displayed error counts as fresh only when it was cleared, changed, or matches text
  the observer saw added after the click, so an old "incorrect" message that is repainted after the
  new attempt is attributed to that attempt while unrelated additions are not. Button and link
  text is stripped from `error_message`.
- The tool tracks a 112-second budget and honours the runtime's abort signal in every wait loop and
  before each click. It refuses to submit the password or a code when fewer than 48 seconds remain,
  so a caller timeout cannot leave a submission running unobserved; invoke again from the current
  page in that case. Timeout messages say whether the site or the budget ended the wait.

## Live configuration matrix

| browser | proxy | profile | start page | real submissions | result |
|---|---|---|---|---|---|
| long-lived (`wjdkr9p7ugcc9ui4ssf7e4mm`) | cincy residential | personal-stuff | `/home` | 0 | existing session confirmed on the profile page, `authenticated: true`, 5.5 s |
| exploration (deleted) | cincy residential | none | password step already open | 1 password + 1 emailed code | 2-Step modal, then `otp` mode authenticated (cookie + header Account) |
| exploration (deleted), after sign-in | cincy residential | none | `/home` | 0 | existing session confirmed; a different requested email refused with `unknown` and no submission |
| mobile (deleted) | us-mobile | none | `/about/` | 1 password | packaged search entry end to end, `mfa_required: true`, 14.7 s |

No CAPTCHA solver events and no visible challenge occurred in any run.

## Independent QA

Round 1, 2026-09-25, agent `agt_e173a64b720e2cb2dd59` against commit `394bda9` in its own
profile-less stealth browser (deleted afterwards). Two fabricated email-step submissions, no
password submissions. Passed: nine invalid inputs rejected by the WebMCP schema gate with no
navigation; the search entry from `about.doordash.com` (DoorDash redirects `/about/` there) reached
`identity.doordash.com` with a DuckDuckGo referrer and returned the site's "Incorrect email" text as
`invalid_credentials` at `email_step` in 12.2 s; a repeat on the referred sign-in page skipped the
search; `otp` mode without a code step returned `unknown` at `otp_step` with no navigation; every
output conformed to `outputSchema`.

Findings and what changed:

| finding | severity | resolution |
|---|---|---|
| Tool is not listed on pages outside doordash.com | major | By design: `url_patterns` follow the repository convention, and the runtime only lists CDP tools on matching pages. Documented above and in the tool description; the unit tests still exercise the entry logic from unrelated URLs because `execute` itself makes no page assumptions. |
| Stale `dd_cx_logged_in` cookie plus a momentarily form-less identity page produced `authenticated: true` | major | Fixed: success now requires a signed-in header control on a non-identity page; the cookie is evidence only. Regression tests added. |
| Code inputs on `www.doordash.com` were invisible to the reader | related | Fixed: code inputs are detected on every DoorDash host, and a code step there is reported as `mfa_required`. |
| `error_message` included the banner's "Create an account" button text | minor | Fixed: button and link text is removed from the message. |
| An identical error repainted after submission returned `unknown` | minor | Fixed with the feedback `MutationObserver`; regression test added. |
| Worst-case waits (about 190 s) exceeded the 120 s invocation timeout | minor | Fixed: shorter step waits plus the 115 s budget and abort-signal handling; the password is only submitted when the 45 s observation fits. |
| Code detector could match a "country code" field | risk | Fixed: the attribute match now requires verification/security/one-time/SMS/2FA code wording or `otp`, excludes "country", and prefers `autocomplete="one-time-code"`. |
| `otp` mode could double-submit if the modal auto-submitted on paste | risk | The live modal does not auto-submit (Submit stays disabled until six digits and had to be clicked); the tool only clicks an enabled Submit inside the dialog. |

Round 2, 2026-09-25, agent `agt_b9c6f31f6f2efbffcbe9` against commit `cb75cd4` in a fresh
profile-less stealth browser (deleted afterwards). Two fabricated email-step submissions, no
password submissions. Confirmed fixes 2 to 6 (harness and live: the search entry from the about
page took 12.3 s and returned the site's "Incorrect email" text without the button suffix; the
repeat on the referred sign-in page skipped the search in 1.9 s; six invalid inputs were rejected
by the schema gate with no navigation; `otp` mode without a code step returned `unknown` with no
navigation; all outputs conformed). New minor findings, all addressed in the next commit:

| finding | resolution |
|---|---|
| `otp` mode and the email step ignored an already-aborted signal | Both now stop before pasting a code or clicking Continue; regression tests added. |
| Timeout messages blamed the site when the budget ended the wait | Messages now say whether the site or the budget/cancellation ended the wait. |
| The feedback observer flagged any added text with an error keyword and never reset | The observer now records the added texts, and a displayed error is fresh only when it matches one of them. |
| The `otp` submit finder accepted fewer code fields than the detector | Both use the same predicate. |
| One-character inputs skipped the "country" exclusion; non-loop calls are not counted against the budget | The exclusion applies to every branch; the budget was lowered to 112 s to keep slack under the 120 s invocation limit. |

Round 3, 2026-09-25, agent `agt_5b1753eb7444ed26b1d6` against commit `67d367b` (`login.js` sha256
`2c769a701733b421c2dea59716d194533bf355b0c68123889ba1542487c78980`) in a fresh profile-less stealth
browser (deleted afterwards). One fabricated email-step submission, no password submissions.
Sign-off: **passes independent QA**. Confirmed all four round-2 fixes (the abort checks in the
harness; the feedback observer live on the sign-in page, where an unrelated hidden addition did not
mark a stale error fresh but a repaint of it did; the shared code predicate by inspection). Live:
three invalid inputs rejected by the schema gate with no navigation; the search entry from the about
page returned `invalid_credentials` at `email_step` in 13.1 s with the observer removed and no guard
set afterwards; `otp` mode without a code step returned `unknown` in 0.8 s with no navigation; all
outputs conformed. Static review found no double submit, no MFA-as-authenticated path, no throw
escaping `execute`, and no bypass of the budget check.

Round 3 left four minor findings, all of which fail closed with nothing submitted. They are
deliberately not fixed in the QA-passed source and are listed under known limitations.

## Status and known limitations

Status: `qa_passed` on the tool source at sha256 `2c769a70…` (commit `67d367b`); later commits on
the branch touch only this README and the registry.

- **Live-verified (2026-09-25):** existing-session success without submission in the profile-backed
  browser (5.5 s, account matched on the profile page); one real email + password submission in a
  profile-less stealth browser with the residential proxy reached the SMS 2-Step Verification modal;
  the emailed code submitted through `otp` mode completed authentication (redirect, then
  `dd_cx_logged_in=true` and the header Account control). The DuckDuckGo entry, unknown-email
  rejection, "Use password instead" switch, and password form were all driven live with the same
  selectors the tool uses.
- **Fixed after the live run:** the first password submission returned `unknown` because the
  code-step detector required the password field to be gone, and the modal keeps it visible; the
  first `otp` run reported success from the footer Account Details link before the cookie existed.
  Both fixes have unit coverage; the code-step detection has not had a second live password
  submission.
- **Live-verified, mobile proxy (2026-09-25, same day, fixed source):** one invocation from
  `/about/` in a profile-less stealth browser with the `us-mobile` proxy ran the packaged path end to
  end (search entry, identity page with a DuckDuckGo referrer, email step, "Use password instead",
  one password submission) and returned `mfa_required: true` with the 2-Step Verification modal in
  14.7 seconds. Its code was not submitted; the browser was deleted.
- **Unverified:** wrong-password wording; lockout, CAPTCHA, and expired-code responses; the
  password path in the profile-backed browser (it was already signed in, so no submission was made
  there). The QA round 1 fixes (header-control success signal, feedback observer, budget) have unit
  coverage and the existing-session live check only; no further real password submission was made
  after them.
- **Known minor issues (round 3, unfixed):** the profile, result-landing, Sign In control, and
  password-option waits still say the site did not respond when the budget or an abort ended the
  wait; the feedback match uses substring containment, so a hidden addition that is a substring of a
  stale error (for example "couldn't") would mark it fresh after a submission; the `otp` paste
  filter applies the "country" exclusion only to its wording branch; an already-aborted signal
  still performs the DuckDuckGo navigation before stopping, and the `otp` abort message cites the
  budget rather than the cancellation. None of these can submit anything or report a false success.
- **Best lead for the next person:** DoorDash sends the 2-Step code to the phone by default. The
  modal's "Send to Email" button switches delivery to the account email, which can be read from the
  mailbox; the tool does not click it, so a caller that cannot receive SMS should click it in the
  browser before invoking `otp` mode.

## get_store

`get_store({ store_id })` reads one DoorDash store (`store_id`: digits without a leading zero) and reports the things the native tools do not:
open status and hours, the services the store offers, whether delivery and pickup can be ordered
**right now**, an estimate range only when the site marks the mode available, the site's own
delivery-fee strings, and the store's menus, together with the delivery basis those figures rest on. It never returns menu items
(use the native `get_restaurant_menu` on the store page), reviews, or a fee quote. `store_id` is the
digits from `search_restaurants` or from a `doordash.com/store/<name>-<id>/` URL. The result also
carries `menu.menu_id`, the `menuId` the native `add_to_cart` requires.

Name: `get_store` follows `ubereats.com/get_store`, and a DoorDash store can be a restaurant or a
convenience store, so the restaurant-only names were not used. Convenience and grocery stores return
their header details with `store_type: "convenience"` and `menu: null`; their catalog is a different
surface (native `get_convenience_store`, `search_retail_products`).

### Delivery context

DoorDash computes delivery availability and estimate for the delivery address selected in the
session, not for the store alone. With no address selected it does **not** use the egress IP: on
2026-09-29 two guest browsers, one whose `getGeoByIP` answered with a point in the middle of the
United States and one behind a New York residential proxy whose `getGeoByIP` answered with the Bronx,
got the identical distance to the same New York store (5385 mi) and "Too far away" for it, and an
independent review saw the same identical values from two other egress locations. Those figures
describe a placeholder location, not the customer, and read "Too far away" for every store. The output
therefore carries `delivery_context.basis` and returns the delivery figures **only** when an address is
positively recognised:

- `selected_address`: the header address control (`data-testid="addressTextButton"`) shows text that
  is not a known placeholder and contains a digit (a street number or ZIP). Delivery `available`,
  `unavailable_reason`, `unavailable_message`, `estimate_minutes` and `too_far_from_consumer` are
  DoorDash's answer for that address.
- `no_address_selected`: the header shows a known placeholder ("Your Address", "Tu dirección") or, when
  the page has no header control, the signed-out landing page's address form
  (`data-testid="LandingPageAddressSearch"`) is present.
- `unknown`: anything else, such as a header text in a locale whose placeholder is not recognised and
  that has no digit, or a page with neither signal.

For `no_address_selected` and `unknown` the five delivery fields above are `null` (withheld): reporting
`available: false` would say a store does not deliver when nothing is known. Store details, hours,
pickup and the fee strings are still returned. The placeholder text is localised, so it is matched
narrowly and everything unrecognised falls to `unknown` rather than to `selected_address`.

Other fields:

- `delivery_context.address_selected` is the boolean behind `basis` (`true`, `false`, `null`). The tool
  never returns the address text and never opens, changes or selects an address.
- No distance is returned. DoorDash's distance from the customer, together with the store coordinates
  in `address`, could be combined across stores to estimate where the customer is.
- `delivery_context.signed_in` is from the `dd_cx_logged_in=true` cookie, a hint only (the cookie can be
  stale); fees and promotions can differ by account (first-order and DashPass messages).
- `delivery.estimate_minutes` and `pickup.estimate_minutes` are `null` unless that mode is available,
  because the site sends a range even for a mode it reports unavailable.
- `delivery.fee_display` returns the site's `title`, `subtitle` and `text` unparsed; the strings differ
  by store type ("$0 delivery fee over $12" on a restaurant, "$0.00" plus "delivery fee on $12+" on a
  convenience store) and are not a quote. They are returned in every basis.
- `rating.average` is `null` for a store with no ratings (the site sends 0).

### Why a page tool

The tool makes one same-origin `fetch` from the registering document and returns; it does not
navigate, so it is `kind: "page"` per the authoring skill and `spec/cdp-tools.md` §2.1. It is invocable
from any `www.doordash.com` page (verified from a search page, the home page, a store page, a DashPass
page and a grocery tab) without leaving it. Registered by the Kernel API, a page tool's input is **not**
checked against `inputSchema` (observed 2026-09-29: malformed input reached `execute`), so `execute`
validates `store_id` itself and returns `invalid_input` before any request.

### Mechanism (observed 2026-09-29)

The store page calls `POST /graphql/storepageFeed?operation=storepageFeed` from its own JavaScript, with
headers `x-csrftoken` (the `csrf_token` cookie when signed in, an empty string signed out),
`x-channel-id: marketplace` and `x-experience-id: doordash`, and a 22 KB query. The tool sends a
trimmed query for the same operation that selects only the fields listed in the output. The trimmed
query was checked live from `/home` and from other store, search, DashPass and grocery pages,
returning HTTP 200 and about 3.4 KB per store, in about 0.6 to 0.9 s. Unknown ids return HTTP 200 with a
GraphQL `NOT_FOUND` error and a null feed; id 1 returns a header with an empty name, which the tool also
reports as `not_found`. `store_id` must not start with a zero: DoorDash normalises `029417` to `29417`, and id `0`
returns an internal-looking record, so both are rejected as `invalid_input`. The server-rendered store HTML carries the same
header, but inside a Next.js payload in which a leading `$` in a string is escaped as `$$` (for example
`"$$0 delivery fee"`); it was compared field by field with the GraphQL response and rejected as the
source because of that encoding and its 2.5 to 3 MB size.

### Errors

Every failure is `{ status: "error", error_kind, error_message }`: `invalid_input`, `wrong_page`
(not on `www.doordash.com`; nothing was requested), `not_found`, `login_required` (HTTP 401 or an
unauthenticated GraphQL error), `challenge` (a non-JSON bot-check page), `rate_limited` (HTTP 429),
`site_changed` (the query was rejected as invalid, the header is missing, or another store came back)
and `site_error` (anything else, including timeout after 25 s). A permission, challenge or rate-limit
response is never turned into an empty success, and nothing is retried.

### Live evidence for get_store

Kernel runtime (`kernel` CLI 0.41.0), 2026-09-29, profile-less stealth browsers signed out, registering
the whole `doordash.com` namespace (`login` and `get_store`) in one `force_overwrite_namespace` batch.
Results are for the final source of this PR; the findings of the independent review that led to the
current `basis` rules are listed under "Independent QA".

| case | result |
|---|---|
| stores 29417, 46989, 1227820 from `/`, `/home`, a search page, a store page, a DashPass page | `ok`, 0.6 to 0.9 s, no navigation (a marker on `window` survived), output valid under Ajv against the schema the runtime lists; `basis: no_address_selected` everywhere (landing address form on `/` and `/home`, placeholder text elsewhere); delivery figures `null`, pickup and store data returned |
| `/es-US/`, `/en-CA/` and `/fr-CA/` store pages | header "Tu dirección" and "Your Address" give `no_address_selected`; fr-CA's "Votre adresse" (no digit, not a known placeholder) gives `unknown`; delivery figures `null` in all three |
| store 36030759 (convenience) from a grocery tab | `store_type: convenience`, `menu: null`, `pickup.available: false` with `estimate_minutes: null` |
| unrated store 37757465 | `rating.average: null`, `count: 0` |
| unknown id 99999999999 and empty-header id 1 | `not_found` |
| malformed inputs (`abc`, `{}`, 13 digits, a number, an extra field, a space, `-1`, `""`, `029417`, `0`, padded and newline-terminated ids) | `invalid_input`; CDP network events showed no `storepageFeed` request, while one valid call showed exactly one |
| help., merchants., identity.doordash.com | `get_store` is not listed (only `login`); the apex redirects to `www` where it is listed |
| two guest egress locations (central US and New York residential) | identical results; before the delivery figures were withheld both showed the same distance (5385 mi) to a New York store |

The same calls in the approved signed-in browser (read only; the custom tools were registered for the
check and removed afterwards, and no address text or account data was recorded): a store in range of
the account's address returned `basis: selected_address`, `signed_in: true`, and delivery and pickup
available with estimate ranges; a store outside that range returned `too_far_from_consumer: true` with
pickup still available; a convenience store in range returned delivery available and pickup
unavailable. Store ids and distances from this account are deliberately not recorded.

Local Chrome extension runtime (Chromium 153.0.8010.52 under Xvfb, throwaway profile and state directory),
2026-09-29, author check of `get_store.js` at commit `ab34f98`: installed with `xwebmcp add` pinned to that
commit, attached with `xwebmcp attach` (both tools in one batch), site access granted in the popup. Both
tools were listed on a store page; `get_store` calls made from the page (`document.modelContext.executeTool`)
and through `xwebmcp mcp` (`open_tab` then `invoke_tool`) returned the same outputs as on Kernel, including
`no_address_selected` on `/es-US/`, `not_found`, and `invalid_input` for `abc`, an extra field and `029417`,
with no navigation. `xwebmcp invoke <tool_ref>` refused a tab it had not opened (`tab_not_allowed`), as the
README describes. DoorDash's native tools were not listed by `getTools()` in this Chromium, unlike on
Kernel; the cause was not investigated. Not run locally: a signed-in profile and real address.

### Independent QA

Round 1, 2026-09-29, agent `agt_e3cd254315c78d609b12` against commit `3488ced` in two profile-less
stealth browsers (one default egress, one New York proxy; both deleted) and in a throwaway local
Chromium 153 with the extension runtime. Static review, the full test suite, live matrix, 57-store
sweep, 71-cookie leakage check, 44 source mutants against the tests. Verdict: defects found, none a
blocker. Findings and what changed:

| finding | severity | resolution |
|---|---|---|
| `addressText !== "Your Address"` read any non-English placeholder ("Tu dirección" on `/es-US/`) as `selected_address`, so placeholder figures were labelled as a real address's | major | An address is now recognised positively only (text with a digit that is not a known placeholder); known placeholders are `no_address_selected`; everything else is `unknown`. Tests cover es-US, an unrecognised locale, a digit-less address and an empty header. |
| `basis: unknown` on `/` and `/home` passed DoorDash's placeholder figures through as definite values | major (design) | Delivery figures are now withheld for `unknown` as well; only `selected_address` returns them. The signed-out landing address form is recognised as `no_address_selected`. |
| a leading-zero id (`029417`) was accepted and then reported as `site_changed` | minor | The id pattern rejects leading zeros (`invalid_input`); id `0` is rejected too. |
| `rating.average: 0` for unrated stores | minor | `null` when the site reports zero ratings. |
| README and description inaccuracies (single-digit ids, only `OPEN` observed, `signed_in` wording) | minor | Corrected below and in the tool description. |
| seven surviving source mutants (padded ids, `signed_in: true`, the convenience guard, the timeout, the error-text bound) | minor | Tests added; a local re-run of 15 mutants of the new logic and of those gaps found all caught. |
| distance plus the store coordinates could be combined across stores to estimate the customer's location | privacy judgement | The numeric distance is no longer returned or requested. |

Round 2, 2026-09-29, same agent `agt_e3cd254315c78d609b12` against commit `27aedc3` (`get_store.js` sha256
`f5223a9ef3fa82d5552605c5d57fb1d979cab05f115ebdfabf28e7679bd30a1d`, unchanged in the later commits) in two
new profile-less stealth browsers (deleted) and the same throwaway local Chromium method. Verdict: **no
defects; signed off on that source as ready for `qa_passed`**. It re-verified all seven round 1 findings;
probed the header on en-US, es-US, en-CA, fr-CA, en-AU, en-NZ and en-GB (every other locale path it tried
returned 404 or redirected to en-US) and on `/`, `/home`, search, store, DashPass and grocery pages plus an
emulated mobile viewport, with no signed-out case reading `selected_address` and none reading
`no_address_selected` while an address was showing; sent 21 malformed inputs (0 requests) and 11 valid calls
(exactly 11 requests); swept 57 stores (0 schema failures, every delivery field `null`); checked 73 cookie
values for leakage (none; one false positive from a cookie whose value is `doordash.com`); and ran 77
source mutants, of which 68 were killed. Of the 9 survivors, four were equivalent, two were the unanchored
placeholder regex and three were test gaps; the tests now cover the gaps (request omits
`distanceFromConsumer`, `execute` agrees with the schema pattern, exact `dd_cx_logged_in=true` cookie
boundary, a placeholder is matched only as the whole text) and a re-run of those mutants finds all caught.
Its minor nits: the description's "not recognised" does not mention that `unknown` also covers a page with
neither a header control nor the landing form (seen live on a mobile `/home`; the schema text says "or
absent"), and one Known limitations line still said two egress locations (fixed). Not checked by the
reviewer: any signed-in state, a real selected address, the NY-proxy egress in the extension, and real
401, 429 or challenge responses (stub-driven only). It also noted that `"Your Address 2"`-style text reads
as `selected_address` because any digit counts, which is unreachable with real placeholders.

Status: `qa_passed`, not `verified`. The `selected_address` branch and the delivery figures it releases have
only the author's live evidence, from one signed-in session, and no independent live check, so the
"live end-to-end success" bar of `spec/repository.md` §5.4 for the tool's central claim is not met even
though independent live successes exist from several pages.

The review also confirmed live that `menu_id` equals the id the native `get_restaurant_menu` reports for
five stores, that six concurrent invocations in one tab succeed, that a document replaced mid-call is
reported by the runtime as `outcome_unknown` (the extension reports an unobservable outcome after 5 s),
and that the delivery placeholder values were identical across the two egress locations. Its synthetic
checks (a selected address, `delivery.available: true`, and the 401, 429, challenge, non-JSON,
site-changed and timeout branches, driven with stubs in throwaway browsers) are not live evidence of real
site responses.

### Known limitations of get_store

- `qa_passed` on `get_store.js` sha256 `f5223a9e…` (commit `ab34f98`; later commits touch only this README, the
  tests and the registry). Not `verified`: see "Independent QA".
- Not verified live: `login_required`, `challenge`, `rate_limited` and `site_changed` responses (fixture
  coverage only, with response shapes assumed from GraphQL conventions and the observed `NOT_FOUND` shape).
  The `challenge` detection looks only at non-JSON bodies.
- `basis` rests on the header address control, the landing address form and two localised placeholders
  ("Your Address", "Tu dirección"). Other locales fall to `unknown` (fr-CA was seen live), so delivery figures
  are missing there even for a guest who has an address without a digit in it. A guest-entered address (never
  exercised: the tool and its testing never set one) is assumed to show as text containing a digit, and that a
  guest address changes DoorDash's figures is unobserved. Signed in without any saved address is unobserved. That
  the placeholder location is the same for every guest was seen from four egress locations in total (two by the
  author, two by the reviewer).
- `unknown` also covers a page with neither a header control nor the landing form (seen live on a mobile
  `/home`), which the tool description does not spell out.
- `selected_address` is the only basis with delivery figures, and it was live-verified only in the one signed-in
  session described above; `delivery.available: true` for a guest-selected address is not verified.
- The delivery estimate and availability are for one moment and one context. `fulfillmentType` is fixed to
  Delivery in the request; the same response carries the pickup status. Scheduled orders are not modelled.
- `operation_status` is a pass-through string: `OPEN` was seen by the author, and `OPEN_CLOSING_SOON` and
  `UNAVAILABLE` in the reviewer's 57-store sweep. There is deliberately no `open_now` boolean.
- The trimmed query names fields and types taken from the site's own query on 2026-09-29. If DoorDash
  renames them the tool returns `site_changed`; the query is not a public API.
- Loading a store page or this query may register a store view in DoorDash's own analytics, as any visit does.
- Only stores DoorDash reports under `/store/<id>` were sampled, plus one convenience store; other store
  types (for example shipping-only) are unobserved.
- Delivery figures depend on the session's address; the egress location did not change them in the four
  locations tried. Coordinates and street in `address` are the store's own.

### URL patterns

`get_store` is narrowed to `https://www.doordash.com/*`; `login` keeps the default pair. The tool calls
`www.doordash.com`'s own GraphQL endpoint with a relative URL, and the other `*.doordash.com` hosts are
unrelated products (`merchants.`, `dasher.`, `business.`, `help.`, `developer.`, `about.`, `identity.`)
that do not serve it; they were observed on 2026-09-29 to have no native tools and a different purpose.
`login` cannot be narrowed the same way because sign-in runs on `identity.doordash.com`. The namespace
therefore mixes both forms, against the `SHOULD` in `spec/repository.md` §6.2 that one host be used per
namespace; this is flagged for review.

## Sessions

- Long-lived signed-in browser (profile `personal-stuff`, residential proxy): `wjdkr9p7ugcc9ui4ssf7e4mm` (24-hour inactivity timeout; left alive for the search and cart phase).
- Exploration browser (no profile): `f8hxya0e603z86s1nsamz01b` (deleted after this work).
- Source: this repository is canonical; sessions expire but files do not. No credentials or codes are stored here.
