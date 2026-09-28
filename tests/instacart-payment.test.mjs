import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";

// list_payment_methods and select_payment_method are page tools: execute runs in the page,
// so each test evaluates the file in a fresh context that only has page globals (fetch,
// location, crypto, Date) backed by a fake GraphQL endpoint. All data is fabricated.

const source = name => readFileSync(new URL(`../domains/instacart.com/${name}.js`, import.meta.url), "utf8");
const plain = value => JSON.parse(JSON.stringify(value));

function conforms(schema, value) {
  if ("const" in schema && value !== schema.const) return false;
  if (schema.enum && !schema.enum.includes(value)) return false;
  if (schema.type && ![schema.type].flat().some(type => {
    if (type === "null") return value === null;
    if (type === "integer") return Number.isInteger(value);
    if (type === "number") return typeof value === "number" && Number.isFinite(value);
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
  if (typeof value === "string") {
    if (value.length < (schema.minLength ?? 0) || value.length > (schema.maxLength ?? Infinity)) return false;
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) return false;
    if (schema.format === "uri" && !URL.canParse(value)) return false;
  }
  if (typeof value === "number") {
    if (value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity)) return false;
    if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) return false;
  }
  return true;
}

const method = (id, type, label, detail, extra = {}) => ({ id: `pm-${id}`, instrumentReference: id, instrumentType: type, isEnabled: true, viewSection: { stringSet: { labelString: label, sublabelString: detail } }, ...extra });
const methods = [
  method("credit_1001", "paypal", "PayPal", "person@example.com"),
  method("credit_1002", "creditCard", "Amex *0005", "Exp. 2/25"),
  method("credit_1003", "creditCard", "Visa *0004", "Exp. 2/30"),
  method("credit_1004", "creditCard", "Visa *0006", "Exp. 1/31", { isEnabled: false })
];
const shops = [{ id: "1760", serviceType: "delivery", retailer: { slug: "market" } }, { id: "1761", serviceType: "pickup", retailer: { slug: "market" } }];

