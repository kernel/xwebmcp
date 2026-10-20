import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";

// kroger.com order and page-context tools. Every page and network interaction is stubbed; nothing
// contacts the live site, and order numbers, addresses and amounts are fabricated.
const source = name => readFileSync(new URL(`../domains/kroger.com/${name}.js`, import.meta.url), "utf8");
const plain = value => JSON.parse(JSON.stringify(value));
const registry = JSON.parse(readFileSync(new URL("../registry.json", import.meta.url), "utf8"));

function conforms(schema, value) {
  if ("const" in schema && value !== schema.const) return false;
  if (schema.enum && !schema.enum.includes(value)) return false;
  if (schema.type && ![schema.type].flat().some(type => {
    if (type === "null") return value === null;
    if (type === "integer") return Number.isInteger(value);
    if (type === "array") return Array.isArray(value);
    if (type === "object") return value !== null && typeof value === "object" && !Array.isArray(value);
    return typeof value === type;
  })) return false;
  if (schema.oneOf && schema.oneOf.filter(s => conforms(s, value)).length !== 1) return false;
  if (schema.not && conforms(schema.not, value)) return false;
  if (Array.isArray(value)) {
    if (schema.maxItems !== undefined && value.length > schema.maxItems) return false;
    if (schema.items && !value.every(item => conforms(schema.items, item))) return false;
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    if (schema.required?.some(key => !Object.hasOwn(value, key))) return false;
    if (schema.properties) {
      if (Object.entries(schema.properties).some(([key, s]) => key in value && !conforms(s, value[key]))) return false;
      if (schema.additionalProperties === false && Object.keys(value).some(key => !(key in schema.properties))) return false;
    }
  }
  if (typeof value === "string") {
    if (value.length < (schema.minLength ?? 0) || value.length > (schema.maxLength ?? Infinity)) return false;
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) return false;
  }
  if (typeof value === "number" && (value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity))) return false;
  return true;
}

const PENDING = { data: { pendingOrderSummaries: { data: [{
  id: "1000000000000000001", purchaseType: "DELIVERY", createDateTime: { value: "2030-01-01T10:00:00Z" }, modifiable: true, cancelable: true,
  costSummary: { total: "USD 42.5000" }, itemCount: 3, handoff: { locationDisplay: "1 Example St" }, modifiableUntil: { value: "2030-01-02T10:00:00.000Z" },
  beginDateTime: { value: "2030-01-02T17:00:00Z" }, endDateTime: { value: "2030-01-02T18:00:00Z" }
}] } } };
const HISTORY = { data: { postOrderSearch: { data: [
  { createdDateTime: { value: "2029-12-30T11:00:00Z" }, handoffStoreId: "54000001", total: "USD 78.02", purchaseType: "DELIVERY", receiptKey: "540~00001~2029-12-30~1460~123", lineItems: [{ upc: "0000000004011" }, { upc: "0001111041700" }], status: "COMPLETED" },
  { createdDateTime: { value: "2029-12-29T11:00:00Z" }, handoffStoreId: "01400001", total: "USD 41.02", purchaseType: "FUEL", receiptKey: "014~00001~2029-12-29~116~456", lineItems: [{ upc: "0001111036838" }], status: "COMPLETED" }
], pageNo: 1, pageSize: 10, pageTotal: 4, isLastPage: false } } };
const DETAILS = { data: { purchaseHistoryDetails: [{
  orderCreateDateTime: { value: "2030-01-01T10:00:00Z" }, loyaltyCard: "000000000000", isModifiable: true, isCancelable: true, orderStatus: "PENDING",
  purchaseId: { orderNumber: "1000000000000000001", fulfillmentId: { locationId: "540FC001" } },
  reservationDetails: { reservationStart: { value: "2030-01-02T17:00:00Z" }, reservationEnd: { value: "2030-01-02T18:00:00Z" }, modifiableUntil: { value: "2030-01-02T10:00:00.000Z" } },
  deliveryAddress: { addressLines: ["1 Example St"], cityTown: "Exampleville", stateProvince: "OH", postalCode: "45000" }, purchaseType: "DELIVERY",
  paymentDetails: [{ paymentMethodName: "AUTHORIZED", lastFourOfCard: "9999", paymentAmount: "USD 42.50", cardTransactionType: "Visa" }],
  specialInstructions: "Leave at door", numberOfItems: 3,
  items: [{ purchasedData: { displayInfo: { description: "Bananas" }, upc: "0000000004011", pricingInfo: { unitPricePaid: "USD 1.03", totalPricePaid: "USD 2.06" }, substitutionInfo: { isAllowed: false, substitutionPolicy: "NONE" }, quantityInfo: { ordered: 2, received: 0 } }, catalogData: { upc: "0000000004011" } }],
  costSummary: { subTotal: "USD 45.10", savings: "USD -2.60", feePaid: "USD 0.00", feeOriginal: "USD 9.95", totalTax: "USD 0.00", total: "USD 42.50" },
  commonPaymentSummary: { lines: [{ type: "TIP", amount: "USD 3.00" }] }
}] } };

