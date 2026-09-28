[{
  kind: "cdp",
  match: { url_patterns: ["https://ubereats.com/*", "https://*.ubereats.com/*", "https://auth.uber.com/*"] },
  tool: {
    name: "register",
    description: "Start creating a NEW Uber Eats account for an email address. Needs a signed-out browser: if the tab is signed in to any Uber account it stops without changes. Opens ubereats.com, follows the site's own Sign up link, and submits the email exactly once. Returns status=challenge with channel=email and a masked destination when Uber emails a code (pass that code to complete_registration), or error_kind=existing_account when Uber shows the sign-in path for an account that already exists. Uber uses one flow for sign-up and sign-in, so an existing passwordless account also gets an email code; complete_registration then reports existing_account instead of creating anything. Calling register again while that sign-up is in progress in this tab returns its current state without submitting. Never enters a phone number, password, payment, or promo code.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["email"],
      properties: {
        email: { type: "string", minLength: 3, maxLength: 254, pattern: "^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$", description: "Address for the new account. The code is sent there." }
      }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false,
          required: ["ok", "status", "step", "challenge", "next_tool", "steps_submitted", "submission_attempted"],
          properties: {
            ok: { const: true }, status: { const: "challenge" },
            step: { enum: ["email_code", "sms_code"] },
            challenge: {
              type: "object", additionalProperties: false, required: ["channel", "destination_hint", "code_length"],
              properties: {
                channel: { enum: ["email", "sms"] },
                destination_hint: { type: "string", minLength: 1, description: "Masked address or phone the code was sent to; never the full value." },
                code_length: { type: "integer", minimum: 4, maximum: 8 }
              }
            },
            next_tool: { const: "complete_registration" },
            steps_submitted: { type: "array", items: { enum: ["email", "email_code", "phone", "sms_code", "profile"] } },
            submission_attempted: { type: "boolean" }
          }
        },
        {
          type: "object", additionalProperties: false,
          required: ["ok", "status", "step", "needs", "terms_text", "next_tool", "steps_submitted", "submission_attempted"],
          properties: {
            ok: { const: true }, status: { const: "needs_input" },
            step: { enum: ["phone", "profile"] },
            needs: { type: "array", minItems: 1, items: { enum: ["phone", "first_name", "last_name", "accept_terms"] } },
            terms_text: { type: ["string", "null"], description: "The site's terms wording when accept_terms is needed, so the caller can decide." },
            next_tool: { const: "resume_registration" },
            steps_submitted: { type: "array", items: { enum: ["email", "email_code", "phone", "sms_code", "profile"] } },
            submission_attempted: { type: "boolean" }
          }
        },
        {
          type: "object", additionalProperties: false,
          required: ["ok", "status", "step", "account_verified", "landing_url", "steps_submitted", "submission_attempted"],
          properties: {
            ok: { const: true }, status: { const: "registered" }, step: { const: "verify" },
            account_verified: { const: true, description: "The site's hashed account email equals the requested email." },
            landing_url: { type: "string" },
            steps_submitted: { type: "array", items: { enum: ["email", "email_code", "phone", "sms_code", "profile"] } },
            submission_attempted: { type: "boolean" }
          }
        },
        {
          type: "object", additionalProperties: false,
          required: ["ok", "error_kind", "error_message", "step", "steps_submitted", "submission_attempted"],
          properties: {
            ok: { const: false },
            error_kind: { enum: ["invalid_input", "signed_in", "existing_account", "phone_conflict", "phone_rejected", "email_rejected", "code_rejected", "code_expired", "duplicate_submission", "no_registration_in_progress", "other_registration_in_progress", "captcha_or_challenge", "locked_or_throttled", "unsupported_step", "wrong_account", "unknown"] },
            error_message: { type: "string", minLength: 1 },
            step: { enum: ["input", "entry", "email", "email_code", "phone", "sms_code", "profile", "verify"] },
            steps_submitted: { type: "array", items: { enum: ["email", "email_code", "phone", "sms_code", "profile"] } },
            submission_attempted: { type: "boolean" }
          }
        }
      ]
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false }
  },
  execute: async (input) => {
    // @xwebmcp-inline lib/input.js
    const typeInto = async (target, text, options = {}) => {
      await click(target);
      if (options.clear !== false) {
        await pressKey("a", ["Control"]);
        await pressKey("Backspace");
      }
      const shifted = '~!@#$%^&*()_+{}|:"<>?';
      const unshifted = '`1234567890-=[]\\;\',./';
      const random = options.random || Math.random;
      let previous = "";
      for (const character of text) {
        if (previous && options.cadence !== "none") {
          const pause = /[.@\s]/.test(previous) ? [80, 200] : [50, 120];
          await waitMs(pause[0] + Math.floor(random() * (pause[1] - pause[0] + 1)));
        }
        const uppercase = character >= "A" && character <= "Z";
        const symbol = shifted.indexOf(character);
        if (uppercase || symbol !== -1) {
          await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16, modifiers: 8 });
          try {
            await pressKey(uppercase ? character.toLowerCase() : unshifted[symbol], ["Shift"]);
          } finally {
            await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16, modifiers: 0 });
          }
        } else {
          await pressKey(character);
        }
        previous = character;
      }
    };
    // @xwebmcp-end
    const steps = [];
    let submitted = false;
    let step = "input";
    const scrub = message => String(message || "").replace(/[^\s@:]+@[^\s@]+\.[^\s@.]+/g, "[email]").replace(/\+?\d[\d\s().-]{5,}\d/g, "[number]").slice(0, 300);
    const fail = (kind, message) => ({ ok: false, error_kind: kind, error_message: scrub(message), step, steps_submitted: steps.slice(), submission_attempted: submitted });
    const ok = extra => ({ ok: true, ...extra, steps_submitted: steps.slice(), submission_attempted: submitted });
    const emailOk = v => typeof v === "string" && v.trim().length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim());
    const nameOk = v => typeof v === "string" && v.trim().length >= 1 && v.trim().length <= 50;
    const checkProfile = input => {
      if (input.phone !== undefined && (typeof input.phone !== "string" || !/^\+[1-9][0-9]{6,14}$/.test(input.phone))) return "phone must be an E.164 number such as +15551234567";
      for (const key of ["first_name", "last_name"]) if (input[key] !== undefined && !nameOk(input[key])) return key + " must be 1 to 50 characters";
      if (input.accept_terms !== undefined && input.accept_terms !== true) return "accept_terms may only be true";
      return null;
    };
    const maskEmail = e => { const [local, domain] = e.split("@"); return local.slice(0, 1) + "***@" + domain; };
    const markerKey = "webmcp.ubereats.register";

    // One read of the page: which Uber screen is showing and what it asks for. Screen detection follows the
    // element ids Uber's sign-up client renders (PHONE_NUMBER_or_EMAIL_ADDRESS, EMAIL_OTP_CODE-n,
    // PHONE_SMS_OTP-n, PHONE_NUMBER, FIRST_NAME, LAST_NAME, LEGAL_ACCEPT_TERMS).
    const read = async () => js(() => {
      const visible = e => !!e && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== "hidden";
      const text = e => (e.innerText || e.textContent || "").replace(/\s+/g, " ").trim();
      const all = selector => [...document.querySelectorAll(selector)].filter(visible);
      const byId = id => { const e = document.getElementById(id); return visible(e) ? e : null; };
      const host = location.hostname;
      const onSite = location.protocol === "https:" && (host === "ubereats.com" || host.endsWith(".ubereats.com"));
      const onAuth = location.protocol === "https:" && host === "auth.uber.com";
      const headings = all("h1,h2,h3,label,p").map(text).filter(t => t && t.length <= 400);
      const emailIn = t => t ? (t.match(/[^\s@:]+@[^\s@]+\.[^\s@.]+/) || [null])[0] : null;
      const identifier = byId("PHONE_NUMBER_or_EMAIL_ADDRESS");
      const emailCode = all('input[id^="EMAIL_OTP_CODE-"]');
      const smsCode = all('input[id^="PHONE_SMS_OTP-"]');
      const otherCode = all('input[id^="PHONE_VOICE_OTP-"], input[id^="PHONE_WHATSAPP_OTP-"], input[id^="TOTP"], input[id^="BACKUP_CODE"]');
      const phone = onAuth && !identifier ? byId("PHONE_NUMBER") : null;
      const firstName = byId("FIRST_NAME") || all('input[autocomplete="given-name"]')[0] || null;
      const lastName = byId("LAST_NAME") || all('input[autocomplete="family-name"]')[0] || null;
      // Uber renders the terms box as a styled checkbox whose input may be visually hidden.
      const termsRoot = document.getElementById("LEGAL_ACCEPT_TERMS");
      const termsBox = termsRoot ? (termsRoot.matches('input[type="checkbox"]') ? termsRoot : termsRoot.querySelector('input[type="checkbox"]')) : null;
      const termsShown = !!termsRoot && (visible(termsRoot) || visible(termsRoot.closest("label")) || visible(termsRoot.parentElement));
      const termsTextEl = document.getElementById("accept-terms-text");
      const extraBoxes = [...document.querySelectorAll('input[type="checkbox"]')].filter(b => b !== termsBox && (visible(b) || visible(b.closest("label"))));
      const password = all('input[type="password"]')[0] || null;
      const moreOptions = visible(document.getElementById("alt-action-help-v2"));
      const chooser = !password && !emailCode.length && !smsCode.length && !identifier && !phone && headings.some(t => /welcome back/i.test(t)) && moreOptions;
      let dial = null;
      if (phone) {
        let node = phone.parentElement;
        for (let depth = 0; node && depth < 6 && !dial; depth++, node = node.parentElement) {
          const hit = [...node.querySelectorAll("button, span, div")].find(e => !e.contains(phone) && /^\+\d{1,4}$/.test(text(e)));
          if (hit) dial = text(hit);
        }
      }
      const forward = document.querySelector("#forward-button");
      const errors = [...new Set(all('[role="alert"], [data-testid="inline_error"]').map(text).map(t => t.replace(/^Error:\s*/i, "")).filter(Boolean))];
      const challengeFrame = all("iframe").find(e => { const r = e.getBoundingClientRect(); return r.width > 100 && r.height > 60 && /captcha|arkose|funcaptcha|challenge|turnstile/i.test((e.title || "") + " " + (e.src || "")); });
      const challengeText = headings.find(t => /verify (?:that )?you(?:'re| are) (?:a )?human|are you a robot|unusual (?:activity|traffic)|security check|complete the (?:captcha|puzzle)|press (?:and|&) hold/i.test(t));
      const proxyError = /proxy error/i.test(document.title) || /provider_unreachable/.test((document.body && document.body.innerText || "").slice(0, 2000));
      const smsHint = smsCode.length ? (headings.map(t => t.match(/sent (?:via SMS |by SMS )?(?:at|to):?\s+(\S*\d{2,})\.?$/i)).find(Boolean) || [null, null])[1] : null;
      const codeFor = emailCode.length ? emailIn(headings.find(t => /code sent to you at/i.test(t)) || null) : null;
      let kind = "unknown";
      if (challengeFrame || challengeText) kind = "challenge";
      else if (proxyError) kind = "proxy_error";
      else if (onSite) kind = "site";
      else if (!onAuth) kind = "other";
      else if (emailCode.length) kind = "email_code";
      else if (smsCode.length) kind = "sms_code";
      else if (otherCode.length) kind = "other_code";
      else if (identifier) kind = "identifier";
      else if (password) kind = "password";
      else if (chooser) kind = "chooser";
      else if (phone || firstName || lastName || termsShown) kind = "profile";
      else if (document.getElementById("consent-to-all-btn")) kind = "unsupported";
      return {
        url: location.href, onSite, onAuth, kind, ready: document.readyState === "complete",
        signature: [kind, phone ? "phone" : "", firstName ? "first" : "", lastName ? "last" : "", termsShown ? "terms" : "", headings.slice(0, 2).join("|")].join("/"),
        identifierValue: identifier ? identifier.value.trim().toLowerCase() : "",
        codeCount: emailCode.length || smsCode.length, codeFilled: [...emailCode, ...smsCode].every(e => e.value.length === 1), codeFor, smsHint,
        fields: { phone: !!phone, first_name: !!firstName, last_name: !!lastName, accept_terms: termsShown },
        phoneDigits: phone ? phone.value.replace(/\D/g, "") : "", firstValue: firstName ? firstName.value : "", lastValue: lastName ? lastName.value : "",
        termsChecked: !!termsBox && (termsBox.checked || termsBox.getAttribute("aria-checked") === "true"), termsText: termsTextEl ? text(termsTextEl).slice(0, 400) : (termsShown ? text(termsRoot.closest("label") || termsRoot).slice(0, 400) : null),
        extraBoxes: extraBoxes.map(b => text(b.closest("label") || b.parentElement || b).slice(0, 120)),
        dial, forwardEnabled: !!forward && visible(forward) && !forward.disabled && forward.getAttribute("aria-disabled") !== "true",
        errors, feedbackFresh: !window.__ueRegWatch || window.__ueRegWatch.changed,
        challenge: challengeText || (challengeFrame ? (challengeFrame.title || "Visible challenge frame") : null),
        headings: headings.slice(0, 4),
        headerSignUp: onSite ? [...document.querySelectorAll('header a[href^="https://auth.uber.com/"]')].filter(visible).some(a => /sign up|log in/i.test(text(a))) : false
      };
    });
    const hash = async value => js(async v => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(v)))].map(b => b.toString(16).padStart(2, "0")).join(""), { arg: value });
    const getMarker = async () => js(key => { try { return JSON.parse(sessionStorage.getItem(key) || "null"); } catch { return null; } }, { arg: markerKey });
    const setMarker = async value => js(({ key, value }) => { sessionStorage.setItem(key, JSON.stringify(value)); }, { arg: { key: markerKey, value } });
    // Signed out, Uber's user endpoint answers HTTP 200 with a failure body carrying code 403
    // (rtapi.forbidden) rather than isLoggedIn: false. Only a successful read with a
    // 64-character hash can confirm an account; anything else is "not confirmed", never success.
    const account = async () => js(async () => {
      if (!/(^|\.)ubereats\.com$/.test(location.hostname)) return { state: "off_site" };
      try {
        const res = await fetch("/_p/api/getUserV1?localeCode=en-US", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", "x-csrf-token": "x" }, body: "{}" });
        const body = await res.json().catch(() => null);
        const user = body && body.status === "success" ? body.data || {} : null;
        if (!user) return { state: res.status === 403 || res.status === 401 || /forbidden/i.test(JSON.stringify(body || {})) ? "signed_out" : "unknown" };
        if (!user.isLoggedIn) return { state: "signed_out" };
        return { state: "signed_in", hashedEmail: typeof user.hashedEmail === "string" && user.hashedEmail.length === 64 ? user.hashedEmail.toLowerCase() : null };
      } catch { return { state: "unknown" }; }
    });
    const arm = async () => js(() => {
      window.__ueRegWatch && window.__ueRegWatch.cleanup();
      const selector = '[role="alert"], [data-testid="inline_error"]';
      const relevant = node => node.nodeType === 1 ? !!node.closest(selector) || !!node.querySelector(selector) : !!(node.parentElement && node.parentElement.closest(selector));
      const watch = { changed: false };
      const observer = new MutationObserver(records => { if (records.some(r => relevant(r.target) || [...r.addedNodes, ...r.removedNodes].some(relevant))) watch.changed = true; });
      watch.cleanup = () => { observer.disconnect(); delete window.__ueRegWatch; };
      window.__ueRegWatch = watch;
      observer.observe(document.body, { subtree: true, childList: true, characterData: true });
    });
    const poll = async (predicate, seconds) => {
      const deadline = Date.now() + seconds * 1000;
      while (Date.now() < deadline) {
        try { const s = await read(); if (await predicate(s)) return s; } catch { /* navigation replaces the context */ }
        await waitMs(500);
      }
      return null;
    };
    const fresh = s => s.errors.length > 0 && s.feedbackFresh;
    const classifyError = (s, where) => {
      const message = s.errors.join(" ");
      if (/too many|try again (?:later|in)|rate limit|temporarily (?:blocked|locked)|suspended|banned/i.test(message)) return fail("locked_or_throttled", message);
      if (/captcha|robot|human verification/i.test(message)) return fail("captcha_or_challenge", message);
      if (where === "code") return fail(/expired/i.test(message) ? "code_expired" : "code_rejected", message + " The code was not retried; request a new one on the site or start over with register.");
      if (where === "phone" && /already (?:in use|associated|registered|linked|exists|taken)|another account|belongs to|registered to|linked to/i.test(message)) return fail("phone_conflict", message + " Nothing further was submitted and no account was changed.");
      if (where === "phone") return fail("phone_rejected", message);
      if (where === "email") return fail("email_rejected", message);
      return fail("unknown", message);
    };
    // Waits for the screen after a submission: a different screen, fresh feedback, a challenge, or the site.
    // A screen with no recognized fields counts only once it shows text, so a loading state is waited out.
    const settledOn = (x, before) => x.signature !== before.signature && (x.kind !== "unknown" || x.headings.length > 0);
    const afterSubmit = async (before, seconds) => poll(async x => !!x.challenge || x.kind === "proxy_error" || fresh(x) || x.kind === "site" || settledOn(x, before), seconds);
    const verified = async (expected, url) => {
      step = "verify";
      const who = await account();
      if (who.state !== "signed_in") return fail("unknown", "The site did not report a signed-in account after sign-up; open the site and check before any retry.");
      if (!who.hashedEmail) return fail("unknown", "The site did not return an account identity to verify; the result is not confirmed.");
      if (who.hashedEmail !== expected) return fail("wrong_account", "The session is signed in to a different Uber account than the requested email. Nothing further was submitted.");
      return ok({ status: "registered", step: "verify", account_verified: true, landing_url: url });
    };
    const waitSignedIn = async seconds => poll(async x => x.kind === "site" && x.ready && (await account()).state === "signed_in" || !!x.challenge, seconds);

    // Walks the registration from whatever screen is showing. Code screens are returned as challenges and never
    // submitted here; profile screens are submitted once each when every field they ask for was supplied.
    const advance = async (input, expected, marker, maxSteps) => {
      for (let i = 0; i < maxSteps; i++) {
        const s = await read();
        if (s.kind === "challenge") return fail("captcha_or_challenge", s.challenge + ". Nothing further was submitted.");
        if (s.kind === "proxy_error") return fail("unknown", "The browser's proxy could not reach Uber (proxy error page). Nothing further was submitted.");
        if (s.kind === "site") {
          const done = await waitSignedIn(30);
          if (!done) return fail("unknown", "Uber returned to the site but no signed-in account appeared within 30 seconds; check before any retry.");
          if (done.challenge) return fail("captcha_or_challenge", done.challenge);
          await js(({ key, value }) => { sessionStorage.setItem(key, JSON.stringify(value)); }, { arg: { key: markerKey + ".done", value: { h: expected, signup_seen: !!marker.signup_seen, at: Date.now() } } });
          if (!marker.signup_seen) { step = "verify"; return fail("existing_account", "The email already had an Uber account: the code signed this session in to it and no sign-up screen appeared. Nothing on that account was changed."); }
          return verified(expected, done.url);
        }
        if (s.kind === "email_code") {
          step = "email_code";
          if (s.codeFor && (await hash(s.codeFor.toLowerCase())) !== expected) return fail("wrong_account", "Uber's code step belongs to a different email; nothing submitted.");
          return ok({ status: "challenge", step: "email_code", challenge: { channel: "email", destination_hint: s.codeFor ? maskEmail(s.codeFor.toLowerCase()) : "the email address entered", code_length: Math.min(8, Math.max(4, s.codeCount)) }, next_tool: "complete_registration" });
        }
        if (s.kind === "sms_code") {
          step = "sms_code";
          if (!marker.phone_at) return fail("existing_account", "Uber asked for a text-message code before any phone was entered, which is its sign-in check for an existing account. Nothing further was submitted.");
          return ok({ status: "challenge", step: "sms_code", challenge: { channel: "sms", destination_hint: s.smsHint ? scrub(s.smsHint) : "the phone ending in " + marker.phone_last2, code_length: Math.min(8, Math.max(4, s.codeCount)) }, next_tool: "complete_registration" });
        }
        if (s.kind === "identifier") { step = "entry"; return fail("no_registration_in_progress", "Uber is back at its first step; the earlier sign-up is no longer active. Call register to start again."); }
        if (s.kind === "chooser" || s.kind === "password") {
          if (marker.phone_at && !marker.signup_seen_after_phone) { step = "phone"; return fail("phone_conflict", "After the phone number Uber offered to sign in to an existing account, so the number already belongs to an account. Nothing further was submitted."); }
          step = marker.email_code_at ? "profile" : "email";
          return fail(marker.email_code_at ? "unsupported_step" : "existing_account", marker.email_code_at ? "Uber asked for a password or sign-in method during sign-up; this tool does not set passwords. Nothing further was submitted." : "The email already has an Uber account (Uber offered its sign-in methods). Nothing further was submitted.");
        }
        if (s.kind !== "profile") {
          step = "profile";
          return fail("unsupported_step", "Uber shows a screen this tool does not handle (" + (s.headings.join(" / ") || s.kind) + "). Nothing further was submitted; finish it by hand or report it.");
        }
        step = s.fields.phone ? "phone" : "profile";
        const needs = [];
        if (s.fields.phone && !input.phone) needs.push("phone");
        if (s.fields.first_name && !input.first_name) needs.push("first_name");
        if (s.fields.last_name && !input.last_name) needs.push("last_name");
        if (s.fields.accept_terms && input.accept_terms !== true) needs.push("accept_terms");
        if (needs.length) return ok({ status: "needs_input", step, needs, terms_text: s.fields.accept_terms && s.termsText ? scrub(s.termsText) : null, next_tool: "resume_registration" });
        if (headingsConflict(s)) return fail("phone_conflict", "Uber reports the phone number is linked to another account. Nothing further was submitted.");
        const signatureHash = await hash(s.signature);
        if (marker.last_profile === signatureHash && Date.now() - (marker.profile_at || 0) < 60000) return fail("duplicate_submission", "This screen was already submitted from this tab less than a minute ago; call resume_registration to see where it went.");
        if (s.fields.phone) {
          if (!s.dial) return fail("unsupported_step", "The phone step's country code could not be read; nothing submitted.");
          if (!input.phone.startsWith(s.dial)) return fail("invalid_input", "Uber preselected country code " + s.dial + ", which does not match the phone number; nothing submitted. Changing the country is not supported.");
          await typeInto("#PHONE_NUMBER", input.phone.slice(s.dial.length));
        }
        if (s.fields.first_name || s.fields.last_name) await js(() => {
          const tag = (el, name) => { if (el) el.setAttribute("data-webmcp-" + name, "true"); };
          tag(document.getElementById("FIRST_NAME") || document.querySelector('input[autocomplete="given-name"]'), "first");
          tag(document.getElementById("LAST_NAME") || document.querySelector('input[autocomplete="family-name"]'), "last");
        });
        if (s.fields.first_name) await typeInto('[data-webmcp-first="true"]', input.first_name.trim());
        if (s.fields.last_name) await typeInto('[data-webmcp-last="true"]', input.last_name.trim());
        if (s.fields.accept_terms && !s.termsChecked) await js(() => {
          const root = document.getElementById("LEGAL_ACCEPT_TERMS");
          const box = root.matches('input[type="checkbox"]') ? root : root.querySelector('input[type="checkbox"]');
          (box && box.closest("label") || box || root).click();
        });
        const filled = await poll(async x => x.signature === s.signature && x.forwardEnabled
          && (!s.fields.phone || x.phoneDigits.endsWith(input.phone.slice(s.dial.length).replace(/\D/g, "")))
          && (!s.fields.first_name || x.firstValue.trim() === input.first_name.trim())
          && (!s.fields.last_name || x.lastValue.trim() === input.last_name.trim())
          && (!s.fields.accept_terms || x.termsChecked), 10);
        if (!filled) return fail("unknown", "The step's fields or its Next control did not become ready; nothing submitted.");
        if (fresh(filled) && filled.errors.length) return classifyError(filled, s.fields.phone ? "phone" : "profile");
        const now = Date.now();
        Object.assign(marker, { last_profile: signatureHash, profile_at: now, signup_seen: true });
        if (s.fields.phone) Object.assign(marker, { phone_at: now, phone_last2: input.phone.slice(-2) });
        else if (marker.phone_at) marker.signup_seen_after_phone = true;
        await setMarker(marker);
        await arm();
        submitted = true;
        steps.push(s.fields.phone ? "phone" : "profile");
        await click("#forward-button");
        const next = await afterSubmit(filled, 45);
        if (!next) return fail("unknown", "The " + step + " submission produced no recognizable result within 45 seconds; inspect the browser before any retry.");
        if (next.kind === "challenge") return fail("captcha_or_challenge", next.challenge);
        if (next.signature === filled.signature && fresh(next)) return classifyError(next, s.fields.phone ? "phone" : "profile");
      }
      return fail("unknown", "Sign-up did not reach a code step, a question, or completion within the step budget; call resume_registration.");
    };
    const headingsConflict = s => s.headings.some(t => /already (?:associated|linked|in use|registered)|belongs to another account|is this you\??$|already have an account/i.test(t));

    if (!input || typeof input !== "object" || Array.isArray(input)) return fail("invalid_input", "Input must be an object with an email; nothing submitted.");
    if (Object.keys(input).some(k => k !== "email")) return fail("invalid_input", "register takes only email; nothing submitted.");
    if (!emailOk(input.email)) return fail("invalid_input", "email must be an email address; nothing submitted.");
    const email = input.email.trim().toLowerCase();
    try {
      step = "entry";
      let s = await read();
      const expected = await hash(email);
      if (s.onAuth) {
        const marker = await getMarker();
        if (marker && marker.h === expected && Date.now() - marker.started < 60 * 60000 && s.kind !== "identifier") return await advance({}, expected, marker, 1);
        if (marker && marker.h !== expected && s.kind !== "identifier") return fail("other_registration_in_progress", "This tab is in the middle of a sign-up for a different email; nothing submitted.");
      }
      if (!s.onSite || s.kind === "site" && !s.ready) {
        await gotoUrl("https://www.ubereats.com/");
        s = await poll(async x => x.kind === "site" && x.ready || !!x.challenge || x.kind === "proxy_error", 30);
        if (!s) return fail("unknown", "ubereats.com did not load; nothing submitted.");
        if (s.challenge) return fail("captcha_or_challenge", s.challenge + "; nothing submitted.");
        if (s.kind === "proxy_error") return fail("unknown", "The browser's proxy could not reach ubereats.com; nothing submitted.");
      }
      const who = await account();
      if (who.state === "signed_in") {
        if (who.hashedEmail === expected) return fail("existing_account", "This session is already signed in to an Uber account with that email; nothing submitted.");
        return fail("signed_in", "This session is signed in to an Uber account. Registration needs a signed-out browser; nothing submitted and the account was not changed.");
      }
      if (who.state !== "signed_out") return fail("unknown", "Could not confirm that the session is signed out; nothing submitted.");

      // Hydration replaces the server-rendered header shortly after load, so the link is re-resolved before each click.
      let opened = false;
      for (let attempt = 0; attempt < 3 && !opened; attempt++) {
        const tagged = await js(() => {
          document.querySelectorAll("[data-webmcp-signup]").forEach(e => e.removeAttribute("data-webmcp-signup"));
          const links = [...document.querySelectorAll('header a[href^="https://auth.uber.com/"]')].filter(a => a.getClientRects().length > 0);
          const link = links.find(a => /^sign up$/i.test((a.innerText || "").trim())) || links.find(a => /^log in$/i.test((a.innerText || "").trim()));
          if (!link) return false;
          link.setAttribute("data-webmcp-signup", "true");
          return true;
        });
        if (!tagged) break;
        await waitMs(1500);
        if (!await js(() => { const l = document.querySelector('[data-webmcp-signup="true"]'); return !!l && l.isConnected; })) continue;
        try { await click('[data-webmcp-signup="true"]'); opened = true; } catch { /* replaced under the click; resolve again */ }
      }
      if (!opened) return fail("unknown", "The site's Sign up link could not be clicked; nothing submitted.");
      step = "email";
      s = await poll(async x => x.kind === "identifier" || x.kind === "challenge" || x.kind === "proxy_error" || (x.onAuth && x.kind !== "unknown"), 30);
      if (!s) return fail("unknown", "Uber's sign-up page did not show its email step; nothing submitted.");
      if (s.kind === "challenge") return fail("captcha_or_challenge", s.challenge + "; nothing submitted.");
      if (s.kind === "proxy_error") return fail("unknown", "The browser's proxy could not reach auth.uber.com (proxy error page); nothing submitted.");
      if (s.kind !== "identifier") return fail("unknown", "Uber's sign-up page opened on an unexpected step (" + s.kind + "); nothing submitted.");
      const previous = await getMarker();
      if (previous && previous.h === expected && previous.email_at && Date.now() - previous.email_at < 15 * 60000) return fail("duplicate_submission", "A code was already requested for this email from this tab in the last 15 minutes; use the code already sent with complete_registration, or wait before starting over.");
      await typeInto("#PHONE_NUMBER_or_EMAIL_ADDRESS", email);
      const ready = await poll(async x => x.kind === "identifier" && x.identifierValue === email && x.forwardEnabled, 10);
      if (!ready) return fail("unknown", "The email field or its Continue control did not become ready; nothing submitted.");
      const marker = { h: expected, started: Date.now(), email_at: Date.now() };
      await setMarker(marker);
      await arm();
      submitted = true;
      steps.push("email");
      await click("#forward-button");
      const next = await afterSubmit(ready, 45);
      if (!next) return fail("unknown", "Submitting the email produced no recognizable result within 45 seconds; inspect the browser before any retry.");
      if (next.kind === "challenge") return fail("captcha_or_challenge", next.challenge + ". The solver may still be running; do not click again.");
      if (next.kind === "identifier" && fresh(next)) return classifyError(next, "email");
      if (next.kind === "chooser" || next.kind === "password") return fail("existing_account", "The email already has an Uber account (Uber offered its sign-in methods). Nothing further was submitted and the account was not changed.");
      if (next.kind === "sms_code") return fail("existing_account", "Uber asked for a text-message code for this email, which is its sign-in check for an existing account. Nothing further was submitted.");
      return await advance({}, expected, marker, 1);
    } catch (error) {
      return fail("unknown", (submitted ? "Browser interaction failed after a submission; the outcome is unknown. Inspect the browser before any retry." : "Browser interaction failed before any submission.") + " Cause: " + String(error && error.message || error).slice(0, 120));
    } finally {
      try { await js(() => window.__ueRegWatch && window.__ueRegWatch.cleanup()); } catch { /* the page may have navigated */ }
    }
  }
}]
