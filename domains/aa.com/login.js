[{
  kind: "cdp",
  match: { url_patterns: ["https://aa.com/*", "https://*.aa.com/*"] },
  tool: {
    name: "login",
    description: "Submit American Airlines AAdvantage login once. When entry is needed, search DuckDuckGo for american airlines login and follow its first organic result only if it is an approved AA login URL. Fall back once to https://www.aa.com/loyalty/login if that result is missing or unsuitable, never after a challenge, uncertain navigation, or submission. Never send credentials to the search engine. Provide username and password, or explicitly use fields already filled by the human or Kernel Vault. Use a solver-free browser. CAPTCHA immediately returns human_assist_required; never solve, bypass, or retry it. manual_assist:true only inspects the current page without navigation, filling, or submission. Stops at MFA; never retries. A sessionStorage guard permits one submission per login tab storage lifetime. Results identify pre-existing versus post-submission observations. logged_in is true only for an authenticated account, not an MFA interstitial. No remember-me or SSO control was observed. Do not invoke again after an uncertain submission.",
    inputSchema: {
      type: "object",
      properties: {
        username: { type: "string", minLength: 1, description: "AAdvantage number or username, not email." },
        password: { type: "string", minLength: 1 },
        use_prefilled: { type: "boolean", description: "Submit existing username and password without reading their values into the tool." },
        manual_assist: { type: "boolean", description: "Inspect an existing AA session for manual login, CAPTCHA, MFA, or authentication. Does not navigate, fill, submit, or return session tokens." }
      },
      additionalProperties: false,
      oneOf: [
        { required: ["username", "password"], properties: { use_prefilled: { const: false }, manual_assist: { const: false } } },
        { required: ["use_prefilled"], properties: { use_prefilled: { const: true }, manual_assist: { const: false } }, not: { anyOf: [{ required: ["username"] }, { required: ["password"] }] } },
        { required: ["manual_assist"], properties: { manual_assist: { const: true } }, not: { anyOf: [{ required: ["username"] }, { required: ["password"] }, { required: ["use_prefilled"] }] } }
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
          required: ["outcome", "logged_in", "human_assist_required", "reason", "message", "landing_url", "next_step"],
          properties: {
            observation: { enum: ["pre_existing", "after_submission"] }, submission_attempted: { type: "boolean" },
            outcome: { const: "human_assist_required" }, logged_in: { const: false }, human_assist_required: { const: true },
            reason: { type: "string", enum: ["captcha_or_challenge", "manual_login"] },
            message: { type: "string", minLength: 1 }, landing_url: { type: "string" },
            next_step: { const: "complete_login_manually_in_browser" }
          }
        },
        {
          type: "object", additionalProperties: false,
          required: ["outcome", "logged_in", "error_kind", "error_message", "error_source", "attempts_remaining_if_shown", "submission_attempted"],
          properties: {
            observation: { enum: ["pre_existing", "after_submission"] },
            outcome: { const: "failure" }, logged_in: { const: false },
            error_kind: { enum: ["invalid_credentials", "mfa_failed", "locked_or_throttled", "invalid_input", "submission_already_attempted", "unknown"] },
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
    const humanAssist = (reason, message, url) => {
      const landing = new URL(url);
      return { outcome: "human_assist_required", logged_in: false, human_assist_required: true,
        reason, message, landing_url: landing.origin + landing.pathname, next_step: "complete_login_manually_in_browser",
        submission_attempted: submitted, observation: submitted ? "after_submission" : "pre_existing" };
    };
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(k => !["username", "password", "use_prefilled", "manual_assist"].includes(k)))
      return fail("invalid_input", "Expected credentials, use_prefilled: true, or manual_assist: true.");
    const prefilled = input.use_prefilled === true;
    const manual = input.manual_assist === true;
    if ((input.use_prefilled !== undefined && typeof input.use_prefilled !== "boolean") ||
        (input.manual_assist !== undefined && typeof input.manual_assist !== "boolean") ||
        (manual ? ("username" in input || "password" in input || "use_prefilled" in input) :
        prefilled ? ("username" in input || "password" in input) :
        (typeof input.username !== "string" || !input.username.trim() || typeof input.password !== "string" || !input.password)))
      return fail("invalid_input", "Supply credentials, only use_prefilled: true, or only manual_assist: true.");
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
      if (state.challenge) return { state, result: humanAssist("captcha_or_challenge", state.challenge, state.url) };
      const ax = await accessibilitySnapshot();
      const texts = ax.nodes.filter(n => ["StaticText", "heading", "alert"].includes(n.role)).map(n => n.name || "");
      const challengeText = texts.find(t => /verify (?:that )?you(?:'re| are) human|complete (?:the|this) captcha|security challenge|access denied/i.test(t));
      if (challengeText) return { state, result: humanAssist("captcha_or_challenge", challengeText, state.url) };
      const errors = [...state.alerts, ...texts.filter(t => /(?:incorrect|invalid|unrecognized) (?:username|password|credentials|code)|(?:username|password|credentials).*(?:incorrect|invalid|not match)|unable to log|could not log|account.*lock|too many (?:attempts|requests)|try again later|code.*(?:expired|incorrect|invalid)/i.test(t))];
      if (errors.length) {
        const message = [...new Set(errors)].join(" ");
        const kind = /account.*lock|too many (?:attempts|requests)|try again later/i.test(message) ? "locked_or_throttled" :
          /(?:code|otp).*(?:expired|incorrect|invalid)|(?:incorrect|invalid).*(?:code|otp)/i.test(message) ? "mfa_failed" :
          /(?:incorrect|invalid|unrecognized) (?:username|password|credentials)|(?:username|password|credentials).*(?:incorrect|invalid|not match)/i.test(message) ? "invalid_credentials" : "unknown";
        return { state, result: fail(kind, message, "site") };
      }
      const mfa = texts.find(t => /(?:we(?:'ve| have)? sent|we sent|enter).*(?:verification|security|one.time) code|choose.*(?:verification|verification method)|how should we send your code/i.test(t));
      const otp = ax.nodes.some(n => n.role === "textbox" && /verification code|security code|one.time|otp/i.test(n.name || ""));
      if (!state.password && mfa && (otp || /sent|choose|how should we send your code/i.test(mfa))) return { state, result: {
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
      if (manual) {
        const observed = await inspect();
        return observed.result || humanAssist("manual_login", "Complete login in the browser, then inspect this session again.", observed.state.url);
      }
      const current = new URL((await pageInfo()).url);
      const loginPage = current.origin === "https://login.aa.com" && current.pathname === "/login";
      let observed;
      if (["https://www.aa.com", "https://login.aa.com"].includes(current.origin)) {
        observed = await inspect();
        if (observed.result) return observed.result;
      }
      if (!loginPage || !observed?.state.username || !observed?.state.password) {
        const inspectSearch = async (selectResult) => js(({ selectResult }) => {
          if (location.origin !== "https://start.duckduckgo.com" && location.origin !== "https://duckduckgo.com") return "wrong_origin";
          const challenge = [...document.querySelectorAll("iframe")].some(e =>
            /captcha|challenge/i.test(e.src + " " + e.title) && e.checkVisibility({ checkVisibilityCSS: true, checkOpacity: true }));
          if (challenge || /verify (?:that )?you(?:'re| are) human|complete (?:the|this) captcha|security challenge|bots use DuckDuckGo|select all squares containing/i.test(document.body?.innerText || "")) return "challenge";
          if (!selectResult) return "clear";
          const first = document.querySelector('article[data-testid="result"] [data-testid="result-title-a"]');
          if (!first) return "missing";
          const target = new URL(first.href);
          if (!((target.origin === "https://www.aa.com" && target.pathname === "/loyalty/login") ||
                (target.origin === "https://login.aa.com" && target.pathname === "/login"))) return "wrong_target";
          document.querySelectorAll('[data-aa-login-result]').forEach(e => e.removeAttribute('data-aa-login-result'));
          first.setAttribute("data-aa-login-result", "true");
          first.setAttribute("target", "_self");
          return "ready";
        }, { arg: { selectResult } });
        await gotoUrl("https://start.duckduckgo.com/");
        let resultState = await inspectSearch(false);
        if (resultState === "clear") {
          await gotoUrl("https://start.duckduckgo.com/?q=american+airlines+login&ia=web");
          const searchDeadline = Date.now() + 20000;
          do {
            await waitMs(250);
            resultState = await inspectSearch(true);
            if (resultState !== "missing") break;
          } while (Date.now() < searchDeadline);
        }
        if (resultState === "challenge") return humanAssist("captcha_or_challenge", "The search page requires human verification. Complete it manually; no fallback was attempted.", (await pageInfo()).url);
        if (resultState === "ready") await click('[data-aa-login-result="true"]');
        else if (["missing", "wrong_target"].includes(resultState)) await gotoUrl("https://www.aa.com/loyalty/login");
        else return fail("unknown", "The search page left the approved search origins. Nothing was submitted and no fallback was attempted.");
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
        if (observed.result) return observed.result;
      } while (Date.now() < deadline);
      if (observed.result) return observed.result;
      return fail("unknown", "No conclusive authentication, MFA, or error state appeared within 45 seconds. Do not automatically resubmit.");
    } catch {
      return fail("unknown", submitted ? "Submission outcome is uncertain. Inspect the browser; do not retry automatically." : "Browser inspection or form preparation failed; no submission was attempted.");
    }
  }
}]
