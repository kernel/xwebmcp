import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { webcrypto } from "node:crypto";
import { createContext, runInContext, runInNewContext } from "node:vm";
import test from "node:test";
import { DOMParser, Document } from "./etsy-dom.mjs";
import { conforms } from "./amazon-schema.mjs";

const names = ["get_cart", "add_to_cart", "update_cart_item", "get_product"];
const sources = Object.fromEntries(names.map(n => [n, readFileSync(new URL(`../domains/amazon.com/${n}.js`, import.meta.url), "utf8")]));
const cartTools = ["get_cart", "add_to_cart", "update_cart_item"];
const writes = ["add_to_cart", "update_cart_item"];
const plain = x => JSON.parse(JSON.stringify(x));

// Cart rows follow the live markup: the line's data attributes carry title and price, and the
// visible title is an a-truncate with both the full and the cut text.
const item = (id = "test-line-1", asin = "B0TEST0001", quantity = 1, extra = "") => ({ id, asin, quantity, extra });
const row = (l, type = "active") => `<div class="a-row sc-list-item" id="sc-${type}-${l.id}" data-itemid="${l.id}" data-itemtype="${type}" data-itemcategory="normal" data-asin="${l.asin}" ${type === "active" ? `data-quantity="${l.quantity}"` : ""} data-price="29.99" data-producttitle="Fabricated bottle" data-isselected="1" data-isprimeasin="0" ${l.extra || ""}><a class="sc-product-title"><span class="sc-product-title"><span class="a-truncate"><span class="a-truncate-full">Fabricated bottle</span><span class="a-truncate-cut">Fabricated…</span></span></span></a><span class="a-price"><span class="a-offscreen"> </span><span class="a-price-symbol">$</span><span class="a-price-whole">29<span class="a-price-decimal">.</span></span><span class="a-price-fraction">99</span></span><script>secret</script></div>`;
const fixture = ({ lines = [], saved = [], other = false, empty = true, csrf = true } = {}) => `<html><head><title>Amazon.com Shopping Cart</title>${csrf ? '<meta name="anti-csrftoken-a2z" id="cart-sp-csrf" content="fabricated_csrf">' : ""}</head><body>
<div id="sc-collapsed-carts-container">
${other ? "<div>Other cart</div>" : ""}
</div>
<div id="sc-active-cart">${!lines.length && empty ? '<div id="sc-empty-cart">Empty cart</div>' : ""}${lines.map(l => row(l)).join("")}</div>
<span id="sc-subtotal-amount-buybox"><span class="a-price-symbol">$</span><span class="a-price-whole">29<span class="a-price-decimal">.</span></span><span class="a-price-fraction">99</span></span>
<div id="sc-saved-cart">${saved.map(l => row(l, "saved")).join("")}</div><div id="glow-ingress-line2">Private location not returned</div></body></html>`;

// The product form follows the live buy box: the Add to Cart button carries its own formaction,
// and the Buy Now pipeline fields sit inside the same form.
const product = ({ asin = "B0TEST0001", target = "/cart/add-to-cart/ref=dp_start-bbf_1_glance", price = '<span class="a-offscreen"> </span><span class="a-price-symbol">$</span><span class="a-price-whole">29<span class="a-price-decimal">.</span></span><span class="a-price-fraction">99</span>', seller = '<div class="offer-display-feature-text-message">Testseller</div>', extra = "", qty = "1", disabled = false } = {}) => `<html><head><title>Test product</title></head><body>
<span id="productTitle">Fabricated bottle</span>
<div id="corePriceDisplay_desktop_feature_div"><span class="a-price priceToPay">${price}</span></div>
<div id="merchantInfoFeature_feature_div">${seller}</div>
<form id="addToCart" method="post" action="/gp/product/handle-buy-box/ref=dp_start-bbf_1_glance">
<input type="hidden" name="anti-csrftoken-a2z" value="fabricated_product_csrf"><input type="hidden" name="items[0.base][asin]" value="${asin}"><input type="hidden" name="items[0.base][quantity]" value="1">
<input type="hidden" name="ASIN" value="${asin}"><input type="hidden" name="offerListingID" value="fabricated_offer"><input type="hidden" name="merchantID" value="fabricated_merchant"><input type="hidden" name="session-id" value="fabricated-session">
${qty === null ? "" : `<select name="quantity">${qty.split(",").map(v => `<option value="${v}">${v}</option>`).join("")}</select>`}
<input id="add-to-cart-button" name="submit.add-to-cart" type="submit" value="Add to cart" formaction="${target}" ${disabled ? "disabled" : ""}>
<input name="submit.buy-now" type="submit" value="Buy Now" formaction="/checkout/entry/buynow">
<input type="hidden" name="pipelineType" value="Chewbacca"><input type="hidden" name="referrer" value="detail"><input type="hidden" name="isBuyNow" value="1"><input type="hidden" name="isEligibilityLogicDisabled" value="1"><input type="hidden" name="ref_" value="dp_start-bbf_1_glance_chw">
<input name="gift-wrap" type="checkbox" value="on">${extra}</form></body></html>`;

