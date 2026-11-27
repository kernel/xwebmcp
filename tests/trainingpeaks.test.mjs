import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { conforms, plain } from "./fixtures/purelymail/server.mjs";

// Fabricated account; nothing here contacts TrainingPeaks.
const USER = { userId: 4242, userName: "fixture-athlete", isAthlete: true };
const API = "https://tpapi.trainingpeaks.com";
const source = name => readFileSync(new URL(`../domains/trainingpeaks.com/${name}.js`, import.meta.url), "utf8");

// A stand-in for the availability API the calendar uses.
function site({ signedIn = true, user = USER, entries = [], postStatus = 200, postThrows = false, deleteStatus = 200 } = {}) {
  const rows = entries.map(e => ({ ...e }));
  const requests = [];
  let nextId = 900;
  const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
  const fetch = async (url, options = {}) => {
    const method = options.method || "GET";
    requests.push({ url, method, body: options.body ?? null, auth: options.headers?.Authorization ?? null });
    if (url === API + "/users/v3/token") return signedIn ? json(200, { token: { access_token: "fixture-token" } }) : json(401, null);
    if (url === API + "/users/v3/user") return json(200, { user });
    const list = new RegExp(`^${API}/fitness/v1/athletes/${user.userId}/availability/(\\d{4}-\\d{2}-\\d{2})/(\\d{4}-\\d{2}-\\d{2})$`).exec(url);
    if (list && method === "GET") return json(200, rows.filter(r => r.startDate.slice(0, 10) <= list[2] && r.endDate.slice(0, 10) >= list[1]));
    if (url === `${API}/fitness/v1/athletes/${user.userId}/availability` && method === "POST") {
      if (postThrows) throw new TypeError("Failed to fetch");
      if (postStatus !== 200) return json(postStatus, { message: "Bad request" });
      const b = JSON.parse(options.body);
      const row = { id: nextId++, personId: b.personId, startDate: b.startDate + "T00:00:00", endDate: b.endDate + "T00:00:00", limitedAvailability: b.limitedAvailability, type: b.type, reason: b.reason, description: b.description, availableSportTypes: b.availableSportTypes };
      rows.push(row);
      return json(200, row);
    }
    const del = new RegExp(`^${API}/fitness/v1/athletes/${user.userId}/availability/(\\d+)$`).exec(url);
    if (del && method === "DELETE") {
      if (deleteStatus === 200) rows.splice(rows.findIndex(r => r.id === Number(del[1])), 1);
      return json(deleteStatus, null);
    }
    throw new Error("unexpected request " + method + " " + url);
  };
  return { fetch, rows, requests, writes: () => requests.filter(r => r.method !== "GET") };
}

const element = (props = {}) => ({ getClientRects: () => [1], textContent: "", dataset: {}, ...props });
function page(name, { href = "https://app.trainingpeaks.com/#calendar", api = site(), selectors = {}, tools = null, cookie = "" } = {}) {
  const url = new URL(href);
  const scheduled = [];
  const location = {
    get href() { return url.href; }, get origin() { return url.origin; }, get hostname() { return url.hostname; },
    get pathname() { return url.pathname; }, get search() { return url.search; },
    get hash() { return url.hash; }, set hash(v) { url.hash = v; scheduled.push({ hash: v }); },
    assign: to => scheduled.push({ assign: to }), reload: () => scheduled.push({ reload: true })
  };
  const document = {
    readyState: "complete",
    get cookie() { return typeof cookie === "function" ? cookie() : cookie; },
    getElementById: id => (selectors["#" + id] || [])[0] || null,
    querySelector: sel => (selectors[sel] || [])[0] || null,
    querySelectorAll: sel => sel.split(",").flatMap(part => selectors[part.trim()] || []),
    modelContext: tools ? { getTools: async () => tools.map(name => ({ name: "custom.trainingpeaks.com." + name })) } : undefined
  };
  const context = {
    fetch: api.fetch, location, document, navigator: {}, URL, Date, Math, JSON, Promise, Number, String, Object, Array, Set, RegExp,
    getComputedStyle: () => ({ visibility: "visible" }),
    setTimeout: (fn, ms) => { if (ms === 100) fn(); else Promise.resolve().then(fn); }
  };
  context.globalThis = context;
  const [definition] = runInNewContext(`(${source(name)})`, context);
  return {
    definition, scheduled, api,
    run: async input => {
      const result = plain(await definition.execute(input));
      assert.ok(conforms(definition.tool.outputSchema, result), "output matches schema: " + JSON.stringify(result));
      assert.ok(!JSON.stringify(result).includes("fixture-token"), "the session token is never returned");
      return result;
    }
  };
}

