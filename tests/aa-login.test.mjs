import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../domains/aa.com/login.js", import.meta.url), "utf8");
const searchHome = "https://start.duckduckgo.com/";
const searchUrl = "https://start.duckduckgo.com/?q=american+airlines+login&ia=web";
const loginUrl = "https://login.aa.com/login?flowId=fixture";
const input = { username: "qa_nonexistent", password: "synthetic-only" };
const plain = value => JSON.parse(JSON.stringify(value));

function conforms(schema, value) {
  if ("const" in schema && schema.const !== value) return false;
  if (schema.enum && !schema.enum.includes(value)) return false;
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some(type => type === "null" ? value === null : type === "object" ? value !== null && typeof value === "object" && !Array.isArray(value) : type === "integer" ? Number.isInteger(value) : typeof value === type)) return false;
  }
  if (typeof value === "string" && schema.minLength !== undefined && value.length < schema.minLength) return false;
  if (typeof value === "number" && schema.minimum !== undefined && value < schema.minimum) return false;
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    if (schema.required?.some(key => !Object.hasOwn(value, key))) return false;
    if (schema.additionalProperties === false && Object.keys(value).some(key => !Object.hasOwn(schema.properties ?? {}, key))) return false;
    for (const [key, property] of Object.entries(schema.properties ?? {})) {
      if (Object.hasOwn(value, key) && !conforms(property, value[key])) return false;
    }
  }
  if (schema.oneOf && schema.oneOf.filter(branch => conforms(branch, value)).length !== 1) return false;
  if (schema.anyOf && !schema.anyOf.some(branch => conforms(branch, value))) return false;
  if (schema.not && conforms(schema.not, value)) return false;
  return true;
}

function harness(options = {}) {
  let clock = 0, checks = 0, clicks = 0, searchClicks = 0, filled = 0, reads = 0, priorClicks = 0;
  let url = options.url ?? loginUrl;
  let state = { url, host: new URL(url).hostname, username: true, password: true, filled: true, challenge: null, alerts: [], ...options.initial };
  const navigation = [], pageFunctions = {}, storage = new Map();
  const arrive = () => {
    url = loginUrl;
    state = { ...state, url, host: "login.aa.com", username: true, password: true, filled: false, ...options.navigationState };
  };
  const tools = runInNewContext(`(${source})`, {
    URL, Date: { now: () => clock },
    pageInfo: async () => ({ url }),
    waitMs: async ms => { clock += ms; },
    gotoUrl: async target => {
      assert.ok([searchHome, searchUrl].includes(target), "entry navigation must stay on DDG");
      navigation.push(target);
      if (options.navigationFailure === target) throw new Error("Navigation outcome uncertain");
      url = target;
    },
    click: async selector => {
      assert.equal(selector, '[data-aa-login-result="true"]');
      searchClicks++;
      if (options.searchClickFailure) throw new Error("Click outcome uncertain");
      arrive();
    },
    accessibilitySnapshot: async () => ({ nodes: clicks > priorClicks ? options.afterNodes ?? [] : options.initialNodes ?? [] }),
    js: async (fn, args) => {
      const text = fn.toString();
      if (text.includes('article[data-testid="result"]')) {
        pageFunctions.search = fn;
        if (options.searchInspectionFailure === (args.arg.selectResult ? "results" : "home")) throw new Error("Search inspection failed");
        return args.arg.selectResult ? options.searchResult ?? "ready" : options.searchHomeResult ?? "clear";
      }
      if (text.includes("const all =")) {
        reads++;
        return { ...state, ...(clicks > priorClicks ? options.after ?? { challenge: "Challenge Content" } : {}) };
      }
      if (args?.arg?.username !== undefined) {
        assert.equal(new URL(url).origin, "https://login.aa.com");
        filled++;
        pageFunctions.fill = fn;
        return options.fillMatches ?? true;
      }
      if (text.includes("const key =")) {
        const button = { disabled: false, getAttribute: () => "false", click: () => { clicks++; } };
        const host = { tagName: "ADC-BUTTON", textContent: "Log in", getClientRects: () => [{}], shadowRoot: { querySelector: () => button } };
        return runInNewContext(`(${fn})()`, {
          location: { origin: "https://login.aa.com" },
          document: { querySelectorAll: () => [host] },
          sessionStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) }
        });
      }
      checks++;
      return checks >= (options.enableAfter ?? 1);
    }
  });
  return { tool: tools[0], navigation, pageFunctions, stats: () => ({ checks, clicks, searchClicks, filled, reads, clock }), clearResult: () => { priorClicks = clicks; } };
}

