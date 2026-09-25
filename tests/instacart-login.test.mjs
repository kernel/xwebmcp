import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../domains/instacart.com/login.js", import.meta.url), "utf8");
const searchEntry = "https://start.duckduckgo.com/";
const loginUrl = "https://www.instacart.com/login";
const accountUrl = "https://www.instacart.com/store/account";
const input = { email: "qa@example.invalid" };
const otpInput = { email: "qa@example.invalid", otp: "123456" };
const unknownEmail = "Enter a valid email address.";
const plain = value => JSON.parse(JSON.stringify(value));

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
  if (schema.required?.some(key => !Object.hasOwn(value, key))) return false;
  if (schema.properties && value !== null && typeof value === "object") {
    if (Object.entries(schema.properties).some(([key, s]) => key in value && !conforms(s, value[key]))) return false;
    if (schema.additionalProperties === false && Object.keys(value).some(key => !(key in schema.properties))) return false;
  }
  if (typeof value === "string") {
    if (value.length < (schema.minLength ?? 0) || value.length > (schema.maxLength ?? Infinity)) return false;
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) return false;
    if (schema.format === "uri" && !URL.canParse(value)) return false;
    if (schema.format === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return false;
  }
  if (typeof value === "number" && value < (schema.minimum ?? -Infinity)) return false;
  return true;
}

const base = {
  url: loginUrl, path: "/login", onSite: true, proxyError: false,
  emailForm: false, emailMatches: false, emailError: null,
  codeStep: false, codeLength: null, codeError: null, codeHint: null, hintMatches: null,
  alerts: [], challenge: null, captchaVisible: false,
  loginButton: false, accountButton: false, accountEmail: null, accountMatches: false
};
const pages = {
  loginForm: { ...base, emailForm: true },
  home: { ...base, url: "https://www.instacart.com/", path: "/", loginButton: true },
  loggedInHome: { ...base, url: "https://www.instacart.com/store/", path: "/store/", accountButton: true },
  codeStep: { ...base, codeStep: true, codeLength: 0, codeHint: "We sent a 6-digit code to qa@example.invalid. It expires soon", hintMatches: true },
  account: { ...base, url: accountUrl, path: "/store/account", accountButton: true, accountEmail: "qa@example.invalid", accountMatches: true },
  search: { ...base, url: "https://duckduckgo.com/?q=instacart+login", path: "/", onSite: false },
  offSite: { ...base, url: "https://example.com/", path: "/", onSite: false }
};

