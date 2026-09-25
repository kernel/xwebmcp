import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../domains/ubereats.com/login.js', import.meta.url), 'utf8');
const email = 'qa@example.invalid';
const otherEmail = 'someone-else@example.invalid';
const input = { email };
const searchUrl = 'https://start.duckduckgo.com/';
const homeUrl = 'https://www.ubereats.com/';
const feedUrl = 'https://www.ubereats.com/feed?diningMode=DELIVERY';
const authUrl = 'https://auth.uber.com/v2/?next_url=https%3A%2F%2Fwww.ubereats.com%2Flogin-redirect%2F';
const wrongCode = 'The code you entered is incorrect.';
const plain = value => JSON.parse(JSON.stringify(value));

// Validate the JSON Schema keywords used by this tool without adding a dependency.
function conforms(schema, value) {
  if ('const' in schema && value !== schema.const) return false;
  if (schema.enum && !schema.enum.includes(value)) return false;
  if (schema.type && ![schema.type].flat().some(type => {
    if (type === 'null') return value === null;
    if (type === 'integer') return Number.isInteger(value);
    if (type === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
    return typeof value === type;
  })) return false;
  if (schema.oneOf && schema.oneOf.filter(s => conforms(s, value)).length !== 1) return false;
  if (schema.anyOf && !schema.anyOf.some(s => conforms(s, value))) return false;
  if (schema.not && conforms(schema.not, value)) return false;
  if (schema.required?.some(key => !Object.hasOwn(value, key))) return false;
  if (schema.properties && value !== null && typeof value === 'object') {
    if (Object.entries(schema.properties).some(([key, s]) => key in value && !conforms(s, value[key]))) return false;
    if (schema.additionalProperties === false && Object.keys(value).some(key => !(key in schema.properties))) return false;
  }
  if (typeof value === 'string' && (value.length < (schema.minLength ?? 0) || value.length > (schema.maxLength ?? Infinity))) return false;
  if (typeof value === 'string' && schema.pattern && !new RegExp(schema.pattern).test(value)) return false;
  if (typeof value === 'number' && value < (schema.minimum ?? -Infinity)) return false;
  if (schema.format === 'uri' && !URL.canParse(value)) return false;
  return true;
}

// Page states the tool can encounter, expressed as the DOM signals its read() looks for. Each page
// replaces every step signal so a scene never inherits fields from the page before it.
const page = extra => ({ emailStep: false, emailValue: '', codeChannel: null, codeValue: '', passwordStep: false, passwordValue: '', headings: [], paragraphs: [], options: [], errors: [], loginLink: false, menu: false, accountText: null, challengeText: null, challengeFrame: null, ...extra });
const scenes = {
  feed: (extra = {}) => page({ url: feedUrl, menu: true, cookies: [{ name: 'sid', domain: '.ubereats.com', value: 'x'.repeat(40) }], ...extra }),
  home: (extra = {}) => page({ url: homeUrl, loginLink: true, menu: true, ...extra }),
  emailStep: (extra = {}) => page({ url: authUrl, emailStep: true, headings: ["What's your phone number or email?"], ...extra }),
  emailCode: (forEmail = email, extra = {}) => page({ url: authUrl, codeChannel: 'email', headings: [`Enter the 4-digit code sent to you at ${forEmail}.`], ...extra }),
  smsCode: (extra = {}) => page({ url: authUrl, codeChannel: 'sms', headings: ['Welcome back, QA.'], paragraphs: ['Enter the 4-digit code sent via SMS at ********64.'], ...extra }),
  password: (extra = {}) => page({ url: authUrl, passwordStep: true, headings: ['Welcome back. Sign in to continue.'], ...extra }),
  chooser: (forEmail = email, extra = {}) => page({ url: authUrl, headings: [`Welcome back, ${forEmail}`], options: ['alt-action-help-v2'], ...extra }),
};

function harness(options = {}) {
  let scene = page({ cookies: [], results: [], ...options.scene });
  let clock = 1_700_000_000_000;
  let observer;
  let pending = null;
  let submitted = false;
  let searchPolls = 0;
  let linkReplacements = options.linkReplacedTimes ?? 0;
  const storage = new Map(options.storage ?? []);
  const window = {};
  const calls = { navigations: [], fills: [], submits: 0, clicks: [] };
  const rect = { left: 10, top: 10, right: 200, bottom: 40, width: 190, height: 30 };
  const element = (text = '', extra = {}) => ({
    nodeType: 1, innerText: text, textContent: text, value: '', disabled: false,
    getClientRects: () => [1], getBoundingClientRect: () => rect,
    closest: () => null, querySelector: () => null, getAttribute: () => null,
    setAttribute() {}, removeAttribute() {}, ...extra,
  });
  const feedback = text => element(text, { closest: () => ({}) });
  const codeBoxes = () => [0, 1, 2, 3].map(i => element('', { value: scene.codeValue[i] ?? '' }));
  const document = {
    body: element(scene.bodyText ?? ''),
    title: scene.title ?? '',
    readyState: 'complete',
    querySelector: selector => {
      if (selector === '#PHONE_NUMBER_or_EMAIL_ADDRESS') return scene.emailStep ? element('', { value: scene.emailValue }) : null;
      if (selector === '[data-webmcp-login-link="true"]') return scene.loginLink ? element('Log in', { isConnected: true }) : null;
      if (selector === '#forward-button') return scene.url.startsWith('https://auth.uber.com/') ? element('Next', { disabled: (scene.forwardDisabledFor ?? 0) > 0 }) : null;
      if (selector.startsWith('header button')) return scene.menu ? element() : null;
      return null;
    },
    querySelectorAll: selector => {
      if (selector.startsWith('input[id^="EMAIL_OTP_CODE-"]')) return scene.codeChannel === 'email' ? codeBoxes() : [];
      if (selector.startsWith('input[id^="PHONE_SMS_OTP-"]')) return scene.codeChannel === 'sms' ? codeBoxes() : [];
      if (selector === 'input[type="password"]') return scene.passwordStep ? [element('', { value: scene.passwordValue })] : [];
      if (selector === 'h1,h2,h3,label') return scene.headings.map(t => element(t));
      if (selector === 'h1,h2,h3,label,p') return [...scene.headings, ...scene.paragraphs].map(t => element(t));
      if (selector.startsWith('[role="alert"]')) return scene.errors.map(feedback);
      if (selector === 'iframe') return scene.challengeFrame ? [element('', { title: scene.challengeFrame, getBoundingClientRect: () => ({ ...rect, width: 320, height: 240 }) })] : [];
      if (selector === 'p,div') return scene.challengeText ? [element(scene.challengeText)] : [];
      if (selector.startsWith('header a[href^="https://auth.uber.com/"]')) return scene.loginLink ? [element('Log in')] : [];
      if (selector.startsWith('header a, header button')) return scene.accountText ? [element(scene.accountText)] : [];
      if (selector.startsWith('[data-testid="result"]')) return scene.results.map(href => element('Result', { href }));
      return [];
    },
    getElementById: id => scene.options.includes(id) ? element(id) : null,
  };
  const sessionStorage = {
    getItem: key => storage.has(key) ? storage.get(key) : null,
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: key => storage.delete(key),
  };
  function apply(next) {
    const navigated = next.url && next.url !== scene.url;
    scene = { ...scene, ...next };
    document.title = scene.title ?? '';
    if (navigated) delete window.__ueLoginWatch;
    else if (next.errors) observer?.([{ target: document.body, addedNodes: scene.errors.map(feedback), removedNodes: [] }]);
  }
  const schedule = (result, delay = 1) => { if (result) pending = { result, delay }; };
  const context = {
    URL, JSON, window, document, sessionStorage, innerWidth: 1280, innerHeight: 800,
    get location() { return new URL(scene.url); },
    getComputedStyle: () => ({ visibility: 'visible' }),
    MutationObserver: class {
      constructor(callback) { this.callback = callback; }
      observe() { observer = this.callback; }
      disconnect() { observer = undefined; }
    },
    Date: class extends Date { static now() { return clock; } },
    js: async (fn, opts) => {
      if (options.transientAfterSubmit && submitted && calls.submits === 1) {
        options.transientAfterSubmit = false;
        throw Error('Execution context was destroyed');
      }
      return fn(opts?.arg);
    },
    cdp: async method => {
      assert.equal(method, 'Network.getCookies');
      return { cookies: scene.cookies };
    },
    waitMs: async ms => {
      clock += ms;
      if (scene.forwardDisabledFor) scene.forwardDisabledFor--;
      if (pending && --pending.delay <= 0) { const { result } = pending; pending = null; apply(result); }
    },
    gotoUrl: async url => {
      calls.navigations.push(url);
      apply(page({ url, bodyText: options.searchBodyText ?? '' }));
      document.body.innerText = scene.bodyText;
    },
    accessibilitySnapshot: async () => ({
      url: scene.url,
      nodes: ++searchPolls > (options.searchDelay ?? 0) && !options.noSearchBox
        ? [{ role: 'combobox', name: 'Search with DuckDuckGo', backendNodeId: 1 }, { role: 'button', name: 'Search', backendNodeId: 2 }]
        : [],
    }),
    waitForElement: async () => options.noResults !== true,
    fillInput: async (target, value) => {
      calls.fills.push(typeof target === 'string' ? target : 'search');
      if (target === '#PHONE_NUMBER_or_EMAIL_ADDRESS') scene.emailValue = value;
      else if (target === 'input[type="password"]') scene.passwordValue = value;
      else if (typeof target === 'string' && target.includes('OTP')) scene.codeValue = value;
    },
    click: async target => {
      if (typeof target === 'object') { scene.results = options.results ?? ['https://www.ubereats.com/login-redirect/']; return; }
      calls.clicks.push(target);
      if (target === '[data-webmcp-entry="true"]') return apply(options.landing ?? scenes.home());
      if (target === '[data-webmcp-login-link="true"]') {
        if (linkReplacements-- > 0) throw Error('Element was not actionable within 10s (not visible)');
        return apply(options.loginPage ?? scenes.emailStep());
      }
      if (target === '#alt-action-help-v2') return apply({ options: [...scene.options, ...(options.moreOptions ?? ['alt-more-options-modal-see-all-options'])] });
      if (target === '#alt-more-options-modal-see-all-options') return apply({ options: [...scene.options, ...(options.allOptions ?? ['alt-more-options-modal-email', 'alt-more-options-modal-password'])] });
      if (target === '#alt-more-options-modal-email' || target === '#alt-more-options-modal-password') return schedule(options.chosen ?? scenes.emailCode());
      if (target === '#forward-button') {
        calls.submits++;
        submitted = true;
        if (options.clickError) throw Error('Click outcome unknown');
        return schedule(options.result ?? scenes.emailCode(), options.resultDelay);
      }
    },
  };
  const definitions = runInNewContext(`(${source})`, context);
  return {
    definitions, calls, storage,
    run: async (args = input) => {
      const result = plain(await definitions[0].execute(args));
      assert.ok(conforms(definitions[0].tool.outputSchema, result), JSON.stringify(result));
      assert.ok(calls.submits <= 1, 'must never submit twice');
      return result;
    },
  };
}

const recentMarker = (stage, ageMs, forEmail = email) => [`webmcp.ubereats.login.${stage}`, JSON.stringify({ email: forEmail, at: 1_700_000_000_000 - ageMs })];

test('single-expression CDP tool declares domain patterns and typed schemas', () => {
  const [definition] = harness().definitions;
  assert.equal(definition.kind, 'cdp');
  assert.equal(definition.tool.name, 'login');
  assert.deepEqual(plain(definition.match.url_patterns), ['https://ubereats.com/*', 'https://*.ubereats.com/*', 'https://auth.uber.com/*']);
  assert.equal(definition.tool.annotations.readOnlyHint, false);
  assert.ok(conforms(definition.tool.inputSchema, input));
  assert.ok(conforms(definition.tool.inputSchema, { email, otp: '1234' }));
  assert.ok(conforms(definition.tool.inputSchema, { email, use_prefilled_password: true }));
  assert.equal(conforms(definition.tool.inputSchema, { email, password: 'x', use_prefilled_password: true }), false);
  assert.ok(!source.trimEnd().endsWith(';'));
});

test('registry matches the canonical login definition and namespace', () => {
  const registry = JSON.parse(readFileSync(new URL('../registry.json', import.meta.url), 'utf8'));
  const entry = registry.tools.find(t => t.domain === 'ubereats.com' && t.tool === 'login');
  assert.equal(entry.namespace, 'ubereats.com');
  assert.equal(entry.file, 'domains/ubereats.com/login.js');
  assert.equal(entry.kind, 'cdp');
  assert.deepEqual(entry.url_patterns, plain(harness().definitions[0].match.url_patterns));
});

for (const args of [{}, { email: 'not-an-email' }, { email, password: '' }, { email, password: 'x', use_prefilled_password: true }, { email, use_prefilled_password: 'yes' }, { email, otp: '12' }, { email, otp: 1234 }, { email, extra: true }, [email], null]) {
  test(`invalid input cannot interact: ${JSON.stringify(args)}`, async () => {
    const h = harness({ scene: scenes.emailStep() });
    if (args && typeof args === 'object' && !Array.isArray(args)) assert.equal(conforms(h.definitions[0].tool.inputSchema, args), false);
    const result = await h.run(args);
    assert.equal(result.error_kind, 'invalid_input');
    assert.equal(result.step, 'input');
    assert.equal(result.submission_attempted, false);
    assert.deepEqual(h.calls, { navigations: [], fills: [], submits: 0, clicks: [] });
  });
}

test('an already authenticated session returns success without any page action', async () => {
  const h = harness({ scene: scenes.feed() });
  const result = await h.run();
  assert.equal(result.authenticated, true);
  assert.equal(result.next_step, 'none');
  assert.equal(result.submission_attempted, false);
  assert.deepEqual(h.calls, { navigations: [], fills: [], submits: 0, clicks: [] });
});

test('a session signed in as another account is reported, not resubmitted', async () => {
  const h = harness({ scene: scenes.feed({ accountText: otherEmail }) });
  const result = await h.run();
  assert.equal(result.error_kind, 'unknown');
  assert.match(result.error_message, /different account/);
  assert.deepEqual(h.calls.navigations, []);
});

for (const [label, scene] of [['unrelated page', { url: 'https://example.com/' }], ['store page', { url: 'https://www.ubereats.com/store/some-restaurant/abc', loginLink: true, menu: true }], ['apex host', { url: 'https://ubereats.com/', loginLink: true, menu: true }], ['blank tab', { url: 'about:blank' }]]) {
  test(`routes ${label} through the search engine entry and stops at the email code step`, async () => {
    const h = harness({ scene });
    const result = await h.run();
    assert.deepEqual(h.calls.navigations, [searchUrl]);
    assert.deepEqual(h.calls.clicks, ['[data-webmcp-entry="true"]', '[data-webmcp-login-link="true"]', '#forward-button']);
    assert.deepEqual(h.calls.fills, ['search', '#PHONE_NUMBER_or_EMAIL_ADDRESS']);
    assert.equal(result.logged_in, true);
    assert.equal(result.authenticated, false);
    assert.equal(result.mfa_required, true);
    assert.equal(result.next_step, 'enter_email_code');
    assert.equal(result.account_hint, email);
    assert.equal(result.submission_attempted, true);
    assert.equal(conforms(h.definitions[0].tool.outputSchema, { ...result, authenticated: true }), false);
  });
}

test('a Log in link replaced by hydration is resolved again before the click', async () => {
  const h = harness({ scene: { url: 'https://example.com/' }, linkReplacedTimes: 2 });
  const result = await h.run();
  assert.equal(result.next_step, 'enter_email_code');
  assert.equal(h.calls.clicks.filter(c => c === '[data-webmcp-login-link="true"]').length, 3);
  assert.equal(h.calls.submits, 1);
  const stuck = harness({ scene: { url: 'https://example.com/' }, linkReplacedTimes: 3 });
  const failure = await stuck.run();
  assert.equal(failure.error_kind, 'unknown');
  assert.match(failure.error_message, /Log in link could not be clicked/);
  assert.equal(stuck.calls.submits, 0);
});

test('a proxy error page in place of the sign-in page fails closed', async () => {
  const h = harness({ scene: { url: 'https://example.com/' }, loginPage: page({ url: authUrl, title: 'proxy error', bodyText: 'provider_unreachable' }) });
  const result = await h.run();
  assert.equal(result.error_kind, 'unknown');
  assert.match(result.error_message, /proxy could not reach auth\.uber\.com/);
  assert.equal(result.submission_attempted, false);
  assert.equal(h.calls.submits, 0);
});

test('an email step that is already open is submitted in place', async () => {
  const h = harness({ scene: scenes.emailStep() });
  const result = await h.run();
  assert.equal(result.next_step, 'enter_email_code');
  assert.deepEqual(h.calls.navigations, []);
  assert.deepEqual(h.calls.fills, ['#PHONE_NUMBER_or_EMAIL_ADDRESS']);
  assert.equal(h.calls.submits, 1);
});

test('a Continue control that is still disabled after the step appears is waited for', async () => {
  const h = harness({ scene: scenes.emailStep({ forwardDisabledFor: 3 }) });
  const result = await h.run();
  assert.equal(result.next_step, 'enter_email_code');
  assert.equal(h.calls.submits, 1);
  const never = harness({ scene: scenes.emailStep({ forwardDisabledFor: 1000 }) });
  const failure = await never.run();
  assert.equal(failure.error_kind, 'unknown');
  assert.match(failure.error_message, /Continue control did not become enabled/);
  assert.equal(never.calls.submits, 0);
  const password = harness({ scene: scenes.password({ forwardDisabledFor: 3 }), storage: [recentMarker('email', 60_000)], result: scenes.smsCode() });
  assert.equal((await password.run({ email, password: 'not-real-pass' })).next_step, 'enter_sms_code');
  assert.equal(password.calls.submits, 1);
});

test('the email step submission is recorded so a re-invocation does not request a second code', async () => {
  const h = harness({ scene: { url: 'https://example.com/' } });
  await h.run();
  assert.equal(JSON.parse(h.storage.get('webmcp.ubereats.login.email')).email, email);
  const again = harness({ scene: { url: 'https://example.com/' }, storage: [recentMarker('email', 60_000)] });
  const result = await again.run();
  assert.equal(result.error_kind, 'unknown');
  assert.match(result.error_message, /already requested/);
  assert.equal(again.calls.submits, 0);
});

test('an already open email code step for the same email is reported without a new request', async () => {
  const h = harness({ scene: scenes.emailCode() });
  const result = await h.run();
  assert.equal(result.next_step, 'enter_email_code');
  assert.equal(result.submission_attempted, false);
  assert.deepEqual(h.calls, { navigations: [], fills: [], submits: 0, clicks: [] });
});

for (const [label, options, kind, pattern] of [
  ['first organic result is off-domain', { results: ['https://example.com/uber-eats-login'] }, 'unknown', /not ubereats\.com/],
  ['search engine shows a challenge', { searchBodyText: 'Unusual traffic from your network. Please verify you are human.' }, 'captcha_or_challenge', /before any Uber request/],
  ['search box never renders', { noSearchBox: true }, 'unknown', /search box/],
  ['no organic results', { noResults: true }, 'unknown', /no organic results/],
  ['site landing shows a challenge', { landing: scenes.home({ challengeText: 'Verify you are human to continue' }) }, 'captcha_or_challenge', /human/],
  ['login page shows a challenge frame', { loginPage: scenes.emailStep({ challengeFrame: 'Arkose challenge' }) }, 'captcha_or_challenge', /Arkose/],
  ['login page shows a lockout before entry', { loginPage: scenes.emailStep({ errors: ['Too many attempts. Try again later.'] }) }, 'locked_or_throttled', /Too many/],
]) {
  test(`entry stops without a submission when the ${label}`, async () => {
    const h = harness({ scene: { url: 'https://example.com/' }, ...options });
    const result = await h.run();
    assert.equal(result.error_kind, kind);
    assert.match(result.error_message, pattern);
    assert.equal(result.submission_attempted, false);
    assert.equal(h.calls.submits, 0);
    assert.ok(!h.calls.fills.includes('#PHONE_NUMBER_or_EMAIL_ADDRESS'));
  });
}

for (const [text, kind, remaining] of [
  ["That email address doesn't match any account.", 'invalid_credentials', null],
  ['Too many requests. 2 attempts remaining.', 'locked_or_throttled', 2],
  ['Please complete the CAPTCHA to continue.', 'captcha_or_challenge', null],
  ['Service unavailable. Please refresh the page.', 'unknown', null],
]) {
  test(`post-submit feedback is classified without retry: ${kind}`, async () => {
    const h = harness({ scene: scenes.emailStep(), result: { errors: [text] } });
    const result = await h.run();
    assert.equal(result.error_kind, kind);
    assert.equal(result.error_message, text);
    assert.equal(result.attempts_remaining, remaining);
    assert.equal(result.submission_attempted, true);
    assert.equal(h.calls.submits, 1);
  });
}

test('feedback left from an earlier attempt is not this attempt\'s verdict', async () => {
  const h = harness({ scene: scenes.emailStep({ errors: ['Service unavailable. Please refresh the page.'] }), result: { emailStep: true }, resultDelay: 100 });
  const result = await h.run();
  assert.equal(result.error_kind, 'unknown');
  assert.match(result.error_message, /no recognizable result within 45 seconds/);
  assert.equal(h.calls.submits, 1);
});

test('an uncertain click is never retried and its cause is reported', async () => {
  const h = harness({ scene: scenes.emailStep(), clickError: true });
  const result = await h.run();
  assert.equal(result.error_kind, 'unknown');
  assert.match(result.error_message, /outcome is unknown.*Cause: Click outcome unknown/);
  assert.equal(result.submission_attempted, true);
  assert.equal(h.calls.submits, 1);
});

test('a transient context loss after submission only retries observation', async () => {
  const h = harness({ scene: scenes.emailStep(), transientAfterSubmit: true, resultDelay: 2 });
  const result = await h.run();
  assert.equal(result.next_step, 'enter_email_code');
  assert.equal(h.calls.submits, 1);
});

test('the email step leading to a password step returns enter_password without a password', async () => {
  const h = harness({ scene: scenes.emailStep(), result: scenes.password() });
  const result = await h.run();
  assert.equal(result.next_step, 'enter_password');
  assert.equal(result.mfa_required, false);
  assert.equal(h.calls.submits, 1);
  assert.equal(JSON.parse(h.storage.get('webmcp.ubereats.login.email')).email, email);
});

test('the password step is resumed for the account this tab identified and leads to the SMS code step', async () => {
  const h = harness({ scene: scenes.password(), storage: [recentMarker('email', 60_000)], result: scenes.smsCode() });
  const result = await h.run({ email, password: 'not-real-pass' });
  assert.deepEqual(h.calls.fills, ['input[type="password"]']);
  assert.equal(h.calls.submits, 1);
  assert.equal(result.next_step, 'enter_sms_code');
  assert.equal(result.mfa_required, true);
  assert.equal(result.account_hint, '********64');
  assert.ok(h.storage.has('webmcp.ubereats.login.password'));
});

test('a password step this tab did not reach for the email is left alone and entry starts over', async () => {
  const h = harness({ scene: scenes.password() });
  const result = await h.run({ email, password: 'not-real-pass' });
  assert.ok(!h.calls.fills.includes('input[type="password"]'));
  assert.deepEqual(h.calls.navigations, [searchUrl]);
  assert.equal(result.next_step, 'enter_email_code');
});

test('a password step for another email is never submitted', async () => {
  const h = harness({ scene: scenes.password({ headings: [`Welcome back, ${otherEmail}`] }), storage: [recentMarker('email', 60_000)] });
  const result = await h.run({ email, password: 'not-real-pass' });
  assert.equal(result.error_kind, 'unknown');
  assert.equal(h.calls.submits, 0);
  assert.ok(!h.calls.fills.includes('input[type="password"]'));
});

test('an incorrect password is reported as invalid credentials', async () => {
  const h = harness({ scene: scenes.password(), storage: [recentMarker('email', 60_000)], result: { errors: ['The password you entered is incorrect.'] } });
  const result = await h.run({ email, password: 'not-real-pass' });
  assert.equal(result.error_kind, 'invalid_credentials');
  assert.equal(result.step, 'password');
  assert.equal(h.calls.submits, 1);
});

test('prefilled password mode never submits an empty field and never fills', async () => {
  const h = harness({ scene: scenes.password(), storage: [recentMarker('email', 60_000)], result: scenes.smsCode() });
  const empty = await h.run({ email, use_prefilled_password: true });
  assert.equal(empty.next_step, 'enter_password');
  assert.equal(h.calls.submits, 0);
  const filled = harness({ scene: scenes.password({ passwordValue: 'filled-by-vault' }), storage: [recentMarker('email', 60_000)], result: scenes.smsCode() });
  const result = await filled.run({ email, use_prefilled_password: true });
  assert.equal(result.next_step, 'enter_sms_code');
  assert.deepEqual(filled.calls.fills, []);
  assert.equal(filled.calls.submits, 1);
});

test('a password submitted from this tab a moment ago is not submitted again', async () => {
  const h = harness({ scene: scenes.password({ passwordValue: 'filled-by-vault' }), storage: [recentMarker('email', 60_000), recentMarker('password', 10_000)] });
  const result = await h.run({ email, use_prefilled_password: true });
  assert.equal(result.error_kind, 'unknown');
  assert.match(result.error_message, /less than a minute ago/);
  assert.equal(h.calls.submits, 0);
});

test('the sign-in method chooser selects the email code unless a password is supplied', async () => {
  const h = harness({ scene: scenes.emailStep(), result: scenes.chooser() });
  const result = await h.run();
  assert.equal(result.next_step, 'enter_email_code');
  assert.deepEqual(h.calls.clicks, ['#forward-button', '#alt-action-help-v2', '#alt-more-options-modal-see-all-options', '#alt-more-options-modal-email']);
  const withPassword = harness({ scene: scenes.chooser(), chosen: scenes.password(), result: scenes.smsCode() });
  const next = await withPassword.run({ email, password: 'not-real-pass' });
  assert.equal(next.next_step, 'enter_sms_code');
  assert.ok(withPassword.calls.clicks.includes('#alt-more-options-modal-password'));
  assert.equal(withPassword.calls.submits, 1);
});

test('a chooser for another account is never operated; entry starts over for the requested email', async () => {
  const h = harness({ scene: scenes.chooser(otherEmail) });
  const result = await h.run();
  assert.equal(result.next_step, 'enter_email_code');
  assert.deepEqual(h.calls.navigations, [searchUrl]);
  assert.ok(!h.calls.clicks.some(c => c.startsWith('#alt-')));
});

for (const [label, scene, storage] of [['the feed', scenes.feed(), []], ['an unrelated page', { url: 'https://example.com/' }, []], ['the email step', scenes.emailStep(), []], ['a code step for another email', scenes.emailCode(otherEmail), []], ['an SMS step this tab did not reach', scenes.smsCode(), []]]) {
  test(`otp without a matching code step is rejected before any page action: ${label}`, async () => {
    const h = harness({ scene, storage });
    const result = await h.run({ email, otp: '1234' });
    assert.equal(result.error_kind, 'invalid_input');
    assert.equal(result.step, 'code');
    assert.equal(result.submission_attempted, false);
    assert.deepEqual(h.calls, { navigations: [], fills: [], submits: 0, clicks: [] });
  });
}

test('the email code is pasted into the first box and a wrong code fails without retry', async () => {
  const h = harness({ scene: scenes.emailCode(), result: { errors: [wrongCode] } });
  const result = await h.run({ email, otp: '1234' });
  assert.deepEqual(h.calls.fills, ['input[id="EMAIL_OTP_CODE-0"]']);
  assert.equal(result.error_kind, 'mfa_failed');
  assert.equal(result.error_message, wrongCode);
  assert.equal(result.submission_attempted, true);
  assert.ok(h.calls.submits <= 1);
});

test('a correct email code completes authentication', async () => {
  const h = harness({ scene: scenes.emailCode(), result: scenes.feed() });
  const result = await h.run({ email, otp: '1234' });
  assert.equal(result.authenticated, true);
  assert.equal(result.next_step, 'none');
  assert.equal(result.submission_attempted, true);
});

test('the SMS code step reached through this tab accepts the code and completes authentication', async () => {
  const h = harness({ scene: scenes.smsCode(), storage: [recentMarker('password', 30_000)], result: scenes.feed() });
  const reported = await h.run();
  assert.equal(reported.next_step, 'enter_sms_code');
  assert.equal(reported.submission_attempted, false);
  const result = await h.run({ email, otp: '1234' });
  assert.deepEqual(h.calls.fills, ['input[id="PHONE_SMS_OTP-0"]']);
  assert.equal(result.authenticated, true);
  assert.equal(h.calls.navigations.length, 0);
});

test('a code submitted seconds ago is not submitted again', async () => {
  const h = harness({ scene: scenes.emailCode(), storage: [recentMarker('code', 5_000)] });
  const result = await h.run({ email, otp: '1234' });
  assert.equal(result.error_kind, 'unknown');
  assert.match(result.error_message, /less than 20 seconds ago/);
  assert.deepEqual(h.calls.fills, []);
});

test('an off-site landing after the code fails closed', async () => {
  const h = harness({ scene: scenes.emailCode(), result: page({ url: 'https://example.com/', menu: true }) });
  const result = await h.run({ email, otp: '1234' });
  assert.equal(result.error_kind, 'unknown');
  assert.match(result.error_message, /no recognizable result/);
  assert.equal(result.step, 'code');
});
