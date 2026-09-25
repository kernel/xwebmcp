import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../domains/kroger.com/login.js", import.meta.url), "utf8");
const searchEntry = "https://start.duckduckgo.com/";
const loginUrl = "https://login.kroger.com/eciamp.onmicrosoft.com/b2c_1a__ciam_signin_signup/oauth2/v2.0/authorize?client_id=fixture";
const input = { email: "qa@example.invalid", password: "fabricated-test-password" };
const invalidCredentials = "Invalid email address";
const markerKey = "kroger.com.login.submission.v1";
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
  if (schema.anyOf && !schema.anyOf.some(s => conforms(s, value))) return false;
  if (schema.not && conforms(schema.not, value)) return false;
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    if (schema.required?.some(key => !Object.hasOwn(value, key))) return false;
    if (schema.properties) {
      if (Object.entries(schema.properties).some(([key, s]) => key in value && !conforms(s, value[key]))) return false;
      if (schema.additionalProperties === false && Object.keys(value).some(key => !(key in schema.properties))) return false;
    }
  }
  if (typeof value === "string") {
    if (value.length < (schema.minLength ?? 0) || value.length > (schema.maxLength ?? Infinity)) return false;
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) return false;
    if (schema.format === "uri" && !URL.canParse(value)) return false;
  }
  if (typeof value === "number" && value < (schema.minimum ?? -Infinity)) return false;
  return true;
}

const pages = {
  loginForm: { url: loginUrl, host: "login.kroger.com", formVisible: true, submitEnabled: true, welcomeText: null, loggedInCookie: false },
  homeLoggedOut: { url: "https://www.kroger.com/", host: "www.kroger.com", formVisible: false, submitEnabled: false, welcomeText: "Sign In", loggedInCookie: false },
  homeLoggedIn: { url: "https://www.kroger.com/", host: "www.kroger.com", formVisible: false, submitEnabled: false, welcomeText: "PAT", loggedInCookie: true },
  product: { url: "https://www.kroger.com/p/milk/0001", host: "www.kroger.com", formVisible: false, submitEnabled: false, welcomeText: "Sign In", loggedInCookie: false },
  connectAuth: { url: "https://www.kroger.com/connect-auth#code=fixture", host: "www.kroger.com", formVisible: false, submitEnabled: false, welcomeText: null, loggedInCookie: false },
  offsite: { url: "https://example.com/", host: "example.com", formVisible: false, submitEnabled: false, welcomeText: null, loggedInCookie: false },
  blank: { url: "about:blank", host: "", formVisible: false, submitEnabled: false, welcomeText: null, loggedInCookie: false },
  duckduckgo: { url: "https://duckduckgo.com/?q=kroger+login", host: "duckduckgo.com", formVisible: false, submitEnabled: false, welcomeText: null, loggedInCookie: false }
};

function page(name, extra = {}) {
  const base = pages[name];
  return {
    ...base,
    onSite: base.host === "kroger.com" || base.host.endsWith(".kroger.com"),
    loginHost: base.host === "login.kroger.com",
    emailValue: "", passwordLength: 0,
    errors: [], challenge: null, codeStep: false, codeHint: null,
    ...extra
  };
}

