import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../domains/doordash.com/login.js", import.meta.url), "utf8");
const identityUrl = "https://identity.doordash.com/auth?client_id=1&layout=consumer_web&redirect_uri=https%3A%2F%2Fwww.doordash.com%2F";
const profileUrl = "https://www.doordash.com/consumer/edit_profile/";
const searchEntry = "https://start.duckduckgo.com/";
const guardKey = "doordash.com.login.submitted.v1";
const input = { email: "qa@example.invalid", password: "fabricated-test-password" };
const unknownEmail = "Incorrect email We couldn't find an account with the email you entered. Try a different email or sign up. Create an account";
const wrongPassword = "Incorrect password. Please try again.";
const plain = value => JSON.parse(JSON.stringify(value));

const base = {
  url: "https://www.doordash.com/home", host: "www.doordash.com", https: true, referrer: "", loggedInCookie: false,
  account: null, profileEmail: null, emailStep: false, emailValue: "", emailSubmit: false, phoneStep: false, usePassword: false,
  passwordStep: false, passwordLength: 0, passwordSubmit: false, boundEmail: null, codeStep: false, codeCount: 0, codeHint: null,
  errors: [], challenge: null, feedbackChanged: false
};
const emailStep = { ...base, url: identityUrl, host: "identity.doordash.com", referrer: "https://duckduckgo.com/", emailStep: true, emailSubmit: true };
const phoneStep = { ...emailStep, emailStep: false, emailSubmit: false, phoneStep: true, usePassword: true };
const passwordStep = { ...emailStep, emailStep: false, emailSubmit: false, passwordStep: true, passwordSubmit: true, boundEmail: input.email };
const codeStep = { ...emailStep, emailStep: false, emailSubmit: false, codeStep: true, codeCount: 6, codeHint: "Enter the 6-digit code we sent to your phone." };
const home = { ...base, loggedInCookie: true, account: "Account" };

