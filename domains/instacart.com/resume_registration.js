[{
  kind: "page",
  match: { url_patterns: ["https://instacart.com/*", "https://*.instacart.com/*"] },
  tool: {
    name: "resume_registration",
    description: "Read-only: report where an Instacart sign-up for this email or phone stands in the current tab, without submitting, resending or navigating. Returns challenge_pending when the code step for this address is open (then call complete_registration with the newest code), registered when Instacart's current-user data shows this identity signed in, existing_account when the page is on the site's log-in code path for this address, and nothing_pending otherwise (then open https://www.instacart.com/signup and call register). Use it after any uncertain register or complete_registration result instead of calling those again. A session for a different account is reported as wrong_account.",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: {
        email: { type: "string", format: "email", minLength: 6, maxLength: 254, description: "Email address of the account; required for the email channel." },
        phone: { type: "string", pattern: "^\\+?1?[\\s.()-]*[2-9][0-9]{2}[\\s.()-]*[0-9]{3}[\\s.-]*[0-9]{4}$", description: "US phone number of the account; required for the sms channel. Never returned in full." },
        channel: { type: "string", enum: ["email", "sms"], description: "Where the verification code is sent. Defaults to email, or sms when phone is given." }
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
          required: ["status", "channel", "destination_hint", "next_step", "landing_url", "evidence"],
          properties: {
            status: { type: "string", enum: ["challenge_pending", "registered", "existing_account", "nothing_pending"] },
            channel: { type: "string", enum: ["email", "sms"] },
            destination_hint: { type: "string", minLength: 1 },
            next_step: { type: "string", enum: ["complete_registration", "none", "login", "register"] },
            landing_url: { type: "string", format: "uri" },
            evidence: { type: "string", minLength: 1 }
          },
          oneOf: [
            { properties: { status: { const: "challenge_pending" }, next_step: { const: "complete_registration" } } },
            { properties: { status: { const: "registered" }, next_step: { const: "none" } } },
            { properties: { status: { const: "existing_account" }, next_step: { const: "login" } } },
            { properties: { status: { const: "nothing_pending" }, next_step: { const: "register" } } }
          ]
        },
        {
          type: "object", additionalProperties: false,
          required: ["status", "error_kind", "error_message", "error_source", "stage", "submission_attempted"],
          properties: {
            status: { const: "error" },
            error_kind: { type: "string", enum: ["invalid_input", "wrong_account", "captcha_or_challenge", "navigation_failed", "unknown"] },
            error_message: { type: "string", minLength: 1 },
            error_source: { type: "string", enum: ["site", "tool"] },
            stage: { type: "string", enum: ["input", "session_check"] },
            submission_attempted: { type: "boolean", description: "True once the email/phone or code was submitted to Instacart, even if the outcome is uncertain. Never retry automatically after that." }
          }
        }
      ]
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
  },
  execute: async (input, { signal } = {}) => {
    let submitted = false;
    let stage = "input";
    const fail = (kind, message, source = "tool", extra = {}) => ({ status: "error", error_kind: kind, error_message: redact(message), error_source: source, stage, submission_attempted: submitted, ...extra });
    const maskEmail = value => String(value).replace(/^(.)[^@]*@/, "$1***@");
    const maskPhone = value => { const digits = String(value).replace(/\D/g, ""); return digits.length >= 4 ? "***-***-" + digits.slice(-4) : "***"; };
    const normalizePhone = value => { const d = String(value).replace(/\D/g, ""); return d.length === 11 && d.startsWith("1") ? d.slice(1) : d; };
    // Site text (the code-step hint, error banners) can contain the address; mask it before it leaves the tool.
    const redact = text => String(text).replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, maskEmail).replace(/(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/g, maskPhone);
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
    const read = target => (expected => {
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
    })(target || null);
    const identity = async channel => {
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
    const ALLOWED = ["email", "phone", "channel"];
    const bad = message => fail("invalid_input", message + " Nothing was submitted.");
    if (!input || typeof input !== "object" || Array.isArray(input)) return bad("Input must be an object.");
    if (Object.keys(input).some(k => !ALLOWED.includes(k))) return bad("Unrecognized input field.");
    const channel = input.channel ?? (input.phone !== undefined ? "sms" : "email");
    if (!["email", "sms"].includes(channel)) return bad("channel must be \"email\" or \"sms\".");
    let target;
    if (channel === "email") {
      if (input.phone !== undefined) return bad("Do not pass phone for the email channel.");
      const email = typeof input.email === "string" ? input.email.trim() : "";
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length < 6 || email.length > 254) return bad("email must be a valid email address.");
      target = { channel, value: email.toLowerCase(), raw: email };
    } else {
      if (input.email !== undefined) return bad("Do not pass email for the sms channel.");
      const phone = typeof input.phone === "string" && /^\+?1?[\s.()-]*[2-9][0-9]{2}[\s.()-]*[0-9]{3}[\s.-]*[0-9]{4}$/.test(input.phone) ? normalizePhone(input.phone) : "";
      if (!/^[2-9][0-9]{9}$/.test(phone)) return bad("phone must be a 10-digit US phone number.");
      target = { channel, value: phone, raw: phone };
    }
    const hint = target.channel === "email" ? maskEmail(target.value) : maskPhone(target.value);
    const ok = (status, next_step, url, evidence) => ({ status, channel: target.channel, destination_hint: hint, next_step, landing_url: url, evidence });
    try {
      stage = "session_check";
      const s = read(target);
      if (s.proxyError || !s.onSite) return fail("navigation_failed", "This tab is showing a proxy error or another site instead of Instacart; reload an Instacart page and call again.");
      if (s.challenge) return fail("captcha_or_challenge", s.challenge, "site");
      if (s.codeStep) {
        if (s.welcomeBack && s.hintMatches !== false) return ok("existing_account", "login", s.url, s.codeHint ? redact(s.codeHint) : "Log-in code step is open.");
        if (s.hintMatches === true) return ok("challenge_pending", "complete_registration", s.url, s.codeHint ? redact(s.codeHint) : "Verification code step is open.");
        return fail("wrong_account", "The open code step is for a different or unidentified address, not " + hint + ".");
      }
      const account = compare(await identity(target.channel), target);
      if (account.state === "match") return ok("registered", "none", s.url, "Instacart's current-user data shows " + account.hint + " signed in.");
      if (account.state === "mismatch") return fail("wrong_account", "This browser is signed in as " + account.hint + ", not " + hint + ".");
      if (account.state === "unknown") return fail("unknown", account.message);
      return ok("nothing_pending", "register", s.url, "No verification step is open in this tab and no account is signed in.");
    } catch (error) {
      return fail("unknown", "The page script failed while reading the page; nothing was submitted.");
    }
  }
}]