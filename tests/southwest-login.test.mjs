import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../domains/southwest.com/login.js', import.meta.url), 'utf8');
const entryUrl = 'https://www.southwest.com/';
const input = { username: 'qa-no-account', password: 'not-real-pass' };
const invalidCredentials = 'The username/account number and/or password are incorrect.';
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
  if (typeof value === 'number' && value < (schema.minimum ?? -Infinity)) return false;
  if (schema.format === 'uri' && !URL.canParse(value)) return false;
  return true;
}

function harness(options = {}) {
  let url = options.url ?? entryUrl;
  let formVisible = options.formVisible ?? true;
  let errors = options.errors ?? [];
  let signals = options.signals ?? [];
  let logout = options.logout ?? false;
  let otp = options.otp ?? false;
  let observer;
  let submitListener;
  let waits = 0;
  let snapshots = 0;
  let submitted = false;
  const window = {};
  const calls = { navigations: [], fills: [], submits: 0, cleaned: 0 };
  const element = (text = '') => ({
    nodeType: 1, innerText: text, textContent: text,
    getClientRects: () => [1],
    closest: () => null, querySelector: () => null,
    matches: () => false,
    getAttribute: () => null,
  });
  const feedback = text => ({ ...element(text), closest: () => ({}) });
  const username = { ...element(), value: options.prefilled ? input.username : '', checkValidity: () => username.value.length >= 4 && username.value.length <= 20 };
  const password = { ...element(), value: options.prefilled ? input.password : '', type: 'password', checkValidity: () => password.value.length >= 8 && password.value.length <= 16 };
  const remember = { ...element(), checked: false };
  const button = { ...element('Log in'), disabled: options.disabled ?? false };
  const form = { ...element(), getClientRects: () => [], querySelector: () => button };
  username.closest = password.closest = () => form;
  username.getClientRects = password.getClientRects = () => formVisible ? [1] : [];
  const document = {
    body: element(),
    querySelector: selector => {
      if (selector === '#username') return username;
      if (selector === '#password') return password;
      if (selector.includes('rememberMe')) return remember;
      return null;
    },
    querySelectorAll: selector => {
      if (selector.startsWith('[role="alert"]')) return errors.map(feedback);
      if (selector.startsWith('h1,')) return signals.map(element);
      if (selector === 'iframe') return [];
      if (selector === 'a,button') return logout ? [element('Log out')] : [];
      if (selector === 'input') return otp ? [{ ...element(), autocomplete: 'one-time-code' }] : [];
      return [];
    },
    addEventListener: (type, listener) => { if (type === 'submit') submitListener = listener; },
    removeEventListener: () => { submitListener = undefined; calls.cleaned++; },
  };
  function apply(result) {
    if ('errors' in result) {
      errors = result.errors;
      observer?.([{ target: form, addedNodes: errors.map(feedback), removedNodes: [] }]);
    }
    if ('formVisible' in result) formVisible = result.formVisible;
    if ('logout' in result) logout = result.logout;
    if ('otp' in result) otp = result.otp;
    if ('signals' in result) signals = result.signals;
    if (result.url) {
      url = result.url;
      delete window.__swLoginWatch;
    }
  }
  const context = {
    URL, window, document,
    get location() { return new URL(url); },
    getComputedStyle: () => ({ visibility: 'visible', display: 'block' }),
    MutationObserver: class {
      constructor(callback) { this.callback = callback; }
      observe() { observer = this.callback; }
      disconnect() { observer = undefined; }
    },
    js: async fn => {
      if (options.transientRead && submitted && waits === 1) throw Error('Execution context replaced');
      return fn();
    },
    pageInfo: async () => ({ url }),
    gotoUrl: async next => {
      calls.navigations.push(next);
      if (options.navigationError) throw Error('Navigation failed');
      url = next;
      formVisible = false;
      errors = []; signals = []; logout = false; otp = false;
      username.value = password.value = '';
    },
    waitForLoad: async () => options.entryLoads !== false,
    accessibilitySnapshot: async () => ({
      nodes: ++snapshots > (options.buttonDelay ?? 0) && !options.noEntry
        ? [{ role: 'button', name: 'Passenger Log in', backendNodeId: 1 }]
        : [],
    }),
    waitForElement: async () => options.formLoads !== false,
    fillInput: async (selector, value) => {
      calls.fills.push(selector);
      (selector === '#username' ? username : password).value = value;
    },
    click: async target => {
      if (typeof target === 'object') {
        formVisible = true;
        if (options.openRedirect) url = options.openRedirect;
        return;
      }
      if (target.includes('rememberMe')) { remember.checked = !remember.checked; return; }
      calls.submits++;
      submitted = true;
      if (options.clickError) throw Error('Click outcome unknown');
      submitListener?.({ target: form });
    },
    waitMs: async () => {
      if (!submitted) return;
      waits++;
      if (waits === (options.resultDelay ?? 1)) apply(options.result ?? { errors: [invalidCredentials] });
    },
  };
  const definitions = runInNewContext(`(${source})`, context);
  return {
    definitions, calls, remember,
    run: async (args = input) => {
      const result = plain(await definitions[0].execute(args));
      assert.ok(conforms(definitions[0].tool.outputSchema, result), JSON.stringify(result));
      assert.ok(calls.submits <= 1, 'must never retry submit');
      return result;
    },
  };
}