const JUNE = { id: 11, personId: USER.userId, startDate: "2026-05-04T00:00:00", endDate: "2026-05-08T00:00:00", limitedAvailability: false, type: 1, reason: "Vacation", description: "fixture trip", availableSportTypes: [] };

test("list_availability reads the range the calendar reads and maps entries", async () => {
  const p = page("list_availability", { api: site({ entries: [JUNE, { ...JUNE, id: 12, startDate: "2026-04-27T00:00:00", endDate: "2026-04-29T00:00:00", limitedAvailability: true, type: 2, reason: "Work", availableSportTypes: [2] }] }) });
  const result = await p.run({ start_date: "2026-04-01", end_date: "2026-05-31" });
  assert.equal(result.account, "fixture-athlete");
  assert.deepEqual(result.entries.map(e => [e.availability_id, e.availability, e.available_sports]), [[12, "limited", ["bike"]], [11, "unavailable", []]]);
  assert.equal(p.api.requests.at(-1).url, `${API}/fitness/v1/athletes/4242/availability/2026-04-01/2026-05-31`);
});

test("list_availability rejects bad ranges, other pages and signed-out sessions before reading", async () => {
  assert.equal((await page("list_availability").run({ start_date: "2026-01-01", end_date: "2027-06-01" })).error_kind, "invalid_input");
  assert.equal((await page("list_availability").run({ start_date: "2026-02-30", end_date: "2026-03-01" })).error_kind, "invalid_input");
  assert.equal((await page("list_availability").run({ start_date: "2026-01-01", end_date: "2026-01-02", extra: 1 })).error_kind, "invalid_input");
  assert.equal((await page("list_availability", { href: "https://home.trainingpeaks.com/login" }).run({ start_date: "2026-01-01", end_date: "2026-01-02" })).error_kind, "wrong_page");
  assert.equal((await page("list_availability", { api: site({ signedIn: false }) }).run({ start_date: "2026-01-01", end_date: "2026-01-02" })).error_kind, "signed_out");
});

test("add_availability sends the form's exact save request once and confirms it by reading it back", async () => {
  const p = page("add_availability");
  const result = await p.run({ start_date: "2026-12-20", end_date: "2026-12-28", reason: "Vacation", description: "trip" });
  assert.equal(result.status, "created");
  assert.deepEqual(result.entry, { availability_id: 900, start_date: "2026-12-20", end_date: "2026-12-28", availability: "unavailable", reason: "Vacation", description: "trip", available_sports: [] });
  const writes = p.api.writes();
  assert.equal(writes.length, 1);
  assert.equal(writes[0].url, `${API}/fitness/v1/athletes/4242/availability`);
  assert.deepEqual(JSON.parse(writes[0].body), { personId: 4242, startDate: "2026-12-20", endDate: "2026-12-28", limitedAvailability: false, reason: "Vacation", availableSportTypes: [], description: "trip", type: 1 });
  const limited = page("add_availability");
  await limited.run({ start_date: "2026-12-01", end_date: "2026-12-01", availability: "limited", available_sports: ["run", "swim"] });
  assert.deepEqual(JSON.parse(limited.api.writes()[0].body), { personId: 4242, startDate: "2026-12-01", endDate: "2026-12-01", limitedAvailability: true, reason: "", availableSportTypes: [3, 1], description: "", type: 2 });
});