function harness(options = {}) {
  let clock = 0, reads = 0, submitted = false, submitTime = null, readFailures = 0;
  let state = page(options.start ?? "loginForm", options.initial);
  const storage = new Map(options.storage ?? []);
  const calls = { navigations: [], fills: [], clicks: [], searchActions: [], keep: [] };
  const token = email => `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify({ emailAddress: email, sub: "fixture" })).toString("base64url")}.sig`;
  const timeline = [...(options.timeline ?? [{ at: 500, state: options.after ?? { errors: [invalidCredentials] } }])];
  const prelude = [...(options.prelude ?? [])];
  const apply = next => { state = { ...state, ...next }; };
  const advance = ms => {
    clock += ms;
    while (prelude.length && clock >= prelude[0].at) apply(prelude.shift().state);
    if (submitTime === null) return;
    while (timeline.length && clock - submitTime >= timeline[0].at) apply(timeline.shift().state);
  };
  const button = { disabled: options.submitDisabled ?? false, getAttribute: () => null, getClientRects: () => [1] };
  const pageContext = () => ({
    JSON, Date: { now: () => clock },
    location: { hostname: state.host, origin: `https://${state.host}` },
    sessionStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    document: { querySelector: () => (options.missingButton ? null : button) }
  });
  const searchDom = () => {
    const result = options.searchResult ?? { href: "https://www.kroger.com/signin" };
    const link = {
      href: result.href, marked: false,
      closest: () => (result.ad ? {} : null),
      setAttribute: () => { link.marked = true; }
    };
    return {
      URL, location: { origin: options.searchOrigin ?? "https://duckduckgo.com" },
      document: {
        body: { innerText: options.searchBlocked ? "Unfortunately, bots use DuckDuckGo too. Please verify you are human." : "Kroger login results" },
        querySelectorAll: () => [],
        querySelector: () => (result.missing ? null : link)
      }
    };
  };
  const context = {
    URL, Buffer, Date: { now: () => clock },
    cdp: async method => {
      assert.equal(method, "Network.getCookies");
      const cookies = state.loggedInCookie ? [{ name: "loggedIn", value: "yes" }] : [];
      if (options.accountEmail) cookies.push({ name: "kroger-si-customer-data-token", value: token(options.accountEmail) });
      if (options.malformedToken) cookies.push({ name: "kroger-si-customer-data-token", value: "not.a-jwt" });
      return { cookies };
    },
    js: async (fn, args) => {
      const text = fn.toString();
      if (text.includes("formVisible:")) {
        reads++;
        if (submitted && options.readFailures && readFailures < options.readFailures) { readFailures++; throw new Error("Execution context replaced"); }
        return plain(state);
      }
      if (text.includes('"concluded"')) return runInNewContext(`(${fn})(${JSON.stringify(args.arg)})`, pageContext());
      if (text.includes('"already_attempted"')) return runInNewContext(`(${fn})(${JSON.stringify(args.arg)})`, pageContext());
      if (text.includes("data-kroger-login-entry")) return runInNewContext(`(${fn})()`, searchDom());
      if (text.includes("#kr_remember_me_adi_true")) { calls.keep.push(args.arg); return options.prepared ?? true; }
      if (text.includes("welcome.click()")) return options.headerOpens ?? state.welcomeText === "Sign In";
      if (text.includes("#welcome-menu-sign-in-out-button")) {
        if (options.signInControlMissing) return false;
        apply(page("loginForm", options.afterHeader));
        return true;
      }
      if (text.includes("data-kroger-login-code-submit")) return options.pasted ?? true;
      throw new Error(`unexpected page function: ${text.slice(0, 80)}`);
    },
    gotoUrl: async url => {
      calls.navigations.push(url);
      if (options.navigationError) throw new Error("Navigation failed");
      clock += options.navigationDelay ?? 0;
      apply(page("duckduckgo"));
    },
    accessibilitySnapshot: async () => ({ nodes: options.missingControls ? [] : [
      { role: "combobox", name: "Search with DuckDuckGo", backendNodeId: 1 },
      { role: "button", name: "Search", backendNodeId: 2 }
    ] }),
    waitForElement: async () => options.resultsListed ?? true,
    fillInput: async (target, value) => {
      if (typeof target === "object") { calls.searchActions.push(["query", value]); return; }
      calls.fills.push(target);
      if (target.includes("signInName")) apply({ emailValue: options.fillMismatch ? "other@example.invalid" : value.toLowerCase() });
      else apply({ passwordLength: value.length });
    },
    click: async target => {
      if (typeof target === "object") { calls.searchActions.push(["search"]); return; }
      calls.clicks.push(target);
      if (target === 'a[data-kroger-login-entry="true"]') {
        calls.searchActions.push(["result"]);
        apply(page(options.landing ?? "loginForm", options.landingState));
        return;
      }
      assert.equal(submitted, false, "one submission maximum");
      submitted = true;
      submitTime = clock;
      if (options.clickError) throw new Error("Click outcome unknown");
    },
    waitMs: async ms => advance(ms)
  };
  const definitions = runInNewContext(`(${source})`, context);
  return {
    definitions, calls, storage,
    reads: () => reads,
    submits: () => calls.clicks.filter(c => c === "button#continue" || c === "[data-kroger-login-code-submit]").length,
    run: async (...args) => {
      const result = plain(await definitions[0].execute(args.length ? args[0] : input));
      assert.ok(conforms(definitions[0].tool.outputSchema, result), JSON.stringify(result));
      return result;
    }
  };
}