function harness(options = {}) {
  let state = { lines: [], saved: [], ...options.state };
  let added = 0;
  const doc = new Document("<html><body></body></html>");
  doc.cookie = "session-id=fabricated-session; session-token=rotating-token; ubid-main=fabricated-ubid";
  const requests = [];
  const location = new URL(options.url || "https://www.amazon.com/s?k=test");
  const ctx = createContext({ document: doc, location, DOMParser, URL, URLSearchParams, crypto: options.crypto || webcrypto, TextEncoder, fetch: async (path, init) => {
    // Like a browser fetch: an aborted call sends nothing, and an abort during the request rejects it.
    if (init.signal?.aborted) throw new DOMException("The operation was aborted.", "AbortError");
    const u = new URL(path, location.origin);
    requests.push({ path: u.pathname, ...init });
    const response = await answer(u, init);
    if (init.signal?.aborted) throw new DOMException("The operation was aborted.", "AbortError");
    return response;
  } });
  const answer = async (u, init) => {
    if (options.handler) {
      const r = await options.handler(u, init, { requests, state, doc });
      if (r) return { status: 200, ok: (r.status ?? 200) < 300, url: u.href, text: async () => r.body || "", ...r };
    }
    let body;
    if (init.method === "POST") {
      const p = new URLSearchParams(init.body);
      if (u.pathname.startsWith("/cart/add-to-cart")) state.lines.unshift(item(`new-line-${++added}`, p.get("ASIN"), Number(p.get("quantity"))));
      else {
        const [action] = JSON.parse(p.get("actionPayload"));
        if (action.type === "DELETE_START") state.lines = state.lines.filter(l => l.id !== action.payload.itemId);
        else state.lines.find(l => l.id === action.payload.itemId).quantity = action.payload.quantity;
      }
      body = "{}";
    } else body = u.pathname.startsWith("/dp/") ? options.product || product() : fixture(state);
    return { status: 200, ok: true, url: u.href, text: async () => body };
  };
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
  return { run, requests, doc, posts: () => requests.filter(r => r.method === "POST"), state: () => state };
}
const expect = c => ({ expected_session_context: c.session_context, expected_cart_version: c.cart_version });
const target = { cart_item_id: "test-line-1", asin: "B0TEST0001", expected_quantity: 1 };
const add = { asin: "B0TEST0001", quantity: 1, expected_unit_price_cents: 2999, expected_sold_by: "Testseller" };
const prepared = async (h, name, input) => h.run(name, { ...expect(await h.run("get_cart")), ...input });
const actionInput = name => name === "add_to_cart" ? add : { ...target, quantity: 2 };
const actionState = name => ({ lines: name === "add_to_cart" ? [item("other", "B0TEST0002")] : [item(), item("other", "B0TEST0002")] });