function harness(options = {}) {
  let state = options.start ?? pages.loginForm;
  let now = 0, reads = 0, submitted = false, interrupted = false, waitsSinceSubmit = 0;
  const navigation = [], fills = [], clicks = [], keys = [], searchActions = [], storage = {};
  const pageFunctions = {};
  const setState = next => { state = { ...state, ...next }; };
  const tools = runInNewContext(`(${source})`, {
    URL, Date: { now: () => now },
    pageInfo: async () => ({ url: state.url }),
    gotoUrl: async next => {
      navigation.push(next);
      if (options.navigationError) throw new Error("Navigation failed");
      if (next === searchEntry) state = { ...pages.search, url: options.searchUrl ?? searchEntry, onSite: false, challenge: options.searchChallenge ?? null, proxyError: !!options.searchProxyError };
      else if (next === accountUrl) state = options.accountPage?.(navigation.filter(u => u === accountUrl).length) ?? pages.account;
      else throw new Error(`unexpected navigation to ${next}`);
    },
    waitForLoad: async () => true,
    waitForElement: async selector => !options.missingSelector?.test(selector),
    accessibilitySnapshot: async () => ({ nodes: [
      ...(options.missingControls ? [] : [
        { role: "combobox", name: "Search with DuckDuckGo", backendNodeId: 1 },
        { role: "button", name: "Search", backendNodeId: 2 }
      ]),
      ...(state.loginButton && !options.missingLoginNode ? [{ role: "button", name: "Log in", backendNodeId: 3 }] : [])
    ] }),
    fillInput: async (target, value) => {
      if (typeof target === "object") { searchActions.push(["query", value]); return; }
      fills.push([target, value]);
      if (options.fillError) throw new Error("fill failed");
      setState({ emailMatches: options.fillMismatch ? false : value.toLowerCase() === (state.emailForm ? input.email : "") });
    },
    js: async (fn, args) => {
      if (args && typeof args.arg === "string") {
        pageFunctions.read = fn;
        reads++;
        if (submitted && options.readInterrupted && !interrupted) {
          interrupted = true;
          throw new Error("Execution context replaced");
        }
        return plain(state);
      }
      if (args && args.arg && typeof args.arg === "object") {
        pageFunctions.guard = fn;
        if (args.arg.release) { delete storage[args.arg.release]; return undefined; }
        const previous = storage[args.arg.key] ?? 0;
        if (previous && now - previous < args.arg.windowMs) return false;
        storage[args.arg.key] = now || 1;
        return true;
      }
      pageFunctions.target = fn;
      return options.approvedResult === false ? null : loginUrl;
    },
    click: async target => {
      if (typeof target === "object") {
        if (target.backendNodeId === 2) searchActions.push(["search"]);
        if (target.backendNodeId === 3) { clicks.push("log-in"); setState(options.loginOpens === false ? {} : { ...pages.loginForm }); }
        return;
      }
      if (target === '[data-webmcp-instacart-login="true"]') {
        searchActions.push(["result"]);
        state = options.landing ?? pages.loginForm;
        return;
      }
      clicks.push(target);
      if (target.startsWith("form:has(")) {
        assert.equal(submitted, false, "one submission maximum");
        submitted = true;
        if (options.clickInterrupted) throw new Error("Outcome uncertain");
        if (options.after) setState(options.after);
        return;
      }
      if (target.startsWith('input[name="code"]')) return;
      throw new Error(`unexpected click ${target}`);
    },
    pressKey: async key => {
      keys.push(key);
      submitted = true;
      setState({ codeLength: options.codeLengthAfterTyping ?? keys.length });
      if (keys.length === 6 && options.afterCode) setState(options.afterCode);
    },
    waitMs: async ms => {
      now += ms;
      if (!submitted) return;
      waitsSinceSubmit++;
      for (const [at, patch] of options.timeline ?? []) if (at === waitsSinceSubmit) setState(patch);
    }
  });
  return {
    tool: tools[0], navigation, fills, clicks, keys, searchActions, pageFunctions, storage,
    reads: () => reads,
    run: async (...args) => {
      submitted = false;
      interrupted = false;
      waitsSinceSubmit = 0;
      const before = clicks.filter(c => c.startsWith("form:has(")).length;
      const result = plain(await tools[0].execute(args.length ? args[0] : input));
      assert.ok(conforms(tools[0].tool.outputSchema, result), JSON.stringify(result));
      assert.ok(clicks.filter(c => c.startsWith("form:has(")).length - before <= 1, "must never retry submit");
      return result;
    }
  };
}

function failure(h, result, kind, submitted, stage) {
  assert.equal(result.logged_in, false);
  assert.equal(result.error_kind, kind, JSON.stringify(result));
  assert.ok(result.error_message.length > 0);
  assert.equal(result.submission_attempted, submitted);
  if (stage) assert.equal(result.stage, stage);
}

const submitClick = 'form:has(input[type="email"][name="email"]) button[type="submit"]';
const emailFill = ['input[type="email"][name="email"]', input.email];
const entryActions = [["query", "instacart login"], ["search"], ["result"]];

test("single expression, CDP kind, domain patterns, typed schemas and no trailing semicolon", () => {
  const { tool } = harness();
  assert.equal(tool.kind, "cdp");
  assert.equal(tool.tool.name, "login");
  assert.deepEqual(plain(tool.match.url_patterns), ["https://instacart.com/*", "https://*.instacart.com/*"]);
  assert.equal(tool.tool.inputSchema.type, "object");
  assert.deepEqual(plain(tool.tool.inputSchema.required), ["email"]);
  assert.equal(tool.tool.outputSchema.oneOf.length, 2);
  assert.equal(tool.tool.annotations.readOnlyHint, false);
  assert.equal(/;\s*$/.test(source), false);
  assert.ok(conforms(tool.tool.inputSchema, input));
  assert.ok(conforms(tool.tool.inputSchema, otpInput));
  assert.ok(conforms(tool.tool.inputSchema, { ...input, password: "unused" }));
});

