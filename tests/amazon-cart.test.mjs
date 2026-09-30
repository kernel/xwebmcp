import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { webcrypto } from "node:crypto";
import { createContext, runInContext, runInNewContext } from "node:vm";
import test from "node:test";
import { DOMParser, Document } from "./etsy-dom.mjs";

const names = ["get_cart", "add_to_cart", "update_cart_item", "remove_cart_item", "prepare_checkout"];
const sources = Object.fromEntries(names.map(n => [n, readFileSync(new URL(`../domains/amazon.com/${n}.js`, import.meta.url), "utf8")]));
const plain = x => JSON.parse(JSON.stringify(x));
const item = (id = "test_line_1", asin = "B0TEST0001", quantity = 1, extra = "") => ({ id, asin, quantity, extra });
const fixture = ({ lines = [], saved = [], other = false, empty = true, csrf = true } = {}) => `<html><head><title>Amazon.com Shopping Cart</title>${csrf ? '<meta id="cart-sp-csrf" content="fabricated_csrf">' : ""}</head><body>
<div id="sc-collapsed-carts-container">${other ? "<div>Other cart</div>" : ""}</div>
<div id="sc-active-cart">${!lines.length && empty ? '<div id="sc-empty-cart">Empty cart</div>' : ""}${lines.map(l => row(l)).join("")}<span id="sc-subtotal-amount-activecart">$29.99</span></div>
<div id="sc-saved-cart">${saved.map(l => row(l, "saved")).join("")}</div><div id="glow-ingress-line2">Private location not returned</div></body></html>`;
const row = (l, type = "active") => `<div class="sc-list-item" id="sc-${type}-${l.id}" data-itemid="${l.id}" data-itemtype="${type}" data-asin="${l.asin}" data-quantity="${l.quantity}" data-price="29.99" data-isselected="1" ${l.extra || ""}><span class="sc-product-title"><span class="a-truncate-full">Fabricated bottle</span><script>secret</script></span><span class="sc-product-price">$29.99</span></div>`;
const product = ({ asin = "B0TEST0001", endpoint = "/gp/product/handle-buy-box/ref=dp_start", price = "$29.99", seller = "Testseller", extra = "", qty = "1", disabled = false } = {}) => `<html><head><title>Test product</title></head><body><div id="corePriceDisplay_desktop_feature_div"><span class="priceToPay"><span class="a-offscreen">${price}</span></span></div><div id="merchantInfoFeature_feature_div"><span class="offer-display-feature-text-message">${seller}</span></div><form id="addToCart" method="post" action="${endpoint}">
<input name="ASIN" value="${asin}"><input name="offerListingID" value="fabricated_offer"><input name="merchantID" value="fabricated_merchant"><input name="anti-csrftoken-a2z" value="fabricated_product_csrf"><select name="quantity">${qty.split(",").map(v => `<option value="${v}">${v}</option>`).join("")}</select><input name="submit.add-to-cart" type="submit" ${disabled ? "disabled" : ""}>
<input name="isBuyNow" value="1"><input name="submit.buy-now" value="Buy Now"><input name="pipelineType" value="Chewbacca"><input name="session-id" value="private_session"><input name="gift-wrap" type="checkbox" value="on">${extra}</form></body></html>`;

function conforms(s, v) {
  if (s.oneOf && s.oneOf.filter(x => conforms(x, v)).length !== 1) return false;
  if (s.const !== undefined && s.const !== v || s.enum && !s.enum.includes(v)) return false;
  if (s.type && ![].concat(s.type).some(t => t === "null" ? v === null : t === "array" ? Array.isArray(v) : t === "integer" ? Number.isInteger(v) : t === "object" ? v && typeof v === "object" && !Array.isArray(v) : typeof v === t)) return false;
  if (Array.isArray(v) && (v.length > (s.maxItems ?? Infinity) || s.items && !v.every(x => conforms(s.items, x)))) return false;
  if (v && typeof v === "object" && !Array.isArray(v)) {
    if (s.required?.some(k => !(k in v))) return false;
    if (s.additionalProperties === false && Object.keys(v).some(k => !(k in s.properties))) return false;
    if (Object.entries(s.properties || {}).some(([k, x]) => k in v && !conforms(x, v[k]))) return false;
  }
  if (typeof v === "string" && (v.length > (s.maxLength ?? Infinity) || s.pattern && !new RegExp(s.pattern).test(v))) return false;
  if (typeof v === "number" && (v < (s.minimum ?? -Infinity) || v > (s.maximum ?? Infinity))) return false;
  return true;
}

