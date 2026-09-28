import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../domains/flyfrontier.com/login.js", import.meta.url), "utf8");
const searchUrl = "https://start.duckduckgo.com";
const landedUrl = "https://www.flyfrontier.com/frontiermiles/";
const credentials = { mode: "credentials", identifier: "qa@example.invalid", password: "not-a-real-password" };

const siteState = {
  url: landedUrl, onSite: true, account: null, formVisible: false, formFilled: false,
  mfaVisible: false, mfaFieldCount: 0, mfaHint: null, errors: [], challenge: null
};
const searchState = { blocked: false, url: searchUrl };

function harness(options = {}) {
  let state = { ...siteState, ...options.initial };
  const navigation = [], fills = [], clicks = [], keys = [], pasted = [];
  const tools = runInNewContext(`(${source})`, {
    URL,
    gotoUrl: async url => { navigation.push(url); },
    waitForLoad: async () => options.loads !== false,
    waitForElement: async selector => {
      if (selector.includes("textarea")) return options.searchFieldMissing !== true;
      return options.resultsMissing !== true;
    },
    waitForNetworkIdle: async () => {},
    pressKey: async key => { keys.push(key); },
    fillInput: async (selector, value) => {
      fills.push({ selector, length: value.length });
      if (selector.includes('name="email"')) state = { ...state, emailValue: value };
      if (selector.includes('name="password"')) state = { ...state, passwordValue: value, formFilled: !!state.emailValue };
    },
    click: async selector => {
      clicks.push(selector);
      if (selector.includes("data-login-entry")) state = { ...state, ...options.afterEntryClick };
      if (selector === ".user-background") state = { ...state, ...(options.afterOpen ?? { formVisible: true }) };
      if (selector === ".login-container .button") state = { ...state, ...options.afterSubmit };
    },
    waitMs: async () => {},
    js: async (fn, args) => {
      const body = String(fn);
      if (body.includes("mfaFieldCount")) return { ...state, formFilled: !!state.emailValue && !!state.passwordValue };
      if (body.includes("wisepops-instance")) return undefined;
      if (body.includes("data-login-entry")) return options.organicResult === null ? null : (options.organicResult ?? "https://www.flyfrontier.com/myfrontier");
      if (body.includes("ClipboardEvent")) {
        pasted.push(args.arg);
        if (options.pasteIgnored) return false;
        state = { ...state, ...options.afterOtp };
        return true;
      }
      if (body.includes("data-login-otp")) return options.otpFields ?? [0, 1, 2, 3, 4, 5];
      if (body.includes("identifier_matches")) return options.fillVerification ?? {
        identifier_matches: state.emailValue === args.arg.identifier,
        length_matches: state.passwordValue?.length === args.arg.password.length,
        every_character_matches: state.passwordValue === args.arg.password
      };
      if (body.includes("toLowerCase()")) return options.accountBound ?? true;
      return { ...searchState, ...options.search };
    }
  });
  return { tools, run: input => tools[0].execute(input), navigation, fills, clicks, keys, pasted };
}

test("source is a single expression with one cdp tool scoped to the domain", () => {
  const { tools } = harness();
  assert.equal(tools.length, 1);
  assert.equal(tools[0].kind, "cdp");
  assert.deepEqual([...tools[0].match.url_patterns], ["https://flyfrontier.com/*", "https://*.flyfrontier.com/*"]);
  assert.equal(tools[0].tool.name, "login");
  assert.equal(tools[0].tool.outputSchema.oneOf.length, 2);
});

test("invalid input is rejected without touching the browser", async () => {
  for (const input of [
    null,
    {},
    { mode: "credentials" },
    { mode: "credentials", identifier: "  ", password: "x" },
    { mode: "credentials", identifier: "a@b.c", password: "x", otp: "123456" },
    { mode: "otp", otp: "12345" },
    { mode: "otp", otp: "123456", password: "x" },
    { mode: "prefilled_password", password: "x" },
    { mode: "credentials", identifier: "a@b.c", password: "x", unexpected: true }
  ]) {
    const h = harness();
    const result = await h.run(input);
    assert.equal(result.error_kind, "invalid_input", JSON.stringify(input));
    assert.equal(result.submitted, false);
    assert.equal(h.navigation.length, 0);
    assert.equal(h.clicks.length, 0);
  }
});