test("registry entry matches the canonical definition", () => {
  const { tools } = JSON.parse(readFileSync(new URL("../registry.json", import.meta.url), "utf8"));
  const entries = tools.filter(t => t.domain === "instacart.com" && t.tool === "login");
  assert.equal(entries.length, 1);
  assert.equal(entries[0].namespace, "instacart.com");
  assert.equal(entries[0].file, "domains/instacart.com/login.js");
  assert.equal(entries[0].kind, "cdp");
  assert.deepEqual(entries[0].url_patterns, plain(harness().tool.match.url_patterns));
  assert.ok(["draft", "qa_passed", "verified", "broken"].includes(entries[0].status));
});

for (const invalid of [undefined, null, {}, [], { email: "not-an-email" }, { email: " " }, { email: 12 }, { otp: "123456" },
  { ...input, otp: "12" }, { ...input, otp: 123456 }, { ...input, otp: "12345a" }, { ...input, password: "" }, { ...input, password: 1 },
  { ...input, extra: true }, { email: `${"a".repeat(250)}@example.invalid` }]) {
  test(`invalid input is rejected before any page access: ${JSON.stringify(invalid)}`, async () => {
    const h = harness();
    if (invalid && typeof invalid === "object" && !Array.isArray(invalid)) assert.equal(conforms(h.tool.tool.inputSchema, invalid), false);
    failure(h, await h.run(invalid), "invalid_input", false, "input");
    assert.equal(h.reads(), 0);
    assert.deepEqual(h.navigation, []);
    assert.deepEqual(h.fills, []);
    assert.deepEqual(h.keys, []);
  });
}

for (const start of [pages.offSite, { ...base, url: "about:blank", path: "blank", onSite: false }, pages.home, pages.loginForm,
  { ...pages.home, url: "https://instacart.com/", path: "/" }, { ...pages.home, url: "https://shop.instacart.com/help", path: "/help" },
  { ...base, proxyError: true }]) {
  test(`enters through DuckDuckGo before filling from ${start.url}`, async () => {
    const h = harness({ start, after: { emailError: unknownEmail } });
    const result = await h.run();
    failure(h, result, "invalid_credentials", true, "after_submit");
    assert.equal(result.error_message, unknownEmail);
    assert.equal(result.error_source, "site");
    assert.deepEqual(h.navigation, [searchEntry]);
    assert.deepEqual(h.searchActions, entryActions);
    assert.deepEqual(h.fills, [emailFill]);
    assert.deepEqual(h.clicks, [submitClick]);
  });
}

test("a landing page without the form is opened through the site's Log in control", async () => {
  const h = harness({ start: pages.offSite, landing: pages.home, after: { emailError: unknownEmail } });
  failure(h, await h.run(), "invalid_credentials", true);
  assert.deepEqual(h.clicks, ["log-in", submitClick]);
  assert.deepEqual(h.fills, [emailFill]);
});

test("a landing page without form or Log in control never submits", async () => {
  const h = harness({ start: pages.offSite, landing: { ...pages.home, loginButton: false, accountButton: false } });
  const result = await h.run();
  assert.equal(result.error_kind, "unknown");
  assert.equal(result.stage, "site_entry");
  assert.deepEqual(h.fills, []);
  assert.deepEqual(h.clicks, []);
});

test("password is accepted but never typed anywhere", async () => {
  const h = harness({ after: { emailError: unknownEmail } });
  await h.run({ ...input, password: "never-typed-secret" });
  assert.deepEqual(h.fills, [emailFill]);
  assert.deepEqual(h.keys, []);
  assert.ok(!JSON.stringify(h.searchActions).includes("never-typed-secret"));
});

test("an already authenticated session is verified on the account page without navigating to search", async () => {
  const h = harness({ start: pages.loggedInHome });
  const result = await h.run();
  assert.equal(result.logged_in, true);
  assert.equal(result.authenticated, true);
  assert.equal(result.mfa_required, false);
  assert.equal(result.next_step, "none");
  assert.equal(result.submission_attempted, false);
  assert.equal(result.landing_url, accountUrl);
  assert.equal(result.account_name_or_hint, input.email);
  assert.deepEqual(h.navigation, [accountUrl]);
  assert.deepEqual(h.fills, []);
  assert.deepEqual(h.clicks, []);
});