for (const name of cartTools) {
  test(`${name}: single self-contained page definition and annotations`, () => {
    const [d] = runInNewContext(`(${sources[name]})`);
    assert.equal(d.kind, "page");
    assert.equal(d.tool.name, name);
    assert.deepEqual(plain(d.match.url_patterns), ["https://www.amazon.com/*"]);
    assert.equal(d.tool.annotations.readOnlyHint, name === "get_cart");
    assert.equal(d.tool.annotations.destructiveHint, name === "update_cart_item");
  });
  test(`${name}: malformed inputs fail before any request`, async () => {
    for (const input of [null, [], { confirmed: true }, { unexpected: "x" }, "x"]) {
      const h = harness();
      assert.equal((await h.run(name, input)).error_kind, "invalid_input");
      assert.equal(h.requests.length, 0);
    }
  });
  test(`${name}: challenge, access notice, rate limit, login redirect and failed reads`, async () => {
    for (const [body, status, url, kind] of [
      ["<title>Robot Check</title>", 200, undefined, "challenge"],
      ["<title>Robot Check</title>", 503, undefined, "challenge"],
      ["<body>Continued access violates Amazon’s Conditions of Use</body>", 200, undefined, "access_gated"],
      ["", 429, undefined, "rate_limited"],
      ["", 200, "https://www.amazon.com/ap/signin", "login_required"],
      ["", 200, "https://www.amazon.com/ax/claim/sign-in", "login_required"],
      ["", 200, "https://evil.example/", "site_changed"],
      ["", 403, undefined, "site_error"]
    ]) {
      const h = harness({ handler: u => u.pathname === "/gp/cart/view.html" ? { status, url, body } : undefined });
      const input = name === "get_cart" ? {} : { expected_session_context: "a".repeat(64), expected_cart_version: "b".repeat(64), ...actionInput(name) };
      assert.equal((await h.run(name, input)).error_kind, kind, `${status} ${url} ${body}`);
      assert.equal(h.posts().length, 0);
    }
  });
}
test("get_cart: an access-notice phrase inside a real cart is not access_gated", async () => {
  const h = harness({ handler: (u, init, { state }) => ({ body: fixture(state).replace("</body>", "<p>violates Amazon’s Conditions of Use</p></body>") }) });
  assert.equal((await h.run("get_cart")).status, "ok");
});
for (const name of writes) {
  test(`${name}: unrelated host, sign-in and checkout pages fail without requests`, async () => {
    for (const url of [
      "https://aws.amazon.com/",
      "https://www.amazon.com/checkout/entry",
      "https://www.amazon.com/gp/buy/spc/handlers/display.html",
      "https://www.amazon.com/ap/signin",
      "https://www.amazon.com/ax/claim"
    ]) {
      const h = harness({ url });
      const r = await h.run(name, { expected_cart_version: "a".repeat(64), expected_session_context: "b".repeat(64), ...actionInput(name) });
      assert.equal(r.error_kind, "wrong_page", url);
      assert.equal(h.requests.length, 0);
    }
  });
}
test("get_cart: refuses other hosts only", async () => {
  assert.equal((await harness({ url: "https://aws.amazon.com/" }).run("get_cart")).error_kind, "wrong_page");
  assert.equal((await harness({ url: "https://www.amazon.com/gp/buy/spc/handlers/display.html" }).run("get_cart")).status, "ok");
});