test("credentials mode enters only through the search engine", async () => {
  const h = harness({ afterSubmit: { mfaVisible: true, mfaFieldCount: 6, mfaHint: "We sent a 6-digit verification code to r***@example.com." } });
  const result = await h.run(credentials);
  assert.deepEqual(h.navigation, [searchUrl]);
  assert.deepEqual(h.keys, ["Enter"]);
  assert.ok(h.clicks.includes('a[data-login-entry="true"]'));
  assert.equal(result.entry_path, "search_referrer");
  assert.equal(result.logged_in, true);
  assert.equal(result.mfa_required, true);
  assert.equal(result.next_step, "enter_email_otp");
  assert.equal(result.authenticated, false);
});

test("each search-entry step fails explicitly instead of navigating to the site", async () => {
  const cases = [
    [{ searchFieldMissing: true }, "entry_search_failed", "search_entry"],
    [{ resultsMissing: true }, "entry_search_failed", "search_entry"],
    [{ organicResult: null }, "entry_result_missing", "search_entry"],
    [{ afterEntryClick: { onSite: false, url: "https://example.com/" } }, "entry_navigation_failed", "site_entry"]
  ];
  for (const [options, kind, stage] of cases) {
    const h = harness(options);
    const result = await h.run(credentials);
    assert.equal(result.error_kind, kind);
    assert.equal(result.stage, stage);
    assert.equal(result.submitted, false);
    assert.deepEqual(h.navigation, [searchUrl], "no entry path other than the search engine");
    assert.ok(!h.clicks.includes(".login-container .button"));
  }
});

test("a search-engine challenge is reported before any site request", async () => {
  const h = harness({ search: { blocked: true } });
  const result = await h.run(credentials);
  assert.equal(result.logged_in, false);
  assert.equal(result.error_kind, "captcha_or_challenge");
  assert.equal(result.stage, "search_entry");
  assert.equal(result.submitted, false);
});

test("a site error after submission is classified from the real message", async () => {
  const wrong = "Error: Your login information is incorrect. Please check your details and try again or reset your password now.";
  const h = harness({ afterSubmit: { errors: [wrong] } });
  const result = await h.run(credentials);
  assert.equal(result.logged_in, false);
  assert.equal(result.error_kind, "invalid_credentials");
  assert.equal(result.error_message, wrong);
  assert.equal(result.error_source, "site");
  assert.equal(result.submitted, true);
  assert.equal(result.attempts_remaining_if_shown, null);
});

test("lockout wording outranks remaining attempts and keeps the count", async () => {
  const h = harness({ afterSubmit: { errors: ["Too many attempts. Your account is locked. 2 attempts remaining."] } });
  const result = await h.run(credentials);
  assert.equal(result.error_kind, "locked_or_throttled");
  assert.equal(result.attempts_remaining_if_shown, 2);
});

test("a captcha after submission is a challenge, not a credential verdict", async () => {
  const h = harness({ afterSubmit: { challenge: "Verify you are human" } });
  const result = await h.run(credentials);
  assert.equal(result.logged_in, false);
  assert.equal(result.error_kind, "captcha_or_challenge");
  assert.equal(result.error_message, "Verify you are human");
  assert.equal(result.stage, "after_submit");
  assert.equal(result.submitted, true);
});

test("a completed session reports done without a verification step", async () => {
  const h = harness({ afterSubmit: { account: "QA", formVisible: false } });
  const result = await h.run(credentials);
  assert.equal(result.logged_in, true);
  assert.equal(result.authenticated, true);
  assert.equal(result.mfa_required, false);
  assert.equal(result.next_step, "done");
});

test("a verification panel that renders before its address hint is still a first-step success", async () => {
  const h = harness({ afterSubmit: { mfaVisible: true, mfaFieldCount: 6, mfaHint: null } });
  const result = await h.run(credentials);
  assert.equal(result.logged_in, true);
  assert.equal(result.mfa_required, true);
  assert.equal(result.next_step, "enter_email_otp");
  assert.equal(result.account_name_or_hint, null);
  assert.match(result.evidence, /6 code fields/);
});

