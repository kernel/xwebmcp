[{
  kind: "cdp",
  match: { url_patterns: ["https://ubereats.com/*", "https://*.ubereats.com/*", "https://auth.uber.com/*"] },
  tool: {
    name: "login",
    description: "Sign in to Uber Eats with an email address, one step per invocation. Uber's sign-in is email first: submitting the email either sends a 4-digit code to that inbox (next_step=enter_email_code) or, for accounts with a password, opens a method chooser and password step (next_step=enter_password). After the password Uber texts a 4-digit code to the account's phone (next_step=enter_sms_code). Every code step returns logged_in=true with mfa_required=true, and calling again with otp completes it. Enters the site through a DuckDuckGo search for the login page and the site's own Log in link; an already signed-in session for the same email returns success without submitting anything. At most one submission per step, never retries, and never solves challenges.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        email: { type: "string", minLength: 3, maxLength: 320, pattern: "^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$", description: "Account email address. Phone-number sign-in is not supported." },
        password: { type: "string", minLength: 1, maxLength: 1024, description: "Submitted only on Uber's password step; never returned or logged. Prefer use_prefilled_password with a secure vault fill." },
        use_prefilled_password: { type: "boolean", description: "Submit the password step after a human or vault securely filled it; the value is never read back. Not combinable with password." },
        otp: { type: "string", pattern: "^[0-9]{4}$", description: "The current 4-digit code Uber emailed or texted; completes an already visible code step for the same account." }
      },
      required: ["email"],
      not: { required: ["password", "use_prefilled_password"] }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false,
          required: ["logged_in", "authenticated", "mfa_required", "next_step", "landing_url", "account_hint", "evidence", "submission_attempted"],
          properties: {
            logged_in: { const: true },
            authenticated: { type: "boolean" },
            mfa_required: { type: "boolean" },
            next_step: { enum: ["none", "enter_email_code", "enter_sms_code", "enter_password"] },
            landing_url: { type: "string", format: "uri" },
            account_hint: { type: ["string", "null"] },
            evidence: { type: "string", minLength: 1 },
            submission_attempted: { type: "boolean" }
          },
          oneOf: [
            { properties: { authenticated: { const: true }, mfa_required: { const: false }, next_step: { const: "none" } } },
            { properties: { authenticated: { const: false }, mfa_required: { const: true }, next_step: { enum: ["enter_email_code", "enter_sms_code"] } } },
            { properties: { authenticated: { const: false }, mfa_required: { const: false }, next_step: { const: "enter_password" } } }
          ]
        },
        {
          type: "object", additionalProperties: false,
          required: ["logged_in", "error_kind", "error_message", "step", "attempts_remaining", "submission_attempted"],
          properties: {
            logged_in: { const: false },
            error_kind: { enum: ["invalid_input", "invalid_credentials", "captcha_or_challenge", "mfa_failed", "locked_or_throttled", "unknown"] },
            error_message: { type: "string", minLength: 1 },
            step: { enum: ["input", "search_entry", "site_entry", "open_login", "email", "choose_method", "code", "password", "verify"] },
            attempts_remaining: { type: ["integer", "null"], minimum: 0 },
            submission_attempted: { type: "boolean" }
          }
        }
      ]
    },
    annotations: { destructiveHint: false, readOnlyHint: false }
  },
  execute: async (input) => {
    let submitted = false;
    let step = "input";
    const fail = (kind, message) => {
      const remaining = message.match(/(\d+)\s+(?:more\s+)?attempts?\s+(?:remaining|left)/i);
      return { logged_in: false, error_kind: kind, error_message: message, step, attempts_remaining: remaining ? Number(remaining[1]) : null, submission_attempted: submitted };
    };
    if (!input || typeof input !== "object" || Array.isArray(input)) return fail("invalid_input", "Input must be an object with an email; nothing submitted.");
    if (Object.keys(input).some(k => !["email", "password", "use_prefilled_password", "otp"].includes(k))) return fail("invalid_input", "Unrecognized input field; nothing submitted.");
    if (typeof input.email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email.trim()) || input.email.trim().length > 320) return fail("invalid_input", "email must be an email address; nothing submitted.");
    if (input.password !== undefined && (typeof input.password !== "string" || !input.password.length || input.password.length > 1024)) return fail("invalid_input", "password must be a non-empty string; nothing submitted.");
    if (input.use_prefilled_password !== undefined && typeof input.use_prefilled_password !== "boolean") return fail("invalid_input", "use_prefilled_password must be boolean; nothing submitted.");
    if (input.password !== undefined && input.use_prefilled_password === true) return fail("invalid_input", "Do not combine password with use_prefilled_password; nothing submitted.");
    if (input.otp !== undefined && (typeof input.otp !== "string" || !/^[0-9]{4}$/.test(input.otp))) return fail("invalid_input", "otp must be the 4-digit code Uber sent; nothing submitted.");
    const email = input.email.trim().toLowerCase();
    const hasPassword = !!input.password || input.use_prefilled_password === true;
    const searchOrigins = ["https://duckduckgo.com", "https://start.duckduckgo.com"];
    const markerKey = "webmcp.ubereats.login";

    const read = async () => js(() => {
      const visible = e => !!e && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== "hidden";
      const onScreen = e => {
        if (!visible(e)) return false;
        const r = e.getBoundingClientRect();
        return r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight;
      };
      const text = e => (e.innerText || e.textContent || "").replace(/\s+/g, " ").trim();
      const all = selector => [...document.querySelectorAll(selector)].filter(visible);
      const host = location.hostname;
      const onSite = location.protocol === "https:" && (host === "ubereats.com" || host.endsWith(".ubereats.com"));
      const onAuth = location.protocol === "https:" && host === "auth.uber.com";
      const emailField = document.querySelector("#PHONE_NUMBER_or_EMAIL_ADDRESS");
      const emailCodeBoxes = all('input[id^="EMAIL_OTP_CODE-"]');
      const smsCodeBoxes = all('input[id^="PHONE_SMS_OTP-"]');
      const codeBoxes = emailCodeBoxes.length ? emailCodeBoxes : smsCodeBoxes;
      const passwordField = all('input[type="password"]')[0] || null;
      const forward = document.querySelector("#forward-button");
      const headings = all("h1,h2,h3,label").map(text);
      const emailIn = t => t ? (t.match(/[^\s@:]+@[^\s@]+\.[^\s@.]+/) || [null])[0] : null;
      // The email code step names the inbox; the SMS step only shows a masked phone number.
      const codeFor = emailCodeBoxes.length ? emailIn(headings.find(t => /code sent to you at/i.test(t)) || null) : null;
      const smsHint = smsCodeBoxes.length ? (all("h1,h2,h3,label,p").map(text).map(t => t.match(/sent via SMS (?:at|to)\s+(\S+?)\.?$/i)).find(Boolean) || [null, null])[1] : null;
      // Accounts with a linked social login get a "Welcome back" chooser instead of an immediate code step.
      const chooserFor = !passwordField && !codeBoxes.length ? emailIn(headings.find(t => /welcome back/i.test(t) && /@/.test(t)) || null) : null;
      const option = id => visible(document.getElementById(id));
      const errors = [...new Set(all('[role="alert"], [data-testid="inline_error"]').map(text).map(t => t.replace(/^Error:\s*/i, "")).filter(Boolean))];
      const challengeFrame = all("iframe").find(e => {
        const r = e.getBoundingClientRect();
        return r.width > 100 && r.height > 60 && /captcha|arkose|funcaptcha|challenge|turnstile/i.test((e.title || "") + " " + (e.src || ""));
      });
      const challengeText = [...headings, ...all("p,div").map(text).filter(t => t.length && t.length <= 200)].find(t => /verify (?:that )?you(?:'re| are) (?:a )?human|are you a robot|unusual (?:activity|traffic)|access denied|security check|complete the (?:captcha|puzzle)|press (?:and|&) hold/i.test(t));
      const authLinks = onSite ? [...document.querySelectorAll('header a[href^="https://auth.uber.com/"]')].filter(onScreen) : [];
      const loginLink = authLinks.find(e => /^log in$/i.test(text(e))) || null;
      document.querySelectorAll("[data-webmcp-login-link]").forEach(e => e.removeAttribute("data-webmcp-login-link"));
      if (loginLink) loginLink.setAttribute("data-webmcp-login-link", "true");
      const menu = onSite ? document.querySelector('header button[data-testid="menu-button"], header button[aria-label="Main navigation menu"]') : null;
      const accountText = onSite ? [...document.querySelectorAll("header a, header button, header span, header div")].filter(onScreen).map(text).find(t => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t) || /^(?:hi|hello|welcome),?\s+\S+/i.test(t)) || null : null;
      const proxyError = /proxy error/i.test(document.title) || /provider_unreachable/.test((document.body?.innerText || "").slice(0, 2000));
      return {
        url: location.href, host, onSite, onAuth, ready: document.readyState === "complete", proxyError,
        emailStep: visible(emailField), emailValue: emailField ? emailField.value.trim().toLowerCase() : "",
        codeCount: codeBoxes.length, codeFilled: codeBoxes.every(e => e.value.length === 1), codeFor, smsCode: !emailCodeBoxes.length && smsCodeBoxes.length > 0, smsHint,
        passwordStep: !!passwordField, passwordLength: passwordField ? passwordField.value.length : 0, passwordFor: passwordField ? emailIn(headings.find(t => /@/.test(t))) : null,
        chooserFor, moreOptions: option("alt-action-help-v2"), seeAllOptions: option("alt-more-options-modal-see-all-options"),
        passwordOption: option("alt-more-options-modal-password"), emailOption: option("alt-more-options-modal-email"),
        forwardEnabled: visible(forward) && !forward.disabled && forward.getAttribute("aria-disabled") !== "true",
        errors, feedbackFresh: !window.__ueLoginWatch || window.__ueLoginWatch.changed,
        challenge: challengeText || (challengeFrame ? (challengeFrame.title || "Visible challenge frame") : null),
        loginLink: !!loginLink, menu: !!menu, accountText
      };
    });
    const sessionCookie = async () => {
      const { cookies } = await cdp("Network.getCookies", { urls: ["https://www.ubereats.com/", "https://auth.uber.com/"] });
      return cookies.some(c => c.name === "sid" && /(?:^|\.)uber(?:eats)?\.com$/.test(c.domain) && c.value.length > 20);
    };
    // One sessionStorage marker per stage records the last submission for this email in this tab, so a
    // re-invocation can neither submit a stage twice nor lose track of an earlier stage.
    const marker = async (stage, write) => js(({ key, email, write }) => {
      let current = null;
      try { current = JSON.parse(sessionStorage.getItem(key) || "null"); } catch { current = null; }
      if (write) sessionStorage.setItem(key, JSON.stringify({ email, at: Date.now() }));
      return current && current.email === email ? Date.now() - current.at : null;
    }, { arg: { key: markerKey + "." + stage, email, write } });
    // Feedback left over from an earlier attempt is not this attempt's verdict: a watcher armed before each
    // submission marks the alert region as changed, and only changed feedback is classified afterwards.
    const arm = async () => js(() => {
      window.__ueLoginWatch?.cleanup();
      const selector = '[role="alert"], [data-testid="inline_error"]';
      const relevant = node => node.nodeType === 1 ? !!node.closest(selector) || !!node.querySelector(selector) : !!node.parentElement?.closest(selector);
      const watch = { changed: false };
      const observer = new MutationObserver(records => {
        if (records.some(r => relevant(r.target) || [...r.addedNodes, ...r.removedNodes].some(relevant))) watch.changed = true;
      });
      watch.cleanup = () => { observer.disconnect(); delete window.__ueLoginWatch; };
      window.__ueLoginWatch = watch;
      observer.observe(document.body, { subtree: true, childList: true, characterData: true });
    });
    const disarm = async () => { try { await js(() => window.__ueLoginWatch?.cleanup()); } catch { /* the page may have navigated away */ } };
    const blocking = s => {
      if (s.proxyError) return fail("unknown", "The browser's proxy could not reach " + s.host + " (proxy error page); nothing submitted.");
      if (s.challenge) return fail("captcha_or_challenge", s.challenge);
      const locked = s.errors.find(t => /too many|locked|temporarily (?:blocked|suspended)|try again (?:later|in)|rate limit|suspended/i.test(t));
      return locked ? fail("locked_or_throttled", locked) : null;
    };
    const classify = s => {
      if (s.challenge) return fail("captcha_or_challenge", s.challenge);
      if (!s.errors.length || !s.feedbackFresh) return null;
      const message = s.errors.join("\n");
      if (/too many|locked|temporarily (?:blocked|suspended)|try again (?:later|in)|rate limit|suspended/i.test(message)) return fail("locked_or_throttled", message);
      if (/captcha|robot|human verification|verify (?:that )?you/i.test(message)) return fail("captcha_or_challenge", message);
      if (s.codeCount || /(?:code|passcode|otp).*(?:incorrect|invalid|expired|wrong)|(?:incorrect|invalid|expired|wrong).*(?:code|passcode|otp)/i.test(message)) return fail("mfa_failed", message);
      if (/incorrect|invalid|wrong|not match|doesn't match|no account|not found|unable to (?:sign|log) in/i.test(message)) return fail("invalid_credentials", message);
      return fail("unknown", message);
    };
    const loggedIn = async s => s.onSite && !s.loginLink && s.menu && await sessionCookie();
    const success = (s, next, evidence) => ({
      logged_in: true, authenticated: next === "none", mfa_required: next === "enter_email_code" || next === "enter_sms_code", next_step: next,
      landing_url: s.url, account_hint: next === "enter_email_code" ? s.codeFor : next === "enter_sms_code" ? s.smsHint : s.accountText, evidence, submission_attempted: submitted
    });
    // Steps that do not repeat the email (password, SMS code) are bound to the account through this tab's
    // own markers: Uber only reaches them after this tool submitted the email or password for it.
    const identifiedRecently = async () => {
      for (const stage of ["email", "password"]) {
        const age = await marker(stage, false);
        if (age !== null && age < 30 * 60000) return true;
      }
      return false;
    };
    const smsStep = async s => s.onAuth && s.codeCount === 4 && s.smsCode && await identifiedRecently();
    const smsSuccess = s => success(s, "enter_sms_code", "Uber texted a 4-digit code to " + (s.smsHint || "the account's phone") + "; obtain it from the account owner and call again with otp.");
    // The user endpoint exposes only a SHA-256 of the account email, which is enough to confirm the account
    // without reading the address back.
    const accountMatches = async () => js(async ({ email }) => {
      const res = await fetch("/_p/api/getUserV1?localeCode=en-US", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", "x-csrf-token": "x" }, body: "{}" });
      const user = ((await res.json()) || {}).data || {};
      if (!user.isLoggedIn || typeof user.hashedEmail !== "string" || user.hashedEmail.length !== 64) return null;
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(email));
      return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("") === user.hashedEmail.toLowerCase();
    }, { arg: { email } });
    const authenticated = async s => {
      if (s.accountText && /@/.test(s.accountText) && s.accountText.toLowerCase() !== email) return fail("unknown", "The site is signed in as a different account (" + s.accountText + "); nothing submitted for the requested email. Sign out first.");
      let match = null;
      try { match = await accountMatches(); } catch { match = null; }
      if (match === false) return fail("unknown", "The site is signed in as a different account than the requested email; nothing submitted. Sign out first.");
      return success(s, "none", match ? "The session is signed in and the site's hashed account email matches the requested email." : "Uber Eats header shows no Log in link, the navigation menu is present, and a session cookie exists.");
    };
    const poll = async (predicate, seconds) => {
      const deadline = Date.now() + seconds * 1000;
      let last = null;
      while (Date.now() < deadline) {
        try {
          last = await read();
          if (await predicate(last)) return last;
        } catch {
          // Navigation replaces the execution context between steps; only the read is retried.
        }
        await waitMs(500);
      }
      return null;
    };
    const freshError = s => s.errors.length > 0 && s.feedbackFresh;
    const settled = async s => !!s.challenge || freshError(s) || (s.onAuth && (s.passwordStep || !!s.chooserFor || (s.codeCount === 4 && (!!s.codeFor || s.smsCode)))) || await loggedIn(s);
    const chooseMethod = async s => {
      step = "choose_method";
      if (s.chooserFor.toLowerCase() !== email) return fail("unknown", "Uber's sign-in chooser belongs to " + s.chooserFor + ", not the requested email; nothing submitted.");
      const wanted = hasPassword ? "passwordOption" : "emailOption";
      const id = hasPassword ? "alt-more-options-modal-password" : "alt-more-options-modal-email";
      if (!s[wanted]) {
        if (!s.seeAllOptions) {
          if (!s.moreOptions) return fail("unknown", "Uber's sign-in chooser offers no More options control; nothing submitted.");
          await click("#alt-action-help-v2");
          s = await poll(async x => x[wanted] || x.seeAllOptions || !!x.challenge, 10);
        }
        if (s && !s[wanted] && s.seeAllOptions) {
          await click("#alt-more-options-modal-see-all-options");
          s = await poll(async x => x[wanted] || !!x.challenge, 10);
        }
        if (!s || !s[wanted]) return fail("unknown", "Uber's sign-in chooser does not offer the " + (hasPassword ? "Password" : "Email") + " method; nothing submitted.");
      }
      await click("#" + id);
      const next = await poll(async x => !!x.challenge || freshError(x) || ((await settled(x)) && !x.chooserFor), 20);
      return await finish(next, "Choosing the " + (hasPassword ? "Password" : "Email") + " method did not open its step within 20 seconds; nothing submitted.");
    };
    const submitPassword = async s => {
      step = "password";
      if (s.passwordFor && s.passwordFor.toLowerCase() !== email) return fail("unknown", "The password step belongs to " + s.passwordFor + ", not the requested email; nothing submitted.");
      if (!hasPassword) return success(s, "enter_password", "Uber asks for the account password; call again with password, or securely fill the visible password field and call again with use_prefilled_password.");
      if (input.use_prefilled_password && !s.passwordLength) return success(s, "enter_password", "Uber's password step is open and empty; securely fill the password field, then call again with use_prefilled_password.");
      const guard = await marker("password", false);
      if (guard !== null && guard < 60000) return fail("unknown", "A password was already submitted from this tab less than a minute ago; inspect the browser before submitting again.");
      if (input.password) await fillInput('input[type="password"]', input.password);
      const filled = x => input.password ? x.passwordLength === input.password.length : x.passwordLength > 0;
      const before = await poll(async x => x.passwordStep && filled(x) && x.forwardEnabled, 10);
      if (!before) return fail("unknown", "The password field or its submit control was not ready; password not submitted.");
      const blocked = blocking(before);
      if (blocked) return blocked;
      await marker("password", true);
      await arm();
      submitted = true;
      await click("#forward-button");
      const after = await poll(async x => !!x.challenge || freshError(x) || ((await settled(x)) && !x.passwordStep), 45);
      return await finish(after, "The password submission produced no recognizable result within 45 seconds; inspect the browser before any retry.");
    };
    const submitEmail = async s => {
      step = "email";
      const guard = await marker("email", false);
      if (guard !== null && guard < 15 * 60000) return fail("unknown", "A code was already requested for this email from this tab in the last 15 minutes; call again with otp instead of requesting another code.");
      await fillInput("#PHONE_NUMBER_or_EMAIL_ADDRESS", email);
      // Uber renders Continue disabled for about a second after the step appears, so readiness is polled.
      const ready = await poll(async x => x.emailStep && x.emailValue === email && x.forwardEnabled, 10);
      if (!ready) {
        s = await read();
        return fail("unknown", s.emailValue !== email ? "The email field did not accept the supplied address; nothing submitted." : "The Continue control did not become enabled within 10 seconds; nothing submitted.");
      }
      s = ready;
      const preSubmit = blocking(s);
      if (preSubmit) return preSubmit;
      await marker("email", true);
      await arm();
      submitted = true;
      await click("#forward-button");
      const after = await poll(async x => !!x.challenge || freshError(x) || ((await settled(x)) && !x.emailStep), 45);
      return await finish(after, "Submitting the email produced no recognizable result within 45 seconds; inspect the browser before any retry.");
    };
    const finish = async (s, timeoutMessage) => {
      if (!s) return fail("unknown", timeoutMessage);
      const outcome = classify(s);
      if (outcome) return outcome;
      if (await loggedIn(s)) return await authenticated(s);
      if (s.onAuth && s.passwordStep) return await submitPassword(s);
      if (s.onAuth && s.chooserFor) return await chooseMethod(s);
      if (s.onAuth && s.codeCount === 4 && s.codeFor) {
        if (s.codeFor.toLowerCase() !== email) return fail("unknown", "The code step shown belongs to " + s.codeFor + ", not the requested email; nothing further submitted.");
        return success(s, "enter_email_code", "Uber shows the 4-digit code step for " + s.codeFor + ".");
      }
      if (await smsStep(s)) return smsSuccess(s);
      step = "verify";
      return fail("unknown", "No recognizable authenticated, code, password, or error state was reached; inspect the browser before any retry.");
    };

    try {
      let s = await read();
      if (input.otp) {
        step = "code";
        const blocked = blocking(s);
        if (blocked) return blocked;
        if (!s.onAuth || s.codeCount !== 4 || !(s.codeFor || s.smsCode)) return fail("invalid_input", "No visible 4-digit code step; request a code first by calling without otp. Nothing submitted.");
        if (s.codeFor && s.codeFor.toLowerCase() !== email) return fail("invalid_input", "The visible code step belongs to " + s.codeFor + ", not the requested email; nothing submitted.");
        if (!s.codeFor && !await smsStep(s)) return fail("invalid_input", "The visible SMS code step was not reached through this tool for the requested email; nothing submitted.");
        const guard = await marker("code", false);
        if (guard !== null && guard < 20000) return fail("unknown", "A code was submitted from this tab less than 20 seconds ago; wait for that result instead of resubmitting.");
        await marker("code", true);
        await arm();
        submitted = true;
        // Each typed digit advances to the next box and the fourth digit submits the form on its own.
        await fillInput(s.codeFor ? 'input[id="EMAIL_OTP_CODE-0"]' : 'input[id="PHONE_SMS_OTP-0"]', input.otp);
        await waitMs(1500);
        const typed = await read();
        if (typed.onAuth && typed.codeCount === 4 && typed.codeFilled && typed.forwardEnabled && !freshError(typed) && !typed.challenge) await click("#forward-button");
        const after = await poll(async x => (await settled(x)) && !(x.codeCount === 4 && !freshError(x)), 45);
        return await finish(after, "The code submission produced no recognizable result within 45 seconds; inspect the browser before any retry.");
      }

      if (await loggedIn(s)) return await authenticated(s);
      if (s.onAuth && s.codeCount === 4 && s.codeFor && s.codeFor.toLowerCase() === email) {
        return success(s, "enter_email_code", "A 4-digit code step for " + s.codeFor + " is already open; call again with otp instead of requesting another code.");
      }
      if (await smsStep(s)) return smsSuccess(s);
      // Resume a flow that already identified this account instead of requesting entry again.
      if (s.onAuth && s.chooserFor && s.chooserFor.toLowerCase() === email) return await chooseMethod(s);
      if (s.onAuth && s.passwordStep && (s.passwordFor ? s.passwordFor.toLowerCase() === email : await identifiedRecently())) return await submitPassword(s);
      if (s.onAuth && s.emailStep) return await submitEmail(s);

      step = "search_entry";
      await gotoUrl("https://start.duckduckgo.com/");
      let query, search;
      const searchDeadline = Date.now() + 20000;
      while (Date.now() < searchDeadline) {
        const snapshot = await accessibilitySnapshot();
        if (!searchOrigins.includes(new URL(snapshot.url).origin)) return fail("unknown", "Navigation left DuckDuckGo before the search; nothing submitted.");
        query = snapshot.nodes.find(n => ["combobox", "textbox", "searchbox"].includes(n.role) && n.name === "Search with DuckDuckGo");
        search = snapshot.nodes.find(n => n.role === "button" && n.name === "Search");
        if (query && search) break;
        await waitMs(500);
      }
      if (!query || !search) return fail("unknown", "The DuckDuckGo search box did not appear; nothing submitted.");
      await fillInput({ backendNodeId: query.backendNodeId }, "uber eats login");
      await click({ backendNodeId: search.backendNodeId });
      if (!await waitForElement('[data-testid="result"] [data-testid="result-title-a"]', { timeoutSec: 20 })) return fail("unknown", "DuckDuckGo showed no organic results; nothing submitted.");
      const target = await js(({ origins }) => {
        if (!origins.includes(location.origin)) return null;
        if (/unusual traffic|verify you are human|are you a robot|captcha/i.test((document.body?.innerText || "").slice(0, 4000))) return "challenge";
        document.querySelectorAll("[data-webmcp-entry]").forEach(e => e.removeAttribute("data-webmcp-entry"));
        const first = [...document.querySelectorAll('[data-testid="result"] [data-testid="result-title-a"]')].find(a => !a.closest('[data-testid="ad"], [data-layout="ad"]'));
        if (!first) return null;
        first.setAttribute("data-webmcp-entry", "true");
        return first.href;
      }, { arg: { origins: searchOrigins } });
      if (target === "challenge") return fail("captcha_or_challenge", "DuckDuckGo challenged this session before any Uber request; nothing submitted.");
      if (!target) return fail("unknown", "No organic DuckDuckGo result was found; nothing submitted.");
      const targetHost = new URL(target).hostname;
      if (!(targetHost === "ubereats.com" || targetHost.endsWith(".ubereats.com"))) return fail("unknown", "The first organic result points at " + targetHost + ", not ubereats.com; nothing submitted.");
      step = "site_entry";
      await click('[data-webmcp-entry="true"]');
      s = await poll(async x => x.onSite && x.ready && (x.loginLink || await loggedIn(x)) || !!x.challenge || x.proxyError, 30);
      if (!s) return fail("unknown", "The search result did not land on a usable Uber Eats page; nothing submitted.");
      const landing = blocking(s);
      if (landing) return landing;
      if (await loggedIn(s)) return await authenticated(s);

      step = "open_login";
      // Hydration replaces the server-rendered header a few seconds after load, which detaches the tagged link.
      // The link is tagged again right before each click and only clicked once it has survived a settle interval.
      let opened = false;
      for (let attempt = 0; attempt < 3 && !opened; attempt++) {
        if (!(await read()).loginLink) break;
        await waitMs(1500);
        const stable = await js(() => { const link = document.querySelector('[data-webmcp-login-link="true"]'); return !!link && link.isConnected; });
        if (!stable) continue;
        try {
          await click('[data-webmcp-login-link="true"]');
          opened = true;
        } catch {
          // The node was replaced under the click; resolve it again. Opening the sign-in page submits nothing.
        }
      }
      if (!opened) return fail("unknown", "The Log in link could not be clicked; nothing submitted.");
      s = await poll(async x => (x.onAuth && (x.emailStep || x.codeCount === 4 || x.passwordStep || !!x.chooserFor)) || !!x.challenge || x.proxyError || x.errors.length > 0, 30);
      if (!s) return fail("unknown", "The Uber sign-in page did not show its email step; nothing submitted.");
      const entryOutcome = blocking(s);
      if (entryOutcome) return entryOutcome;
      if (s.codeCount === 4 && s.codeFor) {
        if (s.codeFor.toLowerCase() === email) return success(s, "enter_email_code", "A 4-digit code step for " + s.codeFor + " is already open; call again with otp.");
        return fail("unknown", "Uber shows a code step for " + s.codeFor + ", not the requested email; nothing submitted.");
      }
      if (await smsStep(s)) return smsSuccess(s);
      if (s.passwordStep) return await submitPassword(s);
      if (s.chooserFor) return await chooseMethod(s);
      if (!s.emailStep) return fail("unknown", "The Uber sign-in page did not show its email field; nothing submitted.");
      return await submitEmail(s);
    } catch (error) {
      // Error text names selectors and helpers, never field values; the supplied password is redacted regardless.
      let detail = error && error.message ? String(error.message).slice(0, 160) : "";
      if (detail && typeof input.password === "string") detail = detail.split(input.password).join("[redacted]");
      return fail("unknown", (submitted
        ? "Browser interaction failed after a submission was attempted; the outcome is unknown. Inspect the browser before any retry."
        : "Browser interaction failed before any submission.") + (detail ? " Cause: " + detail : ""));
    } finally {
      if (submitted) await disarm();
    }
  }
}]
