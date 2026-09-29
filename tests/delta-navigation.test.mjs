import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";

const load = name => readFileSync(new URL(`../domains/delta.com/${name}.js`, import.meta.url), "utf8");

function navigate(url = "https://www.delta.com/us/en/baggage/overview") {
  const assigned = [];
  const scheduled = [];
  const context = {
    URL,
    location: { href: url, assign: to => assigned.push(to) },
    setTimeout: fn => { scheduled.push(fn); return 0; }
  };
  const [tool] = runInNewContext(`(${load("navigate_to_page")})`, context);
  return { tool, run: input => tool.execute(input), assigned, scheduled };
}

test("navigate_to_page: schedules same-origin navigation after returning", async () => {
  const n = navigate();
  const out = await n.run({ url: "/flightsearch/book-a-flight?tripType=ONE_WAY" });
  assert.equal(out.status, "navigation_scheduled");
  assert.equal(out.to_url, "https://www.delta.com/flightsearch/book-a-flight?tripType=ONE_WAY");
  assert.equal(n.assigned.length, 0, "must not navigate before settling");
  n.scheduled[0]();
  assert.deepEqual(n.assigned, [out.to_url]);
});

for (const url of ["https://evil.example/", "//evil.example/x", "flightsearch", "/\\evil.example", ""]) {
  test(`navigate_to_page: rejects ${JSON.stringify(url)} without navigating`, async () => {
    const n = navigate();
    const out = await n.run({ url });
    assert.equal(out.status, "error");
    assert.equal(n.scheduled.length, 0);
  });
}

test("navigate_to_page: description carries a basic site map with examples", () => {
  const { tool } = navigate();
  for (const path of ["/flightsearch/book-a-flight", "/my-trips/search", "/flightstatus/search"]) assert.ok(tool.tool.description.includes(path));
  assert.match(tool.tool.description, /Example: navigate_to_page/);
});

// Fake page for get_page_context.
function context(options) {
  const url = new URL(options.url);
  const el = (props = {}) => ({ innerText: "", getClientRects: () => (props.hidden ? [] : [{}]), querySelector: () => null, ...props });
  const header = options.header ?? [];
  const alerts = options.alerts ?? [];
  const selectors = {
    "#login-trigger": options.loginTrigger ? el() : null,
    "#login-modal-popup": options.flyoutOpen ? { open: true, querySelector: () => el() } : null,
    "#password-input": options.passwordField ? el() : null
  };
  const document = {
    title: options.title ?? "Delta",
    body: { innerText: options.bodyText ?? "" },
    modelContext: options.noModelContext ? undefined : { getTools: async () => (options.tools ?? []).map(name => ({ name: `custom.ct_x.${name}` })) },
    querySelector: sel => selectors[sel] ?? null,
    querySelectorAll: sel => (sel.startsWith("header") ? header : sel.startsWith("[role") ? alerts : [])
  };
  const ctx = {
    document, navigator: {},
    location: { href: url.href, hostname: url.hostname, pathname: url.pathname, search: url.search },
    getComputedStyle: () => ({ visibility: "visible" })
  };
  const [tool] = runInNewContext(`(${load("get_page_context")})`, ctx);
  return tool.execute({});
}

test("get_page_context: signed-out homepage suggests login and lists live tools", async () => {
  const out = await context({ url: "https://www.delta.com/", loginTrigger: true, tools: ["search_flights", "login", "get_page_context", "navigate_to_page", "login"] });
  assert.equal(out.page_type, "home");
  assert.equal(out.signed_in, false);
  assert.deepEqual([...out.available_tools], ["get_page_context", "login", "navigate_to_page", "search_flights"]);
  assert.ok(out.suggested_next_steps.some(s => s.startsWith("Use login")));
  assert.ok(out.suggested_next_steps.some(s => s.includes("search_flights")));
});

test("get_page_context: results page with SFAF001 reports the code and warns against reading zero flights", async () => {
  const out = await context({ url: "https://www.delta.com/flightsearch/search-results?cacheKeySuffix=abc", bodyText: "Something went wrong #SFAF001_429", tools: ["search_flights"] });
  assert.equal(out.page_type, "flight_results");
  assert.equal(out.current_path, "/flightsearch/search-results?cacheKeySuffix=abc");
  assert.ok(out.page_messages.some(m => m.includes("SFAF001_429")));
  assert.ok(out.suggested_next_steps.some(s => s.includes("do not treat it as zero flights")));
});

test("get_page_context: signed-in header, open flyout, missing modelContext", async () => {
  const signedIn = await context({ url: "https://www.delta.com/my-trips/search", header: [{ innerText: "Log Out", getClientRects: () => [{}] }] });
  assert.equal(signedIn.page_type, "my_trips");
  assert.equal(signedIn.signed_in, true);
  const flyout = await context({ url: "https://www.delta.com/", loginTrigger: true, flyoutOpen: true, noModelContext: true, alerts: [{ innerText: "Login credential is incorrect.", getClientRects: () => [{}] }] });
  assert.equal(flyout.login_flyout_open, true);
  assert.equal(flyout.available_tools, null);
  assert.deepEqual([...flyout.page_messages], ["Login credential is incorrect."]);
  assert.ok(flyout.suggested_next_steps[0].includes("never resubmit"));
});
