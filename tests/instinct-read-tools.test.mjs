import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";

// list_connected_services and get_settings are page tools: execute runs in the page, so each test
// evaluates the file in a fresh context that only has page globals (document, location, Date,
// setTimeout, fetch). The fake DOM copies the element structure observed on the app's workspace and
// settings pages; every name, description and value here is fabricated.

const source = name => readFileSync(new URL(`../domains/instinct.com/${name}.js`, import.meta.url), "utf8");
const plain = value => JSON.parse(JSON.stringify(value));

function conforms(schema, value) {
  if ("const" in schema && value !== schema.const) return false;
  if (schema.enum && !schema.enum.includes(value)) return false;
  if (schema.type && ![schema.type].flat().some(type => {
    if (type === "null") return value === null;
    if (type === "object") return value !== null && typeof value === "object" && !Array.isArray(value);
    if (type === "array") return Array.isArray(value);
    return typeof value === type;
  })) return false;
  if (schema.oneOf && schema.oneOf.filter(s => conforms(s, value)).length !== 1) return false;
  if (schema.required?.some(key => !Object.hasOwn(value, key))) return false;
  if (schema.properties && value !== null && typeof value === "object") {
    if (Object.entries(schema.properties).some(([key, s]) => key in value && !conforms(s, value[key]))) return false;
    if (schema.additionalProperties === false && Object.keys(value).some(key => !(key in schema.properties))) return false;
  }
  if (Array.isArray(value) && schema.items && !value.every(v => conforms(schema.items, v))) return false;
  if (typeof value === "string" && value.length < (schema.minLength ?? 0)) return false;
  return true;
}