const untouched = h => {
  assert.deepEqual(h.calls.navigations, []);
  assert.deepEqual(h.calls.fills, []);
  assert.deepEqual(h.calls.clicks, []);
};

test("single-expression CDP tool declares domain patterns and typed schemas", () => {
  assert.equal(source.trimEnd().endsWith(";"), false);
  const [definition] = harness().definitions;
  assert.equal(definition.kind, "cdp");
  assert.equal(definition.tool.name, "login");
  assert.deepEqual(plain(definition.match.url_patterns), ["https://kroger.com/*", "https://*.kroger.com/*"]);
  assert.equal(definition.tool.inputSchema.type, "object");
  assert.equal(definition.tool.outputSchema.oneOf.length, 2);
  assert.equal(definition.tool.annotations.readOnlyHint, false);
  assert.ok(conforms(definition.tool.inputSchema, input));
  assert.ok(conforms(definition.tool.inputSchema, { email: input.email, otp: "123456" }));
  assert.ok(conforms(definition.tool.inputSchema, { ...input, keep_signed_in: false }));
});

test("registry entry matches the canonical definition", () => {
  const registry = JSON.parse(readFileSync(new URL("../registry.json", import.meta.url), "utf8"));
  const entries = registry.tools.filter(t => t.domain === "kroger.com" && t.tool === "login");
  assert.equal(entries.length, 1);
  assert.equal(entries[0].namespace, "kroger.com");
  assert.equal(entries[0].file, "domains/kroger.com/login.js");
  assert.equal(entries[0].kind, "cdp");
  assert.deepEqual(entries[0].url_patterns, plain(harness().definitions[0].match.url_patterns));
});

for (const args of [undefined, null, [], {}, { email: input.email }, { password: input.password }, { ...input, email: "not-an-email" }, { ...input, email: "a@b" },
  { ...input, password: "" }, { ...input, password: 7 }, { ...input, otp: "123456" }, { email: input.email, otp: "12ab" }, { email: input.email, otp: 123456 },
  { ...input, keep_signed_in: "yes" }, { ...input, extra: true }]) {
  test(`invalid input is rejected before any page access: ${JSON.stringify(args)}`, async () => {
    const h = harness();
    if (args && typeof args === "object" && !Array.isArray(args)) assert.equal(conforms(h.definitions[0].tool.inputSchema, args), false);
    const result = await h.run(args);
    assert.equal(result.error_kind, "invalid_input");
    assert.equal(result.step, "input");
    assert.equal(result.entry_path, "none");
    assert.equal(result.submission_attempted, false);
    assert.equal(h.reads(), 0);
    untouched(h);
  });
}

