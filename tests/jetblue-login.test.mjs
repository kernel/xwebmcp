import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../domains/jetblue.com/login.js", import.meta.url), "utf8");
const entry = "https://www.jetblue.com/signin";
const searchEntry = "https://start.duckduckgo.com/";
const input = { username: "qa@example.invalid", password: "fabricated-test-password" };
const plain = value => JSON.parse(JSON.stringify(value));
const branches = { authenticated: 0, mfa_required: 1, human_assist_required: 2, failed: 3 };
const initial = {
  origin: "https://www.jetblue.com", path: "/signin", url: "https://www.jetblue.com/signin",
  errors: [], hasForm: true, fieldsReady: true, submitReady: true, remember: false,
  challenge: null, mfa: null, passkey: null, account: null
};
const cookies = [
  { name: "sid", domain: ".jetblue.com", value: "SECRET-MUST-NOT-APPEAR" },
  { name: "idx", domain: "www.jetblue.com", value: "SECRET-MUST-NOT-APPEAR" },
  { name: "sid", domain: "trueblue.jetblue.com", value: "SECRET-MUST-NOT-APPEAR" },
  { name: "other", domain: ".example.com", value: "SECRET-MUST-NOT-APPEAR" },
  { name: "lookalike", domain: "jetblue.com.evil.example", value: "SECRET-MUST-NOT-APPEAR" }
];

