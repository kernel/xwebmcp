import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../domains/jetblue.com/login.js", import.meta.url), "utf8");
const entry = "https://www.jetblue.com/signin?useIdx=true&returnUrl=https%3A%2F%2Fwww.jetblue.com%2F";
const input = { username: "qa@example.invalid", password: "fabricated-test-password" };
const plain = value => JSON.parse(JSON.stringify(value));
const initial = {
  origin: "https://www.jetblue.com", path: "/signin", url: "https://www.jetblue.com/signin",
  errors: [], hasForm: true, fieldsReady: true, submitReady: true,
  remember: false, challenge: null, mfa: null, account: null
};

function harness(options = {}) {
  let state = { ...initial, ...options.initial };
  let now = 0, reads = 0, submitted = false, readExpression;
  const navigation = [], fills = [], clicks = [], lengthChecks = [];
  const tools = runInNewContext(`(${source})`, {
    URL, Date: { now: () => now },
    pageInfo: async () => ({ url: options.url ?? entry }),
    gotoUrl: async url => { navigation.push(url); state = { ...initial, ...options.navigationState }; },
    waitForElement: async () => true,
    fillInput: async selector => { fills.push(selector); },
    js: async (expression, args) => {
      if (typeof expression === "function") {
        lengthChecks.push(args.arg);
        return options.lengthOK ?? true;
      }
      readExpression = expression;
      reads++;
      if (submitted && options.readInterrupted && reads === 3) throw new Error("Execution context replaced");
      return state;
    },
    click: async selector => {
      clicks.push(selector);
      if (selector === 'input[type="submit"]') {
        assert.equal(submitted, false, "one submission maximum");
        submitted = true;
        if (options.clickInterrupted) throw new Error("Outcome uncertain");
        state = { ...state, ...options.after };
      }
    },
    waitMs: async ms => { now += ms; }
  });
  return { tool: tools[0], navigation, fills, clicks, lengthChecks,
    reads: () => reads, readExpression: () => readExpression };
}

function failure(h, result, kind, submitted) {
  const branch = h.tool.tool.outputSchema.oneOf[1];
  assert.deepEqual(Object.keys(result).sort(), Array.from(branch.required).sort());
  assert.equal(result.logged_in, false);
  assert.equal(result.error_kind, kind);
  assert.ok(branch.properties.error_kind.enum.includes(kind));
  assert.equal(typeof result.error_message, "string");
  assert.ok(result.error_message.length > 0);
  assert.ok(["site", "tool"].includes(result.message_source));
  assert.ok(result.attempts_remaining_if_shown === null || Number.isInteger(result.attempts_remaining_if_shown));
  assert.equal(result.submission_attempted, submitted);
}

test("single expression, CDP kind, domain patterns and dual typed schemas", () => {
  const { tool } = harness();
  assert.equal(tool.kind, "cdp");
  assert.equal(tool.tool.name, "login");
  assert.equal(tool.tool.inputSchema.type, "object");
  assert.equal(tool.tool.outputSchema.type, "object");
  assert.equal(tool.tool.outputSchema.oneOf.length, 2);
  assert.deepEqual(plain(tool.match.url_patterns), ["https://jetblue.com/*", "https://*.jetblue.com/*"]);
});

for (const url of ["about:blank", "https://example.com/", "https://jetblue.com/", "https://help.jetblue.com/", "https://www.jetblue.com/travel-agents", "https://www.jetblue.com/signin/other"]) {
  test(`navigates to the login entry before reading or filling from ${url}`, async () => {
    const h = harness({ url, after: { errors: ["Unable to sign in"] } });
    failure(h, await h.tool.execute(input), "invalid_credentials", true);
    assert.deepEqual(h.navigation, [entry]);
    assert.equal(h.fills.length, 2);
    assert.deepEqual(h.lengthChecks, [input.password.length]);
    assert.deepEqual(h.clicks, ['input[type="submit"]']);
  });
}

