import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../domains/delta.com/login.js", import.meta.url), "utf8");
const loginUrl = "https://www.delta.com/skymiles/login";
const credentials = { mode: "credentials", identifier: "QA000000", password: "not-a-real-password" };
const deltaState = {
  url: loginUrl, host: "www.delta.com", referrer: "https://duckduckgo.com/",
  formVisible: true, filled: false, loginTrigger: true, account: null,
  mfaText: null, challenge: null, alerts: []
};

function harness(options = {}) {
  const steps = { search: [], navigation: [], fills: [], clicks: [], submits: 0 };
  let state = { ...deltaState, ...options.initial };
  const route = fn => {
    const body = fn.toString();
    if (body.includes("data-delta-login-entry")) return "pick";
    if (body.includes("data-delta-login-open")) return "open";
    if (body.includes("login-screen__form")) return "submit";
    return "read";
  };
  const tools = runInNewContext(`(${source})`, {
    URL,
    gotoUrl: async url => {
      steps.navigation.push(url);
      if (options.searchUnreachable) throw new Error("offline");
      state = { ...state, host: "duckduckgo.com", url: "https://duckduckgo.com/" };
    },
    waitForElement: async selector => {
      steps.search.push(selector);
      if (selector.startsWith("textarea")) return options.searchBox !== false;
      return options.results !== false;
    },
    fillInput: async (selector, value) => {
      steps.fills.push([selector, value]);
      if (selector === "#password-input") state = { ...state, filled: true, ...options.afterFill };
    },
    pressKey: async () => {},
    waitMs: async () => {},
    click: async selector => {
      steps.clicks.push(selector);
      if (selector.startsWith("a[data-delta-login-entry")) state = { ...deltaState, ...options.landing };
      if (selector === '[data-delta-login-open="1"]') state = { ...state, ...options.afterTrigger };
    },
    js: async fn => {
      const kind = route(fn);
      if (kind === "read") return state;
      if (kind === "pick") return options.deltaResult === false ? null : `${loginUrl}?redirectBack=true`;
      if (kind === "open") return options.triggerPresent !== false;
      steps.submits++;
      state = { ...state, ...options.afterSubmit };
      return options.submitBlocked !== true;
    }
  });
  return { tool: tools[0], steps };
}

test("input is validated before any navigation", async () => {
  for (const input of [{}, { mode: "credentials", identifier: "QA000000" }, { mode: "credentials", identifier: "QA000000", password: "p", extra: 1 }, { mode: "prefilled_password", password: "p" }]) {
    const { tool, steps } = harness();
    const result = await tool.execute(input);
    assert.equal(result.error_kind, "invalid_input");
    assert.equal(result.failed_step, "input");
    assert.equal(steps.navigation.length, 0);
  }
});

test("each DuckDuckGo entry step reports its own failure and never navigates directly to Delta", async () => {
  const cases = [
    [{ searchUnreachable: true }, "search_engine_unreachable", "search_engine"],
    [{ searchBox: false }, "search_box_missing", "search_engine"],
    [{ results: false }, "search_results_missing", "search_results"],
    [{ deltaResult: false }, "no_delta_result", "search_results"],
    [{ landing: { host: "duckduckgo.com", url: "https://duckduckgo.com/" } }, "entry_navigation_failed", "result_click"]
  ];
  for (const [options, kind, step] of cases) {
    const { tool, steps } = harness(options);
    const result = await tool.execute(credentials);
    assert.equal(result.status, "failure");
    assert.equal(result.error_kind, kind);
    assert.equal(result.failed_step, step);
    assert.equal(result.submitted, false);
    assert.equal(result.entry_path, "duckduckgo_referrer");
    assert.deepEqual(steps.navigation, ["https://start.duckduckgo.com"]);
    assert.equal(steps.submits, 0);
  }
});

test("an unready login form fails without submitting", async () => {
  const { tool, steps } = harness({ landing: { formVisible: false, loginTrigger: false } });
  const result = await tool.execute(credentials);
  assert.equal(result.error_kind, "login_form_not_ready");
  assert.equal(result.failed_step, "login_form");
  assert.equal(steps.submits, 0);
});

test("a visible login trigger is used once to open the form", async () => {
  const { tool, steps } = harness({ landing: { formVisible: false }, afterTrigger: { formVisible: true }, afterSubmit: { formVisible: false, account: "Log Out" } });
  const result = await tool.execute(credentials);
  assert.equal(result.status, "success");
  assert.equal(steps.clicks.filter(c => c === '[data-delta-login-open="1"]').length, 1);
});

