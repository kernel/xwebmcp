[{
  kind: 'cdp',
  match: { url_patterns: ['https://alaskaair.com/*', 'https://*.alaskaair.com/*'] },
  tool: {
    name: 'login',
    description: 'Sign in to Alaska Airlines (Atmos Rewards) with a user ID or account number and password, or submit a verification code for a code step that is already visible. Opens the alaskaair.com "Sign in" link (Alaska\'s auth0.alaskaair.com page), fills the form, presses "Sign in" exactly once and waits up to 45 s for the result. Never retries, never resends codes, never registers, resets passwords or changes account settings; CAPTCHA and other challenges are reported, not solved. If the header already shows a signed-in profile, nothing is typed and status is already_signed_in: Alaska does not show the user ID, so the tool cannot prove that session belongs to the given identifier. signed_in=true only after Alaska returns to alaskaair.com with the profile menu signed in. Invoke serially with a 120-second timeout; afterwards list tools again because the document changed.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        mode: { type: 'string', enum: ['credentials', 'otp'] },
        identifier: { type: 'string', minLength: 1, maxLength: 100, description: 'Atmos Rewards / Mileage Plan / HawaiianMiles user ID or account number.' },
        password: { type: 'string', minLength: 1, maxLength: 128, description: 'Password; typed into the sign-in form and never returned or logged.' },
        otp: { type: 'string', pattern: '^[0-9]{4,8}$', description: 'Code the user received, for a code step that is already visible.' }
      },
      required: ['mode'],
      oneOf: [
        { properties: { mode: { const: 'credentials' } }, required: ['identifier', 'password'], not: { required: ['otp'] } },
        { properties: { mode: { const: 'otp' } }, required: ['otp'], not: { anyOf: [{ required: ['identifier'] }, { required: ['password'] }] } }
      ]
    },
    outputSchema: {
      type: 'object', additionalProperties: false,
      required: ['status', 'signed_in', 'message', 'next_step'],
      properties: {
        status: { type: 'string', enum: ['signed_in', 'already_signed_in', 'verification_required', 'invalid_credentials', 'challenge', 'locked_or_throttled', 'invalid_input', 'wrong_state', 'unknown'] },
        signed_in: { type: 'boolean', description: 'True only when the alaskaair.com header shows a signed-in profile after this call.' },
        submitted: { type: 'boolean', description: 'Whether this invocation pressed a submit button.' },
        message: { type: 'string', description: 'Site message or tool explanation; never contains credentials.' },
        next_step: { type: 'string' }
      }
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
  },
  execute: async (input) => {
    const out = (status, signed_in, message, next_step, submitted = false) => ({ status, signed_in, submitted, message, next_step });
    const mode = input?.mode;
    const identifier = typeof input?.identifier === 'string' ? input.identifier.trim() : '';
    const password = typeof input?.password === 'string' ? input.password : '';
    const otp = typeof input?.otp === 'string' ? input.otp.trim() : '';
    if (mode === 'credentials' && (!identifier || !password || input.otp !== undefined)) return out('invalid_input', false, 'credentials mode needs identifier and password and no otp; nothing was typed.', 'Call again with valid input.');
    if (mode === 'otp' && (!/^[0-9]{4,8}$/.test(otp) || input.identifier !== undefined || input.password !== undefined)) return out('invalid_input', false, 'otp mode needs only a 4-8 digit otp; nothing was typed.', 'Call again with valid input.');
    if (mode !== 'credentials' && mode !== 'otp') return out('invalid_input', false, 'mode must be credentials or otp; nothing was typed.', 'Call again with valid input.');


    // Alaska's auth0 page is a plain form: native value setters plus input events work, and also in a background tab
    // where trusted key events cannot reach the page.
    const fill = (sel, value) => js(([q, v]) => {
      const e = document.querySelector(q);
      if (!e) return false;
      e.focus();
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(e, v);
      e.dispatchEvent(new Event('input', { bubbles: true }));
      e.dispatchEvent(new Event('change', { bubbles: true }));
      e.blur();
      return e.value === v;
    }, { arg: [sel, value] });
    // Submit with the marked button as submitter (same as a click) after the tool settles its checks.
    const submit = () => js(() => { const b = document.querySelector('button[data-xwebmcp-submit="1"]'); b.form.requestSubmit(b); return true; });
    const host = async () => { try { return new URL((await pageInfo()).url).hostname; } catch { return ''; } };
    const onAuth = async () => (await host()) === 'auth0.alaskaair.com';
    // Header state on alaskaair.com: the profile button opens a panel with "Sign in" when signed out.
    const headerState = () => js(() => {
      const deep = (root, sel, acc = []) => { root.querySelectorAll(sel).forEach((e) => acc.push(e)); root.querySelectorAll('*').forEach((e) => e.shadowRoot && deep(e.shadowRoot, sel, acc)); return acc; };
      const hdr = document.querySelector('borealis-header');
      if (!hdr) return { header: false };
      const txt = (e) => (e.innerText || e.textContent || e.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
      const nodes = deep(hdr.shadowRoot || hdr, 'a, button').concat(deep(hdr, 'a, button'));
      const signInLink = nodes.find((e) => /^sign in$/i.test(txt(e)) && /\/login|auth0|signin/i.test(e.getAttribute('href') || '/login'));
      const signOut = nodes.some((e) => /^sign out$/i.test(txt(e)));
      const signInHref = signInLink ? new URL(signInLink.getAttribute('href') || '/account/login', location.href).href : null;
      return { header: true, signed_out_link: !!signInLink, sign_in_href: signInHref, sign_out: signOut };
    });
    const authState = () => js(() => {
      const v = (e) => !!e && e.getClientRects().length > 0;
      const t = (s) => (s || '').replace(/\s+/g, ' ').trim();
      const errs = [...document.querySelectorAll('[id*="error"], .ulp-input-error-message, .ulp-error-info, [role="alert"], .ulp-alert, #prompt-alert')].filter(v).map((e) => t(e.innerText)).filter(Boolean);
      const code = [...document.querySelectorAll('input')].find((e) => v(e) && (e.autocomplete === 'one-time-code' || /^(code|otp)$/i.test(e.name || '')));
      // Alaska shows a reCAPTCHA checkbox (.ulp-recaptcha) when it wants one; the image-challenge frame sits off-screen
      // until opened. A solved checkbox leaves a token in g-recaptcha-response.
      const shown = (f) => f.checkVisibility({ visibilityProperty: true, opacityProperty: true }) && f.getBoundingClientRect().bottom > 0;
      const checkbox = [...document.querySelectorAll('.ulp-captcha iframe, iframe[src*="recaptcha"][src*="anchor"], iframe[src*="hcaptcha"], iframe[src*="arkoselabs"]')].some(shown);
      const imageChallenge = [...document.querySelectorAll('iframe[src*="bframe"]')].some(shown);
      const token = (document.querySelector('#g-recaptcha-response')?.value || '').length > 0;
      const captchaFrame = imageChallenge || (checkbox && !token);
      return {
        path: location.pathname, user: v(document.querySelector('#username')), pass: v(document.querySelector('#password')),
        pass_filled: (document.querySelector('#password')?.value || '').length > 0,
        code: !!code, captcha: captchaFrame, errors: [...new Set(errs)].join(' | ').slice(0, 300),
        heading: t(document.querySelector('h1')?.innerText).slice(0, 120)
      };
    });
    const classify = (s) => {
      const e = s.errors || '';
      if (/lock|too many|throttl|suspend|blocked/i.test(e)) return 'locked_or_throttled';
      if (/wrong|incorrect|invalid|not (?:match|recogni)|couldn.t find/i.test(e)) return 'invalid_credentials';
      return null;
    };
    const waitOutcome = async () => {
      const until = Date.now() + 45000;
      while (Date.now() < until) {
        await waitMs(1000);
        let h;
        try { h = await host(); } catch { continue; }
        if (h && h !== 'auth0.alaskaair.com' && /(^|\.)alaskaair\.com$/.test(h)) {
          await waitForLoad(20);
          for (let i = 0; i < 15; i++) {
            let st = null;
            try { st = await headerState(); } catch { st = null; }
            if (st?.header && !st.signed_out_link) return out('signed_in', true, 'Alaska returned to ' + h + ' and the header no longer offers "Sign in".', 'Call get_page_context (list tools again first: the document changed).', true);
            await waitMs(1000);
          }
          return out('unknown', false, 'Alaska returned to alaskaair.com but the header still offers "Sign in".', 'Call get_page_context; do not call login again without checking.', true);
        }
        let s;
        try { s = await authState(); } catch { continue; }
        if (s.captcha && !s.pass_filled) return out('challenge', false, 'Alaska shows a CAPTCHA or bot challenge; the tool does not solve it.', 'Ask the user to complete the CAPTCHA in this tab without pressing Sign in, then call login again (Alaska clears the password after a challenged attempt).', true);
        if (s.code) return out('verification_required', false, 'Alaska asks for a verification code' + (s.heading ? ' (' + s.heading + ')' : '') + '.', 'Ask the user for the code they received and call login with mode "otp"; never guess or resend codes.', true);
        const k = classify(s);
        if (k) return out(k, false, s.errors, k === 'invalid_credentials' ? 'Ask the user to confirm the credentials; do not retry automatically.' : 'Stop and tell the user; do not retry.', true);
        if (s.errors && !s.user && !s.pass) return out('unknown', false, s.errors, 'Inspect the page with get_page_context; do not resubmit.', true);
      }
      return out('unknown', false, 'No result within 45 s after pressing Sign in.', 'Call get_page_context; do not call login again without checking.', true);
    };

    if (mode === 'otp') {
      if (!(await onAuth())) return out('wrong_state', false, 'No Alaska verification code step is open in this tab.', 'Use credentials mode first.');
      const s = await authState();
      if (!s.code) return out('wrong_state', false, 'The Alaska sign-in page is not asking for a code.', 'Call get_page_context.');
      const sel = 'input[autocomplete="one-time-code"], input[name="code"], input[name="otp"]';
      if (!(await fill(sel, otp))) return out('unknown', false, 'The code field did not keep the typed code; nothing was submitted.', 'Call get_page_context.');
      await js(() => { const b = [...document.querySelectorAll('button[type="submit"][name="action"]')].find((x) => x.getClientRects().length && x.value !== 'pick-authenticator'); b.setAttribute('data-xwebmcp-submit', '1'); });
      await submit();
      return waitOutcome();
    }

    if (!(await onAuth())) {
      const h = await host();
      if (!/(^|\.)alaskaair\.com$/.test(h)) return out('wrong_state', false, 'The tab is not on alaskaair.com.', 'Open https://www.alaskaair.com/ and call login again.');
      await waitForLoad(20);
      let st = null;
      for (let i = 0; i < 10 && !st?.header; i++) { try { st = await headerState(); } catch { st = null; } if (!st?.header) await waitMs(500); }
      if (!st?.header) {
        // Some content pages render no borealis header; the home page always does.
        await gotoUrl('https://www.alaskaair.com/');
        await waitForLoad(25);
        for (let i = 0; i < 20 && !st?.header; i++) { await waitMs(500); try { st = await headerState(); } catch { st = null; } }
      }
      if (!st?.header) return out('wrong_state', false, 'No Alaska header found even on the home page, so sign-in state is unknown; nothing was typed.', 'Call get_page_context.');
      // The profile panel only renders its "Sign in" link after opening; read the state before deciding.
      if (!st.signed_out_link) {
        await js(() => { const h = document.querySelector('borealis-header'); const r = h.shadowRoot || h; const b = [...r.querySelectorAll('button')].find((x) => /sign-in or profile|profile/i.test(x.getAttribute('aria-label') || '')); b && b.click(); });
        await waitMs(1500);
        st = await headerState();
      }
      if (!st.signed_out_link) return out('already_signed_in', true, 'The alaskaair.com header shows a signed-in profile; nothing was typed. Alaska does not display the user ID, so this session could not be matched to the identifier.', 'Confirm with the user that this is their account, or sign out manually first.');
      await gotoUrl(st.sign_in_href || 'https://www.alaskaair.com/account/login');
      const ready = await waitForElement('#username', { timeoutSec: 25 });
      if (!ready || !(await onAuth())) return out('unknown', false, 'Alaska\'s sign-in form did not appear within 25 s; nothing was typed.', 'Call get_page_context.');
    }
    const s0 = await authState();
    if (s0.code) return out('verification_required', false, 'A verification code step is already open; nothing was typed.', 'Ask the user for the code and call login with mode "otp".');
    if (s0.captcha) return out('challenge', false, 'Alaska\'s sign-in page shows a CAPTCHA that has not been completed; nothing was typed or submitted.', 'Ask the user to complete the CAPTCHA in this tab (without pressing Sign in), then call login again.');
    if (!s0.user || !s0.pass) return out('wrong_state', false, 'Alaska\'s sign-in page does not show the user ID and password fields; nothing was typed.', 'Call get_page_context.');
    const ok = (await fill('#username', identifier)) && (await fill('#password', password));
    if (!ok) return out('unknown', false, 'The sign-in form did not keep the typed values; nothing was submitted.', 'Call get_page_context.');
    const marked = await js(() => { const b = [...document.querySelectorAll('button[type="submit"][name="action"]')].find((x) => x.getClientRects().length && /sign in/i.test(x.innerText)); if (!b || b.disabled) return false; b.setAttribute('data-xwebmcp-submit', '1'); return true; });
    if (!marked) return out('unknown', false, 'No enabled "Sign in" button; nothing was submitted.', 'Call get_page_context.');
    await submit();
    return waitOutcome();
  }
}]