test("an authenticated account page is confirmed in place", async () => {
  const h = harness({ start: pages.account });
  assert.equal((await h.run()).authenticated, true);
  assert.deepEqual(h.navigation, []);
});

test("a search-entry landing that is already logged in is verified without submitting", async () => {
  const h = harness({ start: pages.offSite, landing: pages.loggedInHome });
  const result = await h.run();
  assert.equal(result.authenticated, true);
  assert.equal(result.submission_attempted, false);
  assert.deepEqual(h.navigation, [searchEntry, accountUrl]);
  assert.deepEqual(h.fills, []);
});

test("a session for a different account fails without submitting and masks the address", async () => {
  const h = harness({ start: pages.loggedInHome, accountPage: () => ({ ...pages.account, accountEmail: "someone.else@example.invalid", accountMatches: false }) });
  const result = await h.run();
  failure(h, result, "unknown", false, "account_check");
  assert.match(result.error_message, /different account \(s\*\*\*@example\.invalid\)/);
  assert.ok(!result.error_message.includes("someone.else"));
  assert.deepEqual(h.fills, []);
});

test("an account page proxy error is retried once before failing", async () => {
  const h = harness({ start: pages.loggedInHome, accountPage: () => ({ ...base, url: accountUrl, path: "/store/account", proxyError: true }) });
  const result = await h.run();
  failure(h, result, "unknown", false, "account_check");
  assert.match(result.error_message, /proxy/);
  assert.deepEqual(h.navigation, [accountUrl, accountUrl]);
});

test("an account page that recovers on the retry succeeds", async () => {
  const h = harness({ start: pages.loggedInHome, accountPage: attempt => attempt === 1 ? { ...base, url: accountUrl, path: "/store/account", proxyError: true } : pages.account });
  assert.equal((await h.run()).authenticated, true);
  assert.deepEqual(h.navigation, [accountUrl, accountUrl]);
});

test("an account page that turns out to be logged out falls through to search entry", async () => {
  const h = harness({ start: pages.loggedInHome, accountPage: () => ({ ...pages.loginForm, url: `${loginUrl}?next=%2Fstore%2Faccount` }), after: { emailError: unknownEmail } });
  failure(h, await h.run(), "invalid_credentials", true);
  assert.deepEqual(h.navigation, [accountUrl, searchEntry]);
});

test("an open code step for the same address is reported as MFA without a new submission", async () => {
  const h = harness({ start: pages.codeStep });
  const result = await h.run();
  assert.equal(result.logged_in, true);
  assert.equal(result.authenticated, false);
  assert.equal(result.mfa_required, true);
  assert.equal(result.next_step, "enter_email_otp");
  assert.equal(result.submission_attempted, false);
  assert.equal(result.account_name_or_hint, pages.codeStep.codeHint);
  assert.deepEqual(h.navigation, []);
  assert.deepEqual(h.fills, []);
});

test("an open code step for another address is not reused", async () => {
  const h = harness({ start: { ...pages.codeStep, codeHint: "We sent a 6-digit code to other@example.invalid.", hintMatches: false } });
  const result = await h.run();
  failure(h, result, "unknown", false);
  assert.ok(!result.error_message.includes("other@example.invalid"));
  assert.deepEqual(h.navigation, []);
});

test("an accepted email returns the MFA first-step success", async () => {
  const h = harness({ readInterrupted: true, after: { emailForm: false, ...pages.codeStep } });
  const result = await h.run();
  assert.deepEqual(Object.keys(result).sort(), Array.from(h.tool.tool.outputSchema.oneOf[0].required).sort());
  assert.equal(result.logged_in, true);
  assert.equal(result.authenticated, false);
  assert.equal(result.mfa_required, true);
  assert.equal(result.next_step, "enter_email_otp");
  assert.equal(result.submission_attempted, true);
  assert.equal(conforms(h.tool.tool.outputSchema, { ...result, authenticated: true }), false);
  assert.deepEqual(h.clicks, [submitClick]);
});

test("a code step for another address after submission is reported, not entered", async () => {
  const h = harness({ after: { ...pages.codeStep, codeHint: "We sent a 6-digit code to other@example.invalid.", hintMatches: false } });
  failure(h, await h.run(), "unknown", true, "after_submit");
});

