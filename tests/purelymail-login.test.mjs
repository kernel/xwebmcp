import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { conforms, plain, toolSource } from "./fixtures/purelymail/server.mjs";

const email = "agent@example.com";
const password = "fixture-password";
const INBOX = "https://inbox.purelymail.com/?_task=mail&_mbox=INBOX";
const LOGIN = "https://purelymail.com/user/login";

// Page states as the tool's read() reports them.
const webmail = (account = email) => ({ url: INBOX, host: "inbox.purelymail.com", webmail: true, account, form: false, buttonEnabled: false, loginError: null, codeStep: false, marker: 0 });
const loginPage = (extra = {}) => ({ url: LOGIN, host: "purelymail.com", webmail: false, account: null, form: true, buttonEnabled: true, loginError: null, codeStep: false, marker: 0, ...extra });

function harness({ start = { url: "about:blank" }, signedInAs = null, afterSubmit = () => webmail(), marker = 0, acceptTyping = true } = {}) {
  let clock = 1_800_000_000_000;
  let scene = start;
  let storedMarker = marker;
  const calls = { navigations: [], typed: {}, clicks: 0, markers: [] };
  const context = {
    Date: class extends Date { constructor(...a) { super(...(a.length ? a : [clock])); } static now() { return clock; } },
    pageInfo: async () => ({ url: scene.url }),
    gotoUrl: async url => {
      calls.navigations.push(url);
      scene = url.startsWith("https://inbox.purelymail.com/") ? (signedInAs ? webmail(signedInAs) : loginPage()) : loginPage();
    },
    waitForLoad: async () => true,
    waitMs: async ms => { clock += ms; },
    fillInput: async (selector, text) => { calls.typed[selector] = acceptTyping ? text : ""; },
    click: async selector => { assert.equal(selector, "#loginButton"); calls.clicks++; scene = afterSubmit(calls); },
    js: async (fn, options) => {
      const text = fn.toString();
      if (text.includes("header-title")) return { ...scene, marker: scene.form ? storedMarker : 0 };
      if (text.includes("setItem")) { storedMarker = clock; calls.markers.push("set"); return undefined; }
      if (text.includes("removeItem")) { storedMarker = 0; calls.markers.push("clear"); return undefined; }
      if (text.includes("emailInput\").value")) return (calls.typed["#emailInput"] || "") === options.arg && !!calls.typed["#passwordInput"];
      throw new Error("unexpected page function " + text.slice(0, 80));
    }
  };
  const [definition] = runInNewContext(`(${toolSource("login")})`, context);
  return {
    calls,
    run: async input => {
      const result = plain(await definition.execute(input));
      assert.ok(conforms(definition.tool.outputSchema, result), "output matches schema: " + JSON.stringify(result));
      assert.ok(!JSON.stringify(result).includes(password), "the password never appears in the output");
      return result;
    }
  };
}

test("an existing session for the same address succeeds without submitting", async () => {
  const h = harness({ signedInAs: "Agent@Example.com".toLowerCase() });
  const result = await h.run({ email: "Agent@Example.com", password });
  assert.equal(result.status, "ok");
  assert.equal(result.entry, "already_signed_in");
  assert.equal(result.submission_attempted, false);
  assert.equal(h.calls.clicks, 0);
});

test("an existing session for another address is wrong_account and nothing is typed", async () => {
  const h = harness({ signedInAs: "someone-else@example.com" });
  const result = await h.run({ email, password });
  assert.equal(result.error_kind, "wrong_account");
  assert.equal(result.signed_in_account, "someone-else@example.com");
  assert.equal(result.submission_attempted, false);
  assert.deepEqual(h.calls.typed, {});
});

test("the login form is submitted once and success requires the header to show the supplied address", async () => {
  const h = harness();
  const result = await h.run({ email, password });
  assert.deepEqual(result, { status: "ok", logged_in: true, account: email, entry: "form_submitted", submission_attempted: true, landing_url: INBOX });
  assert.equal(h.calls.clicks, 1);
  assert.equal(h.calls.typed["#emailInput"], email);
  assert.deepEqual(h.calls.navigations, [INBOX]);
  const other = await harness({ afterSubmit: () => webmail("different@example.com") }).run({ email, password });
  assert.equal(other.error_kind, "wrong_account");
  assert.equal(other.submission_attempted, true);
});

test("a rejected password is reported once, clears the submission marker, and is not retried", async () => {
  const h = harness({ afterSubmit: () => loginPage({ loginError: "Incorrect username or password" }) });
  const result = await h.run({ email, password });
  assert.equal(result.error_kind, "invalid_credentials");
  assert.equal(result.error_source, "site");
  assert.equal(h.calls.clicks, 1);
  assert.deepEqual(h.calls.markers, ["set", "clear"]);
});

test("a recent unresolved submission blocks a second one", async () => {
  const h = harness({ start: { url: LOGIN }, marker: 1_800_000_000_000 - 5000 });
  const result = await h.run({ email, password });
  assert.equal(result.error_kind, "recent_submission");
  assert.equal(h.calls.clicks, 0);
});

test("no observable result after submitting is unknown, not success", async () => {
  const h = harness({ afterSubmit: () => loginPage({ buttonEnabled: false }) });
  const result = await h.run({ email, password });
  assert.equal(result.error_kind, "unknown");
  assert.equal(result.submission_attempted, true);
  assert.equal(h.calls.clicks, 1);
});

test("a second-factor prompt and throttling are reported, and inputs are validated", async () => {
  assert.equal((await harness({ afterSubmit: () => loginPage({ form: false, codeStep: true }) }).run({ email, password })).error_kind, "mfa_unsupported");
  assert.equal((await harness({ afterSubmit: () => loginPage({ loginError: "Too many attempts, try again later" }) }).run({ email, password })).error_kind, "locked_or_throttled");
  assert.equal((await harness({ acceptTyping: false }).run({ email, password })).error_kind, "unknown");
  for (const bad of [{ email }, { email: "not-an-email", password }, { email, password: "" }, { email, password, otp: "123456" }]) {
    const h = harness();
    assert.equal((await h.run(bad)).error_kind, "invalid_input");
    assert.equal(h.calls.navigations.length, 0);
  }
});