test("add_availability writes nothing for identical, overlapping, wrong-account or invalid requests", async () => {
  const same = page("add_availability", { api: site({ entries: [JUNE] }) });
  const existing = await same.run({ start_date: "2026-05-04", end_date: "2026-05-08", reason: "Vacation" });
  assert.equal(existing.status, "already_exists");
  assert.equal(existing.entry.availability_id, 11);
  const overlap = page("add_availability", { api: site({ entries: [JUNE] }) });
  const refused = await overlap.run({ start_date: "2026-05-07", end_date: "2026-05-10" });
  assert.equal(refused.error_kind, "overlap");
  assert.equal(refused.overlapping_entries[0].availability_id, 11);
  assert.equal(refused.write_attempted, false);
  for (const input of [
    { start_date: "2026-12-02", end_date: "2026-12-01" },
    { start_date: "2026-12-01", end_date: "2026-12-01", available_sports: ["run"] },
    { start_date: "2026-12-01", end_date: "2026-12-01", reason: "Holiday" },
    { start_date: "2026-12-01", end_date: "2026-12-01", expected_account: "someone-else" }
  ]) {
    const p = page("add_availability");
    const result = await p.run(input);
    assert.equal(result.status, "error", JSON.stringify(input));
    assert.equal(p.api.writes().length, 0);
  }
  const allowed = page("add_availability", { api: site({ entries: [JUNE] }) });
  assert.equal((await allowed.run({ start_date: "2026-05-07", end_date: "2026-05-10", allow_overlap: true })).status, "created");
});

test("add_availability reports a rejected or unanswered save without retrying", async () => {
  const rejected = page("add_availability", { api: site({ postStatus: 400 }) });
  const result = await rejected.run({ start_date: "2026-12-01", end_date: "2026-12-01" });
  assert.equal(result.error_kind, "site_rejected");
  assert.match(result.error_message, /400: Bad request/);
  const lost = page("add_availability", { api: site({ postThrows: true }) });
  const unknown = await lost.run({ start_date: "2026-12-01", end_date: "2026-12-01" });
  assert.equal(unknown.error_kind, "outcome_unknown");
  assert.equal(unknown.write_attempted, true);
  assert.equal(lost.api.writes().length, 1);
});

test("delete_availability deletes only the entry whose id and start date match, then confirms it is gone", async () => {
  const p = page("delete_availability", { api: site({ entries: [JUNE] }) });
  const mismatch = await p.run({ availability_id: 11, start_date: "2026-05-05" });
  assert.equal(mismatch.error_kind, "not_found");
  assert.equal(p.api.writes().length, 0);
  const result = await p.run({ availability_id: 11, start_date: "2026-05-04" });
  assert.equal(result.status, "deleted");
  assert.equal(result.deleted_entry.availability_id, 11);
  assert.deepEqual(p.api.writes().map(w => [w.method, w.url]), [["DELETE", `${API}/fitness/v1/athletes/4242/availability/11`]]);
  assert.equal(p.api.rows.length, 0);
  const refused = page("delete_availability", { api: site({ entries: [JUNE], deleteStatus: 403 }) });
  assert.equal((await refused.run({ availability_id: 11, start_date: "2026-05-04" })).error_kind, "site_rejected");
});

