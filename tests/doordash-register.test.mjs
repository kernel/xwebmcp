import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../domains/doordash.com/register.js", import.meta.url), "utf8");
const signupHost = "identity.doordash.com";
const profileUrl = "https://www.doordash.com/consumer/edit_profile/";
const guardKey = "doordash.com.register.submitted.v1";
// Fabricated identity only.
const input = { email: "qa-new@example.invalid", first_name: "Qa", last_name: "Tester", phone: "(202) 555-0100", password: "fabricated-test-password" };
const plain = value => JSON.parse(JSON.stringify(value));

const base = { url: "https://www.doordash.com/", host: "www.doordash.com", https: true, form: false, marks: {}, submit: false, codeStep: false, codeCount: 0, codeHint: null, account: null, errors: [], profileEmail: null, challenge: null };
const form = { ...base, url: "https://identity.doordash.com/auth/user/signup", host: signupHost, form: true, marks: { first: 0, last: 0, email: 0, phone: 0, password: 0 }, submit: true };
const code = { ...form, codeStep: true, codeCount: 1, codeHint: "We sent a code to (202) 555-0100." };
const home = { ...base, account: "Account" };

function conforms(schema, value) {
  if ("const" in schema && value !== schema.const) return false;
  if (schema.enum && !schema.enum.includes(value)) return false;
  if (schema.type && ![schema.type].flat().some(type => {
    if (type === "null") return value === null;
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
  return true;
}

function harness(options = {}) {
  let state = { ...base, ...options.initial };
  let cookie = options.cookie ?? false;
  let now = 1_000_000;
  let pending = [];
  const store = new Map(options.guarded ? [[guardKey, now - 1000]] : []);
  const calls = { navigations: [], typed: [], submits: 0, otpSubmits: 0, otp: null };
  const tools = runInNewContext(`(${source})`, {
    URL, Date: { now: () => now },
    js: async (fn, args) => {
      const src = fn.toString();
      if (src.includes("signup-form") && src.includes("codeInputs")) return { ...state };
      if (src.includes("expected.phone")) return options.fieldsHold ?? true;
      if (src.includes("sessionStorage.getItem")) {
        const previous = store.get(args.arg.key) || 0;
        if (previous && now - previous < args.arg.ttl) return false;
        store.set(args.arg.key, now);
        return true;
      }
      if (src.includes("ClipboardEvent")) { calls.otp = args.arg; return true; }
      if (src.includes("otp-submit")) return true;
      // lib/input.js leftover check after clearing a field.
      if (src.includes("document.activeElement")) return "";
      throw new Error("unexpected page function: " + src.slice(0, 80));
    },
    cdp: async (method, params) => {
      if (method === "Network.getCookies") return { cookies: cookie ? [{ name: "dd_cx_logged_in", value: "true" }] : [] };
      if (method === "Input.dispatchKeyEvent") return {};
      throw new Error("unexpected cdp " + method);
    },
    pressKey: async () => {},
    gotoUrl: async url => {
      calls.navigations.push(url);
      if (url === profileUrl) state = { ...home, url: profileUrl, profileEmail: options.profileEmail ?? input.email };
      else state = { ...(options.signupPage ?? form) };
    },
    click: async selector => {
      if (typeof selector === "string" && selector.includes("data-webmcp-doordash-register=\"") && !selector.includes("otp-submit")) { calls.typed.push(selector.match(/"(\w+)"/)[1]); return; }
      if (selector === "form#signup-form #sign-up-submit-button") {
        calls.submits++;
        pending = [...(options.after ?? [])];
        return;
      }
      if (selector.includes("otp-submit")) { calls.otpSubmits++; pending = [...(options.after ?? [])]; return; }
      throw new Error("unexpected click " + selector);
    },
    waitMs: async ms => {
      now += ms;
      if (pending.length) { const { cookie: c, ...next } = pending.shift(); if (c !== undefined) cookie = c; state = { ...state, ...next }; }
    }
  });
  return {
    tool: tools[0], calls,
    run: async value => {
      const result = plain(await tools[0].execute(value === undefined ? input : value));
      assert.ok(conforms(tools[0].tool.outputSchema, result), JSON.stringify(result));
      assert.ok(calls.submits <= 1, "never retries Sign Up");
      assert.doesNotMatch(JSON.stringify(result), /fabricated-test-password/);
      return result;
    }
  };
}

test("single expression, cdp kind and inlined typing helper", () => {
  assert.ok(!source.trimEnd().endsWith(";"));
  assert.match(source, /@xwebmcp-inline lib\/input\.js\n\s+const typeInto/);
  const { tool } = harness();
  assert.equal(tool.kind, "cdp");
  assert.equal(tool.tool.name, "register");
  assert.ok(conforms(tool.tool.inputSchema, input));
  assert.ok(conforms(tool.tool.inputSchema, { email: input.email, otp: "123456" }));
  assert.equal(conforms(tool.tool.inputSchema, { ...input, otp: "123456" }), false);
});

test("registry entry matches the source", () => {
  const registry = JSON.parse(readFileSync(new URL("../registry.json", import.meta.url), "utf8"));
  const entry = registry.tools.find(t => t.domain === "doordash.com" && t.tool === "register");
  assert.equal(entry.kind, "cdp");
  assert.equal(entry.status, "draft");
  assert.deepEqual(entry.url_patterns, plain(harness().tool.match.url_patterns));
});

for (const invalid of [null, {}, { ...input, phone: "123" }, { ...input, password: "short" }, { ...input, first_name: " " }, { ...input, marketing: true }, { email: input.email, otp: "12345" }, { email: input.email, otp: "123456", phone: input.phone }]) {
  test(`invalid input is rejected before any page action: ${JSON.stringify(invalid)}`, async () => {
    const h = harness();
    const result = await h.run(invalid);
    assert.equal(result.error_kind, "invalid_input");
    assert.equal(result.submission_attempted, false);
    assert.deepEqual(h.calls.navigations, []);
  });
}

test("an already signed-in browser is refused without navigation", async () => {
  const h = harness({ initial: home, cookie: true });
  const result = await h.run();
  assert.equal(result.error_kind, "already_signed_in");
  assert.deepEqual(h.calls.navigations, []);
  assert.equal(h.calls.submits, 0);
});

test("signup types all five fields, submits once and reports the code step", async () => {
  const h = harness({ after: [{}, { ...code, errors: ["Unable to continue until the phone number is verified."] }] });
  const result = await h.run();
  assert.equal(result.error_kind, "verification_required");
  assert.equal(result.next_step, "submit_otp");
  assert.equal(result.submission_attempted, true);
  assert.deepEqual(h.calls.typed, ["first", "last", "email", "phone", "password"]);
  assert.equal(h.calls.submits, 1);
  assert.equal(h.calls.navigations.length, 1);
});

test("an email that is already registered is reported from the site's message", async () => {
  const h = harness({ after: [{ errors: ["An account with this email already exists."] }] });
  const result = await h.run();
  assert.equal(result.error_kind, "email_already_registered");
  assert.equal(result.next_step, "sign_in");
});

test("fields that do not hold their values are not submitted", async () => {
  const h = harness({ fieldsHold: false });
  assert.equal((await h.run()).submission_attempted, false);
  assert.equal(h.calls.submits, 0);
});

test("the per-tab guard blocks a second sign-up", async () => {
  const h = harness({ initial: form, guarded: true });
  const result = await h.run();
  assert.equal(result.error_kind, "unknown");
  assert.equal(h.calls.submits, 0);
});

test("a challenge without the form is reported, not solved", async () => {
  const h = harness({ signupPage: { ...base, host: signupHost, url: "https://identity.doordash.com/", challenge: "Verify you are human" } });
  assert.equal((await h.run()).error_kind, "captcha_or_challenge");
});

test("otp mode requires a visible code step", async () => {
  const h = harness({ initial: form });
  const result = await h.run({ email: input.email, otp: "123456" });
  assert.equal(result.error_kind, "unknown");
  assert.equal(h.calls.otp, null);
});

test("otp success is confirmed by the session cookie and the profile email", async () => {
  const h = harness({ initial: code, after: [{ ...base, cookie: true }] });
  const result = await h.run({ email: input.email, otp: "123456" });
  assert.equal(result.registered, true);
  assert.equal(result.account_hint, "q***@example.invalid");
  assert.equal(h.calls.otp, "123456");
  assert.deepEqual(h.calls.navigations, [profileUrl]);
});

test("a profile showing another email is never success", async () => {
  const h = harness({ initial: code, after: [{ ...base, cookie: true }], profileEmail: "someone@example.invalid" });
  const result = await h.run({ email: input.email, otp: "123456" });
  assert.equal(result.registered, false);
  assert.doesNotMatch(result.error_message, /someone@/);
});

test("a signed-in header control after the code is success", async () => {
  const h = harness({ initial: code, after: [{ ...home }] });
  assert.equal((await h.run({ email: input.email, otp: "123456" })).registered, true);
});

test("a wrong code is reported as verification_failed", async () => {
  const h = harness({ initial: code, after: [{ errors: ["The code you entered is incorrect."] }] });
  assert.equal((await h.run({ email: input.email, otp: "123456" })).error_kind, "verification_failed");
});
