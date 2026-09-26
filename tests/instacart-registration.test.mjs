import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";

// register and resume_registration are kind:"page"; complete_registration is kind:"cdp".
// The harness models Instacart's sign-up page as a small fake DOM plus the site's GraphQL
// endpoint. Page tools are re-created from execute.toString() inside the fake page, the way
// the runtime materializes them; the cdp tool's js() calls run their functions in that page.

const names = ["register", "complete_registration", "resume_registration"];
const sources = Object.fromEntries(names.map(name => [name, readFileSync(new URL(`../domains/instacart.com/${name}.js`, import.meta.url), "utf8")]));
const plain = value => JSON.parse(JSON.stringify(value));
const email = "qa.signup@example.invalid";
const phone = "5135550142";
const origin = "https://www.instacart.com";

function conforms(schema, value) {
  if ("const" in schema && value !== schema.const) return false;
  if (schema.enum && !schema.enum.includes(value)) return false;
  if (schema.type && ![schema.type].flat().some(type => {
    if (type === "null") return value === null;
    if (type === "integer") return Number.isInteger(value);
    if (type === "object") return value !== null && typeof value === "object" && !Array.isArray(value);
    if (type === "array") return Array.isArray(value);
    return typeof value === type;
  })) return false;
  if (schema.oneOf && schema.oneOf.filter(s => conforms(s, value)).length !== 1) return false;
  if (schema.not && conforms(schema.not, value)) return false;
  if (schema.required?.some(key => !Object.hasOwn(value, key))) return false;
  if (schema.properties && value !== null && typeof value === "object") {
    if (Object.entries(schema.properties).some(([key, s]) => key in value && !conforms(s, value[key]))) return false;
    if (schema.additionalProperties === false && Object.keys(value).some(key => !(key in schema.properties))) return false;
  }
  if (Array.isArray(value) && schema.items && !value.every(v => conforms(schema.items, v))) return false;
  if (typeof value === "string") {
    if (value.length < (schema.minLength ?? 0) || value.length > (schema.maxLength ?? Infinity)) return false;
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) return false;
    if (schema.format === "uri" && !URL.canParse(value)) return false;
    if (schema.format === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return false;
  }
  return true;
}

const smsConsent = "By providing your phone number, you consent to receive a text with verification code, messages from Instacart related to your orders, deliveries, and account. Reply STOP to opt out. Terms of Service, Privacy Policy & Health Data Notice.";
const hintFor = target => target.includes("@") ? `We sent a 6-digit code to ${target}. It expires soon` : `We sent a 6-digit code to (${target.slice(0, 3)}) ${target.slice(3, 6)}-${target.slice(6)}.`;

