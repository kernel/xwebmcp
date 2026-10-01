[{
  kind: "cdp",
  match: { url_patterns: ["https://united.com/*", "https://*.united.com/*"] },
  tool: {
    name: "login",
    description: "Sign in to United using email or MileagePlus number and password. Performs at most one submission per stage, never retries, and stops at challenges. logged_in=true means a submission in this invocation reached authenticated or MFA UI, NOT necessarily completed MFA; inspect authentication_complete. Existing sessions without account binding are rejected. prefilled_password submits a password securely filled by the human or vault without reading it. otp continues an already visible code step. Does not select an MFA delivery method or resend codes.",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: {
        mode: { type: "string", enum: ["credentials", "prefilled_password", "otp"] },
        identifier: { type: "string", minLength: 1, description: "Email or MileagePlus number; must match the current account in prefilled_password mode." },
        password: { type: "string", minLength: 1, description: "Password; never returned. Prefer secure fill and prefilled_password mode for real credentials." },
        otp: { type: "string", pattern: "^[0-9]{6}$", description: "Current six-digit verification code, not a TOTP seed." },
        remember_me: { type: "boolean", default: false }
      },
      required: ["mode"],
      oneOf: [
        { properties: { mode: { const: "credentials" } }, required: ["identifier", "password"], not: { required: ["otp"] } },
        { properties: { mode: { const: "prefilled_password" } }, required: ["identifier"], not: { anyOf: [{ required: ["password"] }, { required: ["otp"] }] } },
        { properties: { mode: { const: "otp" } }, required: ["otp"], not: { anyOf: [{ required: ["password"] }, { required: ["identifier"] }, { required: ["remember_me"] }] } }
      ]
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false,
          properties: {
            logged_in: { const: true, type: "boolean" },
            authentication_complete: { type: "boolean" },
            landing_url: { type: "string", format: "uri" },
            account_name_or_hint: { type: ["string", "null"] },
            mfa_required: { type: "boolean" },
            next_step: { type: "string", enum: ["done", "enter_otp", "choose_mfa_method", "complete_additional_verification"] },
            evidence: { type: "string", minLength: 1 }
          },
          required: ["logged_in", "authentication_complete", "landing_url", "account_name_or_hint", "mfa_required", "next_step", "evidence"],
          oneOf: [
            { properties: { authentication_complete: { const: true }, mfa_required: { const: false }, next_step: { const: "done" } } },
            { properties: { authentication_complete: { const: false }, mfa_required: { const: true }, next_step: { enum: ["enter_otp", "choose_mfa_method", "complete_additional_verification"] } } }
          ]
        },
        {
          type: "object", additionalProperties: false,
          properties: {
            logged_in: { const: false, type: "boolean" },
            error_kind: { type: "string", enum: ["invalid_credentials", "captcha_or_challenge", "mfa_failed", "locked_or_throttled", "invalid_input", "unknown"] },
            error_message: { type: "string", minLength: 1 },
            error_source: { type: "string", enum: ["site", "tool"] },
            attempts_remaining_if_shown: { type: ["integer", "null"], minimum: 0 }
          },
          required: ["logged_in", "error_kind", "error_message", "error_source", "attempts_remaining_if_shown"]
        }
      ]
    },
    annotations: { destructiveHint: false, readOnlyHint: false }
  },
  execute: async (input) => {
    const fail = (kind, message, source = "tool") => {
      const remaining = source === "site" ? message.match(/(\d+)\s+(?:more\s+)?attempts?\s+(?:remaining|left)/i) : null;
      return { logged_in: false, error_kind: kind, error_message: message, error_source: source, attempts_remaining_if_shown: remaining ? Number(remaining[1]) : null };
    };
    if (!input || typeof input !== "object" || Array.isArray(input)) return fail("invalid_input", "Input must be an object.");
    const { mode, identifier, password, otp, remember_me = false } = input;
    const text = v => typeof v === "string" && v.trim().length > 0;
    if (Object.keys(input).some(k => !["mode", "identifier", "password", "otp", "remember_me"].includes(k)) || !["credentials", "prefilled_password", "otp"].includes(mode) || typeof remember_me !== "boolean" || (otp !== undefined && (mode !== "otp" || typeof otp !== "string" || !/^\d{6}$/.test(otp))) || (mode !== "otp" && !text(identifier)) || (mode === "credentials" && !text(password)) || (mode === "prefilled_password" && password !== undefined) || (mode === "otp" && (typeof otp !== "string" || password !== undefined || identifier !== undefined || input.remember_me !== undefined))) return fail("invalid_input", "Provide mode and its required fields; OTP must be six digits. No submission was made.");
    let submittedPassword = false;
    let submittedOtp = false;
    let networkFailure = null;
    const read = async () => js(() => {
      const visible = e => !!e && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== "hidden";
      const id = document.querySelector("#MPIDEmailField");
      const pw = document.querySelector("#password");
      // One field (autocomplete=one-time-code) or one box per digit ("Enter digit 1 of 6").
      const label = e => (e.getAttribute('aria-label') || e.labels?.[0]?.innerText || '').replace(/\s+/g, ' ');
      const single = [...document.querySelectorAll('input[autocomplete="one-time-code"]')].filter(visible);
      const digits = [...document.querySelectorAll('input')].filter(e => visible(e) && /digit \d+ of \d+/i.test(label(e)));
      const code = single.length ? single : digits;
      const field = [pw, id, ...code].find(visible);
      const scope = field?.closest('[role="dialog"]') || field?.closest('form')?.parentElement || [...document.querySelectorAll('[role="dialog"]')].find(visible);
      const content = scope?.innerText || "";
      const alerts = [...document.querySelectorAll('[role="alert"], [aria-live="assertive"], [class*="error" i], [class*="alert" i]')].filter(visible).map(e => e.innerText?.replace(/\s+/g, ' ').trim()).filter(t => t && t.length < 1200);
      const uniqueAlerts = [...new Set(alerts)].filter(t => !alerts.some(other => other !== t && other.includes(t)));
      const controls = [...document.querySelectorAll('a,button')].filter(visible).map(e => e.innerText.trim());
      const headings = [...document.querySelectorAll('h1,h2,h3,[role="heading"]')].filter(visible).map(e => e.innerText.trim());
      const challenge = [...headings, ...alerts].find(t => /verify (?:that )?you(?:'re| are) human|access denied|unusual traffic|security check|complete (?:the|this) captcha/i.test(t));
      const challengeFrame = [...document.querySelectorAll('iframe')].find(e => visible(e) && /(?:captcha|challenge)/i.test(e.title) && e.getBoundingClientRect().height > 70);
      const errors = uniqueAlerts.filter(t => /wrong|invalid|incorrect|unable|try again|locked|too many|expired|attempts? (?:left|remaining)|does not match|not recognized|not match/i.test(t));
      const signout = controls.find(t => /^(?:sign out|log out)$/i.test(t));
      const mfaText = [...headings, ...alerts, ...content.split('\n')].find(t => /we(?:'ve| have)? sent (?:you )?(?:a |an |the )?(?:verification |security |one.time )?code|enter (?:the |your )?(?:six.digit|6.digit|verification|one.time|security) (?:code|passcode)|enter code|choose (?:how|where) .*code|verify your identity/i.test(t));
      return { url: location.href, origin: location.origin, idVisible: visible(id), pwVisible: visible(pw), pwFilled: visible(pw) && pw.value.length > 0, account: document.querySelector('input#username')?.value || null, codeCount: code.length, digitBoxes: single.length ? 0 : digits.length, errors: [...new Set(errors)], challenge: challenge || (challengeFrame ? challengeFrame.title : null), signout, mfaText };
    });
    const outcome = s => {
      if (s.origin !== "https://www.united.com") return fail("unknown", "Navigation left the approved United origin; stopped.");
      if (s.challenge) return fail("captcha_or_challenge", s.challenge, "site");
      if (s.errors.length) {
        const msg = s.errors.join('\n');
        const kind = /locked|too many|temporarily blocked|try again (?:later|in \d)/i.test(msg) ? "locked_or_throttled" : /(?:code|otp|passcode).*(?:invalid|incorrect|expired|not match)|(?:invalid|incorrect|expired).*(?:code|otp|passcode)/i.test(msg) ? "mfa_failed" : /(?:password|credentials|mileageplus|email).*(?:incorrect|invalid|not match|not recognized)|(?:incorrect|invalid).*(?:password|credentials|mileageplus|email)/i.test(msg) ? "invalid_credentials" : "unknown";
        return fail(kind, msg, "site");
      }
      if ((s.signout || s.mfaText) && !s.pwVisible && !s.idVisible && !submittedPassword && !submittedOtp) return fail("unknown", "An existing authentication state is visible, but it is not bound to the requested account. No submission was made.");
      if (s.signout && !s.pwVisible && !s.idVisible && !s.codeCount && !s.mfaText) return { logged_in: true, authentication_complete: true, landing_url: s.url, account_name_or_hint: null, mfa_required: false, next_step: "done", evidence: s.signout };
      if (s.mfaText && !s.pwVisible && !s.idVisible) return { logged_in: true, authentication_complete: false, landing_url: s.url, account_name_or_hint: null, mfa_required: true, next_step: s.codeCount === 1 || s.digitBoxes === 6 ? "enter_otp" : /choose/i.test(s.mfaText) ? "choose_mfa_method" : "complete_additional_verification", evidence: s.mfaText };
      return null;
    };
    const poll = async predicate => {
      for (let i = 0; i < 40; i++) {
        try { const s = await read(); if (predicate(s)) return s; } catch { /* A navigation can replace the execution context; only observations are retried. */ }
        await waitMs(500);
      }
      return null;
    };
    const submit = async selector => {
      const target = await js(sel => {
        if (location.origin !== "https://www.united.com") return null;
        const field = document.querySelector(sel);
        const form = field?.closest('form');
        const buttons = [...(form?.querySelectorAll('button') || [])].filter(b => b.getClientRects().length && !b.disabled && /^(?:continue|sign in|verify|verify code|submit)$/i.test(b.innerText.trim()));
        if (buttons.length !== 1) return null;
        document.querySelectorAll('[data-airline-login-submit]').forEach(e => e.removeAttribute('data-airline-login-submit'));
        buttons[0].setAttribute('data-airline-login-submit', 'true');
        return '[data-airline-login-submit="true"]';
      }, { arg: selector });
      if (!target) return false;
      await cdp('Network.enable');
      const responsePromise = waitForEvent('Network.responseReceived', {
        timeoutSec: 20,
        predicate: e => {
          const url = new URL(e.params.response.url);
          const path = selector === '#password' ? '/xapi/auth/signin' : selector === '#MPIDEmailField' ? '/xapi/auth/validate-username' : null;
          return url.origin === 'https://www.united.com' && (path ? url.pathname === path : url.pathname.startsWith('/xapi/auth/'));
        }
      });
      await click(target);
      const response = await responsePromise;
      if (response && response.params.response.status >= 400) {
        const status = response.params.response.status;
        let heading = null;
        for (let i = 0; i < 5; i++) {
          try {
            const body = await cdp('Network.getResponseBody', { requestId: response.params.requestId }, response.sessionId);
            heading = await js(result => {
              const html = result.base64Encoded ? atob(result.body) : result.body;
              const doc = new DOMParser().parseFromString(html, 'text/html');
              return [...doc.querySelectorAll('h1,h2')].map(e => e.textContent.trim()).find(t => /^(?:access denied|verify (?:that )?you(?:'re| are) human|security challenge)$/i.test(t)) || null;
            }, { arg: body });
            break;
          } catch { await waitMs(100); }
        }
        networkFailure = fail(heading ? 'captcha_or_challenge' : status === 429 ? 'locked_or_throttled' : 'unknown', heading ? `${heading} (HTTP ${status})` : `United authentication endpoint returned HTTP ${status}; authentication is unconfirmed. Do not automatically retry.`, 'site');
        if (networkFailure.error_kind === 'unknown') {
          for (let i = 0; i < 10; i++) {
            const state = await read();
            if (state.errors.length || state.challenge) { networkFailure = outcome(state); break; }
            await waitMs(100);
          }
        }
      }
      return true;
    };
    try {
      let s;
      if (mode === "credentials") {
        const entryUrl = "https://www.united.com/en/us/united-mileageplus-signin";
        if ((await pageInfo()).url === entryUrl) {
          s = await read();
          const initial = outcome(s);
          if (initial) return initial;
        }
        if (!s?.idVisible) {
          await gotoUrl(entryUrl);
          s = await poll(x => x.origin === "https://www.united.com" && (x.idVisible || !!outcome(x)));
        }
        if (!s) return fail("unknown", "Login form did not become ready. No credentials were submitted.");
        if (outcome(s)) return outcome(s);
        await fillInput('#MPIDEmailField', identifier);
        if (!await submit('#MPIDEmailField')) return fail("unknown", "Could not identify one enabled Continue button. No identifier submission was made.");
        if (networkFailure) return networkFailure;
        s = await poll(x => x.pwVisible || !!outcome(x));
        if (!s) return fail("unknown", "Identifier result timed out; do not automatically retry.");
        if (outcome(s)) return outcome(s);
        await fillInput('#password', password);
      } else if (mode === "otp") {
        s = await read();
        if (s.challenge) return outcome(s);
        const singleField = s.codeCount === 1 && !s.digitBoxes;
        if (s.origin !== "https://www.united.com" || !(singleField || s.digitBoxes === 6) || !s.mfaText || s.pwVisible || s.idVisible) return fail("unknown", "A supported verification step (one code field or six digit boxes) is not visible; no code was submitted.");
        let codeSelector = 'input[autocomplete="one-time-code"]';
        if (singleField) {
          await fillInput(codeSelector, otp);
        } else {
          // Mark the six digit boxes in order, then type one digit into each.
          const marked = await js(() => {
            const boxes = [...document.querySelectorAll('input')].filter(e => e.getClientRects().length && /digit \d+ of 6/i.test(e.getAttribute('aria-label') || e.labels?.[0]?.innerText || ''));
            boxes.forEach((b, i) => b.setAttribute('data-airline-otp-digit', String(i)));
            return boxes.length;
          });
          if (marked !== 6) return fail("unknown", "The six verification digit boxes changed; no code was submitted.");
          for (let i = 0; i < 6; i++) await fillInput('[data-airline-otp-digit="' + i + '"]', otp[i]);
          codeSelector = '[data-airline-otp-digit="0"]';
        }
        if (!await submit(codeSelector)) return fail("unknown", "Could not identify one enabled verification button; no code was submitted.");
        if (networkFailure) return networkFailure;
        submittedOtp = true;
        s = await poll(x => !!outcome(x) && (!x.codeCount || x.errors.length > 0 || !!x.challenge));
        return s ? outcome(s) : fail("unknown", "Verification result timed out; do not automatically retry.");
      } else {
        s = await read();
        const initial = outcome(s);
        if (initial) return initial;
        if (!s.pwVisible || !s.pwFilled || !s.account || s.account.toLowerCase() !== identifier.trim().toLowerCase()) return fail("invalid_input", "Securely fill the password for the matching current account first. No submission was made.");
      }
      const remember = await js(wanted => {
        if (location.origin !== "https://www.united.com") return false;
        const e = document.querySelector('input[name="rememberMe"]');
        if (!e) return !wanted;
        if (e.checked !== wanted) e.click();
        return e.checked === wanted;
      }, { arg: remember_me });
      if (!remember) return fail("unknown", "Could not set Remember me; no password submission was made.");
      if (!await submit('#password')) return fail("unknown", "Could not identify one enabled Sign in button; no password submission was made.");
      if (networkFailure) return networkFailure;
      submittedPassword = true;
      s = await poll(x => !!outcome(x));
      return s ? outcome(s) : fail("unknown", "Login result timed out; authentication is unconfirmed. Do not automatically retry.");
    } catch {
      return fail("unknown", "Browser interaction failed; submission outcome may be unknown. Inspect the page before any further attempt.");
    }
  }
}]
