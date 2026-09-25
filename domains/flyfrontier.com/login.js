[{
  kind: "cdp",
  match: { url_patterns: ["https://flyfrontier.com/*", "https://*.flyfrontier.com/*"] },
  tool: {
    name: "login",
    description: "Sign in to FRONTIER Miles with an email address or Miles number and password. credentials mode always enters the site through a DuckDuckGo search for the account page and a click on the first organic Frontier result; there is no direct-navigation entry. Performs at most one submission per invocation and never retries. logged_in=true means the submission was accepted, which includes the emailed verification step; inspect authenticated and next_step. A captcha or other challenge is reported as error_kind captcha_or_challenge. prefilled_password submits a vault-filled or human-filled form without reading the password. otp completes an already visible email code step and never resends codes.",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: {
        mode: { type: "string", enum: ["credentials", "prefilled_password", "otp"] },
        identifier: { type: "string", minLength: 1, description: "Email address or FRONTIER Miles number." },
        password: { type: "string", minLength: 1, description: "Password; never returned or logged. Prefer secure fill and prefilled_password mode." },
        otp: { type: "string", pattern: "^[0-9]{6}$", description: "Current six-digit emailed code, not a TOTP seed." },
        search_query: { type: "string", minLength: 1, default: "frontier airlines login", description: "Query used for the search-engine entry in credentials mode." }
      },
      required: ["mode"],
      oneOf: [
        { properties: { mode: { const: "credentials" } }, required: ["identifier", "password"], not: { required: ["otp"] } },
        { properties: { mode: { const: "prefilled_password" } }, not: { anyOf: [{ required: ["password"] }, { required: ["otp"] }, { required: ["search_query"] }] } },
        { properties: { mode: { const: "otp" } }, required: ["otp"], not: { anyOf: [{ required: ["password"] }, { required: ["identifier"] }, { required: ["search_query"] }] } }
      ]
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false,
          properties: {
            logged_in: { const: true, type: "boolean" },
            authenticated: { type: "boolean" },
            landing_url: { type: "string", format: "uri" },
            account_name_or_hint: { type: ["string", "null"] },
            mfa_required: { type: "boolean" },
            next_step: { type: "string", enum: ["done", "enter_email_otp"] },
            entry_path: { type: "string", enum: ["search_referrer", "already_open"] },
            evidence: { type: "string", minLength: 1 }
          },
          required: ["logged_in", "authenticated", "landing_url", "account_name_or_hint", "mfa_required", "next_step", "entry_path", "evidence"],
          oneOf: [
            { properties: { authenticated: { const: true }, mfa_required: { const: false }, next_step: { const: "done" } } },
            { properties: { authenticated: { const: false }, mfa_required: { const: true }, next_step: { const: "enter_email_otp" } } }
          ]
        },
        {
          type: "object", additionalProperties: false,
          properties: {
            logged_in: { const: false, type: "boolean" },
            error_kind: { type: "string", enum: ["invalid_input", "entry_search_failed", "entry_result_missing", "entry_navigation_failed", "login_form_unavailable", "invalid_credentials", "captcha_or_challenge", "mfa_failed", "locked_or_throttled", "unknown"] },
            error_message: { type: "string", minLength: 1 },
            error_source: { type: "string", enum: ["site", "tool"] },
            stage: { type: "string", enum: ["input", "search_entry", "site_entry", "before_submit", "after_submit"] },
            submitted: { type: "boolean" },
            attempts_remaining_if_shown: { type: ["integer", "null"], minimum: 0 }
          },
          required: ["logged_in", "error_kind", "error_message", "error_source", "stage", "submitted", "attempts_remaining_if_shown"]
        }
      ]
    },
    annotations: { destructiveHint: false, readOnlyHint: false }
  },
  execute: async (input) => {
    let submitted = false;
    const fail = (kind, message, stage, source = "tool") => {
      const remaining = source === "site" ? message.match(/(\d+)\s+(?:more\s+)?attempts?\s+(?:remaining|left)/i) : null;
      return { logged_in: false, error_kind: kind, error_message: message, error_source: source, stage, submitted, attempts_remaining_if_shown: remaining ? Number(remaining[1]) : null };
    };
    if (!input || typeof input !== "object" || Array.isArray(input)) return fail("invalid_input", "Input must be an object.", "input");
    const { mode, identifier, password, otp, search_query = "frontier airlines login" } = input;
    const text = v => typeof v === "string" && v.trim().length > 0;
    if (Object.keys(input).some(k => !["mode", "identifier", "password", "otp", "search_query"].includes(k))
      || !["credentials", "prefilled_password", "otp"].includes(mode)
      || (mode === "credentials" && (!text(identifier) || !text(password) || otp !== undefined || !text(search_query)))
      || (mode === "prefilled_password" && (password !== undefined || otp !== undefined || input.search_query !== undefined))
      || (mode === "otp" && (identifier !== undefined || password !== undefined || input.search_query !== undefined || typeof otp !== "string" || !/^[0-9]{6}$/.test(otp))))
      return fail("invalid_input", "Provide mode and exactly its required fields; a code must be six digits. No submission was made.", "input");

    const read = async () => js(() => {
      const visible = e => {
        if (!e || !e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
        const slider = e.closest(".slider-container");
        if (slider && !slider.classList.contains("slider-visible")) return false;
        const r = e.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      };
      const seen = selector => [...document.querySelectorAll(selector)].filter(visible).map(e => e.innerText.replace(/\s+/g, " ").trim()).filter(Boolean);
      const panel = document.querySelector(".login-container");
      const mfa = [...document.querySelectorAll(".slider-visible")].find(e => e.querySelector('input[data-vv-scope="mfa"]'));
      const account = [...document.querySelectorAll(".user-logged-in")].find(e => visible(e) && e.querySelector(".first-name")?.textContent.trim());
      const challenge = seen("h1,h2,h3,[role=alert]").find(t => /verify (?:that )?you(?:'re| are) human|access denied|unusual traffic|security check|checking your browser|complete (?:the|this) captcha|press (?:and hold|& hold)/i.test(t));
      const challengeFrame = [...document.querySelectorAll("iframe")].filter(visible).find(e => {
        const r = e.getBoundingClientRect();
        return r.width > 100 && r.height > 80 && /captcha|challenge|turnstile|awswaf|perimeterx/i.test(e.title + " " + e.src);
      });
      return {
        url: location.href,
        onSite: location.protocol === "https:" && (location.hostname === "flyfrontier.com" || location.hostname.endsWith(".flyfrontier.com")),
        account: account?.querySelector(".first-name")?.textContent.trim() || null,
        formVisible: visible(panel),
        formFilled: !!document.querySelector('.login-container input[name="email"]')?.value.trim() && !!document.querySelector('.login-container input[name="password"]')?.value,
        mfaVisible: !!mfa && visible(mfa),
        mfaFieldCount: mfa ? [...mfa.querySelectorAll('input[data-vv-scope="mfa"]')].filter(visible).length : 0,
        mfaHint: mfa ? [...mfa.querySelectorAll("p")].filter(visible).map(e => e.innerText.replace(/\s+/g, " ").trim()).find(t => /verification code/i.test(t)) || null : null,
        errors: mfa && visible(mfa)
          ? [...new Set(seen(".slider-visible .mfa-error-message, .slider-visible [role=alert]"))]
          : [...new Set(seen(".login-container .error-message, .login-container .field-validation-error, .login-container [role=alert]"))],
        challenge: challenge || (challengeFrame ? "Visible verification frame: " + (challengeFrame.title || "captcha") : null)
      };
    });
    const classify = (s, stage) => {
      if (!s.onSite) return fail("unknown", "The browser left flyfrontier.com; the outcome is unconfirmed. Inspect the page before any further attempt.", stage);
      if (s.challenge) return fail("captcha_or_challenge", s.challenge, stage, "site");
      if (s.errors.length) {
        const message = s.errors.join("\n");
        const kind = /too many|locked|temporarily blocked|try again (?:later|in \d)/i.test(message) ? "locked_or_throttled"
          : /captcha|verify (?:that )?you(?:'re| are) human|security challenge/i.test(message) ? "captcha_or_challenge"
            : s.mfaVisible ? "mfa_failed"
              : /login information is incorrect|incorrect|invalid|not match|no account/i.test(message) ? "invalid_credentials" : "unknown";
        return fail(kind, message, stage, "site");
      }
      return null;
    };
    const succeed = (s, entry_path) => ({
      logged_in: true, authenticated: !s.mfaVisible, landing_url: s.url,
      account_name_or_hint: s.mfaVisible ? s.mfaHint : s.account,
      mfa_required: s.mfaVisible, next_step: s.mfaVisible ? "enter_email_otp" : "done",
      entry_path,
      evidence: s.mfaVisible
        ? (s.mfaHint || "Email verification step with " + s.mfaFieldCount + " code fields")
        : "Account menu shows " + s.account
    });
    const poll = async (predicate, attempts = 100) => {
      for (let i = 0; i < attempts; i++) {
        try { const s = await read(); if (predicate(s)) return s; } catch { /* navigation can replace the execution context; only observations are retried */ }
        await waitMs(250);
      }
      return null;
    };
    const openForm = async () => {
      await js(() => {
        for (const host of document.querySelectorAll('[id^="wisepops-instance-"]')) host.shadowRoot?.querySelector("button.wisepops-close")?.click();
      });
      await click(".user-background");
      return poll(s => s.formVisible || !!s.challenge || !!s.account, 40);
    };

    try {
      if (mode === "otp") {
        let s = await read();
        const blocked = classify(s, "before_submit");
        if (blocked) return blocked;
        if (!s.mfaVisible || s.mfaFieldCount !== 6) return fail("login_form_unavailable", "No visible six-field email verification step; no code was submitted.", "before_submit");
        const bound = await js(() => [...document.querySelectorAll('.slider-visible input[data-vv-scope="mfa"]')].map((e, i) => { e.setAttribute("data-login-otp", String(i)); return i; }));
        if (bound.length !== 6) return fail("login_form_unavailable", "The verification step did not expose six code inputs; no code was submitted.", "before_submit");
        submitted = true;
        // The code inputs advance focus on each keystroke, so type once and repair any field the page skipped.
        await js(() => { for (const field of document.querySelectorAll('.slider-visible input[data-vv-scope="mfa"]')) { field.value = ""; field.dispatchEvent(new Event("input", { bubbles: true })); } });
        await click('.slider-visible input[data-login-otp="0"]');
        await typeText(otp);
        for (const i of bound) {
          const empty = await js(index => document.querySelector('.slider-visible input[data-login-otp="' + index + '"]')?.value.length === 0, { arg: i });
          if (empty) await fillInput('.slider-visible input[data-login-otp="' + i + '"]', otp[i]);
        }
        const populated = await js(() => [...document.querySelectorAll('.slider-visible input[data-vv-scope="mfa"]')].filter(e => e.value.length > 0).length);
        if (populated !== 6) return fail("login_form_unavailable", "The verification form kept " + (6 - populated) + " of its six code fields empty, so the site never evaluated a code.", "after_submit");
        s = await poll(x => !!x.account || x.errors.length > 0 || !!x.challenge || !x.mfaVisible);
        if (!s) return fail("unknown", "The verification result did not resolve; do not automatically retry.", "after_submit");
        const outcome = classify(s, "after_submit");
        if (outcome) return outcome;
        if (s.account) return succeed(s, "already_open");
        return fail("unknown", "The verification step closed without a confirmed account; inspect the page before any further attempt.", "after_submit");
      }

      let entry_path = mode === "credentials" ? "search_referrer" : "already_open";
      let s;
      if (mode === "credentials") {
        await gotoUrl("https://start.duckduckgo.com");
        if (!await waitForLoad(30) || !await waitForElement('textarea[name="q"]', { timeoutSec: 20 })) {
          return fail("entry_search_failed", "The search engine entry page did not present its search field; no other entry path is supported. No submission was made.", "search_entry");
        }
        await fillInput('textarea[name="q"]', search_query);
        await pressKey("Enter");
        const results = await waitForElement('a[data-testid="result-title-a"]', { timeoutSec: 25 });
        const searchState = await js(() => ({
          blocked: /unusual traffic|verify you are human|are you a robot|captcha/i.test(document.body?.innerText.slice(0, 4000) || ""),
          url: location.href
        }));
        if (searchState.blocked) return fail("captcha_or_challenge", "The search engine challenged this session before any Frontier request was made.", "search_entry", "site");
        if (!results) return fail("entry_search_failed", "The search engine returned no usable result list; no other entry path is supported. No submission was made.", "search_entry");
        const target = await js(() => {
          document.querySelectorAll("[data-login-entry]").forEach(e => e.removeAttribute("data-login-entry"));
          const link = [...document.querySelectorAll('a[data-testid="result-title-a"]')].find(a => {
            if (a.closest('[data-testid="ad"], li[data-layout="ad"], [data-layout="ad"]')) return false;
            try { const host = new URL(a.href).hostname; return host === "flyfrontier.com" || host.endsWith(".flyfrontier.com"); } catch { return false; }
          });
          if (!link) return null;
          link.setAttribute("data-login-entry", "true");
          return link.href;
        });
        if (!target) return fail("entry_result_missing", "No organic flyfrontier.com result was present for the search query; no other entry path is supported. No submission was made.", "search_entry");
        await click('a[data-login-entry="true"]');
        await waitForLoad(35);
        s = await poll(x => x.onSite || !!x.challenge, 60);
        if (!s || !s.onSite) return fail("entry_navigation_failed", "The organic search result did not land on flyfrontier.com; no other entry path is supported. No submission was made.", "site_entry");
        const entryOutcome = classify(s, "site_entry");
        if (entryOutcome) return entryOutcome;
      } else {
        s = await read();
      }

      const initial = classify(s, "before_submit");
      if (initial) return initial;
      if (s.account && !s.formVisible && !s.mfaVisible) return succeed(s, entry_path);
      if (s.mfaVisible) return fail("login_form_unavailable", "An email verification step is already open; complete it with otp mode instead.", "before_submit");
      if (!s.formVisible) {
        s = await openForm();
        if (!s) return fail("login_form_unavailable", "The account sign-in panel did not open. No submission was made.", "before_submit");
        const opened = classify(s, "before_submit");
        if (opened) return opened;
        if (!s.formVisible) return fail("login_form_unavailable", "The account sign-in panel did not open. No submission was made.", "before_submit");
      }

      if (mode === "credentials") {
        await fillInput('.login-container input[data-vv-scope="login-fields"][name="email"]', identifier.trim());
        await fillInput('.login-container input[data-vv-scope="login-fields"][name="password"]', password);
        const verified = await js(expected => {
          const email = document.querySelector('.login-container input[name="email"]');
          const pw = document.querySelector('.login-container input[name="password"]');
          return {
            identifier_matches: email?.value === expected.identifier,
            length_matches: pw?.value.length === expected.password.length,
            every_character_matches: !!pw && Array.from(expected.password).every((character, index) => pw.value[index] === character)
          };
        }, { arg: { identifier: identifier.trim(), password } });
        if (!verified.identifier_matches || !verified.length_matches || !verified.every_character_matches) {
          return fail("login_form_unavailable", "The form did not receive the exact credentials supplied. No submission was made.", "before_submit");
        }
      }
      s = await read();
      const beforeSubmit = classify(s, "before_submit");
      if (beforeSubmit) return beforeSubmit;
      if (!s.formFilled) return fail("invalid_input", "Both visible sign-in fields must contain values before submission. No submission was made.", "before_submit");
      if (mode === "prefilled_password" && text(identifier)) {
        const bound = await js(expected => document.querySelector('.login-container input[name="email"]')?.value.trim().toLowerCase() === expected, { arg: identifier.trim().toLowerCase() });
        if (!bound) return fail("invalid_input", "The filled sign-in form does not belong to the requested account. No submission was made.", "before_submit");
      }

      submitted = true;
      await click(".login-container .button");
      s = await poll(x => !!x.account || (x.mfaVisible && x.mfaHint) || x.errors.length > 0 || !!x.challenge || !x.onSite);
      // The verification panel becomes visible before the site reveals which address it emailed.
      if (!s) s = await poll(x => !!x.account || x.mfaVisible || x.errors.length > 0 || !!x.challenge || !x.onSite, 20);
      if (!s) return fail("unknown", "No sign-in result appeared; authentication is unconfirmed. Inspect the page before any further attempt.", "after_submit");
      const outcome = classify(s, "after_submit");
      if (outcome) return outcome;
      if (s.account && !s.formVisible) return succeed(s, entry_path);
      if (s.mfaVisible && s.mfaFieldCount === 6) return succeed(s, entry_path);
      return fail("unknown", "The sign-in result was neither an account session, a verification step, nor a site error. Inspect the page before any further attempt.", "after_submit");
    } catch {
      return fail("unknown", submitted
        ? "Browser interaction failed after the submission began; the outcome is unknown. Inspect the page before any further attempt."
        : "Browser interaction failed before any submission.", submitted ? "after_submit" : "before_submit");
    }
  }
}]