function pageHarness(name, options = {}) {
  const requests = [];
  const respond = (status, body) => ({ status, text: async () => typeof body === "string" ? body : JSON.stringify(body) });
  const fetch = async (path, init = {}) => {
    requests.push({ path, method: init.method || "GET", headers: init.headers });
    if (options.fetch) { const forced = options.fetch(path, init); if (forced) return forced(respond); }
    if (path === "/atlas/v1/post-order/v1/pending-order-summaries") return respond(200, PENDING);
    if (path.startsWith("/atlas/v1/post-order/v1/purchase-history-search")) return respond(200, HISTORY);
    return respond(404, { errors: { reason: "no route" } });
  };
  const elements = options.elements ?? {};
  const node = t => ({ innerText: t, textContent: t, getClientRects: () => [1] });
  const url = new URL(options.url ?? "https://www.kroger.com/mypurchases");
  const document = {
    cookie: options.cookie ?? "loggedIn=yes; other=1", readyState: "complete", title: options.title ?? "Kroger",
    documentElement: {}, body: node(""),
    querySelector: sel => { const m = /data-testid="([^"]+)"/.exec(sel); return m && elements[m[1]] !== undefined ? node(elements[m[1]]) : null; },
    querySelectorAll: () => (options.alerts ?? []).map(node),
    modelContext: options.tools ? { getTools: async () => options.tools.map(n => ({ name: "custom.x." + n })) } : undefined
  };
  const context = {
    URL, JSON, URLSearchParams, Date, fetch, document, navigator: {}, location: { origin: url.origin, href: url.href, hostname: url.hostname, pathname: url.pathname },
    setTimeout: (fn) => fn(), MutationObserver: class { observe() {} disconnect() {} }, getComputedStyle: () => ({ visibility: "visible" })
  };
  const [definition] = runInNewContext(`(${source(name)})`, context);
  return {
    definition, requests,
    run: async input => {
      const result = plain(await definition.execute(input));
      assert.ok(conforms(definition.tool.outputSchema, result), `${name} output violates its schema: ${JSON.stringify(result)}`);
      return result;
    }
  };
}

function orderHarness(options = {}) {
  const calls = { navigations: [], cdp: [] };
  let url = options.url ?? "https://www.kroger.com/cart";
  const context = {
    URL, JSON,
    cdp: async (method, params) => {
      calls.cdp.push(method);
      if (method === "Network.getCookies") return { cookies: [{ name: "loggedIn", value: options.loggedIn === false ? "no" : "yes" }] };
      if (method === "Network.enable") return {};
      if (method === "Network.getResponseBody") return { body: typeof options.body === "string" ? options.body : JSON.stringify(options.body ?? DETAILS) };
      throw new Error("unexpected cdp " + method);
    },
    gotoUrl: async next => { calls.navigations.push(next); url = options.redirect ?? next; },
    pageInfo: async () => ({ url }),
    waitMs: async () => {},
    waitForEvent: async (method, { predicate }) => {
      if (options.noResponse) return null;
      const event = { method, params: { requestId: "r1", response: { url: "https://www.kroger.com/atlas/v1/purchase-history/v2/details", status: options.status ?? 200 } } };
      return predicate(event) ? event : null;
    }
  };
  const [definition] = runInNewContext(`(${source("get_order")})`, context);
  return {
    definition, calls,
    run: async input => {
      const result = plain(await definition.execute(input));
      assert.ok(conforms(definition.tool.outputSchema, result), `get_order output violates its schema: ${JSON.stringify(result)}`);
      return result;
    }
  };
}

