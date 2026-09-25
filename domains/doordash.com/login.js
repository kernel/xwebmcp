[{
  kind: "cdp",
  match: { url_patterns: ["https://doordash.com/*", "https://*.doordash.com/*"] },
  tool: {
    name: "login",
    description: "Sign in to a DoorDash consumer account with email and password, or submit a six-digit code for a verification step that is already visible. When the browser is already signed in, the tool confirms the account on the profile page and returns success without submitting anything. Entry is a DuckDuckGo search for doordash login followed by the first organic DoorDash result; there is no direct-navigation fallback. DoorDash's guided sign-in asks for the email first and then offers a phone code; the tool switches to the password option. The password is submitted at most once per invocation, a per-tab guard blocks a second submission for ten minutes, and nothing is retried. logged_in=true with mfa_required=true means the password was accepted but a code step remains; only authenticated=true is a usable session. Challenges are reported, never solved. Never registers, resets passwords, or changes settings.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        email: { type: "string", format: "email", minLength: 6, maxLength: 254, description: "Account email. Also compared with the account the site shows, so a session for another account is never reported as success." },
        password: { type: "string", minLength: 1, maxLength: 128, description: "Account password; never returned or logged." },
        otp: { type: "string", pattern: "^[0-9]{6}$", description: "Six-digit code for a verification step that is already visible. Cannot be combined with password." }
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
          required: ["logged_in", "authenticated", "mfa_required", "next_step", "landing_url", "account_hint", "evidence", "submission_attempted"],
          properties: {
            logged_in: { const: true },
            authenticated: { type: "boolean" },
            mfa_required: { type: "boolean" },
            next_step: { enum: ["none", "submit_otp"] },
            landing_url: { type: "string", format: "uri" },
            account_hint: { type: ["string", "null"], description: "Masked email the site associates with the session or sign-in flow." },
            evidence: { type: "string", minLength: 1 },
            submission_attempted: { type: "boolean" }
          },
          oneOf: [
            { properties: { authenticated: { const: true }, mfa_required: { const: false }, next_step: { const: "none" } } },
            { properties: { authenticated: { const: false }, mfa_required: { const: true }, next_step: { const: "submit_otp" } } }
          ]
        },
        {
          type: "object", additionalProperties: false,
          required: ["logged_in", "error_kind", "error_message", "attempts_remaining", "submission_attempted", "step"],
          properties: {
            logged_in: { const: false },
            error_kind: { enum: ["invalid_input", "invalid_credentials", "captcha_or_challenge", "mfa_failed", "locked_or_throttled", "unknown"] },
            error_message: { type: "string", minLength: 1 },
            attempts_remaining: { type: ["integer", "null"], minimum: 0, description: "Only set when the site displays a remaining-attempt count." },
            submission_attempted: { type: "boolean", description: "True once a password or code submission was clicked, even if its outcome is uncertain. Never retry automatically." },
            step: { enum: ["input", "session_check", "search_entry", "site_entry", "email_step", "password_option", "password_step", "otp_step"] }
          }
        }
      ]
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false }
  },
  execute: async (input) => {
    let submitted = false;
    let step = "input";
    const IDENTITY = "identity.doordash.com";
    const PROFILE_URL = "https://www.doordash.com/consumer/edit_profile/";
    const GUARD_KEY = "doordash.com.login.submitted.v1";
    const GUARD_TTL_MS = 600000;
    const onSite = host => host === "doordash.com" || host.endsWith(".doordash.com");
    const mask = address => address.replace(/^(.).*?(@.*)$/, "$1***$2");
    const fail = (kind, message) => {
      const remaining = message.match(/(\d+)\s+(?:more\s+)?(?:login\s+|sign.in\s+)?attempts?\s+(?:remaining|left)/i);
      return { logged_in: false, error_kind: kind, error_message: message, attempts_remaining: remaining ? Number(remaining[1]) : null, submission_attempted: submitted, step };
    };
    const classify = (message, codeStep) => {
      if (/too many|locked|try again (?:later|in)|temporarily (?:blocked|unavailable|disabled)|rate limit|suspended/i.test(message)) return "locked_or_throttled";
      if (/captcha|verify (?:that )?you(?:'re| are)|robot|human verification|suspicious|unusual/i.test(message)) return "captcha_or_challenge";
      if (codeStep || /(?:code|otp).*(?:incorrect|invalid|expired|wrong)|(?:incorrect|invalid|expired|wrong).*(?:code|otp)/i.test(message)) return "mfa_failed";
      if (/incorrect (?:email|password)|couldn't find an account|could not find an account|no account|password (?:is |you entered (?:is )?)?(?:incorrect|invalid|wrong)|invalid (?:email|password|credentials)|doesn't match|does not match|do not match/i.test(message)) return "invalid_credentials";
      return "unknown";
    };

    if (!input || typeof input !== "object" || Array.isArray(input)) return fail("invalid_input", "Input must be an object with email and exactly one of password or otp. No page action was taken.");
    const email = typeof input.email === "string" ? input.email.trim() : "";
    const mode = "otp" in input ? "otp" : "password";
    if (Object.keys(input).some(k => !["email", "password", "otp"].includes(k))
      || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254
      || ("password" in input) === ("otp" in input)
      || (mode === "password" && (typeof input.password !== "string" || !input.password.length || input.password.length > 128))
      || (mode === "otp" && !(typeof input.otp === "string" && /^[0-9]{6}$/.test(input.otp)))) {
      return fail("invalid_input", "Provide a valid email plus exactly one of password or a six-digit otp. No page action was taken.");
    }
    const wanted = email.toLowerCase();

    const read = async () => js(() => {
      const visible = e => !!e && e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) && e.getClientRects().length > 0;
      const text = e => (e.innerText || e.textContent || "").replace(/\s+/g, " ").trim();
      const identity = location.hostname === "identity.doordash.com";
      const controls = [...document.querySelectorAll("button, a, [role=button]")].filter(visible);
      // The footer links to Account Details on signed-out pages too; only header controls prove a session.
      const chrome = controls.filter(b => !b.closest("footer"));
      const account = chrome.find(b => /^(?:sign out|log out|logout)$/i.test(text(b)))
        || chrome.find(b => /^account$/i.test(text(b)) || (b.getAttribute("href") || "").includes("/consumer/edit_profile"));
      const state = {
        url: location.href, host: location.hostname, https: location.protocol === "https:", referrer: document.referrer,
        loggedInCookie: /(?:^|;\s*)dd_cx_logged_in=true(?:;|$)/.test(document.cookie),
        account: account ? text(account) : null,
        profileEmail: /^\/consumer\/edit_profile\/?$/.test(location.pathname)
          ? [...document.querySelectorAll('input[type="email"]')].map(e => e.value.trim()).find(v => v.includes("@")) || null : null,
        emailStep: false, emailValue: "", emailSubmit: false, phoneStep: false, usePassword: false,
        passwordStep: false, passwordLength: 0, passwordSubmit: false, boundEmail: null,
        codeStep: false, codeCount: 0, codeHint: null, errors: [], challenge: null
      };
      const frame = [...document.querySelectorAll("iframe")].find(f => visible(f) && /captcha|challenge|turnstile|perimeterx/i.test((f.title || "") + " " + (f.src || "")) && f.getBoundingClientRect().width > 100 && f.getBoundingClientRect().height > 60);
      const blocks = identity ? [...document.querySelectorAll("h1, h2, h3, p, div, span, li, label, [role=alert]")].filter(e => visible(e) && !e.closest("footer, nav, header")) : [...document.querySelectorAll("h1, h2, [role=dialog]")].filter(visible);
      const texts = blocks.map(text).filter(t => t.length > 0 && t.length < 300);
      const challengeText = texts.find(t => /verify (?:that )?you(?:'re| are)(?: not a robot| a human| human)|are you a (?:robot|human)|access denied|unusual traffic|security check|checking your browser|press (?:and|&) hold|complete the captcha/i.test(t));
      state.challenge = challengeText || (frame ? "Visible challenge frame: " + (frame.title || "captcha") : null);
      if (!identity) return state;
      const emailForm = document.querySelector('form[data-testid="login-form-guided-email"]');
      const emailInput = emailForm ? [...emailForm.querySelectorAll('input[type="email"]')].find(visible) : null;
      const emailSubmit = emailForm ? emailForm.querySelector("#guided-submit-button") : null;
      const passwordForm = document.querySelector("form#login-form");
      const passwordInput = passwordForm ? [...passwordForm.querySelectorAll('input[type="password"]')].find(visible) : null;
      const passwordSubmit = passwordForm ? passwordForm.querySelector("#login-submit-button") : null;
      const codeInputs = [...document.querySelectorAll("input")].filter(e => visible(e) && (e.autocomplete === "one-time-code"
        || /\b(?:code|otp|verification)\b/i.test([e.name, e.id, e.getAttribute("aria-label"), e.placeholder, e.getAttribute("data-testid")].join(" "))
        || (e.maxLength === 1 && /^(?:tel|text|number)$/.test(e.type))));
      const bound = texts.map(t => t.match(/logging into your account with\s+([^\s(]+@[^\s(]+)/i)).find(Boolean);
      const errorPattern = /incorrect|invalid|couldn't|could not|can't|cannot|doesn't match|does not match|do not match|too many|locked|try again|unable|expired|wrong|blocked|suspicious|unusual|not (?:found|recogni[sz]ed)|denied|failed/i;
      const candidates = blocks.filter(e => !e.querySelector("input, form") && errorPattern.test(text(e)) && text(e).length <= 300 && !/enter your password to finish/i.test(text(e)));
      const innermost = candidates.filter(e => !candidates.some(o => o !== e && e.contains(o)));
      state.errors = [...new Set(innermost.map(e => {
        let box = e;
        while (box.parentElement && box.parentElement !== document.body && !box.parentElement.querySelector("input, form") && text(box.parentElement).length <= 400) box = box.parentElement;
        return text(box);
      }))];
      state.emailStep = !!emailInput;
      state.emailValue = emailInput ? emailInput.value.trim() : "";
      state.emailSubmit = visible(emailSubmit) && !emailSubmit.disabled;
      state.phoneStep = visible(document.querySelector("form#guided-email-phone-form"));
      state.usePassword = controls.some(b => /^use password instead$/i.test(text(b)));
      state.passwordStep = !!passwordInput;
      state.passwordLength = passwordInput ? passwordInput.value.length : 0;
      state.passwordSubmit = visible(passwordSubmit) && !passwordSubmit.disabled && passwordSubmit.getAttribute("aria-disabled") !== "true";
      state.boundEmail = bound ? bound[1].replace(/[),.]+$/, "") : null;
      state.codeStep = codeInputs.length > 0;
      state.codeCount = codeInputs.length;
      state.codeHint = texts.find(t => /\b(?:6|six)[- ]digit|verification code|enter the code|code (?:we )?(?:sent|texted|emailed)|sent (?:you )?(?:a |the )?code/i.test(t)) || null;
      return state;
    });
    const signedInCookie = async () => {
      try {
        const { cookies } = await cdp("Network.getCookies", { urls: ["https://www.doordash.com/"] });
        return cookies.some(c => c.name === "dd_cx_logged_in" && c.value === "true");
      } catch {
        return false;
      }
    };
    const settle = async (predicate, seconds) => {
      const deadline = Date.now() + seconds * 1000;
      while (Date.now() < deadline) {
        try {
          const state = await read();
          if (predicate(state)) return state;
        } catch { /* navigation replaced the execution context; only the read is retried */ }
        await waitMs(400);
      }
      return null;
    };
    const midFlow = s => s.https && s.host === IDENTITY && (s.passwordStep || (s.phoneStep && s.usePassword) || s.codeStep);
    const searchReferred = s => /^https:\/\/(?:start\.)?duckduckgo\.com\//.test(s.referrer || "");
    const success = (s, hint, evidence) => ({
      logged_in: true, authenticated: !s.codeStep, mfa_required: !!s.codeStep, next_step: s.codeStep ? "submit_otp" : "none",
      landing_url: s.url, account_hint: hint, evidence, submission_attempted: submitted
    });
    const observe = async (before, codeStep) => {
      const deadline = Date.now() + 45000;
      let cleared = before === "[]";
      let challenge = null;
      while (Date.now() < deadline) {
        await waitMs(500);
        let s;
        try { s = await read(); } catch { continue; }
        if (await signedInCookie() && (!s.https || s.host !== IDENTITY || !(s.passwordStep || s.codeStep || s.emailStep))) {
          return success({ ...s, codeStep: false }, mask(s.boundEmail || email), "Session cookie dd_cx_logged_in is set and the sign-in form is gone" + (s.account ? "; " + s.account + " control visible" : "") + ".");
        }
        if (!s.https || !onSite(s.host)) return fail("unknown", "Navigation left doordash.com after submission; the outcome is unconfirmed. Inspect the browser before any further attempt.");
        if (!s.errors.length) cleared = true;
        const fresh = s.errors.length && (cleared || JSON.stringify(s.errors) !== before);
        if (fresh) {
          const message = s.errors.join("\n");
          if (!codeStep) { try { await js(key => sessionStorage.removeItem(key), { arg: GUARD_KEY }); } catch { /* the guard only matters while the form is still open */ } }
          return fail(classify(message, codeStep || s.codeStep), message);
        }
        if (!codeStep && s.codeStep) return success(s, mask(s.boundEmail || email), s.codeHint || ("Verification code step visible with " + s.codeCount + " input(s)."));
        challenge = s.challenge;
        if (s.host !== IDENTITY && s.account) return success({ ...s, codeStep: false }, mask(email), "Signed-in " + s.account + " control visible on " + s.host + ".");
      }
      if (challenge) return fail("captcha_or_challenge", challenge);
      return fail("unknown", "No conclusive sign-in result within 45 seconds. The submission may have reached DoorDash; inspect the browser before any further attempt.");
    };

    try {
      step = "session_check";
      let s = await read();
      if (mode === "password" && (await signedInCookie() || (s.https && onSite(s.host) && s.host !== IDENTITY && s.account))) {
        if (!(s.url.startsWith(PROFILE_URL) && s.profileEmail)) await gotoUrl(PROFILE_URL);
        const profile = await settle(x => !!x.profileEmail || x.emailStep || !!x.challenge, 20);
        if (profile && profile.profileEmail) {
          if (profile.profileEmail.toLowerCase() === wanted) return success(profile, mask(profile.profileEmail), "Existing session: the profile page shows the requested account and no sign-in was needed.");
          return fail("unknown", "The browser is already signed in as " + mask(profile.profileEmail) + ", not the requested account. Sign out before invoking again; no submission was made.");
        }
        if (profile && profile.challenge) return fail("captcha_or_challenge", profile.challenge);
        if (!profile || !profile.emailStep) return fail("unknown", "A signed-in session was detected but the account could not be confirmed on the profile page; no submission was made.");
        s = profile;
      }

      if (mode === "otp") {
        step = "otp_step";
        if (!(s.https && s.host === IDENTITY && s.codeStep)) return fail("unknown", "No verification-code step is visible on the DoorDash sign-in page; the code was not submitted.");
        if (s.boundEmail && s.boundEmail.toLowerCase() !== wanted) return fail("unknown", "The sign-in flow belongs to " + mask(s.boundEmail) + ", not the requested account; the code was not submitted.");
        const before = JSON.stringify(s.errors);
        const entered = await js(code => {
          const visible = e => !!e && e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) && e.getClientRects().length > 0;
          const inputs = [...document.querySelectorAll("input")].filter(e => visible(e) && (e.autocomplete === "one-time-code"
            || /\b(?:code|otp|verification)\b/i.test([e.name, e.id, e.getAttribute("aria-label"), e.placeholder, e.getAttribute("data-testid")].join(" "))
            || (e.maxLength === 1 && /^(?:tel|text|number)$/.test(e.type))));
          if (!inputs.length) return false;
          inputs[0].focus();
          if (inputs.length === 1) {
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(inputs[0], code);
            inputs[0].dispatchEvent(new Event("input", { bubbles: true, composed: true }));
            inputs[0].dispatchEvent(new Event("change", { bubbles: true, composed: true }));
            return inputs[0].value === code;
          }
          // Per-box typing breaks focus handling; the component spreads a pasted code across its boxes.
          const data = new DataTransfer();
          data.setData("text", code);
          inputs[0].dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
          return inputs.every(e => e.value.length > 0) || inputs[0].value.length > 1;
        }, { arg: input.otp });
        if (!entered) return fail("unknown", "The verification form did not accept the code; nothing was submitted.");
        submitted = true;
        // The code modal overlays the password form, whose own Sign In button stays visible; only the modal's control may be clicked.
        let hasSubmit = false;
        for (let i = 0; i < 10 && !hasSubmit; i++) {
          hasSubmit = await js(() => {
            const visible = e => !!e && e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) && e.getClientRects().length > 0;
            const code = [...document.querySelectorAll("input")].find(e => visible(e) && (e.autocomplete === "one-time-code" || e.maxLength === 1));
            const scope = code ? code.closest('[role="dialog"], form') : null;
            if (!scope) return false;
            const button = [...scope.querySelectorAll("button")].find(b => visible(b) && !b.disabled && b.getAttribute("aria-disabled") !== "true" && /^(?:submit|verify|continue|confirm)$/i.test((b.innerText || "").trim()));
            if (!button) return false;
            button.setAttribute("data-webmcp-doordash-login", "otp-submit");
            return true;
          });
          if (!hasSubmit) await waitMs(300);
        }
        if (hasSubmit) await click('[data-webmcp-doordash-login="otp-submit"]');
        return await observe(before, true);
      }

      if (!midFlow(s) && !(s.https && s.host === IDENTITY && s.emailStep && searchReferred(s))) {
        step = "search_entry";
        await gotoUrl("https://start.duckduckgo.com/");
        let query, search;
        const searchDeadline = Date.now() + 20000;
        while (Date.now() < searchDeadline) {
          const { nodes } = await accessibilitySnapshot();
          query = nodes.find(n => ["combobox", "textbox", "searchbox"].includes(n.role) && n.name === "Search with DuckDuckGo");
          search = nodes.find(n => n.role === "button" && n.name === "Search");
          if (query && search) break;
          await waitMs(500);
        }
        if (!query || !search) return fail("unknown", "DuckDuckGo search controls did not become available; no sign-in was attempted.");
        await fillInput({ backendNodeId: query.backendNodeId }, "doordash login");
        await click({ backendNodeId: search.backendNodeId });
        if (!await waitForElement('[data-testid="result"] [data-testid="result-title-a"]', { timeoutSec: 20 })) return fail("unknown", "DuckDuckGo organic results did not load; no sign-in was attempted.");
        const target = await js(() => {
          if (!["https://duckduckgo.com", "https://start.duckduckgo.com"].includes(location.origin)) return null;
          document.querySelectorAll("[data-webmcp-doordash-login]").forEach(e => e.removeAttribute("data-webmcp-doordash-login"));
          const first = [...document.querySelectorAll('[data-testid="result"] [data-testid="result-title-a"]')].find(a => !a.closest('[data-testid="ad"], [data-layout="ad"]') && a.getClientRects().length);
          if (!first) return null;
          first.setAttribute("data-webmcp-doordash-login", "result");
          try { return { href: first.href, host: new URL(first.href).hostname, https: new URL(first.href).protocol === "https:" }; } catch { return { href: first.href, host: "", https: false }; }
        });
        if (!target) return fail("unknown", "No organic DuckDuckGo result was found; no sign-in was attempted.");
        if (!target.https || !onSite(target.host)) return fail("unknown", "The first organic DuckDuckGo result was " + target.host + ", not a doordash.com page; no sign-in was attempted.");
        step = "site_entry";
        await click('[data-webmcp-doordash-login="result"]');
        s = await settle(x => x.https && onSite(x.host) && (x.emailStep || midFlow(x) || !!x.account || !!x.challenge), 15)
          || await settle(x => x.https && onSite(x.host), 15);
        if (!s) return fail("unknown", "The DoorDash result did not lead to a doordash.com page; no sign-in was attempted.");
        if (s.challenge) return fail("captcha_or_challenge", s.challenge);
        if (!s.emailStep && !midFlow(s)) {
          const opened = await js(() => {
            const visible = e => !!e && e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) && e.getClientRects().length > 0;
            const control = [...document.querySelectorAll("a, button")].find(e => visible(e) && /^(?:sign in|log in)$/i.test((e.innerText || "").trim()));
            if (!control) return false;
            control.setAttribute("data-webmcp-doordash-login", "signin");
            return true;
          });
          if (!opened) return fail("unknown", "Landed on " + s.host + " without a sign-in form or Sign In control; no sign-in was attempted.");
          await click('[data-webmcp-doordash-login="signin"]');
          s = await settle(x => (x.https && x.host === IDENTITY && (x.emailStep || midFlow(x))) || !!x.challenge, 30);
          if (!s) return fail("unknown", "The Sign In control did not open the sign-in form; no sign-in was attempted.");
          if (s.challenge) return fail("captcha_or_challenge", s.challenge);
        }
      }

      if (s.host !== IDENTITY || !s.https) return fail("unknown", "Sign-in did not reach the DoorDash identity page; no sign-in was attempted.");
      if (s.emailStep && !midFlow(s)) {
        step = "email_step";
        await fillInput('form[data-testid="login-form-guided-email"] input[type="email"]', email);
        s = await read();
        if (s.emailValue.toLowerCase() !== wanted) return fail("unknown", "The email field did not accept the address; nothing was submitted.");
        if (!s.emailSubmit) return fail("unknown", "The Continue control is missing or disabled; nothing was submitted.");
        if (s.challenge) return fail("captcha_or_challenge", s.challenge);
        const before = JSON.stringify(s.errors);
        await click('form[data-testid="login-form-guided-email"] #guided-submit-button');
        s = await settle(x => x.passwordStep || x.phoneStep || x.codeStep || !!x.challenge || (x.errors.length > 0 && JSON.stringify(x.errors) !== before) || x.host !== IDENTITY, 30);
        if (!s) return fail("unknown", "DoorDash did not respond to the email step within 30 seconds; no password was submitted.");
        if (s.host !== IDENTITY) return fail("unknown", "The email step navigated away from the identity page; no password was submitted.");
        if (s.challenge && !s.passwordStep && !s.phoneStep) return fail("captcha_or_challenge", s.challenge);
        if (s.errors.length && !s.passwordStep && !s.phoneStep) return fail(classify(s.errors.join("\n"), false), s.errors.join("\n"));
      }
      if (s.codeStep) return fail("unknown", "A verification-code step is already open; supply otp instead of password. No password was submitted.");
      if (s.phoneStep && !s.passwordStep) {
        step = "password_option";
        if (!s.usePassword) return fail("unknown", "DoorDash offered only a phone-code sign-in for this account and no password option; nothing was submitted.");
        await js(() => {
          const control = [...document.querySelectorAll("button, a, [role=button]")].find(b => /^use password instead$/i.test((b.innerText || "").trim()));
          control.setAttribute("data-webmcp-doordash-login", "use-password");
        });
        await click('[data-webmcp-doordash-login="use-password"]');
        s = await settle(x => x.passwordStep || !!x.challenge || x.errors.length > 0, 15);
        if (!s) return fail("unknown", "The password option did not open a password form; nothing was submitted.");
        if (s.challenge && !s.passwordStep) return fail("captcha_or_challenge", s.challenge);
      }
      if (!s.passwordStep) return fail("unknown", "No password form is visible" + (s.errors.length ? ": " + s.errors.join("\n") : "") + "; nothing was submitted.");

      step = "password_step";
      if (s.boundEmail && s.boundEmail.toLowerCase() !== wanted) return fail("unknown", "The password step belongs to " + mask(s.boundEmail) + ", not the requested account; nothing was submitted.");
      await fillInput('form#login-form input[type="password"]', input.password);
      s = await read();
      if (s.passwordLength !== input.password.length) return fail("unknown", "The password field did not accept the value; nothing was submitted.");
      if (!s.passwordSubmit) return fail("unknown", "The Sign In control is missing or disabled; nothing was submitted.");
      if (s.challenge) return fail("captcha_or_challenge", s.challenge);
      const before = JSON.stringify(s.errors);
      const armed = await js(guard => {
        const previous = Number(sessionStorage.getItem(guard.key) || 0);
        if (previous && Date.now() - previous < guard.ttl) return false;
        sessionStorage.setItem(guard.key, String(Date.now()));
        return true;
      }, { arg: { key: GUARD_KEY, ttl: GUARD_TTL_MS } });
      if (!armed) return fail("unknown", "This tab already submitted a password within the last ten minutes and no result was recorded; not submitting again. Inspect the browser first.");
      submitted = true;
      await click("form#login-form #login-submit-button");
      return await observe(before, false);
    } catch {
      return fail("unknown", submitted
        ? "Browser interaction failed after the submission started; the outcome is unknown. Inspect the browser before any further attempt."
        : "Browser interaction failed before anything was submitted. Inspect the page before continuing.");
    }
  }
}]