async function invoke(h, ...values) {
  const result = await h.tool.execute(values.length ? values[0] : input);
  assert.ok(conforms(h.tool.tool.outputSchema, result), JSON.stringify(result));
  return result;
}

test("single self-contained expression declares the domain patterns and both outcome categories", () => {
  const { tool } = harness();
  assert.equal(tool.kind, "cdp");
  assert.equal(tool.tool.name, "login");
  assert.deepEqual(plain(tool.match.url_patterns), ["https://aa.com/*", "https://*.aa.com/*"]);
  assert.equal(tool.tool.inputSchema.type, "object");
  assert.equal(tool.tool.outputSchema.type, "object");
  assert.deepEqual(plain(tool.tool.outputSchema.oneOf.map(b => b.properties.outcome.const)), ["authenticated", "mfa_required", "human_assist_required", "failure"]);
});

for (const url of ["about:blank", "https://example.org/", "https://aa.com/", "https://help.aa.com/", "https://www.aa.com/homePage.do", "https://login.aa.com/help"]) {
  test(`navigates to the login entry from ${url}`, async () => {
    const h = harness({ url });
    const result = await invoke(h);
    assert.deepEqual(h.navigation, [searchHome, searchUrl]);
    assert.equal(h.stats().searchClicks, 1);
    assert.equal(h.stats().clicks, 1);
    assert.equal(result.outcome, "human_assist_required");
    assert.equal(result.reason, "captcha_or_challenge");
  });
}

test("reuses a suitable login form and waits for delayed button enablement", async () => {
  const h = harness({ enableAfter: 3 });
  const result = await invoke(h);
  assert.deepEqual(h.navigation, []);
  assert.equal(h.stats().checks, 3);
  assert.equal(h.stats().clicks, 1);
  assert.equal(h.stats().filled, 1);
  assert.equal(result.submission_attempted, true);
  assert.equal(result.observation, "after_submission");
  assert.equal(result.outcome, "human_assist_required");
  assert.equal(h.stats().clock, 950, "stop at the first CAPTCHA observation instead of waiting for a solver");
});

test("permanently disabled button returns unknown after ten seconds without submitting", async () => {
  const h = harness({ enableAfter: Infinity });
  const result = await invoke(h);
  assert.equal(h.stats().checks, 100);
  assert.equal(h.stats().clock, 10000);
  assert.equal(h.stats().clicks, 0);
  assert.equal(result.error_kind, "unknown");
  assert.match(result.error_message, /10 seconds/);
  assert.equal(result.submission_attempted, false);
});

test("fill length mismatch aborts before button readiness or submission", async () => {
  const h = harness({ fillMatches: false });
  assert.equal((await invoke(h)).error_kind, "unknown");
  assert.equal(h.stats().checks, 0);
  assert.equal(h.stats().clicks, 0);
});

test("persistent session guard blocks a second invocation", async () => {
  const h = harness();
  assert.equal((await invoke(h)).submission_attempted, true);
  h.clearResult();
  const second = await invoke(h);
  assert.equal(second.error_kind, "submission_already_attempted");
  assert.equal(second.submission_attempted, false);
  assert.equal(h.stats().clicks, 1);
});

