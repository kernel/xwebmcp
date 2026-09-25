# instacart.com

Tools for Instacart (https://www.instacart.com).

| tool | file | status | notes |
|------|------|--------|-------|
| login | [login.js](login.js) | draft | Passwordless email-code login. Email step, code step, already-logged-in check and wrong-account check live-verified on 2026-09-25. |

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

Live-verified on 2026-09-25 (residential `cincy` proxy, stealth, `personal-stuff`
profile, session `q2yx9he194tv65c9k0idghnz`):

| path | input | result | time |
|------|-------|--------|------|
| already logged in, starting from a Kernel proxy error page | real email | DuckDuckGo entry → landing redirected to `/store` → `/store/account` matched → `authenticated: true`, no submission | 11.5 s |
| already logged in, wrong account | fabricated email | `unknown`, "logged in as a different account (r***@…)", no submission | 0.4 s |
| logged out, fabricated address | fabricated email | DuckDuckGo entry → `/login` → one submission → `invalid_credentials` "Enter a valid email address." | 7.6 s |
| logged out, real address | real email | one submission → `mfa_required: true`, `next_step: enter_email_otp` | 9.0 s |
| Verify email step open | real email + emailed code | six key presses → auto-submit → `/store/account` matched → `authenticated: true` | 6.6 s |

Independent QA, round 1 (agent `agt_3fa02b3438dc8870922b`, browser
`lp3grtyz8mclt54bev1n11ou`, stealth, `cincy` proxy, no profile, no vault, commit
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

Unverified:

- Wrong or expired codes (`mfa_failed`), lockout or throttling text, a visible reCAPTCHA
  that the solver fails to clear, and a `Request a new code` resend. These branches have
  mocked coverage only.
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

## Surfaces relevant to search and cart tools

Observed while logged in (not built here):

- Search: `https://www.instacart.com/store/s?k=<query>` renders results client-side and
  appends a `search_id` query parameter; the header has a `Search` textbox and button.
  Anonymous search works too (`/store/s?k=milk` used ZIP 45410 without an account).
- Storefronts: `https://www.instacart.com/store/<retailer-slug>/storefront`
  (e.g. `costco`, `kroger`). Logged-out storefront visits open the login modal.
- Cart: header button `View Cart. Items in cart: N` (disabled at 0 items). Cart state
  is per retailer.
- Account and delivery address: `GetLastUserLocation`, `UserAddresses` GraphQL queries
  fire on login; the header shows the current address control.
- No native WebMCP tools on any of these pages.

## Sessions

- Long-lived logged-in browser: `q2yx9he194tv65c9k0idghnz` (stealth, `cincy` proxy,
  `personal-stuff` profile without saving changes, `rafs-vault` attached, 24-hour
  inactivity timeout). Left logged in for the next tools.
- Source: this repository is canonical; no credentials, codes, or live-view URLs are
  stored here.