for (const scenario of [
  { name: "unknown email", after: { emailError: unknownEmail }, kind: "invalid_credentials", message: unknownEmail },
  { name: "throttled with attempts", after: { alerts: ["Too many attempts. 2 attempts remaining."] }, kind: "locked_or_throttled", remaining: 2 },
  { name: "challenge text", after: { challenge: "Verify you are human" }, kind: "captcha_or_challenge" },
  { name: "unresolved captcha frame", after: { captchaVisible: true }, kind: "captcha_or_challenge" },
  { name: "proxy error after submit", after: { proxyError: true }, kind: "unknown" },
  { name: "navigation off-site", after: pages.offSite, kind: "unknown" },
  { name: "click outcome uncertain", clickInterrupted: true, kind: "unknown" },
  { name: "no conclusive outcome", kind: "unknown" }
]) {
  test(`post-submit ${scenario.name} returns an explicit failure without retry`, async () => {
    const h = harness(scenario);
    const result = await h.run();
    failure(h, result, scenario.kind, true, "after_submit");
    assert.deepEqual(h.clicks, [submitClick]);
    if (scenario.message) assert.equal(result.error_message, scenario.message);
    assert.equal(result.attempts_remaining_if_shown, scenario.remaining ?? null);
  });
}

test("an already logged-in result after submission is verified on the account page", async () => {
  const h = harness({ after: { ...pages.loggedInHome } });
  const result = await h.run();
  assert.equal(result.authenticated, true);
  assert.equal(result.submission_attempted, true);
  assert.deepEqual(h.navigation, [searchEntry, accountUrl]);
});

for (const scenario of [
  { name: "existing challenge", landing: { ...pages.loginForm, challenge: "Access denied" }, kind: "captcha_or_challenge", stage: "site_entry" },
  { name: "existing lockout", landing: { ...pages.loginForm, alerts: ["Too many attempts, try again later"] }, kind: "locked_or_throttled", stage: "site_entry" },
  { name: "field did not receive the address", fillMismatch: true, kind: "unknown", stage: "before_submit" }
]) {
  test(`${scenario.name} prevents submission`, async () => {
    const h = harness(scenario);
    failure(h, await h.run(), scenario.kind, false, scenario.stage);
    assert.deepEqual(h.clicks, []);
  });
}

test("the sessionStorage guard blocks a second submission after an uncertain outcome", async () => {
  const h = harness();
  failure(h, await h.run(), "unknown", true);
  assert.ok(Object.keys(h.storage).length > 0);
  const second = plain(await h.tool.execute(input));
  failure(h, second, "unknown", false, "before_submit");
  assert.match(second.error_message, /already submitted/);
  assert.equal(h.clicks.filter(c => c === submitClick).length, 1);
});

test("a conclusive site rejection releases the guard for a corrected address", async () => {
  const h = harness({ after: { emailError: unknownEmail } });
  failure(h, await h.run(), "invalid_credentials", true);
  assert.deepEqual(Object.keys(h.storage), []);
  failure(h, await h.run(), "invalid_credentials", true);
  assert.equal(h.clicks.filter(c => c === submitClick).length, 2);
});

test("the MFA step keeps the guard so a re-invocation cannot request another code", async () => {
  const h = harness({ after: { emailForm: false, ...pages.codeStep } });
  assert.equal((await h.run()).mfa_required, true);
  assert.ok(Object.keys(h.storage).length > 0);
});

for (const scenario of [
  { name: "search controls unavailable", missingControls: true },
  { name: "proxy error page on the search engine", missingControls: true, searchProxyError: true, message: /proxy/ },
  { name: "unexpected search origin", searchUrl: "https://example.com/" },
  { name: "organic results unavailable", missingSelector: /result-title/ },
  { name: "first result is not www.instacart.com", approvedResult: false },
  { name: "landing proxy error", landing: { ...base, proxyError: true } },
  { name: "landing off-site", landing: pages.offSite },
  { name: "navigation failure", navigationError: true }
]) {
  test(`${scenario.name} never fills, submits, or falls back to direct navigation`, async () => {
    const h = harness({ start: pages.offSite, ...scenario });
    const result = await h.run();
    assert.equal(result.logged_in, false);
    assert.equal(result.submission_attempted, false);
    assert.ok(["search_entry", "site_entry", "before_submit"].includes(result.stage), result.stage);
    if (scenario.message) assert.match(result.error_message, scenario.message);
    assert.deepEqual(h.navigation, [searchEntry]);
    assert.deepEqual(h.fills, []);
    assert.deepEqual(h.clicks, []);
  });
}