for (const [name, kind] of [["list_orders", "page"], ["get_page_context", "page"], ["get_order", "cdp"]]) {
  test(`${name}: single-expression ${kind} tool with typed schemas and a matching registry entry`, () => {
    const text = source(name);
    assert.equal(text.trimEnd().endsWith(";"), false);
    assert.equal(/\b(Buffer|require|process)\b/.test(text), false);
    const definition = name === "get_order" ? orderHarness().definition : pageHarness(name).definition;
    assert.equal(definition.kind, kind);
    assert.equal(definition.tool.name, name);
    assert.deepEqual(plain(definition.match.url_patterns), ["https://kroger.com/*", "https://*.kroger.com/*"]);
    const entry = registry.tools.find(t => t.domain === "kroger.com" && t.tool === name);
    assert.ok(entry, "registry entry missing");
    assert.equal(entry.kind, kind);
  });
}

// --- list_orders ----------------------------------------------------------------------------------

test("list_orders: returns pending orders with the site's change flags and one history page", async () => {
  const h = pageHarness("list_orders");
  const result = await h.run({ page: 2, page_size: 5 });
  assert.equal(result.status, "ok");
  assert.deepEqual(result.pending_orders[0], {
    order_id: "1000000000000000001", purchase_type: "DELIVERY", created_at: "2030-01-01T10:00:00Z", window_start: "2030-01-02T17:00:00Z", window_end: "2030-01-02T18:00:00Z",
    modifiable: true, cancelable: true, modifiable_until: "2030-01-02T10:00:00.000Z", total_cents: 4250, item_count: 3, location: "1 Example St"
  });
  assert.equal(result.history.length, 2);
  assert.deepEqual(result.history[0], { receipt_key: "540~00001~2029-12-30~1460~123", purchase_type: "DELIVERY", status: "COMPLETED", created_at: "2029-12-30T11:00:00Z", total_cents: 7802, store_id: "54000001", line_count: 2 });
  assert.equal(result.page_total, 4);
  assert.ok(h.requests.some(r => r.path === "/atlas/v1/post-order/v1/purchase-history-search?pageNo=2&pageSize=5"));
  assert.equal(h.requests.every(r => r.method === "GET"), true, "read-only");
  assert.equal(h.requests.find(r => r.path.includes("pending")).headers["x-application-name"], "clicklist");
});

test("list_orders: include_pending false skips the pending read", async () => {
  const h = pageHarness("list_orders");
  const result = await h.run({ include_pending: false });
  assert.deepEqual(result.pending_orders, []);
  assert.equal(h.requests.some(r => r.path.includes("pending")), false);
});

for (const input of [null, [], { page: 0 }, { page: 1.5 }, { page_size: 21 }, { include_pending: "yes" }, { extra: 1 }]) {
  test(`list_orders: rejects ${JSON.stringify(input)} without requests`, async () => {
    const h = pageHarness("list_orders");
    const result = await h.run(input);
    assert.equal(result.error_kind, "invalid_input");
    assert.deepEqual(h.requests, []);
  });
}