test('single-expression CDP tool declares domain patterns and typed schemas', () => {
  const [definition] = harness().definitions;
  assert.equal(definition.kind, 'cdp');
  assert.equal(definition.tool.name, 'login');
  assert.deepEqual(plain(definition.match.url_patterns), ['https://southwest.com/*', 'https://*.southwest.com/*']);
  assert.equal(definition.tool.inputSchema.type, 'object');
  assert.equal(definition.tool.outputSchema.type, 'object');
  assert.equal(definition.tool.annotations.readOnlyHint, false);
  assert.ok(conforms(definition.tool.inputSchema, input));
  assert.ok(conforms(definition.tool.inputSchema, { use_prefilled: true }));
});

test('registry matches the canonical login definition and namespace', () => {
  const registry = JSON.parse(readFileSync(new URL('../registry.json', import.meta.url), 'utf8'));
  const entry = registry.tools.find(t => t.domain === 'southwest.com' && t.tool === 'login');
  assert.equal(entry.namespace, 'southwest.com');
  assert.equal(entry.file, 'domains/southwest.com/login.js');
  assert.equal(entry.kind, 'cdp');
  assert.deepEqual(entry.url_patterns, plain(harness().definitions[0].match.url_patterns));
});

for (const args of [{}, { username: input.username }, { password: input.password }, { ...input, password: 1 }, { ...input, remember_me: 'yes' }, { ...input, use_prefilled: true }, { ...input, extra: true }]) {
  test(`invalid input cannot interact: ${Object.keys(args).join(',')}`, async () => {
    const h = harness();
    assert.equal(conforms(h.definitions[0].tool.inputSchema, args), false);
    assert.equal((await h.run(args)).error_kind, 'invalid_input');
    assert.deepEqual(h.calls, { navigations: [], fills: [], submits: 0, cleaned: 0 });
  });
}

for (const url of ['https://www.southwest.com/air/booking/select-depart.html', 'https://southwest.com/', 'https://mobile.southwest.com/', 'https://example.com/', 'about:blank']) {
  test(`routes unsuitable page to canonical entry: ${url}`, async () => {
    const h = harness({ url, formVisible: false });
    const result = await h.run();
    assert.deepEqual(h.calls.navigations, [entryUrl]);
    assert.equal(h.calls.submits, 1);
    assert.equal(result.error_kind, 'invalid_credentials');
  });
}

test('unrelated page challenge text does not prevent navigation to approved login', async () => {
  const h = harness({ url: 'https://example.com/', signals: ['CAPTCHA'] });
  assert.equal((await h.run()).error_kind, 'invalid_credentials');
  assert.deepEqual(h.calls.navigations, [entryUrl]);
});

test('prefilled values are not carried across navigation', async () => {
  const h = harness({ url: 'https://example.com/', prefilled: true });
  const result = await h.run({ use_prefilled: true });
  assert.equal(result.error_kind, 'invalid_input');
  assert.equal(result.submitted, false);
  assert.deepEqual(h.calls.navigations, [entryUrl]);
  assert.equal(h.calls.submits, 0);
});

test('visible inputs in display:contents form submit once with remember-me', async () => {
  const h = harness();
  const result = await h.run({ ...input, remember_me: true });
  assert.equal(result.error_message, invalidCredentials);
  assert.equal(result.submission_state, 'dispatched');
  assert.equal(result.attempts_remaining_if_shown, null);
  assert.equal(h.remember.checked, true);
  assert.equal(h.calls.cleaned, 1);
  assert.deepEqual(h.calls.navigations, []);
});

test('waits for asynchronously rendered entry button', async () => {
  const h = harness({ formVisible: false, buttonDelay: 4 });
  assert.equal((await h.run()).error_kind, 'invalid_credentials');
  assert.equal(h.calls.submits, 1);
});

for (const options of [{ navigationError: true, url: 'https://example.com/' }, { entryLoads: false, url: 'https://example.com/' }, { noEntry: true, formVisible: false }, { formLoads: false, formVisible: false }, { formVisible: false, openRedirect: 'https://example.com/' }]) {
  test(`entry failures never submit: ${JSON.stringify(options)}`, async () => {
    const h = harness(options);
    assert.equal((await h.run()).error_kind, 'unknown');
    assert.equal(h.calls.submits, 0);
    assert.deepEqual(h.calls.fills, []);
  });
}

