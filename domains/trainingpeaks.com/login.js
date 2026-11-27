[{
  kind: "cdp",
  match: { url_patterns: ["https://trainingpeaks.com/*", "https://*.trainingpeaks.com/*"] },
  tool: {
    name: "login",
    description: "Sign in to TrainingPeaks (https://home.trainingpeaks.com/login) with a username and password, and confirm the session belongs to exactly that username. If the browser already has a TrainingPeaks session it submits nothing: the same username returns success with entry already_signed_in, a different one fails with wrong_account (sign out first; this tool never switches or signs out accounts). Otherwise it loads a fresh login page, waits for the page's own reCAPTCHA token, fills the Login form and submits it once; it never retries. Success leaves the tab on the TrainingPeaks app, where the other trainingpeaks.com tools run. A rejected password returns invalid_credentials: do not loop on it, the account may be locked. A second-factor prompt returns mfa_required and is left open in the page. The whole call is bounded to about 80 seconds, so invoke it with a timeout of at least 90 seconds. The password is only typed into the TrainingPeaks form and never returned.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["username", "password"],
      properties: {
        username: { type: "string", minLength: 1, maxLength: 254, pattern: "^\\S+$", description: "TrainingPeaks username (or account email) as typed into the Username field." },
        password: { type: "string", minLength: 1, maxLength: 256, description: "Account password; never returned or logged." }
      }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false, required: ["status", "logged_in", "account", "entry", "submission_attempted", "landing_url", "next_actions"],
          properties: {
            status: { const: "ok" }, logged_in: { const: true },
            account: {
              type: "object", additionalProperties: false, required: ["username", "user_id", "is_athlete"],
              properties: { username: { type: "string" }, user_id: { type: "integer" }, is_athlete: { type: ["boolean", "null"] } },
              description: "The signed-in user as TrainingPeaks reports it; username always matches the supplied username or email."
            },
            entry: { enum: ["already_signed_in", "form_submitted"] },
            submission_attempted: { type: "boolean" },
            landing_url: { type: "string", format: "uri" },
            next_actions: { type: "array", items: { type: "string" } }
          }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "logged_in", "error_kind", "error_message", "error_source", "step", "submission_attempted", "signed_in_account"],
          properties: {
            status: { const: "error" }, logged_in: { const: false },
            error_kind: { enum: ["invalid_input", "wrong_account", "invalid_credentials", "mfa_required", "captcha_unavailable", "locked_or_throttled", "recent_submission", "unknown"] },
            error_message: { type: "string", minLength: 1 },
            error_source: { enum: ["site", "tool"] },
            step: { enum: ["input", "session_check", "login_form", "before_submit", "after_submit"] },
            submission_attempted: { type: "boolean" },
            signed_in_account: { type: ["string", "null"], description: "For wrong_account: the username TrainingPeaks is actually signed in to." }
          }
        }
      ]
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false }
  },
  execute: async (input) => {
    const LOGIN = "https://home.trainingpeaks.com/login";
    const MARKER = "xwebmcp.trainingpeaks.login_submitted_at";
    const startedAt = Date.now();
    const remaining = () => 80000 - (Date.now() - startedAt);
    let step = "input";
    let submitted = false;
    const fail = (kind, message, source = "tool", signedIn = null) => ({ status: "error", logged_in: false, error_kind: kind, error_message: message, error_source: source, step, submission_attempted: submitted, signed_in_account: signedIn });
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => !["username", "password"].includes(key))) return fail("invalid_input", "Input must be { username, password }; nothing was submitted.");
    const { username, password } = input;
    if (typeof username !== "string" || !username.trim() || username.trim().length > 254 || /\s/.test(username.trim())) return fail("invalid_input", "username must be 1-254 characters without spaces; nothing was submitted.");
    if (typeof password !== "string" || !password.length || password.length > 256) return fail("invalid_input", "password must be 1-256 characters; nothing was submitted.");
    const wanted = username.trim().toLowerCase();
    const matches = account => !!account && (account.username.toLowerCase() === wanted || (account.email || "").toLowerCase() === wanted);
    const ok = (account, entry, url) => ({
      status: "ok", logged_in: true, entry, submission_attempted: submitted, landing_url: url,
      account: { username: account.username, user_id: account.user_id, is_athlete: account.is_athlete },
      next_actions: ["Call get_page_context({ wait_for_settled_seconds: 10 }) and list tools again: the tab may be on another page and earlier tool_refs are no longer valid.", "For days off, open the calendar with navigate_to_page({ url: \"#calendar\" }) and use list_availability or add_availability."]
    });
    // The signed-in user, read through the same session API the TrainingPeaks app uses; null when signed out.
    const whoami = () => js(async () => {
      try {
        const tokenRes = await fetch("https://tpapi.trainingpeaks.com/users/v3/token", { credentials: "include" });
        if (!tokenRes.ok) return null;
        const body = await tokenRes.json();
        const token = body && body.token && body.token.access_token;
        if (!token) return null;
        const userRes = await fetch("https://tpapi.trainingpeaks.com/users/v3/user", { headers: { Authorization: "Bearer " + token } });
        if (!userRes.ok) return null;
        const data = await userRes.json();
        const u = data && (data.user || data);
        if (!u || typeof u.userId !== "number") return null;
        return { username: String(u.userName || u.username || ""), email: u.email ? String(u.email) : null, user_id: u.userId, is_athlete: typeof u.isAthlete === "boolean" ? u.isAthlete : null };
      } catch { return null; }
    });
    const read = () => js(() => {
      const visible = e => !!e && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== "hidden";
      const user = document.getElementById("Username");
      const pass = document.getElementById("Password");
      const errors = [...document.querySelectorAll(".validation-summary-errors li, .validation-summary-errors, .field-validation-error, [role=alert]")]
        .filter(visible).map(e => e.textContent.trim()).filter(Boolean);
      const codeField = [...document.querySelectorAll("input")].find(e => visible(e) && e.type !== "hidden" && e.type !== "password" && e.id !== "Username" && /one-time-code|otp|mfa|2fa|two.?factor|verification|code/i.test([e.autocomplete, e.id, e.name, e.placeholder, e.getAttribute("aria-label")].join(" ")));
      const tokenField = document.getElementById("captcha-token");
      return {
        url: location.href, host: location.hostname, path: location.pathname,
        form: visible(user) && visible(pass) && visible(document.getElementById("btnSubmit")),
        captcha_ready: !!(tokenField && tokenField.value),
        error: errors[0] || null,
        code_step: !!codeField || /\/(mfa|verify|two-?factor)/i.test(location.pathname),
        marker: (() => { try { return Number(sessionStorage.getItem("xwebmcp.trainingpeaks.login_submitted_at")) || 0; } catch { return 0; } })()
      };
    });
    let latest = null;
    const poll = async (predicate, ms) => {
      const deadline = Date.now() + Math.min(ms, remaining());
      while (Date.now() < deadline) {
        try { latest = await read(); if (await predicate(latest)) return latest; } catch { /* the document is being replaced */ }
        await waitMs(500);
      }
      return null;
    };

    step = "session_check";
    let info = null;
    try { info = await pageInfo(); } catch { /* no usable page yet */ }
    if (!info || !/^https:\/\/([a-z0-9-]+\.)*trainingpeaks\.com\//.test(info.url)) {
      await gotoUrl(LOGIN);
      await waitForLoad(30);
    }
    const current = await whoami();
    if (current) {
      if (!matches(current)) return fail("wrong_account", "The browser is already signed in to a different TrainingPeaks account. Sign out before signing in as the supplied username; nothing was submitted.", "tool", current.username);
      const here = await pageInfo();
      return ok(current, "already_signed_in", here.url);
    }

    step = "login_form";
    // The page fetches a reCAPTCHA v3 token on load and it expires after two minutes, so always start from a fresh login page.
    await gotoUrl(LOGIN);
    await waitForLoad(30);
    if (!await poll(s => s.form, 20000)) return fail("unknown", "The TrainingPeaks login form did not appear" + (latest ? " (the tab is on " + latest.host + latest.path + ")" : "") + "; nothing was submitted.");
    step = "before_submit";
    if (latest.marker && Date.now() - latest.marker < 60000) return fail("recent_submission", "A sign-in was submitted from this tab less than a minute ago with no observed result. Check the page before invoking again; nothing was submitted.");
    if (!await poll(s => s.captcha_ready, 15000)) return fail("captcha_unavailable", "The login page's reCAPTCHA token was not issued, so the form would be rejected; nothing was submitted.");
    if (remaining() < 30000) return fail("unknown", "Too little time remains to observe the result; nothing was submitted.");
    await fillInput("#Username", username.trim());
    await fillInput("#Password", password);
    const filled = await js(expected => document.getElementById("Username").value.trim().toLowerCase() === expected && document.getElementById("Password").value.length > 0 && document.activeElement === document.getElementById("Password"), { arg: wanted });
    if (!filled) return fail("unknown", "The login form did not accept the typed values; nothing was submitted.");
    await js(key => { try { sessionStorage.setItem(key, String(Date.now())); } catch { /* storage unavailable */ } }, { arg: MARKER });
    // Press Enter in the focused Password field: the cookie-consent overlay can cover the Login button, and a
    // keyboard submit sends the same form without making a consent choice for the user.
    try {
      submitted = true;
      await pressKey("Enter");
    } catch (error) {
      if (!submitted) {
        await js(key => { try { sessionStorage.removeItem(key); } catch { /* storage unavailable */ } }, { arg: MARKER });
        return fail("unknown", "The login form could not be submitted (" + String(error && error.message || error).slice(0, 120) + "); nothing was submitted.");
      }
    }

    step = "after_submit";
    let account = null;
    const done = await poll(async s => {
      if (s.code_step || (s.error && s.path.toLowerCase().startsWith("/login"))) return true;
      if (s.form) return false;
      account = await whoami();
      return !!account;
    }, remaining() - 1000);
    const clearMarker = async () => { try { await js(key => { try { sessionStorage.removeItem(key); } catch { /* storage unavailable */ } }, { arg: MARKER }); } catch { /* now on another origin */ } };
    if (!done) return fail("unknown", "No result was observed after submitting the form; the sign-in may still complete. Check the page before invoking again.");
    if (account) {
      await clearMarker();
      if (!matches(account)) return fail("wrong_account", "TrainingPeaks signed in, but to a different account than the supplied username. Sign out and try again.", "site", account.username);
      return ok(account, "form_submitted", done.url);
    }
    await clearMarker();
    if (done.code_step) return fail("mfa_required", "TrainingPeaks asked for a second factor, which this tool does not enter; finish it in the page.", "site");
    const text = done.error;
    if (/too many|locked|try again later/i.test(text)) return fail("locked_or_throttled", "TrainingPeaks: " + text, "site");
    if (/incorrect|invalid|wrong|not found|password|username/i.test(text)) return fail("invalid_credentials", "TrainingPeaks: " + text, "site");
    return fail("unknown", "TrainingPeaks: " + text, "site");
  }
}]
