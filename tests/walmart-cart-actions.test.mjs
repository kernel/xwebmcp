import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";

// Fabricated account, cart and product data; this harness never contacts Walmart.
const names = ["get_cart", "add_to_cart", "update_cart_item", "remove_cart_item", "save_for_later", "list_lists"];
const writes = names.slice(1, 5);
const sources = Object.fromEntries(names.map(n => [n, readFileSync(new URL(`../domains/walmart.com/${n}.js`, import.meta.url), "utf8")]));
const copy = value => JSON.parse(JSON.stringify(value));
const product = () => ({ usItemId: "20000001", offerId: "TEST_OFFER", name: "Test towels", salesUnit: "EACH", isAlcohol: false, type: "Bed Sheets", legalRestriction: false, isLMPAlcoholItem: false, showAtc: true, orderLimit: 12, orderMinLimit: 1, availabilityStatus: "IN_STOCK", canAddToCart: true, sellerName: "Test seller", fulfillmentOptions: [{ type: "SHIPPING", availabilityStatus: "IN_STOCK" }] });
const line = (id = "TEST_LINE", p = product()) => ({ id, quantity: 2, product: p, fulfillmentPreference: "SHIPPING", priceInfo: { itemPrice: { value: 3 }, linePrice: { value: 6 } } });
const cart = () => ({ id: "TEST_CART", customer: { id: "TEST_ACCOUNT", isGuest: false, firstName: "Never Return", phone: "555-000-0000" }, lineItems: [line()], checkoutable: true, fulfillment: { intent: "SHIPPING", pickupStore: { storeId: "1234" }, deliveryStore: { storeId: "2222" }, deliveryAddress: { addressLineOne: "1 Fabricated Street" }, fulfillmentItemGroups: [{ collapsedItemIds: ["TEST_LINE"] }] }, priceDetails: { subTotal: { value: 6 } } });
const next = (props = {}) => ({ runtimeConfig: { tenant: "test-tenant", tenantV2: { bu: "WALMART-US", mart: "B2C" }, appVersion: "test-version" }, props: { pageProps: props } });
const html = data => `<script id="__NEXT_DATA__">${JSON.stringify(data)}</script>`;
const operation = (name, type) => ({ toString: () => `let op={type:"${type}",name:"${name}",hash:"${"a".repeat(64)}"}` });

function conforms(schema, value) {
  if (schema.oneOf && schema.oneOf.filter(s => conforms(s, value)).length !== 1) return false;
  if ("const" in schema && value !== schema.const) return false;
  if (schema.enum && !schema.enum.includes(value)) return false;
  if (schema.type && ![schema.type].flat().some(t => t === "null" ? value === null : t === "integer" ? Number.isInteger(value) : t === "array" ? Array.isArray(value) : t === "object" ? value !== null && typeof value === "object" && !Array.isArray(value) : typeof value === t)) return false;
  if (Array.isArray(value) && (value.length > (schema.maxItems ?? Infinity) || (schema.items && !value.every(v => conforms(schema.items, v))))) return false;
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    if (schema.required?.some(k => !Object.hasOwn(value, k))) return false;
    if (schema.additionalProperties === false && Object.keys(value).some(k => !Object.hasOwn(schema.properties || {}, k))) return false;
    if (Object.entries(schema.properties || {}).some(([k, s]) => k in value && !conforms(s, value[k]))) return false;
  }
  if (typeof value === "string" && (value.length > (schema.maxLength ?? Infinity) || (schema.pattern && !new RegExp(schema.pattern).test(value)))) return false;
  if (typeof value === "number" && (value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity))) return false;
  return true;
}

