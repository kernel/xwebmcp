[{
  kind: "page",
  match: { url_patterns: ["https://instacart.com/*", "https://*.instacart.com/*"] },
  tool: {
    name: "register",
    description: "Start creating a NEW Instacart account for a test identity and stop at the verification-code step. Call it in the tab that shows https://www.instacart.com/signup (navigate there first; this tool runs inside that page and never navigates, and returns wrong_page with that URL anywhere else). Instacart sign-up is passwordless: it sends a six-digit code to the email address (email channel) or by text to a US phone number (sms channel). The tool first checks that the browser is not signed in to an account (refuses with logged_in_session otherwise) and, for email, checks read-only whether the address already has an account, returning status existing_account without submitting anything if so (use the login tool then). Otherwise it fills only the requested address, never ticks marketing opt-ins, and submits the form exactly once; the site may run a reCAPTCHA that the browser solves while the tool waits up to 50 seconds, so invoke it with a timeout of at least 90 seconds. Success is status challenge_sent with a masked destination hint and next_step complete_registration; no account exists until complete_registration enters the code. accept_terms must be true (the form states that continuing accepts Instacart's Terms of Service, Privacy Policy and Health Data Notice); the sms channel also requires accept_sms_terms true for the site's required text-message consent. Never resends codes, never retries a submission, never places orders or changes settings. If the code step for the same address is already open it returns that state without submitting again.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["accept_terms"],
      properties: {
        email: { type: "string", format: "email", minLength: 6, maxLength: 254, description: "Email address of the account; required for the email channel." },
        phone: { type: "string", pattern: "^\\+?1?[\\s.()-]*[2-9][0-9]{2}[\\s.()-]*[0-9]{3}[\\s.-]*[0-9]{4}$", description: "US phone number of the account; required for the sms channel. Never returned in full." },
        channel: { type: "string", enum: ["email", "sms"], description: "Where the verification code is sent. Defaults to email, or sms when phone is given." },
        accept_terms: { const: true, description: "Must be true: continuing on Instacart's sign-up form accepts its Terms of Service, Privacy Policy and Health Data Notice." },
        accept_sms_terms: { type: "boolean", description: "sms channel only: must be true to tick the site's required consent to receive the verification text and account-related texts." },
        first_name: { type: "string", minLength: 1, maxLength: 60, description: "Used only if the sign-up form shows a first-name field." },
        last_name: { type: "string", minLength: 1, maxLength: 60, description: "Used only if the sign-up form shows a last-name field." }
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
          required: ["status", "channel", "destination_hint", "code_length", "next_step", "landing_url", "evidence", "submission_attempted", "resumed"],
          properties: {
            status: { const: "challenge_sent" },
            channel: { type: "string", enum: ["email", "sms"] },
            destination_hint: { type: "string", minLength: 1, description: "Masked address or phone the code was sent to." },
            code_length: { const: 6 },
            next_step: { const: "complete_registration" },
            landing_url: { type: "string", format: "uri" },
            evidence: { type: "string", minLength: 1 },
            submission_attempted: { type: "boolean" },
            resumed: { type: "boolean", description: "True when the code step was already open and nothing was submitted in this call." }
          }
        },
        {
          type: "object", additionalProperties: false,
          required: ["status", "channel", "destination_hint", "next_step", "code_sent", "message", "submission_attempted"],
          properties: {
            status: { const: "existing_account" },
            channel: { type: "string", enum: ["email", "sms"] },
            destination_hint: { type: "string", minLength: 1 },
            next_step: { const: "login" },
            code_sent: { type: ["boolean", "null"], description: "false when detected before any submission; null when the site routed the submission to its log-in path and may have sent a log-in code." },
            message: { type: "string", minLength: 1 },
            submission_attempted: { type: "boolean" }
          }
        },
        {
          type: "object", additionalProperties: false,
          required: ["status", "error_kind", "error_message", "error_source", "stage", "submission_attempted", "missing_fields", "next_url"],
          properties: {
            status: { const: "error" },
            error_kind: { type: "string", enum: ["invalid_input", "terms_not_accepted", "wrong_page", "logged_in_session", "additional_info_required", "captcha_or_challenge", "locked_or_throttled", "site_changed", "unknown"] },
            error_message: { type: "string", minLength: 1 },
            error_source: { type: "string", enum: ["site", "tool"] },
            stage: { type: "string", enum: ["input", "session_check", "availability_check", "before_submit", "after_submit"] },
            submission_attempted: { type: "boolean", description: "True once the email/phone or code was submitted to Instacart, even if the outcome is uncertain. Never retry automatically after that." }, missing_fields: { type: "array", items: { type: "string" }, description: "Form fields the site requires that were not supplied (additional_info_required)." }, next_url: { type: ["string", "null"], description: "Page to open before calling register again (wrong_page), otherwise null." }
          }
        }
      ]
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false }
  },
  execute: async (input, { signal } = {}) => {
    let submitted = false;
    let stage = "input";
    const fail = (kind, message, source = "tool", extra = {}) => ({ status: "error", error_kind: kind, error_message: redact(message), error_source: source, stage, submission_attempted: submitted, missing_fields: [], next_url: null, ...extra });
    const emailGuardKey = "instacart.com.register.submitted.v1";
    const maskEmail = value => String(value).replace(/^(.)[^@]*@/, "$1***@");
    const maskPhone = value => { const digits = String(value).replace(/\D/g, ""); return digits.length >= 4 ? "***-***-" + digits.slice(-4) : "***"; };
    const normalizePhone = value => { const d = String(value).replace(/\D/g, ""); return d.length === 11 && d.startsWith("1") ? d.slice(1) : d; };
    // Site text (the code-step hint, error banners) can contain the address; mask it before it leaves the tool.
    const redact = text => String(text).replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, maskEmail).replace(/(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/g, maskPhone);
    const classify = (message, onCodeStep) => {
      if (/too many|locked|temporarily|try again (?:later|in \d)|rate limit|slow down/i.test(message)) return "locked_or_throttled";
      if (/captcha|robot|human verification|verify (?:that )?you/i.test(message)) return "captcha_or_challenge";
      if (onCodeStep && /expired/i.test(message)) return "code_expired";
      if (onCodeStep) return "code_rejected";
      if (/valid (?:email|phone)|invalid/i.test(message)) return "invalid_input";
      return "unknown";
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
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    const poll = async (target, predicate, ms) => {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline && !signal?.aborted) {
        const s = read(target);
        if (predicate(s)) return s;
        await sleep(250);
      }
      return null;
    };
    const ALLOWED = ["email", "phone", "channel", "accept_terms", "accept_sms_terms", "first_name", "last_name"];
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
    if (input.accept_terms !== true) return fail("terms_not_accepted", "accept_terms must be true; Instacart's sign-up form treats continuing as accepting its Terms of Service, Privacy Policy and Health Data Notice. Nothing was submitted.");
    if (input.accept_sms_terms !== undefined && typeof input.accept_sms_terms !== "boolean") return bad("accept_sms_terms must be a boolean.");
    if (target.channel === "sms" && input.accept_sms_terms !== true) return fail("terms_not_accepted", "The sms channel requires accept_sms_terms true: Instacart requires consent to receive the verification text and account-related texts. Nothing was submitted.");
    if (target.channel === "email" && input.accept_sms_terms !== undefined) return bad("accept_sms_terms applies only to the sms channel.");
    for (const key of ["first_name", "last_name"]) if (input[key] !== undefined && (typeof input[key] !== "string" || !input[key].trim() || input[key].length > 60)) return bad(`${key} must be a non-empty string of at most 60 characters.`);
    const signupUrl = "https://www.instacart.com/signup";
    const setValue = (element, value) => {
      // The site's form reads values from input events; the prototype setter keeps React's value tracking in step.
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value")?.set;
      if (setter) setter.call(element, value); else element.value = value;
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
    };
    const visibleForm = () => {
      const field = [...document.querySelectorAll('input[type="email"][name="email"], input[type="tel"]')].find(e => e.getClientRects().length > 0);
      return field ? field.closest("form") : null;
    };
    const fieldKey = field => /family|last/i.test(field.autocomplete + " " + field.name + " " + field.label) ? "last_name" : /given|first/i.test(field.autocomplete + " " + field.name + " " + field.label) ? "first_name" : null;
    const consentBox = label => target.channel === "sms" && /verification code/i.test(label);
    const legalBox = label => /terms of service|privacy policy/i.test(label) && !/offers|promotion|marketing|newsletter|deals/i.test(label);
    try {
      stage = "session_check";
      let s = read(target);
      if (s.proxyError || !s.onSite) return fail("wrong_page", "This tab is not showing Instacart (proxy error or another site). Open " + signupUrl + " and call register again. Nothing was submitted.", "tool", { next_url: signupUrl });
      if (s.challenge) return fail("captcha_or_challenge", s.challenge, "site");
      if (s.codeStep) {
        if (s.welcomeBack && s.hintMatches !== false) return { status: "existing_account", channel: target.channel, destination_hint: hint, next_step: "login", code_sent: null, message: "A log-in code step is already open for an existing account; use the login tool. Nothing was submitted.", submission_attempted: false };
        if (s.hintMatches === true) return { status: "challenge_sent", channel: target.channel, destination_hint: hint, code_length: 6, next_step: "complete_registration", landing_url: s.url, evidence: s.codeHint ? redact(s.codeHint) : "Verification code step is open.", submission_attempted: false, resumed: true };
        return fail("unknown", "A verification step for a different or unidentified address is already open in this tab; reload " + signupUrl + " before registering " + hint + ". Nothing was submitted.");
      }
      const who = await identity(target.channel);
      if (who.error === "site_changed") return fail("site_changed", "Instacart no longer accepts the current-user lookup this tool relies on; the tool needs updating. Nothing was submitted.");
      if (who.error) return fail("unknown", `Could not confirm that the browser is signed out (${who.error}); nothing was submitted.`);
      if (who.state === "signed_in") return fail("logged_in_session", "This browser is signed in to an Instacart account; registering a new account here would mix identities. Log out or use a separate browser. Nothing was submitted.");
      const previous = Number(sessionStorage.getItem(emailGuardKey) || 0);
      if (previous && Date.now() - previous < 15 * 60 * 1000) return fail("unknown", "This tab already submitted a sign-up within the last 15 minutes without a conclusive result; call resume_registration or inspect the page instead of submitting again. Nothing was submitted.");
      if (s.path !== "/signup" || (!s.emailForm && !s.phoneForm)) return fail("wrong_page", "The sign-up form is not open in this tab. Navigate to " + signupUrl + " and call register again. Nothing was submitted.", "tool", { next_url: signupUrl });

      if (target.channel === "email") {
        stage = "availability_check";
        const availability = await (async address => {
      const find = (o, d = 0) => { if (!o || typeof o !== "object" || d > 10) return null; if (typeof o.authConfigurationToken === "string") return o.authConfigurationToken; for (const v of Object.values(o)) { const r = find(v, d + 1); if (r) return r; } return null; };
      let state = null;
      try { state = JSON.parse(decodeURIComponent(document.getElementById("node-apollo-state")?.textContent || "")); } catch { state = null; }
      const token = find(state);
      if (!token) return { error: "no_token" };
      try {
        const url = new URL("/graphql", location.origin);
        url.searchParams.set("operationName", "GetEmailAvailability");
        url.searchParams.set("variables", JSON.stringify({ email: address, authConfigurationToken: token }));
        url.searchParams.set("extensions", JSON.stringify({ persistedQuery: { version: 1, sha256Hash: "f2f32834e2e4323c367032dd92b38759ee01f4aaa47cbdea712da23aecace56d" } }));
        const response = await fetch(url, { headers: { "content-type": "application/json", "x-client-identifier": "web" }, credentials: "include" });
        let body = null;
        try { body = JSON.parse(await response.text()); } catch { body = null; }
        const code = body?.errors?.[0]?.extensions?.code || null;
        if (code === "PERSISTED_QUERY_NOT_SUPPORTED" || code === "PERSISTED_QUERY_NOT_FOUND") return { error: "site_changed" };
        if (response.status === 429) return { error: "throttled" };
        const availability = body?.data?.getEmailAvailability?.availability;
        if (availability !== "available" && availability !== "unavailable") return { error: `http_${response.status}` };
        return { availability };
      } catch {
        return { error: "fetch_failed" };
      }
    })(target.raw);
        if (availability.error === "site_changed") return fail("site_changed", "Instacart no longer accepts the email availability lookup this tool relies on; the tool needs updating. Nothing was submitted.");
        if (availability.error === "throttled") return fail("locked_or_throttled", "Instacart rate-limited the email availability lookup; wait before retrying. Nothing was submitted.", "site");
        if (availability.error) return fail("unknown", `The email availability lookup failed (${availability.error}); nothing was submitted.`);
        if (availability.availability === "unavailable") return { status: "existing_account", channel: "email", destination_hint: hint, next_step: "login", code_sent: false, message: "An Instacart account already exists for " + hint + "; use the login tool. Nothing was submitted.", submission_attempted: false };
      }

      stage = "before_submit";
      const wanted = target.channel === "sms" ? "phoneForm" : "emailForm";
      if (!s[wanted]) {
        const switchLabel = target.channel === "sms" ? "Phone" : "Email";
        const toggle = [...document.querySelectorAll("button")].find(b => b.getClientRects().length > 0 && (b.innerText || "").trim() === switchLabel);
        if (!toggle) return fail("site_changed", `The sign-up page has no ${switchLabel} option. Nothing was submitted.`);
        toggle.click();
        s = await poll(target, x => x[wanted] || !!x.challenge, 5000);
        if (!s || !s[wanted]) return fail("site_changed", `The ${target.channel === "sms" ? "phone" : "email"} sign-up form did not open. Nothing was submitted.`);
      }
      const missing = [];
      for (const field of s.extraFields) {
        const key = fieldKey(field);
        if (key && input[key] !== undefined) continue;
        if (field.required || key) missing.push(key || field.label || field.name || "unnamed field");
      }
      if (missing.length) return fail("additional_info_required", "The sign-up form asks for fields that were not supplied: " + missing.join(", ") + ". Nothing was submitted.", "tool", { missing_fields: missing });
      const form = visibleForm();
      const inputs = form ? [...form.querySelectorAll("input")].filter(i => i.getClientRects().length > 0) : [];
      const addressInput = inputs.find(i => i.type === (target.channel === "sms" ? "tel" : "email"));
      const submit = form && [...form.querySelectorAll('button[type="submit"]')].find(b => b.getClientRects().length > 0 && /^continue$/i.test((b.innerText || "").trim()));
      if (!addressInput || !submit) return fail("site_changed", "The sign-up form changed while it was being filled. Nothing was submitted.");
      setValue(addressInput, target.channel === "sms" ? target.value : target.raw);
      for (const field of s.extraFields) {
        const key = fieldKey(field);
        const element = inputs.find(i => (field.name && i.name === field.name) || (!field.name && field.autocomplete && i.autocomplete === field.autocomplete));
        if (key && input[key] !== undefined && element) setValue(element, input[key].trim());
      }
      // Tick only the consent the chosen channel requires; leave every other box (marketing, offers) as the site set it, and refuse a pre-ticked one.
      const boxes = [...form.querySelectorAll('input[type="checkbox"]')].filter(b => b.getClientRects().length > 0 && b.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }));
      for (const box of read(target).checkboxes) {
        if (consentBox(box.label) || legalBox(box.label)) {
          if (!box.checked) boxes[box.index].click();
        } else if (box.checked) {
          return fail("unknown", "The sign-up form has a pre-ticked optional box (" + box.label.slice(0, 120) + "); refusing to submit an opt-in that was not requested. Nothing was submitted.");
        }
      }
      await sleep(300);
      s = read(target);
      if (s.challenge) return fail("captcha_or_challenge", s.challenge, "site");
      if (target.channel === "email" ? s.emailValue !== target.value : normalizePhone(s.phoneDigits || "") !== target.value) return fail("unknown", "The form did not receive the supplied address. Nothing was submitted.");
      if (s.checkboxes.some(b => (consentBox(b.label) || legalBox(b.label)) && !b.checked)) return fail("unknown", "A required consent box could not be ticked. Nothing was submitted.");
      if (Number(sessionStorage.getItem(emailGuardKey) || 0) > previous) return fail("unknown", "Another invocation submitted a sign-up in this tab meanwhile; call resume_registration. Nothing was submitted.");
      const feedback = x => [x.fieldError, ...x.alerts].filter(Boolean).join(" ");
      const previousFeedback = feedback(s);
      let cleared = !previousFeedback;
      sessionStorage.setItem(emailGuardKey, String(Date.now()));
      submitted = true;
      stage = "after_submit";
      submit.click();
      let sawCaptcha = false;
      const result = await poll(target, x => {
        if (x.captchaVisible) sawCaptcha = true;
        const message = feedback(x);
        if (!message) cleared = true;
        return !x.onSite || x.proxyError || !!x.challenge || x.codeStep || x.welcomeBack || (!!message && (message !== previousFeedback || cleared));
      }, 50000);
      if (!result) {
        if (sawCaptcha) return fail("captcha_or_challenge", "A reCAPTCHA challenge was shown after submitting and was not resolved within 50 seconds. Do not resubmit; call resume_registration later.", "site");
        return fail("unknown", "The sign-up was submitted but no verification step appeared within 50 seconds. Call resume_registration before any further attempt.");
      }
      if (result.proxyError || !result.onSite) return fail("unknown", "The page showed a proxy error or left Instacart after submitting; the outcome is unknown. Call resume_registration before any further attempt.");
      if (result.challenge) return fail("captcha_or_challenge", result.challenge, "site");
      if (result.welcomeBack && result.hintMatches !== false) return { status: "existing_account", channel: target.channel, destination_hint: hint, next_step: "login", code_sent: null, message: "Instacart routed this sign-up to its log-in path because an account already exists for " + hint + "; it may have sent a log-in code. Use the login tool; do not enter that code with complete_registration.", submission_attempted: true };
      const message = feedback(result);
      if (message && !result.codeStep && (message !== previousFeedback || cleared)) {
        const kind = classify(message, false);
        if (kind === "invalid_input") sessionStorage.removeItem(emailGuardKey);
        return fail(kind, message, "site");
      }
      if (result.hintMatches === false) return fail("unknown", "Instacart opened a verification step for a different address than " + hint + ". Do not enter a code; inspect the page.");
      return { status: "challenge_sent", channel: target.channel, destination_hint: hint, code_length: 6, next_step: "complete_registration", landing_url: result.url, evidence: result.codeHint ? redact(result.codeHint) : "Verification code step is open.", submission_attempted: true, resumed: false };
    } catch (error) {
      return fail("unknown", submitted ? "The page script failed after the sign-up was submitted; the outcome is unknown. Call resume_registration before any further attempt." : "The page script failed before anything was submitted.");
    }
  }
}]