import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { El, h, makeDocument } from './alaskaair-fake-dom.mjs';

const source = readFileSync(new URL('../domains/alaskaair.com/login.js', import.meta.url), 'utf8');

function signInDoc({ captcha = false } = {}) {
  const user = new El('input', { id: 'username', value: '' });
  const pass = new El('input', { id: 'password', value: '' });
  const err = h('div', { cls: 'ulp-input-error-message', rects: 0 });
  const submit = h('button', { attrs: { type: 'submit', name: 'action' }, text: 'Sign in' });
  const form = h('form', {}, user, pass, err, submit);
  submit.form = form;
  const kids = [form];
  if (captcha) kids.push(h('div', { cls: 'ulp-captcha' }, h('iframe', { attrs: { src: 'https://www.google.com/recaptcha/enterprise/anchor?k=x' } })), new El('textarea', { id: 'g-recaptcha-response', value: '' }));
  return { doc: makeDocument(h('body', {}, ...kids)), user, pass, err, submit, form };
}
const homeDoc = (signedIn) => makeDocument(h('body', {}, h('borealis-header', {}, signedIn ? h('button', { attrs: { 'aria-label': 'Profile' } }) : h('a', { attrs: { href: '/account/login?int=x' }, text: 'Sign in' }))));

function harness(start, docs, { onSubmit } = {}) {
  let url = start;
  const log = { gotos: [], submits: 0 };
  const current = () => docs[new URL(url).hostname];
  const page = () => {
    const u = new URL(url);
    const doc = current();
    const pctx = { URL, document: doc, location: { href: url, hostname: u.hostname, pathname: u.pathname }, HTMLInputElement: El, Event: class { constructor(t) { this.type = t; } } };
    for (const e of doc.querySelectorAll('input')) { e.focus = () => {}; e.blur = () => {}; e.dispatchEvent = () => true; }
    return pctx;
  };
  const ctx = {
    URL, Date, Promise,
    pageInfo: async () => ({ url }),
    gotoUrl: async (u) => { log.gotos.push(u); url = 'https://auth0.alaskaair.com/u/login?state=s'; },
    waitForLoad: async () => true,
    waitForElement: async () => !!current().querySelector('#username'),
    waitMs: async () => {},
    js: async (fn, opts) => {
      const p = page();
      // The tool uses the native input value setter; route it to the fake element.
      p.HTMLInputElement = { prototype: {} };
      p.Object = { getOwnPropertyDescriptor: () => ({ set: { call: (el, v) => { el.value = v; } } }) };
      p.requestSubmitHook = () => { log.submits++; if (onSubmit) url = onSubmit(current()) || url; };
      for (const f of current().querySelectorAll('form')) f.requestSubmit = () => p.requestSubmitHook();
      return vm.runInNewContext('(' + fn.toString() + ')(' + JSON.stringify(opts?.arg ?? null) + ')', p);
    },
  };
  const defs = vm.runInNewContext('(' + source + ')', ctx);
  return { run: async (input) => JSON.parse(JSON.stringify(await defs[0].execute(input))), log, defs };
}

test('login definition: cdp kind, domain patterns, password never in outputs', () => {
  const { defs } = harness('https://www.alaskaair.com/', { 'www.alaskaair.com': homeDoc(false) });
  assert.equal(defs[0].kind, 'cdp');
  assert.equal(defs[0].tool.name, 'login');
  assert.deepEqual(JSON.parse(JSON.stringify(defs[0].match.url_patterns)), ['https://alaskaair.com/*', 'https://*.alaskaair.com/*']);
});

test('rejects malformed input before touching the page', async () => {
  const { run, log } = harness('https://www.alaskaair.com/', { 'www.alaskaair.com': homeDoc(false) });
  for (const input of [{}, { mode: 'credentials', identifier: 'u' }, { mode: 'credentials', identifier: 'u', password: 'p', otp: '123456' }, { mode: 'otp', otp: '12' }, { mode: 'otp', otp: '123456', password: 'p' }]) {
    assert.equal((await run(input)).status, 'invalid_input');
  }
  assert.equal(log.gotos.length, 0);
});

test('already signed in: nothing typed, identity not claimed', async () => {
  const { run, log } = harness('https://www.alaskaair.com/', { 'www.alaskaair.com': homeDoc(true) });
  const r = await run({ mode: 'credentials', identifier: 'user1', password: 'pw-secret' });
  assert.equal(r.status, 'already_signed_in');
  assert.equal(r.signed_in, true);
  assert.equal(log.gotos.length, 0);
  assert.doesNotMatch(JSON.stringify(r), /pw-secret|user1/);
});

test('unsolved CAPTCHA: reports challenge without typing or submitting', async () => {
  const s = signInDoc({ captcha: true });
  const { run, log } = harness('https://auth0.alaskaair.com/u/login?state=s', { 'auth0.alaskaair.com': s.doc });
  const r = await run({ mode: 'credentials', identifier: 'user1', password: 'pw-secret' });
  assert.equal(r.status, 'challenge');
  assert.equal(r.submitted, false);
  assert.equal(s.user.value, '');
  assert.equal(log.submits, 0);
});

test('signs in once from the home page and confirms the signed-in header', async () => {
  const s = signInDoc();
  const docs = { 'www.alaskaair.com': homeDoc(false), 'auth0.alaskaair.com': s.doc };
  const { run, log } = harness('https://www.alaskaair.com/', docs, { onSubmit: () => { docs['www.alaskaair.com'] = homeDoc(true); return 'https://www.alaskaair.com/atmosrewards/account/overview/'; } });
  const r = await run({ mode: 'credentials', identifier: 'user1', password: 'pw-secret' });
  assert.equal(r.status, 'signed_in');
  assert.equal(r.signed_in, true);
  assert.equal(log.submits, 1);
  assert.match(log.gotos[0], /^https:\/\/www\.alaskaair\.com\/account\/login/);
  assert.equal(s.user.value, 'user1');
  assert.doesNotMatch(JSON.stringify(r), /pw-secret/);
});

test('wrong password message is classified and not retried', async () => {
  const s = signInDoc();
  const { run, log } = harness('https://auth0.alaskaair.com/u/login?state=s', { 'auth0.alaskaair.com': s.doc }, { onSubmit: () => { s.err.rects = 1; s.err.ownText = 'Wrong username or password'; } });
  const r = await run({ mode: 'credentials', identifier: 'user1', password: 'bad' });
  assert.equal(r.status, 'invalid_credentials');
  assert.equal(r.submitted, true);
  assert.equal(log.submits, 1);
});

test('otp mode requires a visible code step', async () => {
  const s = signInDoc();
  const { run, log } = harness('https://auth0.alaskaair.com/u/login?state=s', { 'auth0.alaskaair.com': s.doc });
  const r = await run({ mode: 'otp', otp: '123456' });
  assert.equal(r.status, 'wrong_state');
  assert.equal(log.submits, 0);
});