for (const invalid of [undefined, {}, [], { username: "fixture" }, { password: "fixture" }, { ...input, password: "" }, { ...input, username: " " }, { ...input, use_prefilled: true }, { ...input, use_prefilled: "yes" }, { ...input, extra: true }]) {
  test(`invalid input is rejected before page access: ${JSON.stringify(invalid)}`, async () => {
    const h = harness();
    const result = await invoke(h, invalid);
    assert.equal(result.error_kind, "invalid_input");
    assert.equal(h.stats().reads, 0);
    assert.equal(h.stats().clicks, 0);
  });
}

test("input schema rejects missing or conflicting fields", () => {
  const schema = harness().tool.tool.inputSchema;
  assert.equal(conforms(schema, input), true);
  assert.equal(conforms(schema, { use_prefilled: true }), true);
  assert.equal(conforms(schema, { manual_assist: true }), true);
  assert.equal(conforms(schema, { ...input, manual_assist: true }), false);
  assert.equal(conforms(schema, { use_prefilled: true, manual_assist: true }), false);
  for (const value of [{}, { username: "fixture" }, { ...input, use_prefilled: true }, { ...input, password: "" }]) assert.equal(conforms(schema, value), false);
});

test("prefilled mode navigates away from unsuitable pages but never invents field values", async () => {
  const h = harness({ url: "https://www.aa.com/homePage.do" });
  assert.equal((await invoke(h, { use_prefilled: true })).error_kind, "invalid_input");
  assert.deepEqual(h.navigation, [searchHome, searchUrl]);
  assert.equal(h.stats().filled, 0);
  assert.equal(h.stats().clicks, 0);
});

for (const [message, kind] of [
  ["Invalid password. 0 attempts remaining.", "invalid_credentials"],
  ["Your account is locked. Try again later.", "locked_or_throttled"],
  ["The verification code is incorrect.", "mfa_failed"],
  ["The service is unavailable.", "unknown"]
]) {
  test(`synthetic site error: ${kind}`, async () => {
    const h = harness({ after: { alerts: [message] } });
    const result = await invoke(h);
    assert.equal(result.error_kind, kind);
    assert.equal(result.error_message, message);
    assert.equal(result.error_source, "site");
    assert.equal(result.attempts_remaining_if_shown, kind === "invalid_credentials" ? 0 : null);
    assert.equal(h.stats().clicks, 1);
  });
}

for (const mfa of [false, true]) {
  const nodes = mfa
    ? [{ role: "StaticText", name: "We sent a verification code" }, { role: "textbox", name: "Verification code" }]
    : [{ role: "button", name: "Log out" }, { role: "StaticText", name: "Available miles" }];
  test(`synthetic ${mfa ? "MFA first-step" : "authenticated"} success matches schema`, async () => {
    const h = harness({ after: { username: false, password: false }, afterNodes: nodes });
    const result = await invoke(h);
    assert.equal(result.first_step_succeeded, true);
    assert.equal(result.logged_in, !mfa);
    assert.equal(result.mfa_required, mfa);
    assert.equal(result.observation, "after_submission");
    assert.equal(h.stats().clicks, 1);
  });
  test(`pre-existing ${mfa ? "MFA" : "authenticated"} state is explicitly attributed`, async () => {
    const h = harness({ initial: { username: false, password: false }, initialNodes: nodes });
    const result = await invoke(h);
    assert.equal(result.observation, "pre_existing");
    assert.equal(result.submission_attempted, false);
    assert.equal(h.stats().clicks, 0);
  });
}

test("missing form times out without submitting", async () => {
  const h = harness({ url: "about:blank", navigationState: { username: false, password: false } });
  assert.equal((await invoke(h)).error_kind, "login_form_unavailable");
  assert.equal(h.stats().clock, 30250);
  assert.equal(h.stats().clicks, 0);
});