test("list_orders: signed out and off-site pages are refused without requests", async () => {
  let h = pageHarness("list_orders", { cookie: "loggedIn=no" });
  assert.equal((await h.run({})).error_kind, "not_authenticated");
  assert.deepEqual(h.requests, []);
  h = pageHarness("list_orders", { url: "https://login.kroger.com/x" });
  assert.equal((await h.run({})).error_kind, "wrong_page");
  assert.deepEqual(h.requests, []);
});

test("list_orders: HTTP errors map to explicit error kinds", async () => {
  for (const [status, kind] of [[401, "not_authenticated"], [429, "challenge"], [500, "site_error"]]) {
    const h = pageHarness("list_orders", { fetch: () => respond => respond(status, { errors: { reason: "x" } }) });
    assert.equal((await h.run({})).error_kind, kind);
  }
  const h = pageHarness("list_orders", { fetch: () => respond => respond(200, "<html>") });
  assert.equal((await h.run({})).error_kind, "site_error");
});

// --- get_order ------------------------------------------------------------------------------------

test("get_order: opens the pending order page and reads the details it loads", async () => {
  const h = orderHarness();
  const result = await h.run({ order_id: "1000000000000000001" });
  assert.deepEqual(h.calls.navigations, ["https://www.kroger.com/mypurchases/pending/1000000000000000001"]);
  assert.equal(result.status, "ok");
  assert.equal(result.modifiable, true);
  assert.equal(result.cancelable, true);
  assert.equal(result.postal_code, "45000");
  assert.deepEqual(result.items[0], { upc: "0000000004011", description: "Bananas", quantity_ordered: 2, quantity_received: 0, unit_price_cents: 103, total_price_cents: 206, substitution_policy: "NONE", substitution_allowed: false });
  assert.deepEqual(result.costs, { subtotal_cents: 4510, savings_cents: -260, delivery_fee_cents: 0, delivery_fee_original_cents: 995, tax_cents: 0, tip_cents: 300, total_cents: 4250 });
  assert.deepEqual(result.payment_methods, [{ card_type: "Visa", amount_cents: 4250 }]);
  assert.equal(JSON.stringify(result).includes("9999"), false, "card digits are never returned");
  assert.equal(JSON.stringify(result).includes("Example St"), false, "street address is never returned");
});

test("get_order: a receipt key opens the receipt detail page", async () => {
  const h = orderHarness();
  const result = await h.run({ receipt_key: "540~00001~2029-12-30~1460~123" });
  assert.deepEqual(h.calls.navigations, ["https://www.kroger.com/mypurchases/detail/540~00001~2029-12-30~1460~123"]);
  assert.equal(result.receipt_key, "540~00001~2029-12-30~1460~123");
});

for (const input of [undefined, {}, { order_id: "12" }, { order_id: 123456789 }, { receipt_key: "bad" }, { order_id: "1000000000000000001", receipt_key: "540~00001~2029-12-30~1460~123" }, { order_id: "1000000000000000001", extra: 1 }]) {
  test(`get_order: rejects ${JSON.stringify(input)} before navigating`, async () => {
    const h = orderHarness();
    assert.equal((await h.run(input)).error_kind, "invalid_input");
    assert.deepEqual(h.calls.navigations, []);
  });
}

test("get_order: signed out is refused before navigating", async () => {
  const h = orderHarness({ loggedIn: false });
  assert.equal((await h.run({ order_id: "1000000000000000001" })).error_kind, "not_authenticated");
  assert.deepEqual(h.calls.navigations, []);
});

test("get_order: an unknown order number is not_found", async () => {
  const h = orderHarness({ status: 400, body: { errors: { reason: "Unexpected receipt key(s) without x-isreceipt header" } } });
  assert.equal((await h.run({ order_id: "123456789" })).error_kind, "not_found");
});

test("get_order: a page that loads another order is not reported as the requested one", async () => {
  const h = orderHarness();
  assert.equal((await h.run({ order_id: "2000000000000000002" })).error_kind, "site_error");
});

test("get_order: a redirect to sign-in without a details request is not_authenticated", async () => {
  const h = orderHarness({ noResponse: true, redirect: "https://login.kroger.com/signin" });
  assert.equal((await h.run({ order_id: "1000000000000000001" })).error_kind, "not_authenticated");
});

