[{
  kind: "cdp",
  match: { url_patterns: ["https://instacart.com/*", "https://*.instacart.com/*"] },
  tool: {
    name: "complete_registration",
    description: "Finish an Instacart sign-up started by register: type the six-digit code from the verification email or text into the open code step, once, then confirm through Instacart's own current-user data that the newly signed-in account is the one being registered (email must match exactly; for sms the account's phone number must match). Instacart replaces the page after it accepts the code, which is why this tool runs outside the page. Requires the code step that register left open in this same tab; it never navigates by itself, never resends a code and never retries. A rejected or expired code is reported as code_rejected or code_expired and the code is not entered again; ask for the newest code rather than guessing. A session for any other account is reported as wrong_account, never as success. Output never contains the code.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["code"],
      properties: {
        email: { type: "string", format: "email", minLength: 6, maxLength: 254, description: "Email address of the account; required for the email channel." },
        phone: { type: "string", pattern: "^\\+?1?[\\s.()-]*[2-9][0-9]{2}[\\s.()-]*[0-9]{3}[\\s.-]*[0-9]{4}$", description: "US phone number of the account; required for the sms channel. Never returned in full." },
        channel: { type: "string", enum: ["email", "sms"], description: "Where the verification code is sent. Defaults to email, or sms when phone is given." },
        code: { type: "string", pattern: "^[0-9]{6}$", description: "The newest six-digit code Instacart sent for this sign-up. Never echoed back." }
      },
      oneOf: [
        { required: ["email"], not: { required: ["phone"] }, properties: { channel: { const: "email" } } },
        { required: ["phone"], not: { required: ["email"] }, properties: { channel: { const: "sms" } } }
      ]
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false,
          required: ["status", "authenticated", "channel", "account_hint", "landing_url", "evidence", "submission_attempted"],
          properties: {
            status: { const: "registered" },
            authenticated: { const: true },
            channel: { type: "string", enum: ["email", "sms"] },
            account_hint: { type: "string", minLength: 1, description: "Masked identity of the signed-in account." },
            landing_url: { type: "string", format: "uri" },
            evidence: { type: "string", minLength: 1 },
            submission_attempted: { const: true }
          }
        },
        {
          type: "object", additionalProperties: false,
          required: ["status", "error_kind", "error_message", "error_source", "stage", "submission_attempted"],
          properties: {
            status: { const: "error" },
            error_kind: { type: "string", enum: ["invalid_input", "no_pending_registration", "existing_account", "code_rejected", "code_expired", "wrong_account", "captcha_or_challenge", "locked_or_throttled", "navigation_failed", "unknown"] },
            error_message: { type: "string", minLength: 1 },
            error_source: { type: "string", enum: ["site", "tool"] },
            stage: { type: "string", enum: ["input", "before_submit", "after_submit"] },
            submission_attempted: { type: "boolean", description: "True once the email/phone or code was submitted to Instacart, even if the outcome is uncertain. Never retry automatically after that." }
          }
        }
      ]
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false }
  },
  execute: async (input) => {
    let submitted = false;
    let stage = "input";
    const fail = (kind, message, source = "tool", extra = {}) => ({ status: "error", error_kind: kind, error_message: message, error_source: source, stage, submission_attempted: submitted, ...{}, ...extra });
    const emailGuardKey = "instacart.com.register.submitted.v1";
    const codeGuardKey = "instacart.com.register.code_submitted.v1";
    const maskEmail = value => String(value).replace(/^(.)[^@]*@/, "$1***@");
    const maskPhone = value => { const digits = String(value).replace(/\D/g, ""); return digits.length >= 4 ? "***-***-" + digits.slice(-4) : "***"; };
    const normalizePhone = value => { const d = String(value).replace(/\D/g, ""); return d.length === 11 && d.startsWith("1") ? d.slice(1) : d; };
    const classify = (message, onCodeStep) => {
      if (/too many|locked|temporarily|try again (?:later|in \d)|rate limit|slow down/i.test(message)) return "locked_or_throttled";
      if (/captcha|robot|human verification|verify (?:that )?you/i.test(message)) return "captcha_or_challenge";
      if (onCodeStep && /expired/i.test(message)) return "code_expired";
      if (onCodeStep) return "code_rejected";
      if (/valid (?:email|phone)|invalid/i.test(message)) return "invalid_input";
      return "unknown";
    };
    // Compares a signed-in identity with the target; never returns the other account's full address.
    const compare = (who, target) => {
      if (who.error === "site_changed") return { state: "unknown", message: "Instacart no longer accepts the current-user lookup this tool relies on; the tool needs updating." };
      if (who.error) return { state: "unknown", message: `The signed-in account could not be read (${who.error}).` };
      if (who.state === "logged_out") return { state: "logged_out" };
      if (target.channel === "email") {
        if (!who.email) return { state: "unknown", message: "The signed-in account has no email address, so it could not be matched." };
        return who.email === target.value ? { state: "match", hint: maskEmail(who.email) } : { state: "mismatch", hint: maskEmail(who.email) };
      }
      if (!who.phoneDigits) return { state: "unknown", message: "The signed-in account has no phone number, so it could not be matched." };
      return normalizePhone(who.phoneDigits) === target.value ? { state: "match", hint: maskPhone(target.value) } : { state: "mismatch", hint: maskPhone(who.phoneDigits) };
    };
    const reader = expected => {
      const visible = e => !!e && e.getClientRects().length > 0 && e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
      const text = e => (e.innerText || e.textContent || "").replace(/\s+/g, " ").trim();
      const all = selector => [...document.querySelectorAll(selector)].filter(visible);
      const body = (document.body?.innerText || "").replace(/\s+/g, " ").slice(0, 5000);
      const described = field => field && field.getAttribute("aria-invalid") === "true"
        ? [field.getAttribute("aria-errormessage"), field.getAttribute("aria-describedby")].filter(Boolean).map(id => document.getElementById(id)).filter(visible).map(text).find(Boolean) || null
        : null;
      // The consent box sits in an empty inner <label>; its text is on the nearest ancestor that has any.
      const labelOf = box => { let n = box; while (n && n.tagName !== "FORM" && !text(n)) n = n.parentElement; return n && n.tagName !== "FORM" ? text(n).slice(0, 400) : (box.getAttribute("aria-label") || ""); };
      const emailInput = all('input[type="email"][name="email"]')[0] || null;
      const phoneInput = all('input[type="tel"]')[0] || null;
      const form = (emailInput || phoneInput)?.closest("form") || null;
      const submit = form ? [...form.querySelectorAll('button[type="submit"]')].find(b => visible(b) && /^continue$/i.test(text(b))) || null : null;
      const checkboxes = form ? [...form.querySelectorAll('input[type="checkbox"]')].filter(visible).map((box, index) => ({ index, checked: box.checked, label: labelOf(box) })) : [];
      const extraFields = form ? [...form.querySelectorAll("input")].filter(i => visible(i) && !["email", "tel", "checkbox", "hidden", "submit"].includes(i.type)).map(i => ({ name: i.name || "", autocomplete: i.autocomplete || "", label: (i.getAttribute("aria-label") || i.placeholder || (i.id && document.querySelector(`label[for="${i.id}"]`)?.innerText) || "").trim().slice(0, 80), required: i.required || i.getAttribute("aria-required") === "true" })) : [];
      const codeInput = all('input[autocomplete="one-time-code"]')[0] || null;
      const headings = all("h1,h2,h3").map(text);
      const codeHint = codeInput ? all("p,div,span").map(text).filter(t => /sent a .*code to /i.test(t) && t.length < 300).sort((a, b) => a.length - b.length)[0] || null : null;
      const alerts = [...new Set(all('[role="alert"]').map(text).filter(Boolean))];
      const challengePattern = /verify (?:that )?you(?:'re| are) human|access denied|unusual traffic|security check|checking your browser/i;
      const challenge = [...headings, ...alerts].find(t => challengePattern.test(t)) || (challengePattern.test(body) ? body.match(challengePattern)[0] : null);
      const captchaFrame = all("iframe").find(f => /recaptcha\/(?:api2|enterprise)\/bframe/.test(f.src) && f.getBoundingClientRect().width > 100);
      const hintLower = (codeHint || "").toLowerCase();
      const hintDigits = ((codeHint || "").split(/code to /i)[1] || "").replace(/\D/g, "");
      let hintMatches = null;
      if (codeHint && expected) {
        if (expected.channel === "email" && hintLower.includes("@")) hintMatches = hintLower.includes(expected.value);
        else if (expected.channel === "sms" && hintDigits.length >= 4) hintMatches = expected.value.endsWith(hintDigits.slice(-4));
      }
      return {
        url: location.href, path: location.pathname.replace(/\/$/, "") || "/",
        onSite: location.protocol === "https:" && (location.hostname === "instacart.com" || location.hostname.endsWith(".instacart.com")),
        proxyError: /^(?:proxy proxy error|egress-proxy-mitm encountered)/i.test(body),
        emailForm: !!emailInput && !!submit, phoneForm: !!phoneInput && !!submit,
        emailValue: emailInput ? emailInput.value.trim().toLowerCase() : null,
        phoneDigits: phoneInput ? phoneInput.value.replace(/\D/g, "") : null,
        fieldError: described(emailInput) || described(phoneInput),
        checkboxes, extraFields,
        codeStep: !!codeInput, codeError: described(codeInput),
        codeHint, hintMatches,
        welcomeBack: headings.some(t => /^welcome back/i.test(t)) || (!!codeInput && /log back into|welcome back/i.test(body)),
        alerts, challenge, captchaVisible: !!captchaFrame
      };
    };
    const identityFn = async channel => {
      const query = async (operationName, sha256Hash) => {
        const url = new URL("/graphql", location.origin);
        url.searchParams.set("operationName", operationName);
        url.searchParams.set("variables", "{}");
        url.searchParams.set("extensions", JSON.stringify({ persistedQuery: { version: 1, sha256Hash } }));
        const response = await fetch(url, { headers: { "content-type": "application/json", "x-client-identifier": "web" }, credentials: "include" });
        let body = null;
        try { body = JSON.parse(await response.text()); } catch { body = null; }
        const code = body?.errors?.[0]?.extensions?.code || null;
        if (code === "PERSISTED_QUERY_NOT_SUPPORTED" || code === "PERSISTED_QUERY_NOT_FOUND") return { error: "site_changed" };
        if (!response.ok || !body?.data) return { error: `http_${response.status}` };
        return { data: body.data };
      };
      try {
        const user = await query("CurrentUser", "61e119409ed8f85dceb975375fdae9c4f4b4c885cb9d3b3a9aef26d91ffce491");
        if (user.error) return user;
        const current = user.data.currentUser;
        if (!current || current.guest) return { state: "logged_out" };
        if (channel !== "sms") return { state: "signed_in", email: typeof current.email === "string" ? current.email.trim().toLowerCase() : null, phoneDigits: null };
        const phone = await query("UsersPhoneNumber", "a5c45b39a642dd47149ad49cf06259136762352ac7498e8adb19b236e8f99e0d");
        if (phone.error) return phone;
        const digits = String(phone.data.userPhoneNumber?.phoneNumber?.phoneNumber || "").replace(/\D/g, "");
        return { state: "signed_in", email: typeof current.email === "string" ? current.email.trim().toLowerCase() : null, phoneDigits: digits || null };
      } catch {
        return { error: "fetch_failed" };
      }
    };
    const read = async target => js(reader, { arg: target || null });
    const identity = async channel => { try { return await js(identityFn, { arg: channel }); } catch { return { error: "page_replaced" }; } };
    const poll = async (target, predicate, ms) => {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) {
        try { const s = await read(target); if (predicate(s)) return s; } catch { /* Navigation can replace the execution context; only the observation is retried. */ }
        await waitMs(500);
      }
      return null;
    };
    const guard = async (key, windowMs) => js(({ key, windowMs }) => {
      const previous = Number(sessionStorage.getItem(key) || 0);
      if (previous && Date.now() - previous < windowMs) return false;
      sessionStorage.setItem(key, String(Date.now()));
      return true;
    }, { arg: { key, windowMs } });
    const releaseGuard = async key => { try { await js(({ release }) => sessionStorage.removeItem(release), { arg: { release: key } }); } catch { /* The page may already have navigated. */ } };
    const ALLOWED = ["email", "phone", "channel", "code"];
    const bad = message => fail("invalid_input", message + " Nothing was submitted.");
    if (!input || typeof input !== "object" || Array.isArray(input)) return bad("Input must be an object.");
    if (Object.keys(input).some(k => !ALLOWED.includes(k))) return bad("Unrecognized input field.");
    const channel = input.channel ?? (input.phone !== undefined ? "sms" : "email");
    if (!["email", "sms"].includes(channel)) return bad("channel must be \"email\" or \"sms\".");
    let target;
    if (channel === "email") {
      if (input.phone !== undefined) return bad("Do not pass phone for the email channel.");
      const email = typeof input.email === "string" ? input.email.trim() : "";
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return bad("email must be a valid email address.");
      target = { channel, value: email.toLowerCase(), raw: email };
    } else {
      if (input.email !== undefined) return bad("Do not pass email for the sms channel.");
      const phone = typeof input.phone === "string" ? normalizePhone(input.phone) : "";
      if (!/^[2-9][0-9]{9}$/.test(phone)) return bad("phone must be a 10-digit US phone number.");
      target = { channel, value: phone, raw: phone };
    }
    const hint = target.channel === "email" ? maskEmail(target.value) : maskPhone(target.value);
    if (typeof input.code !== "string" || !/^[0-9]{6}$/.test(input.code)) return bad("code must be the six-digit verification code.");
    try {
      stage = "before_submit";
      const s = await read(target);
      if (s.proxyError || !s.onSite) return fail("navigation_failed", "This tab is not showing Instacart's verification step (proxy error or another site). No code was entered.");
      if (s.challenge) return fail("captcha_or_challenge", s.challenge, "site");
      if (!s.codeStep) return fail("no_pending_registration", "No verification code step is open in this tab; call register first (or resume_registration to inspect). No code was entered.");
      if (s.welcomeBack) return fail("existing_account", "The open code step is Instacart's log-in path for an existing account, not a sign-up; use the login tool. No code was entered.");
      if (s.hintMatches !== true) return fail("wrong_account", "The open code step is for " + (s.codeHint ? "a different or unidentified address" : "an unidentified address") + ", not " + hint + ". No code was entered.");
      if (!await guard(codeGuardKey, 60000)) return fail("unknown", "This tab already entered a code within the last minute; inspect the page instead of entering another. No code was entered.");
      const feedback = x => [x.codeError, ...x.alerts].filter(Boolean).join(" ");
      const previous = feedback(s);
      let cleared = !previous;
      submitted = true;
      stage = "after_submit";
      await click('input[autocomplete="one-time-code"]');
      for (const digit of input.code) await pressKey(digit);
      const result = await poll(target, x => {
        const message = feedback(x);
        if (!message) cleared = true;
        return !x.onSite || x.proxyError || !!x.challenge || (!!message && (message !== previous || cleared)) || !x.codeStep;
      }, 30000);
      if (!result) return fail("unknown", "The code was entered but no result appeared within 30 seconds. Call resume_registration before any further attempt.");
      if (result.proxyError || !result.onSite) return fail("unknown", "The browser left Instacart or hit a proxy error after the code was entered; the outcome is unknown. Call resume_registration.");
      if (result.challenge) return fail("captcha_or_challenge", result.challenge, "site");
      const message = feedback(result);
      if (message && result.codeStep) {
        await releaseGuard(codeGuardKey);
        return fail(classify(message, true), message, "site");
      }
      // The code step closed: Instacart is signing in and replacing the page. Read the session until it settles.
      await waitForLoad(20);
      let account = { state: "unknown", message: "The signed-in account could not be read within 20 seconds." };
      const deadline = Date.now() + 20000;
      while (Date.now() < deadline) {
        let again = null;
        try { again = await read(target); } catch { /* The page is being replaced. */ }
        if (again?.codeStep && feedback(again)) {
          await releaseGuard(codeGuardKey);
          return fail(classify(feedback(again), true), feedback(again), "site");
        }
        const who = await identity(target.channel);
        account = who.error === "page_replaced" ? account : compare(who, target);
        if (account.state === "match" || account.state === "mismatch" || who.error === "site_changed") break;
        await waitMs(1000);
      }
      const landing = (await pageInfo()).url;
      if (account.state === "match") return { status: "registered", authenticated: true, channel: target.channel, account_hint: account.hint, landing_url: landing, evidence: "Instacart's current-user data shows " + account.hint + " signed in after the code was accepted.", submission_attempted: true };
      if (account.state === "mismatch") return fail("wrong_account", "After the code was accepted the browser is signed in as " + account.hint + ", not " + hint + ". Treat the registration as failed; log out before any further attempt.");
      if (account.state === "logged_out") return fail("unknown", "The code step closed but no account session exists; call resume_registration before any further attempt.");
      return fail("unknown", account.message);
    } catch (error) {
      return fail("unknown", submitted ? "Browser interaction failed after the code was entered; the outcome is unknown. Call resume_registration before any further attempt." : "Browser interaction failed before any code was entered.");
    }
  }
}]