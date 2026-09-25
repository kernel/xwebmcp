[{
  kind: "cdp",
  match: { url_patterns: ["https://kroger.com/*", "https://*.kroger.com/*"] },
  tool: {
    name: "login",
    description: "Sign in to a Kroger account with email and password. If the browser is already signed in on kroger.com the tool returns success without submitting anything and, when the site exposes the signed-in email, confirms it matches the supplied email. Otherwise it enters the site through a DuckDuckGo search for kroger login, follows the first organic kroger.com result, opens sign-in from the site header when that result is not the sign-in page, and submits the login.kroger.com form at most once. A sessionStorage marker blocks a second submission from the same tab. The whole invocation is bounded to 110 seconds and the form is not submitted when fewer than 20 seconds remain to observe the result. Never retries; never requests or resends codes. logged_in=true with mfa_required=true means the password was accepted and a verification-code step is showing: the session is NOT authenticated yet. Supply otp instead of password to submit a code on an already visible verification step. Does not solve CAPTCHAs: an unresolved challenge is reported as captcha_or_challenge.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        email: { type: "string", minLength: 6, maxLength: 254, pattern: "^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$", description: "Kroger account email address. Also used to confirm which account an existing session belongs to." },
        password: { type: "string", minLength: 1, maxLength: 256, description: "Account password; never returned or logged. Omit when submitting a code with otp." },
        otp: { type: "string", pattern: "^[0-9]{4,8}$", description: "Numeric code for a verification step that is already visible. The tool never requests or resends codes." },
        keep_signed_in: { type: "boolean", default: true, description: "Desired state of the Keep me signed in checkbox. The site checks it by default." }
      },
      required: ["email"],
      oneOf: [
        { required: ["password"], not: { required: ["otp"] } },
        { required: ["otp"], not: { required: ["password"] } }
      ]
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false,
          required: ["logged_in", "authenticated", "mfa_required", "next_step", "landing_url", "account_name_or_hint", "account_check", "entry_path", "submission_attempted", "evidence"],
          properties: {
            logged_in: { const: true },
            authenticated: { type: "boolean" },
            mfa_required: { type: "boolean" },
            next_step: { enum: ["none", "enter_otp"] },
            landing_url: { type: "string", format: "uri" },
            account_name_or_hint: { type: ["string", "null"], description: "First name from the site header, or the masked destination of a verification code." },
            account_check: { enum: ["email_confirmed", "unverified"], description: "email_confirmed when the site exposed the signed-in email and it matched the supplied email." },
            entry_path: { enum: ["already_signed_in", "already_open", "search_referrer", "site_navigation"] },
            submission_attempted: { type: "boolean" },
            evidence: { type: "string", minLength: 1 }
          },
          oneOf: [
            { properties: { authenticated: { const: true }, mfa_required: { const: false }, next_step: { const: "none" } } },
            { properties: { authenticated: { const: false }, mfa_required: { const: true }, next_step: { const: "enter_otp" } } }
          ]
        },
        {
          type: "object", additionalProperties: false,
          required: ["logged_in", "error_kind", "error_message", "error_source", "step", "entry_path", "attempts_remaining_if_shown", "submission_attempted"],
          properties: {
            logged_in: { const: false },
            error_kind: { enum: ["invalid_input", "invalid_credentials", "captcha_or_challenge", "mfa_failed", "locked_or_throttled", "unknown"] },
            error_message: { type: "string", minLength: 1 },
            error_source: { enum: ["site", "tool"] },
            step: { enum: ["input", "search_entry", "site_entry", "login_form", "before_submit", "after_submit", "account_check"] },
            entry_path: { enum: ["none", "already_signed_in", "already_open", "search_referrer", "site_navigation"] },
            attempts_remaining_if_shown: { type: ["integer", "null"], minimum: 0 },
            submission_attempted: { type: "boolean" }
          }
        }
      ]
    },
    annotations: { destructiveHint: false, readOnlyHint: false }
  },
  execute: async (input) => {
    const startedAt = Date.now();
    const remaining = () => 110000 - (Date.now() - startedAt);
    let submitted = false;
    let step = "input";
    let entryPath = "none";
    const fail = (kind, message, source = "tool") => {
      const attempts = source === "site" ? message.match(/(\d+)\s+(?:more\s+)?(?:login\s+|sign.?in\s+)?attempts?\s+(?:remaining|left)/i) : null;
      return { logged_in: false, error_kind: kind, error_message: message, error_source: source, step, entry_path: entryPath, attempts_remaining_if_shown: attempts ? Number(attempts[1]) : null, submission_attempted: submitted };
    };
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(k => !["email", "password", "otp", "keep_signed_in"].includes(k))) {
      return fail("invalid_input", "Input must be an object with email plus either password or otp; nothing was submitted.");
    }
    const { email, password, otp } = input;
    const keepSignedIn = input.keep_signed_in === undefined ? true : input.keep_signed_in;
    if (typeof email !== "string" || email.length < 6 || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return fail("invalid_input", "email must be a valid email address; nothing was submitted.");
    }
    if (typeof keepSignedIn !== "boolean") return fail("invalid_input", "keep_signed_in must be a boolean; nothing was submitted.");
    const otpMode = otp !== undefined;
    if (otpMode ? (password !== undefined || typeof otp !== "string" || !/^[0-9]{4,8}$/.test(otp)) : (typeof password !== "string" || password.length < 1 || password.length > 256)) {
      return fail("invalid_input", "Provide password for a credential sign-in or a 4-8 digit otp for a visible verification step, not both; nothing was submitted.");
    }
    const account = email.trim().toLowerCase();

    const classify = text => {
      if (/too many|locked|temporarily (?:blocked|disabled|suspended)|try again (?:later|in \d)|rate limit/i.test(text)) return "locked_or_throttled";
      if (/captcha|verify (?:that )?you(?:'re| are) (?:a )?human|security challenge|access denied/i.test(text)) return "captcha_or_challenge";
      if (/(?:code|otp|passcode)\b.*(?:incorrect|invalid|expired|wrong)|(?:incorrect|invalid|expired|wrong)\b.*(?:code|otp|passcode)/i.test(text)) return "mfa_failed";
      if (/invalid (?:email|username|password|credentials|sign.?in)|incorrect|can(?:'|no)t (?:seem to )?find|not (?:found|recognized)|(?:do|does)n(?:'|o)t match|unable to sign|no account|email or password/i.test(text)) return "invalid_credentials";
      return "unknown";
    };
    const read = async () => {
      const page = await js(() => {
        const visible = e => !!e && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== "hidden" && e.getAttribute("aria-hidden") !== "true";
        const text = e => (e.innerText || e.textContent || "").replace(/\s+/g, " ").trim();
        const host = location.hostname;
        const emailField = document.querySelector("input#signInName");
        const passwordField = document.querySelector("input#password[type=password]");
        const submit = document.querySelector("button#continue");
        const welcome = document.querySelector("#welcome-menu-open-close-button");
        const errors = [...new Set([...document.querySelectorAll(".error.pageLevel, .error.itemLevel, [role=alert]")].filter(visible).map(text).filter(Boolean))];
        const challengePattern = /access denied|verify (?:that )?you(?:'re| are) (?:a )?human|security check|checking your browser|unusual (?:traffic|activity)|pardon our interruption|press (?:and|&) hold|reference #/i;
        const challengeText = [...document.querySelectorAll("h1,h2,h3,[role=alert],[role=dialog]")].filter(visible).map(text).find(t => challengePattern.test(t))
          || (challengePattern.test(document.title) ? document.title : null);
        const challengeFrame = [...document.querySelectorAll("iframe")].filter(visible).find(e => {
          const r = e.getBoundingClientRect();
          return r.width > 100 && r.height > 60 && /captcha|challenge|turnstile|awswaf|perimeterx|arkose/i.test((e.title || "") + " " + (e.src || ""));
        });
        const codeField = [...document.querySelectorAll("input")].find(e => visible(e) && !/password|checkbox|hidden|submit|radio/.test(e.type)
          && /one-time-code|(?:^|[^a-z])(?:otp|code|passcode)/i.test([e.autocomplete, e.id, e.name, e.getAttribute("aria-label"), e.placeholder].join(" ")));
        const codeHint = codeField ? [...document.querySelectorAll("p,div,span,label,h1,h2,h3")].filter(visible).map(text)
          .find(t => t.length < 300 && /(?:sent|emailed|texted).{0,80}code|verification code|enter (?:the|your) code/i.test(t)) || null : null;
        return {
          url: location.href, host,
          onSite: location.protocol === "https:" && (host === "kroger.com" || host.endsWith(".kroger.com")),
          loginHost: host === "login.kroger.com",
          formVisible: visible(emailField) && visible(passwordField) && visible(submit),
          submitEnabled: !!submit && !submit.disabled && submit.getAttribute("aria-disabled") !== "true",
          emailValue: emailField ? emailField.value.trim().toLowerCase() : "",
          passwordLength: passwordField ? passwordField.value.length : 0,
          welcomeText: visible(welcome) ? text(welcome) : null,
          errors,
          challenge: challengeText || (challengeFrame ? "Visible challenge frame: " + (challengeFrame.title || challengeFrame.src.slice(0, 80)) : null),
          codeStep: !!codeField && !visible(passwordField),
          codeHint
        };
      });
      let loggedInCookie = false;
      let accountEmail = null;
      try {
        const { cookies } = await cdp("Network.getCookies", { urls: ["https://www.kroger.com/"] });
        loggedInCookie = cookies.some(c => c.name === "loggedIn" && c.value === "yes");
        // The customer data token is a JWT whose payload names the signed-in account.
        const payload = cookies.find(c => c.name === "kroger-si-customer-data-token")?.value.split(".")[1];
        if (payload) accountEmail = String(JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/"))).emailAddress || "").trim().toLowerCase() || null;
      } catch { /* Cookies confirm the header; they never decide on their own. */ }
      page.loggedInCookie = loggedInCookie;
      page.accountEmail = accountEmail;
      page.signedIn = page.onSite && !page.loginHost && loggedInCookie && !!page.welcomeText && !/^sign in$/i.test(page.welcomeText);
      return page;
    };
    let latest = null;
    const poll = async (predicate, ms) => {
      const deadline = Date.now() + Math.min(ms, remaining());
      while (Date.now() < deadline) {
        try {
          latest = await read();
          if (predicate(latest)) return latest;
        } catch { /* Navigation replaces the execution context; only the read is retried. */ }
        await waitMs(500);
      }
      return null;
    };
    const succeed = state => {
      if (state.accountEmail && state.accountEmail !== account) {
        step = "account_check";
        return fail("unknown", "The browser is signed in to a different Kroger account than the supplied email. Sign out of that account before invoking this tool; nothing was submitted for the supplied email.");
      }
      return {
        logged_in: true, authenticated: true, mfa_required: false, next_step: "none",
        landing_url: state.url, account_name_or_hint: state.welcomeText,
        account_check: state.accountEmail ? "email_confirmed" : "unverified",
        entry_path: entryPath, submission_attempted: submitted,
        evidence: "loggedIn cookie present and header welcome button shows " + state.welcomeText + (state.accountEmail ? "; customer data token names the supplied email" : "; no customer data token to confirm the email")
      };
    };
    const codePending = state => ({
      logged_in: true, authenticated: false, mfa_required: true, next_step: "enter_otp",
      landing_url: state.url, account_name_or_hint: state.codeHint, account_check: "unverified",
      entry_path: entryPath, submission_attempted: submitted,
      evidence: state.codeHint || "A verification-code field is visible and the password field is not."
    });
    const blockedBefore = state => {
      if (!state.onSite) return fail("unknown", "The browser is not on kroger.com; the flow stopped without submitting.");
      if (state.challenge) return fail("captcha_or_challenge", state.challenge, "site");
      const text = state.errors.join("\n");
      const kind = text ? classify(text) : null;
      if (kind === "locked_or_throttled" || kind === "captcha_or_challenge") return fail(kind, text, "site");
      return null;
    };
    const markerKey = "kroger.com.login.submission.v1";
    const settle = async () => {
      try { await js(key => sessionStorage.setItem(key, JSON.stringify({ state: "concluded", at: Date.now() })), { arg: markerKey }); } catch { /* Navigation may have replaced the page. */ }
    };
    const observe = async (state, deadlineMs) => {
      step = "after_submit";
      const prior = JSON.stringify(state.errors);
      let sawCleared = state.errors.length === 0;
      let challenge = null;
      const windowMs = Math.min(deadlineMs, remaining());
      const deadline = Date.now() + windowMs;
      while (Date.now() < deadline) {
        await waitMs(500);
        let current;
        try { current = await read(); } catch { continue; }
        if (!current.onSite) return fail("unknown", "The browser left kroger.com after the submission; the outcome is unconfirmed. Inspect the page before any further attempt.");
        if (current.challenge) { challenge = current.challenge; continue; }
        if (current.signedIn) return succeed(current);
        if (current.loginHost && current.codeStep && !otpMode) { await settle(); return codePending(current); }
        if (!current.errors.length) sawCleared = true;
        else if (current.loginHost && (sawCleared || JSON.stringify(current.errors) !== prior)) {
          const text = current.errors.join("\n");
          await settle();
          const kind = classify(text);
          return fail(otpMode && kind === "invalid_credentials" ? "mfa_failed" : kind, text, "site");
        }
      }
      if (challenge) return fail("captcha_or_challenge", challenge, "site");
      return fail("unknown", "No conclusive sign-in result within " + Math.round(windowMs / 1000) + " seconds; the submission may have reached Kroger. Inspect the browser before any further attempt.");
    };
    const submitForm = async (armSelector, submitSelector) => {
      if (remaining() < 20000) return fail("unknown", "Fewer than 20 seconds of the 110-second invocation budget remain, which is not enough to observe a submission; nothing was submitted.");
      const armed = await js(({ key, selector }) => {
        if (location.hostname !== "login.kroger.com") return "origin";
        const button = document.querySelector(selector);
        if (!button || button.disabled || button.getAttribute("aria-disabled") === "true" || !button.getClientRects().length) return "button";
        let prior = null;
        try { prior = JSON.parse(sessionStorage.getItem(key) || "null"); } catch { /* Treat unreadable markers as absent. */ }
        if (prior && prior.state === "pending" && Date.now() - prior.at < 15 * 60 * 1000) return "already_attempted";
        sessionStorage.setItem(key, JSON.stringify({ state: "pending", at: Date.now() }));
        return "armed";
      }, { arg: { key: markerKey, selector: armSelector } });
      if (armed === "already_attempted") return fail("unknown", "This tab already submitted the sign-in form within the last 15 minutes without a conclusive result; a second submission is blocked. Inspect the page or use a new tab.");
      if (armed !== "armed") return fail("unknown", armed === "origin" ? "The page left login.kroger.com before submission; nothing was submitted." : "The submit control is missing or disabled; nothing was submitted.");
      submitted = true;
      await click(submitSelector);
      return null;
    };
    const openFromHeader = async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        const opened = await js(() => {
          const welcome = document.querySelector("#welcome-menu-open-close-button");
          if (!welcome || !welcome.getClientRects().length || !/^sign in$/i.test(welcome.textContent.trim())) return false;
          welcome.click();
          return true;
        });
        if (!opened) return false;
        for (let i = 0; i < 6; i++) {
          await waitMs(500);
          const clicked = await js(() => {
            const button = document.querySelector("#welcome-menu-sign-in-out-button");
            if (!button || !button.getClientRects().length || !/^sign in$/i.test(button.textContent.trim())) return false;
            button.click();
            return true;
          });
          if (clicked) return true;
        }
      }
      return false;
    };

    try {
      step = "login_form";
      let state = await read();
      // The header renders after the loggedIn cookie is readable; give it time before entering the site again.
      if (!state.signedIn && state.onSite && !state.loginHost && state.loggedInCookie) state = (await poll(s => s.signedIn || s.formVisible, 10000)) || latest;
      if (state.signedIn) {
        entryPath = "already_signed_in";
        return succeed(state);
      }
      entryPath = "already_open";
      if (otpMode) {
        const blocked = blockedBefore(state);
        if (blocked) return blocked;
        if (!state.loginHost || !state.codeStep) return fail("unknown", "No verification-code step is visible on login.kroger.com; otp mode submits only a code that the site is already asking for. Nothing was submitted.");
        step = "before_submit";
        const pasted = await js(code => {
          const visible = e => !!e && e.getClientRects().length > 0;
          const field = [...document.querySelectorAll("input")].find(e => visible(e) && !/password|checkbox|hidden|submit|radio/.test(e.type)
            && /one-time-code|(?:^|[^a-z])(?:otp|code|passcode)/i.test([e.autocomplete, e.id, e.name, e.getAttribute("aria-label"), e.placeholder].join(" ")));
          if (!field) return false;
          field.focus();
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(field, code);
          field.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
          field.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
          const button = [...document.querySelectorAll("button, input[type=submit]")].find(e => visible(e) && /verify|continue|submit|sign in/i.test(e.textContent || e.value || ""));
          if (!button) return false;
          document.querySelectorAll("[data-kroger-login-code-submit]").forEach(e => e.removeAttribute("data-kroger-login-code-submit"));
          button.setAttribute("data-kroger-login-code-submit", "true");
          return field.value.length === code.length;
        }, { arg: otp });
        if (!pasted) return fail("unknown", "The verification-code field or its submit control could not be prepared; nothing was submitted.");
        const blockedSubmit = await submitForm("[data-kroger-login-code-submit]", "[data-kroger-login-code-submit]");
        if (blockedSubmit) return blockedSubmit;
        return observe(state, 45000);
      }
      if (!(state.loginHost && state.formVisible)) {
        step = "search_entry";
        entryPath = "search_referrer";
        await gotoUrl("https://start.duckduckgo.com/");
        let query, search;
        const controlsWindow = Math.min(20000, remaining());
        const controlsDeadline = Date.now() + controlsWindow;
        while (Date.now() < controlsDeadline) {
          const snapshot = await accessibilitySnapshot();
          query = snapshot.nodes.find(n => ["combobox", "textbox", "searchbox"].includes(n.role) && n.name === "Search with DuckDuckGo");
          search = snapshot.nodes.find(n => n.role === "button" && n.name === "Search");
          if (query && search) break;
          await waitMs(500);
        }
        if (!query || !search) return fail("unknown", "search_controls_unavailable: the DuckDuckGo search box did not appear within " + Math.round(controlsWindow / 1000) + " seconds; nothing was submitted.");
        await fillInput({ backendNodeId: query.backendNodeId }, "kroger login");
        await click({ backendNodeId: search.backendNodeId });
        const resultsWindow = Math.max(1, Math.min(20, Math.floor(remaining() / 1000)));
        const listed = await waitForElement('article[data-testid="result"] a[data-testid="result-title-a"]', { timeoutSec: resultsWindow });
        const results = await js(() => {
          const blocked = /unusual traffic|verify (?:that )?you(?:'re| are) human|are you a robot|bots use DuckDuckGo|select all squares/i.test((document.body?.innerText || "").slice(0, 4000));
          document.querySelectorAll("[data-kroger-login-entry]").forEach(e => e.removeAttribute("data-kroger-login-entry"));
          const first = document.querySelector('article[data-testid="result"] a[data-testid="result-title-a"]');
          let host = null, href = null;
          if (first && !first.closest('[data-testid="ad"], [data-layout="ad"]')) {
            try {
              const url = new URL(first.href);
              if (url.protocol === "https:") { host = url.hostname; href = url.href; first.setAttribute("data-kroger-login-entry", "true"); }
            } catch { /* An unparsable href is treated as missing. */ }
          }
          return { origin: location.origin, blocked, host, href };
        });
        if (!["https://duckduckgo.com", "https://start.duckduckgo.com"].includes(results.origin)) return fail("unknown", "search_origin_unexpected: the search left DuckDuckGo; nothing was submitted.");
        if (results.blocked) return fail("captcha_or_challenge", "DuckDuckGo challenged this session before any Kroger request was made; nothing was submitted.", "site");
        if (!listed || !results.href) return fail("unknown", "search_result_missing: no organic result was listed for kroger login within " + resultsWindow + " seconds; nothing was submitted.");
        if (!(results.host === "kroger.com" || results.host.endsWith(".kroger.com"))) return fail("unknown", "search_result_unapproved: the first organic result points at " + results.host + ", not kroger.com; nothing was submitted.");
        step = "site_entry";
        await click('a[data-kroger-login-entry="true"]');
        const landingWindow = Math.min(30000, remaining());
        state = await poll(s => s.challenge || (s.onSite && (s.formVisible || s.signedIn || !!s.welcomeText)), landingWindow);
        if (!state) return fail("unknown", "site_entry_failed: the organic result did not land on a usable kroger.com page within " + Math.round(landingWindow / 1000) + " seconds; nothing was submitted.");
        const blockedEntry = blockedBefore(state);
        if (blockedEntry) return blockedEntry;
        if (state.signedIn) return succeed(state);
        if (!(state.loginHost && state.formVisible)) {
          step = "login_form";
          entryPath = "site_navigation";
          if (!await openFromHeader()) return fail("unknown", "sign_in_control_missing: the site header did not offer a Sign In control; nothing was submitted.");
          const formWindow = Math.min(30000, remaining());
          state = await poll(s => s.challenge || (s.loginHost && s.formVisible) || s.signedIn, formWindow);
          if (!state) return fail("unknown", "login_form_unavailable: the login.kroger.com sign-in form did not appear within " + Math.round(formWindow / 1000) + " seconds; nothing was submitted.");
          const blockedForm = blockedBefore(state);
          if (blockedForm) return blockedForm;
          if (state.signedIn) return succeed(state);
        }
      }
      step = "before_submit";
      const blocked = blockedBefore(state);
      if (blocked) return blocked;
      if (!(state.loginHost && state.formVisible)) return fail("unknown", "The login.kroger.com sign-in form is not visible; nothing was submitted.");
      await fillInput("input#signInName", email.trim());
      await fillInput("input#password[type=password]", password);
      const prepared = await js(keep => {
        const remember = document.querySelector("#kr_remember_me_adi_true");
        if (remember && remember.checked !== keep) remember.click();
        return remember ? remember.checked === keep : true;
      }, { arg: keepSignedIn });
      state = await read();
      if (!(state.loginHost && state.formVisible)) return fail("unknown", "The sign-in form disappeared while it was being filled; nothing was submitted.");
      if (state.challenge) return fail("captcha_or_challenge", state.challenge, "site");
      if (state.emailValue !== account || state.passwordLength !== password.length || !prepared) return fail("unknown", "The form did not receive the exact credentials supplied; nothing was submitted.");
      if (!state.submitEnabled) return fail("unknown", "The Sign In button is disabled; nothing was submitted.");
      const blockedSubmit = await submitForm("button#continue", "button#continue");
      if (blockedSubmit) return blockedSubmit;
      return observe(state, 45000);
    } catch {
      return fail("unknown", submitted
        ? "Browser interaction failed after the submission started; the outcome is unknown. Inspect the page before any further attempt."
        : "Browser interaction failed during step " + step + "; nothing was submitted.");
    }
  }
}]
