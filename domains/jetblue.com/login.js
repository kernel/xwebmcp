[{
  kind: "cdp",
  match: { url_patterns: ["https://jetblue.com/*", "https://*.jetblue.com/*"] },
  tool: {
    name: "login",
    description: "Enter JetBlue through a DuckDuckGo search for jetblue login and submit the username/password form at most once. Reports four states: authenticated, mfa_required, human_assist_required, and failed. CAPTCHAs and other challenges are reported as human_assist_required and are never solved, bypassed, or worked around; the supported path is a person signing in through the browser live view, after which mode \"capture_session\" records the resulting session. Never creates accounts and never guesses or retries credentials.",
    inputSchema: {
      type: "object",
      properties: {
        mode: { enum: ["login", "await_human_login", "capture_session"], default: "login" },
        username: { type: "string", minLength: 1, maxLength: 320 },
        password: { type: "string", minLength: 1, maxLength: 1024 },
        remember_me: { type: "boolean", default: false },
        use_filled_form: { type: "boolean", default: false },
        wait_seconds: { type: "integer", minimum: 10, maximum: 600, default: 180 }
      },
      additionalProperties: false,
      oneOf: [
        {
          required: ["username", "password"],
          properties: { mode: { enum: ["login"] }, use_filled_form: { const: false } },
          not: { required: ["wait_seconds"] }
        },
        {
          required: ["use_filled_form"],
          properties: { mode: { enum: ["login"] }, use_filled_form: { const: true } },
          not: { anyOf: [{ required: ["username"] }, { required: ["password"] }, { required: ["wait_seconds"] }] }
        },
        {
          required: ["mode"],
          properties: { mode: { const: "await_human_login" } },
          not: { anyOf: [{ required: ["username"] }, { required: ["password"] }, { required: ["use_filled_form"] }] }
        },
        {
          required: ["mode"],
          properties: { mode: { const: "capture_session" } },
          not: { anyOf: [{ required: ["username"] }, { required: ["password"] }, { required: ["use_filled_form"] }, { required: ["wait_seconds"] }] }
        }
      ]
    },
    outputSchema: {
      type: "object",
      required: ["status", "submission_attempted"],
      oneOf: [
        {
          type: "object", additionalProperties: false,
          required: ["status", "landing_url", "account_name_or_hint", "evidence", "session", "submission_attempted"],
          properties: {
            status: { const: "authenticated" },
            landing_url: { type: "string", format: "uri" },
            account_name_or_hint: { type: ["string", "null"] },
            evidence: { type: "string", minLength: 1 },
            session: {
              type: "object", additionalProperties: false,
              required: ["cookie_read_ok", "cookie_count", "cookie_names", "values_returned"],
              properties: {
                cookie_read_ok: { type: "boolean" },
                cookie_count: { type: "integer", minimum: 0 },
                cookie_names: { type: "array", items: { type: "string" } },
                values_returned: { const: false }
              }
            },
            submission_attempted: { type: "boolean" }
          }
        },
        {
          type: "object", additionalProperties: false,
          required: ["status", "landing_url", "mfa_prompt", "next_step", "submission_attempted"],
          properties: {
            status: { const: "mfa_required" },
            landing_url: { type: "string", format: "uri" },
            mfa_prompt: { type: "string", minLength: 1 },
            next_step: { const: "complete_mfa" },
            submission_attempted: { type: "boolean" }
          }
        },
        {
          type: "object", additionalProperties: false,
          required: ["status", "landing_url", "assist_reason", "challenge_evidence", "automated_solving", "handoff", "next_step", "submission_attempted"],
          properties: {
            status: { const: "human_assist_required" },
            landing_url: { type: "string", format: "uri" },
            assist_reason: { enum: ["captcha_or_challenge", "unsupported_verification_method", "pending_human_login"] },
            challenge_evidence: { type: "string", minLength: 1 },
            automated_solving: { const: "not_implemented" },
            handoff: {
              type: "object", additionalProperties: false,
              required: ["action", "page_url", "instructions"],
              properties: {
                action: { const: "open_browser_live_view_and_sign_in_manually" },
                page_url: { type: "string", format: "uri" },
                instructions: { type: "string", minLength: 1 }
              }
            },
            next_step: { const: "human_login_then_capture_session" },
            submission_attempted: { type: "boolean" }
          }
        },
        {
          type: "object", additionalProperties: false,
          required: ["status", "error_kind", "error_message", "attempts_remaining_if_shown", "message_source", "submission_attempted"],
          properties: {
            status: { const: "failed" },
            error_kind: { enum: ["invalid_credentials", "mfa_failed", "locked_or_throttled", "validation_error", "unknown"] },
            error_message: { type: "string", minLength: 1 },
            attempts_remaining_if_shown: { type: ["integer", "null"], minimum: 0 },
            message_source: { enum: ["site", "tool"] },
            submission_attempted: { type: "boolean" }
          }
        }
      ]
    },
    annotations: { destructiveHint: false, readOnlyHint: false }
  },
  execute: async (input) => {
    let submitted = false;
    const failure = (kind, message, source = "tool") => {
      const remaining = message.match(/(\d+)\s+(?:sign.in\s+)?attempts?\s+(?:remaining|left)/i);
      return { status: "failed", error_kind: kind, error_message: message,
        attempts_remaining_if_shown: remaining ? Number(remaining[1]) : null,
        message_source: source, submission_attempted: submitted };
    };
    const assist = (reason, evidence, url) => ({
      status: "human_assist_required", landing_url: url, assist_reason: reason,
      challenge_evidence: evidence, automated_solving: "not_implemented",
      handoff: {
        action: "open_browser_live_view_and_sign_in_manually",
        page_url: url,
        instructions: "Open this browser session's live view and sign in by hand, then invoke this tool again with mode \"capture_session\". This tool does not solve challenges, register accounts, or reuse credentials after a challenge."
      },
      next_step: "human_login_then_capture_session", submission_attempted: submitted
    });
    const keys = ["mode", "username", "password", "remember_me", "use_filled_form", "wait_seconds"];
    if (!input || typeof input !== "object" || Array.isArray(input) ||
        Object.keys(input).some(k => !keys.includes(k)) ||
        (input.mode !== undefined && !["login", "await_human_login", "capture_session"].includes(input.mode)) ||
        (input.remember_me !== undefined && typeof input.remember_me !== "boolean") ||
        (input.use_filled_form !== undefined && typeof input.use_filled_form !== "boolean") ||
        (input.wait_seconds !== undefined && (!Number.isInteger(input.wait_seconds) || input.wait_seconds < 10 || input.wait_seconds > 600))) {
      return failure("validation_error", "Invalid login input; no submission made.");
    }
    const mode = input.mode ?? "login";
    if (mode === "login") {
      if (input.use_filled_form === true) {
        if (input.username !== undefined || input.password !== undefined) return failure("validation_error", "Do not combine credentials with use_filled_form.");
      } else if (typeof input.username !== "string" || !input.username.trim() || input.username.length > 320 ||
                 typeof input.password !== "string" || !input.password.length || input.password.length > 1024) {
        return failure("validation_error", "Both username and password are required; no submission made.");
      }
    } else if (input.username !== undefined || input.password !== undefined || input.use_filled_form !== undefined) {
      return failure("validation_error", "Credential fields are not accepted in " + mode + " mode; no submission made.");
    }
    const readState = async () => js(`(() => {
      const visible = e => !!e && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden';
      const all = selector => [...document.querySelectorAll(selector)].filter(visible);
      const text = e => (e.innerText || e.textContent || '').trim();
      const errors = [...new Set(all('[role="alert"], .o-form-error-container, .o-form-input-error').map(text).filter(Boolean))];
      const headings = all('h1,h2,h3,[role="heading"]').map(text);
      const controls = all('a,button,input[type="submit"]').map(e => e.tagName === 'INPUT' ? e.value : text(e));
      const challengeFrame = all('iframe').find(e => /recaptcha|hcaptcha|captcha|challenge|turnstile|arkose|funcaptcha/i.test(e.title + ' ' + e.src));
      const challengeText = [...headings, ...errors, ...all('[role="dialog"]').map(text), ...all('p,div,span').map(text).filter(t => t.length <= 240)].find(t => /verify (?:that )?you are human|security check|complete the captcha|i am not a robot|press and hold|access denied|unusual traffic/i.test(t));
      const identifier = document.querySelector('input[name="identifier"]');
      const password = document.querySelector('input[type="password"][name="credentials.passcode"]');
      const mfaHeading = headings.find(t => /verify your identity|verify with|enter.*(?:verification|security).*code|two.step verification|multi.factor authentication|(?:get|send)(?: me)? (?:a |an )?verification email|we sent an email/i.test(t));
      const code = all('input[autocomplete="one-time-code"],input[name="credentials.passcode"]').some(e => e.type !== 'password');
      const mfaChoice = controls.some(t => /send (?:a )?code|send me an email|select|verify/i.test(t));
      const passkey = [...headings, ...controls].find(t => /passkey|security key|windows hello|touch id|face id|biometric/i.test(t));
      return { origin: location.origin, path: location.pathname, url: location.origin + location.pathname,
        errors, hasForm: visible(identifier) && visible(password),
        fieldsReady: visible(identifier) && visible(password) && !!identifier.value.trim() && !!password.value,
        submitReady: all('input[type="submit"]').some(e => e.value.toLowerCase() === 'sign in' && !e.disabled),
        remember: document.querySelector('input[name="rememberMe"]')?.checked ?? null,
        challenge: challengeText || (challengeFrame ? (challengeFrame.title || 'Visible CAPTCHA/challenge iframe') : null),
        mfa: !visible(password) && mfaHeading && (code || mfaChoice) ? mfaHeading : null,
        passkey: !visible(password) && passkey ? passkey : null,
        account: controls.find(t => /^(?:sign out|log out)$/i.test(t)) || null };
    })()`);
    const sessionFacts = async () => {
      try {
        const { cookies } = await cdp("Storage.getCookies", {}, null);
        const scoped = cookies.filter(c => /(^|\.)jetblue\.com$/.test(String(c.domain).replace(/^\./, "")));
        return { cookie_read_ok: true, cookie_count: scoped.length,
          cookie_names: [...new Set(scoped.map(c => c.name))].sort(), values_returned: false };
      } catch {
        return { cookie_read_ok: false, cookie_count: 0, cookie_names: [], values_returned: false };
      }
    };
    const authenticated = async state => ({
      status: "authenticated", landing_url: state.url, account_name_or_hint: state.account,
      evidence: state.account, session: await sessionFacts(), submission_attempted: submitted
    });
    // Challenges and unsupported verification are outcomes to hand to a person, not failures to retry.
    const classify = async state => {
      if (state.origin !== "https://www.jetblue.com") return failure("unknown", "Navigation left the approved origin; no further interaction performed.");
      if (state.challenge) return assist("captcha_or_challenge", state.challenge, state.url);
      const message = state.errors.join("\n");
      if (message) {
        if (/captcha|challenge|robot|human verification/i.test(message)) return assist("captcha_or_challenge", message, state.url);
        let kind = "unknown";
        if (/locked|too many|try again later|rate.limit|temporarily blocked/i.test(message)) kind = "locked_or_throttled";
        else if (/(?:invalid|incorrect|expired).*(?:code|otp)|(?:code|otp).*(?:invalid|incorrect|expired)/i.test(message)) kind = "mfa_failed";
        else if (/unable to sign in|invalid (?:username|password|credentials)|incorrect (?:username|password)/i.test(message)) kind = "invalid_credentials";
        else if (/required|cannot be blank|please enter/i.test(message)) kind = "validation_error";
        return failure(kind, message, "site");
      }
      if (state.account && !state.hasForm) return authenticated(state);
      if (state.passkey && !state.mfa) return assist("unsupported_verification_method", state.passkey, state.url);
      if (state.mfa) return { status: "mfa_required", landing_url: state.url, mfa_prompt: state.mfa,
        next_step: "complete_mfa", submission_attempted: submitted };
      return null;
    };
    const hasSearchReferrer = async () => js(() => {
      try {
        return ["https://duckduckgo.com", "https://start.duckduckgo.com"].includes(new URL(document.referrer).origin);
      } catch {
        return false;
      }
    });
    try {
      if (mode === "capture_session") {
        const state = await readState();
        return await classify(state) || failure("unknown", "No authenticated JetBlue session is visible on this page; sign in through the live view first.");
      }
      if (mode === "await_human_login") {
        const deadline = Date.now() + (input.wait_seconds ?? 180) * 1000;
        let last = await readState();
        while (Date.now() < deadline) {
          if (last.account && !last.hasForm) return await authenticated(last);
          await waitMs(2000);
          try {
            last = await readState();
          } catch {
            // The human's own navigation can replace the execution context mid-poll.
          }
        }
        return assist("pending_human_login", last.challenge || last.passkey || last.mfa ||
          "Waiting for a person to finish signing in; no authenticated session yet.", last.url);
      }
      const current = new URL((await pageInfo()).url);
      const atLogin = current.origin === "https://www.jetblue.com" && /^\/signin\/?$/.test(current.pathname);
      if (atLogin) {
        const existing = await readState();
        if (existing.challenge || existing.mfa || existing.passkey || existing.account || existing.errors.length) {
          const result = await classify(existing);
          if (result) return result;
        }
      }
      if (input.use_filled_form && !atLogin) return failure("validation_error", "Prefilled mode requires the canonical JetBlue sign-in page; no navigation or submission made.");
      if (!atLogin || (!input.use_filled_form && !await hasSearchReferrer())) {
        await gotoUrl("https://start.duckduckgo.com/");
        if (!await waitForElement('input[role="combobox"],input[type="text"]', { timeoutSec: 20 })) {
          return failure("unknown", "DuckDuckGo search form did not become available; no login submission made.");
        }
        const searchPage = new URL((await pageInfo()).url);
        if (!["https://start.duckduckgo.com", "https://duckduckgo.com"].includes(searchPage.origin)) {
          return failure("unknown", "Search navigation left DuckDuckGo; no login submission made.");
        }
        const snapshot = await accessibilitySnapshot();
        const query = snapshot.nodes.find(n => ["combobox", "textbox", "searchbox"].includes(n.role) && n.name === "Search with DuckDuckGo");
        const search = snapshot.nodes.find(n => n.role === "button" && n.name === "Search");
        if (!query || !search) return failure("unknown", "DuckDuckGo search controls were not recognized; no login submission made.");
        await fillInput({ backendNodeId: query.backendNodeId }, "jetblue login");
        await click({ backendNodeId: search.backendNodeId });
        if (!await waitForElement('[data-testid="result"] [data-testid="result-title-a"]', { timeoutSec: 20 })) {
          return failure("unknown", "DuckDuckGo organic results did not become available; no login submission made.");
        }
        const approved = await js(() => {
          if (!["https://duckduckgo.com", "https://start.duckduckgo.com"].includes(location.origin)) return false;
          document.querySelectorAll('[data-webmcp-jetblue-login]').forEach(e => e.removeAttribute('data-webmcp-jetblue-login'));
          const first = document.querySelector('[data-testid="result"] [data-testid="result-title-a"]');
          if (!first || !first.getClientRects().length) return false;
          const destination = new URL(first.href);
          if (destination.origin !== "https://www.jetblue.com" || !/^\/signin\/?$/.test(destination.pathname) || destination.search || destination.hash) return false;
          first.setAttribute('data-webmcp-jetblue-login', 'true');
          return true;
        });
        if (!approved) return failure("unknown", "The first organic result was not the approved JetBlue sign-in URL; no login submission made.");
        await click('[data-webmcp-jetblue-login="true"]');
        await waitForElement('input[name="credentials.passcode"]', { timeoutSec: 20 });
        if (!await hasSearchReferrer()) return failure("unknown", "The login landing page did not retain a DuckDuckGo referrer; no login submission made.");
      }
      let state = await readState();
      if (state.origin !== "https://www.jetblue.com") return classify(state);
      if (state.challenge || state.mfa || state.passkey || state.account) {
        const result = await classify(state);
        if (result) return result;
      }
      if (!/^\/signin\/?$/.test(state.path) || !state.hasForm) {
        return await classify(state) || failure("unknown", "JetBlue login form did not become available; no submission made.");
      }
      if (state.errors.some(t => /locked|too many|try again later|rate.limit|temporarily blocked|logged out due to inactivity/i.test(t))) return classify(state);
      if (!input.use_filled_form) {
        await fillInput('input[name="identifier"]', input.username);
        await fillInput('input[type="password"][name="credentials.passcode"]', input.password);
      }
      state = await readState();
      if (state.origin !== "https://www.jetblue.com" || state.challenge) return classify(state);
      if (!state.fieldsReady || !state.submitReady) return failure("validation_error", "Both visible credential fields and an enabled Sign in control are required; no submission made.");
      if (state.remember !== null && state.remember !== (input.remember_me ?? false)) await click('input[name="rememberMe"]');
      if (!input.use_filled_form) {
        const lengthOK = await js(n => document.querySelector('input[type="password"][name="credentials.passcode"]')?.value.length === n, { arg: input.password.length });
        if (!lengthOK) return failure("validation_error", "Password length verification failed; no submission made.");
      }
      // An unchanged error from an earlier attempt is not proof of this attempt's outcome.
      const previousErrors = JSON.stringify(state.errors);
      submitted = true;
      await click('input[type="submit"]');
      let sawClearedErrors = state.errors.length === 0;
      const deadline = Date.now() + 25000;
      while (Date.now() < deadline) {
        try {
          state = await readState();
        } catch {
          // Navigation can replace the execution context; only the read is retried.
          await waitMs(300);
          continue;
        }
        if (!state.errors.length) sawClearedErrors = true;
        const result = await classify(state);
        if (result && (result.status !== "failed" || state.origin !== "https://www.jetblue.com" ||
            sawClearedErrors || JSON.stringify(state.errors) !== previousErrors)) return result;
        await waitMs(300);
      }
      return failure("unknown", "No fresh, conclusive login outcome within 25 seconds. Submission may have reached JetBlue; inspect the browser before any retry.");
    } catch {
      return failure("unknown", submitted ? "Login observation was interrupted after submission may have started. Inspect the browser; do not automatically retry." : "Login preparation was interrupted; no submission was attempted.");
    }
  }
}]
