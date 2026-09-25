# ubereats.com

Tools for Uber Eats (https://www.ubereats.com). Sign-in is handled by Uber's shared
auth service at `https://auth.uber.com/v2/`, so the login tool also matches that host.

| tool  | file                 | status | notes                                                                                   |
|-------|----------------------|--------|-----------------------------------------------------------------------------------------|
| login | [login.js](login.js) | draft  | One submission per step; email, chooser, password, and signed-in paths live-verified; SMS code step fixture-only |

## Native WebMCP tools

None found. Checked on 2026-09-25, signed out and signed in, on the home page,
the `auth.uber.com` sign-in steps, `/search?q=pizza`, a `/store/...` page, and
`/checkout`: `webmcp.listTools()` returned only custom tools, `navigator.modelContext`
is undefined, `document.modelContext` is only the Kernel runtime shim, and no element
carries a `toolname` attribute. There is nothing to conflict with; search and cart
tools will have to be custom too.

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
  for the `personal-stuff` profile is in London. Search and cart tools must set the
  address explicitly rather than trusting the default.
- **Marketing overlays.** A cookie notice ("Opt out" / "Got it") sits bottom-right on
  the feed. It did not block the login flow but will need dismissing for cart work.

### Status and known limitations

- Independent QA (agent `agt_b94bb0a4b4d20af839ae`, commit `aae5cc0`) found the
  hydration defect above: the tool never reached Uber's email step on its own in 5 of 6
  live runs. A second pass (agent `agt_c4fd2ee51e0ad730bd35`, commit `84a9be7`) confirmed
  the fix (Log in clicked on its own in 2 of 2 runs that reached the auth page) and found
  the disabled-Continue race above, which stopped 1 of 2 runs before submitting. That fix
  has fixture coverage and is awaiting live re-verification.
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

Recorded 2026-09-25. Owner runs used the long-lived session below with the
`personal-stuff` profile and the `us-mobile` proxy; fabricated runs used a separate
stealth browser on the `cincy` proxy with no profile, since deleted.

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
without profile or vault: `nxg4wrwoyufbgdp9qb5zfhoa` on `cincy`, replaced by
`oax3sse568exk6dv7421o8je` on `us-mobile` after the proxy error page; both deleted):

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

Independent QA of commit `84a9be7` (agent `agt_c4fd2ee51e0ad730bd35`, browsers
`znx8n3iwk7brwumkret2vsnh` on `cincy` and `y5txeyzedfsqcxunsb8b7weo` on `us-mobile`, both
deleted):

| case                                                       | account     | result                                   | evidence                                              |
|------------------------------------------------------------|-------------|------------------------------------------|-------------------------------------------------------|
| Entry from home (`cincy`)                                  | fabricated  | `unknown` at `open_login`, 0 submissions | proxy error page recognized and named                 |
| Entry from home (`us-mobile`), run 1                       | fabricated  | `unknown` at `email`, 0 submissions      | Continue still disabled when read once                |
| Entry from home (`us-mobile`), run 2                       | fabricated  | `enter_email_code`, 26 s, 1 submission   | code step heading named the fabricated address        |
| Re-invocation with the code step open                      | fabricated  | `enter_email_code`, 0 submissions        |                                                       |
| Wrong 4-digit code, then the same again                    | fabricated  | `mfa_failed`, then 20 s guard            | 1 submission                                          |
| Four malformed inputs on the home page                     | fabricated  | rejected, no page action                 | all outputs valid under Ajv                           |
| Listing on `/search?q=pizza`                               | n/a         | listed once the page settled             | one empty listing mid-navigation                      |

Local contract and fixture tests:

```sh
node --test tests/ubereats-login.test.mjs
```

They mock the DOM and CDP helpers (fake clock, `sessionStorage`, mutation observer) and
cover schema branches, input rejection before any page action, entry from unrelated
and non-login pages, entry failures, stale feedback, uncertain clicks, the chooser,
password and prefilled-password handling, both code steps, and the per-step guards.
They are not live evidence.

## Sessions

- Long-lived owner session: `hs15472lgc2jt0tvewsrqs3j` (24-hour inactivity timeout,
  `personal-stuff` profile read-only, `rafs-vault` attached, `us-mobile` proxy).
  Signed in on 2026-09-25 and left signed in for the search and cart work.
- Independent QA sessions: `nxg4wrwoyufbgdp9qb5zfhoa`, `oax3sse568exk6dv7421o8je`,
  `znx8n3iwk7brwumkret2vsnh`, and `y5txeyzedfsqcxunsb8b7weo` (all deleted after their runs).
- Source: this repository is canonical; sessions expire but files do not.
