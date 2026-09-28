[{
  kind: "cdp",
  match: { url_patterns: ["https://purelymail.com/*", "https://*.purelymail.com/*"] },
  tool: {
    name: "login",
    description: "Sign in to Purelymail webmail (https://inbox.purelymail.com/) with the given email address and password, and confirm the webmail is signed in to exactly that address. If the browser already has a webmail session it submits nothing: the same address returns success with entry already_signed_in, a different address fails with wrong_account (sign out in the webmail first; this tool never switches or signs out accounts). Otherwise it opens https://purelymail.com/user/login, fills the Webmail Login form and submits it once; it never retries. Success leaves the tab on the webmail inbox, where the other purelymail.com tools run. A rejected password returns invalid_credentials: do not loop on it, the account may be throttled. Two-factor prompts are not supported. The whole call is bounded to about 100 seconds. The password is only typed into the Purelymail form and never returned.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["email", "password"],
      properties: {
        email: { type: "string", minLength: 6, maxLength: 254, pattern: "^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$", description: "Full Purelymail address, which is also the webmail username." },
        password: { type: "string", minLength: 1, maxLength: 256, description: "Account password; never returned or logged." }
      }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false, required: ["status", "logged_in", "account", "entry", "submission_attempted", "landing_url"],
          properties: {
            status: { const: "ok" }, logged_in: { const: true },
            account: { type: "string", minLength: 3, description: "Address the webmail header shows; always equals the supplied email." },
            entry: { enum: ["already_signed_in", "form_submitted"] },
            submission_attempted: { type: "boolean" },
            landing_url: { type: "string", format: "uri" }
          }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "logged_in", "error_kind", "error_message", "error_source", "step", "submission_attempted", "signed_in_account"],
          properties: {
            status: { const: "error" }, logged_in: { const: false },
            error_kind: { enum: ["invalid_input", "wrong_account", "invalid_credentials", "mfa_unsupported", "locked_or_throttled", "recent_submission", "unknown"] },
            error_message: { type: "string", minLength: 1 },
            error_source: { enum: ["site", "tool"] },
            step: { enum: ["input", "session_check", "login_form", "before_submit", "after_submit"] },
            submission_attempted: { type: "boolean" },
            signed_in_account: { type: ["string", "null"], description: "For wrong_account: the address the webmail is actually signed in to." }
          }
        }
      ]
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false }
  },
  execute: async (input) => {
    const INBOX = "https://inbox.purelymail.com/?_task=mail&_mbox=INBOX";
    const LOGIN = "https://purelymail.com/user/login";
    const MARKER = "xwebmcp.purelymail.login_submitted_at";
    const startedAt = Date.now();
    const remaining = () => 100000 - (Date.now() - startedAt);
    let step = "input";
    let submitted = false;
    const fail = (kind, message, source = "tool", signedIn = null) => ({ status: "error", logged_in: false, error_kind: kind, error_message: message, error_source: source, step, submission_attempted: submitted, signed_in_account: signedIn });
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => !["email", "password"].includes(key))) return fail("invalid_input", "Input must be { email, password }; nothing was submitted.");
    const { email, password } = input;
    if (typeof email !== "string" || email.length < 6 || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) return fail("invalid_input", "email must be a full email address; nothing was submitted.");
    if (typeof password !== "string" || !password.length || password.length > 256) return fail("invalid_input", "password must be 1-256 characters; nothing was submitted.");
    const account = email.trim().toLowerCase();
    const read = () => js(() => {
      const visible = e => !!e && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== "hidden";
      const rc = window.rcmail && window.rcmail.env;
      const header = document.querySelector(".header-title.username");
      const loginError = [...document.querySelectorAll(".errorFadeOut, #loginForm [style*=\"color: red\"], .center [style*=\"color: red\"]")].filter(visible).map(e => e.textContent.trim()).find(Boolean) || null;
      const codeField = [...document.querySelectorAll("input")].find(e => visible(e) && /one-time-code|totp|otp|2fa|two.?factor|verification/i.test([e.autocomplete, e.id, e.name, e.placeholder, e.getAttribute("aria-label")].join(" ")));
      return {
        url: location.href, host: location.hostname,
        webmail: location.hostname === "inbox.purelymail.com" && !!(rc && rc.request_token) && rc.task !== "login",
        account: header ? header.textContent.trim().toLowerCase() : null,
        form: visible(document.querySelector("#loginForm #emailInput")) && visible(document.querySelector("#loginForm #passwordInput")) && visible(document.querySelector("#loginButton")),
        buttonEnabled: !!document.querySelector("#loginButton") && !document.querySelector("#loginButton").disabled,
        loginError, codeStep: !!codeField,
        marker: (() => { try { return Number(sessionStorage.getItem("xwebmcp.purelymail.login_submitted_at")) || 0; } catch { return 0; } })()
      };
    });
    let latest = null;
    const poll = async (predicate, ms) => {
      const deadline = Date.now() + Math.min(ms, remaining());
      while (Date.now() < deadline) {
        try { latest = await read(); if (predicate(latest)) return latest; } catch { /* the document is being replaced */ }
        await waitMs(400);
      }
      return null;
    };
    const signedIn = state => state.webmail && !!state.account && /@/.test(state.account);
    step = "session_check";
    let info = null;
    try { info = await pageInfo(); } catch { /* no usable page yet */ }
    if (!info || !/^https:\/\/inbox\.purelymail\.com\//.test(info.url)) {
      await gotoUrl(INBOX);
      await waitForLoad(30);
    }
    const first = await poll(s => signedIn(s) || s.form, 25000);
    if (!first) return fail("unknown", "Neither the webmail nor the Purelymail login form appeared" + (latest ? " (the tab is on " + latest.host + ")" : "") + "; nothing was submitted.");
    if (signedIn(first)) {
      if (first.account !== account) return fail("wrong_account", "The browser is already signed in to a different Purelymail webmail account. Sign out in the webmail before signing in as the supplied address; nothing was submitted.", "tool", first.account);
      return { status: "ok", logged_in: true, account: first.account, entry: "already_signed_in", submission_attempted: false, landing_url: first.url };
    }
    step = "login_form";
    if (!/^https:\/\/purelymail\.com\/user\/login/.test(first.url)) {
      await gotoUrl(LOGIN);
      await waitForLoad(30);
      if (!await poll(s => s.form, 20000)) return fail("unknown", "The Purelymail login form did not appear; nothing was submitted.");
    }
    step = "before_submit";
    if (latest.marker && Date.now() - latest.marker < 60000) return fail("recent_submission", "A sign-in was submitted from this tab less than a minute ago with no observed result. Check the page before invoking again; nothing was submitted.");
    if (remaining() < 30000) return fail("unknown", "Too little time remains to observe the result; nothing was submitted.");
    await fillInput("#emailInput", account);
    await fillInput("#passwordInput", password);
    const filled = await js(expected => document.getElementById("emailInput").value.trim().toLowerCase() === expected && document.getElementById("passwordInput").value.length > 0, { arg: account });
    if (!filled) return fail("unknown", "The login form did not accept the typed values; nothing was submitted.");
    await js(key => { try { sessionStorage.setItem(key, String(Date.now())); } catch { /* storage unavailable */ } }, { arg: MARKER });
    submitted = true;
    await click("#loginButton");
    step = "after_submit";
    const done = await poll(s => signedIn(s) || !!s.loginError || s.codeStep, remaining() - 1000);
    const clearMarker = async () => { try { await js(key => { try { sessionStorage.removeItem(key); } catch { /* storage unavailable */ } }, { arg: MARKER }); } catch { /* now on another origin */ } };
    if (!done) return fail("unknown", "No result was observed after submitting the form; the sign-in may still complete. Check the page before invoking again.");
    if (signedIn(done)) {
      if (done.account !== account) return fail("wrong_account", "The webmail opened, but it is signed in to a different account than the supplied address. Sign out in the webmail and try again.", "site", done.account);
      return { status: "ok", logged_in: true, account: done.account, entry: "form_submitted", submission_attempted: true, landing_url: done.url };
    }
    await clearMarker();
    if (done.codeStep) return fail("mfa_unsupported", "Purelymail asked for a second factor, which this tool does not handle; finish it in the page.", "site");
    const text = done.loginError;
    if (/too many|locked|try again later|rate/i.test(text)) return fail("locked_or_throttled", "Purelymail: " + text, "site");
    if (/incorrect|invalid|wrong|not found|password/i.test(text)) return fail("invalid_credentials", "Purelymail: " + text, "site");
    return fail("unknown", "Purelymail: " + text, "site");
  }
}]
