# kroger.com

Tools for Kroger (https://www.kroger.com).

| tool  | file                 | status | notes |
|-------|----------------------|--------|-------|
| login | [login.js](login.js) | qa_passed | One submission maximum; live success, already-signed-in, account mismatch and invalid credentials verified; MFA, lockout and CAPTCHA synthetic only |

## Native WebMCP tools

None found (checked 2026-09-25 with `webmcp.listTools()` and
`document.modelContext.getTools()` on the homepage, a search results page
(`/search?query=milk`), a product page (`/p/...`), the cart (`/cart`), the sign-in
redirect (`/signin`) and `/account/profile`, which is a 404).

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
  no MFA, `authenticated: true`, header `RAFAEL`, landing `https://www.kroger.com/`,
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

Best lead for the next person: the signed-in identity, store and loyalty number all
sit in the `kroger-si-customer-data-token` JWT, and the header `RAFAEL` button is
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
| 7 | independent QA pass 3 (no submissions) on the final commit | QA browser, no profile | none | in progress |

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

- Long-lived signed-in browser: `noihe7yj13l2isft6decjt5a` (24-hour inactivity
  timeout, profile changes not saved). It is reused for the search and cart tools.
- Independent QA browsers were deleted by their agents after each pass.
- Source: this repository is canonical; sessions expire but files do not.