function harness(options = {}) {
  const state = { cart: options.cart ?? cart(), saved: { id: "TEST_SAVED", totalQuantity: 0, lineItems: [], pageInfo: {} }, calls: [], posts: 0 };
  const document = { cookie: "assortmentStoreId=1234", getElementById: () => ({ textContent: JSON.stringify(next()) }) };
  class DOMParser {
    parseFromString(body) {
      return { getElementById: () => { const m = body.match(/<script id="__NEXT_DATA__">([\s\S]*)<\/script>/); return m ? { textContent: m[1] } : null; } };
    }
  }
  const window = { webpackChunk_N_E: [[[], Object.fromEntries(["getCart", "getSFL", "updateItems", "moveToSFL"].filter(n => n !== options.missingOp).map(n => [n, operation(n, ["getCart", "getSFL"].includes(n) ? "query" : "mutation")]))]] };
  const context = { window, document, crypto: webcrypto, TextEncoder, URL, AbortController, setTimeout, clearTimeout, DOMParser, location: { origin: options.origin ?? "https://www.walmart.com", pathname: options.path ?? "/" }, fetch: async (url, init) => {
    state.calls.push({ url, init });
    assert.equal(init.credentials, "same-origin");
    if (options.respond) {
      const result = await options.respond(url, init, state);
      if (result) return result;
    }
    let data;
    const path = new URL(url, "https://www.walmart.com").pathname;
    if (path === "/lists") return response(html(next({ bootstrapData: { account: { data: { account: { profile: {} } } } }, initialData: { data: { shoppingListsExtended: { maxListsReached: false, lists: [{ id: "TEST_LIST", name: "Test list", type: "SL", lineItemCount: 2, primary: true, ownerDetails: { private: "Never Return" } }] } } } })), url);
    if (path.startsWith("/ip/")) return response(html({ props: { pageProps: { initialData: { data: { product: product() } } } } }), url);
    const op = path.split("/").at(-2);
    if (op === "getCart") data = { cart: copy(state.cart) };
    if (op === "getSFL") data = { sfl: copy(state.saved) };
    if (init.method === "POST") {
      state.posts++;
      const input = JSON.parse(init.body).variables.input;
      assert.equal(input.cartId, "TEST_CART");
      assert.equal(input.items.length, 1);
      if (op === "updateItems") {
        assert.equal(input.skipPolicyCheck, false);
        const item = input.items[0];
        const existing = state.cart.lineItems.find(l => l.id === item.lineItemId);
        if (!item.quantity) state.cart.lineItems = state.cart.lineItems.filter(l => l !== existing);
        else if (existing) existing.quantity = item.quantity;
        else { const added = line("ADDED_LINE"); added.quantity = item.quantity; state.cart.lineItems.push(added); }
        data = { updateItems: copy(state.cart) };
      } else if (op === "moveToSFL") {
        assert.equal(input.sflId, "TEST_SAVED");
        const existing = state.cart.lineItems.find(l => l.id === input.items[0].lineItemId);
        state.saved.lineItems.push(copy(existing)); state.saved.totalQuantity += existing.quantity;
        state.cart.lineItems = state.cart.lineItems.filter(l => l !== existing);
        data = { moveToSFL: { cart: copy(state.cart) } };
      } else assert.fail("Unexpected mutation operation");
      if (options.afterWrite) options.afterWrite(state);
    }
    assert.ok(data, `Unexpected request ${path}`);
    return response(JSON.stringify({ data }), url);
  } };
  const definitions = Object.fromEntries(names.map(n => [n, runInNewContext(`(${sources[n]})`, context)[0]]));
  const run = async (name, input, signal = new AbortController().signal) => {
    const result = copy(await definitions[name].execute(input, { signal }));
    assert.ok(conforms(definitions[name].tool.outputSchema, result), `${name}: schema mismatch ${JSON.stringify(result)}`);
    return result;
  };
  const guards = async () => { const r = await run("get_cart", {}); assert.equal(r.status, "ok"); return { expected_account_token: r.account_token, expected_cart_state: r.cart_state }; };
  return { state, run, guards, document, definitions };
}
function response(body, url, status = 200) { return { ok: status >= 200 && status < 300, status, url: new URL(url, "https://www.walmart.com").href, text: async () => body }; }
const target = { request_id: "TEST_REQUEST", line_id: "TEST_LINE", us_item_id: "20000001", offer_id: "TEST_OFFER" };
const actionInput = async (h, name) => ({ ...await h.guards(), ...target, ...(name === "add_to_cart" ? { line_id: undefined, fulfillment_preference: "SHIPPING" } : {}), ...(name === "update_cart_item" || name === "add_to_cart" ? { quantity: 3 } : {}) });
const inputFor = async (h, name) => { const value = await actionInput(h, name); delete value.line_id; if (name !== "add_to_cart") value.line_id = "TEST_LINE"; return value; };