test("shadow DOM fill checks lengths and dispatches input and change events", async () => {
  const h = harness();
  await invoke(h);
  class FakeInput {
    constructor(name) { this.tagName = "INPUT"; this.name = name; this.events = []; }
    get value() { return this.content ?? ""; }
    set value(value) { this.content = value; }
    getClientRects() { return [{}]; }
    dispatchEvent(event) { this.events.push(event.type); }
  }
  const username = new FakeInput("username"), password = new FakeInput("password");
  const document = { querySelectorAll: () => [{ tagName: "ADC-TEXT-INPUT", shadowRoot: { querySelectorAll: () => [username, password] } }] };
  const fill = runInNewContext(`(${h.pageFunctions.fill})`, { document, location: { origin: "https://login.aa.com" }, HTMLInputElement: FakeInput, Event: class { constructor(type) { this.type = type; } } });
  assert.equal(fill(input), true);
  assert.equal(username.value.length, input.username.length);
  assert.equal(password.value.length, input.password.length);
  assert.deepEqual(username.events, ["input", "change"]);
  assert.deepEqual(password.events, ["input", "change"]);
});

for (const [searchResult, errorKind] of [["missing", "ddg_result_missing"], ["wrong_target", "ddg_result_unapproved"]]) {
  test(`returns ${errorKind} and stops for ${searchResult} results`, async () => {
    const h = harness({ url: "about:blank", searchResult });
    const result = await invoke(h);
    assert.deepEqual(h.navigation, [searchHome, searchUrl]);
    assert.equal(h.stats().searchClicks, 0);
    assert.equal(h.stats().clicks, 0);
    assert.equal(h.stats().filled, 0);
    assert.equal(result.error_kind, errorKind);
    assert.equal(result.submission_attempted, false);
    assert.equal(h.stats().clock, searchResult === "missing" ? 20000 : 250);
  });
}

for (const stage of ["home", "results"]) {
  for (const searchState of ["challenge", "wrong_origin"]) {
    test(`stops after ${searchState} on search ${stage}`, async () => {
      const h = harness({ url: "about:blank", [stage === "home" ? "searchHomeResult" : "searchResult"]: searchState });
      const result = await invoke(h);
      assert.deepEqual(h.navigation, stage === "home" ? [searchHome] : [searchHome, searchUrl]);
      assert.equal(result.outcome, searchState === "challenge" ? "human_assist_required" : "failure");
      if (searchState === "challenge") assert.equal(result.reason, "captcha_or_challenge");
      else assert.equal(result.error_kind, "ddg_unexpected_origin");
      assert.equal(result.submission_attempted, false);
      assert.equal(h.stats().searchClicks, 0);
      assert.equal(h.stats().clicks, 0);
      assert.equal(h.stats().filled, 0);
    });
  }
}

for (const [navigationFailure, errorKind] of [[searchHome, "ddg_home_navigation_failed"], [searchUrl, "ddg_search_navigation_failed"]]) {
  test(`uncertain navigation reports ${errorKind} without retrying`, async () => {
    const h = harness({ url: "about:blank", navigationFailure });
    const result = await invoke(h);
    assert.equal(result.error_kind, errorKind);
    assert.equal(result.submission_attempted, false);
    assert.deepEqual(h.navigation, navigationFailure === searchHome ? [searchHome] : [searchHome, searchUrl]);
    assert.equal(h.stats().filled, 0);
  });
}

for (const stage of ["home", "results"]) {
  test(`search inspection failure on ${stage} names the failing step`, async () => {
    const h = harness({ url: "about:blank", searchInspectionFailure: stage });
    const result = await invoke(h);
    assert.equal(result.error_kind, "ddg_inspection_failed");
    assert.equal(result.submission_attempted, false);
    assert.equal(h.stats().searchClicks, 0);
    assert.equal(h.stats().filled, 0);
  });
}

test("uncertain organic click returns ddg_result_click_failed", async () => {
  const h = harness({ url: "about:blank", searchClickFailure: true });
  assert.equal((await invoke(h)).error_kind, "ddg_result_click_failed");
  assert.deepEqual(h.navigation, [searchHome, searchUrl]);
  assert.equal(h.stats().clicks, 0);
});

test("a challenge after the organic click stops before credential filling", async () => {
  const h = harness({ url: "about:blank", navigationState: { challenge: "Challenge Content" } });
  const result = await invoke(h);
  assert.equal(result.reason, "captcha_or_challenge");
  assert.equal(result.submission_attempted, false);
  assert.equal(h.stats().filled, 0);
  assert.equal(h.stats().clicks, 0);
  assert.deepEqual(h.navigation, [searchHome, searchUrl]);
});