test("an open login form is filled and submitted exactly once", async () => {
  const h = harness();
  const result = await h.run();
  assert.equal(result.error_kind, "invalid_credentials");
  assert.equal(result.error_message, invalidCredentials);
  assert.equal(result.error_source, "site");
  assert.equal(result.step, "after_submit");
  assert.equal(result.entry_path, "already_open");
  assert.equal(result.submission_attempted, true);
  assert.equal(result.attempts_remaining_if_shown, null);
  assert.deepEqual(h.calls.navigations, []);
  assert.deepEqual(h.calls.fills, ["input#signInName", "input#password[type=password]"]);
  assert.equal(h.submits(), 1);
  assert.deepEqual(h.calls.keep, [true]);
  assert.equal(JSON.parse(h.storage.get(markerKey)).state, "concluded");
});

test("keep_signed_in false is applied before submission", async () => {
  const h = harness();
  await h.run({ ...input, keep_signed_in: false });
  assert.deepEqual(h.calls.keep, [false]);
  assert.equal(h.submits(), 1);
});

for (const start of ["offsite", "blank", "homeLoggedOut", "product", "connectAuth", "duckduckgo"]) {
  test(`unsuitable page enters through the search engine: ${start}`, async () => {
    const h = harness({ start });
    const result = await h.run();
    assert.equal(result.error_kind, "invalid_credentials");
    assert.equal(result.entry_path, "search_referrer");
    assert.deepEqual(h.calls.navigations, [searchEntry]);
    assert.deepEqual(h.calls.searchActions, [["query", "kroger login"], ["search"], ["result"]]);
    assert.equal(h.submits(), 1);
  });
}

test("a signed-in session returns success without navigating or submitting", async () => {
  const h = harness({ start: "homeLoggedIn" });
  const result = await h.run();
  assert.equal(result.logged_in, true);
  assert.equal(result.authenticated, true);
  assert.equal(result.mfa_required, false);
  assert.equal(result.next_step, "none");
  assert.equal(result.entry_path, "already_signed_in");
  assert.equal(result.account_name_or_hint, "PAT");
  assert.equal(result.account_check, "unverified");
  assert.equal(result.submission_attempted, false);
  untouched(h);
});

test("a customer data token naming the supplied email confirms the account", async () => {
  const h = harness({ start: "homeLoggedIn", accountEmail: "QA@Example.invalid" });
  const result = await h.run({ email: "qa@example.invalid", password: input.password });
  assert.equal(result.account_check, "email_confirmed");
  assert.equal(result.authenticated, true);
  untouched(h);
});

test("a malformed customer data token leaves the account unverified", async () => {
  const h = harness({ start: "homeLoggedIn", malformedToken: true });
  const result = await h.run();
  assert.equal(result.authenticated, true);
  assert.equal(result.account_check, "unverified");
});

test("a session belonging to a different account is not reported as success", async () => {
  const h = harness({ start: "homeLoggedIn", accountEmail: "someone-else@example.invalid" });
  const result = await h.run();
  assert.equal(result.logged_in, false);
  assert.equal(result.error_kind, "unknown");
  assert.equal(result.step, "account_check");
  assert.equal(result.entry_path, "already_signed_in");
  assert.equal(result.submission_attempted, false);
  untouched(h);
});

test("a signed-in cookie without a rendered name is not treated as signed in", async () => {
  const h = harness({ start: "homeLoggedIn", initial: { welcomeText: "Sign In" } });
  assert.equal((await h.run()).error_kind, "invalid_credentials");
  assert.deepEqual(h.calls.navigations, [searchEntry]);
});

test("a signed-in cookie waits for the header to render before re-entering the site", async () => {
  const h = harness({ start: "homeLoggedIn", initial: { welcomeText: null }, prelude: [{ at: 3000, state: { welcomeText: "PAT" } }] });
  const result = await h.run();
  assert.equal(result.entry_path, "already_signed_in");
  assert.equal(result.submission_attempted, false);
  untouched(h);
});

test("a non-sign-in organic result opens sign-in from the site header", async () => {
  const h = harness({ start: "offsite", landing: "homeLoggedOut" });
  const result = await h.run();
  assert.equal(result.error_kind, "invalid_credentials");
  assert.equal(result.entry_path, "site_navigation");
  assert.deepEqual(h.calls.searchActions, [["query", "kroger login"], ["search"], ["result"]]);
  assert.equal(h.submits(), 1);
});