test("get_cart: empty state, stable digests, no private fields", async () => {
  const h = harness(); const a = await h.run("get_cart"), b = await h.run("get_cart");
  assert.equal(a.status, "ok");
  assert.equal(a.cart_version, b.cart_version);
  assert.equal(a.items_quantity, 0);
  assert.deepEqual(a.lines, []);
  assert.doesNotMatch(JSON.stringify(a), /fabricated-session|rotating-token|private|csrf|cookie/);
});
test("get_cart: session_context ignores session-token rotation", async () => {
  const h = harness(); const a = await h.run("get_cart");
  h.doc.cookie = "session-id=fabricated-session; session-token=rotated; ubid-main=fabricated-ubid";
  assert.equal((await h.run("get_cart")).session_context, a.session_context);
  h.doc.cookie = "session-id=other-session; ubid-main=fabricated-ubid";
  assert.notEqual((await h.run("get_cart")).session_context, a.session_context);
  h.doc.cookie = "";
  assert.equal((await h.run("get_cart")).error_kind, "site_error");
});
test("get_cart: live-shaped lines read title and price once from data attributes", async () => {
  const h = harness({ state: { lines: [item()], saved: [item("saved-1", "B0TEST0002")], other: true } });
  const r = await h.run("get_cart");
  assert.deepEqual(r.lines, [{ cart_item_id: "test-line-1", asin: "B0TEST0001", title: "Fabricated bottle", quantity: 1, unit_price_cents: 2999 }]);
  assert.equal(r.subtotal_cents, 2999);
  assert.equal(r.other_carts_present, true);
  assert.doesNotMatch(JSON.stringify(r), /saved-1|secret|Fabricated…/);
});
test("get_cart: whitespace-only collapsed-cart container is not another cart", async () => {
  assert.equal((await harness({ state: { lines: [item()] } }).run("get_cart")).other_carts_present, false);
});
test("get_cart: unknown empty state, malformed line, duplicates, oversized and pagination fail closed", async () => {
  for (const state of [
    { empty: false },
    { lines: [item("bad id")] },
    { lines: [item(), item()] },
    { lines: Array.from({ length: 101 }, (_, i) => item(`line_${i}`)) },
    { lines: [item("line", "B0TEST0001", 0)] }
  ]) assert.equal((await harness({ state }).run("get_cart")).error_kind, "site_changed", JSON.stringify(state).slice(0, 80));
  for (const page of [
    s => fixture(s).replace("Empty cart", '<span class="sc-pagination">Next</span>'),
    s => fixture({ ...s, lines: [item(), item("missing", "B0TEST0003")] }).replace('data-itemid="missing"', ""),
    s => fixture(s).replace('<div id="sc-saved-cart">', '<div id="sc-saved-cart"><span class="sc-pagination">Next</span>'),
    s => fixture({ ...s, saved: [item("duplicate", "B0TEST0003"), item("duplicate", "B0TEST0004")] }),
    s => fixture(s).replace('id="sc-saved-cart"', 'id="unknown-saved-layout"'),
    s => fixture(s).replace('id="sc-collapsed-carts-container"', 'id="unknown-other-layout"')
  ]) assert.equal((await harness({ handler: (u, init, { state }) => ({ body: page(state) }) }).run("get_cart")).error_kind, "site_changed");
});
test("get_cart: cancellation during hashing is canceled", async () => {
  const ctl = new AbortController(); let hashes = 0;
  const crypto = { subtle: { digest: async (...args) => { const result = await webcrypto.subtle.digest(...args); if (++hashes === 2) ctl.abort(); return result; } } };
  assert.equal((await harness({ crypto }).run("get_cart", {}, ctl.signal)).error_kind, "canceled");
});