test("a DuckDuckGo challenge is reported as a challenge before any site request", async () => {
  const h = harness({ start: pages.offSite, missingSelector: /result-title/, searchChallenge: "Unfortunately, bots use DuckDuckGo too." });
  const result = await h.run();
  failure(h, result, "captcha_or_challenge", false, "search_entry");
  assert.equal(result.error_source, "site");
  assert.match(result.error_message, /bots use DuckDuckGo/);
  assert.deepEqual(h.searchActions, [["query", "instacart login"], ["search"]]);
});

test("the first organic result is approved only for https www.instacart.com destinations", async () => {
  const h = harness({ start: pages.offSite, approvedResult: false });
  await h.run();
  for (const href of [loginUrl, "https://www.instacart.com/", "https://www.instacart.com/store?x=1",
    "https://www.instacart.com.evil.example/login", "https://evil.example/login", "http://www.instacart.com/login",
    "https://logistics.instacart.com/login", "https://www.instacart.ca/"]) {
    let marked = false;
    const link = { href, getClientRects: () => [{}], setAttribute: () => { marked = true; } };
    const approve = runInNewContext(`(${h.pageFunctions.target})`, {
      URL, location: { origin: "https://duckduckgo.com" },
      document: {
        querySelectorAll: selector => selector === '[data-testid="result"]' ? [{ closest: () => null, querySelector: () => link }] : [],
      }
    });
    const expected = /^https:\/\/www\.instacart\.com\//.test(href);
    assert.equal(approve() === href, expected, href);
    assert.equal(marked, expected, href);
  }
});

test("the first organic result skips advertisement results", async () => {
  const h = harness({ start: pages.offSite, approvedResult: false });
  await h.run();
  const organic = { href: loginUrl, getClientRects: () => [{}], setAttribute: () => {} };
  const ad = { href: "https://www.instacart.com/ad", getClientRects: () => [{}], setAttribute: () => {} };
  const approve = runInNewContext(`(${h.pageFunctions.target})`, {
    URL, location: { origin: "https://duckduckgo.com" },
    document: {
      querySelectorAll: selector => selector === '[data-testid="result"]'
        ? [{ closest: () => ({}), querySelector: () => ad }, { closest: () => null, querySelector: () => organic }]
        : []
    }
  });
  assert.equal(approve(), loginUrl);
});

test("otp mode types six digits into the code input and verifies the account", async () => {
  const h = harness({ start: pages.codeStep, afterCode: { ...pages.loggedInHome, codeStep: false, codeLength: null } });
  const result = await h.run(otpInput);
  assert.equal(result.logged_in, true);
  assert.equal(result.authenticated, true);
  assert.equal(result.submission_attempted, true);
  assert.deepEqual(h.keys, ["1", "2", "3", "4", "5", "6"]);
  assert.deepEqual(h.clicks, ['input[name="code"][autocomplete="one-time-code"]']);
  assert.deepEqual(h.navigation, [accountUrl]);
  assert.deepEqual(h.fills, []);
});

test("otp mode reports a rejected code as mfa_failed", async () => {
  const h = harness({ start: pages.codeStep, afterCode: { codeError: "Incorrect code. Please try again." } });
  const result = await h.run(otpInput);
  failure(h, result, "mfa_failed", true, "after_submit");
  assert.equal(result.error_message, "Incorrect code. Please try again.");
  assert.equal(result.error_source, "site");
});

