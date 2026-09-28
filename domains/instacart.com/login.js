[{
  kind: "cdp",
  match: { url_patterns: ["https://instacart.com/*", "https://*.instacart.com/*"] },
  tool: {
    name: "login",
    description: "Log in to Instacart with an email address. Instacart's email login is passwordless: the site emails a six-digit code after the address is accepted, so a first invocation (email only) submits the address exactly once and returns logged_in=true with mfa_required=true, and a second invocation with the same email plus otp enters that code. password is accepted for interface parity but never entered. An already authenticated session is verified on the account page without any submission, and a session for a different account is reported as a failure. Entry is a DuckDuckGo search for instacart login followed by its first organic www.instacart.com result; when that page is not the sign-in form the site's own Log in control opens it. The stealth browser's captcha solver may run during the bounded observation window; an unresolved challenge is reported, never solved here. Never retries, never requests a new code, never creates or resets accounts. Do not invoke again after an uncertain result without inspecting the browser.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        email: { type: "string", format: "email", minLength: 6, maxLength: 254, description: "Account email address. Also used to confirm which account the browser is or becomes logged in as." },
        password: { type: "string", minLength: 1, maxLength: 1024, description: "Ignored. Instacart's email flow has no password step; the value is never typed, logged, or returned." },
        otp: { type: "string", pattern: "^[0-9]{6}$", description: "Current six-digit code from the Instacart verification email. Supply it on a second invocation while the Verify email step is visible." }
      },
      required: ["email"]
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false,
          properties: {
            logged_in: { const: true, type: "boolean" },
            authenticated: { type: "boolean" },
            mfa_required: { type: "boolean" },
            next_step: { type: "string", enum: ["none", "enter_email_otp"] },
            landing_url: { type: "string", format: "uri" },
            account_name_or_hint: { type: ["string", "null"] },
            evidence: { type: "string", minLength: 1 },
            submission_attempted: { type: "boolean" }
          },
          required: ["logged_in", "authenticated", "mfa_required", "next_step", "landing_url", "account_name_or_hint", "evidence", "submission_attempted"],
          oneOf: [
            { properties: { authenticated: { const: true }, mfa_required: { const: false }, next_step: { const: "none" } } },
            { properties: { authenticated: { const: false }, mfa_required: { const: true }, next_step: { const: "enter_email_otp" } } }
          ]
        },
        {
          type: "object", additionalProperties: false,
          properties: {
            logged_in: { const: false, type: "boolean" },
            error_kind: { type: "string", enum: ["invalid_input", "invalid_credentials", "captcha_or_challenge", "mfa_failed", "locked_or_throttled", "unknown"] },
            error_message: { type: "string", minLength: 1 },
            error_source: { type: "string", enum: ["site", "tool"] },
            stage: { type: "string", enum: ["input", "account_check", "search_entry", "site_entry", "before_submit", "after_submit"] },
            submission_attempted: { type: "boolean" },
            attempts_remaining_if_shown: { type: ["integer", "null"], minimum: 0 }
          },
          required: ["logged_in", "error_kind", "error_message", "error_source", "stage", "submission_attempted", "attempts_remaining_if_shown"]
        }
      ]
    },
    annotations: { destructiveHint: false, readOnlyHint: false }
  },
  execute: async (input) => {
    const origin = "https://www.instacart.com";
    const searchOrigins = ["https://start.duckduckgo.com", "https://duckduckgo.com"];
    const emailSelector = 'input[type="email"][name="email"]';
    const codeSelector = 'input[name="code"][autocomplete="one-time-code"]';
    let submitted = false;
    let stage = "input";
    const fail = (kind, message, source = "tool") => {
      const remaining = source === "site" ? message.match(/(\d+)\s+(?:more\s+)?attempts?\s+(?:remaining|left)/i) : null;
      return { logged_in: false, error_kind: kind, error_message: message, error_source: source, stage, submission_attempted: submitted, attempts_remaining_if_shown: remaining ? Number(remaining[1]) : null };
    };
    if (!input || typeof input !== "object" || Array.isArray(input)) return fail("invalid_input", "Input must be an object with email and optionally otp. Nothing was submitted.");
    if (Object.keys(input).some(k => !["email", "password", "otp"].includes(k))) return fail("invalid_input", "Unrecognized input field. Nothing was submitted.");
    const email = typeof input.email === "string" ? input.email.trim() : "";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return fail("invalid_input", "email must be a valid email address. Nothing was submitted.");
    if (input.password !== undefined && (typeof input.password !== "string" || !input.password)) return fail("invalid_input", "password, when supplied, must be a non-empty string. It is never entered because Instacart emails a code instead.");
    if (input.otp !== undefined && (typeof input.otp !== "string" || !/^[0-9]{6}$/.test(input.otp))) return fail("invalid_input", "otp must be the current six-digit emailed code. Nothing was submitted.");
    const lowerEmail = email.toLowerCase();
    const mask = address => address.replace(/^(.)[^@]*@/, "$1***@");

    const read = async () => js(expected => {
      const visible = e => !!e && e.getClientRects().length > 0 && e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
      const text = e => (e.innerText || e.textContent || "").replace(/\s+/g, " ").trim();
      const all = selector => [...document.querySelectorAll(selector)].filter(visible);
      const described = field => field.getAttribute("aria-invalid") === "true"
        ? [field.getAttribute("aria-errormessage"), field.getAttribute("aria-describedby")].filter(Boolean).map(id => document.getElementById(id)).filter(visible).map(text).find(Boolean) || null
        : null;
      const emailInput = all('input[type="email"][name="email"]')[0] || null;
      const emailForm = emailInput?.closest("form") || null;
      const continueButton = emailForm ? [...emailForm.querySelectorAll('button[type="submit"]')].find(b => visible(b) && !b.disabled && /^continue$/i.test(text(b))) : null;
      const codeInput = all('input[name="code"][autocomplete="one-time-code"]')[0] || null;
      const headings = all("h1,h2,h3").map(text);
      const codeHint = codeInput ? all("p,div,span").map(text).filter(t => /sent a .*code to /i.test(t) && t.length < 300).sort((a, b) => a.length - b.length)[0] || null : null;
      const alerts = [...new Set(all('[role="alert"]').map(text).filter(Boolean))];
      const controls = all("a,button").map(e => text(e) || e.getAttribute("aria-label") || "");
      const body = (document.body?.innerText || "").replace(/\s+/g, " ").slice(0, 4000);
      const challengePattern = /verify (?:that )?you(?:'re| are) human|access denied|unusual traffic|security check|checking your browser|bots use duckduckgo|select all squares/i;
      const challenge = [...headings, ...alerts].find(t => challengePattern.test(t)) || (challengePattern.test(body) ? body.match(challengePattern)[0] : null);
      const captchaFrame = all("iframe").find(f => /recaptcha\/(?:api2|enterprise)\/bframe/.test(f.src) && f.getBoundingClientRect().width > 100);
      const accountEmail = location.pathname.replace(/\/$/, "") === "/store/account" ? (body.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/) || [null])[0] : null;
      return {
        url: location.href,
        path: location.pathname,
        onSite: location.protocol === "https:" && (location.hostname === "instacart.com" || location.hostname.endsWith(".instacart.com")),
        proxyError: /^(?:proxy proxy error|egress-proxy-mitm encountered)/i.test(body),
        emailForm: !!emailInput && !!continueButton,
        emailMatches: !!emailInput && emailInput.value.trim().toLowerCase() === expected,
        emailError: emailInput ? described(emailInput) : null,
        codeStep: !!codeInput,
        codeLength: codeInput ? codeInput.value.length : null,
        codeError: codeInput ? described(codeInput) : null,
        codeHint,
        hintMatches: codeHint && codeHint.includes("@") ? codeHint.toLowerCase().includes(expected) : null,
        alerts,
        challenge,
        captchaVisible: !!captchaFrame,
        loginButton: controls.some(t => /^log in$/i.test(t)),
        accountButton: controls.some(t => /^account$/i.test(t)) || all('a[href="/accounts/logout"]').length > 0,
        accountEmail,
        accountMatches: !!accountEmail && accountEmail.toLowerCase() === expected
      };
    }, { arg: lowerEmail });
    const poll = async (predicate, ms) => {
      const deadline = Date.now() + ms;
      let state = null;
      while (Date.now() < deadline) {
        try {
          state = await read();
          if (predicate(state)) return state;
        } catch {
          // Navigation can replace the execution context; only the observation is retried.
        }
        await waitMs(500);
      }
      return null;
    };
    const classifyText = (message, onCodeStep) => {
      if (/too many|locked|temporarily|try again (?:later|in \d)|rate limit|slow down/i.test(message)) return "locked_or_throttled";
      if (/captcha|robot|human verification|verify (?:that )?you/i.test(message)) return "captcha_or_challenge";
      if (onCodeStep) return "mfa_failed";
      if (/valid email|no account|not (?:found|recognized)|doesn't exist|does not exist|incorrect|invalid/i.test(message)) return "invalid_credentials";
      return "unknown";
    };
    const siteFailure = s => {
      if (s.proxyError) return fail("unknown", "The browser's proxy returned an error page instead of Instacart; retry later or with another proxy.");
      if (!s.onSite) return fail("unknown", "The browser is not on instacart.com; inspect the page before any further attempt.");
      if (s.challenge) return fail("captcha_or_challenge", s.challenge, "site");
      const message = [s.emailError, s.codeError, ...s.alerts].filter(Boolean).join(" ");
      if (message) return fail(classifyText(message, s.codeStep), message, "site");
      return null;
    };
    const loggedIn = s => s.accountButton && !s.loginButton && !s.emailForm && !s.codeStep;
    const mfaStep = s => ({
      logged_in: true, authenticated: false, mfa_required: true, next_step: "enter_email_otp",
      landing_url: s.url, account_name_or_hint: s.codeHint,
      evidence: s.codeHint || "Verify email step with a one-time-code input is visible.",
      submission_attempted: submitted
    });
    const verifyAccount = async () => {
      stage = "account_check";
      let s = null;
      // The account page is a read-only GET, so one proxy error page is retried once; submissions never are.
      for (let attempt = 0; attempt < 2; attempt++) {
        const current = await read();
        if (attempt > 0 || current.proxyError || current.path.replace(/\/$/, "") !== "/store/account") {
          if (attempt > 0) await waitMs(2000);
          await gotoUrl(origin + "/store/account");
          await waitForLoad(20);
        }
        s = await poll(x => !x.onSite || x.proxyError || !!x.accountEmail || x.emailForm || x.loginButton || !!x.challenge, 15000);
        if (!s || !s.proxyError) break;
      }
      if (!s) return fail("unknown", "The account page did not confirm a session within 15 seconds.");
      const blocked = siteFailure(s);
      if (blocked) return blocked;
      if (s.emailForm || s.loginButton) return null;
      if (!s.accountEmail) return fail("unknown", "The account page did not display an account email, so the session could not be verified.");
      if (!s.accountMatches) return fail("unknown", "The browser is logged in as a different account (" + mask(s.accountEmail) + "); log out before logging in as " + mask(email) + ".");
      return {
        logged_in: true, authenticated: true, mfa_required: false, next_step: "none",
        landing_url: s.url, account_name_or_hint: s.accountEmail,
        evidence: "Account page shows " + s.accountEmail + " with a Log out control.",
        submission_attempted: submitted
      };
    };
    const emailGuardKey = "instacart.com.login.email_submitted.v1";
    const codeGuardKey = "instacart.com.login.code_submitted.v1";
    // The marker is written before the single submit and survives uncertain outcomes; a conclusive
    // site rejection releases it so a corrected address or code can be submitted without waiting.
    const guard = async (key, windowMs) => js(({ key, windowMs }) => {
      const previous = Number(sessionStorage.getItem(key) || 0);
      if (previous && Date.now() - previous < windowMs) return false;
      sessionStorage.setItem(key, String(Date.now()));
      return true;
    }, { arg: { key, windowMs } });
    const releaseGuard = async key => {
      try { await js(({ release }) => sessionStorage.removeItem(release), { arg: { release: key } }); } catch { /* The page may already have navigated. */ }
    };

    try {
      if (input.otp !== undefined) {
        stage = "before_submit";
        const s = await read();
        if (s.proxyError || !s.onSite || s.challenge) return siteFailure(s);
        if (!s.codeStep) return fail("unknown", "No Verify email step is visible; invoke without otp first so Instacart emails a code. No code was entered.");
        if (s.hintMatches === false) return fail("unknown", "The visible code step belongs to a different address (" + mask(s.codeHint.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/)[0]) + "). No code was entered.");
        if (!await guard(codeGuardKey, 60000)) return fail("unknown", "This tab already entered a code within the last minute; inspect the page instead of entering another. No code was entered.");
        // An error left by an earlier code is not this code's verdict: report only feedback that changed or reappeared.
        const feedback = x => [x.codeError, ...x.alerts].filter(Boolean).join(" ");
        const previous = feedback(s);
        let cleared = !previous;
        submitted = true;
        stage = "after_submit";
        await click(codeSelector);
        for (const digit of input.otp) await pressKey(digit);
        const typed = await poll(x => !x.codeStep || x.codeLength === 6 || feedback(x) !== previous, 5000);
        if (typed && typed.codeStep && typed.codeLength !== 6 && feedback(typed) === previous) return fail("unknown", "The code field did not accept all six digits; the site may not have evaluated the code. Inspect the page before any further attempt.");
        const result = await poll(x => {
          const message = feedback(x);
          if (!message) cleared = true;
          return !x.onSite || x.proxyError || !!x.challenge || (!!message && (message !== previous || cleared)) || (!x.codeStep && (loggedIn(x) || x.path !== "/login"));
        }, 30000);
        if (!result) return fail("unknown", "The code was entered but no result appeared within 30 seconds. Inspect the page before any further attempt.");
        const failed = siteFailure(result);
        if (failed) {
          if (failed.error_kind === "mfa_failed") await releaseGuard(codeGuardKey);
          return failed;
        }
        return await verifyAccount() || fail("unknown", "The code step closed but the account page shows a login form; the session was not established.");
      }

      let s = await read();
      if (s.onSite && !s.proxyError && (s.accountButton || s.codeStep)) {
        const existing = siteFailure(s);
        if (existing) return existing;
        if (s.codeStep) {
          if (s.hintMatches === false) return fail("unknown", "A Verify email step for a different address is already open; go back before logging in as " + mask(email) + ". Nothing was submitted.");
          return mfaStep(s);
        }
        const verified = await verifyAccount();
        if (verified) return verified;
      }

      stage = "search_entry";
      await gotoUrl("https://start.duckduckgo.com/");
      const searchPage = new URL((await pageInfo()).url);
      if (!searchOrigins.includes(searchPage.origin)) return fail("unknown", "Search navigation did not reach DuckDuckGo; no login submission made.");
      let query, search;
      const controlsDeadline = Date.now() + 20000;
      while (Date.now() < controlsDeadline) {
        const snapshot = await accessibilitySnapshot();
        query = snapshot.nodes.find(n => ["combobox", "textbox", "searchbox"].includes(n.role) && n.name === "Search with DuckDuckGo");
        search = snapshot.nodes.find(n => n.role === "button" && n.name === "Search");
        if (query && search) break;
        await waitMs(500);
      }
      if (!query || !search) {
        const blocked = await read();
        if (blocked.proxyError) return siteFailure(blocked);
        return fail("unknown", "DuckDuckGo search controls did not become available; no login submission made.");
      }
      await fillInput({ backendNodeId: query.backendNodeId }, "instacart login");
      await click({ backendNodeId: search.backendNodeId });
      if (!await waitForElement('[data-testid="result"] [data-testid="result-title-a"]', { timeoutSec: 20 })) {
        const blocked = await read();
        if (blocked.challenge) return fail("captcha_or_challenge", "DuckDuckGo challenged this session before any Instacart request was made: " + blocked.challenge, "site");
        return fail("unknown", "DuckDuckGo organic results did not become available; no login submission made.");
      }
      const target = await js(() => {
        if (!["https://duckduckgo.com", "https://start.duckduckgo.com"].includes(location.origin)) return null;
        document.querySelectorAll("[data-webmcp-instacart-login]").forEach(e => e.removeAttribute("data-webmcp-instacart-login"));
        const first = [...document.querySelectorAll('[data-testid="result"]')].find(r => !r.closest('[data-layout="ad"], [data-testid="ad"]'));
        const link = first?.querySelector('[data-testid="result-title-a"]');
        if (!link || !link.getClientRects().length) return null;
        let destination;
        try { destination = new URL(link.href); } catch { return null; }
        if (destination.protocol !== "https:" || destination.hostname !== "www.instacart.com") return null;
        link.setAttribute("data-webmcp-instacart-login", "true");
        return destination.href;
      });
      if (!target) return fail("unknown", "The first organic DuckDuckGo result was not an https://www.instacart.com page; no login submission made.");
      await click('[data-webmcp-instacart-login="true"]');
      stage = "site_entry";
      await waitForLoad(25);
      s = await poll(x => x.proxyError || (x.onSite && (x.emailForm || x.loginButton || x.accountButton || x.codeStep || !!x.challenge)), 20000);
      if (!s) return fail("unknown", "The search result did not land on a usable Instacart page; no login submission made.");
      const landing = siteFailure(s);
      if (landing) return landing;
      if (s.codeStep) {
        if (s.hintMatches === false) return fail("unknown", "A Verify email step for a different address is already open; go back before logging in as " + mask(email) + ". Nothing was submitted.");
        return mfaStep(s);
      }
      if (loggedIn(s)) {
        const verified = await verifyAccount();
        if (verified) return verified;
        s = await read();
      }
      if (!s.emailForm) {
        if (!s.loginButton) return fail("unknown", "Neither the sign-in form nor a Log in control is visible on the Instacart landing page; no login submission made.");
        const snapshot = await accessibilitySnapshot();
        const open = snapshot.nodes.find(n => ["button", "link"].includes(n.role) && n.name === "Log in");
        if (!open) return fail("unknown", "The Log in control could not be resolved in the accessibility tree; no login submission made.");
        await click({ backendNodeId: open.backendNodeId });
        s = await poll(x => x.emailForm || !!x.challenge || !x.onSite, 15000);
        if (!s || !s.emailForm) return fail("unknown", "The Instacart sign-in form did not open; no login submission made.");
      }

      stage = "before_submit";
      await fillInput(emailSelector, email);
      s = await read();
      const before = siteFailure(s);
      if (before) return before;
      if (!s.emailForm || !s.emailMatches) return fail("unknown", "The email field did not receive the supplied address; nothing was submitted.");
      if (!await guard(emailGuardKey, 15 * 60 * 1000)) return fail("unknown", "This tab already submitted an email within the last 15 minutes without a conclusive result; inspect the page instead of submitting again. Nothing was submitted.");
      submitted = true;
      stage = "after_submit";
      await click('form:has(input[type="email"][name="email"]) button[type="submit"]');
      let sawCaptcha = false;
      const result = await poll(x => {
        if (x.captchaVisible) sawCaptcha = true;
        return !x.onSite || x.proxyError || !!x.challenge || x.codeStep || !!x.emailError || x.alerts.length > 0 || loggedIn(x);
      }, 60000);
      if (!result) {
        if (sawCaptcha) return fail("captcha_or_challenge", "A reCAPTCHA challenge was shown after submitting the email and was not resolved within 60 seconds.", "site");
        return fail("unknown", "The email was submitted but no result appeared within 60 seconds. Inspect the page before any further attempt.");
      }
      const after = siteFailure(result);
      if (after) {
        if (after.error_kind === "invalid_credentials") await releaseGuard(emailGuardKey);
        return after;
      }
      if (result.codeStep) {
        if (result.hintMatches === false) return fail("unknown", "Instacart opened a code step for a different address than the one submitted. Inspect the page.");
        return mfaStep(result);
      }
      return await verifyAccount() || fail("unknown", "The submission finished without a code step or a verified session. Inspect the page before any further attempt.");
    } catch {
      return fail("unknown", submitted
        ? "Browser interaction failed after a submission was attempted; the outcome is unknown. Inspect the page before any further attempt."
        : "Browser interaction failed before any submission was attempted.");
    }
  }
}]