test("add_to_cart: accepts get_product's own price and seller outputs", async () => {
  for (const p of [product(), product({ price: '<span class="a-offscreen">$1,299.00</span>' }), product({ seller: "" }).replace("</body>", '<a id="sellerProfileTriggerId"><span>Foo</span><span>.com</span></a></body>')]) {
    const h = harness({ product: p });
    const view = await h.run("get_product", { asin: add.asin });
    assert.equal(view.status, "ok", JSON.stringify(view));
    const r = await prepared(h, "add_to_cart", { ...add, expected_unit_price_cents: view.price_cents, expected_sold_by: view.sold_by });
    assert.equal(r.status, "ok", JSON.stringify(r));
  }
});
test("add_to_cart: posts the form to the button target without Buy Now fields and verifies the line", async () => {
  const h = harness({ product: product({ qty: "1,2" }), state: { lines: [item("other", "B0TEST0002")], saved: [item("saved", "B0TEST0003")] } });
  const r = await prepared(h, "add_to_cart", { ...add, quantity: 2 });
  assert.equal(r.status, "ok");
  assert.equal(r.quantity, 2);
  assert.equal(r.unit_price_cents, 2999);
  assert.equal(r.lines.length, 2);
  assert.equal(r.cart_item_id, "new-line-1");
  const [post] = h.posts();
  assert.equal(h.posts().length, 1);
  assert.equal(post.path, "/cart/add-to-cart/ref=dp_start-bbf_1_glance");
  assert.equal(post.redirect, "manual");
  assert.equal(post.credentials, "include");
  const p = new URLSearchParams(post.body);
  assert.equal(p.get("quantity"), "2");
  assert.equal(p.get("items[0.base][quantity]"), "2");
  assert.equal(p.get("submit.add-to-cart"), "Add to cart");
  assert.equal(p.get("anti-csrftoken-a2z"), "fabricated_product_csrf");
  for (const key of ["submit.buy-now", "pipelineType", "referrer", "isBuyNow", "isEligibilityLogicDisabled", "ref_", "gift-wrap"]) assert.equal(p.has(key), false, key);
});
test("add_to_cart: a button without a name adds no submitter field", async () => {
  const h = harness({ product: product().replace('name="submit.add-to-cart" ', "") });
  assert.equal((await prepared(h, "add_to_cart", add)).status, "ok");
  const p = new URLSearchParams(h.posts()[0].body);
  assert.equal(p.has("null"), false);
  assert.equal(p.has("submit.add-to-cart"), false);
});
test("add_to_cart: items without a quantity selector can add one", async () => {
  assert.equal((await prepared(harness({ product: product({ qty: null }) }), "add_to_cart", add)).status, "ok");
  const h = harness({ product: product({ qty: null }) });
  assert.equal((await prepared(h, "add_to_cart", { ...add, quantity: 2 })).error_kind, "quantity_unavailable");
  assert.equal(h.posts().length, 0);
});
test("add_to_cart: refusals before any write", async () => {
  for (const [state, kind] of [
    [{ lines: [item()] }, "already_in_cart"],
    [{ saved: [item("saved", add.asin)] }, "already_in_cart"],
    [{ other: true }, "unsupported_cart"],
    [{ lines: [item("plan", "B0TEST0002", 1, 'data-related-item-ids="warranty_1"')] }, "unsupported_cart"]
  ]) {
    const h = harness({ state });
    assert.equal((await prepared(h, "add_to_cart", add)).error_kind, kind);
    assert.equal(h.posts().length, 0);
  }
  for (const [p, kind] of [
    [product({ price: '<span class="a-offscreen">$30.00</span>' }), "offer_changed"],
    [product({ seller: '<div class="offer-display-feature-text-message">Otherseller</div>' }), "offer_changed"],
    [product({ asin: "B0TEST0002" }), "unavailable"],
    [product({ disabled: true }), "unavailable"],
    [product({ qty: "1" }).replace('formaction="/cart', 'data-x="/cart'), "site_changed"],
    [product({ target: "/checkout/entry/buynow" }), "site_changed"],
    [product({ target: "https://evil.example/cart/add-to-cart" }), "site_changed"],
    [product({ extra: '<input name="snsOrderType" value="1">' }), "unsupported_item"],
    [product({ extra: '<input name="custom-name.1" value="x">' }), "unsupported_item"],
    [product().replace('type="checkbox" value="on"', 'type="checkbox" value="on" checked'), "unsupported_item"],
    [product().replace('name="offerListingID" value="fabricated_offer"', 'name="offerListingID" value=""'), "site_changed"]
  ]) {
    const h = harness({ product: p });
    assert.equal((await prepared(h, "add_to_cart", add)).error_kind, kind);
    assert.equal(h.posts().length, 0);
  }
  const missing = harness({ handler: u => u.pathname.startsWith("/dp/") ? { status: 404, body: "" } : undefined });
  assert.equal((await prepared(missing, "add_to_cart", add)).error_kind, "not_found");
});
test("add_to_cart: the cart line may show a different price than the product page", async () => {
  const h = harness({ handler: (u, init, { state }) => { if (init.method === "GET" && u.pathname === "/gp/cart/view.html" && state.lines.length) return { body: fixture(state).replace('data-price="29.99"', 'data-price="27.99"') }; } });
  const r = await prepared(h, "add_to_cart", add);
  assert.equal(r.status, "ok");
  assert.equal(r.unit_price_cents, 2799);
});

