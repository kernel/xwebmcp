[{
  kind: "cdp",
  match: { url_patterns: ["https://jetblue.com/*", "https://*.jetblue.com/*"] },
  tool: {
    name: "login",
    description: "Submit JetBlue's username/password form once. Use use_filled_form for human or vault-filled credentials without returning their values. Success means first-step acceptance; authenticated is false when email verification or other MFA remains. Stops on challenges and never retries a submission. Does not request or submit MFA codes.",
    inputSchema: {
      type: "object",
      properties: {
        username: { type: "string", minLength: 1, maxLength: 320 },
        password: { type: "string", minLength: 1, maxLength: 1024 },
        remember_me: { type: "boolean", default: false },
        use_filled_form: { type: "boolean", default: false }
      },
      additionalProperties: false,
      oneOf: [
        { required: ["username", "password"], properties: { use_filled_form: { const: false } } },
        { required: ["use_filled_form"], properties: { use_filled_form: { const: true } }, not: { anyOf: [{ required: ["username"] }, { required: ["password"] }] } }
      ]
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false,
          required: ["logged_in", "authenticated", "landing_url", "account_name_or_hint", "mfa_required", "next_step", "evidence", "submission_attempted"],
          properties: {
            logged_in: { const: true }, authenticated: { type: "boolean" },
            landing_url: { type: "string", format: "uri" },
            account_name_or_hint: { type: ["string", "null"] },
            mfa_required: { type: "boolean" }, next_step: { enum: ["none", "complete_mfa"] },
            evidence: { type: "string", minLength: 1 }, submission_attempted: { type: "boolean" }
          },
          oneOf: [
            { properties: { authenticated: { const: true }, mfa_required: { const: false }, next_step: { const: "none" } } },
            { properties: { authenticated: { const: false }, mfa_required: { const: true }, next_step: { const: "complete_mfa" } } }
          ]
        },
        {
          type: "object", additionalProperties: false,
          required: ["logged_in", "error_kind", "error_message", "attempts_remaining_if_shown", "message_source", "submission_attempted"],
          properties: {
            logged_in: { const: false },
            error_kind: { enum: ["invalid_credentials", "captcha_or_challenge", "mfa_failed", "locked_or_throttled", "validation_error", "unknown"] },
            error_message: { type: "string", minLength: 1 },
            attempts_remaining_if_shown: { type: ["integer", "null"], minimum: 0 },
            message_source: { enum: ["site", "tool"] }, submission_attempted: { type: "boolean" }
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
      return { logged_in: false, error_kind: kind, error_message: message,
        attempts_remaining_if_shown: remaining ? Number(remaining[1]) : null,
        message_source: source, submission_attempted: submitted };
    };
    if (!input || typeof input !== "object" || Array.isArray(input) ||
        Object.keys(input).some(k => !["username", "password", "remember_me", "use_filled_form"].includes(k)) ||
        (input.remember_me !== undefined && typeof input.remember_me !== "boolean") ||
        (input.use_filled_form !== undefined && typeof input.use_filled_form !== "boolean")) {
      return failure("validation_error", "Invalid login input; no submission made.");
    }
    if (input.use_filled_form === true) {
      if (input.username !== undefined || input.password !== undefined) return failure("validation_error", "Do not combine credentials with use_filled_form.");
    } else if (typeof input.username !== "string" || !input.username.trim() || input.username.length > 320 ||
               typeof input.password !== "string" || !input.password.length || input.password.length > 1024) {
      return failure("validation_error", "Both username and password are required; no submission made.");
    }
    const readState = async () => js(`(() => {
      const visible = e => !!e && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden';
      const all = selector => [...document.querySelectorAll(selector)].filter(visible);
      const text = e => (e.innerText || e.textContent || '').trim();
      const errors = [...new Set(all('[role="alert"], .o-form-error-container, .o-form-input-error').map(text).filter(Boolean))];
      const headings = all('h1,h2,h3,[role="heading"]').map(text);
      const controls = all('a,button,input[type="submit"]').map(e => e.tagName === 'INPUT' ? e.value : text(e));
      const challengeFrame = all('iframe').find(e => /recaptcha|hcaptcha|captcha|challenge/i.test(e.title + ' ' + e.src));
      const challengeText = [...headings, ...errors, ...all('[role="dialog"]').map(text), ...all('p,div,span').map(text).filter(t => t.length <= 240)].find(t => /verify (?:that )?you are human|security check|complete the captcha|access denied|unusual traffic/i.test(t));
      const identifier = document.querySelector('input[name="identifier"]');
      const password = document.querySelector('input[type="password"][name="credentials.passcode"]');
      const mfaHeading = headings.find(t => /verify your identity|verify with|enter.*(?:verification|security).*code|two.step verification|multi.factor authentication|(?:get|send)(?: me)? (?:a |an )?verification email|we sent an email/i.test(t));
      const code = all('input[autocomplete="one-time-code"],input[name="credentials.passcode"]').some(e => e.type !== 'password');
      const mfaChoice = controls.some(t => /send (?:a )?code|send me an email|select|verify/i.test(t));
      return { origin: location.origin, path: location.pathname, url: location.origin + location.pathname,
        errors, hasForm: visible(identifier) && visible(password),
        fieldsReady: visible(identifier) && visible(password) && !!identifier.value.trim() && !!password.value,
        submitReady: all('input[type="submit"]').some(e => e.value.toLowerCase() === 'sign in' && !e.disabled),
        remember: document.querySelector('input[name="rememberMe"]')?.checked ?? null,
        challenge: challengeText || (challengeFrame ? (challengeFrame.title || 'Visible CAPTCHA/challenge iframe') : null),
        mfa: !visible(password) && mfaHeading && (code || mfaChoice) ? mfaHeading : null,
        account: controls.find(t => /^(?:sign out|log out)$/i.test(t)) || null };
    })()`);
    const outcome = state => {
      if (state.origin !== "https://www.jetblue.com") return failure("unknown", "Navigation left the approved origin; no further interaction performed.");
      if (state.challenge) return failure("captcha_or_challenge", state.challenge, "site");
      const message = state.errors.join("\n");
      if (message) {
        let kind = "unknown";
        if (/locked|too many|try again later|rate.limit|temporarily blocked/i.test(message)) kind = "locked_or_throttled";
        else if (/captcha|challenge|robot|human verification/i.test(message)) kind = "captcha_or_challenge";
        else if (/(?:invalid|incorrect|expired).*(?:code|otp)|(?:code|otp).*(?:invalid|incorrect|expired)/i.test(message)) kind = "mfa_failed";
        else if (/unable to sign in|invalid (?:username|password|credentials)|incorrect (?:username|password)/i.test(message)) kind = "invalid_credentials";
        else if (/required|cannot be blank|please enter/i.test(message)) kind = "validation_error";
        return failure(kind, message, "site");
      }
      if (state.mfa || (state.account && !state.hasForm)) return {
        logged_in: true, authenticated: !state.mfa, landing_url: state.url,
        account_name_or_hint: state.account, mfa_required: !!state.mfa,
        next_step: state.mfa ? "complete_mfa" : "none", evidence: state.mfa || state.account,
        submission_attempted: submitted
      };
      return null;
    };
    try {
      const entry = "https://www.jetblue.com/signin?useIdx=true&returnUrl=https%3A%2F%2Fwww.jetblue.com%2F";
      const current = new URL((await pageInfo()).url);
      if (current.origin !== "https://www.jetblue.com" || !/^\/signin\/?$/.test(current.pathname)) {
        await gotoUrl(entry);
        await waitForElement('input[name="credentials.passcode"]', { timeoutSec: 20 });
      }
      let state = await readState();
      if (state.origin !== "https://www.jetblue.com") return outcome(state);
      if (state.challenge || state.mfa || state.account) {
        const result = outcome(state);
        if (result) return result;
      }
      if (!state.hasForm) {
        return outcome(state) || failure("unknown", "JetBlue login form did not become available; no submission made.");
      }
      if (state.errors.some(t => /locked|too many|try again later|rate.limit|temporarily blocked|logged out due to inactivity/i.test(t))) return outcome(state);
      if (!input.use_filled_form) {
        await fillInput('input[name="identifier"]', input.username);
        await fillInput('input[type="password"][name="credentials.passcode"]', input.password);
      }
      state = await readState();
      if (state.origin !== "https://www.jetblue.com" || state.challenge) return outcome(state);
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
        const result = outcome(state);
        if (result && (result.logged_in || result.error_kind === "captcha_or_challenge" ||
            state.origin !== "https://www.jetblue.com" || sawClearedErrors || JSON.stringify(state.errors) !== previousErrors)) return result;
        await waitMs(300);
      }
      return failure("unknown", "No fresh, conclusive login outcome within 25 seconds. Submission may have reached JetBlue; inspect the browser before any retry.");
    } catch {
      return failure("unknown", submitted ? "Login observation was interrupted after submission may have started. Inspect the browser; do not automatically retry." : "Login preparation was interrupted; no submission was attempted.");
    }
  }
}]
