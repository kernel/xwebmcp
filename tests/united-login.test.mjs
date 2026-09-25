import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../domains/united.com/login.js", import.meta.url), "utf8");
const entryUrl = "https://www.united.com/en/us/united-mileageplus-signin";
const input = { mode: "credentials", identifier: "qa@example.invalid", password: "not-a-real-password" };
const prefilled = { mode: "prefilled_password", identifier: "QA123456" };
const stateTemplate = {
  url: entryUrl, origin: "https://www.united.com", idVisible: false,
  pwVisible: true, pwFilled: true, account: "QA123456", codeCount: 0,
  errors: [], challenge: null, signout: null, mfaText: null
};
const plain = value => JSON.parse(JSON.stringify(value));

function harness(options = {}) {
  let state = { ...stateTemplate, ...options.initial };
  let pendingSelector;
  let pageReads = 0;
  const navigation = [], submissions = [], fills = [], events = [];
  const pageFunctions = {};
  const tools = runInNewContext(`(${source})`, {
    URL,
    pageInfo: async () => { pageReads++; return { url: state.url }; },
    gotoUrl: async url => {
      navigation.push(url);
      state = { ...stateTemplate, idVisible: true, pwVisible: false, ...options.navigationState };
    },
    js: async (fn, args) => {
      if (typeof args?.arg === "boolean") return true;
      if (typeof args?.arg === "string") {
        pendingSelector = args.arg;
        pageFunctions.submit = fn;
        return '[data-airline-login-submit="true"]';
      }
      if (args?.arg?.body !== undefined) {
        const response = options.responses?.[pendingSelector];
        return response?.heading ?? null;
      }
      pageReads++;
      pageFunctions.read = fn;
      return state;
    },
    fillInput: async selector => { fills.push(selector); },
    click: async () => {
      assert.ok(!submissions.includes(pendingSelector), "must not resubmit a stage");
      submissions.push(pendingSelector);
      events.push("click");
      state = pendingSelector === "#MPIDEmailField"
        ? { ...stateTemplate }
        : { ...state, ...options.after };
    },
    waitMs: async () => {},
    cdp: async cmd => {
      if (cmd === "Network.getResponseBody") return { body: "fixture", base64Encoded: false };
      return {};
    },
    waitForEvent: async (method, { predicate }) => {
      assert.equal(method, "Network.responseReceived");
      events.push("observe");
      const path = pendingSelector === "#MPIDEmailField" ? "/xapi/auth/validate-username" : "/xapi/auth/signin";
      const response = options.responses?.[pendingSelector] ?? { status: 200 };
      const event = { params: { response: { url: `https://www.united.com${path}`, status: response.status }, requestId: "fixture" }, sessionId: "fixture" };
      assert.equal(predicate(event), true);
      assert.equal(predicate({ params: { response: { url: "https://example.com/xapi/auth/signin" } } }), false);
      return event;
    }
  });
  return { tool: tools[0], navigation, submissions, fills, events, pageFunctions, pageReads: () => pageReads };
}

function assertFailure(tool, output, kind) {
  const branch = tool.tool.outputSchema.oneOf.find(s => s.properties.logged_in.const === false);
  assert.deepEqual(Object.keys(output).sort(), Array.from(branch.required).sort());
  assert.equal(output.logged_in, false);
  assert.equal(output.error_kind, kind);
  assert.ok(branch.properties.error_kind.enum.includes(output.error_kind));
  assert.ok(branch.properties.error_source.enum.includes(output.error_source));
  assert.equal(typeof output.error_message, "string");
  assert.ok(output.error_message.length > 0);
  assert.ok(output.attempts_remaining_if_shown === null || Number.isInteger(output.attempts_remaining_if_shown));
}

test("single tool-array expression matches both domain patterns and declares dual output branches", () => {
  const { tool } = harness();
  assert.equal(tool.kind, "cdp");
  assert.equal(tool.tool.name, "login");
  assert.equal(tool.tool.annotations.readOnlyHint, false);
  assert.deepEqual(plain(tool.match.url_patterns), ["https://united.com/*", "https://*.united.com/*"]);
  assert.equal(tool.tool.inputSchema.type, "object");
  assert.equal(tool.tool.outputSchema.type, "object");
  assert.equal(tool.tool.outputSchema.oneOf.length, 2);
});