function harness(options = {}) {
  let state = { lines: [], saved: [], ...options.state };
  const doc = new Document("<html><body></body></html>");
  doc.cookie = "session-id=fabricated-session; session-token=fabricated-context";
  const storage = new Map();
  const requests = [];
  const location = new URL(options.url || "https://www.amazon.com/s?k=test");
  const ctx = createContext({ document: doc, location, DOMParser, URL, URLSearchParams, crypto: webcrypto, TextEncoder, sessionStorage: { getItem: k => storage.get(k), setItem: (k, v) => storage.set(k, v) }, fetch: async (path, init) => {
    const u = new URL(path, location.origin);
    requests.push({ path: u.pathname, ...init });
    if (options.handler) {
      const r = await options.handler(u, init, { requests, state, doc });
      if (r) return { status: 200, url: u.href, text: async () => r.body || "", ...r };
    }
    let body;
    if (init.method === "POST") {
      const p = new URLSearchParams(init.body);
      if (u.pathname.startsWith("/gp/product/handle-buy-box")) state.lines.push(item("new_line", p.get("ASIN"), Number(p.get("quantity"))));
      else {
        const [action] = JSON.parse(p.get("actionPayload"));
        if (action.type === "DELETE_START") state.lines = state.lines.filter(l => l.id !== action.payload.itemId);
        else state.lines.find(l => l.id === action.payload.itemId).quantity = action.payload.quantity;
      }
      body = "{}";
    } else body = u.pathname.startsWith("/dp/") ? options.product || product() : fixture(state);
    return { status: 200, url: u.href, text: async () => body };
  } });
  const tools = Object.fromEntries(names.map(n => {
    const [definition] = runInNewContext(`(${sources[n]})`);
    const execute = runInContext(`(${definition.execute.toString()})`, ctx);
    return [n, { definition, execute }];
  }));
  const run = async (name, input = {}, signal) => {
    const result = plain(await tools[name].execute(input, { signal }));
    assert.ok(conforms(tools[name].definition.tool.outputSchema, result), JSON.stringify(result));
    return result;
  };
  return { run, requests, doc, storage, state: () => state };
}
const expect = c => ({ expected_session_context: c.session_context, expected_cart_version: c.cart_version });
const target = { cart_item_id: "test_line_1", asin: "B0TEST0001", expected_quantity: 1 };
const add = { asin: "B0TEST0001", quantity: 1, expected_unit_price_cents: 2999, expected_sold_by: "Testseller" };
const prepared = async (h, name, input) => h.run(name, { ...expect(await h.run("get_cart")), ...input });

