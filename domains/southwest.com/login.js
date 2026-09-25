[
  {
    kind: 'cdp',
    match: { url_patterns: ['https://southwest.com/*', 'https://*.southwest.com/*'] },
    tool: {
      name: 'login',
      description: 'Navigate to Southwest login when necessary and submit account number or username and password at most once. Serial invocations only. Alternatively submit fields already populated by secure vault fill with use_prefilled=true. Never retries. logged_in=true means first-step acceptance; check authenticated and mfa_required before treating the session as authenticated. Stops for human MFA or captcha; does not solve or submit them.',
      inputSchema: {
        type: 'object',
        properties: {
          username: { type: 'string', minLength: 4, maxLength: 20, description: 'Account number or username, not email.' },
          password: { type: 'string', minLength: 8, maxLength: 16 },
          use_prefilled: { type: 'boolean', description: 'Explicitly submit the current form after secure vault fill; credentials are not read back.' },
          remember_me: { type: 'boolean', default: false }
        },
        additionalProperties: false,
        oneOf: [
          { required: ['username', 'password'], properties: { use_prefilled: { const: false } } },
          { required: ['use_prefilled'], properties: { use_prefilled: { const: true } }, not: { anyOf: [{ required: ['username'] }, { required: ['password'] }] } }
        ]
      },
      outputSchema: {
        type: 'object',
        oneOf: [
          {
            type: 'object', additionalProperties: false,
            required: ['logged_in', 'authenticated', 'landing_url', 'account_name_or_hint', 'mfa_required', 'next_step', 'evidence'],
            properties: {
              logged_in: { const: true }, authenticated: { type: 'boolean' },
              landing_url: { type: 'string', format: 'uri' },
              account_name_or_hint: { type: ['string', 'null'] },
              mfa_required: { type: 'boolean' },
              next_step: { enum: ['none', 'complete_mfa_in_browser'] },
              evidence: { type: 'string' }
            },
            oneOf: [
              { properties: { authenticated: { const: true }, mfa_required: { const: false }, next_step: { const: 'none' } } },
              { properties: { authenticated: { const: false }, mfa_required: { const: true }, next_step: { const: 'complete_mfa_in_browser' } } }
            ]
          },
          {
            type: 'object', additionalProperties: false,
            required: ['logged_in', 'error_kind', 'error_message', 'attempts_remaining_if_shown', 'submitted', 'submission_state'],
            properties: {
              logged_in: { const: false },
              error_kind: { enum: ['invalid_input', 'invalid_credentials', 'captcha_or_challenge', 'mfa_failed', 'locked_or_throttled', 'unknown'] },
              error_message: { type: 'string' },
              attempts_remaining_if_shown: { type: ['integer', 'null'], minimum: 0 },
              submitted: { type: 'boolean', description: 'True once clicking submit was attempted, even if dispatch is uncertain. Check submission_state; never automatically retry.' },
              submission_state: { enum: ['not_dispatched', 'dispatched', 'unknown'] }
            }
          }
        ]
      },
      annotations: { destructiveHint: false, readOnlyHint: false }
    },
    execute: async (input) => {
      let submitted = false;
      let watchStarted = false;
      let submissionState = 'not_dispatched';
      const fail = (kind, message) => {
        const remaining = message.match(/(\d+)\s+(?:login\s+)?attempts?\s+(?:remaining|left)/i);
        return { logged_in: false, error_kind: kind, error_message: message, attempts_remaining_if_shown: remaining ? Number(remaining[1]) : null, submitted, submission_state: submissionState };
      };
      const classify = (text) => {
        if (/too many|locked|try again (?:in|later)|temporarily blocked|rate limit/i.test(text)) return 'locked_or_throttled';
        if (/captcha|verify (?:that )?you(?: are|'re) human|access denied|security challenge|unusual traffic/i.test(text)) return 'captcha_or_challenge';
        if (/(?:code|otp).*(?:incorrect|invalid|expired)|(?:incorrect|invalid|expired).*(?:code|otp)/i.test(text)) return 'mfa_failed';
        if (/The username\/account number and\/or password are incorrect\./i.test(text)) return 'invalid_credentials';
        if (/Enter a valid (?:password|username|account)|required/i.test(text)) return 'invalid_input';
        return 'unknown';
      };
      const observe = async () => js(() => {
        const visible = e => !!e && !!e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden' && getComputedStyle(e).display !== 'none';
        const clean = e => (e.innerText || e.textContent || '').trim();
        const feedback = [...document.querySelectorAll('[role="alert"], [id$="Error"], [class*="errorMessage"]')].filter(visible).map(clean).filter(Boolean);
        const signals = [...document.querySelectorAll('h1,h2,h3,[role="dialog"],main p,form p')].filter(visible).map(clean).filter(Boolean);
        const challenge = signals.find(t => /captcha|access denied|verify (?:that )?you(?: are|'re) human|security challenge|unusual traffic/i.test(t));
        const challengeFrame = [...document.querySelectorAll('iframe')].find(e => visible(e) && /captcha|challenge/i.test((e.title || '') + ' ' + (e.src || '')) && e.getBoundingClientRect().width > 100 && e.getBoundingClientRect().height > 60);
        const logout = [...document.querySelectorAll('a,button')].find(e => visible(e) && /^(?:log out|logout|sign out)$/i.test(clean(e)));
        const otp = [...document.querySelectorAll('input')].find(e => visible(e) && /one-time-code|verification.?code|security.?code|otp/i.test([e.autocomplete,e.name,e.id,e.getAttribute('aria-label')].join(' ')));
        const mfa = signals.find(t => /(?:we(?:'ve| have)? (?:sent|texted|emailed)|code (?:was |has been )?sent|enter (?:the |your )?(?:verification|security|one.time) code)/i.test(t));
        return {
          url: location.href, origin: location.origin,
          form: visible(document.querySelector('#username')) && visible(document.querySelector('#password')), errors: [...new Set(feedback)],
          feedbackFresh: !window.__swLoginWatch || window.__swLoginWatch.changed,
          submitObserved: !!window.__swLoginWatch?.submitted,
          challenge: challenge || (challengeFrame ? challengeFrame.title || 'Visible captcha/challenge frame' : null),
          logout: logout ? clean(logout) : null,
          mfa: otp && mfa ? mfa.slice(0,800) : null
        };
      });
      const outcome = state => {
        if (state.origin !== 'https://www.southwest.com') return fail('unknown', 'Navigation left the approved Southwest origin; no further interaction performed.');
        if (state.challenge) return fail('captcha_or_challenge', state.challenge);
        if (state.errors.length && (!watchStarted || state.feedbackFresh)) {
          const text = state.errors.join('\n');
          return fail(classify(text), text);
        }
        if (state.logout && !state.form) return {
          logged_in: true, authenticated: true, landing_url: state.url,
          account_name_or_hint: null, mfa_required: false, next_step: 'none',
          evidence: 'Visible ' + state.logout + ' control and no visible login form.'
        };
        if (state.mfa && !state.form) return {
          logged_in: true, authenticated: false, landing_url: state.url,
          account_name_or_hint: null, mfa_required: true,
          next_step: 'complete_mfa_in_browser', evidence: state.mfa
        };
        return null;
      };
      if (!input || typeof input !== 'object' || Array.isArray(input)) return fail('invalid_input', 'Provide username and password, or explicitly set use_prefilled=true.');
      if (Object.keys(input).some(k => !['username','password','use_prefilled','remember_me'].includes(k))) return fail('invalid_input', 'Unrecognized input field.');
      if (input.remember_me !== undefined && typeof input.remember_me !== 'boolean') return fail('invalid_input', 'remember_me must be boolean.');
      if (input.use_prefilled !== undefined && typeof input.use_prefilled !== 'boolean') return fail('invalid_input', 'use_prefilled must be boolean.');
      if (input.use_prefilled === true) {
        if ('username' in input || 'password' in input) return fail('invalid_input', 'Do not combine prefilled mode with credential arguments.');
      } else if (typeof input.username !== 'string' || !input.username.trim() || input.username.length < 4 || input.username.length > 20 || typeof input.password !== 'string' || input.password.length < 8 || input.password.length > 16) {
        return fail('invalid_input', 'Provide an account number or username (4–20 characters) and password (8–16 characters).');
      }
      try {
        const entryUrl = 'https://www.southwest.com/';
        const initialUrl = new URL((await pageInfo()).url);
        let navigated = false;
        const openEntry = async () => {
          await gotoUrl(entryUrl);
          navigated = true;
          return await waitForLoad(15);
        };
        if (initialUrl.origin !== 'https://www.southwest.com' && !await openEntry()) return fail('unknown', 'Login entry did not finish loading.');
        let state = await observe();
        if (state.origin !== 'https://www.southwest.com') return outcome(state);
        if (state.challenge || state.logout || state.mfa) return outcome(state) || fail('unknown', 'Current page state does not permit login.');
        if (state.errors.some(t => ['locked_or_throttled', 'captcha_or_challenge', 'mfa_failed'].includes(classify(t)))) return outcome(state);
        if (!state.form && state.url !== entryUrl) {
          if (!await openEntry()) return fail('unknown', 'Login entry did not finish loading.');
          state = await observe();
          if (state.origin !== 'https://www.southwest.com' || state.challenge || state.logout || state.mfa) return outcome(state) || fail('unknown', 'Current page state does not permit login.');
        }
        if (!state.form) {
          let open;
          for (let i = 0; i < 30 && !open; i++) {
            const nodes = (await accessibilitySnapshot()).nodes;
            open = nodes.find(n => n.role === 'button' && n.name === 'Passenger Log in');
            if (!open) await waitMs(500);
          }
          if (!open) return fail('unknown', 'Southwest login entry point was not found.');
          await click({ backendNodeId: open.backendNodeId });
          if (!await waitForElement('#username', { timeoutSec: 15 })) return fail('unknown', 'Login form did not appear.');
        }
        state = await observe();
        if (state.origin !== 'https://www.southwest.com' || state.challenge || state.logout || state.mfa) return outcome(state) || fail('unknown', 'Current page state does not permit login.');
        if (!state.form) return fail('unknown', 'Login fields are not visible; nothing submitted.');
        if (state.errors.some(t => ['locked_or_throttled', 'captcha_or_challenge', 'mfa_failed'].includes(classify(t)))) return outcome(state);
        if (input.use_prefilled && navigated) return fail('invalid_input', 'Login entry opened on a new page; securely fill this form before invoking prefilled mode.');
        if (!input.use_prefilled) {
          await fillInput('#username', input.username);
          await fillInput('#password', input.password);
        }
        const fields = await js(() => {
          const u = document.querySelector('#username');
          const p = document.querySelector('#password');
          return { ready: !!u?.value.trim() && !!p?.value && u.checkValidity() && p.checkValidity(), remember: document.querySelector('form:has(#username) input[name="rememberMe"]')?.checked ?? null };
        });
        if (!fields.ready) return fail('invalid_input', 'Login fields are missing or do not satisfy the site constraints; nothing submitted.');
        if (fields.remember === null) return fail('unknown', 'Remember me control was not found; nothing submitted.');
        if (fields.remember !== (input.remember_me ?? false)) await click('form:has(#username) input[name="rememberMe"]');
        state = await observe();
        if (state.challenge || state.origin !== 'https://www.southwest.com') return outcome(state);
        if (state.errors.some(t => ['locked_or_throttled', 'captcha_or_challenge', 'mfa_failed'].includes(classify(t)))) return outcome(state);
        const armed = await js(() => {
          const form = document.querySelector('#username')?.closest('form');
          const button = form?.querySelector('button[type="submit"]');
          if (!button || button.disabled || button.getAttribute('aria-disabled') === 'true') return false;
          window.__swLoginWatch?.cleanup();
          const selector = '[role="alert"], [id$="Error"], [class*="errorMessage"]';
          const relevant = node => node.nodeType === 1 ? !!node.closest(selector) : !!node.parentElement?.closest(selector);
          const containsFeedback = node => relevant(node) || (node.nodeType === 1 && !!node.querySelector(selector));
          const watch = { changed: false, submitted: false };
          const observer = new MutationObserver(records => {
            if (records.some(r => relevant(r.target) || [...r.addedNodes, ...r.removedNodes].some(containsFeedback))) watch.changed = true;
          });
          const onSubmit = e => { if (e.target === form) watch.submitted = true; };
          watch.cleanup = () => { observer.disconnect(); document.removeEventListener('submit', onSubmit, true); delete window.__swLoginWatch; };
          window.__swLoginWatch = watch;
          observer.observe(document.body, { subtree: true, childList: true, characterData: true });
          document.addEventListener('submit', onSubmit, true);
          return true;
        });
        if (!armed) return fail('unknown', 'Login submit control is missing or disabled; nothing submitted.');
        watchStarted = true;
        submitted = true;
        submissionState = 'unknown';
        await click('form:has(#username) button[type="submit"]');
        for (let i = 0; i < 60; i++) {
          await waitMs(500);
          let current;
          try { current = await observe(); } catch { continue; }
          if (current.submitObserved) submissionState = 'dispatched';
          const result = outcome(current);
          if (result) return result;
        }
        return fail('unknown', 'No conclusive authentication result within 30 seconds. Inspect the browser before any further submission.');
      } catch {
        return fail('unknown', submitted ? 'Browser interaction failed after a submission was attempted. Outcome uncertain; do not automatically retry.' : 'Browser interaction failed before submission. Inspect the page before continuing.');
      } finally {
        if (watchStarted) {
          try { await js(() => window.__swLoginWatch?.cleanup()); } catch { /* Navigation may already have destroyed the observer. */ }
        }
      }
    }
  }
]