test("navigate_to_page schedules app routes after returning, reloads the open address, and guards forms and hosts", async () => {
  const p = page("navigate_to_page");
  const result = await p.run({ url: "#dashboard" });
  assert.deepEqual([result.status, result.to_url, result.reload], ["navigation_scheduled", "https://app.trainingpeaks.com/#dashboard", false]);
  assert.deepEqual(p.scheduled, [{ hash: "#dashboard" }]);
  const again = page("navigate_to_page");
  assert.equal((await again.run({ url: "#calendar" })).reload, true);
  assert.deepEqual(again.scheduled, [{ reload: true }]);
  const fresh = page("navigate_to_page", { href: "https://app.trainingpeaks.com/#dashboard" });
  assert.equal((await fresh.run({ url: "#calendar", reload: true })).reload, true);
  assert.deepEqual(fresh.scheduled, [{ hash: "#calendar" }, { reload: true }], "switching routes alone shows cached calendar data");
  assert.equal((await page("navigate_to_page").run({ url: "#calendar", reload: "yes" })).error_kind, "invalid_input");
  const fromLogin = page("navigate_to_page", { href: "https://home.trainingpeaks.com/login" });
  await fromLogin.run({ url: "https://app.trainingpeaks.com/#calendar" });
  assert.deepEqual(fromLogin.scheduled, [{ assign: "https://app.trainingpeaks.com/#calendar" }]);
  for (const url of ["https://home.trainingpeaks.com/login", "//example.com/#calendar", "javascript:alert(1)", "calendar"]) {
    const bad = page("navigate_to_page");
    assert.equal((await bad.run({ url })).error_kind, "invalid_input", url);
    assert.equal(bad.scheduled.length, 0);
  }
  const form = { '[data-cy="availabilityEditor"]': [element()] };
  const guarded = page("navigate_to_page", { href: "https://app.trainingpeaks.com/#calendar/athletes/4242/availability/11", selectors: form });
  assert.equal((await guarded.run({ url: "#calendar" })).error_kind, "form_open");
  assert.equal(guarded.scheduled.length, 0);
  const discard = page("navigate_to_page", { href: "https://app.trainingpeaks.com/#calendar/athletes/4242/availability/11", selectors: form });
  assert.equal((await discard.run({ url: "#calendar", discard_form: true })).status, "navigation_scheduled");
});

test("get_page_context reports the page, account, calendar range, open item and next steps", async () => {
  const days = ["2026-11-29", "2026-11-23", "2026-12-06"].map(date => element({ dataset: { date } }));
  const tools = ["add_availability", "delete_availability", "get_page_context", "list_availability", "login", "navigate_to_page"];
  const p = page("get_page_context", {
    href: "https://app.trainingpeaks.com/#calendar/athletes/4242/availability/11", tools: [...tools, "answer_cookie_banner"],
    selectors: { "#onetrust-banner-sdk": [element()], ".onetrust-pc-dark-filter": [element()], ".day[data-date]": days, ".day.today[data-date]": [days[0]], '[data-cy="availabilityEditor"]': [element()], ".frameworkMainWrapper": [element()] }
  });
  const result = await p.run({});
  assert.equal(result.page_type, "calendar");
  assert.deepEqual(result.open_item, { item_type: "availability", item_id: 11 });
  assert.deepEqual(result.account, { user_id: 4242, username: "fixture-athlete", is_athlete: true });
  assert.deepEqual(result.calendar, { first_drawn_date: "2026-11-23", last_drawn_date: "2026-12-06", today: "2026-11-29" });
  assert.equal(result.availability_form_open, true);
  assert.deepEqual(result.available_tools, [...tools, "answer_cookie_banner"].sort());
  assert.ok(result.suggested_next_steps.some(s => s.includes("discard_form")));
  assert.deepEqual(result.cookie_banner, { visible: true, settings_open: false, blocks_page: true, answered: false });
  assert.ok(result.suggested_next_steps.some(s => s.includes("answer_cookie_banner({}) closes it with Reject All")));
  const login = await page("get_page_context", { href: "https://home.trainingpeaks.com/login", api: site({ signedIn: false }), tools: ["login"] }).run({});
  assert.deepEqual([login.page_type, login.signed_in, login.account], ["login", false, null]);
  assert.deepEqual(login.cookie_banner, { visible: false, settings_open: false, blocks_page: false, answered: false });
  assert.ok(login.suggested_next_steps[0].startsWith("Not signed in: use login"));
  assert.equal((await page("get_page_context", { href: "https://app.trainingpeaks.com/#plan" }).run({})).page_type, "plan");
  assert.equal((await page("get_page_context").run({ wait_for_settled_seconds: 99 })).error_kind, "invalid_input");
});

