import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

const tools = ['register', 'complete_registration', 'resume_registration'];
const sources = Object.fromEntries(tools.map(name => [name, readFileSync(new URL(`../domains/ubereats.com/${name}.js`, import.meta.url), 'utf8')]));
const registry = JSON.parse(readFileSync(new URL('../registry.json', import.meta.url), 'utf8'));
const plain = value => JSON.parse(JSON.stringify(value));
const sha = value => createHash('sha256').update(value).digest('hex');

// Fabricated identities only.
const email = 'qa-new@example.invalid';
const other = 'someone-else@example.invalid';
const phone = '+15550100199';
const profile = { phone, first_name: 'Qa', last_name: 'Tester', accept_terms: true };
const homeUrl = 'https://www.ubereats.com/';
const feedUrl = 'https://www.ubereats.com/feed?diningMode=DELIVERY';
const authUrl = 'https://auth.uber.com/v2/?next_url=https%3A%2F%2Fwww.ubereats.com%2Flogin-redirect%2F';

function conforms(schema, value) {
  if ('const' in schema && value !== schema.const) return false;
  if (schema.enum && !schema.enum.includes(value)) return false;
  if (schema.type && ![schema.type].flat().some(type => {
    if (type === 'null') return value === null;
    if (type === 'integer') return Number.isInteger(value);
    if (type === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
    if (type === 'array') return Array.isArray(value);
    return typeof value === type;
  })) return false;
  if (schema.oneOf && schema.oneOf.filter(s => conforms(s, value)).length !== 1) return false;
  if (schema.required?.some(key => !Object.hasOwn(value, key))) return false;
  if (schema.properties && value !== null && typeof value === 'object' && !Array.isArray(value)) {
    if (Object.entries(schema.properties).some(([key, s]) => key in value && !conforms(s, value[key]))) return false;
    if (schema.additionalProperties === false && Object.keys(value).some(key => !(key in schema.properties))) return false;
  }
  if (Array.isArray(value)) {
    if (schema.items && !value.every(item => conforms(schema.items, item))) return false;
    if (schema.minItems !== undefined && value.length < schema.minItems) return false;
  }
  if (typeof value === 'string') {
    if (value.length < (schema.minLength ?? 0) || value.length > (schema.maxLength ?? Infinity)) return false;
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) return false;
  }
  if (typeof value === 'number' && (value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity))) return false;
  return true;
}

// Uber screens as the element ids its sign-up client renders.
const screen = extra => ({ url: authUrl, identifier: false, identifierValue: '', emailCode: 0, smsCode: 0, codeValue: '', phone: false, dial: '+1', phoneValue: '', first: false, firstValue: '', last: false, lastValue: '', terms: false, termsChecked: false, extraBoxes: [], password: false, moreOptions: false, headings: [], errors: [], forwardDisabled: false, challengeFrame: null, title: 'Sign up or Log in with Uber', bodyText: '', ...extra });
const scenes = {
  home: (account = 'signed_out') => screen({ url: homeUrl, title: 'Uber Eats', site: true, account, headerLinks: ['Sign up', 'Log in'] }),
  feed: (account) => screen({ url: feedUrl, title: 'Uber Eats', site: true, account, headerLinks: [] }),
  identifier: () => screen({ identifier: true, headings: ["What's your phone number or email?"] }),
  emailCode: (to = email) => screen({ emailCode: 4, headings: [`Enter the 4-digit code sent to you at: ${to}`] }),
  smsCode: () => screen({ smsCode: 4, headings: ['Enter the 4-digit code sent via SMS at ********99.'] }),
  phone: (dial = '+1') => screen({ phone: true, dial, headings: ["What's your phone number?"] }),
  name: () => screen({ first: true, last: true, headings: ["What's your name?"] }),
  terms: (extraBoxes = []) => screen({ terms: true, extraBoxes, headings: ["Accept Uber's Terms & Review Privacy Notice"] }),
  nameTerms: () => screen({ first: true, last: true, terms: true, headings: ['Almost done'] }),
  chooser: (to = email) => screen({ moreOptions: true, headings: [`Welcome back, ${to}`] }),
  password: () => screen({ password: true, headings: ['Welcome back. Sign in to continue.'] }),
  unknown: () => screen({ headings: ['Would you like marketing emails?'] }),
  challenge: () => screen({ challengeFrame: 'Arkose challenge' }),
  proxyError: () => screen({ title: 'proxy error', bodyText: 'provider_unreachable' }),
  other: () => screen({ url: 'https://example.com/', title: 'Example' }),
};