for (const url of ["about:blank", "https://example.com/", "https://united.com/", "https://help.united.com/", "https://www.united.com/en/us/fly/travel.html"]) {
  test(`credentials enter the login flow from ${url}`, async () => {
    const h = harness({ initial: { url, origin: new URL(url).origin }, responses: { "#MPIDEmailField": { status: 428, heading: "Access Denied" } } });
    const result = await h.tool.execute(input);
    assert.deepEqual(h.navigation, [entryUrl]);
    assert.deepEqual(h.submissions, ["#MPIDEmailField"]);
    assert.deepEqual(h.fills, ["#MPIDEmailField"]);
    assert.deepEqual(h.events, ["observe", "click"]);
    assertFailure(h.tool, result, "captcha_or_challenge");
    assert.equal(result.error_message, "Access Denied (HTTP 428)");
  });
}

test("reuses a ready identifier form without navigation", async () => {
  const h = harness({ initial: { idVisible: true, pwVisible: false }, responses: { "#MPIDEmailField": { status: 428, heading: "Access Denied" } } });
  assertFailure(h.tool, await h.tool.execute(input), "captcha_or_challenge");
  assert.deepEqual(h.navigation, []);
  assert.deepEqual(h.submissions, ["#MPIDEmailField"]);
});

test("missing form times out without filling or submitting", async () => {
  const h = harness({ initial: { url: "about:blank", origin: "null" }, navigationState: { idVisible: false } });
  assertFailure(h.tool, await h.tool.execute(input), "unknown");
  assert.deepEqual(h.submissions, []);
  assert.deepEqual(h.fills, []);
});

for (const invalid of [undefined, {}, [], { mode: "credentials" }, { ...input, password: "" }, { ...input, identifier: " " }, { ...input, remember_me: "yes" }, { ...input, otp: "123456" }, { mode: "otp", otp: 123456 }, { ...prefilled, password: "synthetic" }]) {
  test(`invalid input fails before page access: ${JSON.stringify(invalid)}`, async () => {
    const h = harness();
    assertFailure(h.tool, await h.tool.execute(invalid), "invalid_input");
    assert.equal(h.pageReads(), 0);
    assert.deepEqual(h.submissions, []);
    assert.deepEqual(h.navigation, []);
  });
}

for (const scenario of [
  { name: "existing session is not proof of requested account", initial: { pwVisible: false, signout: "Sign out" }, kind: "unknown", submissions: 0 },
  { name: "prefilled account mismatch", initial: { account: "OTHER123" }, kind: "invalid_input", submissions: 0 },
  { name: "visible challenge", initial: { challenge: "Verify you are human" }, kind: "captcha_or_challenge", submissions: 0 },
  { name: "invalid credentials", after: { errors: ["Incorrect password. 0 attempts remaining."] }, kind: "invalid_credentials", remaining: 0 },
  { name: "lockout", after: { errors: ["Too many attempts. Try again later."] }, kind: "locked_or_throttled" },
  { name: "generic site failure", after: { errors: ["Sorry, something went wrong. Please try again."] }, kind: "unknown" },
  { name: "MFA failure", after: { errors: ["The verification code is incorrect."] }, kind: "mfa_failed" },
  { name: "hidden denial", responses: { "#password": { status: 428, heading: "Access Denied" } }, kind: "captcha_or_challenge" },
  { name: "HTTP throttle", responses: { "#password": { status: 429 } }, kind: "locked_or_throttled" },
  { name: "HTTP error preserves site wording", responses: { "#password": { status: 401 } }, after: { errors: ["Incorrect password."] }, kind: "invalid_credentials" },
  { name: "unclassified HTTP failure", responses: { "#password": { status: 500 } }, kind: "unknown" }
]) {
  test(scenario.name, async () => {
    const h = harness(scenario);
    const result = await h.tool.execute(prefilled);
    assertFailure(h.tool, result, scenario.kind);
    assert.equal(h.submissions.length, scenario.submissions ?? 1);
    if (scenario.remaining !== undefined) assert.equal(result.attempts_remaining_if_shown, scenario.remaining);
  });
}