test("update_cart_item: request mirrors Amazon's cart script", async () => {
  const h = harness({ state: { lines: [item(), item("other", "B0TEST0002")], saved: [item("saved", "B0TEST0003")] } });
  assert.equal((await prepared(h, "update_cart_item", { ...target, quantity: 2 })).status, "ok");
  const [post] = h.posts();
  assert.equal(post.path, "/cart/ref=ox_sc_cart_actions_1");
  assert.equal(post.redirect, "manual");
  assert.equal(post.headers["anti-csrftoken-a2z"], "fabricated_csrf");
  assert.equal(post.headers["X-AUI-View"], "Desktop");
  const p = new URLSearchParams(post.body);
  assert.equal(p.get("submit.cart-actions"), "1");
  assert.equal(p.get("pageAction"), "cart-actions");
  assert.equal(p.get("displayedSavedItemNum"), "1");
  assert.deepEqual(JSON.parse(p.get("actionPayload")), [{ type: "UPDATE_QUANTITY_START", payload: { itemId: "test-line-1", list: "activeItems", relatedItemIds: [], isPrimeAsin: false, quantity: 2 } }]);
  assert.deepEqual(JSON.parse(p.get("activeItems")).map(i => i.itemId), ["sc-active-test-line-1", "sc-active-other"]);
  assert.deepEqual(JSON.parse(p.get("savedItems")), [{ itemId: "sc-saved-saved", price: "29.99" }]);
});
test("update_cart_item: update, restore and remove with exact readback", async () => {
  const h = harness({ state: { lines: [item(), item("other", "B0TEST0002")], saved: [item("saved", "B0TEST0003")] } });
  const initial = await h.run("get_cart");
  const updated = await h.run("update_cart_item", { ...expect(initial), ...target, quantity: 2 });
  assert.equal(updated.changed, true);
  assert.equal(updated.quantity, 2);
  assert.equal(updated.previous_quantity, 1);
  const restored = await h.run("update_cart_item", { ...expect(updated), ...target, expected_quantity: 2, quantity: 1 });
  assert.equal(restored.cart_version, initial.cart_version, "a restored cart has its original version and may be changed again");
  const removed = await h.run("update_cart_item", { ...expect(restored), ...target, quantity: 0 });
  assert.equal(removed.quantity, 0);
  assert.deepEqual(removed.lines.map(l => l.cart_item_id), ["other"]);
  assert.equal(JSON.parse(new URLSearchParams(h.posts()[2].body).get("actionPayload"))[0].type, "DELETE_START");
  assert.equal("quantity" in JSON.parse(new URLSearchParams(h.posts()[2].body).get("actionPayload"))[0].payload, false);
});
test("update_cart_item: already at the requested quantity is a no-op", async () => {
  const h = harness({ state: { lines: [item()] } }); const r = await prepared(h, "update_cart_item", { ...target, quantity: 1 });
  assert.equal(r.changed, false);
  assert.equal(h.posts().length, 0);
});
test("update_cart_item: wrong target, quantity and special lines refuse writes", async () => {
  for (const [extra, patch, kind] of [
    ["", { asin: "B0TEST0002" }, "not_found"],
    ["", { cart_item_id: "missing" }, "not_found"],
    ["", { expected_quantity: 2 }, "stale_cart"],
    ['data-related-item-ids="warranty_1"', {}, "unsupported_cart"],
    ['data-subscription="1"><span class="sc-action-sns"></span', {}, "unsupported_cart"]
  ]) {
    const h = harness({ state: { lines: [item("test-line-1", "B0TEST0001", 1, extra)] } });
    assert.equal((await prepared(h, "update_cart_item", { ...target, quantity: 2, ...patch })).error_kind, kind);
    assert.equal(h.posts().length, 0);
  }
  for (const [page, kind] of [
    [s => fixture(s).replace('data-itemcategory="normal"', 'data-itemcategory="fresh"'), "unsupported_cart"],
    [s => fixture(s).replace('<div id="sc-active-cart">', '<div id="sc-active-cart"><div class="sc-delivery-group"></div>'), "unsupported_cart"],
    [s => fixture({ ...s, csrf: false }), "site_changed"]
  ]) {
    const h = harness({ state: { lines: [item()] }, handler: (u, init, { state }) => init.method === "GET" ? { body: page(state) } : undefined });
    assert.equal((await prepared(h, "update_cart_item", { ...target, quantity: 2 })).error_kind, kind);
    assert.equal(h.posts().length, 0);
  }
});
test("cart writes: quantity, type and approval-flag errors fail before any request", async () => {
  for (const name of writes) {
    const args = { expected_session_context: "a".repeat(64), expected_cart_version: "b".repeat(64), ...actionInput(name) };
    const patches = [{ confirmed: true }, { expected_session_context: "invalid" }, { asin: "BAD" }, { quantity: 11 }, { quantity: "1" }, { quantity: -1 }];
    patches.push(name === "add_to_cart" ? { quantity: 0 } : { expected_quantity: 0 });
    if (name === "add_to_cart") patches.push({ expected_sold_by: " " }, { expected_unit_price_cents: 1.5 });
    for (const patch of patches) {
      const h = harness();
      assert.equal((await h.run(name, { ...args, ...patch })).error_kind, "invalid_input", JSON.stringify(patch));
      assert.equal(h.requests.length, 0);
    }
  }
});