function harness(name, options = {}) {
  let scene = options.scene ?? scenes.home();
  const after = [...(options.after ?? [])];
  const storage = new Map((options.storage ?? []).map(([origin, key, value]) => [`${origin}|${key}`, JSON.stringify(value)]));
  const calls = { navigations: [], fills: [], submits: 0, clicks: [], fetches: 0 };
  const boxClicks = [];
  const window = {};
  let observer;
  let clock = options.now ?? 1_700_000_000_000;
  const origin = () => new URL(scene.url).origin;
  const rect = { left: 10, top: 10, right: 200, bottom: 40, width: 190, height: 30 };
  const el = (text = '', extra = {}) => {
    const node = {
      nodeType: 1, innerText: text, textContent: text, value: '', disabled: false, isConnected: true, attrs: {},
      getClientRects: () => [1], getBoundingClientRect: () => rect,
      closest: () => null, querySelector: () => null, querySelectorAll: () => [], matches: () => false, contains: other => other === node,
      getAttribute: key => node.attrs[key] ?? null, setAttribute: (key, value) => { node.attrs[key] = value; }, removeAttribute: key => { delete node.attrs[key]; },
      click() {}, ...extra,
    };
    return node;
  };
  const feedback = text => el(text, { closest: () => ({}) });
  const boxes = count => Array.from({ length: count }, (_, i) => el('', { value: scene.codeValue[i] ?? '' }));
  let headerLink = null;
  const document = {
    get title() { return scene.title; },
    get readyState() { return 'complete'; },
    get body() { return el(scene.bodyText); },
    getElementById: id => {
      if (id === 'PHONE_NUMBER_or_EMAIL_ADDRESS') return scene.identifier ? el('', { value: scene.identifierValue }) : null;
      if (id === 'PHONE_NUMBER') {
        if (!scene.phone) return null;
        const input = el('', { value: scene.phoneValue });
        const dial = el(scene.dial);
        input.parentElement = el('', { querySelectorAll: () => [dial, input], contains: n => n === input });
        return input;
      }
      if (id === 'FIRST_NAME') return scene.first ? el('', { value: scene.firstValue }) : null;
      if (id === 'LAST_NAME') return scene.last ? el('', { value: scene.lastValue }) : null;
      if (id === 'LEGAL_ACCEPT_TERMS') {
        if (!scene.terms) return null;
        const box = el('', { checked: scene.termsChecked, click: () => { scene.termsChecked = !scene.termsChecked; } });
        box.closest = () => null;
        return el('I agree', { matches: () => false, querySelector: () => box });
      }
      if (id === 'accept-terms-text') return scene.terms ? el("By checking the box, I agree to Uber's Terms of Use and acknowledge the Privacy Notice.") : null;
      if (id === 'alt-action-help-v2') return scene.moreOptions ? el('More options') : null;
      return null;
    },
    querySelector: selector => {
      if (selector === '#forward-button') return scene.site ? null : el('Next', { disabled: scene.forwardDisabled });
      if (selector === '[data-webmcp-signup="true"]') return headerLink && headerLink.attrs['data-webmcp-signup'] ? headerLink : null;
      if (selector === 'input[autocomplete="given-name"]' || selector === 'input[autocomplete="family-name"]') return null;
      return null;
    },
    querySelectorAll: selector => {
      if (selector === 'h1,h2,h3,label,p') return scene.headings.map(t => el(t));
      if (selector.startsWith('input[id^="EMAIL_OTP_CODE-"]')) return boxes(scene.emailCode);
      if (selector.startsWith('input[id^="PHONE_SMS_OTP-"]')) return boxes(scene.smsCode);
      if (selector === 'input[type="checkbox"]') return scene.extraBoxes.map(t => { const label = el(t, { click: () => boxClicks.push(t) }); return el('', { closest: () => label, click: () => boxClicks.push(t) }); });
      if (selector === 'input[type="password"]') return scene.password ? [el()] : [];
      if (selector.startsWith('[role="alert"]')) return scene.errors.map(feedback);
      if (selector === 'iframe') return scene.challengeFrame ? [el('', { title: scene.challengeFrame, getBoundingClientRect: () => ({ ...rect, width: 320, height: 240 }) })] : [];
      if (selector.startsWith('header a[href^="https://auth.uber.com/"]')) {
        headerLink = (scene.headerLinks ?? [])[0] ? el(scene.headerLinks[0]) : null;
        return (scene.headerLinks ?? []).map((t, i) => i === 0 ? headerLink : el(t));
      }
      return [];
    },
  };
  const sessionStorage = {
    getItem: key => storage.get(`${origin()}|${key}`) ?? null,
    setItem: (key, value) => storage.set(`${origin()}|${key}`, String(value)),
  };
  function go(next) {
    const navigated = next.url !== scene.url || !!next.site !== !!scene.site;
    scene = next;
    if (navigated) delete window.__ueRegWatch;
    else if (next.errors?.length) observer?.([{ target: {}, addedNodes: next.errors.map(feedback), removedNodes: [] }]);
  }
  const submit = () => {
    calls.submits++;
    const next = after.shift();
    if (!next) return;
    if (next.stay) go({ ...scene, errors: next.errors, codeValue: '' });
    else go(typeof next === 'function' ? next() : next);
  };
  const context = {
    URL, JSON, TextEncoder, Uint8Array, window, document, sessionStorage,
    crypto: { subtle: webcrypto.subtle },
    get location() { return new URL(scene.url); },
    getComputedStyle: () => ({ visibility: 'visible' }),
    MutationObserver: class { constructor(cb) { this.cb = cb; } observe() { observer = this.cb; } disconnect() { observer = undefined; } },
    Date: class extends Date { static now() { return clock; } },
    fetch: async path => {
      calls.fetches++;
      assert.match(path, /getUserV1/);
      const account = scene.account ?? 'signed_out';
      const body = account === 'signed_out' ? { status: 'failure', data: { code: 403, meta: { code: 'rtapi.forbidden' } } } : { status: 'success', data: { isLoggedIn: true, hashedEmail: sha(account) } };
      // Uber answers HTTP 200 with a failure body when signed out.
      return { status: 200, json: async () => body };
    },
    js: async (fn, opts) => fn(opts?.arg),
    waitMs: async ms => { clock += ms; },
    gotoUrl: async url => { calls.navigations.push(url); go(options.home ? options.home() : scenes.home()); },
    fillInput: async (selector, value) => {
      calls.fills.push(selector);
      if (selector === '#PHONE_NUMBER_or_EMAIL_ADDRESS') scene.identifierValue = value;
      else if (selector === '#PHONE_NUMBER') scene.phoneValue = value;
      else if (selector.includes('webmcp-first')) scene.firstValue = value;
      else if (selector.includes('webmcp-last')) scene.lastValue = value;
      else if (selector.includes('OTP')) scene.codeValue = value;
    },
    click: async selector => {
      calls.clicks.push(selector);
      if (selector === '[data-webmcp-signup="true"]') return go(options.signupPage ? options.signupPage() : scenes.identifier());
      if (selector === '#forward-button') return submit();
    },
  };
  const [definition] = runInNewContext(`(${sources[name]})`, context);
  return {
    definition, calls, storage, boxClicks,
    marker: () => JSON.parse(storage.get(`https://auth.uber.com|webmcp.ubereats.register`) ?? 'null'),
    run: async input => {
      const result = plain(await definition.execute(input));
      assert.ok(conforms(definition.tool.outputSchema, result), `${name} output violates its schema: ${JSON.stringify(result)}`);
      const text = JSON.stringify(result);
      assert.ok(!text.includes(phone) && !text.includes(phone.slice(2)), 'output must never contain the phone number');
      if (input?.code) assert.ok(!text.includes(input.code), 'output must never contain the code');
      return result;
    },
  };
}