test("otp mode without a visible code step enters nothing, even beside a stale site error", async () => {
  for (const start of [pages.loginForm, pages.loggedInHome, { ...pages.loginForm, emailError: unknownEmail }, { ...pages.home, alerts: ["Something went wrong"] }]) {
    const h = harness({ start });
    const result = await h.run(otpInput);
    failure(h, result, "unknown", false, "before_submit");
    assert.match(result.error_message, /No Verify email step/);
    assert.deepEqual(h.keys, []);
    assert.deepEqual(h.navigation, []);
  }
  for (const start of [pages.offSite, { ...pages.codeStep, proxyError: true }, { ...pages.codeStep, challenge: "Access denied" }]) {
    const h = harness({ start });
    const result = await h.run(otpInput);
    assert.equal(result.logged_in, false);
    assert.equal(result.submission_attempted, false);
    assert.deepEqual(h.keys, []);
  }
});

test("otp mode enters a corrected code beside a stale code error and judges only fresh feedback", async () => {
  const stale = { ...pages.codeStep, codeError: "Incorrect code. Please try again." };
  const unchanged = harness({ start: stale });
  const timedOut = await unchanged.run(otpInput);
  failure(unchanged, timedOut, "unknown", true, "after_submit");
  assert.equal(unchanged.keys.length, 6);
  assert.match(timedOut.error_message, /30 seconds/);
  const reappeared = harness({ start: stale, timeline: [[2, { codeError: null }], [4, { codeError: "Incorrect code. Please try again." }]] });
  failure(reappeared, await reappeared.run(otpInput), "mfa_failed", true, "after_submit");
  assert.equal(reappeared.keys.length, 6);
  const changed = harness({ start: stale, afterCode: { codeError: "This code has expired." } });
  const result = await changed.run(otpInput);
  failure(changed, result, "mfa_failed", true, "after_submit");
  assert.equal(result.error_message, "This code has expired.");
  const accepted = harness({ start: stale, afterCode: { ...pages.loggedInHome, codeStep: false, codeLength: null, codeError: null } });
  assert.equal((await accepted.run(otpInput)).authenticated, true);
});

test("otp mode refuses a code step for another address", async () => {
  const h = harness({ start: { ...pages.codeStep, codeHint: "We sent a 6-digit code to other@example.invalid.", hintMatches: false } });
  const result = await h.run(otpInput);
  failure(h, result, "unknown", false, "before_submit");
  assert.ok(!result.error_message.includes("other@example.invalid"));
  assert.deepEqual(h.keys, []);
});

test("otp mode reports a field that did not accept all digits", async () => {
  const h = harness({ start: pages.codeStep, codeLengthAfterTyping: 5 });
  failure(h, await h.run(otpInput), "unknown", true, "after_submit");
});

test("otp mode times out explicitly when nothing changes", async () => {
  const h = harness({ start: pages.codeStep });
  const result = await h.run(otpInput);
  failure(h, result, "unknown", true, "after_submit");
  assert.match(result.error_message, /30 seconds/);
});

test("otp mode guard blocks a second code entry within a minute", async () => {
  const h = harness({ start: pages.codeStep });
  await h.run(otpInput);
  const second = plain(await h.tool.execute(otpInput));
  failure(h, second, "unknown", false, "before_submit");
  assert.equal(h.keys.length, 6);
});

test("otp mode fails closed when the code step closes into a login form", async () => {
  const h = harness({ start: pages.codeStep, afterCode: { ...pages.loginForm, codeStep: false, codeLength: null }, accountPage: () => pages.loginForm });
  failure(h, await h.run(otpInput), "unknown", true);
});

test("a transient post-submit context error retries only the observation", async () => {
  const h = harness({ readInterrupted: true, after: { emailError: unknownEmail } });
  failure(h, await h.run(), "invalid_credentials", true);
  assert.deepEqual(h.clicks, [submitClick]);
});

test("an interaction failure before submission is reported as such", async () => {
  const h = harness({ fillError: true });
  const result = await h.run();
  failure(h, result, "unknown", false, "before_submit");
  assert.match(result.error_message, /before any submission/);
});

function element(text, extra = {}) {
  return {
    innerText: text, textContent: text, children: [], getAttribute: () => null,
    getClientRects: () => [{}], getBoundingClientRect: () => ({ width: 320, height: 40 }),
    checkVisibility: () => true, closest: () => null, ...extra
  };
}