test("organic result selection validates the first destination without skipping to another result", async () => {
  const h = harness({ url: "about:blank" });
  await invoke(h);
  for (const [href, expected] of [
    ["https://www.aa.com/loyalty/login", "ready"],
    ["https://login.aa.com/login", "ready"],
    ["https://www.aa.com/homePage.do", "wrong_target"],
    ["https://aa.com.example.org/loyalty/login", "wrong_target"],
    ["http://www.aa.com/loyalty/login", "wrong_target"]
  ]) {
    const attrs = {};
    const first = { href, setAttribute: (key, value) => { attrs[key] = value; } };
    const select = runInNewContext(`(${h.pageFunctions.search})`, {
      URL,
      location: { origin: "https://start.duckduckgo.com" },
      document: {
        querySelector: selector => {
          assert.equal(selector, 'article[data-testid="result"] [data-testid="result-title-a"]');
          return first;
        },
        querySelectorAll: () => []
      }
    });
    assert.equal(select({ selectResult: true }), expected);
    assert.equal(attrs["data-aa-login-result"], expected === "ready" ? "true" : undefined);
    assert.equal(attrs.target, expected === "ready" ? "_self" : undefined);
  }
});

test("search inspection detects text and visible iframe challenges before selecting a result", async () => {
  const h = harness({ url: "about:blank" });
  await invoke(h);
  for (const [bodyText, iframe, expected] of [
    ["Unfortunately, bots use DuckDuckGo too.", null, "challenge"],
    ["Select all squares containing a duck", null, "challenge"],
    ["", { src: "https://example.org/captcha", title: "", checkVisibility: () => true }, "challenge"],
    ["", { src: "https://example.org/captcha", title: "", checkVisibility: () => false }, "clear"]
  ]) {
    const inspect = runInNewContext(`(${h.pageFunctions.search})`, {
      location: { origin: "https://start.duckduckgo.com" },
      document: {
        body: { innerText: bodyText },
        querySelectorAll: () => iframe ? [iframe] : [],
        querySelector: () => { throw new Error("Must not select a result"); }
      }
    });
    assert.equal(inspect({ selectResult: false }), expected);
    if (expected === "challenge") assert.equal(inspect({ selectResult: true }), expected);
  }
});

test("observed delivery-choice wording is first-step MFA success without sending a code", async () => {
  const wording = "To keep your account safe, we'll send a verification code. How should we send your code?";
  const h = harness({ after: { username: false, password: false }, afterNodes: [
    { role: "heading", name: "Let's confirm it's really you" },
    { role: "StaticText", name: wording },
    { role: "button", name: "Text" },
    { role: "button", name: "Email" }
  ] });
  const result = await invoke(h);
  assert.equal(result.outcome, "mfa_required");
  assert.equal(result.first_step_succeeded, true);
  assert.equal(result.logged_in, false);
  assert.equal(result.mfa_required, true);
  assert.equal(result.next_step, wording);
  assert.equal(h.stats().clicks, 1);
});

for (const url of [loginUrl, "https://www.aa.com/homePage.do", "https://www.aa.com/blocked"]) {
  test(`pre-existing CAPTCHA stops before navigation or submission on ${url}`, async () => {
    const h = harness({ url, initial: { challenge: "Challenge Content" } });
    const result = await invoke(h);
    assert.equal(result.outcome, "human_assist_required");
    assert.equal(result.reason, "captcha_or_challenge");
    assert.equal(result.human_assist_required, true);
    assert.equal(result.logged_in, false);
    assert.equal(result.submission_attempted, false);
    assert.equal(result.next_step, "complete_login_manually_in_browser");
    assert.equal(result.landing_url, new URL(url).origin + new URL(url).pathname);
    assert.deepEqual(h.navigation, []);
    assert.equal(h.stats().filled, 0);
    assert.equal(h.stats().clicks, 0);
    assert.equal(h.stats().clock, 0);
  });
}