for (const name of names) {
  test(`${name}: single self-contained page definition and annotations`, () => {
    const [d] = runInNewContext(`(${sources[name]})`);
    assert.equal(d.kind, "page"); assert.equal(d.tool.name, name);
    assert.deepEqual(plain(d.match.url_patterns), ["https://www.amazon.com/*"]);
    assert.equal(d.tool.annotations.readOnlyHint, ["get_cart", "prepare_checkout"].includes(name));
  });
  test(`${name}: malformed inputs before any request`, async () => {
    for (const input of [null, [], { confirmed: true }, { unexpected: "x" }, "x"]) {
      const h = harness(); assert.equal((await h.run(name, input)).error_kind, "invalid_input"); assert.equal(h.requests.length, 0);
    }
  });
  test(`${name}: unrelated host and checkout fail without interaction`, async () => {
    for (const url of ["https://aws.amazon.com/", "https://www.amazon.com/checkout/entry", "https://www.amazon.com/ap/signin"]) {
      const h = harness({ url });
      const input = name === "add_to_cart" ? { ...add, expected_cart_version: "a".repeat(64), expected_session_context: "b".repeat(64) } : name.endsWith("cart_item") ? { ...target, quantity: 2, expected_cart_version: "a".repeat(64), expected_session_context: "b".repeat(64) } : {};
      if (name === "remove_cart_item") delete input.quantity;
      assert.equal((await h.run(name, input)).error_kind, "wrong_page"); assert.equal(h.requests.length, 0);
    }
  });
}
test("get_cart: empty state, stable session digest, bounded allowlisted fields", async () => {
  const h = harness(); const a = await h.run("get_cart"), b = await h.run("get_cart");
  assert.equal(a.status, "ok"); assert.equal(a.cart_version, b.cart_version); assert.equal(a.items_quantity, 0);
  assert.doesNotMatch(JSON.stringify(a), /fabricated-session|fabricated-context|private|csrf|cookie/);
});
test("get_cart: populated retail shape, saved items not exposed, other carts flagged", async () => {
  const h = harness({ state: { lines: [item()], saved: [item("saved_1", "B0TEST0002")], other: true } });
  const r = await h.run("get_cart"); assert.equal(r.lines[0].quantity, 1); assert.equal(r.lines[0].unit_price_cents, 2999); assert.equal(r.lines[0].title, "Fabricated bottle"); assert.equal(r.other_carts_present, true); assert.doesNotMatch(JSON.stringify(r), /saved_1|secret/);
});
test("get_cart: unknown empty state, malformed line, duplicates, oversized and pagination fail closed", async () => {
  for (const state of [{ empty: false }, { lines: [item("bad id")] }, { lines: [item(), item()] }, { lines: Array.from({ length: 101 }, (_, i) => item(`line_${i}`)) }, { lines: [item("line", "B0TEST0001", 0)] }]) assert.equal((await harness({ state }).run("get_cart")).error_kind, "site_changed");
  const h = harness({ handler: () => ({ body: fixture().replace("Empty cart", '<span class="sc-pagination">Next</span>') }) }); assert.equal((await h.run("get_cart")).error_kind, "site_changed");
});
test("get_cart: challenge, access notice, rate limit, login redirect and failed reads", async () => {
  for (const [body, status, url, kind] of [["<title>Robot Check</title>", 200, undefined, "challenge"], ["<body>Continued access violates Amazon’s Conditions of Use</body>", 200, undefined, "access_gated"], ["", 429, undefined, "rate_limited"], ["", 200, "https://www.amazon.com/ap/signin", "login_required"], ["", 200, "https://evil.example/", "site_changed"], ["", 403, undefined, "site_error"]]) {
    const h = harness({ handler: () => ({ status, url, body }) }); assert.equal((await h.run("get_cart")).error_kind, kind);
  }
});
test("prepare_checkout: always handoff-only with no purchase approval input or request", async () => {
  const h = harness({ state: { lines: [item()] } }); const r = await h.run("prepare_checkout"); assert.equal(r.status, "handoff_only"); assert.equal(r.execution_available, false); assert.equal(h.requests.length, 1); assert.equal(h.requests[0].method, "GET");
});
for (const name of ["add_to_cart", "update_cart_item", "remove_cart_item"]) {
  const input = name === "add_to_cart" ? add : { ...target, ...(name === "update_cart_item" ? { quantity: 2 } : {}) };
  test(`${name}: wrong session and stale cart refuse POST`, async () => {
    const h = harness({ state: { lines: name === "add_to_cart" ? [] : [item()] } });
    const c = await h.run("get_cart"); h.doc.cookie = "session-id=different-session";
    assert.equal((await h.run(name, { ...expect(c), ...input })).error_kind, "wrong_account");
    assert.equal((await h.run(name, { ...expect(await h.run("get_cart")), expected_cart_version: "a".repeat(64), ...input })).error_kind, "stale_cart");
    assert.ok(h.requests.every(r => r.method === "GET"));
  });
  test(`${name}: canceled before requests and unknown after dispatch; no duplicate retry`, async () => {
    const h = harness({ state: { lines: name === "add_to_cart" ? [] : [item()] }, handler: (u, init) => { if (init.method === "POST") throw new Error("private URL/token must not leak"); } });
    const c = await h.run("get_cart"), args = { ...expect(c), ...input };
    const ctl = new AbortController(); ctl.abort(); const count = h.requests.length;
    assert.equal((await h.run(name, args, ctl.signal)).error_kind, "canceled"); assert.equal(h.requests.length, count);
    const r = await h.run(name, args); assert.equal(r.error_kind, "outcome_unknown"); assert.equal(r.mutation_attempted, true); assert.doesNotMatch(JSON.stringify(r), /private URL/);
    assert.equal((await h.run(name, args)).error_kind, "outcome_unknown"); assert.equal(h.requests.filter(r => r.method === "POST").length, 1);
  });
  test(`${name}: other cart types refuse writes`, async () => {
    const h = harness({ state: { lines: name === "add_to_cart" ? [] : [item()], other: true } }); assert.equal((await prepared(h, name, input)).error_kind, "unsupported_item"); assert.ok(h.requests.every(r => r.method === "GET"));
  });
}
test("add_to_cart: exact mocked postcondition and only allowlisted add fields, never Buy Now", async () => {
  const h = harness({ product: product({ qty: "1,2" }), state: { lines: [item("other", "B0TEST0002")], saved: [item("saved", "B0TEST0003")] } });
  const r = await prepared(h, "add_to_cart", { ...add, quantity: 2 }); assert.equal(r.status, "ok"); assert.equal(r.quantity, 2); assert.equal(r.lines.length, 2);
  const posts = h.requests.filter(r => r.method === "POST"); assert.equal(posts.length, 1); assert.equal(posts[0].redirect, "manual");
  const p = new URLSearchParams(posts[0].body); assert.equal(p.get("isBuyNow"), "0"); assert.equal(p.get("quantity"), "2"); assert.deepEqual([...p.keys()].sort(), ["ASIN", "anti-csrftoken-a2z", "isBuyNow", "merchantID", "offerListingID", "quantity", "submit.add-to-cart"].sort());
});
test("add_to_cart: existing ASIN, changed offer, custom/sns, unsafe endpoint, unavailable quantity fail before writes", async () => {
  assert.equal((await prepared(harness({ state: { lines: [item()] } }), "add_to_cart", add)).error_kind, "already_in_cart");
  for (const [p, kind] of [[product({ price: "$30.00" }), "stale_cart"], [product({ seller: "Otherseller" }), "stale_cart"], [product({ asin: "B0TEST0002" }), "unavailable"], [product({ endpoint: "https://evil.example/submit" }), "site_changed"], [product({ extra: '<input name="snsOrderType" value="1">' }), "unsupported_item"], [product({ extra: '<input name="custom-name.1" value="x">' }), "unsupported_item"], [product({ qty: "2" }), "unavailable"], [product({ disabled: true }), "unavailable"]]) {
    const h = harness({ product: p }); assert.equal((await prepared(h, "add_to_cart", add)).error_kind, kind); assert.ok(h.requests.every(r => r.method === "GET"));
  }
});
test("update/remove: exact mocked cart changes, absolute quantity and restore equality", async () => {
  const h = harness({ state: { lines: [item(), item("other", "B0TEST0002")], saved: [item("saved", "B0TEST0003")] } });
  const initial = await h.run("get_cart"); const updated = await h.run("update_cart_item", { ...expect(initial), ...target, quantity: 2 }); assert.equal(updated.status, "ok"); assert.equal(updated.changed, true);
  const post = h.requests.find(r => r.method === "POST"), payload = JSON.parse(new URLSearchParams(post.body).get("actionPayload")); assert.equal(payload.length, 1); assert.equal(payload[0].type, "UPDATE_QUANTITY_START"); assert.equal(payload[0].payload.quantity, 2);
  const restored = await h.run("update_cart_item", { ...expect(updated), ...target, expected_quantity: 2, quantity: 1 }); assert.equal(restored.status, "ok"); assert.deepEqual(restored.lines, initial.lines); assert.equal(restored.cart_version, initial.cart_version);
  const removal = harness({ state: { lines: initial.lines.map(l => item(l.cart_item_id, l.asin, l.quantity)), saved: [item("saved", "B0TEST0003")] } });
  const removed = await prepared(removal, "remove_cart_item", { cart_item_id: "other", asin: "B0TEST0002", expected_quantity: 1 }); assert.equal(removed.status, "ok"); assert.equal(removed.quantity, 0); assert.equal(removed.lines.length, 1);
  assert.equal((await h.run("update_cart_item", { ...expect(restored), ...target, quantity: 2 })).error_kind, "outcome_unknown", "an attempted version cannot be reused even after exact restoration");
});
test("update: already desired quantity is a no-op", async () => {
  const h = harness({ state: { lines: [item()] } }); const r = await prepared(h, "update_cart_item", { ...target, quantity: 1 }); assert.equal(r.changed, false); assert.ok(h.requests.every(r => r.method === "GET"));
});
test("update/remove: missing/wrong target, quantity and special line guards", async () => {
  for (const n of ["update_cart_item", "remove_cart_item"]) for (const [extra, patch, kind] of [["", { asin: "B0TEST0002" }, "not_found"], ["", { expected_quantity: 2 }, "stale_cart"], ['data-related-item-ids="warranty_1"', {}, "unsupported_item"]]) {
    const h = harness({ state: { lines: [item("test_line_1", "B0TEST0001", 1, extra)] } }); const r = await prepared(h, n, { ...target, ...(n === "update_cart_item" ? { quantity: 2 } : {}), ...patch }); assert.equal(r.error_kind, kind); assert.ok(h.requests.every(r => r.method === "GET"));
  }
});
test("actions: quantity/type errors and model approval flags fail before interaction", async () => {
  for (const name of ["add_to_cart", "update_cart_item", "remove_cart_item"]) {
    const args = { expected_session_context: "a".repeat(64), expected_cart_version: "b".repeat(64), ...(name === "add_to_cart" ? add : { ...target, ...(name === "update_cart_item" ? { quantity: 2 } : {}) }) };
    for (const patch of [{ confirmed: true }, { expected_session_context: "invalid" }, { asin: "BAD" }, ...(name === "remove_cart_item" ? [{ expected_quantity: 0 }] : [{ quantity: 0 }, { quantity: 11 }, { quantity: "1" }])]) {
      const h = harness(); assert.equal((await h.run(name, { ...args, ...patch })).error_kind, "invalid_input"); assert.equal(h.requests.length, 0);
    }
  }
});
test("add: fresh-state race refuses write and missing guard storage fails closed", async () => {
  const h = harness({ handler: (u, init, { requests, state }) => { if (u.pathname.startsWith("/dp/")) state.lines.push(item("other", "B0TEST0002")); } });
  assert.equal((await prepared(h, "add_to_cart", add)).error_kind, "stale_cart"); assert.ok(h.requests.every(r => r.method === "GET"));
  const broken = harness(); broken.storage.set("xwebmcp.amazon.cart_attempts", "not-json");
  assert.equal((await prepared(broken, "add_to_cart", add)).error_kind, "site_error"); assert.ok(broken.requests.every(r => r.method === "GET"));
});
test("add: selected gift wrap refuses write, unselected controls are not serialized", async () => {
  const h = harness({ product: product().replace('type="checkbox" value="on"', 'type="checkbox" value="on" checked') });
  assert.equal((await prepared(h, "add_to_cart", add)).error_kind, "unsupported_item"); assert.ok(h.requests.every(r => r.method === "GET"));
});
test("cart writes: post-dispatch HTTP failure and cancellation stay unknown", async () => {
  for (const cancel of [false, true]) {
    const ctl = new AbortController();
    const h = harness({ handler: (u, init) => { if (init.method === "POST") { if (cancel) { ctl.abort(); throw new Error("aborted"); } return { status: 403, body: "Denied" }; } } });
    const c = await h.run("get_cart"); const r = await h.run("add_to_cart", { ...expect(c), ...add }, ctl.signal);
    assert.equal(r.error_kind, "outcome_unknown"); assert.equal(r.mutation_attempted, true); assert.equal(h.requests.filter(r => r.method === "POST").length, 1);
  }
});
test("unobserved or additional unrelated postconditions never produce success", async () => {
  const h = harness({ handler: (u, init, { state }) => { if (init.method === "POST") { state.lines.push(item("unexpected", "B0TEST0003")); return { body: "{}" }; } } });
  const r = await prepared(h, "add_to_cart", add); assert.equal(r.error_kind, "outcome_unknown"); assert.equal(r.mutation_attempted, true); assert.equal(h.requests.filter(r => r.method === "POST").length, 1);
});