test("a landing page that is already signed in succeeds without submitting", async () => {
  const h = harness({ start: "offsite", landing: "homeLoggedIn" });
  const result = await h.run();
  assert.equal(result.authenticated, true);
  assert.equal(result.entry_path, "search_referrer");
  assert.equal(h.submits(), 0);
});

for (const [name, options, kind] of [
  ["search controls unavailable", { missingControls: true }, "unknown"],
  ["navigation failure", { navigationError: true }, "unknown"],
  ["search origin unexpected", { searchOrigin: "https://example.com" }, "unknown"],
  ["search engine challenge", { searchBlocked: true }, "captcha_or_challenge"],
  ["organic result missing", { searchResult: { missing: true } }, "unknown"],
  ["organic results not listed", { resultsListed: false }, "unknown"],
  ["first result is an ad", { searchResult: { href: "https://www.kroger.com/signin", ad: true } }, "unknown"],
  ["first result is another host", { searchResult: { href: "https://www.instacart.com/kroger" } }, "unknown"],
  ["first result is a lookalike host", { searchResult: { href: "https://kroger.com.example/signin" } }, "unknown"],
  ["first result is not https", { searchResult: { href: "http://www.kroger.com/signin" } }, "unknown"],
  ["landing never becomes usable", { landing: "offsite" }, "unknown"],
  ["landing shows a challenge", { landing: "loginForm", landingState: { challenge: "Access Denied" } }, "captcha_or_challenge"],
  ["header sign-in control missing", { landing: "homeLoggedOut", signInControlMissing: true }, "unknown"],
  ["header welcome control missing", { landing: "homeLoggedOut", headerOpens: false }, "unknown"]
]) {
  test(`entry failure never fills or submits: ${name}`, async () => {
    const h = harness({ start: "offsite", ...options });
    const result = await h.run();
    assert.equal(result.error_kind, kind);
    assert.equal(result.submission_attempted, false);
    assert.deepEqual(h.calls.fills, []);
    assert.equal(h.submits(), 0);
    assert.ok(["search_entry", "site_entry", "login_form"].includes(result.step), result.step);
  });
}

test("subdomain hosts of kroger.com are accepted as organic results", async () => {
  const h = harness({ start: "offsite", searchResult: { href: "https://login.kroger.com/anything" } });
  assert.equal((await h.run()).error_kind, "invalid_credentials");
});

for (const [text, kind, remaining] of [
  ["Too many sign-in attempts. Please try again later.", "locked_or_throttled", null],
  ["Your account is locked. 2 attempts remaining", "locked_or_throttled", 2],
  ["Please complete the CAPTCHA", "captcha_or_challenge", null]
]) {
  test(`pre-existing ${kind} stops before filling`, async () => {
    const h = harness({ initial: { errors: [text] } });
    const result = await h.run();
    assert.equal(result.error_kind, kind);
    assert.equal(result.error_source, "site");
    assert.equal(result.attempts_remaining_if_shown, remaining);
    assert.equal(result.submission_attempted, false);
    assert.deepEqual(h.calls.fills, []);
  });
  test(`post-submit ${kind} is reported without retry`, async () => {
    const h = harness({ after: { errors: [text] } });
    const result = await h.run();
    assert.equal(result.error_kind, kind);
    assert.equal(result.attempts_remaining_if_shown, remaining);
    assert.equal(h.submits(), 1);
  });
}

test("a visible challenge before submission stops the flow", async () => {
  const h = harness({ initial: { challenge: "Verify you are human" } });
  const result = await h.run();
  assert.equal(result.error_kind, "captcha_or_challenge");
  assert.equal(h.submits(), 0);
  assert.deepEqual(h.calls.fills, []);
});