for (const invalid of [undefined, {}, [], { username: "qa" }, { password: "synthetic" }, { ...input, password: "" }, { ...input, username: " " }, { ...input, remember_me: "yes" }, { ...input, use_filled_form: "yes" }, { ...input, otp: "123456" }, { ...input, use_filled_form: true }]) {
  test(`invalid input rejected without page access: ${JSON.stringify(invalid)}`, async () => {
    const h = harness();
    failure(h, await h.tool.execute(invalid), "validation_error", false);
    assert.equal(h.reads(), 0);
    assert.deepEqual(h.navigation, []);
    assert.deepEqual(h.clicks, []);
  });
}

for (const scenario of [
  { name: "invalid credentials", after: { errors: ["Unable to sign in"] }, kind: "invalid_credentials" },
  { name: "lockout", after: { errors: ["Account locked. 0 attempts remaining"] }, kind: "locked_or_throttled", remaining: 0 },
  { name: "MFA failure", after: { errors: ["The verification code is incorrect."] }, kind: "mfa_failed" },
  { name: "session expiry", after: { errors: ["You have been logged out due to inactivity. Refresh or return to the sign in screen."] }, kind: "unknown" },
  { name: "challenge", after: { challenge: "Verify you are human" }, kind: "captcha_or_challenge" },
  { name: "navigation to another origin", after: { origin: "https://example.com" }, kind: "unknown" },
  { name: "click outcome uncertain", clickInterrupted: true, kind: "unknown" },
  { name: "no conclusive outcome", kind: "unknown" }
]) {
  test(scenario.name, async () => {
    const h = harness(scenario);
    const result = await h.tool.execute(input);
    failure(h, result, scenario.kind, true);
    assert.deepEqual(h.clicks, ['input[type="submit"]']);
    if (scenario.after?.errors) assert.equal(result.error_message, scenario.after.errors[0]);
    if (scenario.remaining !== undefined) assert.equal(result.attempts_remaining_if_shown, scenario.remaining);
  });
}

for (const scenario of [
  { name: "blank password after fill", initial: { fieldsReady: false }, kind: "validation_error" },
  { name: "password length mismatch", lengthOK: false, kind: "validation_error" },
  { name: "existing challenge", initial: { challenge: "Verify you are human" }, kind: "captcha_or_challenge" },
  { name: "existing lockout", initial: { errors: ["Too many attempts"] }, kind: "locked_or_throttled" },
  { name: "existing expired flow", initial: { errors: ["You have been logged out due to inactivity."] }, kind: "unknown" },
  { name: "missing form", initial: { hasForm: false }, kind: "unknown" }
]) {
  test(`${scenario.name} prevents submission`, async () => {
    const h = harness(scenario);
    failure(h, await h.tool.execute(input), scenario.kind, false);
    assert.deepEqual(h.clicks, []);
  });
}

test("prefilled mode never calls fillInput or reads a password length", async () => {
  const h = harness({ after: { errors: ["Unable to sign in"] } });
  failure(h, await h.tool.execute({ use_filled_form: true }), "invalid_credentials", true);
  assert.deepEqual(h.fills, []);
  assert.deepEqual(h.lengthChecks, []);
});

test("stale unchanged errors time out instead of judging a new attempt", async () => {
  const h = harness({ initial: { errors: ["Unable to sign in"] } });
  failure(h, await h.tool.execute(input), "unknown", true);
  assert.deepEqual(h.clicks, ['input[type="submit"]']);
});

for (const mfa of [false, true]) {
  test(`success branch distinguishes MFA from completed authentication: ${mfa}`, async () => {
    const h = harness({ readInterrupted: true, after: { hasForm: false, mfa: mfa ? "Get a verification email" : null, account: mfa ? null : "Sign out" } });
    const result = await h.tool.execute(input);
    assert.deepEqual(Object.keys(result).sort(), Array.from(h.tool.tool.outputSchema.oneOf[0].required).sort());
    assert.equal(result.logged_in, true);
    assert.equal(result.authenticated, !mfa);
    assert.equal(result.mfa_required, mfa);
    assert.equal(result.next_step, mfa ? "complete_mfa" : "none");
    assert.equal(result.submission_attempted, true);
    assert.deepEqual(h.clicks, ['input[type="submit"]']);
  });
}