function harness(options = {}) {
  let state = { ...initial, ...options.initial };
  let now = 0, reads = 0, submitted = false, readExpression, interrupted = false;
  let url = options.url ?? entry, followedResult = false;
  const navigation = [], fills = [], clicks = [], lengthChecks = [], searchActions = [], cdpCalls = [];
  const pageFunctions = {};
  const tools = runInNewContext(`(${source})`, {
    URL, Number, Date: { now: () => now },
    pageInfo: async () => ({ url }),
    gotoUrl: async next => {
      navigation.push(next);
      if (next === entry) { url = entry; state = { ...initial, ...options.directState }; }
      else url = options.searchUrl ?? next;
    },
    waitForElement: async selector => !options.missingSelector?.test(selector),
    accessibilitySnapshot: async () => ({ nodes: options.missingControls ? [] : [
      { role: "combobox", name: "Search with DuckDuckGo", backendNodeId: 1 },
      { role: "button", name: "Search", backendNodeId: 2 }
    ] }),
    cdp: async (command, params, sessionId) => {
      cdpCalls.push([command, sessionId]);
      if (options.cookieReadFails) throw new Error("cookie read unavailable");
      return { cookies };
    },
    fillInput: async (selector, value) => {
      if (typeof selector === "object") {
        if (options.searchInterrupted) throw new Error("Search page replaced");
        searchActions.push(["query", value]);
      }
      else {
        fills.push(selector);
        if (fills.length === 2 && options.beforeSubmit) state = { ...state, ...options.beforeSubmit };
      }
    },
    js: async (expression, args) => {
      if (typeof expression === "function") {
        if (typeof args?.arg === "number") {
          lengthChecks.push(args.arg);
          return options.lengthOK ?? true;
        }
        if (expression.toString().includes("document.referrer")) {
          pageFunctions.referrer = expression;
          return followedResult ? options.landingReferrer ?? true : options.hasReferrer ?? true;
        }
        pageFunctions.approve = expression;
        return options.approvedResult ?? true;
      }
      readExpression = expression;
      reads++;
      if (submitted && options.readInterrupted && !interrupted) {
        interrupted = true;
        throw new Error("Execution context replaced");
      }
      if (options.humanSignsInAfterReads === reads) state = { ...state, ...options.afterHuman };
      return state;
    },
    click: async selector => {
      if (typeof selector === "object") { searchActions.push(["search"]); return; }
      if (selector === '[data-webmcp-jetblue-login="true"]') {
        searchActions.push(["result"]);
        followedResult = true;
        url = entry;
        state = { ...initial, ...options.navigationState };
        return;
      }
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
  return { tool: tools[0], navigation, fills, clicks, lengthChecks, searchActions, cdpCalls, pageFunctions,
    reads: () => reads, readExpression: () => readExpression };
}

function conforms(h, result, status) {
  const branch = h.tool.tool.outputSchema.oneOf[branches[status]];
  assert.equal(result.status, status);
  assert.deepEqual(Object.keys(result).filter(k => k !== "entry").sort(), Array.from(branch.required).sort());
  if ("entry" in result) {
    assert.ok(branch.properties.entry.properties.path.enum.includes(result.entry.path));
    assert.equal(result.entry.fallback_reason === null, result.entry.path !== "direct_fallback");
  }
  assert.equal(typeof result.submission_attempted, "boolean");
  return branch;
}

function failure(h, result, kind, submitted) {
  const branch = conforms(h, result, "failed");
  assert.equal(result.error_kind, kind);
  assert.ok(branch.properties.error_kind.enum.includes(kind));
  assert.ok(typeof result.error_message === "string" && result.error_message.length > 0);
  assert.ok(["site", "tool"].includes(result.message_source));
  assert.ok(result.attempts_remaining_if_shown === null || Number.isInteger(result.attempts_remaining_if_shown));
  assert.equal(result.submission_attempted, submitted);
}

function humanAssist(h, result, reason, submitted) {
  const branch = conforms(h, result, "human_assist_required");
  assert.equal(result.assist_reason, reason);
  assert.ok(branch.properties.assist_reason.enum.includes(reason));
  assert.equal(result.automated_solving, "not_implemented");
  assert.equal(result.next_step, "human_login_then_capture_session");
  assert.equal(result.handoff.action, "open_browser_live_view_and_sign_in_manually");
  assert.ok(result.challenge_evidence.length > 0);
  assert.equal(result.submission_attempted, submitted);
}

test("single expression, CDP kind, domain patterns and four typed output states", () => {
  const { tool } = harness();
  assert.equal(tool.kind, "cdp");
  assert.equal(tool.tool.name, "login");
  assert.equal(tool.tool.inputSchema.type, "object");
  assert.equal(tool.tool.outputSchema.type, "object");
  assert.deepEqual(plain(tool.tool.outputSchema.oneOf.map(b => b.properties.status.const)),
    ["authenticated", "mfa_required", "human_assist_required", "failed"]);
  assert.ok(!tool.tool.outputSchema.oneOf[branches.failed].properties.error_kind.enum.includes("captcha_or_challenge"),
    "a challenge is its own state, never an error kind");
  assert.deepEqual(plain(tool.match.url_patterns), ["https://jetblue.com/*", "https://*.jetblue.com/*"]);
});

for (const url of ["about:blank", "https://example.com/", "https://jetblue.com/", "https://help.jetblue.com/", "https://www.jetblue.com/travel-agents", "https://www.jetblue.com/signin/other"]) {
  test(`enters through search before reading or filling from ${url}`, async () => {
    const h = harness({ url, after: { errors: ["Unable to sign in"] } });
    failure(h, await h.tool.execute(input), "invalid_credentials", true);
    assert.deepEqual(h.navigation, [searchEntry]);
    assert.deepEqual(h.searchActions, [["query", "jetblue login"], ["search"], ["result"]]);
    assert.equal(h.fills.length, 2);
    assert.deepEqual(h.lengthChecks, [input.password.length]);
    assert.deepEqual(h.clicks, ['input[type="submit"]']);
  });
}

for (const invalid of [undefined, {}, [], { username: "qa" }, { password: "synthetic" },
  { ...input, password: "" }, { ...input, username: " " }, { ...input, remember_me: "yes" },
  { ...input, use_filled_form: "yes" }, { ...input, otp: "123456" }, { ...input, use_filled_form: true },
  { mode: "solve_captcha" }, { mode: "capture_session", ...input }, { mode: "await_human_login", use_filled_form: true },
  { mode: "await_human_login", wait_seconds: 5 }, { mode: "await_human_login", wait_seconds: 6000 },
  { mode: "await_human_login", wait_seconds: 30.5 }]) {
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
  { name: "rendered challenge after submitting", after: { challenge: "Verify you are human" }, evidence: "Verify you are human" },
  { name: "challenge wording inside a site error", after: { errors: ["Please complete the CAPTCHA to continue."] }, evidence: "Please complete the CAPTCHA to continue." }
]) {
  test(`${scenario.name} reports human assist, never a solve attempt`, async () => {
    const h = harness(scenario);
    const result = await h.tool.execute(input);
    humanAssist(h, result, "captcha_or_challenge", true);
    assert.equal(result.challenge_evidence, scenario.evidence);
    assert.deepEqual(h.clicks, ['input[type="submit"]'], "no extra interaction after a challenge");
  });
}

for (const scenario of [
  { name: "blank password after fill", initial: { fieldsReady: false }, kind: "validation_error" },
  { name: "password length mismatch", lengthOK: false, kind: "validation_error" },
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

test("a challenge already on screen stops before any credential is typed", async () => {
  const h = harness({ initial: { challenge: "Press and hold to confirm you are human" } });
  humanAssist(h, await h.tool.execute(input), "captcha_or_challenge", false);
  assert.deepEqual(h.fills, []);
  assert.deepEqual(h.clicks, []);
  assert.deepEqual(h.navigation, []);
});

test("a passkey-only prompt is an unsupported verification handoff, not a failure", async () => {
  const h = harness({ initial: { hasForm: false, passkey: "Use your passkey to sign in" } });
  humanAssist(h, await h.tool.execute(input), "unsupported_verification_method", false);
  assert.deepEqual(h.clicks, []);
});

test("prefilled mode never calls fillInput or reads a password length", async () => {
  const h = harness({ after: { errors: ["Unable to sign in"] } });
  failure(h, await h.tool.execute({ use_filled_form: true }), "invalid_credentials", true);
  assert.deepEqual(h.fills, []);
  assert.deepEqual(h.lengthChecks, []);
});

test("stale unchanged errors time out instead of judging a new attempt", async () => {
  const h = harness({ beforeSubmit: { errors: ["Unable to sign in"] } });
  failure(h, await h.tool.execute(input), "unknown", true);
  assert.deepEqual(h.clicks, ['input[type="submit"]']);
});

test("first-step acceptance reports MFA separately from completed authentication", async () => {
  const h = harness({ readInterrupted: true, after: { hasForm: false, mfa: "Get a verification email" } });
  const result = await h.tool.execute(input);
  conforms(h, result, "mfa_required");
  assert.equal(result.mfa_prompt, "Get a verification email");
  assert.equal(result.next_step, "complete_mfa");
  assert.equal(result.submission_attempted, true);
});

test("completed authentication reports cookie metadata and no cookie values", async () => {
  const h = harness({ readInterrupted: true, after: { hasForm: false, account: "Sign out" } });
  const result = await h.tool.execute(input);
  conforms(h, result, "authenticated");
  assert.equal(result.account_name_or_hint, "Sign out");
  assert.deepEqual(plain(result.session), { cookie_read_ok: true, cookie_count: 3, cookie_names: ["idx", "sid"], values_returned: false });
  assert.ok(!JSON.stringify(result).includes("SECRET-MUST-NOT-APPEAR"), "cookie values must never be returned");
  assert.deepEqual(plain(h.cdpCalls), [["Storage.getCookies", null]]);
});

test("capture_session verifies an existing session without typing, clicking or navigating", async () => {
  const h = harness({ initial: { hasForm: false, account: "Sign out" } });
  const result = await h.tool.execute({ mode: "capture_session" });
  conforms(h, result, "authenticated");
  assert.equal(result.submission_attempted, false);
  assert.equal(result.session.cookie_count, 3);
  assert.deepEqual(h.fills, []);
  assert.deepEqual(h.clicks, []);
  assert.deepEqual(h.navigation, []);
});

test("capture_session reports an unreadable cookie store instead of implying an empty one", async () => {
  const h = harness({ cookieReadFails: true, initial: { hasForm: false, account: "Sign out" } });
  const result = await h.tool.execute({ mode: "capture_session" });
  assert.deepEqual(plain(result.session), { cookie_read_ok: false, cookie_count: 0, cookie_names: [], values_returned: false });
});

for (const scenario of [
  { name: "no session yet", initial: {}, expect: h => r => failure(h, r, "unknown", false) },
  { name: "still at a challenge", initial: { challenge: "Verify you are human" }, expect: h => r => humanAssist(h, r, "captcha_or_challenge", false) },
  { name: "still at MFA", initial: { hasForm: false, mfa: "Get a verification email" }, expect: h => r => conforms(h, r, "mfa_required") }
]) {
  test(`capture_session with ${scenario.name} does not claim a session`, async () => {
    const h = harness({ initial: scenario.initial });
    scenario.expect(h)(await h.tool.execute({ mode: "capture_session" }));
    assert.deepEqual(h.clicks, []);
  });
}

test("await_human_login returns the session once a person finishes signing in", async () => {
  const h = harness({ humanSignsInAfterReads: 3, afterHuman: { hasForm: false, account: "Sign out" } });
  const result = await h.tool.execute({ mode: "await_human_login", wait_seconds: 60 });
  conforms(h, result, "authenticated");
  assert.equal(result.submission_attempted, false);
  assert.deepEqual(h.fills, []);
  assert.deepEqual(h.clicks, []);
  assert.deepEqual(h.navigation, []);
});

test("await_human_login times out as pending, not as a failed login", async () => {
  const h = harness({ initial: { challenge: "Verify you are human" } });
  const result = await h.tool.execute({ mode: "await_human_login", wait_seconds: 10 });
  humanAssist(h, result, "pending_human_login", false);
  assert.deepEqual(h.clicks, []);
});

function element(text, extra = {}) {
  return { innerText: text, textContent: text, tagName: "DIV", getClientRects: () => [{}], ...extra };
}

async function parseFixture({ heading, button, code = false, password = false, bodyText = null }) {
  const h = harness({ initial: { hasForm: false } });
  await h.tool.execute({ mode: "capture_session" });
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
      if (selector === 'p,div,span' && bodyText) return [element(bodyText)];
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
  test(`page reader recognizes email MFA: ${fixture.heading}`, async () => {
    const state = await parseFixture(fixture);
    assert.equal(state.mfa, fixture.heading);
    assert.equal(state.hasForm, false);
    const h = harness({ initial: plain(state) });
    const result = await h.tool.execute({ mode: "capture_session" });
    conforms(h, result, "mfa_required");
    assert.deepEqual(h.clicks, []);
  });
}

test("verification-like heading alone is not MFA acceptance", async () => {
  assert.equal((await parseFixture({ heading: "Get a verification email" })).mfa, null);
  assert.equal((await parseFixture({ heading: "Verify your identity", button: "Verify", password: true })).mfa, null);
});

for (const wording of ["Verify you are human", "Press and hold to continue", "Security check", "Access Denied", "We detected unusual traffic from your network"]) {
  test(`page reader recognizes challenge wording: ${wording}`, async () => {
    assert.equal((await parseFixture({ bodyText: wording })).challenge, wording);
  });
}

test("page reader recognizes a passkey prompt only while no password form is shown", async () => {
  assert.equal((await parseFixture({ heading: "Use your passkey to sign in", button: "Continue" })).passkey, "Use your passkey to sign in");
  assert.equal((await parseFixture({ heading: "Use your passkey to sign in", button: "Continue", password: true })).passkey, null);
});

test("a direct sign-in entry establishes a real search referral before filling", async () => {
  const h = harness({ hasReferrer: false, after: { errors: ["Unable to sign in"] } });
  failure(h, await h.tool.execute(input), "invalid_credentials", true);
  assert.deepEqual(h.navigation, [searchEntry]);
  assert.deepEqual(h.searchActions, [["query", "jetblue login"], ["search"], ["result"]]);
});

test("an existing search-referred login does not navigate again", async () => {
  const h = harness({ after: { errors: ["Unable to sign in"] } });
  await h.tool.execute(input);
  assert.deepEqual(h.navigation, []);
  assert.deepEqual(h.searchActions, []);
});

test("prefilled mode refuses an unrelated page without discarding input or navigating", async () => {
  const h = harness({ url: "https://example.com/" });
  failure(h, await h.tool.execute({ use_filled_form: true }), "validation_error", false);
  assert.deepEqual(h.navigation, []);
  assert.deepEqual(h.fills, []);
});

for (const scenario of [
  { name: "search form unavailable", missingSelector: /combobox/ },
  { name: "search controls unavailable", missingControls: true },
  { name: "unexpected search origin", searchUrl: "https://example.com/" },
  { name: "organic results unavailable", missingSelector: /result-title/ },
  { name: "first result unapproved", approvedResult: false },
  { name: "missing landing referrer", landingReferrer: false },
  { name: "landing origin changed", navigationState: { origin: "https://example.com" } },
  { name: "landing path changed", navigationState: { path: "/other" } },
  { name: "search interrupted", searchInterrupted: true }
]) {
  test(`${scenario.name} falls back to the direct sign-in URL before filling`, async () => {
    const h = harness({ url: "https://www.jetblue.com/", after: { errors: ["Unable to sign in"] }, ...scenario });
    const result = await h.tool.execute(input);
    failure(h, result, "invalid_credentials", true);
    assert.deepEqual(h.navigation, [searchEntry, entry]);
    assert.equal(result.entry.path, "direct_fallback");
    assert.ok(result.entry.fallback_reason.length > 0);
    if (scenario.approvedResult === false) assert.ok(!h.searchActions.some(([action]) => action === "result"), "an unapproved result is never clicked");
    assert.equal(h.fills.length, 2);
    assert.deepEqual(h.clicks, ['input[type="submit"]']);
  });
}

test("a failed direct fallback stops without filling or submitting", async () => {
  const h = harness({ url: "https://www.jetblue.com/", approvedResult: false, directState: { path: "/other", hasForm: false } });
  const result = await h.tool.execute(input);
  failure(h, result, "unknown", false);
  assert.deepEqual(h.navigation, [searchEntry, entry]);
  assert.equal(result.entry.path, "direct_fallback");
  assert.deepEqual(h.fills, []);
  assert.deepEqual(h.clicks, []);
});

test("a direct fallback that lands on a challenge hands off without typing", async () => {
  const h = harness({ url: "https://www.jetblue.com/", missingControls: true, directState: { challenge: "Verify you are human" } });
  const result = await h.tool.execute(input);
  humanAssist(h, result, "captcha_or_challenge", false);
  assert.equal(result.entry.path, "direct_fallback");
  assert.deepEqual(h.fills, []);
});

test("search-referred and reused sign-in pages report their entry path", async () => {
  const searched = harness({ url: "https://example.com/", after: { errors: ["Unable to sign in"] } });
  assert.deepEqual(plain((await searched.tool.execute(input)).entry), { path: "search_referral", fallback_reason: null });
  const reused = harness({ after: { errors: ["Unable to sign in"] } });
  assert.deepEqual(plain((await reused.tool.execute(input)).entry), { path: "existing_page", fallback_reason: null });
});

test("first organic result approval rejects lookalikes, alternate destinations and redirects", async () => {
  const h = harness({ url: "https://example.com/", approvedResult: false });
  await h.tool.execute(input);
  for (const href of [
    "https://www.jetblue.com/signin", "https://www.jetblue.com/signin/",
    "https://www.jetblue.com.evil.example/signin", "https://evil.example/signin",
    "http://www.jetblue.com/signin", "https://www.jetblue.com/signin?returnUrl=https://evil.example",
    "https://www.jetblue.com/signin#other", "https://www.jetblue.com/", "https://trueblue.jetblue.com/login"
  ]) {
    let marked = false, cleared = false;
    const first = { href, getClientRects: () => [{}], setAttribute: () => { marked = true; } };
    const approve = runInNewContext(`(${h.pageFunctions.approve})`, {
      URL, location: { origin: "https://duckduckgo.com" }, document: {
        querySelectorAll: () => [{ removeAttribute: () => { cleared = true; } }],
        querySelector: selector => {
          assert.equal(selector, '[data-testid="result"] [data-testid="result-title-a"]');
          return first;
        }
      }
    });
    const expected = [entry, `${entry}/`].includes(href);
    assert.equal(approve(), expected, href);
    assert.equal(marked, expected, href);
    assert.equal(cleared, true);
  }
});

test("referrer check only trusts exact HTTPS DuckDuckGo origins", async () => {
  const h = harness({ after: { errors: ["Unable to sign in"] } });
  await h.tool.execute(input);
  for (const referrer of ["", "not a url", "https://duckduckgo.com/?q=jetblue", "https://start.duckduckgo.com/", "http://duckduckgo.com/", "https://duckduckgo.com.evil.example/"]) {
    const check = runInNewContext(`(${h.pageFunctions.referrer})`, { URL, document: { referrer } });
    assert.equal(check(), referrer === "https://duckduckgo.com/?q=jetblue" || referrer === "https://start.duckduckgo.com/", referrer);
  }
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