test("get_order: no details request at all is an explicit site_error", async () => {
  const h = orderHarness({ noResponse: true });
  assert.equal((await h.run({ order_id: "1000000000000000001" })).error_kind, "site_error");
});

// --- get_page_context -----------------------------------------------------------------------------

const header = { "CurrentModality-textV2": "Delivery to 1 Example St", "CurrentModality-vanityName": "1 Example St", "CartHeader-badge": "2", "CartLink": "2" };

test("get_page_context: classifies the cart page and reads the header", async () => {
  const result = await pageHarness("get_page_context", { url: "https://www.kroger.com/cart", elements: header, tools: ["get_cart", "get_delivery_slots"] }).run({});
  assert.equal(result.page_type, "cart");
  assert.equal(result.signed_in, true);
  assert.equal(result.fulfillment_type, "DELIVERY");
  assert.equal(result.fulfillment_label, "1 Example St");
  assert.equal(result.cart_count, 2);
  assert.deepEqual(result.available_tools, ["get_cart", "get_delivery_slots"]);
  assert.ok(result.suggested_next_steps.some(s => s.includes("get_delivery_slots")));
});

test("get_page_context: order pages expose the id or receipt key and never suggest order changes by tool", async () => {
  let result = await pageHarness("get_page_context", { url: "https://www.kroger.com/mypurchases/pending/1000000000000000001", elements: header }).run({});
  assert.equal(result.page_type, "pending_order");
  assert.equal(result.order_id, "1000000000000000001");
  assert.ok(result.suggested_next_steps.some(s => /no tool performs it/.test(s)));
  result = await pageHarness("get_page_context", { url: "https://www.kroger.com/mypurchases/detail/540~00001~2029-12-30~1460~123", elements: header }).run({});
  assert.equal(result.page_type, "purchase_detail");
  assert.equal(result.receipt_key, "540~00001~2029-12-30~1460~123");
});

test("get_page_context: checkout steps warn that reserving, paying and placing are the user's actions", async () => {
  const schedule = await pageHarness("get_page_context", { url: "https://www.kroger.com/scheduling?fulfillmentType=HomeDelivery", elements: header }).run({});
  assert.equal(schedule.page_type, "checkout_schedule");
  assert.ok(schedule.suggested_next_steps.some(s => /may reserve it/.test(s)));
  const upsell = await pageHarness("get_page_context", { url: "https://www.kroger.com/got-everything", elements: header }).run({});
  assert.equal(upsell.page_type, "checkout_upsell");
});

test("get_page_context: signed out, sign-in host, price live regions and unknown header", async () => {
  const result = await pageHarness("get_page_context", { url: "https://login.kroger.com/signin", cookie: "loggedIn=no", alerts: ["about $1.03 each", "Something went wrong"] }).run({ wait_for_settled_seconds: 1 });
  assert.equal(result.page_type, "sign_in");
  assert.equal(result.signed_in, false);
  assert.equal(result.fulfillment_type, null);
  assert.equal(result.cart_count, null);
  assert.deepEqual(result.page_messages, ["Something went wrong"]);
  assert.equal(result.available_tools, null);
});

test("get_page_context: other kroger.com subdomains are not shopping pages", async () => {
  const result = await pageHarness("get_page_context", { url: "https://developer.kroger.com/", elements: {} }).run({});
  assert.equal(result.page_type, "other");
  assert.equal(result.suggested_next_steps.some(s => s.includes("get_cart")), false);
});

test("get_page_context: an empty cart does not suggest delivery windows", async () => {
  const result = await pageHarness("get_page_context", { url: "https://www.kroger.com/cart", elements: { ...header, "CartHeader-badge": "0" } }).run({});
  assert.equal(result.cart_count, 0);
  assert.equal(result.suggested_next_steps.some(s => s.includes("get_delivery_slots")), false);
});