function harness(name, options = {}) {
  const page = {
    path: options.path ?? "/signup",
    host: options.host ?? "www.instacart.com",
    proxy: options.proxy ?? false,
    mode: options.mode ?? (options.path && options.path !== "/signup" ? "none" : "email"),
    codeFor: options.codeFor ?? null,
    welcome: options.welcome ?? false,
    codeValue: "", emailValue: "", telValue: "",
    boxes: plain(options.emailCheckboxes ?? []),
    extraFields: plain(options.extraFields ?? []),
    extraValues: {},
    fieldError: null, codeError: options.codeError ?? null, alerts: options.alerts ?? [],
    challenge: options.challenge ?? null, captcha: false,
    loggedInAs: options.loggedInAs ?? null, guest: options.guest ?? false
  };
  if (options.mode === "phone") page.boxes = [{ checked: false, label: smsConsent }];
  const calls = { fetches: [], submits: 0, keys: [], boxClicks: 0, toggles: [], inputEvents: 0, navigations: [], storageWrites: 0 };
  const storage = new Map(Object.entries(options.storage ?? {}));
  let clock = 1_000_000;
  let submittedAt = null;
  let jsFailures = options.jsFailuresAfterCode ?? 0;
  let spinnerUntil = null;
  const settle = () => { if (spinnerUntil !== null && clock >= spinnerUntil) { spinnerUntil = null; page.mode = "code"; page.codeError = "That code is incorrect. Please try again."; } };

  const location = {
    get href() { return `https://${page.host}${page.path}`; },
    get pathname() { return page.path; },
    get protocol() { return "https:"; },
    get hostname() { return page.host; },
    get origin() { return `https://${page.host}`; }
  };

  class FakeElement {
    constructor(tagName, props = {}) { Object.assign(this, { tagName, innerText: "", textContent: "", parentElement: null, attrs: {}, src: "" }, props); }
    getClientRects() { return [{}]; }
    getBoundingClientRect() { return { width: 400, height: 40 }; }
    checkVisibility() { return true; }
    getAttribute(name) { return this.attrs[name] ?? null; }
    closest(selector) { let n = this; while (n) { if (selector === "form" && n.tagName === "FORM") return n; n = n.parentElement; } return null; }
    querySelectorAll() { return []; }
    dispatchEvent(event) { if (event.type === "input") calls.inputEvents++; return true; }
    click() { this.onClick?.(); }
  }
  class FakeInput extends FakeElement {
    get value() { return this.read(); }
    set value(v) { this.write(v); }
  }

  const form = () => {
    const f = new FakeElement("FORM");
    const inputs = [];
    if (page.mode === "email") inputs.push(new FakeInput("INPUT", { type: "email", name: "email", autocomplete: "email", read: () => page.emailValue, write: v => { if (!options.fillIgnored) page.emailValue = v; } }));
    if (page.mode === "phone") inputs.push(new FakeInput("INPUT", { type: "tel", name: "", autocomplete: "tel-national", read: () => page.telValue, write: v => { if (!options.fillIgnored) page.telValue = String(v).replace(/\D/g, ""); } }));
    for (const field of page.extraFields) inputs.push(new FakeInput("INPUT", { type: "text", name: field.name, autocomplete: field.autocomplete, placeholder: field.label, required: field.required, read: () => page.extraValues[field.name] ?? "", write: v => { page.extraValues[field.name] = v; } }));
    if (page.fieldError) for (const input of inputs.slice(0, 1)) input.attrs = { "aria-invalid": "true", "aria-describedby": "field-error" };
    const boxes = page.boxes.map((box, index) => {
      const label = new FakeElement("LABEL", { innerText: box.label, parentElement: f });
      const inner = new FakeElement("LABEL", { parentElement: label });
      return new FakeInput("INPUT", { type: "checkbox", parentElement: inner, get checked() { return page.boxes[index].checked; }, read: () => "on", write: () => {}, onClick: () => { calls.boxClicks++; page.boxes[index].checked = !page.boxes[index].checked; } });
    });
    const submit = new FakeElement("BUTTON", { type: "submit", innerText: "Continue", onClick: () => submitForm() });
    for (const e of [...inputs, ...boxes, submit]) if (!e.parentElement) e.parentElement = f;
    f.querySelectorAll = selector => {
      if (selector === 'button[type="submit"]') return [submit];
      if (selector === 'input[type="checkbox"]') return boxes;
      if (selector === "input") return [...inputs, ...boxes];
      return [];
    };
    return { inputs, boxes, submit };
  };

  const submitForm = () => {
    calls.submits++;
    submittedAt = clock;
    const target = page.mode === "phone" ? page.telValue : page.emailValue;
    const outcome = options.afterSubmit ?? "code";
    if (outcome === "code") { page.mode = "code"; page.codeFor = options.codeFor ?? target; }
    else if (outcome === "welcome") { page.mode = "code"; page.welcome = true; page.codeFor = target; }
    else if (outcome === "error") page.fieldError = options.siteError ?? "Enter a valid email address.";
    else if (outcome === "alert") page.alerts = [options.siteError];
    else if (outcome === "captcha") page.captcha = true;
    else if (outcome === "proxy") page.proxy = true;
  };

  const headings = () => [page.welcome && page.mode === "code" ? "Welcome back" : page.mode === "code" ? "Verify email" : "$0 delivery fee", page.challenge].filter(Boolean);
  const byId = {
    "field-error": () => page.fieldError && new FakeElement("DIV", { innerText: page.fieldError }),
    "code-error": () => page.codeError && new FakeElement("DIV", { innerText: page.codeError }),
    "node-apollo-state": () => options.noToken ? null : new FakeElement("SCRIPT", { textContent: encodeURIComponent(JSON.stringify({ ROOT: { auth: { authConfigurationToken: "act.fixture" } } })) })
  };
  const document = {
    get body() {
      if (page.proxy) return new FakeElement("BODY", { innerText: "egress-proxy-mitm encountered an unexpected EOF" });
      return new FakeElement("BODY", { innerText: [...headings(), page.mode === "code" ? hintFor(page.codeFor) : "", ...page.alerts].join(" ") });
    },
    getElementById: id => byId[id]?.() || null,
    querySelector: selector => document.querySelectorAll(selector)[0] ?? null,
    querySelectorAll: selector => {
      settle();
      if (page.proxy) return [];
      const current = ["email", "phone"].includes(page.mode) ? form() : null;
      if (selector === 'input[type="email"][name="email"]') return current ? current.inputs.filter(i => i.type === "email") : [];
      if (selector === 'input[type="tel"]') return current ? current.inputs.filter(i => i.type === "tel") : [];
      if (selector === 'input[type="email"][name="email"], input[type="tel"]') return current ? current.inputs.filter(i => ["email", "tel"].includes(i.type)) : [];
      if (selector === 'input[autocomplete="one-time-code"]') return page.mode === "code" ? [new FakeInput("INPUT", { autocomplete: "one-time-code", attrs: page.codeError ? { "aria-invalid": "true", "aria-describedby": "code-error" } : {}, read: () => page.codeValue, write: () => {} })] : [];
      if (selector === "h1,h2,h3") return headings().map(t => new FakeElement("H2", { innerText: t }));
      if (selector === "p,div,span") return page.mode === "code" ? [new FakeElement("DIV", { innerText: `${headings()[0]} ${hintFor(page.codeFor)} Didn't receive a code?` }), new FakeElement("P", { innerText: hintFor(page.codeFor) })] : [];
      if (selector === '[role="alert"]') return page.alerts.map(t => new FakeElement("DIV", { innerText: t }));
      if (selector === "iframe") return page.captcha ? [new FakeElement("IFRAME", { src: "https://www.google.com/recaptcha/api2/bframe?k=x" })] : [];
      if (selector === "button") {
        const toggles = [];
        if (page.mode === "email" && !options.noPhoneToggle) toggles.push(new FakeElement("BUTTON", { innerText: "Phone", onClick: () => { calls.toggles.push("Phone"); page.mode = "phone"; page.boxes = plain(options.phoneCheckboxes ?? [{ checked: false, label: smsConsent }]); } }));
        if (page.mode === "phone") toggles.push(new FakeElement("BUTTON", { innerText: "Email", onClick: () => { calls.toggles.push("Email"); page.mode = "email"; page.boxes = plain(options.emailCheckboxes ?? []); } }));
        return toggles;
      }
      return [];
    }
  };

  const sessionStorage = {
    getItem: key => storage.has(key) ? storage.get(key) : null,
    setItem: (key, value) => { calls.storageWrites++; storage.set(key, String(value)); },
    removeItem: key => { storage.delete(key); }
  };

  const respond = (status, body) => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) });
  const fetch = async url => {
    const u = new URL(url);
    const op = u.searchParams.get("operationName");
    calls.fetches.push(op);
    const failure = options.fetchFailures?.[op];
    if (failure === "throw") throw new TypeError("Failed to fetch");
    if (failure === "persisted") return respond(200, { errors: [{ extensions: { code: "PERSISTED_QUERY_NOT_FOUND" } }] });
    if (failure === "http500") return respond(500, {});
    if (failure === "http429") return respond(429, {});
    if (op === "CurrentUser") return respond(200, { data: { currentUser: page.loggedInAs ? { id: "1", guest: page.guest, email: page.loggedInAs.includes("@") ? page.loggedInAs : "" } : (page.guest ? { id: "g", guest: true, email: null } : null) } });
    if (op === "UsersPhoneNumber") return respond(200, { data: { userPhoneNumber: page.loggedInAs && !page.loggedInAs.includes("@") ? { phoneNumber: { phoneNumber: "1" + page.loggedInAs } } : null } });
    if (op === "GetEmailAvailability") return respond(200, { data: { getEmailAvailability: { availability: options.existing ? "unavailable" : "available" } } });
    throw new Error(`unexpected operation ${op}`);
  };

  const pageGlobals = {
    URL, JSON, Event: class { constructor(type) { this.type = type; } },
    Date: { now: () => clock },
    setTimeout: (fn, ms) => { clock += ms; Promise.resolve().then(fn); return 0; },
    document, location, sessionStorage, fetch
  };

  // CDP helpers for complete_registration.
  const helpers = {
    js: async (fn, opts) => {
      if (jsFailures > 0 && page.loggedInAs && submittedAt !== null) { jsFailures--; throw new Error("Execution context was destroyed"); }
      return plain(await fn(opts?.arg === undefined ? undefined : plain(opts.arg)) ?? null);
    },
    click: async selector => { if (selector !== 'input[autocomplete="one-time-code"]') throw new Error(`unexpected click ${selector}`); },
    pressKey: async key => {
      calls.keys.push(key);
      page.codeValue += key;
      if (page.codeValue.length !== 6) return;
      submittedAt = clock;
      const outcome = options.afterCode ?? "success";
      if (outcome === "success") { page.loggedInAs = options.createdAs ?? page.codeFor; page.mode = "none"; page.path = "/store/hub/grocery"; }
      else if (outcome === "rejected") page.codeError = "That code is incorrect. Please try again.";
      else if (outcome === "expired") page.alerts = ["This code has expired. Request a new code."];
      else if (outcome === "logged-out") { page.mode = "none"; page.path = "/store/hub/grocery"; }
      else if (outcome === "spinner-then-rejected") { page.mode = "none"; spinnerUntil = clock + 3000; }
    },
    waitMs: async ms => { clock += ms; },
    waitForLoad: async () => true,
    pageInfo: async () => ({ url: location.href }),
    gotoUrl: async url => { calls.navigations.push(url); throw new Error("the registration tools never navigate"); }
  };

  const definition = runInNewContext(`(${sources[name]})`, { ...pageGlobals, ...helpers })[0];
  const execute = definition.kind === "page"
    ? runInNewContext(`(${definition.execute.toString()})`, pageGlobals)
    : definition.execute;
  return {
    tool: definition, page, calls, storage,
    run: async input => {
      const result = plain(await execute(input, definition.kind === "page" ? { signal: { aborted: false } } : undefined));
      assert.ok(conforms(definition.tool.outputSchema, result), `${name} output violates its schema: ${JSON.stringify(result)}`);
      assert.ok(calls.submits <= 1, "at most one sign-up submission per invocation");
      assert.deepEqual(calls.navigations, [], "the registration tools never navigate");
      assert.ok(!JSON.stringify(result).includes("123456"), "the code is never echoed");
      assert.ok(!JSON.stringify(result).replace(/\D/g, "").includes(phone), "the full phone number is never returned, in any format");
      assert.ok(!JSON.stringify(result).includes("555-0142") || JSON.stringify(result).includes("***-***-0142"), "phone digits appear only masked");
      return result;
    }
  };
}