for (const mfa of [false, true]) {
  test(`synthetic success distinguishes completed authentication from MFA: ${mfa}`, async () => {
    const h = harness({ after: mfa ? { pwVisible: false, codeCount: 1, mfaText: "Enter the verification code" } : { pwVisible: false, signout: "Sign out" } });
    const result = await h.tool.execute(input);
    assert.equal(result.logged_in, true);
    assert.equal(result.authentication_complete, !mfa);
    assert.equal(result.mfa_required, mfa);
    assert.equal(result.next_step, mfa ? "enter_otp" : "done");
    assert.deepEqual(h.submissions, ["#MPIDEmailField", "#password"]);
    const branch = h.tool.tool.outputSchema.oneOf.find(s => s.properties.logged_in.const === true);
    assert.deepEqual(Object.keys(result).sort(), Array.from(branch.required).sort());
  });
}

test("OTP mode refuses missing verification state without navigation or submission", async () => {
  const h = harness();
  assertFailure(h.tool, await h.tool.execute({ mode: "otp", otp: "123456" }), "unknown");
  assert.deepEqual(h.navigation, []);
  assert.deepEqual(h.submissions, []);
});

test("submit selector clears a previous stage's marker", async () => {
  const h = harness({ after: { errors: ["Incorrect password."] } });
  await h.tool.execute(prefilled);
  const previous = { marked: true, removeAttribute() { this.marked = false; } };
  const current = {
    marked: false, innerText: "Sign in", disabled: false,
    getClientRects: () => [{}],
    setAttribute() { this.marked = true; },
    removeAttribute() { this.marked = false; }
  };
  const document = {
    querySelector: () => ({ closest: () => ({ querySelectorAll: () => [current] }) }),
    querySelectorAll: () => [previous, current].filter(b => b.marked)
  };
  const select = runInNewContext(`(${h.pageFunctions.submit})`, { document, location: { origin: "https://www.united.com" } });
  assert.equal(select("#password"), '[data-airline-login-submit="true"]');
  assert.equal(previous.marked, false);
  assert.equal(current.marked, true);
});

test("nested error elements produce one copy of the site message", async () => {
  const h = harness({ initial: { account: "OTHER123" } });
  await h.tool.execute(prefilled);
  const alerts = [
    "Something went wrong\n\nSorry, something went wrong. Please try again.",
    "Something went wrong",
    "Sorry, something went wrong. Please try again."
  ].map(innerText => ({ innerText, getClientRects: () => [{}] }));
  const document = {
    querySelector: () => null,
    querySelectorAll: selector => selector.includes('[role="alert"]') ? alerts : []
  };
  const read = runInNewContext(`(${h.pageFunctions.read})`, {
    document, location: { origin: "https://www.united.com", href: entryUrl },
    getComputedStyle: () => ({ visibility: "visible" })
  });
  assert.deepEqual(plain(read().errors), ["Something went wrong Sorry, something went wrong. Please try again."]);
});

test("registry preserves search and adds the login namespace, patterns and QA status", () => {
  const registry = JSON.parse(readFileSync(new URL("../registry.json", import.meta.url), "utf8"));
  assert.ok(registry.tools.some(t => t.domain === "united.com" && t.tool === "search_flights"));
  const entries = registry.tools.filter(t => t.domain === "united.com" && t.tool === "login");
  assert.equal(entries.length, 1);
  assert.equal(entries[0].namespace, "united.com");
  assert.equal(entries[0].file, "domains/united.com/login.js");
  assert.equal(entries[0].status, "draft");
  assert.equal(entries[0].browser_session, null);
  assert.deepEqual(entries[0].url_patterns, plain(harness().tool.match.url_patterns));
});