for (const name of names) {
  test(`${name}: page-local contract and malformed input before requests`, async () => {
    const h = harness();
    assert.equal(h.definitions[name].kind, "page");
    assert.equal(h.definitions[name].tool.name, name);
    assert.equal(sources[name].trimEnd().endsWith(";"), false);
    assert.equal(/\b(gotoUrl|cdp|click|fillInput|require)\(/.test(sources[name]), false);
    for (const input of [null, [], 5, { unexpected: true }, { limit: "1" }]) {
      const r = await h.run(name, input);
      assert.equal(r.error_kind, "invalid_input"); assert.equal(r.mutation_attempted, false);
    }
    assert.equal(h.state.calls.length, 0);
  });
  test(`${name}: wrong domain and pre-cancellation never interact`, async () => {
    const base = harness();
    let valid = name === "get_cart" ? {} : name === "list_lists" ? { expected_account_token: (await base.guards()).expected_account_token } : await inputFor(base, name);
    const wrong = harness({ origin: "https://careers.walmart.com" });
    assert.equal((await wrong.run(name, valid)).error_kind, "wrong_page"); assert.equal(wrong.state.calls.length, 0);
    const h = harness(), c = new AbortController(); c.abort();
    assert.equal((await h.run(name, valid, c.signal)).error_kind, "canceled"); assert.equal(h.state.calls.length, 0);
  });
}

test("get_cart: allowlists private data, includes unavailable lines, and bounds output", async () => {
  const c = cart(); c.lineItems = Array.from({ length: 150 }, (_, i) => line(`LINE_${i}`)); c.lineItems[0].product.availabilityStatus = "OUT_OF_STOCK";
  const h = harness({ cart: c }), r = await h.run("get_cart", { limit: 2 });
  assert.equal(r.total_line_count, 150); assert.equal(r.truncated, true); assert.equal(r.lines.length, 2);
  assert.equal(r.lines[0].availability, "OUT_OF_STOCK"); assert.equal(r.subtotal_cents, 600);
  assert.equal(/Never Return|Fabricated Street|555-|customer|deliveryAddress/.test(JSON.stringify(r)), false);
  assert.equal(h.state.posts, 0); assert.equal(h.state.calls.length, 1);
});

test("get_cart: deployment drift and response failures fail explicitly", async () => {
  for (const status of [401, 403, 418, 429, 500]) {
    const h = harness({ respond: (url) => response("{}", url, status) });
    const r = await h.run("get_cart", {});
    assert.equal(r.error_kind, ({ 401: "login_required", 403: "challenge", 418: "challenge", 429: "rate_limited", 500: "site_error" })[status]);
  }
  assert.equal((await harness({ missingOp: "getCart" }).run("get_cart", {})).error_kind, "site_changed");
  const h = harness({ respond: (url) => response("<div id='px-captcha'>robot or human</div>", url) });
  assert.equal((await h.run("get_cart", {})).error_kind, "challenge");
});

for (const name of writes) {
  test(`${name}: mock success, exact single POST, postconditions and duplicate prevention`, async () => {
    const c = cart(); if (name === "add_to_cart") c.lineItems = [];
    const h = harness({ cart: c }), input = await inputFor(h, name);
    const result = await h.run(name, input);
    assert.equal(result.status, "ok"); assert.equal(result.mutation_attempted, true); assert.equal(h.state.posts, 1);
    assert.equal(result.quantity, ["remove_cart_item", "save_for_later"].includes(name) ? 0 : 3);
    assert.equal((await h.run(name, input)).error_kind, "duplicate_request"); assert.equal(h.state.posts, 1);
  });
  test(`${name}: account, cart, store and address guards prevent writes`, async () => {
    for (const change of [c => c.customer.id = "OTHER_ACCOUNT", c => c.lineItems[0].quantity++, c => c.fulfillment.deliveryAddress.addressLineOne = "Different fabricated street", () => {}]) {
      const h = harness(), input = await inputFor(h, name); change(h.state.cart);
      if (change.toString().includes("() => {}")) h.document.cookie = "assortmentStoreId=5678";
      const result = await h.run(name, input);
      assert.ok(["wrong_account", "stale_state"].includes(result.error_kind)); assert.equal(h.state.posts, 0);
    }
  });
  test(`${name}: guest, incorrect line/offer, reserved and restricted carts are refused`, async () => {
    const cases = [c => c.customer.isGuest = true, c => c.fulfillment.reservation = { reservedSlot: {} }, c => c.lineItems[0].product.isAlcohol = true, c => c.lineItems[0].rxDetails = {}, c => c.lineItems[0].subscription = { isSelected: true }, c => c.lineItems[0].selectedAddOnServices = [{}]];
    for (const mutate of cases) {
      const c = cart(); mutate(c); const h = harness({ cart: c }), input = await inputFor(h, name);
      const r = await h.run(name, input);
      assert.equal(r.status, "error"); assert.equal(h.state.posts, 0);
    }
    const h = harness(), input = await inputFor(h, name); input.offer_id = "WRONG_OFFER";
    assert.equal((await h.run(name, input)).status, "error"); assert.equal(h.state.posts, 0);
  });
  test(`${name}: dispatched errors are unknown, never retried, and block further writes`, async () => {
    const c = cart(); if (name === "add_to_cart") c.lineItems = [];
    const h = harness({ cart: c, respond: (url, init) => init.method === "POST" ? response("{}", url, 403) : null });
    const input = await inputFor(h, name), r = await h.run(name, input);
    assert.equal(r.error_kind, "outcome_unknown"); assert.equal(r.mutation_attempted, true);
    assert.equal(h.state.calls.filter(c => c.init.method === "POST").length, 1);
    const retry = await h.run(name, { ...input, request_id: "SECOND_REQUEST" });
    assert.equal(retry.error_kind, "outcome_unknown"); assert.equal(h.state.calls.filter(c => c.init.method === "POST").length, 1);
  });
}

test("update_cart_item: equal absolute quantity is an unchanged no-op", async () => {
  const h = harness(), input = await inputFor(h, "update_cart_item"); input.quantity = 2;
  assert.equal((await h.run("update_cart_item", input)).status, "unchanged"); assert.equal(h.state.posts, 0);
});

test("add_to_cart: missing item, unavailable/duplicate offer and changed intent fail closed", async () => {
  const h = harness(), duplicate = await inputFor(h, "add_to_cart");
  assert.equal((await h.run("add_to_cart", duplicate)).error_kind, "stale_state"); assert.equal(h.state.posts, 0);
  const c = cart(); c.lineItems = []; const empty = harness({ cart: c }), input = await inputFor(empty, "add_to_cart"); input.fulfillment_preference = "DELIVERY";
  assert.equal((await empty.run("add_to_cart", input)).error_kind, "stale_state"); assert.equal(empty.state.posts, 0);
});

test("post-write unrelated-line changes, address changes and partial results never claim success", async () => {
  for (const afterWrite of [s => s.cart.fulfillment.deliveryAddress.addressLineOne = "Changed", s => s.cart.lineItems.push(line("UNEXPECTED", { ...product(), offerId: "OTHER_OFFER" })), s => s.cart.lineItems[0].quantity = 7, s => s.cart.lineItems[0].selectedVariants = [{ name: "Different size" }], s => s.cart.lineItems[0].subscription = { isSelected: true }]) {
    const h = harness({ afterWrite }), input = await inputFor(h, "update_cart_item");
    assert.equal((await h.run("update_cart_item", input)).error_kind, "outcome_unknown"); assert.equal(h.state.posts, 1);
  }
});

test("save_for_later: missing modules, paginated or duplicate saved state prevents POST", async () => {
  const missing = harness({ missingOp: "getSFL" }), input = await inputFor(missing, "save_for_later");
  assert.equal((await missing.run("save_for_later", input)).error_kind, "wrong_page"); assert.equal(missing.state.posts, 0);
  for (const update of [s => s.saved.totalQuantity = 200, s => { s.saved.lineItems = [line()]; s.saved.totalQuantity = 2; }]) {
    const h = harness(); update(h.state); const input = await inputFor(h, "save_for_later");
    assert.equal((await h.run("save_for_later", input)).status, "error"); assert.equal(h.state.posts, 0);
  }
});

test("list_lists: own account summaries only, wrong-account and login failures", async () => {
  const h = harness(), guards = await h.guards();
  const r = await h.run("list_lists", { expected_account_token: guards.expected_account_token });
  assert.equal(r.status, "ok"); assert.equal(r.lists[0].name, "Test list"); assert.equal(JSON.stringify(r).includes("Never Return"), false);
  assert.equal(h.state.posts, 0);
  h.state.cart.customer.id = "OTHER_ACCOUNT";
  assert.equal((await h.run("list_lists", { expected_account_token: guards.expected_account_token })).error_kind, "wrong_account");
});

test("add_to_cart: exact observed product eligibility is required before mutation", async () => {
  for (const change of [p => p.type = "Unknown Goods", p => p.showAtc = false, p => p.legalRestriction = true, p => p.isAlcohol = true, p => p.isLMPAlcoholItem = true, p => p.salesUnit = "WEIGHT", p => p.petRx = { eligible: true }, p => p.vision = { visionCenterApproved: true }, p => p.orderLimit = 2]) {
    const c = cart(); c.lineItems = [];
    const p = product(); change(p);
    const h = harness({ cart: c, respond: (url) => url.startsWith("/ip/") ? response(html({ props: { pageProps: { initialData: { data: { product: p } } } } }), url) : null });
    const input = await inputFor(h, "add_to_cart");
    assert.equal((await h.run("add_to_cart", input)).error_kind, "unsupported_item"); assert.equal(h.state.posts, 0);
  }
});

test("cancellation after POST dispatch reports an unknown outcome and never retries", async () => {
  const controller = new AbortController();
  const h = harness({ respond: (url, init) => {
    if (init.method !== "POST") return null;
    controller.abort();
    throw new DOMException("Canceled", "AbortError");
  } });
  const input = await inputFor(h, "update_cart_item");
  const r = await h.run("update_cart_item", input, controller.signal);
  assert.equal(r.error_kind, "outcome_unknown"); assert.equal(r.mutation_attempted, true);
  assert.equal(h.state.calls.filter(c => c.init.method === "POST").length, 1);
});

test("model-supplied confirmation and invalid quantities never reach the site", async () => {
  for (const name of writes) {
    const h = harness(), valid = await inputFor(h, name), before = h.state.calls.length;
    assert.equal((await h.run(name, { ...valid, confirmed: true })).error_kind, "invalid_input");
    assert.equal(h.state.calls.length, before);
    if (name === "add_to_cart" || name === "update_cart_item") for (const quantity of [0, -1, 1.5, 100, "2", null]) {
      assert.equal((await h.run(name, { ...valid, quantity })).error_kind, "invalid_input"); assert.equal(h.state.calls.length, before);
    }
  }
});

test("ten tools form the complete atomic Walmart namespace", () => {
  const registry = JSON.parse(readFileSync(new URL("../registry.json", import.meta.url), "utf8"));
  const registered = registry.tools.filter(t => t.domain === "walmart.com").map(t => t.tool).sort();
  assert.deepEqual(registered, [...names, "search_products", "get_product", "get_product_reviews", "get_store"].sort());
  for (const name of names) assert.equal(harness().definitions[name].tool.annotations.readOnlyHint, ["get_cart", "list_lists"].includes(name));
});