// Validate the JSON Schema keywords used by this tool without adding a dependency.
function conforms(schema, value) {
  if ("const" in schema && value !== schema.const) return false;
  if (schema.enum && !schema.enum.includes(value)) return false;
  if (schema.type && ![schema.type].flat().some(type => {
    if (type === "null") return value === null;
    if (type === "integer") return Number.isInteger(value);
    if (type === "object") return value !== null && typeof value === "object" && !Array.isArray(value);
    return typeof value === type;
  })) return false;
  if (schema.oneOf && schema.oneOf.filter(s => conforms(s, value)).length !== 1) return false;
  if (schema.anyOf && !schema.anyOf.some(s => conforms(s, value))) return false;
  if (schema.not && conforms(schema.not, value)) return false;
  if (schema.required?.some(key => !Object.hasOwn(value, key))) return false;
  if (schema.properties && value !== null && typeof value === "object") {
    if (Object.entries(schema.properties).some(([key, s]) => key in value && !conforms(s, value[key]))) return false;
    if (schema.additionalProperties === false && Object.keys(value).some(key => !(key in schema.properties))) return false;
  }
  if (typeof value === "string" && (value.length < (schema.minLength ?? 0) || value.length > (schema.maxLength ?? Infinity))) return false;
  if (typeof value === "string" && schema.pattern && !new RegExp(schema.pattern).test(value)) return false;
  if (typeof value === "number" && value < (schema.minimum ?? -Infinity)) return false;
  if (schema.format === "uri" && !URL.canParse(value)) return false;
  if (schema.format === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return false;
  return true;
}

function harness(options = {}) {
  let state = { ...base, ...options.initial };
  let cookie = options.cookie ?? false;
  let now = 1_000_000;
  let submitted = false;
  let interrupted = false;
  let pending = [];
  const store = new Map(options.guarded ? [[guardKey, now - 1000]] : []);
  const calls = { navigations: [], fills: [], clicks: [], submits: 0, otpSubmits: 0, reads: 0, guardCleared: 0, otp: null, watches: 0 };
  const advance = () => {
    if (!pending.length) return;
    const { cookie: nextCookie, ...next } = pending.shift();
    if (nextCookie !== undefined) cookie = nextCookie;
    state = { ...state, ...next };
  };
  const navigate = url => {
    if (url === searchEntry) return { ...base, url: "https://duckduckgo.com/?q=doordash+login", host: "duckduckgo.com" };
    if (url === profileUrl) {
      if (options.profileRedirect) return { ...emailStep, referrer: profileUrl };
      return { ...home, url: profileUrl, profileEmail: options.profileEmail === undefined ? input.email : options.profileEmail };
    }
    throw new Error("unexpected navigation " + url);
  };
  const tools = runInNewContext(`(${source})`, {
    URL, Date: { now: () => now },
    js: async (fn, args) => {
      const code = fn.toString();
      if (code.includes("loggedInCookie")) {
        calls.reads++;
        if (submitted && options.readInterrupted && !interrupted) { interrupted = true; throw new Error("Execution context replaced"); }
        return { ...state, loggedInCookie: cookie };
      }
      if (code.includes("MutationObserver")) { calls.watches++; return undefined; }
      if (code.includes("__ddLoginWatch")) return undefined;
      if (code.includes("result-title-a")) return options.searchResult === undefined ? { href: "https://www.doordash.com/consumer/login", host: "www.doordash.com", https: true } : options.searchResult;
      if (code.includes('"signin"')) return options.signInControl ?? true;
      if (code.includes("use-password")) return undefined;
      if (code.includes("sessionStorage.getItem")) {
        const previous = store.get(args.arg.key) || 0;
        if (previous && now - previous < args.arg.ttl) return false;
        store.set(args.arg.key, now);
        return true;
      }
      if (code.includes("removeItem")) { store.delete(args.arg); calls.guardCleared++; return undefined; }
      if (code.includes("ClipboardEvent")) { calls.otp = args.arg; return options.otpAccepted ?? true; }
      if (code.includes("otp-submit")) return options.otpSubmit ?? true;
      throw new Error("unexpected page function: " + code.slice(0, 80));
    },
    cdp: async method => {
      assert.equal(method, "Network.getCookies");
      return { cookies: cookie ? [{ name: "dd_cx_logged_in", value: "true" }] : [] };
    },
    gotoUrl: async url => { calls.navigations.push(url); state = navigate(url); },
    accessibilitySnapshot: async () => ({ nodes: options.missingSearchControls ? [] : [
      { role: "combobox", name: "Search with DuckDuckGo", backendNodeId: 1 },
      { role: "button", name: "Search", backendNodeId: 2 }
    ] }),
    waitForElement: async selector => !options.missingSelector?.test(selector),
    fillInput: async (selector, value) => {
      if (typeof selector === "object") { calls.fills.push("search:" + value); return; }
      calls.fills.push(selector);
      if (selector.includes('type="email"')) state = { ...state, emailValue: options.emailAccepted === false ? "" : value };
      if (selector.includes('type="password"')) {
        if (options.slowPasswordFill) now += options.slowPasswordFill;
        state = { ...state, passwordLength: options.passwordAccepted === false ? 0 : value.length };
      }
    },
    click: async selector => {
      const name = typeof selector === "object" ? "search" : selector;
      calls.clicks.push(name);
      if (name === '[data-webmcp-doordash-login="result"]') state = options.afterResult ?? { ...emailStep };
      else if (name === '[data-webmcp-doordash-login="signin"]') state = options.afterSignIn ?? { ...emailStep, referrer: "https://www.doordash.com/" };
      else if (name.includes("#guided-submit-button")) state = options.afterEmail ?? { ...phoneStep };
      else if (name === '[data-webmcp-doordash-login="use-password"]') state = options.afterUsePassword ?? { ...passwordStep };
      else if (name.includes("#login-submit-button")) {
        assert.equal(submitted, false, "one password submission maximum");
        submitted = true;
        calls.submits++;
        if (options.clickInterrupted) throw new Error("Click outcome unknown");
        pending = [...(options.after ?? [{ errors: [wrongPassword] }])];
      } else if (name === '[data-webmcp-doordash-login="otp-submit"]') {
        calls.otpSubmits++;
        pending = [...(options.after ?? [])];
      }
    },
    waitMs: async ms => { now += ms; advance(); }
  });
  return {
    tool: tools[0], calls, store,
    run: async (...args) => {
      const result = plain(await tools[0].execute(args.length ? args[0] : input, args[1]));
      assert.ok(conforms(tools[0].tool.outputSchema, result), JSON.stringify(result));
      assert.ok(calls.submits <= 1, "must never retry the password submission");
      return result;
    }
  };
}

test("single expression, CDP kind, domain patterns and dual typed schemas", () => {
  assert.ok(!source.trimEnd().endsWith(";"), "the runtime wraps the source in an expression");
  const { tool } = harness();
  assert.equal(tool.kind, "cdp");
  assert.equal(tool.tool.name, "login");
  assert.deepEqual(plain(tool.match.url_patterns), ["https://doordash.com/*", "https://*.doordash.com/*"]);
  assert.equal(tool.tool.inputSchema.type, "object");
  assert.equal(tool.tool.outputSchema.oneOf.length, 2);
  assert.equal(tool.tool.annotations.readOnlyHint, false);
  assert.ok(conforms(tool.tool.inputSchema, input));
  assert.ok(conforms(tool.tool.inputSchema, { email: input.email, otp: "123456" }));
  assert.equal(conforms(tool.tool.inputSchema, { ...input, otp: "123456" }), false);
  assert.equal(conforms(tool.tool.inputSchema, { email: input.email }), false);
});

test("registry entry matches the canonical definition", () => {
  const registry = JSON.parse(readFileSync(new URL("../registry.json", import.meta.url), "utf8"));
  const entry = registry.tools.find(t => t.domain === "doordash.com" && t.tool === "login");
  assert.equal(entry.namespace, "doordash.com");
  assert.equal(entry.file, "domains/doordash.com/login.js");
  assert.equal(entry.kind, "cdp");
  assert.deepEqual(entry.url_patterns, plain(harness().tool.match.url_patterns));
  const domains = registry.tools.map(t => t.domain + " " + t.tool);
  assert.deepEqual(domains, [...domains].sort(), "registry is sorted by domain then tool");
});

for (const invalid of [undefined, null, [], {}, { email: input.email }, { password: input.password }, { ...input, otp: "123456" }, { ...input, password: "" }, { email: "not-an-email", password: "x" }, { email: input.email, otp: "12345" }, { email: input.email, otp: 123456 }, { ...input, remember_me: true }, { email: " ", password: "x" }]) {
  test(`invalid input is rejected before any page action: ${JSON.stringify(invalid)}`, async () => {
    const h = harness();
    if (invalid && typeof invalid === "object" && !Array.isArray(invalid)) assert.equal(conforms(h.tool.tool.inputSchema, invalid), false);
    const result = await h.run(invalid);
    assert.equal(result.error_kind, "invalid_input");
    assert.equal(result.step, "input");
    assert.equal(result.submission_attempted, false);
    assert.deepEqual(h.calls, { navigations: [], fills: [], clicks: [], submits: 0, otpSubmits: 0, reads: 0, guardCleared: 0, otp: null, watches: 0 });
  });
}

test("an existing session for the requested account succeeds without any submission", async () => {
  const h = harness({ initial: home, cookie: true });
  const result = await h.run();
  assert.equal(result.logged_in, true);
  assert.equal(result.authenticated, true);
  assert.equal(result.mfa_required, false);
  assert.equal(result.account_hint, "q***@example.invalid");
  assert.equal(result.submission_attempted, false);
  assert.deepEqual(h.calls.navigations, [profileUrl]);
  assert.equal(h.calls.submits, 0);
  assert.deepEqual(h.calls.fills, []);
});

test("the session cookie alone triggers the profile check from an unrelated page", async () => {
  const h = harness({ initial: { ...base, url: "https://example.com/", host: "example.com" }, cookie: true });
  assert.equal((await h.run()).authenticated, true);
  assert.deepEqual(h.calls.navigations, [profileUrl]);
});

test("email comparison ignores case", async () => {
  const h = harness({ initial: home, cookie: true, profileEmail: "QA@Example.Invalid" });
  assert.equal((await h.run({ ...input, email: "qa@EXAMPLE.invalid" })).authenticated, true);
});

test("a session for a different account is never reported as success", async () => {
  const h = harness({ initial: home, cookie: true, profileEmail: "someone.else@example.invalid" });
  const result = await h.run();
  assert.equal(result.logged_in, false);
  assert.equal(result.error_kind, "unknown");
  assert.equal(result.step, "session_check");
  assert.match(result.error_message, /s\*\*\*@example\.invalid/);
  assert.doesNotMatch(result.error_message, /someone\.else/);
  assert.equal(h.calls.submits, 0);
});

test("a stale session cookie that redirects to sign-in continues with the login flow", async () => {
  const h = harness({ initial: home, cookie: true, profileRedirect: true });
  const result = await h.run();
  assert.equal(result.error_kind, "invalid_credentials");
  assert.deepEqual(h.calls.navigations, [profileUrl, searchEntry]);
  assert.equal(h.calls.submits, 1);
});

for (const initial of [
  { ...base, url: "https://example.com/", host: "example.com" },
  { ...base, url: "about:blank", host: "", https: false },
  base,
  { ...base, url: "https://www.doordash.com/search/store/pizza/" },
  { ...base, url: "https://help.doordash.com/consumers", host: "help.doordash.com" },
  { ...emailStep, referrer: "" }
]) {
  test(`unsuitable page enters through search: ${initial.url}`, async () => {
    const h = harness({ initial });
    const result = await h.run();
    assert.equal(result.error_kind, "invalid_credentials");
    assert.equal(result.error_message, wrongPassword);
    assert.equal(result.step, "password_step");
    assert.equal(result.submission_attempted, true);
    assert.deepEqual(h.calls.navigations, [searchEntry]);
    assert.deepEqual(h.calls.fills, ["search:doordash login", 'form[data-testid="login-form-guided-email"] input[type="email"]', 'form#login-form input[type="password"]']);
    assert.deepEqual(h.calls.clicks, ["search", '[data-webmcp-doordash-login="result"]', 'form[data-testid="login-form-guided-email"] #guided-submit-button', '[data-webmcp-doordash-login="use-password"]', "form#login-form #login-submit-button"]);
    assert.equal(h.calls.guardCleared, 1, "a conclusive site rejection releases the per-tab guard");
  });
}

test("a search-referred email step is reused without a new search", async () => {
  const h = harness({ initial: emailStep });
  assert.equal((await h.run()).error_kind, "invalid_credentials");
  assert.deepEqual(h.calls.navigations, []);
  assert.equal(h.calls.submits, 1);
});

test("an open password step for the requested account submits without re-entering", async () => {
  const h = harness({ initial: passwordStep });
  const result = await h.run();
  assert.equal(result.error_kind, "invalid_credentials");
  assert.deepEqual(h.calls.navigations, []);
  assert.deepEqual(h.calls.fills, ['form#login-form input[type="password"]']);
  assert.equal(h.calls.submits, 1);
});

test("a password step bound to another account is not submitted", async () => {
  const h = harness({ initial: { ...passwordStep, boundEmail: "other@example.invalid" } });
  const result = await h.run();
  assert.equal(result.error_kind, "unknown");
  assert.equal(result.step, "password_step");
  assert.match(result.error_message, /o\*\*\*@example\.invalid/);
  assert.equal(h.calls.submits, 0);
  assert.deepEqual(h.calls.fills, []);
});

for (const [label, options, step] of [
  ["search controls missing", { missingSearchControls: true }, "search_entry"],
  ["no organic results", { missingSelector: /result-title-a/ }, "search_entry"],
  ["first organic result off-site", { searchResult: { href: "https://doordash.example.net/login", host: "doordash.example.net", https: true } }, "search_entry"],
  ["first organic result not https", { searchResult: { href: "http://www.doordash.com/consumer/login", host: "www.doordash.com", https: false } }, "search_entry"],
  ["result never reaches doordash", { afterResult: { ...base, url: "https://example.com/", host: "example.com" } }, "site_entry"],
  ["site page without sign-in control", { afterResult: base, signInControl: false }, "site_entry"],
  ["challenge on landing", { afterResult: { ...emailStep, challenge: "Verify you are human" } }, "site_entry"]
]) {
  test(`entry failure never submits: ${label}`, async () => {
    const h = harness({ initial: { ...base, url: "https://example.com/", host: "example.com" }, ...options });
    const result = await h.run();
    assert.equal(result.logged_in, false);
    assert.equal(result.step, step);
    assert.equal(result.error_kind, label.includes("challenge") ? "captcha_or_challenge" : "unknown");
    assert.equal(result.submission_attempted, false);
    assert.equal(h.calls.submits, 0);
    assert.ok(!h.calls.fills.some(f => f.includes("password")));
  });
}

test("a homepage result opens sign-in from the site's own control", async () => {
  const h = harness({ initial: { ...base, url: "https://example.com/", host: "example.com" }, searchResult: { href: "https://www.doordash.com/", host: "www.doordash.com", https: true }, afterResult: base });
  assert.equal((await h.run()).error_kind, "invalid_credentials");
  assert.ok(h.calls.clicks.includes('[data-webmcp-doordash-login="signin"]'));
  assert.equal(h.calls.submits, 1);
});

test("an unknown email is reported from the site's own message without a password submission", async () => {
  const h = harness({ initial: emailStep, afterEmail: { ...emailStep, errors: [unknownEmail] } });
  const result = await h.run();
  assert.equal(result.error_kind, "invalid_credentials");
  assert.equal(result.error_message, unknownEmail);
  assert.equal(result.step, "email_step");
  assert.equal(result.submission_attempted, false);
  assert.equal(h.calls.submits, 0);
  assert.deepEqual(h.calls.fills, ['form[data-testid="login-form-guided-email"] input[type="email"]']);
});

test("an email field that does not take the address stops before continuing", async () => {
  const h = harness({ initial: emailStep, emailAccepted: false });
  const result = await h.run();
  assert.equal(result.error_kind, "unknown");
  assert.equal(result.step, "email_step");
  assert.deepEqual(h.calls.clicks, []);
});

test("a phone-code step without a password option stops explicitly", async () => {
  const h = harness({ initial: emailStep, afterEmail: { ...phoneStep, usePassword: false } });
  const result = await h.run();
  assert.equal(result.error_kind, "unknown");
  assert.equal(result.step, "password_option");
  assert.match(result.error_message, /phone-code/);
  assert.equal(h.calls.submits, 0);
});

test("a password step offered directly after the email skips the phone option", async () => {
  const h = harness({ initial: emailStep, afterEmail: { ...passwordStep } });
  assert.equal((await h.run()).error_kind, "invalid_credentials");
  assert.ok(!h.calls.clicks.includes('[data-webmcp-doordash-login="use-password"]'));
});

test("a code step already open in password mode is not submitted", async () => {
  const h = harness({ initial: codeStep });
  const result = await h.run();
  assert.equal(result.error_kind, "unknown");
  assert.match(result.error_message, /otp/);
  assert.equal(h.calls.submits, 0);
});

test("a password field that rejects the value is not submitted", async () => {
  const h = harness({ initial: passwordStep, passwordAccepted: false });
  const result = await h.run();
  assert.equal(result.error_kind, "unknown");
  assert.equal(result.step, "password_step");
  assert.equal(h.calls.submits, 0);
});

test("a disabled submit control is not clicked", async () => {
  const h = harness({ initial: { ...passwordStep, passwordSubmit: false } });
  assert.equal((await h.run()).error_kind, "unknown");
  assert.equal(h.calls.submits, 0);
});

test("the per-tab guard blocks a second submission", async () => {
  const h = harness({ initial: passwordStep, guarded: true });
  const result = await h.run();
  assert.equal(result.error_kind, "unknown");
  assert.match(result.error_message, /already submitted/);
  assert.equal(result.submission_attempted, false);
  assert.equal(h.calls.submits, 0);
});

test("the guard is armed before the click and kept after an uncertain outcome", async () => {
  const h = harness({ initial: passwordStep, after: [] });
  const result = await h.run();
  assert.equal(result.error_kind, "unknown");
  assert.match(result.error_message, /No conclusive sign-in result/);
  assert.equal(result.submission_attempted, true);
  assert.ok(h.store.has(guardKey));
  assert.equal(h.calls.guardCleared, 0);
});

test("an uncertain click is never retried", async () => {
  const h = harness({ initial: passwordStep, clickInterrupted: true });
  const result = await h.run();
  assert.equal(result.error_kind, "unknown");
  assert.equal(result.submission_attempted, true);
  assert.equal(h.calls.submits, 1);
});

test("a transient post-submit read failure only retries the observation", async () => {
  const h = harness({ initial: passwordStep, readInterrupted: true });
  assert.equal((await h.run()).error_kind, "invalid_credentials");
  assert.equal(h.calls.submits, 1);
});

test("a stale unchanged error is not attributed to the new attempt", async () => {
  const h = harness({ initial: { ...passwordStep, errors: [wrongPassword] }, after: [] });
  const result = await h.run();
  assert.equal(result.error_kind, "unknown");
  assert.match(result.error_message, /No conclusive/);
});

test("a stale error that clears and reappears counts as fresh", async () => {
  const h = harness({ initial: { ...passwordStep, errors: [wrongPassword] }, after: [{ errors: [] }, { errors: [wrongPassword] }] });
  assert.equal((await h.run()).error_kind, "invalid_credentials");
});

for (const [text, kind, remaining] of [
  ["Too many attempts. Try again later. 2 attempts remaining.", "locked_or_throttled", 2],
  ["Your account is temporarily blocked.", "locked_or_throttled", null],
  ["Please complete the captcha to continue.", "captcha_or_challenge", null],
  ["Something went wrong. Please try again.", "unknown", null]
]) {
  test(`post-submit site message classified as ${kind}: ${text}`, async () => {
    const h = harness({ initial: passwordStep, after: [{ errors: [text] }] });
    const result = await h.run();
    assert.equal(result.error_kind, kind);
    assert.equal(result.error_message, text);
    assert.equal(result.attempts_remaining, remaining);
    assert.equal(result.submission_attempted, true);
  });
}

test("a persistent challenge after submission is reported, not solved", async () => {
  const h = harness({ initial: passwordStep, after: [{ challenge: "Visible challenge frame: reCAPTCHA" }] });
  const result = await h.run();
  assert.equal(result.error_kind, "captcha_or_challenge");
  assert.equal(result.submission_attempted, true);
  assert.equal(h.calls.submits, 1);
});

test("a challenge that clears into a session still succeeds", async () => {
  const h = harness({ initial: passwordStep, after: [{ challenge: "Visible challenge frame: reCAPTCHA" }, {}, { challenge: null, cookie: true, url: "https://www.doordash.com/home", host: "www.doordash.com", passwordStep: false, passwordSubmit: false, account: "Account" }] });
  const result = await h.run();
  assert.equal(result.authenticated, true);
});

test("authenticated success requires a signed-in header control on the main site", async () => {
  const h = harness({ initial: passwordStep, after: [{ cookie: true }, { url: "https://www.doordash.com/?state=none&code=abc&action=Login", host: "www.doordash.com", passwordStep: false, passwordSubmit: false, account: null }, {}, {}, { url: "https://www.doordash.com/home", account: "Account" }] });
  const result = await h.run();
  assert.equal(result.logged_in, true);
  assert.equal(result.authenticated, true);
  assert.equal(result.mfa_required, false);
  assert.equal(result.next_step, "none");
  assert.equal(result.landing_url, "https://www.doordash.com/home");
  assert.equal(result.account_hint, "q***@example.invalid");
  assert.equal(result.submission_attempted, true);
  assert.equal(h.calls.reads > 2, true);
});

test("a code step after the password is first-step success, never authenticated", async () => {
  const h = harness({ initial: passwordStep, after: [{ ...codeStep }] });
  const result = await h.run();
  assert.equal(result.logged_in, true);
  assert.equal(result.authenticated, false);
  assert.equal(result.mfa_required, true);
  assert.equal(result.next_step, "submit_otp");
  assert.equal(result.evidence, codeStep.codeHint);
  assert.equal(conforms(h.tool.tool.outputSchema, { ...result, authenticated: true }), false);
});

test("a stale session cookie never turns a form-less sign-in page into success", async () => {
  const h = harness({ initial: home, cookie: true, profileRedirect: true, after: [{ passwordStep: false, passwordSubmit: false }] });
  const result = await h.run();
  assert.equal(result.logged_in, false);
  assert.equal(result.error_kind, "unknown");
  assert.match(result.error_message, /No conclusive sign-in result/);
  assert.equal(h.calls.submits, 1);
});

test("the session cookie alone is not success while the main site shows no signed-in control", async () => {
  const h = harness({ initial: passwordStep, after: [{ cookie: true, url: "https://www.doordash.com/?state=none&code=abc", host: "www.doordash.com", passwordStep: false, passwordSubmit: false, account: null }] });
  const result = await h.run();
  assert.equal(result.logged_in, false);
  assert.equal(result.error_kind, "unknown");
});

test("a code step on the main site is first-step success, never authenticated", async () => {
  const h = harness({ initial: passwordStep, after: [{ url: "https://www.doordash.com/?state=none&code=abc", host: "www.doordash.com", passwordStep: false, passwordSubmit: false, account: "Account", codeStep: true, codeCount: 1 }] });
  const result = await h.run();
  assert.equal(result.logged_in, true);
  assert.equal(result.authenticated, false);
  assert.equal(result.mfa_required, true);
});

test("an identical error re-rendered after submission counts as fresh when the watch saw it", async () => {
  const h = harness({ initial: { ...passwordStep, errors: [wrongPassword] }, after: [{ errors: [wrongPassword], feedbackChanged: true }] });
  const result = await h.run();
  assert.equal(result.error_kind, "invalid_credentials");
  assert.equal(h.calls.watches, 1);
  assert.equal(h.calls.guardCleared, 1);
});

test("the password is not submitted when the remaining budget cannot cover the observation window", async () => {
  const h = harness({ initial: passwordStep, slowPasswordFill: 80_000 });
  const result = await h.run();
  assert.equal(result.error_kind, "unknown");
  assert.match(result.error_message, /budget/);
  assert.equal(result.submission_attempted, false);
  assert.equal(h.calls.submits, 0);
  assert.equal(h.store.has(guardKey), false);
});

test("an aborted invocation signal stops before the password click", async () => {
  const h = harness({ initial: passwordStep });
  const result = await h.run(input, { signal: { aborted: true } });
  assert.equal(result.error_kind, "unknown");
  assert.equal(h.calls.submits, 0);
});

test("an aborted invocation signal stops the search entry without navigating further", async () => {
  const h = harness({ initial: { ...base, url: "https://example.com/", host: "example.com" } });
  const result = await h.run(input, { signal: { aborted: true } });
  assert.equal(result.step, "search_entry");
  assert.deepEqual(h.calls.clicks, []);
});

test("leaving doordash.com after submission fails closed", async () => {
  const h = harness({ initial: passwordStep, after: [{ url: "https://example.com/", host: "example.com", passwordStep: false }] });
  const result = await h.run();
  assert.equal(result.error_kind, "unknown");
  assert.equal(result.submission_attempted, true);
});

test("otp mode requires a visible code step", async () => {
  const h = harness({ initial: passwordStep });
  const result = await h.run({ email: input.email, otp: "123456" });
  assert.equal(result.error_kind, "unknown");
  assert.equal(result.step, "otp_step");
  assert.equal(result.submission_attempted, false);
  assert.equal(h.calls.otp, null);
  assert.deepEqual(h.calls.navigations, []);
});

test("otp mode refuses a flow bound to another account", async () => {
  const h = harness({ initial: { ...codeStep, boundEmail: "other@example.invalid" } });
  const result = await h.run({ email: input.email, otp: "123456" });
  assert.equal(result.error_kind, "unknown");
  assert.equal(h.calls.otp, null);
});

test("otp mode pastes the code once and reports authentication from the session cookie", async () => {
  const h = harness({ initial: codeStep, after: [{ cookie: true, url: "https://www.doordash.com/home", host: "www.doordash.com", codeStep: false, account: "Account" }] });
  const result = await h.run({ email: input.email, otp: "123456" });
  assert.equal(result.authenticated, true);
  assert.equal(result.submission_attempted, true);
  assert.equal(h.calls.otp, "123456");
  assert.equal(h.calls.otpSubmits, 1);
  assert.equal(h.calls.submits, 0);
});

test("a rejected code is mfa_failed and the guard is untouched", async () => {
  const h = harness({ initial: codeStep, after: [{ errors: ["The code you entered is incorrect."] }] });
  const result = await h.run({ email: input.email, otp: "123456" });
  assert.equal(result.error_kind, "mfa_failed");
  assert.equal(result.submission_attempted, true);
  assert.equal(h.calls.guardCleared, 0);
});

test("a code form that ignores the paste stops before any submission", async () => {
  const h = harness({ initial: codeStep, otpAccepted: false });
  const result = await h.run({ email: input.email, otp: "123456" });
  assert.equal(result.error_kind, "unknown");
  assert.equal(result.submission_attempted, false);
  assert.equal(h.calls.otpSubmits, 0);
});