// A OneTrust banner whose buttons record the choice in cookies and hide the banner, as the site's do.
function bannerPage({ shown = true, settingsOpen = false } = {}) {
  const state = { shown, cookie: "OptanonConsent=isGpcEnabled=0&groups=C0001%3A1%2CC0002%3A0", pressed: [] };
  const press = (name, groups) => element({ click: () => {
    state.pressed.push(name);
    state.shown = false;
    state.cookie = "OptanonConsent=isGpcEnabled=0&groups=" + encodeURIComponent(groups) + "; OptanonAlertBoxClosed=2026-11-27T20:00:00.000Z";
  } });
  const selectors = {
    "#onetrust-banner-sdk": [element({ getClientRects: () => (state.shown ? [1] : []) })],
    "#onetrust-pc-sdk": settingsOpen ? [element()] : [],
    "#onetrust-reject-all-handler": [press("reject", "C0001:1,C0002:0,C0003:0,C0004:0")],
    "#onetrust-accept-btn-handler": [press("accept", "C0001:1,C0002:1,C0003:1,C0004:1")]
  };
  return { p: page("answer_cookie_banner", { selectors, cookie: () => state.cookie }), state };
}

test("answer_cookie_banner presses only the button for the user's choice and reports the recorded consent", async () => {
  for (const [choice, button, marketing] of [["reject_all", "reject", false], ["accept_all", "accept", true]]) {
    const { p, state } = bannerPage();
    const result = await p.run({ choice });
    assert.deepEqual(state.pressed, [button]);
    assert.deepEqual([result.status, result.choice, result.banner_visible, result.consent_groups.C0001, result.consent_groups.C0004], ["answered", choice, false, true, marketing]);
  }
});

test("answer_cookie_banner defaults to Reject All and presses nothing for bad input, without a banner or with Cookie Settings open", async () => {
  const { p, state } = bannerPage();
  for (const input of [{ choice: "close" }, { choice: "reject_all", extra: 1 }]) assert.equal((await p.run(input)).error_kind, "invalid_input");
  assert.deepEqual(state.pressed, []);
  const byDefault = bannerPage();
  assert.equal((await byDefault.p.run({})).choice, "reject_all");
  assert.deepEqual(byDefault.state.pressed, ["reject"]);
  const none = bannerPage({ shown: false });
  const absent = await none.p.run({ choice: "reject_all" });
  assert.deepEqual([absent.status, absent.choice], ["no_banner", null]);
  assert.deepEqual(none.state.pressed, []);
  const settings = bannerPage({ settingsOpen: true });
  assert.equal((await settings.p.run({ choice: "accept_all" })).error_kind, "settings_open");
  assert.deepEqual(settings.state.pressed, []);
});