test("text-only CAPTCHA also requires immediate human assistance", async () => {
  const h = harness({ initialNodes: [{ role: "heading", name: "Verify you are human" }] });
  const result = await invoke(h);
  assert.equal(result.outcome, "human_assist_required");
  assert.equal(result.reason, "captcha_or_challenge");
  assert.equal(result.message, "Verify you are human");
  assert.equal(h.stats().clicks, 0);
});

for (const challenge of [null, "Challenge Content"]) {
  test(`manual-assist mode observes without navigation, filling, or submission: ${challenge}`, async () => {
    const h = harness({ initial: { challenge } });
    const result = await invoke(h, { manual_assist: true });
    assert.equal(result.outcome, "human_assist_required");
    assert.equal(result.reason, challenge ? "captcha_or_challenge" : "manual_login");
    assert.equal(result.submission_attempted, false);
    assert.equal(result.observation, "pre_existing");
    assert.deepEqual(h.navigation, []);
    assert.deepEqual(h.stats(), { checks: 0, clicks: 0, searchClicks: 0, filled: 0, reads: 1, clock: 0 });
  });
}

test("manual inspection after human login reports authentication without returning tokens", async () => {
  const h = harness({ initial: { username: false, password: false }, initialNodes: [
    { role: "button", name: "Log out" }, { role: "StaticText", name: "Available miles" }
  ] });
  const result = await invoke(h, { manual_assist: true });
  assert.equal(result.outcome, "authenticated");
  assert.equal(result.submission_attempted, false);
  assert.equal(result.observation, "pre_existing");
  assert.equal("session_token" in result, false);
  assert.equal("cookies" in result, false);
  assert.deepEqual(h.navigation, []);
  assert.equal(h.stats().clicks, 0);
});

for (const mfa of [true, false]) {
  test(`manual ${mfa ? "MFA" : "authenticated"} results omit URL queries and fragments`, async () => {
    const h = harness({ url: "https://login.aa.com/login?flowId=synthetic#private", initial: { username: false, password: false }, initialNodes: mfa
      ? [{ role: "StaticText", name: "We sent a verification code" }, { role: "textbox", name: "Verification code" }]
      : [{ role: "button", name: "Log out" }, { role: "StaticText", name: "Available miles" }]
    });
    const result = await invoke(h, { manual_assist: true });
    assert.equal(result.outcome, mfa ? "mfa_required" : "authenticated");
    assert.equal(result.landing_url, "https://login.aa.com/login");
    assert.equal(result.submission_attempted, false);
  });
}

test("manual inspection never navigates away from an unrelated page", async () => {
  const h = harness({ url: "https://example.org/" });
  assert.equal((await invoke(h, { manual_assist: true })).error_kind, "unknown");
  assert.deepEqual(h.navigation, []);
  assert.equal(h.stats().clicks, 0);
});

for (const invalid of [{ ...input, manual_assist: true }, { manual_assist: true, use_prefilled: true }, { manual_assist: "yes" }, { manual_assist: false }]) {
  test(`rejects conflicting manual-assist input: ${JSON.stringify(invalid)}`, async () => {
    const h = harness();
    assert.equal((await invoke(h, invalid)).error_kind, "invalid_input");
    assert.equal(h.stats().reads, 0);
  });
}

test("registry preserves search and indexes login under aa.com", () => {
  const registry = JSON.parse(readFileSync(new URL("../registry.json", import.meta.url), "utf8"));
  assert.ok(registry.tools.some(t => t.domain === "aa.com" && t.tool === "search_flights"));
  const entries = registry.tools.filter(t => t.domain === "aa.com" && t.tool === "login");
  assert.equal(entries.length, 1);
  assert.equal(entries[0].namespace, "aa.com");
  assert.equal(entries[0].file, "domains/aa.com/login.js");
  assert.equal(entries[0].status, "qa_passed");
  assert.deepEqual(entries[0].url_patterns, plain(harness().tool.match.url_patterns));
});
