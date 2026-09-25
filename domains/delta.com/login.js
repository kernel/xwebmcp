[{
  kind: "cdp",
  match: { url_patterns: ["https://delta.com/*", "https://*.delta.com/*"] },
  tool: {
    name: "login",
    description: "Sign in to Delta with a SkyMiles number or username and password. Credentials mode always enters the site through a DuckDuckGo search result, never by direct navigation, and fails with the step that broke rather than falling back. Performs at most one submission and never retries. status=\"success\" means this invocation's submission reached authenticated or verification UI; check authentication_complete. A captcha or bot challenge is reported as error_kind \"captcha_or_challenge\". prefilled_password submits a password already filled by the human or a vault, without reading it, and does not navigate.",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: {
        mode: { type: "string", enum: ["credentials", "prefilled_password"], description: "credentials enters through DuckDuckGo; prefilled_password submits the login form already visible and filled on the current Delta page." },
        identifier: { type: "string", minLength: 1, description: "SkyMiles number or username, not an email unless it is also the username." },
        password: { type: "string", minLength: 1, description: "Password; never returned. Prefer a secure fill plus prefilled_password mode for real credentials." },
        search_query: { type: "string", minLength: 1, maxLength: 120, default: "delta skymiles login", description: "Query used for the DuckDuckGo entry path in credentials mode." }
      },
      required: ["mode"],
      oneOf: [
        { properties: { mode: { const: "credentials" } }, required: ["identifier", "password"] },
        { properties: { mode: { const: "prefilled_password" } }, required: [], not: { anyOf: [{ required: ["password"] }, { required: ["identifier"] }, { required: ["search_query"] }] } }
      ]
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false,
          properties: {
            status: { const: "success", type: "string" },
            logged_in: { const: true, type: "boolean" },
            authentication_complete: { type: "boolean" },
            mfa_required: { type: "boolean" },
            next_step: { type: "string", enum: ["done", "enter_code_in_browser", "complete_additional_verification"] },
            landing_url: { type: "string", format: "uri" },
            account_name_or_hint: { type: ["string", "null"] },
            entry_path: { type: "string", enum: ["duckduckgo_referrer", "current_page"] },
            referrer: { type: ["string", "null"] },
            evidence: { type: "string", minLength: 1 }
          },
          required: ["status", "logged_in", "authentication_complete", "mfa_required", "next_step", "landing_url", "account_name_or_hint", "entry_path", "referrer", "evidence"],
          oneOf: [
            { properties: { authentication_complete: { const: true }, mfa_required: { const: false }, next_step: { const: "done" } } },
            { properties: { authentication_complete: { const: false }, mfa_required: { const: true }, next_step: { enum: ["enter_code_in_browser", "complete_additional_verification"] } } }
          ]
        },
        {
          type: "object", additionalProperties: false,
          properties: {
            status: { const: "failure", type: "string" },
            logged_in: { const: false, type: "boolean" },
            error_kind: {
              type: "string",
              enum: ["search_engine_unreachable", "search_box_missing", "search_results_missing", "no_delta_result", "entry_navigation_failed", "login_form_not_ready", "invalid_credentials", "captcha_or_challenge", "mfa_failed", "locked_or_throttled", "invalid_input", "unknown"]
            },
            failed_step: { type: "string", enum: ["input", "search_engine", "search_results", "result_click", "login_form", "credential_fill", "submission", "result_read"] },
            error_message: { type: "string", minLength: 1 },
            error_source: { type: "string", enum: ["site", "tool"] },
            submitted: { type: "boolean" },
            attempts_remaining_if_shown: { type: ["integer", "null"], minimum: 0 },
            entry_path: { type: "string", enum: ["duckduckgo_referrer", "current_page"] }
          },
          required: ["status", "logged_in", "error_kind", "failed_step", "error_message", "error_source", "submitted", "attempts_remaining_if_shown", "entry_path"]
        }
      ]
    },
    annotations: { destructiveHint: false, readOnlyHint: false }
  },
  execute: async (input) => {
    const entryPath = input && input.mode === "prefilled_password" ? "current_page" : "duckduckgo_referrer";
    let submitted = false;
    const fail = (kind, step, message, source = "tool", remaining = null) => ({
      status: "failure", logged_in: false, error_kind: kind, failed_step: step,
      error_message: message, error_source: source, submitted,
      attempts_remaining_if_shown: remaining, entry_path: entryPath
    });
    if (!input || typeof input !== "object" || Array.isArray(input)) return fail("invalid_input", "input", "Input must be an object.");
    const { mode, identifier, password, search_query = "delta skymiles login" } = input;
    const text = v => typeof v === "string" && v.trim().length > 0;
    if (Object.keys(input).some(k => !["mode", "identifier", "password", "search_query"].includes(k))
      || !["credentials", "prefilled_password"].includes(mode)
      || (mode === "credentials" && (!text(identifier) || !text(password) || !text(search_query) || search_query.length > 120))
      || (mode === "prefilled_password" && (identifier !== undefined || password !== undefined || input.search_query !== undefined))) {
      return fail("invalid_input", "input", "Provide mode and its required fields. No submission was made.");
    }

    const read = () => js(() => {
      const visible = e => !!e && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== "hidden";
      const all = sel => Array.from(document.querySelectorAll(sel)).filter(visible);
      const clean = t => (t || "").replace(/\s+/g, " ").trim();
      const user = document.querySelector("#userId-input");
      const pw = document.querySelector("#password-input");
      const alerts = [...new Set(all('[role="alert"],.login-screen__error-text,.login-screen__error-container,[class*="error-message"],[class*="error-text"]')
        .map(e => clean(e.innerText)).filter(t => t && t.length < 1200))];
      const headings = all('h1,h2,h3,[role="heading"]').map(e => clean(e.innerText));
      const controls = all('a,button,[role="button"]').map(e => clean(e.innerText) || clean(e.getAttribute("aria-label")));
      const frame = all("iframe").find(e => /captcha|challenge/i.test([e.title, e.src].join(" ")));
      const challenge = [...headings, ...alerts].find(t => /verify (?:that )?you(?:'re| are)? ?human|are you a human|access denied|unusual traffic|security (?:check|challenge)|complete (?:the|this) captcha|press and hold/i.test(t))
        || (frame ? (frame.title || "Captcha or challenge frame") : null);
      const regions = all('[role="dialog"],main,form').map(e => clean(e.innerText)).join("\n").slice(0, 8000);
      const mfaText = [...headings, ...regions.split("\n")].find(t => /we(?:'ve| have)? sent|(?:verification|security|one.time|6.digit|six.digit) code|verify your identity|check your (?:email|phone|text)/i.test(t));
      return {
        url: location.href, host: location.host, referrer: document.referrer || null,
        formVisible: visible(user) && visible(pw),
        filled: !!user && !!pw && user.value.trim().length > 0 && pw.value.length > 0,
        loginTrigger: controls.some(t => /^log ?in\b/i.test(t)),
        account: controls.find(t => /^(?:log ?out|sign ?out)$/i.test(t)) || null,
        mfaText: mfaText || null, challenge: challenge || null, alerts
      };
    });

    const isDelta = host => /(^|\.)delta\.com$/.test(host || "");
    const outcome = s => {
      if (!isDelta(s.host)) return fail("unknown", "result_read", "The page left the approved Delta origin; stopped.");
      if (s.challenge) return fail("captcha_or_challenge", submitted ? "submission" : "login_form", s.challenge, "site");
      const message = s.alerts.join("\n");
      if (message) {
        const remaining = message.match(/(\d+)\s+(?:more\s+)?attempts?\s+(?:remaining|left)/i);
        const kind = /locked|too many|try again later|temporarily blocked|rate limit/i.test(message) ? "locked_or_throttled"
          : /(?:code|otp|passcode).{0,60}(?:incorrect|invalid|expired)|(?:incorrect|invalid|expired).{0,60}(?:code|otp|passcode)/i.test(message) ? "mfa_failed"
            : /login credential is incorrect|(?:password|username|skymiles number|credentials?).{0,60}(?:incorrect|invalid|not match|not recognized)|(?:incorrect|invalid).{0,60}(?:password|username|credentials?)/i.test(message) ? "invalid_credentials"
              : "unknown";
        return fail(kind, submitted ? "submission" : "login_form", message, "site", remaining ? Number(remaining[1]) : null);
      }
      if (!submitted) return null;
      if (!s.formVisible && s.mfaText) return {
        status: "success", logged_in: true, authentication_complete: false, mfa_required: true,
        next_step: /(?:verification|security|one.time|6.digit|six.digit) code/i.test(s.mfaText) ? "enter_code_in_browser" : "complete_additional_verification",
        landing_url: s.url, account_name_or_hint: null, entry_path: entryPath, referrer: s.referrer, evidence: s.mfaText
      };
      if (!s.formVisible && s.account) return {
        status: "success", logged_in: true, authentication_complete: true, mfa_required: false, next_step: "done",
        landing_url: s.url, account_name_or_hint: null, entry_path: entryPath, referrer: s.referrer, evidence: s.account
      };
      return null;
    };
    const poll = async (predicate, attempts) => {
      for (let i = 0; i < attempts; i++) {
        try { const s = await read(); if (predicate(s)) return s; } catch { /* navigation can replace the execution context; only observations are retried */ }
        await waitMs(500);
      }
      return null;
    };

    try {
      if (mode === "credentials") {
        try {
          await gotoUrl("https://start.duckduckgo.com");
        } catch {
          return fail("search_engine_unreachable", "search_engine", "Could not open the DuckDuckGo entry page. No login page was requested.");
        }
        if (!await waitForElement('textarea[name="q"]', { timeoutSec: 30 })) {
          return fail("search_box_missing", "search_engine", "The DuckDuckGo search box did not appear. No login page was requested.");
        }
        await fillInput('textarea[name="q"]', search_query);
        await pressKey("Enter");
        if (!await waitForElement('a[data-testid="result-title-a"]', { timeoutSec: 30 })) {
          return fail("search_results_missing", "search_results", "DuckDuckGo returned no usable organic results for the query. No login page was requested.");
        }
        const picked = await js(() => {
          document.querySelectorAll("[data-delta-login-entry]").forEach(e => e.removeAttribute("data-delta-login-entry"));
          const anchor = Array.from(document.querySelectorAll('a[data-testid="result-title-a"]'))
            .filter(a => a.getClientRects().length > 0 && !a.closest('[data-layout="ad"],[data-testid="ad"]'))
            .find(a => { try { return /^(?:www\.)?delta\.com$/.test(new URL(a.href).host); } catch { return false; } });
          if (!anchor) return null;
          anchor.setAttribute("data-delta-login-entry", "1");
          return anchor.href;
        });
        if (!picked) return fail("no_delta_result", "search_results", "No organic delta.com result was present on the first results page. No login page was requested.");
        await click('a[data-delta-login-entry="1"]');
        const landed = await poll(s => isDelta(s.host), 60);
        if (!landed) return fail("entry_navigation_failed", "result_click", `Following the DuckDuckGo result did not reach delta.com (${picked}).`);
      }

      let state = await read();
      if (!isDelta(state.host)) return fail("unknown", "login_form", "The browser is not on delta.com; no submission was made.");
      if (mode === "prefilled_password") {
        const early = outcome(state);
        if (early) return early;
        if (!state.formVisible || !state.filled) {
          return fail("invalid_input", "login_form", "Securely fill both login fields on the visible Delta login form first. No submission was made.");
        }
      } else {
        if (!state.formVisible) {
          state = await poll(s => s.formVisible || !!s.challenge || s.alerts.length > 0, 90) || state;
          if (!state.formVisible && !state.challenge && !state.alerts.length && state.loginTrigger) {
            const opened = await js(() => {
              const visible = e => e.getClientRects().length > 0;
              const clean = t => (t || "").replace(/\s+/g, " ").trim();
              document.querySelectorAll("[data-delta-login-open]").forEach(e => e.removeAttribute("data-delta-login-open"));
              const trigger = Array.from(document.querySelectorAll('button,a,[role="button"]'))
                .filter(visible).find(e => /^log ?in\b/i.test(clean(e.innerText) || clean(e.getAttribute("aria-label"))));
              if (!trigger) return false;
              trigger.setAttribute("data-delta-login-open", "1");
              return true;
            });
            if (opened) {
              await click('[data-delta-login-open="1"]');
              state = await poll(s => s.formVisible || !!s.challenge || s.alerts.length > 0, 40) || state;
            }
          }
        }
        const early = outcome(state);
        if (early) return early;
        if (!state.formVisible) {
          return fail("login_form_not_ready", "login_form", `The Delta login form did not become ready at ${state.url} within the readiness budget. No credentials were submitted.`);
        }
        await fillInput("#userId-input", identifier);
        await fillInput("#password-input", password);
        state = await read();
        const afterFill = outcome(state);
        if (afterFill) return afterFill;
        if (!isDelta(state.host) || !state.formVisible || !state.filled) {
          return fail("unknown", "credential_fill", "The login form changed while entering credentials. No submission was made.");
        }
      }

      const clicked = await js(() => {
        if (!/(^|\.)delta\.com$/.test(location.host)) return false;
        const form = document.querySelector("form.login-screen__form");
        const button = form && form.querySelector('button[type="submit"]');
        const user = form && form.querySelector("#userId-input");
        const pw = form && form.querySelector("#password-input");
        if (!button || !user || !pw || button.disabled || button.getClientRects().length === 0) return false;
        if (user.value.trim().length === 0 || pw.value.length === 0) return false;
        button.click();
        return true;
      });
      if (!clicked) return fail("unknown", "submission", "Could not submit the Delta login form; the approved origin, form, or filled fields were unavailable. No submission was made.");
      submitted = true;
      const settled = await poll(s => !!outcome(s), 60);
      return settled ? outcome(settled) : fail("unknown", "submission", "The login result did not settle within 30 seconds; authentication is unconfirmed. Do not automatically retry.");
    } catch {
      return fail("unknown", submitted ? "submission" : "login_form", submitted
        ? "Browser interaction failed after submitting; the outcome is unknown. Inspect the browser before any further attempt."
        : "Browser interaction failed before any submission was made.");
    }
  }
}]