function page(name, options = {}) {
  const state = { selected: options.selected ?? "credit_1003", requests: [], writes: [] };
  const respond = (op, variables) => {
    if (options.respond) { const custom = options.respond(op, variables, state); if (custom) return custom; }
    switch (op) {
      case "BuyflowPaymentInstrumentsV2": return { data: { buyflowPaymentInstruments: options.noPayments ? null : { paymentSelection: { savedPaymentMethods: { paymentMethods: (options.methods ?? methods).map(m => ({ ...m, isSelected: m.instrumentReference === state.selected })) } } } } };
      case "GetLastUserLocation": return { data: { lastUserLocation: options.noAddress ? { zoneId: "78", postalCode: "62701" } : { addressId: "900001", zoneId: "78", postalCode: "62701", coordinates: { latitude: 39.8, longitude: -89.6 } } } };
      case "ShopCollectionScoped": return { data: { shopCollection: { shops: variables.retailerSlug === "market" ? shops : [] } } };
      case "ActiveCartId": return { data: { shopBasket: { cartId: "777", cartType: "grocery" } } };
      case "CartData": return { data: { userCart: { id: variables.id, itemCount: options.emptyCart ? 0 : 1 } } };
      case "InitializeCheckout": return { data: { initializeCheckout: { checkoutData: { checkoutSessionId: "checkoutsession_test_1", cartId: variables.cartId } } } };
      case "UpdateBuyflowPaymentInstructionsV2": {
        if (options.reject) return { data: { updateBuyflowPaymentInstructions: { updatedPaymentInstructions: [] } } };
        if (!options.ignore) state.selected = variables.updatePaymentInstructions.updatePrimaryInstrument.primaryInstrumentReference;
        return { data: { updateBuyflowPaymentInstructions: { updatedPaymentInstructions: [{ instrumentReference: variables.updatePaymentInstructions.updatePrimaryInstrument.primaryInstrumentReference }] } } };
      }
      case "UpdateCheckout": return { data: { updateCheckout: { checkoutData: { checkoutSessionId: variables.checkoutSessionId } } } };
      default: return { errors: [{ message: "unknown op", extensions: { code: "PERSISTED_QUERY_NOT_SUPPORTED" } }], data: null };
    }
  };
  const url = new URL(options.url ?? "https://www.instacart.com/store/account");
  let uuid = 0;
  const context = {
    URL, JSON, Array, Object, String, Number, RegExp, Error, Promise,
    Date: class extends Date { constructor(...args) { super(...(args.length ? args : ["2026-09-28T12:00:00Z"])); } },
    crypto: { randomUUID: () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, "0")}` },
    location: { origin: url.origin, hostname: url.hostname, protocol: url.protocol, href: url.href },
    fetch: async (input, init = {}) => {
      const target = typeof input === "string" ? new URL(input, url.origin) : input;
      assert.equal(init.headers["x-client-identifier"], "web");
      let op, variables;
      if (init.method === "POST") { ({ operationName: op, variables } = JSON.parse(init.body)); assert.equal(target.searchParams.get("operationName"), op); state.writes.push(op); }
      else { op = target.searchParams.get("operationName"); variables = JSON.parse(target.searchParams.get("variables")); }
      state.requests.push({ op, variables, method: init.method ?? "GET" });
      if (options.http?.[op]) return { status: options.http[op], text: async () => "" };
      if (options.throwOn === op) throw new Error("network down");
      return { status: 200, text: async () => JSON.stringify(respond(op, variables)) };
    }
  };
  const tool = runInNewContext(`(${source(name)})`, context)[0];
  return { tool, state, run: async input => {
    const result = plain(await tool.execute(input));
    assert.ok(conforms(tool.tool.outputSchema, result), `${name} output violates its schema: ${JSON.stringify(result)}`);
    return result;
  } };
}

for (const name of ["list_payment_methods", "select_payment_method"]) {
  test(`${name}: single-expression page tool with domain patterns and typed schemas`, () => {
    const { tool } = page(name);
    assert.equal(tool.kind, "page");
    assert.equal(tool.tool.name, name);
    assert.deepEqual(plain(tool.match.url_patterns), ["https://instacart.com/*", "https://*.instacart.com/*"]);
    assert.equal(tool.tool.outputSchema.oneOf.length, 2);
    assert.equal(/;\s*$/.test(source(name)), false);
    assert.equal(/\b(?:Buffer|require|process|gotoUrl|js)\(/.test(source(name)), false);
  });

  test(`${name}: refuses to run off instacart.com`, async () => {
    const h = page(name, { url: "https://example.com/" });
    const result = await h.run(name === "list_payment_methods" ? {} : { store: "market", payment_method_id: "credit_1001" });
    assert.equal(result.error_kind, "wrong_page");
    assert.deepEqual(h.state.requests, []);
  });
}

test("list_payment_methods: lists saved methods with the selected one, availability and expiry", async () => {
  const h = page("list_payment_methods");
  const result = await h.run({});
  assert.equal(result.selected_payment_method_id, "credit_1003");
  assert.deepEqual(result.payment_methods.map(m => [m.payment_method_id, m.type, m.label, m.detail, m.is_selected, m.is_enabled, m.expired]), [
    ["credit_1001", "paypal", "PayPal", "person@example.com", false, true, null],
    ["credit_1002", "creditCard", "Amex *0005", "Exp. 2/25", false, true, true],
    ["credit_1003", "creditCard", "Visa *0004", "Exp. 2/30", true, true, false],
    ["credit_1004", "creditCard", "Visa *0006", "Exp. 1/31", false, false, false]
  ]);
  assert.equal(h.state.requests[0].variables.scenario, "checkoutV4Web");
  assert.deepEqual(h.state.writes, []);
});

test("list_payment_methods: rejects input and reports site failures", async () => {
  assert.equal((await page("list_payment_methods").run({ x: 1 })).error_kind, "invalid_input");
  assert.equal((await page("list_payment_methods", { noPayments: true }).run({})).error_kind, "not_logged_in");
  assert.equal((await page("list_payment_methods", { http: { BuyflowPaymentInstrumentsV2: 429 } }).run({})).error_kind, "throttled");
  assert.equal((await page("list_payment_methods", { http: { BuyflowPaymentInstrumentsV2: 401 } }).run({})).error_kind, "not_logged_in");
  assert.equal((await page("list_payment_methods", { respond: () => ({ errors: [{ extensions: { code: "PERSISTED_QUERY_NOT_FOUND" } }], data: null }) }).run({})).error_kind, "site_changed");
  const none = await page("list_payment_methods", { methods: [] }).run({});
  assert.deepEqual([none.selected_payment_method_id, none.payment_methods], [null, []]);
});

test("select_payment_method: opens a checkout, sends one selection update and confirms it", async () => {
  const h = page("select_payment_method");
  const result = await h.run({ store: "market", payment_method_id: "credit_1001" });
  assert.deepEqual(result, { status: "ok", changed: true, mutation_attempted: true, previous_payment_method_id: "credit_1003", selected_payment_method_id: "credit_1001", label: "PayPal", detail: "person@example.com", cart_id: "777" });
  assert.deepEqual(h.state.writes, ["InitializeCheckout", "UpdateBuyflowPaymentInstructionsV2", "UpdateCheckout"]);
  const init = h.state.requests.find(r => r.op === "InitializeCheckout").variables;
  assert.deepEqual([init.cartId, init.shopId, init.serviceType, init.userLocation.addressId], ["777", "1760", "DELIVERY", "900001"]);
  const update = h.state.requests.find(r => r.op === "UpdateBuyflowPaymentInstructionsV2").variables;
  assert.deepEqual(update, { checkoutSessionId: "checkoutsession_test_1", updatePaymentInstructions: { toggleSplitTenderInstrument: { splitTenderPaymentInstructionsToken: "", toggle: false }, updatePrimaryInstrument: { primaryInstrumentReference: "credit_1001", paymentInstrumentType: "paypal" } } });
  assert.equal(h.state.requests.at(-1).op, "BuyflowPaymentInstrumentsV2");
});

test("select_payment_method: pickup uses the pickup shop", async () => {
  const h = page("select_payment_method");
  await h.run({ store: "market", service_type: "pickup", payment_method_id: "credit_1001" });
  const init = h.state.requests.find(r => r.op === "InitializeCheckout").variables;
  assert.deepEqual([init.shopId, init.serviceType], ["1761", "PICKUP"]);
});

test("select_payment_method: the already selected method sends nothing", async () => {
  const h = page("select_payment_method");
  const result = await h.run({ store: "market", payment_method_id: "credit_1003" });
  assert.deepEqual([result.changed, result.mutation_attempted, result.cart_id], [false, false, null]);
  assert.deepEqual(h.state.writes, []);
});

test("select_payment_method: invalid, unknown, disabled and expired methods are rejected before any write", async () => {
  const cases = [
    [null, "invalid_input"], [{}, "invalid_input"], [{ store: "market" }, "invalid_input"], [{ payment_method_id: "credit_1001" }, "invalid_input"],
    [{ store: "Market!", payment_method_id: "credit_1001" }, "invalid_input"], [{ store: "market", payment_method_id: "a b" }, "invalid_input"],
    [{ store: "market", payment_method_id: "credit_1001", service_type: "drone" }, "invalid_input"], [{ store: "market", payment_method_id: "credit_1001", extra: 1 }, "invalid_input"],
    [{ store: "market", payment_method_id: "credit_9" }, "payment_method_not_found"],
    [{ store: "market", payment_method_id: "credit_1004" }, "payment_method_unusable"],
    [{ store: "market", payment_method_id: "credit_1002" }, "payment_method_unusable"]
  ];
  for (const [input, kind] of cases) {
    const h = page("select_payment_method");
    const result = await h.run(input);
    assert.equal(result.error_kind, kind, JSON.stringify(input));
    assert.equal(result.mutation_attempted, false);
    assert.deepEqual(h.state.writes, []);
  }
});

test("select_payment_method: no store, empty cart or no address stops before any write", async () => {
  for (const [options, input, kind] of [
    [{}, { store: "elsewhere", payment_method_id: "credit_1001" }, "store_not_found"],
    [{ emptyCart: true }, { store: "market", payment_method_id: "credit_1001" }, "cart_empty"],
    [{ noAddress: true }, { store: "market", payment_method_id: "credit_1001" }, "not_logged_in"]
  ]) {
    const h = page("select_payment_method", options);
    const result = await h.run(input);
    assert.equal(result.error_kind, kind);
    assert.equal(result.mutation_attempted, false);
    assert.deepEqual(h.state.writes, []);
  }
});

test("select_payment_method: a rejected, unconfirmed or failed update is reported and never retried", async () => {
  const rejected = page("select_payment_method", { reject: true });
  const a = await rejected.run({ store: "market", payment_method_id: "credit_1001" });
  assert.deepEqual([a.error_kind, a.mutation_attempted], ["selection_rejected", true]);
  const ignored = page("select_payment_method", { ignore: true });
  const b = await ignored.run({ store: "market", payment_method_id: "credit_1001" });
  assert.deepEqual([b.error_kind, b.mutation_attempted], ["unknown", true]);
  const broken = page("select_payment_method", { throwOn: "UpdateBuyflowPaymentInstructionsV2" });
  const c = await broken.run({ store: "market", payment_method_id: "credit_1001" });
  assert.deepEqual([c.error_kind, c.mutation_attempted], ["unknown", true]);
  assert.match(c.error_message, /after the update was sent/);
  for (const h of [rejected, ignored, broken]) assert.equal(h.state.writes.filter(op => op === "UpdateBuyflowPaymentInstructionsV2").length, 1);
  const noSession = page("select_payment_method", { respond: op => op === "InitializeCheckout" ? { data: { initializeCheckout: null } } : null });
  const d = await noSession.run({ store: "market", payment_method_id: "credit_1001" });
  assert.deepEqual([d.error_kind, d.mutation_attempted], ["unknown", false]);
  assert.deepEqual(noSession.state.writes, ["InitializeCheckout"]);
});
