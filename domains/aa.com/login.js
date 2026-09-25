[{
  kind: "cdp",
  match: { url_patterns: ["https://aa.com/*", "https://*.aa.com/*"] },
  tool: {
    name: "login",
    description: "Submit American Airlines AAdvantage login once. Provide username and password, or explicitly use fields already filled by the human or Kernel Vault. Stops at MFA or captcha; never retries. A sessionStorage guard permits one submission per login tab storage lifetime. Results identify pre-existing versus post-submission observations. logged_in is true only for an authenticated account, not an MFA interstitial. No remember-me or SSO control was observed. Do not invoke again after an uncertain submission.",
    inputSchema: {
      type: "object",
      properties: {
        username: { type: "string", minLength: 1, description: "AAdvantage number or username, not email." },
        password: { type: "string", minLength: 1 },
        use_prefilled: { type: "boolean", description: "Submit existing username and password without reading their values into the tool." }
      },
      additionalProperties: false,
      oneOf: [
        { required: ["username", "password"], properties: { use_prefilled: { const: false } } },
        { required: ["use_prefilled"], properties: { use_prefilled: { const: true } }, not: { anyOf: [{ required: ["username"] }, { required: ["password"] }] } }
      ]
    },
    outputSchema: {
      type: "object",
      required: ["observation", "submission_attempted"],
      properties: {
        observation: { enum: ["pre_existing", "after_submission"] },
        submission_attempted: { type: "boolean" }
      },
      oneOf: [
        {
          type: "object", additionalProperties: false,
          required: ["outcome", "logged_in", "first_step_succeeded", "landing_url", "account_name_or_hint", "mfa_required", "next_step"],
          properties: {
            observation: { enum: ["pre_existing", "after_submission"] }, submission_attempted: { type: "boolean" },
            outcome: { const: "authenticated" }, logged_in: { const: true }, first_step_succeeded: { const: true },
            landing_url: { type: "string" }, account_name_or_hint: { type: "string" },
            mfa_required: { const: false }, next_step: { const: "none" }
          }
        },
        {
          type: "object", additionalProperties: false,
          required: ["outcome", "logged_in", "first_step_succeeded", "landing_url", "account_name_or_hint", "mfa_required", "next_step"],
          properties: {
            observation: { enum: ["pre_existing", "after_submission"] }, submission_attempted: { type: "boolean" },
            outcome: { const: "mfa_required" }, logged_in: { const: false }, first_step_succeeded: { const: true },
            landing_url: { type: "string" }, account_name_or_hint: { type: ["string", "null"] },
            mfa_required: { const: true }, next_step: { type: "string", minLength: 1 }
          }
        },
        {
          type: "object", additionalProperties: false,
          required: ["outcome", "logged_in", "error_kind", "error_message", "error_source", "attempts_remaining_if_shown", "submission_attempted"],
          properties: {
            observation: { enum: ["pre_existing", "after_submission"] },
            outcome: { const: "failure" }, logged_in: { const: false },
            error_kind: { enum: ["invalid_credentials", "captcha_or_challenge", "mfa_failed", "locked_or_throttled", "invalid_input", "submission_already_attempted", "unknown"] },
            error_message: { type: "string", minLength: 1 }, error_source: { enum: ["site", "tool"] },
            attempts_remaining_if_shown: { type: ["integer", "null"], minimum: 0 }, submission_attempted: { type: "boolean" }
          }
        }
      ]
    },
    annotations: { destructiveHint: false, readOnlyHint: false }
  },
  execute: async (input) => {
    let submitted = false;
    const fail = (kind, message, source = "tool") => {
      const remaining = message.match(/(\d+)\s+(?:login\s+)?attempts?\s+(?:remaining|left)/i);
      return { outcome: "failure", logged_in: false, error_kind: kind, error_message: message,
        error_source: source, attempts_remaining_if_shown: remaining ? Number(remaining[1]) : null,
        submission_attempted: submitted, observation: submitted ? "after_submission" : "pre_existing" };
    };
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(k => !["username", "password", "use_prefilled"].includes(k)))
      return fail("invalid_input", "Expected username and password, or use_prefilled: true.");
    const prefilled = input.use_prefilled === true;
    if ((input.use_prefilled !== undefined && typeof input.use_prefilled !== "boolean") ||
        (prefilled ? ("username" in input || "password" in input) :
        (typeof input.username !== "string" || !input.username.trim() || typeof input.password !== "string" || !input.password)))
      return fail("invalid_input", "Supply both username and password, or only use_prefilled: true.");
    const inspect = async () => {
      const state = await js(() => {
        const all = [];
        function walk(root) { for (const e of root.querySelectorAll("*")) { all.push(e); if (e.shadowRoot) walk(e.shadowRoot); } }
        walk(document);
        const visible = e => e.getClientRects().length > 0 && e.checkVisibility({ checkVisibilityCSS: true, checkOpacity: true });
        const inputs = all.filter(e => e.tagName === "INPUT" && visible(e));
        const challenge = all.find(e => e.tagName === "IFRAME" && /challenge-assets\/.*captcha|captcha|challenge/i.test(e.src + " " + e.title) && visible(e));
        const alerts = all.filter(e => visible(e) && (e.getAttribute("role") === "alert" || e.tagName === "ADC-INLINE-NOTIFICATION"))
          .map(e => e.textContent.trim()).filter(Boolean);
        return { url: location.href, host: location.hostname, username: inputs.some(e => e.name === "username"),
          password: inputs.some(e => e.name === "password"),
          filled: ["username", "password"].every(name => inputs.some(e => e.name === name && e.value.length > 0)),
          challenge: challenge ? (challenge.title || "Visible CAPTCHA challenge") : null, alerts };
      });
      if (!["www.aa.com", "login.aa.com"].includes(state.host)) return { state, result: fail("unknown", "Stopped outside the approved airline hosts.") };
      if (state.challenge) return { state, result: fail("captcha_or_challenge", state.challenge, "site") };
      const ax = await accessibilitySnapshot();
      const texts = ax.nodes.filter(n => ["StaticText", "heading", "alert"].includes(n.role)).map(n => n.name || "");
      const errors = [...state.alerts, ...texts.filter(t => /(?:incorrect|invalid|unrecognized) (?:username|password|credentials|code)|(?:username|password|credentials).*(?:incorrect|invalid|not match)|unable to log|could not log|account.*lock|too many (?:attempts|requests)|try again later|code.*(?:expired|incorrect|invalid)/i.test(t))];
      if (errors.length) {
        const message = [...new Set(errors)].join(" ");
        const kind = /account.*lock|too many (?:attempts|requests)|try again later/i.test(message) ? "locked_or_throttled" :
          /(?:code|otp).*(?:expired|incorrect|invalid)|(?:incorrect|invalid).*(?:code|otp)/i.test(message) ? "mfa_failed" :
          /(?:incorrect|invalid|unrecognized) (?:username|password|credentials)|(?:username|password|credentials).*(?:incorrect|invalid|not match)/i.test(message) ? "invalid_credentials" : "unknown";
        return { state, result: fail(kind, message, "site") };
      }
      const mfa = texts.find(t => /(?:we(?:'ve| have)? sent|we sent|enter).*(?:verification|security|one.time) code|choose.*(?:verification|verification method)/i.test(t));
      const otp = ax.nodes.some(n => n.role === "textbox" && /verification code|security code|one.time|otp/i.test(n.name || ""));
      if (!state.password && mfa && (otp || /sent|choose/i.test(mfa))) return { state, result: {
        observation: submitted ? "after_submission" : "pre_existing", submission_attempted: submitted,
        outcome: "mfa_required", logged_in: false, first_step_succeeded: true, landing_url: state.url,
        account_name_or_hint: null, mfa_required: true, next_step: mfa
      } };
      const logout = ax.nodes.find(n => ["link", "button"].includes(n.role) && /^(?:log out|logout|sign out)$/i.test((n.name || "").trim()));
      const account = texts.find(t => /AAdvantage.*(?:#|number)|available miles|loyalty points/i.test(t));
      if (!state.password && logout && account) return { state, result: {
        observation: submitted ? "after_submission" : "pre_existing", submission_attempted: submitted,
        outcome: "authenticated", logged_in: true, first_step_succeeded: true, landing_url: state.url,
        account_name_or_hint: account, mfa_required: false, next_step: "none"
      } };
      return { state, result: null };
    };
    try {
      const current = new URL((await pageInfo()).url);
      const loginPage = current.origin === "https://login.aa.com" && current.pathname === "/login";
      const accountPage = current.origin === "https://www.aa.com" && current.pathname.startsWith("/loyalty/profile/");
      let observed;
      if (loginPage || accountPage) {
        observed = await inspect();
        if (observed.result) return observed.result;
      }
      if (!loginPage || !observed?.state.username || !observed?.state.password) {
        await gotoUrl("https://www.aa.com/loyalty/login?uri=%2floyalty%2flogin&previousPage=%2FhomePage.do&from=comp_nav");
        const deadline = Date.now() + 30000;
        do {
          await waitMs(500);
          try { observed = await inspect(); } catch { continue; }
          if (observed.result) return observed.result;
          if (observed.state.username && observed.state.password) break;
        } while (Date.now() < deadline);
      }
      observed = await inspect();
      if (observed.result) return observed.result;
      if (!observed.state.username || !observed.state.password) return fail("unknown", "The expected username and password form is not available.");
      if (prefilled && !observed.state.filled) return fail("invalid_input", "Both fields must already be filled by the human or vault.");
      if (!prefilled) {
        const filled = await js(({ username, password }) => {
          if (location.origin !== "https://login.aa.com") return false;
          function find(root, name) { for (const e of root.querySelectorAll("*")) {
            if (e.tagName === "INPUT" && e.name === name && e.getClientRects().length) return e;
            if (e.shadowRoot) { const found = find(e.shadowRoot, name); if (found) return found; }
          } }
          const user = find(document, "username"), pass = find(document, "password");
          if (!user || !pass || user.disabled || pass.disabled) return false;
          for (const [element, value] of [[user, username], [pass, password]]) {
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(element, value);
            element.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
            element.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
          }
          return user.value.length === username.length && pass.value.length === password.length;
        }, { arg: { username: input.username, password: input.password } });
        if (!filled) return fail("unknown", "Credential fields could not be filled on the approved login origin.");
      }
      let available = false;
      const readyDeadline = Date.now() + 10000;
      do {
        available = await js(() => {
          if (location.origin !== "https://login.aa.com") return false;
          function find(root) { for (const e of root.querySelectorAll("*")) {
            if (e.tagName === "ADC-BUTTON" && e.textContent.trim() === "Log in" && e.getClientRects().length) return e.shadowRoot?.querySelector("button");
            if (e.shadowRoot) { const found = find(e.shadowRoot); if (found) return found; }
          } }
          const button = find(document);
          return !!button && !button.disabled && button.getAttribute("aria-disabled") !== "true";
        });
        if (available) break;
        await waitMs(100);
      } while (Date.now() < readyDeadline);
      if (!available) return fail("unknown", "The login button did not become enabled within 10 seconds; nothing was submitted.");
      submitted = true;
      const clickResult = await js(() => {
        if (location.origin !== "https://login.aa.com") throw new Error("Origin changed before submit");
        function find(root) { for (const e of root.querySelectorAll("*")) {
          if (e.tagName === "ADC-BUTTON" && e.textContent.trim() === "Log in" && e.getClientRects().length) return e.shadowRoot?.querySelector("button");
          if (e.shadowRoot) { const found = find(e.shadowRoot); if (found) return found; }
        } }
        const button = find(document);
        if (!button || button.disabled || button.getAttribute("aria-disabled") === "true") throw new Error("Submit control changed");
        const key = "aa.com.login.submitted.v1";
        if (sessionStorage.getItem(key)) return "already_attempted";
        sessionStorage.setItem(key, "true");
        button.click();
        return "submitted";
      });
      if (clickResult === "already_attempted") {
        submitted = false;
        return fail("submission_already_attempted", "This login tab already submitted once. Further submissions are blocked; inspect the browser with the human.");
      }
      const deadline = Date.now() + 45000;
      do {
        await waitMs(750);
        try { observed = await inspect(); } catch { continue; }
        if (observed.result && observed.result.error_kind !== "captcha_or_challenge") return observed.result;
      } while (Date.now() < deadline);
      if (observed.result) return observed.result;
      return fail("unknown", "No conclusive authentication, MFA, or error state appeared within 45 seconds. Do not automatically resubmit.");
    } catch {
      return fail("unknown", submitted ? "Submission outcome is uncertain. Inspect the browser; do not retry automatically." : "Browser inspection or form preparation failed; no submission was attempted.");
    }
  }
}]