class Node {
  constructor(tag, attrs, kids) {
    this.tagName = tag.toUpperCase();
    this.attrs = attrs;
    this.parentElement = null;
    this.childNodes = kids.filter(kid => kid !== null).map(kid => {
      if (typeof kid !== "string") { kid.parentElement = this; return kid; }
      return { nodeType: 3, textContent: kid };
    });
    this.nodeType = 1;
  }
  get id() { return this.attrs.id ?? ""; }
  get children() { return this.childNodes.filter(n => n.nodeType === 1); }
  get textContent() { return this.childNodes.map(n => n.textContent).join(""); }
  getAttribute(name) { return name in this.attrs ? String(this.attrs[name]) : null; }
  contains(node) {
    for (let el = node; el; el = el.parentElement) if (el === this) return true;
    return false;
  }
  closest(selector) {
    assert.equal(selector, "section");
    for (let el = this; el; el = el.parentElement) if (el.tagName === "SECTION") return el;
    return null;
  }
  querySelectorAll(selector) {
    const prefix = selector.match(/^\[id\^="(.+)"\]$/)?.[1];
    const tag = /^[a-z0-9]+$/.test(selector) ? selector.toUpperCase() : null;
    assert.ok(prefix !== undefined || tag, `fake DOM does not support selector ${selector}`);
    const found = [];
    const walk = el => {
      for (const child of el.children) {
        if (tag ? child.tagName === tag : child.id.startsWith(prefix)) found.push(child);
        walk(child);
      }
    };
    walk(this);
    return found;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
}
const h = (tag, attrs = {}, ...kids) => new Node(tag, attrs, kids);

const connectorRow = (id, name, description, { label = "Connect", badge = null, extra = null } = {}) =>
  h("div", { id: `connector-${id}` }, h("div", {},
    h("span", {}, h("svg")),
    h("div", {}, h("span", {}, name, badge ? h("span", {}, badge) : null), h("span", {}, description), extra),
    h("div", {}, h("button", { type: "button" }, label))));

const observedRows = () => [
  connectorRow("mail-suite", "Example Mail Suite", "Mail, calendar and files"),
  connectorRow("issues", "Example Issues", "Search and update issues. Create issues and add comments"),
  connectorRow("wallet", "Example Pay", "Checkout seamlessly with Example Pay.", { badge: "Beta" })
];

const workspaceDom = (rows = observedRows(), { heading = true } = {}) => h("div", {},
  h("section", {}, h("div", {}, h("div", {}, h("h2", {}, "Contact"), h("p", {}, "Ways to reach the assistant directly"))), h("div", {},
    h("div", {}, h("span", {}, "Email"), h("span", {}, "assistant-fixture@example.invalid")))),
  h("section", {},
    h("div", {}, h("div", {}, heading ? h("h2", {}, "Connectors") : null, h("p", {}, "Tools your agent can use"))),
    h("div", {}, ...rows)),
  h("section", {}, h("div", {}, h("div", {}, h("h2", {}, "Data privacy"))), h("div", {}, h("button", { type: "button" }, "Delete"))));

const settingsDom = ({ checked = "false", icloud = "Not linked", whatsapp = "Not connected", role = "switch", label = "Improve Instinct for everyone", labelFor = "training-data-preference", stray = false, omit = [] } = {}) => h("div", {},
  h("section", {}, h("div", {}, h("div", {}, h("h2", {}, "Name"))), h("div", {}, h("input", { id: "display-name", value: "Fixture Person" }), h("button", { type: "button" }, "Saved"))),
  h("section", {}, h("div", {}, h("div", {}, h("h2", {}, "Sign-in methods"))), h("div", {},
    h("div", {}, h("span", {}, h("svg")), h("div", {}, h("span", {}, "Phone"), h("span", {}, "+1 555 0100")), h("div", {}, h("button", { type: "button" }, "Change"))),
    omit.includes("icloud") ? null : h("div", {}, h("span", {}, h("svg")), h("div", {}, h("span", {}, "iCloud email for iMessage"), h("span", {}, icloud)), h("div", {}, h("a", { href: "/link-icloud?replace=1" }, "Add"))))),
  omit.includes("whatsapp") ? null : h("section", { "aria-labelledby": "whatsapp-number-heading" },
    h("div", {}, h("div", {}, h("h2", { id: "whatsapp-number-heading" }, "WhatsApp"), h("p", {}, "The number you use to message the assistant on WhatsApp."))),
    h("div", {}, h("div", {}, h("span", {}, h("svg")), h("div", {}, h("span", {}, whatsapp), h("span", {}, "Link the number you message from")), h("div", {}, h("a", { href: "/connect/whatsapp" }, "Connect"))))),
  h("section", {}, h("div", {}, h("div", {}, h("h2", {}, "Data controls"))), h("div", {},
    h("div", {}, h("span", {}, h("label", { for: labelFor }, label)), h("span", {}, h("span", { id: "training-data-preference-description" }, "Your data will no longer be used for future training.")),
      h("button", { type: "button", role, ...(checked === null ? {} : { "aria-checked": checked }), id: "training-data-preference" }),
      stray ? h("div", {}, h("span", {}, "Not linked"), h("span", {}, "Not connected")) : null))));

function allNodes(root) {
  const out = [root];
  for (const child of root.children) out.push(...allNodes(child));
  return out;
}

// dom may be a tree or a function of the poll count, so a page can render late or redirect mid-wait.
function page(name, { url = "https://app.instinct.com/workspace", dom = null } = {}) {
  const target = new URL(url);
  const state = { polls: 0, domReads: 0, fetches: 0, clicks: 0, now: 0 };
  const location = { protocol: target.protocol, hostname: target.hostname, pathname: target.pathname, search: target.search };
  const tree = () => (typeof dom === "function" ? dom(state.polls, location) : dom);
  const root = () => tree() ?? h("div");
  const document = {
    querySelectorAll: selector => { state.domReads++; return root().querySelectorAll(selector); },
    getElementById: id => { state.domReads++; return allNodes(root()).find(el => el.id === id) ?? null; }
  };
  const context = {
    JSON, Array, Object, String, Number, RegExp, Error, Promise, Math,
    location, document,
    Date: { now: () => (state.now += 1) },
    setTimeout: fn => { state.polls++; state.now += 100; fn(); },
    fetch: async () => { state.fetches++; throw new Error("read-only tools make no requests"); }
  };
  const tool = runInNewContext(`(${source(name)})`, context)[0];
  const spy = () => { for (const el of allNodes(root())) el.click = el.dispatchEvent = () => { state.clicks++; }; };
  return { tool, state, location, run: async input => {
    spy();
    const result = plain(await tool.execute(input));
    assert.ok(conforms(tool.tool.outputSchema, result), `${name} output violates its schema: ${JSON.stringify(result)}`);
    return result;
  } };
}

const NAMES = ["list_connected_services", "get_settings"];
const START = { list_connected_services: "https://app.instinct.com/workspace", get_settings: "https://app.instinct.com/settings" };
const goodDom = name => (name === "get_settings" ? settingsDom() : workspaceDom());

for (const name of NAMES) {
  test(`${name}: single-expression read-only page tool with domain patterns and typed schemas`, () => {
    const { tool } = page(name, { url: START[name], dom: goodDom(name) });
    assert.equal(tool.kind, "page");
    assert.equal(tool.tool.name, name);
    assert.deepEqual(plain(tool.match.url_patterns), ["https://instinct.com/*", "https://*.instinct.com/*"]);
    assert.deepEqual(plain(tool.tool.inputSchema), { type: "object", additionalProperties: false, properties: {} });
    assert.equal(tool.tool.outputSchema.oneOf.length, 2);
    assert.equal(tool.tool.annotations.readOnlyHint, true);
    assert.equal(/;\s*$/.test(source(name)), false);
    assert.equal(/\b(?:Buffer|require|process|gotoUrl|js|click)\(|\.click\(|\bfetch\(|\.submit\(|\.value\s*=/.test(source(name)), false);
  });

  test(`${name}: rejects malformed input before reading the page`, async () => {
    for (const input of [null, undefined, "x", 7, [], [1], { anything: 1 }, { limit: 5 }]) {
      const h = page(name, { url: START[name], dom: goodDom(name) });
      const result = await h.run(input);
      assert.equal(result.error_kind, "invalid_input", JSON.stringify(input));
      assert.equal(h.state.domReads, 0);
    }
  });

  test(`${name}: reports wrong_page with the entry URL off the app and off its page, without reading the DOM`, async () => {
    const path = new URL(START[name]).pathname;
    for (const url of ["https://instinct.com/", "https://www.instinct.com/terms", "https://api.instinct.com/", `https://example.com${path}`, `https://www.instinct.com${path}`, `https://instinct.com${path}`, `http://app.instinct.com${path}`,
      name === "get_settings" ? "https://app.instinct.com/workspace" : "https://app.instinct.com/settings", "https://app.instinct.com/vault", "https://app.instinct.com/"]) {
      const h = page(name, { url, dom: goodDom(name) });
      const result = await h.run({});
      assert.equal(result.error_kind, "wrong_page", url);
      assert.equal(result.entry_url, START[name]);
      assert.equal(h.state.domReads, 0, url);
    }
  });

  test(`${name}: reports not_logged_in on the sign-in page, including a redirect that happens while it waits`, async () => {
    const direct = page(name, { url: "https://app.instinct.com/login", dom: goodDom(name) });
    assert.equal((await direct.run({})).error_kind, "not_logged_in");
    assert.equal(direct.state.domReads, 0);
    const redirected = page(name, { url: START[name], dom: (polls, location) => { if (polls >= 3) location.pathname = "/login"; return null; } });
    const result = await redirected.run({});
    assert.equal(result.error_kind, "not_logged_in");
    assert.ok(redirected.state.polls >= 3);
  });

  test(`${name}: waits for a late render, then times out as not_ready`, async () => {
    const late = page(name, { url: START[name], dom: polls => (polls >= 5 ? goodDom(name) : null) });
    assert.equal((await late.run({})).status, "ok");
    assert.equal(late.state.polls, 5);
    const never = page(name, { url: START[name], dom: () => null });
    const result = await never.run({});
    assert.equal(result.error_kind, "not_ready");
    assert.ok(never.state.now >= 8000 && never.state.now < 8500, "bounded wait of about 8 seconds");
  });

  test(`${name}: makes no requests and clicks nothing`, async () => {
    const h = page(name, { url: START[name], dom: goodDom(name) });
    assert.equal((await h.run({})).status, "ok");
    assert.equal(h.state.fetches, 0);
    assert.equal(h.state.clicks, 0);
  });
}

test("list_connected_services: reads every connector row with id, name, badge and description", async () => {
  const result = await page("list_connected_services", { dom: workspaceDom() }).run({});
  assert.deepEqual(result, {
    status: "ok",
    truncated: false,
    connectors: [
      { connector_id: "mail-suite", name: "Example Mail Suite", badge: null, description: "Mail, calendar and files", connected: false },
      { connector_id: "issues", name: "Example Issues", badge: null, description: "Search and update issues. Create issues and add comments", connected: false },
      { connector_id: "wallet", name: "Example Pay", badge: "Beta", description: "Checkout seamlessly with Example Pay.", connected: false }
    ]
  });
  assert.equal(JSON.stringify(result).includes("example.invalid"), false, "the contact section is not read");
});

test("list_connected_services: returns only id and name for a row that does not offer Connect", async () => {
  const rows = [
    connectorRow("mail-suite", "Example Mail Suite", "Connected as Jane Doe (workspace acme-corp)", { label: "Disconnect", badge: "Beta" }),
    connectorRow("issues", "Example Issues", "Signed in: jdoe_1985 / org 8f3a2c1d", { label: "Manage jdoe_1985" }),
    connectorRow("notes", "Example Notes", "Meeting notes", { label: "+1 555 0100 (linked)", extra: h("span", {}, "third span") }),
    connectorRow("chat", "Example Chat", "Read and send messages", { label: "" }),
    connectorRow("wallet", "Example Pay", "Checkout")
  ];
  const result = await page("list_connected_services", { dom: workspaceDom(rows) }).run({});
  assert.deepEqual(result.connectors, [
    { connector_id: "mail-suite", name: "Example Mail Suite", badge: null, description: null, connected: null },
    { connector_id: "issues", name: "Example Issues", badge: null, description: null, connected: null },
    { connector_id: "notes", name: "Example Notes", badge: null, description: null, connected: null },
    { connector_id: "chat", name: "Example Chat", badge: null, description: null, connected: null },
    { connector_id: "wallet", name: "Example Pay", badge: null, description: "Checkout", connected: false }
  ]);
});

test("list_connected_services: a row without a button is reported, not dropped or treated as drift", async () => {
  const noButton = h("div", { id: "connector-status" }, h("div", {}, h("span", {}, h("svg")), h("div", {}, h("span", {}, "Example Status"), h("span", {}, "Shows a state")), h("div", {}, h("span", {}, "Connected"))));
  const harness = page("list_connected_services", { dom: workspaceDom([connectorRow("mail-suite", "Example Mail Suite", "Mail"), noButton]) });
  const result = await harness.run({});
  assert.deepEqual(result.connectors.map(c => [c.connector_id, c.description, c.connected]), [["mail-suite", "Mail", false], ["status", null, null]]);
  assert.ok(harness.state.now >= 8000, "a row is read as buttonless only after the wait for its button ran out");
});

test("list_connected_services: waits for a half-rendered row instead of reading it early", async () => {
  const shell = h("div", { id: "connector-mail-suite" });
  const noButton = h("div", { id: "connector-mail-suite" }, h("div", {}, h("span", {}, h("svg")), h("div", {}, h("span", {}, "Example Mail Suite"), h("span", {}, "Mail")), h("div", {})));
  const shellFirst = page("list_connected_services", { dom: polls => workspaceDom(polls < 5 ? [shell] : [connectorRow("mail-suite", "Example Mail Suite", "Mail")]) });
  assert.deepEqual((await shellFirst.run({})).connectors, [{ connector_id: "mail-suite", name: "Example Mail Suite", badge: null, description: "Mail", connected: false }]);
  const buttonLate = page("list_connected_services", { dom: polls => workspaceDom(polls < 12 ? [noButton] : [connectorRow("mail-suite", "Example Mail Suite", "Mail")]) });
  const result = await buttonLate.run({});
  assert.equal(result.connectors[0].connected, false);
  assert.equal(buttonLate.state.polls, 12);
});

test("list_connected_services: waits for a row's name and description structure as well as its button", async () => {
  const partial = h("div", { id: "connector-mail-suite" }, h("div", {}, h("span", {}, h("svg")), h("div", {}, h("span", {}, "Example Mail Suite")), h("div", {}, h("button", { type: "button" }, "Connect"))));
  const harness = page("list_connected_services", { dom: polls => workspaceDom(polls < 4 ? [partial] : [connectorRow("mail-suite", "Example Mail Suite", "Mail")]) });
  assert.deepEqual((await harness.run({})).connectors, [{ connector_id: "mail-suite", name: "Example Mail Suite", badge: null, description: "Mail", connected: false }]);
  assert.equal(harness.state.polls, 4);
});

test("list_connected_services: ignores elements that are not row divs, even at the top of the list", async () => {
  const helper = h("a", { id: "connector-help", href: "/help" }, "Need a connector?");
  const dom = h("div", {}, h("section", {}, h("div", {}, h("div", {}, h("h2", {}, "Connectors"))), h("div", {}, helper, connectorRow("mail-suite", "Example Mail Suite", "Mail"))));
  const result = await page("list_connected_services", { dom }).run({});
  assert.deepEqual(result.connectors.map(c => c.connector_id), ["mail-suite"]);
});

test("list_connected_services: a nested element carrying the row id prefix is not a second row", async () => {
  const nested = h("div", { id: "connector-mail-suite" }, h("div", {},
    h("span", {}, h("svg")),
    h("div", {}, h("span", {}, "Example Mail Suite"), h("span", {}, "Mail")),
    h("div", {}, h("button", { type: "button" }, "Connect"), h("div", { id: "connector-mail-suite-tooltip" }, h("span", {}, "Hint")))));
  const result = await page("list_connected_services", { dom: workspaceDom([nested, connectorRow("issues", "Example Issues", "Issues")]) }).run({});
  assert.deepEqual(result.connectors.map(c => c.connector_id), ["mail-suite", "issues"]);
});

test("list_connected_services: treats only the exact Connect label as the observed layout", async () => {
  const rows = ["Connected", "Connect another account", "connect", "Connect now", "Reconnect"].map((label, i) => connectorRow(`svc-${i}`, `Service ${i}`, "Does things", { label }));
  const result = await page("list_connected_services", { dom: workspaceDom(rows) }).run({});
  assert.deepEqual(result.connectors.map(c => [c.description, c.connected]), rows.map(() => [null, null]));
});

test("list_connected_services: withholds any text with an '@' or a phone-like run of seven or more digits", async () => {
  const digits = ["555-0100", "555\u20130100", "555/0100", "555_0100", "555\u00b70100", "+1 (555) 010-0100", "\uff15\uff15\uff15\uff10\uff11\uff10\uff10", "5 5 5 0 1 0 0"];
  for (const value of digits) {
    const result = await page("list_connected_services", { dom: workspaceDom([connectorRow("wallet", "Example Pay", `Call ${value}`, { badge: value })]) }).run({});
    assert.deepEqual([result.connectors[0].badge, result.connectors[0].description], [null, null], value);
    const named = await page("list_connected_services", { dom: workspaceDom([connectorRow("wallet", `Pay ${value}`, "Checkout")]) }).run({});
    assert.equal(named.error_kind, "site_changed", value);
    assert.match(named.error_message, /'@' or a phone-like run of seven or more digits/);
  }
  const short = await page("list_connected_services", { dom: workspaceDom([connectorRow("wallet", "Example Pay 365", "Checkout since 2024, ref 123456", { badge: "v2" })]) }).run({});
  assert.deepEqual(short.connectors[0], { connector_id: "wallet", name: "Example Pay 365", badge: "v2", description: "Checkout since 2024, ref 123456", connected: false });
});

test("list_connected_services: never returns text that looks like an email or number, even in an observed-layout row", async () => {
  const rows = [
    connectorRow("wallet", "Example Pay", "Sign in as a@b.co", { badge: "555-0100 line" }),
    connectorRow("mail-suite", "Example Mail (person@example.net)", "Mail"),
    connectorRow("person@example.net", "Example Other", "Other"),
    connectorRow("phone", "Example Chat 5550100", "Chat")
  ];
  for (const bad of [rows[1], rows[2], rows[3]]) {
    const result = await page("list_connected_services", { dom: workspaceDom([rows[0], bad]) }).run({});
    assert.equal(result.error_kind, "site_changed");
    assert.equal(/person@example|5550100|a@b\.co|555-0100/.test(JSON.stringify(result)), false);
  }
  const ok = await page("list_connected_services", { dom: workspaceDom([rows[0]]) }).run({});
  assert.deepEqual(ok.connectors[0], { connector_id: "wallet", name: "Example Pay", badge: null, description: null, connected: false });
});

test("list_connected_services: caps names, ids, badges and descriptions", async () => {
  const long = "a".repeat(400);
  const result = await page("list_connected_services", { dom: workspaceDom([connectorRow(long, long, long, { badge: long })]) }).run({});
  const [row] = result.connectors;
  assert.deepEqual([row.connector_id.length, row.name.length, row.badge.length, row.description.length], [80, 80, 300, 300]);
});

test("list_connected_services: caps the list at 50 rows and says so only above 50", async () => {
  const rowsOf = n => Array.from({ length: n }, (_, i) => connectorRow(`svc-${i}`, `Service ${i}`, "Does things"));
  const exact = await page("list_connected_services", { dom: workspaceDom(rowsOf(50)) }).run({});
  assert.deepEqual([exact.connectors.length, exact.truncated], [50, false]);
  const over = await page("list_connected_services", { dom: workspaceDom(rowsOf(60)) }).run({});
  assert.equal(over.connectors.length, 50);
  assert.equal(over.connectors[49].connector_id, "svc-49");
  assert.equal(over.truncated, true);
});

test("list_connected_services: reads only the Connectors section and only its row elements", async () => {
  const stray = h("div", { id: "connector-stray" }, h("div", {}, h("div", {}, h("span", {}, "Stray"), h("span", {}, "Outside the section")), h("div", {}, h("button", { type: "button" }, "Connect"))));
  const nested = connectorRow("mail-suite", "Example Mail Suite", "Mail", { extra: h("span", { id: "connector-mail-suite-note" }, "not a row") });
  const dom = h("div", {}, h("section", {}, h("h2", {}, "Contact"), stray), workspaceDom([nested]).children[1], h("section", {}, h("h2", {}, "Connectors (legacy)"), connectorRow("old", "Old", "Old row")));
  const result = await page("list_connected_services", { dom }).run({});
  assert.deepEqual(result.connectors.map(c => c.connector_id), ["mail-suite"]);
  const legacyOnly = h("div", {}, h("section", {}, h("h2", {}, "Connectors (legacy)"), connectorRow("old", "Old", "Old row")));
  assert.equal((await page("list_connected_services", { dom: legacyOnly }).run({})).error_kind, "not_ready");
});

test("list_connected_services: reports site_changed when rows lose their structure, not an empty success", async () => {
  const noName = connectorRow("y", "", "Does things");
  const oneSpan = h("div", { id: "connector-z" }, h("div", {}, h("div", {}, h("span", {}, "Z")), h("div", {}, h("button", { type: "button" }, "Connect"))));
  for (const dom of [workspaceDom([noName]), workspaceDom([oneSpan]), workspaceDom([])]) {
    const result = await page("list_connected_services", { dom }).run({});
    assert.equal(result.error_kind, "site_changed");
  }
  assert.equal((await page("list_connected_services", { dom: workspaceDom(observedRows(), { heading: false }) }).run({})).error_kind, "not_ready");
});

test("get_settings: reads the training switch and the link states without returning identifiers", async () => {
  const result = await page("get_settings", { url: START.get_settings, dom: settingsDom() }).run({});
  assert.deepEqual(result, { status: "ok", training_data_opt_out: true, icloud_email_linked: false, whatsapp_connected: false });
  const on = await page("get_settings", { url: START.get_settings, dom: settingsDom({ checked: "true" }) }).run({});
  assert.equal(on.training_data_opt_out, false);
});

test("get_settings: leaves the link flags null for unobserved layouts and never returns the linked address or number", async () => {
  for (const dom of [settingsDom({ icloud: "person@example.net", whatsapp: "+1 555 0100" }), settingsDom({ omit: ["icloud", "whatsapp"] })]) {
    const result = await page("get_settings", { url: START.get_settings, dom }).run({});
    assert.deepEqual(result, { status: "ok", training_data_opt_out: true, icloud_email_linked: null, whatsapp_connected: null });
  }
  const mixed = await page("get_settings", { url: START.get_settings, dom: settingsDom({ icloud: "person@example.net" }) }).run({});
  assert.deepEqual([mixed.icloud_email_linked, mixed.whatsapp_connected], [null, false]);
  const text = JSON.stringify(await page("get_settings", { url: START.get_settings, dom: settingsDom() }).run({}));
  assert.equal(/Fixture|555|@/.test(text), false, "display name and phone are not read");
});

test("get_settings: reports site_changed when the switch is not the one it expects", async () => {
  for (const dom of [
    settingsDom({ role: "checkbox" }),
    settingsDom({ label: "Share usage data" }),
    settingsDom({ checked: "mixed" }),
    settingsDom({ checked: "" })
  ]) {
    const result = await page("get_settings", { url: START.get_settings, dom }).run({});
    assert.equal(result.error_kind, "site_changed");
  }
});

test("get_settings: Not linked and Not connected must be the text of a leaf span, not a wrapper with other content", async () => {
  const wrapped = text => h("span", {}, h("svg"), text);
  const result = await page("get_settings", { url: START.get_settings, dom: settingsDom({ icloud: wrapped("Not linked"), whatsapp: wrapped("Not connected") }) }).run({});
  assert.deepEqual([result.icloud_email_linked, result.whatsapp_connected], [null, null]);
});

test("get_settings: only the exact Not linked and Not connected texts count", async () => {
  for (const [icloud, whatsapp] of [["Not linked yet", "Not connected yet"], ["Was Not linked", "Was Not connected"], ["not linked", "not connected"]]) {
    const result = await page("get_settings", { url: START.get_settings, dom: settingsDom({ icloud, whatsapp }) }).run({});
    assert.deepEqual([result.icloud_email_linked, result.whatsapp_connected], [null, null], `${icloud} / ${whatsapp}`);
  }
});

test("get_settings: reports site_changed when the switch has no aria-checked or its label points elsewhere", async () => {
  for (const dom of [settingsDom({ checked: null }), settingsDom({ labelFor: "another-control" })]) {
    const result = await page("get_settings", { url: START.get_settings, dom }).run({});
    assert.equal(result.error_kind, "site_changed");
  }
});

test("get_settings: takes Not linked and Not connected only from their own rows", async () => {
  const dom = settingsDom({ icloud: "person@example.net", whatsapp: "+1 555 0100", stray: true });
  const result = await page("get_settings", { url: START.get_settings, dom }).run({});
  assert.deepEqual(result, { status: "ok", training_data_opt_out: true, icloud_email_linked: null, whatsapp_connected: null });
});