test("a half-rendered verification panel is not a success", async () => {
  const h = harness({ afterSubmit: { mfaVisible: true, mfaFieldCount: 0, mfaHint: null } });
  const result = await h.run(credentials);
  assert.equal(result.logged_in, false);
  assert.equal(result.error_kind, "unknown");
  assert.equal(result.submitted, true);
});

test("otp mode requires a visible six-field step and never resends", async () => {
  const missing = harness({ initial: { mfaVisible: false } });
  const blocked = await missing.run({ mode: "otp", otp: "123456" });
  assert.equal(blocked.error_kind, "login_form_unavailable");
  assert.equal(blocked.submitted, false);
  assert.equal(missing.fills.length, 0);

  const h = harness({
    initial: { mfaVisible: true, mfaFieldCount: 6, mfaHint: "We sent a 6-digit verification code" },
    afterOtp: { mfaVisible: false, mfaFieldCount: 0, account: "QA" }
  });
  const result = await h.run({ mode: "otp", otp: "123456" });
  assert.equal(result.logged_in, true);
  assert.equal(result.authenticated, true);
  assert.deepEqual(h.pasted, ["123456"], "the code is pasted once into the first box");
  assert.equal(h.fills.length, 0, "per-box typing is never used");
  assert.equal(h.navigation.length, 0, "otp mode never re-enters through search");
});

test("a verification form that ignores the pasted code fails without claiming a code was evaluated", async () => {
  const h = harness({
    initial: { mfaVisible: true, mfaFieldCount: 6, mfaHint: "We sent a 6-digit verification code" },
    pasteIgnored: true
  });
  const result = await h.run({ mode: "otp", otp: "123456" });
  assert.equal(result.logged_in, false);
  assert.equal(result.error_kind, "login_form_unavailable");
  assert.equal(result.submitted, false);
  assert.match(result.error_message, /never evaluated a code/);
});

test("a rejected code is mfa_failed with the site's wording", async () => {
  const h = harness({
    initial: { mfaVisible: true, mfaFieldCount: 6, mfaHint: "We sent a 6-digit verification code" },
    afterOtp: { errors: ["Invalid code. Please try again."] }
  });
  const result = await h.run({ mode: "otp", otp: "123456" });
  assert.equal(result.logged_in, false);
  assert.equal(result.error_kind, "mfa_failed");
  assert.equal(result.error_message, "Invalid code. Please try again.");
  assert.equal(result.error_source, "site");
  assert.equal(result.submitted, true);
  assert.deepEqual(h.pasted, ["123456"]);
});

test("prefilled mode submits an open form without navigating or reading the password", async () => {
  const h = harness({
    initial: { formVisible: true, formFilled: true, emailValue: "qa@example.invalid", passwordValue: "filled" },
    afterSubmit: { account: "QA", formVisible: false }
  });
  const result = await h.run({ mode: "prefilled_password", identifier: "qa@example.invalid" });
  assert.equal(result.logged_in, true);
  assert.equal(result.entry_path, "already_open");
  assert.equal(h.navigation.length, 0);
  assert.ok(!h.fills.some(f => f.selector.includes("password")));
});

test("a mismatched filled account is refused before submission", async () => {
  const h = harness({
    initial: { formVisible: true, formFilled: true, emailValue: "other@example.invalid", passwordValue: "filled" },
    accountBound: false
  });
  const result = await h.run({ mode: "prefilled_password", identifier: "qa@example.invalid" });
  assert.equal(result.error_kind, "invalid_input");
  assert.equal(result.submitted, false);
  assert.ok(!h.clicks.includes(".login-container .button"));
});

test("a fill that does not match the supplied credentials blocks submission", async () => {
  const h = harness({ fillVerification: { identifier_matches: true, length_matches: false, every_character_matches: false } });
  const result = await h.run(credentials);
  assert.equal(result.error_kind, "login_form_unavailable");
  assert.equal(result.submitted, false);
  assert.ok(!h.clicks.includes(".login-container .button"));
});