const reg = extra => ({ email, accept_terms: true, ...extra });
const regSms = extra => ({ phone, channel: "sms", accept_terms: true, accept_sms_terms: true, ...extra });
const done = extra => ({ email, code: "123456", ...extra });
const guardKey = "instacart.com.register.submitted.v1";
const codeGuardKey = "instacart.com.register.code_submitted.v1";

// ---------------------------------------------------------------- contract

const kinds = { register: "page", complete_registration: "cdp", resume_registration: "page" };
for (const name of names) {
  test(`${name}: single-expression ${kinds[name]} tool with domain patterns, typed schemas, no Node globals`, () => {
    const { tool } = harness(name);
    assert.equal(tool.kind, kinds[name]);
    assert.equal(tool.tool.name, name);
    assert.deepEqual(plain(tool.match.url_patterns), ["https://instacart.com/*", "https://*.instacart.com/*"]);
    assert.equal(tool.tool.inputSchema.type, "object");
    assert.ok(tool.tool.outputSchema.oneOf.length >= 2);
    assert.equal(/;\s*$/.test(sources[name]), false);
    assert.equal(/\b(?:Buffer|require|process)\b/.test(sources[name]), false);
    if (tool.kind === "page") {
      assert.equal(typeof new Function(`return (${tool.execute.toString()})`)(), "function");
      assert.equal(/\b(?:gotoUrl|js|pressKey|waitMs|waitForLoad|accessibilitySnapshot|fillInput)\(/.test(tool.execute.toString()), false, "page tools use no CDP helpers");
    }
  });
}

test("registry lists the registration tools with matching kind and patterns", () => {
  const registry = JSON.parse(readFileSync(new URL("../registry.json", import.meta.url), "utf8"));
  for (const name of names) {
    const entry = registry.tools.find(t => t.domain === "instacart.com" && t.tool === name);
    assert.ok(entry, name);
    assert.equal(entry.file, `domains/instacart.com/${name}.js`);
    assert.equal(entry.kind, kinds[name]);
    assert.deepEqual(entry.url_patterns, plain(harness(name).tool.match.url_patterns));
  }
});

// ---------------------------------------------------------------- input validation

const invalid = {
  register: [undefined, {}, { email }, { email: "a@b.c", accept_terms: true }, { phone: "513abc5550142", channel: "sms", accept_terms: true, accept_sms_terms: true }, { email, accept_terms: false }, { email: "not-an-email", accept_terms: true }, { email, phone, accept_terms: true },
    { phone: "123", channel: "sms", accept_terms: true, accept_sms_terms: true }, { email, channel: "sms", accept_terms: true }, { email, accept_terms: true, accept_sms_terms: true },
    { email, accept_terms: true, first_name: "" }, { email, accept_terms: true, password: "x" }, { phone, channel: "sms", accept_terms: true }, { email, accept_terms: true, channel: "fax" }],
  complete_registration: [undefined, {}, { email }, { email, code: "12345" }, { email, code: 123456 }, { email, code: "12345a" }, { code: "123456" }, { email, phone, code: "123456" }, { email, code: "123456", extra: 1 }],
  resume_registration: [undefined, {}, { email: "x" }, { email, phone }, { phone: "12" }, { email, extra: true }]
};
for (const [name, inputs] of Object.entries(invalid)) {
  for (const input of inputs) {
    test(`${name}: invalid input ${JSON.stringify(input)} is rejected before any page action`, async () => {
      const h = harness(name, { mode: "code", codeFor: email });
      const result = await h.run(input);
      assert.equal(result.status, "error");
      assert.ok(["invalid_input", "terms_not_accepted"].includes(result.error_kind), result.error_kind);
      assert.equal(result.submission_attempted, false);
      assert.deepEqual(h.calls.fetches, []);
      assert.deepEqual(h.calls.keys, []);
      assert.equal(h.calls.inputEvents, 0);
    });
  }
}

// ---------------------------------------------------------------- register

test("register: email sign-up on /signup stops at the code step after one submission", async () => {
  const h = harness("register");
  const result = await h.run(reg());
  assert.equal(result.status, "challenge_sent");
  assert.equal(result.channel, "email");
  assert.equal(result.destination_hint, "q***@example.invalid");
  assert.equal(result.next_step, "complete_registration");
  assert.equal(result.landing_url, `${origin}/signup`);
  assert.equal(result.submission_attempted, true);
  assert.equal(result.resumed, false);
  assert.deepEqual(h.calls.fetches, ["CurrentUser", "GetEmailAvailability"]);
  assert.equal(h.calls.submits, 1);
  assert.equal(h.page.emailValue, email);
  assert.ok(h.calls.inputEvents >= 1, "the value is announced with input events");
  assert.ok(h.storage.has(guardKey));
});

test("register: an existing email is detected read-only and nothing is filled or submitted", async () => {
  const h = harness("register", { existing: true });
  const result = await h.run(reg());
  assert.equal(result.status, "existing_account");
  assert.equal(result.code_sent, false);
  assert.equal(result.next_step, "login");
  assert.equal(result.submission_attempted, false);
  assert.equal(h.calls.submits, 0);
  assert.equal(h.calls.inputEvents, 0);
  assert.equal(h.storage.size, 0);
});

test("register: a submission routed to the log-in path is existing_account with code_sent null", async () => {
  const result = await harness("register", { afterSubmit: "welcome" }).run(reg());
  assert.equal(result.status, "existing_account");
  assert.equal(result.code_sent, null);
  assert.equal(result.submission_attempted, true);
});

test("register: a signed-in browser is refused before the availability lookup", async () => {
  const h = harness("register", { loggedInAs: "someone@example.invalid" });
  const result = await h.run(reg());
  assert.equal(result.error_kind, "logged_in_session");
  assert.equal(result.submission_attempted, false);
  assert.deepEqual(h.calls.fetches, ["CurrentUser"]);
});

test("register: an implicit guest session counts as signed out", async () => {
  assert.equal((await harness("register", { guest: true }).run(reg())).status, "challenge_sent");
});

test("register: an open code step for the same address resumes without submitting", async () => {
  const h = harness("register", { mode: "code", codeFor: email });
  const result = await h.run(reg());
  assert.equal(result.status, "challenge_sent");
  assert.equal(result.resumed, true);
  assert.equal(result.submission_attempted, false);
  assert.equal(h.calls.submits, 0);
  assert.deepEqual(h.calls.fetches, []);
});

test("register: a log-in code step for another address is refused, not reported as this identity's account", async () => {
  const h = harness("register", { mode: "code", welcome: true, codeFor: "other@example.invalid" });
  const result = await h.run(reg());
  assert.equal(result.status, "error");
  assert.match(result.error_message, /different or unidentified address/);
});

test("register: a banner already on the page is not taken as this submission's verdict", async () => {
  const stale = harness("register", { alerts: ["Something went wrong. Please try again."], afterSubmit: "nothing" });
  const result = await stale.run(reg());
  assert.equal(result.error_kind, "unknown");
  assert.match(result.error_message, /no verification step appeared/);
  const ok = harness("register", { alerts: ["Something went wrong. Please try again."] });
  assert.equal((await ok.run(reg())).status, "challenge_sent");
});

test("register: site text that repeats the address is masked", async () => {
  const sms = await harness("register").run(regSms());
  assert.match(sms.evidence, /\*\*\*-\*\*\*-0142/);
  const banner = await harness("register", { afterSubmit: "alert", siteError: `We couldn't send a code to ${email}.` }).run(reg());
  assert.ok(!banner.error_message.includes(email));
  assert.ok(banner.error_message.includes("q***@example.invalid"));
});

test("register: an open code step for another address is refused", async () => {
  const h = harness("register", { mode: "code", codeFor: "other@example.invalid" });
  const result = await h.run(reg());
  assert.equal(result.error_kind, "unknown");
  assert.match(result.error_message, /different or unidentified address/);
  assert.equal(h.calls.submits, 0);
});

test("register: the sessionStorage guard blocks a second submission in the same tab", async () => {
  const h = harness("register", { storage: { [guardKey]: String(1_000_000 - 60_000) } });
  const result = await h.run(reg());
  assert.equal(result.error_kind, "unknown");
  assert.match(result.error_message, /resume_registration/);
  assert.equal(h.calls.submits, 0);
});

test("register: an expired guard no longer blocks", async () => {
  assert.equal((await harness("register", { storage: { [guardKey]: String(1_000_000 - 16 * 60_000) } }).run(reg())).status, "challenge_sent");
});

for (const scenario of [
  { name: "another Instacart page", options: { path: "/store" } },
  { name: "the log-in page", options: { path: "/login", mode: "email" } },
  { name: "a proxy error page", options: { proxy: true } }
]) {
  test(`register: ${scenario.name} returns wrong_page with the sign-up URL`, async () => {
    const h = harness("register", scenario.options);
    const result = await h.run(reg());
    assert.equal(result.error_kind, "wrong_page");
    assert.equal(result.next_url, `${origin}/signup`);
    assert.equal(result.submission_attempted, false);
    assert.equal(h.calls.submits, 0);
    assert.ok(!h.calls.fetches.includes("GetEmailAvailability"));
  });
}

test("register: sms sign-up switches to the phone form, ticks only the required consent and masks the number", async () => {
  const h = harness("register");
  const result = await h.run(regSms());
  assert.equal(result.status, "challenge_sent");
  assert.equal(result.channel, "sms");
  assert.equal(result.destination_hint, "***-***-0142");
  assert.deepEqual(h.calls.toggles, ["Phone"]);
  assert.equal(h.calls.boxClicks, 1);
  assert.deepEqual(h.calls.fetches, ["CurrentUser"]);
  assert.equal(h.calls.submits, 1);
  assert.equal(h.page.telValue, phone);
});

test("register: email sign-up switches back from the phone form", async () => {
  const h = harness("register", { mode: "phone" });
  assert.equal((await h.run(reg())).status, "challenge_sent");
  assert.deepEqual(h.calls.toggles, ["Email"]);
});

test("register: sms without a Phone option on the page is site_changed", async () => {
  const h = harness("register", { noPhoneToggle: true });
  const result = await h.run(regSms());
  assert.equal(result.error_kind, "site_changed");
  assert.equal(h.calls.submits, 0);
});

test("register: a pre-ticked optional marketing box stops the submission", async () => {
  const h = harness("register", { emailCheckboxes: [{ checked: true, label: "Send me offers and promotions by email" }] });
  const result = await h.run(reg());
  assert.equal(result.error_kind, "unknown");
  assert.match(result.error_message, /pre-ticked optional box/);
  assert.equal(h.calls.submits, 0);
  assert.equal(h.storage.size, 0);
});

test("register: an unticked marketing box is left unticked", async () => {
  const h = harness("register", { emailCheckboxes: [{ checked: false, label: "Send me offers and promotions by email" }] });
  assert.equal((await h.run(reg())).status, "challenge_sent");
  assert.equal(h.calls.boxClicks, 0);
  assert.equal(h.page.boxes[0].checked, false);
});

test("register: a required terms checkbox is ticked because accept_terms is true", async () => {
  const h = harness("register", { emailCheckboxes: [{ checked: false, label: "I agree to the Terms of Service and Privacy Policy" }] });
  assert.equal((await h.run(reg())).status, "challenge_sent");
  assert.equal(h.calls.boxClicks, 1);
});

test("register: required name fields that were not supplied stop before submission; supplied ones are filled", async () => {
  const fields = [{ name: "firstName", autocomplete: "given-name", label: "First name", required: true }, { name: "lastName", autocomplete: "family-name", label: "Last name", required: true }];
  const missing = harness("register", { extraFields: fields });
  const result = await missing.run(reg());
  assert.equal(result.error_kind, "additional_info_required");
  assert.deepEqual(result.missing_fields, ["first_name", "last_name"]);
  assert.equal(missing.calls.submits, 0);
  const supplied = harness("register", { extraFields: fields });
  assert.equal((await supplied.run(reg({ first_name: "Qa", last_name: "Tester" }))).status, "challenge_sent");
  assert.deepEqual(supplied.page.extraValues, { firstName: "Qa", lastName: "Tester" });
});

test("register: a form that ignores the typed value is not submitted", async () => {
  const h = harness("register", { fillIgnored: true });
  const result = await h.run(reg());
  assert.equal(result.error_kind, "unknown");
  assert.match(result.error_message, /did not receive/);
  assert.equal(h.calls.submits, 0);
});

for (const scenario of [
  { name: "site field error", options: { afterSubmit: "error", siteError: "Enter a valid email address." }, kind: "invalid_input" },
  { name: "rate limit", options: { afterSubmit: "alert", siteError: "Too many attempts. Try again later." }, kind: "locked_or_throttled" },
  { name: "unresolved captcha", options: { afterSubmit: "captcha" }, kind: "captcha_or_challenge" },
  { name: "no visible outcome", options: { afterSubmit: "nothing" }, kind: "unknown" },
  { name: "proxy error after submit", options: { afterSubmit: "proxy" }, kind: "unknown" },
  { name: "code step for another address", options: { codeFor: "other@example.invalid" }, kind: "unknown" }
]) {
  test(`register: post-submit ${scenario.name} is ${scenario.kind} without a retry`, async () => {
    const h = harness("register", scenario.options);
    const result = await h.run(reg());
    assert.equal(result.error_kind, scenario.kind, result.error_message);
    assert.equal(result.submission_attempted, true);
    assert.equal(result.stage, "after_submit");
    assert.equal(h.calls.submits, 1);
  });
}

test("register: a conclusive invalid-address rejection releases the guard; uncertain outcomes keep it", async () => {
  const rejected = harness("register", { afterSubmit: "error" });
  await rejected.run(reg());
  assert.equal(rejected.storage.has(guardKey), false);
  const uncertain = harness("register", { afterSubmit: "captcha" });
  await uncertain.run(reg());
  assert.equal(uncertain.storage.has(guardKey), true);
});

for (const scenario of [
  { name: "current-user lookup retired", options: { fetchFailures: { CurrentUser: "persisted" } }, kind: "site_changed" },
  { name: "current-user lookup failed", options: { fetchFailures: { CurrentUser: "http500" } }, kind: "unknown" },
  { name: "current-user fetch threw", options: { fetchFailures: { CurrentUser: "throw" } }, kind: "unknown" },
  { name: "availability lookup retired", options: { fetchFailures: { GetEmailAvailability: "persisted" } }, kind: "site_changed" },
  { name: "availability throttled", options: { fetchFailures: { GetEmailAvailability: "http429" } }, kind: "locked_or_throttled" },
  { name: "no auth configuration token", options: { noToken: true }, kind: "unknown" },
  { name: "challenge on the sign-up page", options: { challenge: "Verify you are human" }, kind: "captcha_or_challenge" }
]) {
  test(`register: ${scenario.name} fails before any submission`, async () => {
    const h = harness("register", scenario.options);
    const result = await h.run(reg());
    assert.equal(result.error_kind, scenario.kind, result.error_message);
    assert.equal(result.submission_attempted, false);
    assert.equal(h.calls.submits, 0);
    assert.equal(h.storage.size, 0);
  });
}

// ---------------------------------------------------------------- complete_registration

const codeStep = extra => ({ mode: "code", codeFor: email, ...extra });

test("complete_registration: types the code once and verifies the new account from current-user data", async () => {
  const h = harness("complete_registration", codeStep());
  const result = await h.run(done());
  assert.equal(result.status, "registered");
  assert.equal(result.authenticated, true);
  assert.equal(result.account_hint, "q***@example.invalid");
  assert.equal(result.landing_url, `${origin}/store/hub/grocery`);
  assert.deepEqual(h.calls.keys, ["1", "2", "3", "4", "5", "6"]);
  assert.ok(h.calls.fetches.includes("CurrentUser"));
});

test("complete_registration: survives the site replacing the page while the session is read", async () => {
  const h = harness("complete_registration", codeStep({ jsFailuresAfterCode: 3 }));
  assert.equal((await h.run(done())).status, "registered");
});

test("complete_registration: a session for another account is wrong_account, never success", async () => {
  const h = harness("complete_registration", codeStep({ createdAs: "someone.else@example.invalid" }));
  const result = await h.run(done());
  assert.equal(result.error_kind, "wrong_account");
  assert.equal(result.submission_attempted, true);
  assert.ok(!result.error_message.includes("someone.else"));
});

test("complete_registration: sms sign-up matches the account phone number, country code included", async () => {
  const h = harness("complete_registration", codeStep({ codeFor: phone }));
  const result = await h.run({ phone, code: "123456" });
  assert.equal(result.status, "registered");
  assert.equal(result.account_hint, "***-***-0142");
  assert.ok(h.calls.fetches.includes("UsersPhoneNumber"));
});

for (const scenario of [
  { name: "wrong code", afterCode: "rejected", kind: "code_rejected" },
  { name: "expired code", afterCode: "expired", kind: "code_expired" },
  { name: "no result", afterCode: "stale", kind: "unknown" },
  { name: "code step closed without a session", afterCode: "logged-out", kind: "unknown" },
  { name: "rejection after the code field briefly disappears", afterCode: "spinner-then-rejected", kind: "code_rejected" }
]) {
  test(`complete_registration: ${scenario.name} is ${scenario.kind} and the code is typed once`, async () => {
    const h = harness("complete_registration", codeStep({ afterCode: scenario.afterCode }));
    const result = await h.run(done());
    assert.equal(result.error_kind, scenario.kind, result.error_message);
    assert.equal(result.submission_attempted, true);
    assert.equal(h.calls.keys.length, 6);
  });
}

test("complete_registration: a stale code error does not count as this code's verdict", async () => {
  const h = harness("complete_registration", codeStep({ codeError: "That code is incorrect. Please try again.", afterCode: "stale" }));
  const result = await h.run(done());
  assert.equal(result.error_kind, "unknown");
  assert.match(result.error_message, /30 seconds/);
});

for (const scenario of [
  { name: "no code step", options: { path: "/store", mode: "none" }, kind: "no_pending_registration" },
  { name: "code step for another address", options: codeStep({ codeFor: "other@example.invalid" }), kind: "wrong_account" },
  { name: "log-in code step for an existing account", options: codeStep({ welcome: true }), kind: "existing_account" },
  { name: "proxy error page", options: { proxy: true }, kind: "navigation_failed" },
  { name: "challenge", options: codeStep({ challenge: "Verify you are human" }), kind: "captcha_or_challenge" }
]) {
  test(`complete_registration: ${scenario.name} types no code`, async () => {
    const h = harness("complete_registration", scenario.options);
    const result = await h.run(done());
    assert.equal(result.error_kind, scenario.kind, result.error_message);
    assert.equal(result.submission_attempted, false);
    assert.deepEqual(h.calls.keys, []);
  });
}

test("complete_registration: the guard blocks a second code entry; a rejection releases it", async () => {
  const blocked = harness("complete_registration", codeStep({ storage: { [codeGuardKey]: String(1_000_000 - 10_000) } }));
  assert.equal((await blocked.run(done())).error_kind, "unknown");
  assert.deepEqual(blocked.calls.keys, []);
  const rejected = harness("complete_registration", codeStep({ afterCode: "rejected" }));
  await rejected.run(done());
  assert.equal(rejected.storage.has(codeGuardKey), false);
});

// ---------------------------------------------------------------- resume_registration

for (const scenario of [
  { name: "open code step", options: codeStep(), status: "challenge_pending", next: "complete_registration" },
  { name: "log-in code step", options: codeStep({ welcome: true }), status: "existing_account", next: "login" },
  { name: "matching signed-in account", options: { path: "/store/hub/grocery", loggedInAs: email }, status: "registered", next: "none" },
  { name: "signed-out page", options: { path: "/store" }, status: "nothing_pending", next: "register" },
  { name: "guest session", options: { path: "/store", guest: true }, status: "nothing_pending", next: "register" }
]) {
  test(`resume_registration: ${scenario.name} is ${scenario.status} and changes nothing`, async () => {
    const h = harness("resume_registration", scenario.options);
    const result = await h.run({ email });
    assert.equal(result.status, scenario.status);
    assert.equal(result.next_step, scenario.next);
    assert.equal(h.calls.submits, 0);
    assert.equal(h.calls.storageWrites, 0);
    assert.equal(h.calls.inputEvents, 0);
    assert.ok(!h.calls.fetches.includes("GetEmailAvailability"));
  });
}

test("resume_registration: sms identity is matched on the phone number", async () => {
  const result = await harness("resume_registration", { path: "/store", loggedInAs: phone }).run({ phone });
  assert.equal(result.status, "registered");
  assert.equal(result.destination_hint, "***-***-0142");
});

test("resume_registration: another signed-in account is wrong_account with a masked hint", async () => {
  const result = await harness("resume_registration", { path: "/store", loggedInAs: "someone@example.invalid" }).run({ email });
  assert.equal(result.error_kind, "wrong_account");
  assert.ok(result.error_message.includes("s***@example.invalid"));
  assert.ok(!result.error_message.includes("someone@"));
});

test("resume_registration: a code step for another address is wrong_account", async () => {
  assert.equal((await harness("resume_registration", codeStep({ codeFor: "other@example.invalid" })).run({ email })).error_kind, "wrong_account");
});

test("resume_registration: an unreadable session is unknown, not nothing_pending", async () => {
  const result = await harness("resume_registration", { path: "/store", fetchFailures: { CurrentUser: "http500" } }).run({ email });
  assert.equal(result.error_kind, "unknown");
});

test("resume_registration: a proxy error page is navigation_failed", async () => {
  assert.equal((await harness("resume_registration", { proxy: true }).run({ email })).error_kind, "navigation_failed");
});
