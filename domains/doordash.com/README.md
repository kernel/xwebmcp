# doordash.com

Tools for DoorDash (https://www.doordash.com).

| tool | file | status | notes |
|------|------|--------|-------|
| login | [login.js](login.js) | draft | Email + password sign-in with a two-step guided flow; existing sessions verified against the profile page; `otp` mode for the 2-Step Verification modal |

## Native WebMCP tools

Checked on 2026-09-25 in a stealth browser with a signed-in profile. DoorDash ships its own
tools through a `[WebMCP Polyfill]` that it installs on `navigator.modelContext`
(`registerTool`, `unregisterTool`, `callTool`, `listTools`, plus a `_registeredTools` map).
The polyfill is page JavaScript, not the browser's `document.modelContext` API, so
`webmcp.listTools()` in the Kernel REPL returns **no native tools** on any page; read them with
`await navigator.modelContext.listTools()` from page context instead. The polyfill can take a few
seconds to load after `load`; poll for `navigator.modelContext` before reading. Tool names are
therefore not visible to Kernel's WebMCP client, but the custom `login` name still does not
collide with any of them.

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

None of the native tools sign in, so `login` is custom. Search and cart are already covered
natively; the next phase should evaluate those tools before writing custom ones, and it must
call them through `navigator.modelContext.callTool` (or register the site-provided definitions)
because Kernel's WebMCP client does not see the polyfill.

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
   control. The tool waits for the cookie or the header control, not the footer's Account Details
   link, which exists on signed-out pages too.

Endpoints observed: `POST https://identity.doordash.com/v2/auth/guided/email` for the email step
(HTTP 200 even for an unknown email; the outcome is in the body and the DOM). The page loads an
invisible reCAPTCHA Enterprise anchor (`www.google.com/recaptcha/enterprise/anchor`); no visible
challenge appeared in any run.

## Loading

```javascript
const source = (await import("node:fs")).readFileSync("domains/doordash.com/login.js", "utf8");
await webmcp.addCustomTools({ namespace: "doordash.com", tools: eval(source), forceOverwriteNamespace: true });
const tool = (await webmcp.listTools()).find(t => t.source.custom?.namespace === "doordash.com" && t.tool.name === "login");
const result = await webmcp.invokeTool(tool.tool_ref, { email: "qa@example.invalid", password: "fabricated" }, { timeoutSec: 120 });
// Second step, once the code arrives:
// await webmcp.invokeTool(tool.tool_ref, { email: "qa@example.invalid", otp: "123456" }, { timeoutSec: 120 });
```

`forceOverwriteNamespace: true` replaces every tool in `doordash.com`; register search or cart tools
together with `login` as one array. Take a fresh `tool_ref` after navigation. Use `timeoutSec: 120`
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
- A `MutationObserver` armed before each submission flags feedback that re-renders with unchanged
  text, so an old "incorrect" message that DoorDash repaints after the new attempt is still
  attributed to that attempt. Button and link text is stripped from `error_message`.
- The tool tracks a 115-second budget and honours the runtime's abort signal. It refuses to click
  the password submit when fewer than 48 seconds remain, so a caller timeout cannot leave a
  submission running unobserved; invoke again from the current page in that case.

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

Round 2 is recorded below once it completes.

## Status and known limitations

Status: `draft` pending the independent QA pass recorded above.

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
- **Best lead for the next person:** DoorDash sends the 2-Step code to the phone by default. The
  modal's "Send to Email" button switches delivery to the account email, which can be read from the
  mailbox; the tool does not click it, so a caller that cannot receive SMS should click it in the
  browser before invoking `otp` mode.

## Sessions

- Long-lived signed-in browser (profile `personal-stuff`, residential proxy): `wjdkr9p7ugcc9ui4ssf7e4mm` (24-hour inactivity timeout; left alive for the search and cart phase).
- Exploration browser (no profile): `f8hxya0e603z86s1nsamz01b` (deleted after this work).
- Source: this repository is canonical; sessions expire but files do not. No credentials or codes are stored here.