test("credentials that did not reach the form are never submitted", async () => {
  const h = harness({ fillMismatch: true });
  const result = await h.run();
  assert.equal(result.error_kind, "unknown");
  assert.equal(result.step, "before_submit");
  assert.equal(h.submits(), 0);
});

test("a disabled submit control is not clicked", async () => {
  const h = harness({ initial: { submitEnabled: false } });
  const result = await h.run();
  assert.equal(result.error_kind, "unknown");
  assert.equal(result.submission_attempted, false);
  assert.equal(h.submits(), 0);
});

test("a pending marker from the same tab blocks a second submission", async () => {
  const h = harness({ storage: [[markerKey, JSON.stringify({ state: "pending", at: 0 })]] });
  const result = await h.run();
  assert.equal(result.error_kind, "unknown");
  assert.match(result.error_message, /already submitted/);
  assert.equal(result.submission_attempted, false);
  assert.equal(h.submits(), 0);
});

for (const marker of [{ state: "concluded", at: 0 }, { state: "pending", at: -16 * 60 * 1000 }]) {
  test(`a marker that no longer blocks allows one submission: ${marker.state}`, async () => {
    const h = harness({ storage: [[markerKey, JSON.stringify(marker)]] });
    assert.equal((await h.run()).error_kind, "invalid_credentials");
    assert.equal(h.submits(), 1);
  });
}

test("a slow entry that leaves too little budget to observe does not submit", async () => {
  const h = harness({ start: "offsite", navigationDelay: 95000 });
  const result = await h.run();
  assert.equal(result.error_kind, "unknown");
  assert.match(result.error_message, /not enough to observe/);
  assert.equal(result.step, "before_submit");
  assert.equal(result.submission_attempted, false);
  assert.equal(h.submits(), 0);
});

test("the observation window shrinks to the remaining budget", async () => {
  const h = harness({ start: "offsite", navigationDelay: 80000, timeline: [] });
  const result = await h.run();
  assert.equal(result.error_kind, "unknown");
  assert.match(result.error_message, /within (?:2\d|30) seconds/);
  assert.equal(h.submits(), 1);
});

test("entry waits are bounded by the remaining budget", async () => {
  const h = harness({ start: "offsite", navigationDelay: 105000, missingControls: true });
  const result = await h.run();
  assert.equal(result.error_kind, "unknown");
  assert.equal(result.step, "search_entry");
  assert.equal(h.submits(), 0);
});

test("an uncertain click leaves the marker pending and is never retried", async () => {
  const h = harness({ clickError: true });
  const result = await h.run();
  assert.equal(result.error_kind, "unknown");
  assert.equal(result.submission_attempted, true);
  assert.equal(h.submits(), 1);
  assert.equal(JSON.parse(h.storage.get(markerKey)).state, "pending");
});

test("authenticated success after the post-login redirect", async () => {
  const h = harness({ timeline: [{ at: 500, state: page("connectAuth") }, { at: 3000, state: page("homeLoggedIn") }], readFailures: 2, accountEmail: input.email });
  const result = await h.run();
  assert.equal(result.logged_in, true);
  assert.equal(result.authenticated, true);
  assert.equal(result.account_check, "email_confirmed");
  assert.equal(result.entry_path, "already_open");
  assert.equal(result.submission_attempted, true);
  assert.equal(result.landing_url, "https://www.kroger.com/");
  assert.equal(h.submits(), 1);
});

test("a verification-code step is a first-step success that is not authenticated", async () => {
  const h = harness({ after: { formVisible: false, codeStep: true, codeHint: "We sent a code to q***@example.invalid" } });
  const result = await h.run();
  assert.equal(result.logged_in, true);
  assert.equal(result.authenticated, false);
  assert.equal(result.mfa_required, true);
  assert.equal(result.next_step, "enter_otp");
  assert.equal(result.account_name_or_hint, "We sent a code to q***@example.invalid");
  assert.equal(conforms(h.definitions[0].tool.outputSchema, { ...result, authenticated: true }), false);
  assert.equal(JSON.parse(h.storage.get(markerKey)).state, "concluded");
});