const auth = 'https://auth.uber.com';
const site = 'https://www.ubereats.com';
const startedMarker = (extra = {}) => [auth, 'webmcp.ubereats.register', { h: sha(email), started: 1_700_000_000_000 - 60_000, email_at: 1_700_000_000_000 - 60_000, ...extra }];

for (const name of tools) {
  test(`${name}: single-expression CDP tool that matches the registry and declares typed schemas`, () => {
    const { definition } = harness(name);
    assert.equal(definition.kind, 'cdp');
    assert.equal(definition.tool.name, name);
    assert.deepEqual(plain(definition.match.url_patterns), ['https://ubereats.com/*', 'https://*.ubereats.com/*', 'https://auth.uber.com/*']);
    assert.equal(definition.tool.inputSchema.type, 'object');
    assert.ok(definition.tool.outputSchema.oneOf.length === 4);
    assert.ok(!sources[name].trimEnd().endsWith(';'));
    assert.ok(!/\b(Buffer|require|process)\b/.test(sources[name]), 'must not use Node-only globals');
    assert.ok(!/checkout|payment|promo/i.test(sources[name].match(/gotoUrl\([^)]*\)/g)?.join('') ?? ''), 'must never navigate to checkout, payment, or promotions');
    const entry = registry.tools.find(t => t.domain === 'ubereats.com' && t.tool === name);
    assert.equal(entry.file, `domains/ubereats.com/${name}.js`);
    assert.equal(entry.status, 'draft');
    assert.deepEqual(entry.url_patterns, plain(definition.match.url_patterns));
  });
}