function readFixture({ location = { href: loginUrl, pathname: "/login", protocol: "https:", hostname: "www.instacart.com" }, body = "", byId = {}, selectors = {} }) {
  const h = harness();
  return h.run().then(() => runInNewContext(`(${h.pageFunctions.read})`, {
    location,
    document: {
      body: element(body),
      querySelectorAll: selector => selectors[selector] ?? [],
      getElementById: id => byId[id] ?? null
    }
  })("qa@example.invalid"));
}

test("page reader extracts the login form, its aria error, and the Continue control", async () => {
  const error = element(unknownEmail);
  const form = { querySelectorAll: selector => selector === 'button[type="submit"]' ? [element("Continue", { disabled: false }), element("Sign up")] : [] };
  const attributes = { "aria-invalid": "true", "aria-errormessage": "err-1", "aria-describedby": null };
  const emailInput = element("", { value: " QA@example.invalid ", closest: () => form, getAttribute: name => attributes[name] ?? null });
  const state = await readFixture({
    body: "Sign up Log in Enter your email address Enter a valid email address. Continue",
    byId: { "err-1": error },
    selectors: { 'input[type="email"][name="email"]': [emailInput], "h1,h2,h3": [element("Log in")], "a,button": [element("Sign up"), element("Continue")] }
  });
  assert.equal(state.onSite, true);
  assert.equal(state.emailForm, true);
  assert.equal(state.emailMatches, true);
  assert.equal(state.emailError, unknownEmail);
  assert.equal(state.loginButton, false);
  assert.equal(state.accountButton, false);
  assert.equal(state.codeStep, false);
  assert.equal(state.proxyError, false);
});

test("page reader recognizes the Verify email step and its address hint", async () => {
  const hint = "We sent a 6-digit code to qa@example.invalid. It expires soon";
  const codeInput = element("", { value: "12", getAttribute: () => null });
  const state = await readFixture({
    body: `Verify email ${hint}`,
    selectors: { 'input[name="code"][autocomplete="one-time-code"]': [codeInput], "h1,h2,h3": [element("Verify email")], "p,div,span": [element(`Verify email ${hint} Request a new code in 0:15 seconds`), element("Verify email"), element(hint)] }
  });
  assert.equal(state.codeStep, true);
  assert.equal(state.codeLength, 2);
  assert.equal(state.codeHint, hint);
  assert.equal(state.hintMatches, true);
  assert.equal(state.emailForm, false);
});

test("page reader reads the account email only on the account page", async () => {
  const selectors = { "a,button": [element("Account"), element("Log out")], 'a[href="/accounts/logout"]': [element("Log out")] };
  const body = "Account settings Personal information qa@example.invalid Log out";
  const onAccount = await readFixture({ location: { href: accountUrl, pathname: "/store/account", protocol: "https:", hostname: "www.instacart.com" }, body, selectors });
  assert.equal(onAccount.accountEmail, "qa@example.invalid");
  assert.equal(onAccount.accountMatches, true);
  assert.equal(onAccount.accountButton, true);
  const elsewhere = await readFixture({ location: { href: "https://www.instacart.com/store/", pathname: "/store/", protocol: "https:", hostname: "www.instacart.com" }, body, selectors });
  assert.equal(elsewhere.accountEmail, null);
  assert.equal(elsewhere.accountButton, true);
});

test("page reader flags Kernel proxy error pages, challenge frames, and foreign hosts", async () => {
  const proxy = await readFixture({ body: "PROXY proxy error the upstream proxy provider timed out. error code upstream_timeout" });
  assert.equal(proxy.proxyError, true);
  const mitm = await readFixture({ body: "egress-proxy-mitm encountered an unexpected error unexpected EOF" });
  assert.equal(mitm.proxyError, true);
  const frame = element("", { src: "https://www.google.com/recaptcha/api2/bframe?k=x", getBoundingClientRect: () => ({ width: 400, height: 580 }) });
  const captcha = await readFixture({ body: "Log in", selectors: { iframe: [frame] } });
  assert.equal(captcha.captchaVisible, true);
  assert.equal(captcha.challenge, null);
  const foreign = await readFixture({ location: { href: "https://www.instacart.com.evil.example/login", pathname: "/login", protocol: "https:", hostname: "www.instacart.com.evil.example" } });
  assert.equal(foreign.onSite, false);
  const text = await readFixture({ body: "Please verify you are human to continue" });
  assert.equal(text.challenge, "verify you are human");
});
