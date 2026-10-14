[{
  kind: "cdp",
  match: { url_patterns: ["https://doordash.com/*", "https://*.doordash.com/*"] },
  tool: {
    name: "register",
    description: "Create a new DoorDash consumer account with the email sign-up form (first name, last name, email, US mobile number, password), or submit a six-digit code for a sign-up verification step that is already visible. Signup mode refuses when the browser is already signed in, opens identity.doordash.com's sign-up page directly, types each field with trusted key events, and clicks Sign Up at most once per invocation (a per-tab guard blocks a second submission for ten minutes); nothing is retried. Optional offers are never accepted, and no payment method, address or order is added. registered=true means DoorDash returned to www.doordash.com with a signed-in header control; verification_required means a code step is open: ask the person for the code and invoke again with email and otp. CAPTCHAs and challenges are reported, never solved. Listed on doordash.com pages; allow 120 seconds per invocation.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        email: { type: "string", format: "email", minLength: 6, maxLength: 254, description: "Email for the new account." },
        first_name: { type: "string", minLength: 1, maxLength: 50 },
        last_name: { type: "string", minLength: 1, maxLength: 50 },
        phone: { type: "string", pattern: "^(?:\\+?1)?[ .()-]*[2-9][0-9]{2}[ .()-]*[0-9]{3}[ .-]*[0-9]{4}$", description: "US mobile number; DoorDash may text a code to it." },
        password: { type: "string", minLength: 10, maxLength: 128, description: "New account password (DoorDash requires at least 10 characters); never returned or logged." },
        otp: { type: "string", pattern: "^[0-9]{6}$", description: "Six-digit code for a sign-up verification step that is already visible. Combine only with email." }
      },
      required: ["email"],
      oneOf: [
        { required: ["first_name", "last_name", "phone", "password"], not: { required: ["otp"] } },
        { required: ["otp"], not: { anyOf: [{ required: ["password"] }, { required: ["phone"] }, { required: ["first_name"] }, { required: ["last_name"] }] } }
      ]
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false,
          required: ["registered", "next_step", "landing_url", "account_hint", "evidence", "submission_attempted"],
          properties: {
            registered: { const: true },
            next_step: { const: "none" },
            landing_url: { type: "string", format: "uri" },
            account_hint: { type: "string", description: "Masked email of the new account." },
            evidence: { type: "string", minLength: 1 },
            submission_attempted: { type: "boolean" }
          }
        },
        {
          type: "object", additionalProperties: false,
          required: ["registered", "error_kind", "error_message", "next_step", "submission_attempted", "step"],
          properties: {
            registered: { const: false },
            error_kind: { enum: ["invalid_input", "already_signed_in", "email_already_registered", "verification_required", "verification_failed", "captcha_or_challenge", "locked_or_throttled", "unknown"] },
            error_message: { type: "string", minLength: 1 },
            next_step: { enum: ["none", "submit_otp", "sign_in", "inspect_browser", "fix_input"] },
            submission_attempted: { type: "boolean", description: "True once Sign Up or a code submission was clicked, even if the outcome is uncertain. Never retry automatically." },
            step: { enum: ["input", "session_check", "signup_page", "fill", "submit", "otp_step"] }
          }
        }
      ]
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false }
  },
  execute: async (input, context) => {
    let submitted = false;
    let step = "input";
    const started = Date.now();
    const BUDGET_MS = 112000;
    const OBSERVE_MS = 45000;
    const signal = context && context.signal;
    const remaining = () => BUDGET_MS - (Date.now() - started);
    const cancelled = () => (!!signal && signal.aborted) || remaining() <= 0;
    const IDENTITY = "identity.doordash.com";
    const SIGNUP_URL = "https://identity.doordash.com/auth/user/signup?client_id=1666519390426295040&intl=en-US&layout=consumer_web&prompt=none&redirect_uri=https%3A%2F%2Fwww.doordash.com%2Fpost-login%2F&response_type=code&scope=*&state=%2F";
    const PROFILE_URL = "https://www.doordash.com/consumer/edit_profile/";
    const GUARD_KEY = "doordash.com.register.submitted.v1";
    const GUARD_TTL_MS = 600000;
    const onSite = host => host === "doordash.com" || host.endsWith(".doordash.com");
    const mask = address => address.replace(/^(.).*?(@.*)$/, "$1***$2");
    const NEXT = { invalid_input: "fix_input", already_signed_in: "none", email_already_registered: "sign_in", verification_required: "submit_otp", verification_failed: "submit_otp", captcha_or_challenge: "inspect_browser", locked_or_throttled: "inspect_browser", unknown: "inspect_browser" };
    const fail = (kind, message) => ({ registered: false, error_kind: kind, error_message: message, next_step: NEXT[kind], submission_attempted: submitted, step });
    const classify = (message, codeStep) => {
      if (/too many|try again (?:later|in)|temporarily|rate limit|suspended|locked/i.test(message)) return "locked_or_throttled";
      if (/captcha|robot|human verification|suspicious|unusual/i.test(message)) return "captcha_or_challenge";
      if (/already (?:have an account|registered|in use|exists|associated|taken)|account (?:already )?exists|is already|sign in instead/i.test(message)) return "email_already_registered";
      if (codeStep || /code/i.test(message)) return "verification_failed";
      if (/invalid|valid (?:email|phone|number)|required|at least|must|too short|not allowed/i.test(message)) return "invalid_input";
      return "unknown";
    };

    // @xwebmcp-inline lib/input.js
    const typeInto = async (target, text, options = {}) => {
      await click(target);
      if (options.clear !== false) {
        // Control+A is select-all on Linux/Windows but not macOS, and macOS Chrome runs no editing
        // shortcuts for synthetic key events. The explicit selectAll command works on every platform.
        const keyA = { key: "a", code: "KeyA", windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: 2 };
        await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "Control", code: "ControlLeft", windowsVirtualKeyCode: 17, modifiers: 2, location: 1 });
        try {
          await cdp("Input.dispatchKeyEvent", { type: "rawKeyDown", ...keyA, commands: ["selectAll"] });
          await cdp("Input.dispatchKeyEvent", { type: "keyUp", ...keyA });
        } finally {
          await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "Control", code: "ControlLeft", windowsVirtualKeyCode: 17, modifiers: 0, location: 1 });
        }
        await pressKey("Backspace");
        const leftover = () => js(() => {
          const e = document.activeElement;
          if (!e) return null;
          if (typeof e.value === "string") return e.value;
          return e.isContentEditable ? e.textContent : null;
        });
        if (await leftover()) {
          await js(() => {
            const e = document.activeElement;
            if (typeof e.select === "function") e.select();
            else window.getSelection().selectAllChildren(e);
          });
          await pressKey("Backspace");
          const rest = await leftover();
          if (rest) throw new Error("typeInto: could not clear the field, it still holds " + rest.length + " character(s)");
        }
      }
      const shifted = '~!@#$%^&*()_+{}|:"<>?';
      const unshifted = '`1234567890-=[]\\;\',./';
      const random = options.random || Math.random;
      let previous = "";
      for (const character of text) {
        if (previous && options.cadence !== "none") {
          const pause = /[.@\s]/.test(previous) ? [80, 200] : [50, 120];
          await waitMs(pause[0] + Math.floor(random() * (pause[1] - pause[0] + 1)));
        }
        const uppercase = character >= "A" && character <= "Z";
        const symbol = shifted.indexOf(character);
        if (uppercase || symbol !== -1) {
          await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16, modifiers: 8, location: 1 });
          try {
            await pressKey(uppercase ? character.toLowerCase() : unshifted[symbol], ["Shift"]);
          } finally {
            await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16, modifiers: 0, location: 1 });
          }
        } else {
          await pressKey(character);
        }
        previous = character;
      }
    };
    // @xwebmcp-end

    if (!input || typeof input !== "object" || Array.isArray(input)) return fail("invalid_input", "Input must be an object. No page action was taken.");
    const allowed = ["email", "first_name", "last_name", "phone", "password", "otp"];
    const email = typeof input.email === "string" ? input.email.trim() : "";
    const mode = "otp" in input ? "otp" : "signup";
    const str = (v, max) => typeof v === "string" && v.trim().length > 0 && v.trim().length <= max;
    const digits = typeof input.phone === "string" ? input.phone.replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "") : "";
    if (Object.keys(input).some(k => !allowed.includes(k)) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return fail("invalid_input", "Provide a valid email and only the documented fields. No page action was taken.");
    if (mode === "otp") {
      if (["password", "phone", "first_name", "last_name"].some(k => k in input) || !(typeof input.otp === "string" && /^[0-9]{6}$/.test(input.otp))) return fail("invalid_input", "otp mode takes only email and a six-digit otp. No page action was taken.");
    } else if (!str(input.first_name, 50) || !str(input.last_name, 50) || !/^[2-9]\d{9}$/.test(digits)
      || typeof input.password !== "string" || input.password.length < 10 || input.password.length > 128) {
      return fail("invalid_input", "Signup needs first_name, last_name, a 10-digit US phone and a password of 10 to 128 characters. No page action was taken.");
    }

    const read = async () => js(() => {
      const visible = e => !!e && e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) && e.getClientRects().length > 0;
      const text = e => (e.innerText || e.textContent || "").replace(/\s+/g, " ").trim();
      const form = document.querySelector("form#signup-form");
      const labelled = name => {
        if (!form) return null;
        const label = [...form.querySelectorAll("label")].find(l => text(l).replace(/\*$/, "").trim().toLowerCase() === name);
        const control = label ? (label.htmlFor && document.getElementById(label.htmlFor)) || label.parentElement.querySelector("input") : null;
        return visible(control) ? control : null;
      };
      const fields = {
        first: labelled("first name"), last: labelled("last name"),
        email: form ? [...form.querySelectorAll('input[type="email"]')].find(visible) : null,
        phone: form ? [...form.querySelectorAll('input[type="tel"]')].find(visible) : null,
        password: form ? [...form.querySelectorAll('input[type="password"]')].find(visible) : null
      };
      const marks = {};
      for (const [key, el] of Object.entries(fields)) if (el) { el.setAttribute("data-webmcp-doordash-register", key); marks[key] = el.value.length; }
      const submit = form ? form.querySelector("#sign-up-submit-button") : null;
      const codeInputs = [...document.querySelectorAll("input")].filter(e => {
        const a = [e.name, e.id, e.getAttribute("aria-label"), e.placeholder, e.getAttribute("data-testid")].join(" ");
        return visible(e) && !/country/i.test(a) && (e.autocomplete === "one-time-code" || (e.maxLength === 1 && /^(?:tel|text|number)$/.test(e.type)) || /(?:verification|security|one.?time|sms|2fa|mfa)[ _-]?code|\botp\b/i.test(a));
      });
      const controls = [...document.querySelectorAll("button, a, [role=button]")].filter(e => visible(e) && !e.closest("footer"));
      const account = controls.find(b => /^(?:sign out|log out|account)$/i.test(text(b)) || (b.getAttribute("href") || "").includes("/consumer/edit_profile"));
      const blocks = [...document.querySelectorAll("[role=alert], [aria-live], span, div, p")].filter(e => visible(e) && !e.closest("footer, nav, header") && !e.querySelector("input, form, button"));
      const errors = [...new Set(blocks.map(text).filter(t => t.length > 3 && t.length < 250 && /invalid|already|required|must|try again|too many|couldn't|could not|unable|incorrect|expired|not valid|blocked/i.test(t) && !/terms and privacy/i.test(t)))];
      const frame = [...document.querySelectorAll("iframe")].find(f => visible(f) && /captcha|challenge|turnstile|perimeterx/i.test((f.title || "") + " " + (f.src || "")) && f.getBoundingClientRect().width > 100 && f.getBoundingClientRect().height > 60);
      const challengeText = blocks.map(text).find(t => t.length < 200 && /verify (?:that )?you(?:'re| are)|are you a (?:robot|human)|access denied|unusual traffic|press (?:and|&) hold|complete the captcha/i.test(t));
      return {
        url: location.href, host: location.hostname, https: location.protocol === "https:",
        form: !!form, marks, submit: visible(submit) && !submit.disabled && submit.getAttribute("aria-disabled") !== "true",
        codeStep: codeInputs.length > 0, codeCount: codeInputs.length,
        codeHint: blocks.map(text).filter(t => t.length < 250 && /\b(?:6|six)[- ]digit|verification code|enter the code|code (?:we )?(?:sent|texted|emailed)|sent (?:you )?(?:a |the )?code/i.test(t)).sort((a, b) => a.length - b.length)[0] || null,
        account: account ? text(account) : null, errors,
        profileEmail: /^\/consumer\/edit_profile\/?$/.test(location.pathname) ? [...document.querySelectorAll('input[type="email"]')].map(e => e.value.trim()).find(v => v.includes("@")) || null : null,
        challenge: challengeText || (frame ? "Visible challenge frame: " + (frame.title || "captcha") : null)
      };
    });
    const signedInCookie = async () => {
      try {
        const { cookies } = await cdp("Network.getCookies", { urls: ["https://www.doordash.com/"] });
        return cookies.some(c => c.name === "dd_cx_logged_in" && c.value === "true");
      } catch { return false; }
    };
    const settle = async (predicate, seconds) => {
      const deadline = Date.now() + seconds * 1000;
      while (Date.now() < deadline && !cancelled()) {
        try { const s = await read(); if (predicate(s)) return s; } catch { /* navigation replaced the context */ }
        await waitMs(400);
      }
      return null;
    };
    const observe = async (before, codeStep) => {
      const deadline = Date.now() + OBSERVE_MS;
      let challenge = null;
      while (Date.now() < deadline && !cancelled()) {
        await waitMs(600);
        let s;
        try { s = await read(); } catch { continue; }
        if (!s.https || !onSite(s.host)) return fail("unknown", "Navigation left doordash.com after submission; the outcome is unconfirmed. Inspect the browser before any further attempt.");
        // Signup refuses to start while the cookie is set, so a cookie seen here was minted by this flow; the profile email confirms the account.
        if (s.host !== IDENTITY && !s.codeStep && !s.account && await signedInCookie()) {
          try {
            await gotoUrl(PROFILE_URL);
            const profile = await settle(x => !!x.profileEmail, 15);
            if (profile && profile.profileEmail.toLowerCase() === email.toLowerCase()) {
              return { registered: true, next_step: "none", landing_url: profile.url, account_hint: mask(profile.profileEmail), evidence: "dd_cx_logged_in cookie set and the profile page shows the new account's email.", submission_attempted: submitted };
            }
            if (profile) return fail("unknown", "Signed in, but the profile page shows " + mask(profile.profileEmail) + " rather than the requested email.");
          } catch { /* fall through to keep observing */ }
        }
        if (s.host !== IDENTITY && s.account && !s.codeStep) {
          const cookie = await signedInCookie();
          return { registered: true, next_step: "none", landing_url: s.url, account_hint: mask(email), evidence: "Signed-in " + s.account + " control visible on " + s.host + (cookie ? " with the dd_cx_logged_in cookie set." : "."), submission_attempted: submitted };
        }
        // The code dialog can open alongside transient form notices, so it wins over feedback text.
        if (!codeStep && s.codeStep) return fail("verification_required", (s.codeHint || "A verification-code step is visible") + " Ask the person for the code, then invoke again with email and otp.");
        const fresh = s.errors.filter(e => !before.includes(e));
        if (fresh.length) return fail(classify(fresh.join("\n"), codeStep), fresh.join("\n"));
        challenge = s.challenge;
      }
      if (challenge) return fail("captcha_or_challenge", challenge);
      return fail("unknown", "No conclusive result within the observation window. The submission may have reached DoorDash; inspect the browser before any further attempt.");
    };

    try {
      step = "session_check";
      let s = await read();
      if (mode === "otp") {
        step = "otp_step";
        if (!(s.https && onSite(s.host) && s.codeStep)) return fail("unknown", "No verification-code step is visible; the code was not submitted.");
        const before = s.errors;
        const entered = await js(code => {
          const visible = e => !!e && e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) && e.getClientRects().length > 0;
          const inputs = [...document.querySelectorAll("input")].filter(e => {
            const a = [e.name, e.id, e.getAttribute("aria-label"), e.placeholder, e.getAttribute("data-testid")].join(" ");
            return visible(e) && !/country/i.test(a) && (e.autocomplete === "one-time-code" || (e.maxLength === 1 && /^(?:tel|text|number)$/.test(e.type)) || /(?:verification|security|one.?time|sms|2fa|mfa)[ _-]?code|\botp\b/i.test(a));
          });
          if (!inputs.length) return false;
          inputs[0].focus();
          if (inputs.length === 1) {
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(inputs[0], code);
            inputs[0].dispatchEvent(new Event("input", { bubbles: true, composed: true }));
            inputs[0].dispatchEvent(new Event("change", { bubbles: true, composed: true }));
            return inputs[0].value === code;
          }
          const data = new DataTransfer();
          data.setData("text", code);
          inputs[0].dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
          return inputs.every(e => e.value.length > 0) || inputs[0].value.length > 1;
        }, { arg: input.otp });
        if (!entered) return fail("unknown", "The verification form did not accept the code; nothing was submitted.");
        submitted = true;
        let hasSubmit = false;
        for (let i = 0; i < 10 && !hasSubmit; i++) {
          hasSubmit = await js(() => {
            const visible = e => !!e && e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) && e.getClientRects().length > 0;
            const code = [...document.querySelectorAll("input")].find(e => visible(e) && (e.autocomplete === "one-time-code" || e.maxLength === 1 || /code|otp/i.test([e.name, e.id, e.getAttribute("aria-label")].join(" "))));
            const scope = code ? code.closest('[role="dialog"], form') : null;
            const button = scope ? [...scope.querySelectorAll("button")].find(b => visible(b) && !b.disabled && b.getAttribute("aria-disabled") !== "true" && /^(?:submit|verify|continue|confirm|sign up)$/i.test((b.innerText || "").trim())) : null;
            if (!button) return false;
            button.setAttribute("data-webmcp-doordash-register", "otp-submit");
            return true;
          });
          if (!hasSubmit) await waitMs(300);
        }
        if (hasSubmit) await click('[data-webmcp-doordash-register="otp-submit"]');
        return await observe(before, true);
      }

      if (await signedInCookie() || (s.https && onSite(s.host) && s.host !== IDENTITY && s.account)) return fail("already_signed_in", "The browser is already signed in to DoorDash; sign out before registering. Nothing was submitted.");
      step = "signup_page";
      if (!(s.https && s.host === IDENTITY && s.form)) await gotoUrl(SIGNUP_URL);
      s = await settle(x => (x.form && Object.keys(x.marks).length === 5) || !!x.challenge, 20);
      if (!s) return fail("unknown", "The DoorDash sign-up form did not load with all five fields; nothing was submitted.");
      if (s.challenge && !s.form) return fail("captcha_or_challenge", s.challenge);

      step = "fill";
      const values = { first: input.first_name.trim(), last: input.last_name.trim(), email, phone: digits, password: input.password };
      for (const key of ["first", "last", "email", "phone", "password"]) {
        if (cancelled()) return fail("unknown", "The invocation was cancelled while filling the form; nothing was submitted.");
        await typeInto('[data-webmcp-doordash-register="' + key + '"]', values[key]);
      }
      s = await read();
      const check = await js(expected => {
        const get = k => document.querySelector('[data-webmcp-doordash-register="' + k + '"]');
        const d = v => v.replace(/\D/g, "");
        return get("first").value === expected.first && get("last").value === expected.last && get("email").value.trim().toLowerCase() === expected.email.toLowerCase()
          && d(get("phone").value).endsWith(expected.phone) && get("password").value.length === expected.length;
      }, { arg: { first: values.first, last: values.last, email, phone: digits, length: input.password.length } });
      if (!check) return fail("unknown", "One or more sign-up fields did not hold the typed value; nothing was submitted.");
      if (s.errors.length) return fail(classify(s.errors.join("\n"), false), s.errors.join("\n"));
      if (s.challenge) return fail("captcha_or_challenge", s.challenge);
      if (!s.submit) return fail("unknown", "The Sign Up control is missing or disabled; nothing was submitted.");
      if (remaining() < OBSERVE_MS + 3000) return fail("unknown", "Not enough of the invocation budget remains to observe a submission; nothing was submitted.");

      step = "submit";
      const armed = await js(guard => {
        const previous = Number(sessionStorage.getItem(guard.key) || 0);
        if (previous && Date.now() - previous < guard.ttl) return false;
        sessionStorage.setItem(guard.key, String(Date.now()));
        return true;
      }, { arg: { key: GUARD_KEY, ttl: GUARD_TTL_MS } });
      if (!armed) return fail("unknown", "This tab already submitted a sign-up within the last ten minutes; not submitting again. Inspect the browser first.");
      submitted = true;
      await click("form#signup-form #sign-up-submit-button");
      return await observe(s.errors, false);
    } catch {
      return fail("unknown", submitted
        ? "Browser interaction failed after the submission started; the outcome is unknown. Inspect the browser before any further attempt."
        : "Browser interaction failed before anything was submitted. Inspect the page before continuing.");
    }
  }
}]