const invalid = {
  register: [{}, { email: 'not-an-email' }, { email, phone }, { email, code: '1234' }, null, [email]],
  complete_registration: [{ email }, { email, code: '12' }, { email, code: 1234 }, { email, code: '1234', phone: '5550100199' }, { email, code: '1234', accept_terms: false }, { email, code: '1234', first_name: '' }, { email, code: '1234', extra: 1 }, null],
  resume_registration: [{}, { email, code: '1234' }, { email, phone: '+0123' }, { email, accept_terms: 'yes' }, { email, last_name: 'x'.repeat(51) }, null],
};
for (const [name, inputs] of Object.entries(invalid)) {
  for (const input of inputs) {
    test(`${name}: invalid input is rejected before any page action: ${JSON.stringify(input)}`, async () => {
      const h = harness(name, { scene: scenes.identifier() });
      if (input && typeof input === 'object' && !Array.isArray(input)) assert.equal(conforms(h.definition.tool.inputSchema, input), false);
      const result = await h.run(input);
      assert.equal(result.error_kind, 'invalid_input');
      assert.equal(result.submission_attempted, false);
      assert.deepEqual(h.calls, { navigations: [], fills: [], submits: 0, clicks: [], fetches: 0 });
    });
  }
}

test('register: from an unrelated page it opens the site, follows Sign up, submits the email once, and returns the email challenge', async () => {
  const h = harness('register', { scene: scenes.other(), after: [scenes.emailCode] });
  const result = await h.run({ email: ' QA-New@Example.invalid ' });
  assert.deepEqual(h.calls.navigations, [homeUrl]);
  assert.deepEqual(h.calls.clicks, ['[data-webmcp-signup="true"]', '#forward-button']);
  assert.deepEqual(h.calls.fills, ['#PHONE_NUMBER_or_EMAIL_ADDRESS']);
  assert.deepEqual([result.status, result.step, result.next_tool], ['challenge', 'email_code', 'complete_registration']);
  assert.deepEqual(result.challenge, { channel: 'email', destination_hint: 'q***@example.invalid', code_length: 4 });
  assert.deepEqual([result.steps_submitted, result.submission_attempted], [['email'], true]);
  assert.equal(h.marker().h, sha(email));
});

test('register: a signed-in session is refused without submitting, whichever account it is', async () => {
  const signedOther = harness('register', { scene: scenes.home(other) });
  const refused = await signedOther.run({ email });
  assert.deepEqual([refused.error_kind, refused.submission_attempted], ['signed_in', false]);
  assert.equal(signedOther.calls.submits, 0);
  const signedSame = harness('register', { scene: scenes.home(email) });
  assert.equal((await signedSame.run({ email })).error_kind, 'existing_account');
  assert.deepEqual(signedSame.calls.clicks, []);
});

for (const [label, after] of [['the sign-in chooser', scenes.chooser], ['a password step', scenes.password], ['a text-message code', scenes.smsCode]]) {
  test(`register: an existing account (${label} after the email) stops without further steps`, async () => {
    const h = harness('register', { after: [after] });
    const result = await h.run({ email });
    assert.equal(result.error_kind, 'existing_account');
    assert.equal(h.calls.submits, 1);
    assert.deepEqual(result.steps_submitted, ['email']);
  });
}

test('register: a rejected email and a challenge are reported, not retried', async () => {
  const rejected = harness('register', { after: [{ stay: true, errors: ['Enter a valid email address.'] }] });
  assert.equal((await rejected.run({ email })).error_kind, 'email_rejected');
  const challenged = harness('register', { after: [scenes.challenge] });
  assert.equal((await challenged.run({ email })).error_kind, 'captcha_or_challenge');
  assert.equal(challenged.calls.submits, 1);
});