test("a challenge that never resolves is reported after the observation window", async () => {
  const h = harness({ after: { challenge: "Visible challenge frame: captcha" } });
  const result = await h.run();
  assert.equal(result.error_kind, "captcha_or_challenge");
  assert.equal(result.step, "after_submit");
  assert.equal(h.submits(), 1);
});

test("a challenge that resolves into a session is success", async () => {
  const h = harness({ timeline: [{ at: 500, state: { challenge: "Visible challenge frame: captcha" } }, { at: 20000, state: page("homeLoggedIn") }] });
  assert.equal((await h.run()).authenticated, true);
});

test("a submission that lands in a different account is not success", async () => {
  const h = harness({ after: page("homeLoggedIn"), accountEmail: "someone-else@example.invalid" });
  const result = await h.run();
  assert.equal(result.logged_in, false);
  assert.equal(result.step, "account_check");
  assert.equal(result.submission_attempted, true);
});

test("leaving kroger.com after submission is an unknown outcome", async () => {
  const h = harness({ after: page("offsite") });
  const result = await h.run();
  assert.equal(result.error_kind, "unknown");
  assert.equal(result.submission_attempted, true);
});

test("no result within the window is an explicit unknown", async () => {
  const h = harness({ timeline: [] });
  const result = await h.run();
  assert.equal(result.error_kind, "unknown");
  assert.match(result.error_message, /No conclusive sign-in result/);
});

test("an unchanged stale error is not judged as a new rejection", async () => {
  const h = harness({ initial: { errors: [invalidCredentials] }, timeline: [] });
  const result = await h.run();
  assert.equal(result.error_kind, "unknown");
  assert.match(result.error_message, /No conclusive sign-in result/);
  assert.equal(h.submits(), 1);
});

test("a stale error that clears and reappears is a fresh rejection", async () => {
  const h = harness({ initial: { errors: [invalidCredentials] }, timeline: [{ at: 500, state: { errors: [] } }, { at: 2000, state: { errors: [invalidCredentials] } }] });
  assert.equal((await h.run()).error_kind, "invalid_credentials");
});

test("otp mode without a visible code step submits nothing", async () => {
  const h = harness();
  const result = await h.run({ email: input.email, otp: "123456" });
  assert.equal(result.error_kind, "unknown");
  assert.equal(result.submission_attempted, false);
  untouched(h);
});

test("otp mode submits the code once and reports a wrong code as mfa_failed", async () => {
  const h = harness({ initial: { formVisible: false, codeStep: true }, after: { errors: ["The verification code is incorrect."] } });
  const result = await h.run({ email: input.email, otp: "123456" });
  assert.equal(result.error_kind, "mfa_failed");
  assert.deepEqual(h.calls.clicks, ["[data-kroger-login-code-submit]"]);
  assert.deepEqual(h.calls.fills, []);
});

test("otp mode completing the session is authenticated success", async () => {
  const h = harness({ initial: { formVisible: false, codeStep: true }, after: page("homeLoggedIn") });
  const result = await h.run({ email: input.email, otp: "123456" });
  assert.equal(result.authenticated, true);
  assert.equal(result.submission_attempted, true);
});

test("otp mode on a signed-in session succeeds without submitting", async () => {
  const h = harness({ start: "homeLoggedIn" });
  assert.equal((await h.run({ email: input.email, otp: "123456" })).authenticated, true);
  untouched(h);
});

test("otp mode never submits when the code field is unusable", async () => {
  const h = harness({ initial: { formVisible: false, codeStep: true }, pasted: false });
  const result = await h.run({ email: input.email, otp: "123456" });
  assert.equal(result.error_kind, "unknown");
  assert.equal(h.submits(), 0);
});
