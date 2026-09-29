import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../domains/delta.com/login.js", import.meta.url), "utf8");
const creds = { skymiles_number_or_username: "QA000000", password: "not-a-real-password" };

// Minimal fake of the Delta homepage header and its login flyout.
function page(options = {}) {
  const events = { triggerClicks: 0, submits: 0, scheduled: [] };
  class HTMLInputElement {
    constructor(id) { this.id = id; this._value = ""; this.shown = true; }
    get value() { return this._value; }
    set value(v) { this._value = options.dropValues ? "" : String(v); }
    focus() {}
    dispatchEvent() { return true; }
    getClientRects() { return this.shown && dialog.open ? [{}] : []; }
  }
  const user = new HTMLInputElement("userId-input");
  const pass = new HTMLInputElement("password-input");
  const submit = {
    innerText: "Log In", disabled: !!options.submitDisabled,
    classList: { contains: c => c === "login-screen__submit-button" },
    getClientRects: () => (dialog.open ? [{}] : []),
    click: () => { events.submits++; }
  };
  const close = { innerText: "", classList: { contains: () => false }, getClientRects: () => [{}], click() {} };
  const dialog = {
    open: !!options.flyoutOpen,
    querySelector: sel => ({ "#userId-input": user, "#password-input": pass })[sel] ?? null,
    querySelectorAll: () => (options.noSubmit ? [close] : [close, submit])
  };
  const trigger = {
    getClientRects: () => (options.signedIn ? [] : [{}]),
    click: () => { events.triggerClicks++; if (!options.flyoutNeverOpens) dialog.open = true; }
  };
  const url = new URL(options.url ?? "https://www.delta.com/");
  let now = 0;
  const context = {
    HTMLInputElement, Event: class { constructor(type) { this.type = type; } },
    location: { hostname: url.hostname, pathname: url.pathname },
    document: { querySelector: sel => ({ "#login-modal-popup": dialog, "#login-trigger": trigger })[sel] ?? null },
    getComputedStyle: () => ({ visibility: "visible" }),
    Date: { now: () => now },
    setTimeout: (fn, ms) => {
      if (ms === 100) { events.scheduled.push(fn); return 0; }
      now += ms; fn(); return 0;
    }
  };
  const [tool] = runInNewContext(`(${source})`, context);
  const run = input => runInNewContext("(fn, input) => fn(input)", context)(tool.execute, input);
  return { tool, run, events, user, pass };
}

test("definition: homepage-only page tool with no output schema", () => {
  const { tool } = page();
  assert.equal(tool.kind, "page");
  assert.equal(tool.tool.outputSchema, undefined);
  assert.ok(tool.match.url_patterns.every(p => /^https:\/\/www\.delta\.com\/(\?\*|us\/en\/?(\?\*)?)?$/.test(p)));
  assert.ok(!/duckduckgo/i.test(source));
});

test("opens the flyout, fills both fields and schedules one submit after returning", async () => {
  const p = page();
  const out = await p.run(creds);
  assert.equal(typeof out, "string");
  assert.match(out, /NOT confirmed/);
  assert.ok(!out.includes(creds.password));
  assert.equal(p.events.triggerClicks, 1);
  assert.equal(p.user.value, creds.skymiles_number_or_username);
  assert.equal(p.pass.value, creds.password);
  assert.equal(p.events.submits, 0, "must not submit before settling");
  assert.equal(p.events.scheduled.length, 1);
  p.events.scheduled[0]();
  assert.equal(p.events.submits, 1);
});

test("reuses an already-open flyout without clicking Log in again", async () => {
  const p = page({ flyoutOpen: true });
  await p.run(creds);
  assert.equal(p.events.triggerClicks, 0);
  assert.equal(p.events.scheduled.length, 1);
});

for (const [name, options, input, pattern] of [
  ["wrong page", { url: "https://www.delta.com/flightsearch/book-a-flight" }, creds, /wrong_page/],
  ["missing password", {}, { skymiles_number_or_username: "QA000000", password: "" }, /invalid_input/],
  ["already signed in", { signedIn: true }, creds, /login_button_missing/],
  ["flyout never opens", { flyoutNeverOpens: true }, creds, /login_form_not_ready/],
  ["values dropped", { dropValues: true }, creds, /fill_failed/],
  ["no submit button", { noSubmit: true }, creds, /submit_button_missing/],
  ["submit disabled", { submitDisabled: true }, creds, /submit_disabled/]
]) {
  test(`fails explicitly without submitting: ${name}`, async () => {
    const p = page(options);
    await assert.rejects(p.run(input), pattern);
    assert.equal(p.events.scheduled.length, 0);
    assert.equal(p.events.submits, 0);
  });
}