function element(text, extra = {}) {
  return { innerText: text, textContent: text, tagName: "DIV", getClientRects: () => [{}], ...extra };
}

async function parseFixture({ heading, button, code = false, password = false, genericChallenge = false }) {
  const h = harness({ initial: { hasForm: false } });
  await h.tool.execute(input);
  const passcode = code || password ? element("", { type: password ? "password" : "text", value: "synthetic" }) : null;
  const document = {
    querySelector: selector => {
      if (selector === 'input[type="password"][name="credentials.passcode"]') return password ? passcode : null;
      if (selector === 'input[name="identifier"]') return password ? element("", { value: "qa" }) : null;
      return null;
    },
    querySelectorAll: selector => {
      if (selector === 'h1,h2,h3,[role="heading"]') return heading ? [element(heading)] : [];
      if (selector === 'a,button,input[type="submit"]') return button ? [element(button, { tagName: "INPUT", type: "submit", value: button })] : [];
      if (selector === 'input[autocomplete="one-time-code"],input[name="credentials.passcode"]') return passcode ? [passcode] : [];
      if (selector === 'p,div,span' && genericChallenge) return [element("Verify you are human")];
      return [];
    }
  };
  return runInNewContext(h.readExpression(), {
    document, location: { origin: "https://www.jetblue.com", pathname: "/signin" },
    getComputedStyle: () => ({ visibility: "visible" })
  });
}

for (const fixture of [
  { heading: "Get a verification email", button: "Send me an email" },
  { heading: 'Send a verification email to q***@example.invalid by clicking on "Send me an email".', button: "Send me an email" },
  { heading: "Verify with your email", button: "Verify", code: true },
  { heading: "We sent an email to q***@example.invalid. Enter the verification code in the text box.", button: "Verify", code: true }
]) {
  test(`real page-reader recognizes email MFA fixture: ${fixture.heading}`, async () => {
    const state = await parseFixture(fixture);
    assert.equal(state.mfa, fixture.heading);
    assert.equal(state.hasForm, false);
    const h = harness({ initial: plain(state) });
    const result = await h.tool.execute(input);
    assert.equal(result.logged_in, true);
    assert.equal(result.mfa_required, true);
    assert.equal(result.authenticated, false);
    assert.equal(result.submission_attempted, false);
    assert.deepEqual(h.fills, []);
    assert.deepEqual(h.clicks, []);
  });
}

test("verification-like heading alone is not MFA acceptance", async () => {
  assert.equal((await parseFixture({ heading: "Get a verification email" })).mfa, null);
  assert.equal((await parseFixture({ heading: "Verify your identity", button: "Verify", password: true })).mfa, null);
});

test("generic text challenge remains detectable", async () => {
  assert.equal((await parseFixture({ genericChallenge: true })).challenge, "Verify you are human");
});

test("registry preserves search and adds login metadata", () => {
  const { tools } = JSON.parse(readFileSync(new URL("../registry.json", import.meta.url), "utf8"));
  assert.ok(tools.some(t => t.domain === "jetblue.com" && t.tool === "search_flights"));
  const entries = tools.filter(t => t.domain === "jetblue.com" && t.tool === "login");
  assert.equal(entries.length, 1);
  assert.equal(entries[0].namespace, "jetblue.com");
  assert.equal(entries[0].status, "qa_passed");
  assert.equal(entries[0].file, "domains/jetblue.com/login.js");
  assert.deepEqual(entries[0].url_patterns, plain(harness().tool.match.url_patterns));
});