for (const name of writes) {
  test(`${name}: wrong session and stale cart refuse POST`, async () => {
    const h = harness({ state: actionState(name) });
    const c = await h.run("get_cart");
    h.doc.cookie = "session-id=different-session; ubid-main=fabricated-ubid";
    assert.equal((await h.run(name, { ...expect(c), ...actionInput(name) })).error_kind, "session_changed");
    assert.equal((await h.run(name, { ...expect(await h.run("get_cart")), expected_cart_version: "a".repeat(64), ...actionInput(name) })).error_kind, "stale_cart");
    assert.equal(h.posts().length, 0);
  });
  test(`${name}: canceled before requests; network failure after dispatch is unknown`, async () => {
    const h = harness({ state: actionState(name), handler: (u, init) => { if (init.method === "POST") throw new Error("private URL/token must not leak"); } });
    const c = await h.run("get_cart"), args = { ...expect(c), ...actionInput(name) };
    const ctl = new AbortController();
    ctl.abort();
    const count = h.requests.length;
    assert.equal((await h.run(name, args, ctl.signal)).error_kind, "canceled");
    assert.equal(h.requests.length, count);
    const r = await h.run(name, args);
    assert.equal(r.error_kind, "outcome_unknown");
    assert.equal(r.mutation_attempted, true);
    assert.doesNotMatch(JSON.stringify(r), /private URL/);
    assert.equal(h.posts().length, 1);
  });
  test(`${name}: HTTP failure, unchanged cart and unrelated changes never claim success`, async () => {
    for (const mode of ["http", "redirect", "unchanged", "other", "special"]) {
      const h = harness({ state: actionState(name), handler: (u, init, { state }) => {
        if (init.method !== "POST") return;
        if (mode === "http") return { status: 403, body: "Denied" };
        if (mode === "redirect") return { status: 0, type: "opaqueredirect", body: "" };
        if (mode === "unchanged") return { body: "{}" };
        if (mode === "other") state.saved.push(item("unexpected-saved", "B0TEST0004"));
        if (mode === "special") { state.lines = state.lines.map(l => ({ ...l, extra: 'data-related-item-ids="plan"' })); state.lines.unshift(item("new", add.asin)); return { body: "{}" }; }
      } });
      const r = await prepared(h, name, actionInput(name));
      assert.equal(r.error_kind, "outcome_unknown", mode);
      assert.equal(r.mutation_attempted, true);
      assert.equal(h.posts().length, 1);
    }
  });
  test(`${name}: cancellation after dispatch is unknown, never success`, async () => {
    const ctl = new AbortController();
    const h = harness({ state: actionState(name), handler: (u, init) => { if (init.method === "POST") { ctl.abort(); throw new Error("aborted"); } } });
    const r = await h.run(name, { ...expect(await h.run("get_cart")), ...actionInput(name) }, ctl.signal);
    assert.equal(r.error_kind, "outcome_unknown");
    assert.equal(r.mutation_attempted, true);
  });
}

test("cart tools pass the caller's signal to every request", async () => {
  for (const name of cartTools) {
    const ctl = new AbortController();
    const h = harness({ state: actionState(name) });
    const input = name === "get_cart" ? {} : { ...expect(await h.run("get_cart")), ...actionInput(name) };
    const before = h.requests.length;
    assert.equal((await h.run(name, input, ctl.signal)).status, "ok", name);
    const sent = h.requests.slice(before);
    assert.ok(sent.length > 0 && sent.every(r => r.signal === ctl.signal), name);
  }
});

test("add_to_cart: a robot check served as HTTP 404 is a challenge, not not_found", async () => {
  const h = harness({ handler: u => u.pathname.startsWith("/dp/") ? { status: 404, body: "<html><head><title>Robot Check</title></head><body></body></html>" } : undefined });
  const r = await prepared(h, "add_to_cart", add);
  assert.equal(r.error_kind, "challenge");
  assert.equal(h.posts().length, 0);
});