test('register: a challenge or proxy error before the email step submits nothing', async () => {
  const proxied = harness('register', { signupPage: scenes.proxyError });
  const result = await proxied.run({ email });
  assert.deepEqual([result.error_kind, result.submission_attempted], ['unknown', false]);
  assert.match(result.error_message, /proxy/);
  const challenged = harness('register', { scene: scenes.other(), home: scenes.challenge });
  assert.equal((await challenged.run({ email })).error_kind, 'captcha_or_challenge');
});

test('register: calling again while the code step is open returns it without a second request', async () => {
  const h = harness('register', { scene: scenes.emailCode(), storage: [startedMarker()] });
  const result = await h.run({ email });
  assert.deepEqual([result.status, result.submission_attempted], ['challenge', false]);
  assert.deepEqual(h.calls, { navigations: [], fills: [], submits: 0, clicks: [], fetches: 0 });
});

test('register: a code requested from this tab minutes ago is not requested again', async () => {
  const h = harness('register', { scene: scenes.other(), storage: [startedMarker()] });
  const result = await h.run({ email });
  assert.equal(result.error_kind, 'duplicate_submission');
  assert.equal(h.calls.submits, 0);
});

test('register: a sign-up for another email in this tab is not touched', async () => {
  const h = harness('register', { scene: scenes.name(), storage: [[auth, 'webmcp.ubereats.register', { h: sha(other), started: 1_700_000_000_000, email_at: 1_700_000_000_000 }]] });
  assert.equal((await h.run({ email })).error_kind, 'other_registration_in_progress');
  assert.equal(h.calls.submits, 0);
});

test('complete_registration: walks phone, SMS code, name, and terms, then verifies the new account by hashed email', async () => {
  const first = harness('complete_registration', { scene: scenes.emailCode(), storage: [startedMarker()], after: [scenes.phone, scenes.smsCode] });
  const challenge = await first.run({ email, code: '4821', ...profile });
  assert.deepEqual([challenge.status, challenge.step, challenge.challenge.channel, challenge.challenge.destination_hint], ['challenge', 'sms_code', 'sms', '********99']);
  assert.deepEqual(challenge.steps_submitted, ['email_code', 'phone']);
  assert.ok(first.calls.fills.includes('#PHONE_NUMBER'));
  const marker = first.marker();
  assert.equal(marker.phone_last2, '99');
  assert.ok(!JSON.stringify(marker).includes(phone.slice(2)), 'the marker keeps no phone number');
  assert.ok(!JSON.stringify(marker).includes('4821'), 'the marker keeps no code');

  const second = harness('complete_registration', { now: 1_700_000_000_000 + 120_000, scene: scenes.smsCode(), storage: [[auth, 'webmcp.ubereats.register', marker]], after: [scenes.name, scenes.terms, () => scenes.feed(email)] });
  const done = await second.run({ email, code: '7302', ...profile });
  assert.deepEqual([done.status, done.account_verified, done.landing_url], ['registered', true, feedUrl]);
  assert.deepEqual(done.steps_submitted, ['sms_code', 'profile', 'profile']);
});

test('complete_registration: a terms screen with a marketing box is submitted once with only the terms box checked', async () => {
  const h = harness('complete_registration', { scene: scenes.emailCode(), storage: [startedMarker()], after: [() => scenes.terms(['Send me offers and news']), () => scenes.feed(email)] });
  const result = await h.run({ email, code: '4821', accept_terms: true });
  assert.equal(result.status, 'registered');
  assert.deepEqual(result.steps_submitted, ['email_code', 'profile']);
  assert.deepEqual(h.calls.clicks, ['#forward-button', '#forward-button']);
  assert.deepEqual(h.boxClicks, []);
});

test('complete_registration: a combined name and terms screen is submitted once', async () => {
  const h = harness('complete_registration', { scene: scenes.emailCode(), storage: [startedMarker()], after: [scenes.nameTerms, () => scenes.feed(email)] });
  const result = await h.run({ email, code: '4821', first_name: 'Qa', last_name: 'Tester', accept_terms: true });
  assert.equal(result.status, 'registered');
  assert.deepEqual(result.steps_submitted, ['email_code', 'profile']);
  assert.ok(h.calls.fills.includes('[data-webmcp-first="true"]') && h.calls.fills.includes('[data-webmcp-last="true"]'));
});