// The login tool is a cdp tool: its helpers are stubbed and its page functions are recognized by their source.
function loginHarness({ sessionUser = null, afterSubmit = () => ({ user: USER }), captcha = true } = {}) {
  let clock = 1_800_000_000_000;
  let state = { url: "about:blank", user: sessionUser, form: false, error: null, code: false };
  let marker = 0;
  const calls = { navigations: [], typed: {}, keys: [], clicks: 0 };
  const read = () => ({ url: state.url, host: new URL(state.url === "about:blank" ? "https://x.invalid" : state.url).hostname, path: state.url === "about:blank" ? "" : new URL(state.url).pathname, form: state.form, captcha_ready: captcha, error: state.error, code_step: state.code, marker });
  const context = {
    Date: class extends Date { constructor(...a) { super(...(a.length ? a : [clock])); } static now() { return clock; } },
    pageInfo: async () => ({ url: state.url }),
    gotoUrl: async url => { calls.navigations.push(url); state = { ...state, url, form: !state.user && url.includes("/login") }; },
    waitForLoad: async () => true,
    waitMs: async ms => { clock += ms; },
    fillInput: async (selector, text) => { calls.typed[selector] = text; },
    click: async () => { calls.clicks++; },
    pressKey: async key => {
      calls.keys.push(key);
      const outcome = afterSubmit();
      state = outcome.user ? { url: "https://app.trainingpeaks.com/", user: outcome.user, form: false, error: null, code: false } : { ...state, ...outcome };
    },
    js: async (fn, options) => {
      const text = fn.toString();
      if (text.includes("users/v3/token")) return state.user ? { username: state.user.userName, email: null, user_id: state.user.userId, is_athlete: state.user.isAthlete } : null;
      if (text.includes("captcha-token")) return read();
      if (text.includes("setItem")) { marker = clock; return undefined; }
      if (text.includes("removeItem")) { marker = 0; return undefined; }
      if (text.includes("activeElement")) return (calls.typed["#Username"] || "").toLowerCase() === options.arg && !!calls.typed["#Password"];
      throw new Error("unexpected page function " + text.slice(0, 80));
    }
  };
  const [definition] = runInNewContext(`(${source("login")})`, context);
  return {
    calls,
    run: async input => {
      const result = plain(await definition.execute(input));
      assert.ok(conforms(definition.tool.outputSchema, result), "output matches schema: " + JSON.stringify(result));
      assert.ok(!JSON.stringify(result).includes("fixture-password"), "the password never appears in the output");
      return result;
    }
  };
}

test("login confirms an existing session without submitting, and refuses another account", async () => {
  const same = loginHarness({ sessionUser: USER });
  const ok = await same.run({ username: "Fixture-Athlete", password: "fixture-password" });
  assert.deepEqual([ok.status, ok.entry, ok.submission_attempted], ["ok", "already_signed_in", false]);
  assert.equal(same.calls.keys.length, 0);
  const other = loginHarness({ sessionUser: { ...USER, userName: "someone-else" } });
  const wrong = await other.run({ username: "fixture-athlete", password: "fixture-password" });
  assert.deepEqual([wrong.error_kind, wrong.signed_in_account, wrong.submission_attempted], ["wrong_account", "someone-else", false]);
  assert.deepEqual(other.calls.typed, {});
});

test("login submits once with Enter from a fresh login page and reports the signed-in account", async () => {
  const h = loginHarness();
  const result = await h.run({ username: "fixture-athlete", password: "fixture-password" });
  assert.deepEqual([result.status, result.entry, result.account.username, result.account.user_id], ["ok", "form_submitted", "fixture-athlete", 4242]);
  assert.deepEqual(h.calls.keys, ["Enter"]);
  assert.equal(h.calls.clicks, 0, "the Login button can be covered by the consent banner, so it is not clicked");
  assert.ok(h.calls.navigations.every(url => url === "https://home.trainingpeaks.com/login"));
});

test("login reports rejected passwords, second factors and missing reCAPTCHA tokens without retrying", async () => {
  const bad = loginHarness({ afterSubmit: () => ({ error: "Username or password is incorrect" }) });
  const rejected = await bad.run({ username: "fixture-athlete", password: "fixture-password" });
  assert.deepEqual([rejected.error_kind, rejected.submission_attempted], ["invalid_credentials", true]);
  assert.equal(bad.calls.keys.length, 1);
  const mfa = await loginHarness({ afterSubmit: () => ({ code: true }) }).run({ username: "fixture-athlete", password: "fixture-password" });
  assert.equal(mfa.error_kind, "mfa_required");
  const noToken = loginHarness({ captcha: false });
  const captcha = await noToken.run({ username: "fixture-athlete", password: "fixture-password" });
  assert.deepEqual([captcha.error_kind, captcha.submission_attempted], ["captcha_unavailable", false]);
  assert.equal(noToken.calls.keys.length, 0);
  assert.equal((await loginHarness().run({ username: "has space", password: "x" })).error_kind, "invalid_input");
});
