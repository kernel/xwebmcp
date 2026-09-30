import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { Document, DOMParser } from "./etsy-dom.mjs";

const ORIGIN = "https://www.amazon.in";
const asin = "B0TESTAAA1";
const input = { asin, expected_price_inr: 299.5 };
const names = ["get_cart", "add_to_cart"];
const definitions = Object.fromEntries(names.map(name => [name, runInNewContext(`(${readFileSync(new URL(`../domains/amazon.in/${name}.js`, import.meta.url), "utf8")})`)[0]]));
const template = readFileSync(new URL("./fixtures/amazon-in/cart.html", import.meta.url), "utf8");
const empty = template.replace("{{ITEMS}}", '<div id="sc-empty-cart">Your cart is empty</div>');
const line = (id = asin, quantity = 1) => `<div class="sc-list-item" data-asin="${id}" data-quantity="${quantity}"><span class="sc-product-title">Acme bottle</span></div>`;
const filled = (id = asin, quantity = 1) => template.replace("{{ITEMS}}", line(id, quantity));
const plain = value => JSON.parse(JSON.stringify(value));
function validate(schema, value) {
  if (schema.oneOf) return schema.oneOf.filter(s => validate(s, value)).length === 1;
  if ("const" in schema && schema.const !== value) return false;
  if (schema.enum && !schema.enum.includes(value)) return false;
  if (schema.type === "object" && (!value || typeof value !== "object" || Array.isArray(value))) return false;
  if (schema.type === "array" && !Array.isArray(value)) return false;
  if (schema.type === "integer" && !Number.isInteger(value)) return false;
  if (["number", "string", "boolean"].includes(schema.type) && typeof value !== schema.type) return false;
  if (schema.required?.some(k => !Object.hasOwn(value, k))) return false;
  if (schema.additionalProperties === false && Object.keys(value).some(k => !Object.hasOwn(schema.properties || {}, k))) return false;
  if (schema.properties && Object.entries(schema.properties).some(([k, s]) => k in value && !validate(s, value[k]))) return false;
  if (schema.items && !value.every(v => validate(schema.items, v))) return false;
  if (schema.maxItems !== undefined && value.length > schema.maxItems) return false;
  if (schema.minLength !== undefined && value.length < schema.minLength) return false;
  if (schema.maxLength !== undefined && value.length > schema.maxLength) return false;
  if (schema.pattern && !new RegExp(schema.pattern).test(value)) return false;
  if (schema.minimum !== undefined && value < schema.minimum) return false;
  if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) return false;
  if (schema.maximum !== undefined && value > schema.maximum) return false;
  return true;
}
function harness(name, { before = empty, after = filled(), respond, origin = ORIGIN, document = new Document(empty), storageFail = false } = {}) {
  const requests = [], store = new Map(), controller = new AbortController();
  let writes = 0;
  const fetch = async (url, init = {}) => {
    requests.push({ url, ...init });
    const post = init.method === "POST";
    if (post) writes++;
    const r = respond ? await respond(url, init, requests.length, controller) : { body: writes ? after : before };
    if (r instanceof Error) throw r;
    const status = r.status ?? 200;
    return { status, ok: status >= 200 && status < 300, url: r.url ?? url, headers: { get: key => r.headers?.[key] ?? null }, text: async () => r.body ?? "" };
  };
  const sessionStorage = { getItem: k => { if (storageFail) throw new Error("denied"); return store.get(k) ?? null; }, setItem: (k, v) => { if (storageFail) throw new Error("denied"); store.set(k, v); }, removeItem: k => store.delete(k) };
  const execute = runInNewContext(`(${definitions[name].execute.toString()})`, { location: { origin }, document, fetch, DOMParser, URL, URLSearchParams, sessionStorage });
  return { requests, store, controller, run: async (i = name === "get_cart" ? {} : input) => {
    const r = plain(await execute(i, { signal: controller.signal }));
    assert.ok(validate(definitions[name].tool.outputSchema, r), JSON.stringify(r));
    for (const secret of ["FAKE-CSRF", "FAKE-OFFER", "Test Person", "Testville", "400001", "000-0000000", "token=FAKE", "Private saved item"]) assert.ok(!JSON.stringify(r).includes(secret), secret);
    return r;
  } };
}