test('complete_registration: the terms are never accepted without accept_terms: true', async () => {
  const h = harness('complete_registration', { scene: scenes.emailCode(), storage: [startedMarker()], after: [scenes.nameTerms] });
  const result = await h.run({ email, code: '4821', first_name: 'Qa', last_name: 'Tester' });
  assert.deepEqual([result.status, result.needs, result.next_tool], ['needs_input', ['accept_terms'], 'resume_registration']);
  assert.match(result.terms_text, /Terms of Use/);
  assert.equal(h.calls.submits, 1);
});

test('complete_registration: a missing phone stops at the phone screen with needs_input', async () => {
  const h = harness('complete_registration', { scene: scenes.emailCode(), storage: [startedMarker()], after: [scenes.phone] });
  const result = await h.run({ email, code: '4821' });
  assert.deepEqual([result.status, result.step, result.needs], ['needs_input', 'phone', ['phone']]);
});

test('complete_registration: a phone whose country code differs from the preselected one is not submitted', async () => {
  const h = harness('complete_registration', { scene: scenes.emailCode(), storage: [startedMarker()], after: [() => scenes.phone('+44')] });
  const result = await h.run({ email, code: '4821', ...profile });
  assert.equal(result.error_kind, 'invalid_input');
  assert.match(result.error_message, /\+44/);
  assert.equal(h.calls.submits, 1);
  assert.ok(!h.calls.fills.includes('#PHONE_NUMBER'));
});

for (const [label, after, kind] of [
  ['the site says the number is in use', { stay: true, errors: ['This phone number is already associated with another account.'] }, 'phone_conflict'],
  ['the site offers to sign in to the account that owns the number', scenes.chooser, 'phone_conflict'],
  ['the site refuses the number', { stay: true, errors: ['This phone number is not supported.'] }, 'phone_rejected'],
]) {
  test(`complete_registration: ${label} stops without changes`, async () => {
    const h = harness('resume_registration', { scene: scenes.phone(), storage: [startedMarker({ email_code_at: 1_700_000_000_000 - 30_000 })], after: [after] });
    const result = await h.run({ email, ...profile });
    assert.equal(result.error_kind, kind);
    assert.deepEqual([h.calls.submits, result.steps_submitted], [1, ['phone']]);
  });
}

for (const [label, message, kind] of [['wrong', 'The email passcode you\u2019ve entered is incorrect.', 'code_rejected'], ['expired', 'This code has expired. Request a new one.', 'code_expired']]) {
  test(`complete_registration: a ${label} code is reported and never retried`, async () => {
    const h = harness('complete_registration', { scene: scenes.emailCode(), storage: [startedMarker()], after: [{ stay: true, errors: [message] }] });
    const result = await h.run({ email, code: '0000', ...profile });
    assert.equal(result.error_kind, kind);
    assert.equal(h.calls.submits, 1);
    const again = harness('complete_registration', { scene: { ...scenes.emailCode(), errors: [] }, storage: [[auth, 'webmcp.ubereats.register', { ...h.marker(), code_at: 1_700_000_000_000 - 60_000 }]] });
    const repeat = await again.run({ email, code: '0000', ...profile });
    assert.equal(repeat.error_kind, 'duplicate_submission');
    assert.equal(again.calls.submits, 0);
  });
}

test('complete_registration: a code for an account that already existed is reported as existing_account', async () => {
  const h = harness('complete_registration', { scene: scenes.emailCode(), storage: [startedMarker()], after: [() => scenes.feed(email)] });
  const result = await h.run({ email, code: '4821', ...profile });
  assert.equal(result.error_kind, 'existing_account');
  assert.equal(JSON.parse(h.storage.get(`${site}|webmcp.ubereats.register.done`)).signup_seen, false);
});

test('complete_registration: a finished sign-up signed in to another account is wrong_account, never success', async () => {
  const h = harness('complete_registration', { scene: scenes.smsCode(), storage: [startedMarker({ signup_seen: true, phone_at: 1, phone_last2: '99' })], after: [() => scenes.feed(other)] });
  const result = await h.run({ email, code: '4821', ...profile });
  assert.deepEqual([result.ok, result.error_kind], [false, 'wrong_account']);
});

test('complete_registration: an SMS code step no phone was entered for is an existing account', async () => {
  const h = harness('complete_registration', { scene: scenes.smsCode(), storage: [startedMarker()] });
  assert.equal((await h.run({ email, code: '4821' })).error_kind, 'existing_account');
  assert.equal(h.calls.submits, 0);
});