test("site errors are classified and attributed to the site", async () => {
  const cases = [
    ["Login credential is incorrect. Please try again.", "invalid_credentials"],
    ["We’re sorry, but login is unavailable right now.", "unknown"],
    ["Your account is locked. Try again later.", "locked_or_throttled"],
    ["That verification code is incorrect.", "mfa_failed"]
  ];
  for (const [message, kind] of cases) {
    const { tool, steps } = harness({ afterSubmit: { alerts: [message] } });
    const result = await tool.execute(credentials);
    assert.equal(result.status, "failure");
    assert.equal(result.error_kind, kind);
    assert.equal(result.error_source, "site");
    assert.equal(result.failed_step, "submission");
    assert.equal(result.submitted, true);
    assert.equal(steps.submits, 1);
  }
});

test("a shown attempt count is reported", async () => {
  const { tool } = harness({ afterSubmit: { alerts: ["Login credential is incorrect. You have 2 attempts remaining."] } });
  const result = await tool.execute(credentials);
  assert.equal(result.error_kind, "invalid_credentials");
  assert.equal(result.attempts_remaining_if_shown, 2);
});

test("a challenge on the landing page stops before credentials are entered", async () => {
  const { tool, steps } = harness({ landing: { challenge: "Verify you are human" } });
  const result = await tool.execute(credentials);
  assert.equal(result.status, "failure");
  assert.equal(result.error_kind, "captcha_or_challenge");
  assert.equal(result.error_source, "site");
  assert.equal(result.failed_step, "login_form");
  assert.equal(result.submitted, false);
  assert.equal(steps.submits, 0);
  assert.deepEqual(steps.fills.map(([selector]) => selector), ['textarea[name="q"]']);
});

test("a challenge after submitting is reported as submitted", async () => {
  const { tool } = harness({ afterSubmit: { challenge: "Captcha challenge" } });
  const result = await tool.execute(credentials);
  assert.equal(result.status, "failure");
  assert.equal(result.error_kind, "captcha_or_challenge");
  assert.equal(result.failed_step, "submission");
  assert.equal(result.submitted, true);
});

test("success branches distinguish completed authentication from a verification step", async () => {
  const done = await harness({ afterSubmit: { formVisible: false, account: "Log Out" } }).tool.execute(credentials);
  assert.equal(done.status, "success");
  assert.equal(done.authentication_complete, true);
  assert.equal(done.mfa_required, false);
  assert.equal(done.next_step, "done");
  assert.equal(done.referrer, "https://duckduckgo.com/");

  const mfa = await harness({ afterSubmit: { formVisible: false, mfaText: "Enter the verification code we sent you" } }).tool.execute(credentials);
  assert.equal(mfa.status, "success");
  assert.equal(mfa.authentication_complete, false);
  assert.equal(mfa.mfa_required, true);
  assert.equal(mfa.next_step, "enter_code_in_browser");
});

test("an existing signed-in page is not reported as this invocation's success", async () => {
  const { tool, steps } = harness({ landing: { formVisible: false, loginTrigger: false, account: "Log Out" } });
  const result = await tool.execute(credentials);
  assert.equal(result.status, "failure");
  assert.equal(result.error_kind, "login_form_not_ready");
  assert.equal(steps.submits, 0);
});

test("prefilled_password never navigates and requires a filled visible form", async () => {
  const empty = harness({ initial: { filled: false } });
  const rejected = await empty.tool.execute({ mode: "prefilled_password" });
  assert.equal(rejected.error_kind, "invalid_input");
  assert.equal(rejected.failed_step, "login_form");
  assert.equal(rejected.entry_path, "current_page");
  assert.deepEqual(empty.steps.navigation, []);
  assert.equal(empty.steps.submits, 0);

  const filled = harness({ initial: { filled: true }, afterSubmit: { formVisible: false, account: "Log Out" } });
  const accepted = await filled.tool.execute({ mode: "prefilled_password" });
  assert.equal(accepted.status, "success");
  assert.equal(accepted.entry_path, "current_page");
  assert.deepEqual(filled.steps.navigation, []);
  assert.deepEqual(filled.steps.fills, []);
  assert.equal(filled.steps.submits, 1);
});