test("cart tools are page expressions and match sorted draft registry entries", () => {
  const registry = JSON.parse(readFileSync(new URL("../registry.json", import.meta.url), "utf8"));
  for (const name of names) {
    const d = definitions[name], entry = registry.tools.find(e => e.domain === "amazon.in" && e.tool === name);
    assert.equal(d.kind, "page");
    assert.equal(entry.kind, d.kind);
    assert.deepEqual(plain(d.match.url_patterns), ["https://www.amazon.in/*"]);
    assert.deepEqual(entry.url_patterns, plain(d.match.url_patterns));
    assert.equal(d.tool.annotations.readOnlyHint, name === "get_cart");
    assert.equal(d.tool.annotations.idempotentHint, name === "get_cart");
    assert.equal(d.tool.annotations.destructiveHint, false);
  }
});
test("read empty guest cart and bounded INR recommendations without tokens or saved items", async () => {
  const h = harness("get_cart"), r = await h.run();
  assert.equal(r.status, "ok"); assert.equal(r.line_count, 0); assert.equal(r.fulfillment_context, "current_session_undisclosed");
  assert.deepEqual(r.recommendations, [{ asin, title: "Acme bottle", price_inr: 299.5, quantity: 1, url: ORIGIN + "/dp/" + asin, can_add_to_empty_cart: true }]);
  assert.equal(h.requests.length, 1); assert.equal(h.requests[0].credentials, "include"); assert.equal(h.requests[0].method, undefined);
});
test("read populated template, excluding removed rows and never marking recommendations addable", async () => {
  const before = filled().replace("</div>\n<div id=\"sc-saved-cart\">", '<div class="sc-list-item" data-removed="true">Removed</div></div>\n<div id="sc-saved-cart">');
  const r = await harness("get_cart", { before }).run();
  assert.equal(r.line_count, 1); assert.equal(r.items[0].quantity, 1); assert.equal(r.recommendations[0].can_add_to_empty_cart, false);
});
test("malformed inputs fail before requests or storage", async () => {
  for (const name of names) for (const bad of [null, [], "x", { x: 1 }, ...(name === "add_to_cart" ? [{}, { asin, expected_price_inr: null }, { ...input, asin: "bad" }, { ...input, quantity: 2 }, { ...input, confirmed: true }, { ...input, expected_price_inr: NaN }, { ...input, expected_price_inr: Infinity }, { ...input, expected_price_inr: -1 }, { ...input, expected_price_inr: 1.234 }, { ...input, expected_price_inr: 10000001 }] : [])]) {
    const h = harness(name, { storageFail: true }); assert.equal((await h.run(bad)).error_kind, "invalid_input"); assert.equal(h.requests.length, 0);
  }
});
test("unrelated pages and canceled reads refuse before requesting", async () => {
  for (const name of names) {
    const h = harness(name, { origin: "https://example.test" }); assert.equal((await h.run()).error_kind, "wrong_page"); assert.equal(h.requests.length, 0);
    const c = harness(name); c.controller.abort(); assert.equal((await c.run()).error_kind, "canceled"); assert.equal(c.requests.length, 0);
  }
});
test("missing/signed-in account state, redirects, challenges and HTTP failures fail closed", async () => {
  const cases = [
    [empty.replace("Hello, sign in", "Hello, Test Person"), 200, undefined, "wrong_account"],
    [empty.replace('id="nav-link-accountList-nav-line-1"', 'id="other"'), 200, undefined, "wrong_account"],
    [empty, 200, ORIGIN + "/ap/signin", "login_required"],
    [empty, 200, "https://example.test/cart", "site_error"],
    [empty, 200, ORIGIN + "/dp/" + asin, "site_changed"],
    ['<form action="/errors/validateCaptcha"></form>', 200, undefined, "challenge"],
    [empty, 429, undefined, "rate_limited"], [empty, 503, undefined, "rate_limited"], [empty, 202, undefined, "challenge"], [empty, 500, undefined, "site_error"]
  ];
  for (const name of names) for (const [body, status, url, kind] of cases) {
    const h = harness(name, { respond: () => ({ body, status, url }) }); assert.equal((await h.run()).error_kind, kind); assert.equal(h.requests.length, 1); assert.ok(h.requests.every(r => r.method !== "POST"));
  }
});
test("unreadable active rows are not assumed empty", async () => {
  for (const name of names) for (const before of [empty.replace('id="sc-active-cart"', 'id="other"'), empty.replace('id="sc-empty-cart"', 'id="other"'), filled().replace('data-quantity="1"', 'data-quantity="0"'), filled().replace('data-asin="B0TESTAAA1"', 'data-asin="bad"'), filled().replace('class="sc-product-title"', 'class="other"'), template.replace("{{ITEMS}}", line().repeat(101))]) {
    const h = harness(name, { before }); assert.equal((await h.run()).error_kind, "site_changed"); assert.ok(h.requests.every(r => r.method !== "POST"));
  }
});
test("hidden empty markers and contradictory cart quantities cannot authorise a write", async () => {
  for (const name of names) for (const before of [
    empty.replace('id="sc-empty-cart"', 'id="sc-empty-cart" hidden'),
    empty.replace('id="sc-empty-cart"', 'id="sc-empty-cart" class="aok-hidden"'),
    empty.replace('id="sc-empty-cart"', 'id="sc-empty-cart" style="display:none"'),
    empty.replace('</nav>', '</nav><div id="sc-buy-box" data-quantity="2"></div>')
  ]) { const h = harness(name, { before }); assert.equal((await h.run()).error_kind, "site_changed"); assert.ok(h.requests.every(r => r.method !== "POST")); }
});
test("ambiguous recommendations and disabled/unsupported forms are not advertised as addable", async () => {
  const duplicate = empty.replace('</body>', new Document(empty).querySelector('form').outerHTML + '</body>');
  const h = harness('add_to_cart', { before: duplicate }); assert.equal((await h.run()).error_kind, 'not_available'); assert.equal(h.requests.length, 1);
  assert.equal((await harness('get_cart', { before: duplicate }).run()).recommendations[0].can_add_to_empty_cart, false);
  for (const before of [empty.replace('_encoding=UTF8', 'isBuyNow=1'), empty.replace('</form>', '<select name="quantity"></select></form>'), empty.replace('type="submit"', 'type="submit" disabled')]) {
    assert.equal((await harness('get_cart', { before }).run()).recommendations.length, 0);
    assert.equal((await harness('add_to_cart', { before }).run()).error_kind, 'site_changed');
  }
});
test("empty markers hidden by ancestor inline styles cannot authorise writes", async () => {
  for (const style of ["display:none", "visibility:hidden", "visibility:collapse"]) for (const name of names) {
    const before = empty.replace('<div id="sc-empty-cart">Your cart is empty</div>', `<section style="${style}"><div id="sc-empty-cart">Your cart is empty</div></section>`);
    const h = harness(name, { before }); assert.equal((await h.run()).error_kind, "site_changed"); assert.ok(h.requests.every(r => r.method !== "POST"));
  }
});
test("cart summary quantity must agree with populated rows before and after writes", async () => {
  const contradictory = filled().replace('</nav>', '</nav><div id="sc-buy-box" data-quantity="2"></div>');
  for (const name of names) {
    const h = harness(name, { before: contradictory }); assert.equal((await h.run()).error_kind, "site_changed"); assert.ok(h.requests.every(r => r.method !== "POST"));
  }
  const h = harness("add_to_cart", { after: contradictory }); const r = await h.run();
  assert.equal(r.error_kind, "outcome_unknown"); assert.equal(r.write_attempted, true); assert.equal(h.store.size, 1);
  const count = h.requests.length; assert.equal((await h.run()).error_kind, "outcome_unknown"); assert.equal(h.requests.length, count);
  assert.equal((await harness("get_cart", { before: filled().replace('</nav>', '</nav><div id="sc-buy-box" data-quantity="1"></div>') }).run()).line_count, 1);
});
test("another product's price or multiple prices in a card never authorise a write", async () => {
  for (const extra of [
    '<a href="/Example/dp/B0TESTBBB2/ref=example"><span class="a-price"><span class="a-offscreen">₹199.00</span></span></a>',
    '<span class="a-price"><span class="a-offscreen">₹199.00</span></span>',
    '<a href="/Example/dp/B0TESTBBB2/ref=example">Another item</a>'
  ]) {
    const before = empty.replace('<div class="a-fixed-left-grid-inner">', '<div class="a-fixed-left-grid-inner">' + extra);
    assert.equal((await harness("get_cart", { before }).run()).recommendations.length, 0);
    const h = harness("add_to_cart", { before }); assert.equal((await h.run()).error_kind, "site_changed"); assert.equal(h.requests.length, 1);
  }
});
test("already present and other cart contents cause no duplicate write", async () => {
  assert.equal((await harness("add_to_cart", { before: filled() }).run()).status, "already_present");
  for (const before of [filled(asin, 2), filled("B0TESTBBB2"), template.replace("{{ITEMS}}", line() + line("B0TESTBBB2"))]) {
    const h = harness("add_to_cart", { before }); assert.equal((await h.run()).error_kind, "state_changed"); assert.equal(h.requests.length, 1);
  }
});
test("price and unsupported recommendation form checks never POST", async () => {
  const mutations = [
    [s => s.replace("₹299.50", "₹300.00"), "price_changed"],
    [s => s.replace("₹299.50", "$299.50"), "site_changed"],
    [s => s.replace("/cart/add-to-cart/ref=example", "/gp/product/handle-buy-box/ref=example"), "site_changed"],
    [s => s.replace('action="/cart/', 'action="https://example.test/cart/'), "site_changed"],
    [s => s.replace("_encoding=UTF8", "isBuyNow=1"), "site_changed"],
    [s => s.replace('method="post"', 'method="get"'), "site_changed"],
    [s => s.replace('value="FAKE-CSRF"', 'value=""'), "site_changed"],
    [s => s.replace('value="FAKE-OFFER"', 'value=""'), "site_changed"],
    [s => s.replace('name="customizers" value=""', 'name="customizers" value="extras"'), "site_changed"],
    [s => s.replace('name="items[0.base][quantity]" value="1"', 'name="items[0.base][quantity]" value="2"'), "site_changed"],
    [s => s.replace('</form>', '<input name="isBuyNow" value="1"></form>'), "site_changed"],
    [s => s.replace('</form>', '<input name="anti-csrftoken-a2z" value="SECOND"></form>'), "site_changed"],
    [s => s.replace('</form>', '<select name="gift"><option>yes</option></select></form>'), "site_changed"],
    [s => s.replace('type="submit"', 'type="hidden"'), "site_changed"],
    [s => s.replace('class="a-fixed-left-grid-inner"', 'class="other"'), "site_changed"],
    [s => s.replace('class="add-to-cart-data"', 'class="other"'), "not_available"]
  ];
  for (const [mutate, kind] of mutations) { const h = harness("add_to_cart", { before: mutate(empty) }); assert.equal((await h.run()).error_kind, kind); assert.equal(h.requests.length, 1); }
});
test("one dedicated POST plus readback verifies exact quantity; tokens stay request-local", async () => {
  const h = harness("add_to_cart"), r = await h.run(); assert.equal(r.status, "ok"); assert.equal(r.write_attempted, true);
  assert.equal(h.requests.length, 3); const post = h.requests[1]; assert.equal(post.method, "POST"); assert.equal(post.redirect, "error"); assert.equal(post.credentials, "include");
  const params = new URLSearchParams(post.body); assert.equal(params.get("items[0.base][asin]"), asin); assert.equal(params.get("items[0.base][quantity]"), "1"); assert.equal(params.get("anti-csrftoken-a2z"), "FAKE-CSRF"); assert.equal(params.get("items[0.base][offerListingId]"), "FAKE-OFFER"); assert.ok(params.has("submit.addToCart")); assert.ok(!params.has("submit.buy-now")); assert.equal(h.store.size, 0);
  assert.equal((await h.run()).status, "already_present"); assert.equal(h.requests.filter(r => r.method === "POST").length, 1);
});
test("uncertain network/HTTP/redirect/cancel and wrong postconditions never retry", async () => {
  for (const after of [empty, filled(asin, 2), filled("B0TESTBBB2"), empty.replace("Hello, sign in", "Hello, Test Person"), '<form action="/errors/validateCaptcha"></form>']) {
    const h = harness("add_to_cart", { after }); const r = await h.run(); assert.equal(r.error_kind, "outcome_unknown"); assert.equal(r.write_attempted, true); assert.equal(h.store.size, 1);
    const count = h.requests.length; assert.equal((await h.run()).error_kind, "outcome_unknown"); assert.equal(h.requests.length, count);
  }
  const h = harness("add_to_cart", { respond: (url, init, n) => init.method === "POST" ? new Error("uncertain") : n === 1 ? { body: empty } : new Error("unreadable") });
  assert.equal((await h.run()).error_kind, "outcome_unknown"); assert.equal(h.requests.filter(r => r.method === "POST").length, 1);
  const redirect = harness("add_to_cart", { respond: (url, init, n) => init.method === "POST" ? new Error("redirect refused") : { body: n === 1 ? empty : filled() } });
  assert.equal((await redirect.run()).status, "ok"); assert.equal(redirect.requests.filter(r => r.method === "POST").length, 1);
  const canceled = harness("add_to_cart", { respond: (url, init, n, c) => { if (init.method === "POST") c.abort(); return { body: empty }; } });
  assert.equal((await canceled.run()).error_kind, "outcome_unknown"); assert.equal(canceled.requests.length, 2);
});
test("write guard must be available, current signed-in page is refused before fetch", async () => {
  const h = harness("add_to_cart", { storageFail: true }); assert.equal((await h.run()).error_kind, "site_error"); assert.equal(h.requests.length, 0);
  const s = harness("add_to_cart", { document: new Document(empty.replace("Hello, sign in", "Hello, Test Person")) }); assert.equal((await s.run()).error_kind, "wrong_account"); assert.equal(s.requests.length, 0);
});