test('empty prefilled fields do not submit', async () => {
  const h = harness();
  assert.equal((await h.run({ use_prefilled: true })).error_kind, 'invalid_input');
  assert.equal(h.calls.submits, 0);
});

test('disabled submit is not reported as dispatched', async () => {
  const h = harness({ disabled: true });
  const result = await h.run();
  assert.equal(result.submission_state, 'not_dispatched');
  assert.equal(result.submitted, false);
  assert.equal(h.calls.submits, 0);
});

for (const [text, kind] of [
  ['The verification code is invalid.', 'mfa_failed'],
  ['Too many login attempts. 2 attempts remaining.', 'locked_or_throttled'],
  ['Security challenge', 'captcha_or_challenge'],
]) {
  test(`preflight ${kind} does not fill or submit`, async () => {
    const h = harness({ errors: [text] });
    const result = await h.run();
    assert.equal(result.error_kind, kind);
    assert.equal(result.submission_state, 'not_dispatched');
    assert.deepEqual(h.calls.fills, []);
    assert.equal(h.calls.submits, 0);
    if (kind === 'locked_or_throttled') assert.equal(result.attempts_remaining_if_shown, 2);
  });
  test(`post-submit ${kind} returns explicit failure without retry`, async () => {
    const h = harness({ result: { errors: [text] } });
    assert.equal((await h.run()).error_kind, kind);
    assert.equal(h.calls.submits, 1);
  });
}

test('CAPTCHA heading stops before credential entry', async () => {
  const h = harness({ signals: ['CAPTCHA'] });
  assert.equal((await h.run()).error_kind, 'captcha_or_challenge');
  assert.equal(h.calls.submits, 0);
  assert.deepEqual(h.calls.fills, []);
});

test('stale error is ignored until new post-submit feedback', async () => {
  const h = harness({ errors: [invalidCredentials], resultDelay: 4, result: { errors: ['Service unavailable.'] } });
  const result = await h.run();
  assert.equal(result.error_kind, 'unknown');
  assert.equal(result.error_message, 'Service unavailable.');
  assert.equal(h.calls.submits, 1);
});

test('unchanged stale error times out explicitly rather than faking rejection', async () => {
  const h = harness({ errors: [invalidCredentials], resultDelay: 100 });
  const result = await h.run();
  assert.equal(result.error_kind, 'unknown');
  assert.match(result.error_message, /No conclusive authentication result/);
  assert.equal(h.calls.submits, 1);
});

test('uncertain click is never retried', async () => {
  const h = harness({ clickError: true });
  const result = await h.run();
  assert.equal(result.error_kind, 'unknown');
  assert.equal(result.submission_state, 'unknown');
  assert.equal(h.calls.submits, 1);
});

test('authenticated success is schema-valid after document replacement', async () => {
  const h = harness({ result: { formVisible: false, logout: true, url: `${entryUrl}myaccount/` } });
  const result = await h.run();
  assert.equal(result.logged_in, true);
  assert.equal(result.authenticated, true);
  assert.equal(result.mfa_required, false);
  assert.equal(result.next_step, 'none');
  assert.equal(h.calls.submits, 1);
});

test('first-step MFA success remains explicitly unauthenticated', async () => {
  const h = harness({ result: { formVisible: false, otp: true, signals: ['We sent a verification code.'] } });
  const result = await h.run();
  assert.equal(result.logged_in, true);
  assert.equal(result.authenticated, false);
  assert.equal(result.mfa_required, true);
  assert.equal(result.next_step, 'complete_mfa_in_browser');
  assert.equal(h.calls.submits, 1);
  assert.equal(conforms(h.definitions[0].tool.outputSchema, { ...result, authenticated: true }), false);
});

test('an already authenticated page is not submitted again', async () => {
  const h = harness({ formVisible: false, logout: true, url: `${entryUrl}myaccount/` });
  assert.equal((await h.run()).authenticated, true);
  assert.equal(h.calls.submits, 0);
  assert.deepEqual(h.calls.navigations, []);
});

test('a transient post-submit context error retries only observation', async () => {
  const h = harness({ transientRead: true });
  assert.equal((await h.run()).error_kind, 'invalid_credentials');
  assert.equal(h.calls.submits, 1);
});

test('off-origin post-submit navigation fails closed', async () => {
  const h = harness({ result: { url: 'https://example.com/', logout: true, formVisible: false } });
  assert.equal((await h.run()).error_kind, 'unknown');
  assert.equal(h.calls.submits, 1);
});