for (const [label, scene, storage, kind] of [
  ['an unrelated page', scenes.other(), [], 'no_registration_in_progress'],
  ['the site home page', scenes.home(), [], 'no_registration_in_progress'],
  ['Uber\u2019s first step with no sign-up recorded', scenes.identifier(), [], 'no_registration_in_progress'],
  ['a code step for another email', scenes.emailCode(other), [startedMarker()], 'wrong_account'],
  ['a name screen', scenes.name(), [startedMarker()], 'invalid_input'],
]) {
  test(`complete_registration: invoked on ${label} submits nothing`, async () => {
    const h = harness('complete_registration', { scene, storage });
    const result = await h.run({ email, code: '4821' });
    assert.equal(result.error_kind, kind);
    assert.deepEqual([h.calls.submits, h.calls.fills, h.calls.navigations], [0, [], []]);
  });
}

test('complete_registration: a screen the tool does not know stops with unsupported_step', async () => {
  const h = harness('complete_registration', { scene: scenes.emailCode(), storage: [startedMarker()], after: [scenes.unknown] });
  const result = await h.run({ email, code: '4821', ...profile });
  assert.equal(result.error_kind, 'unsupported_step');
  assert.match(result.error_message, /marketing emails/);
});

test('resume_registration: never submits a code and reports the open challenge', async () => {
  const h = harness('resume_registration', { scene: scenes.emailCode(), storage: [startedMarker()] });
  const result = await h.run({ email });
  assert.deepEqual([result.status, result.submission_attempted], ['challenge', false]);
  assert.deepEqual([h.calls.submits, h.calls.fills], [0, []]);
});

test('resume_registration: continues a profile screen once and refuses to resubmit it right away', async () => {
  const h = harness('resume_registration', { scene: scenes.name(), storage: [startedMarker({ phone_at: 1, phone_last2: '99' })], after: [scenes.terms] });
  const needs = await h.run({ email, first_name: 'Qa', last_name: 'Tester' });
  assert.deepEqual([needs.status, needs.needs, needs.steps_submitted], ['needs_input', ['accept_terms'], ['profile']]);
  const again = harness('resume_registration', { scene: scenes.name(), storage: [[auth, 'webmcp.ubereats.register', h.marker()]] });
  assert.equal((await again.run({ email, first_name: 'Qa', last_name: 'Tester' })).error_kind, 'duplicate_submission');
  assert.equal(again.calls.submits, 0);
});

test('resume_registration: on the site it verifies the account only for a sign-up this tab completed', async () => {
  const done = harness('resume_registration', { scene: scenes.feed(email), storage: [[site, 'webmcp.ubereats.register.done', { h: sha(email), signup_seen: true }]] });
  assert.equal((await done.run({ email })).status, 'registered');
  const unrecorded = harness('resume_registration', { scene: scenes.feed(email) });
  assert.equal((await unrecorded.run({ email })).error_kind, 'unknown');
  const existing = harness('resume_registration', { scene: scenes.feed(email), storage: [[site, 'webmcp.ubereats.register.done', { h: sha(email), signup_seen: false }]] });
  assert.equal((await existing.run({ email })).error_kind, 'existing_account');
  const wrong = harness('resume_registration', { scene: scenes.feed(other), storage: [[site, 'webmcp.ubereats.register.done', { h: sha(email), signup_seen: true }]] });
  assert.equal((await wrong.run({ email })).error_kind, 'wrong_account');
  const signedOut = harness('resume_registration', { scene: scenes.home() });
  assert.equal((await signedOut.run({ email })).error_kind, 'no_registration_in_progress');
});

test('resume_registration: Uber back at its first step means the sign-up is gone', async () => {
  const h = harness('resume_registration', { scene: scenes.identifier(), storage: [startedMarker()] });
  assert.equal((await h.run({ email })).error_kind, 'no_registration_in_progress');
});

test('error messages from the site never echo a phone number or email address', async () => {
  const h = harness('resume_registration', { scene: scenes.phone(), storage: [startedMarker()], after: [{ stay: true, errors: ['+1 555 010 0199 is already in use by qa-owner@example.invalid.'] }] });
  const result = await h.run({ email, ...profile });
  assert.equal(result.error_kind, 'phone_conflict');
  assert.ok(!/555|qa-owner/.test(result.error_message), result.error_message);
});
