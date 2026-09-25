import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";

// Shared harness for the kroger.com search and cart tools. Every page and API interaction is stubbed;
// nothing here contacts the live site, and the fixtures use fabricated addresses and cart contents.
const fixture = name => JSON.parse(readFileSync(new URL(`./fixtures/kroger/${name}.json`, import.meta.url), "utf8"));
const sources = Object.fromEntries(["search_products", "get_product", "get_cart", "add_to_cart", "update_cart_item"].map(name =>
  [name, readFileSync(new URL(`../domains/kroger.com/${name}.js`, import.meta.url), "utf8")]));
const plain = value => JSON.parse(JSON.stringify(value));
const LAF = JSON.stringify(fixture("laf"));
const HOME = "https://www.kroger.com/";

// Validate the JSON Schema keywords used by these tools without adding a dependency.
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
  if (schema.allOf && !schema.allOf.every(s => conforms(s, value))) return false;
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) return false;
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
    if (value.length < (schema.minLength ?? 0)) return false;
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) return false;
    if (schema.format === "uri" && !URL.canParse(value)) return false;
  }
  if (typeof value === "number") {
    if (value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity)) return false;
  }
  return true;
}

function harness(name, options = {}) {
  let url = options.url ?? HOME;
  let cart = plain(options.cart ?? fixture("cart"));
  const products = plain(options.products ?? fixture("products"));
  const search = plain(options.search ?? fixture("search"));
  const storage = new Map(options.storage ?? []);
  const cookies = options.cookies ?? [
    { name: "loggedIn", value: options.loggedIn === false ? "no" : "yes" },
    { name: "x-active-modality", value: encodeURIComponent(JSON.stringify({ type: options.modality ?? "DELIVERY", postalCode: "45200", createdDate: options.cookieStamp ?? 1 })) },
    { name: "StoreCode", value: "00418" }, { name: "DD_modStore", value: "540FC001" }
  ];
  const calls = { navigations: [], requests: [], captures: 0, waits: [] };
  let nextLine = 1;
  const respond = (status, body) => ({ status, body: JSON.stringify(body) });
  const route = (path, method, body) => {
    calls.requests.push({ path, method, body });
    if (options.responses) { const forced = options.responses(path, method, body); if (forced) return forced; }
    if (path.startsWith("/atlas/v1/search/v1/products-search")) return respond(200, search);
    if (path.startsWith("/atlas/v1/product/v2/products")) {
      const wanted = [...new URLSearchParams(path.split("?")[1]).getAll("filter.gtin13s")];
      return respond(200, { data: { products: products.data.products.filter(p => wanted.includes(p.id)) } });
    }
    if (path === "/atlas/v1/carts" && method === "GET") return respond(200, cart);
    if (path.startsWith("/atlas/v1/carts/") && method === "PUT") {
      const active = cart.data.carts[0];
      for (const line of JSON.parse(body).lineItems) {
        const index = active.lineItems.findIndex(l => l.id === line.id);
        if (index >= 0) { if (line.quantity === 0) active.lineItems.splice(index, 1); else active.lineItems[index].quantity = options.ignoreUpdates ? active.lineItems[index].quantity : line.quantity; }
        else if (line.quantity > 0) active.lineItems.push({ id: `line-${nextLine++}`, gtin13: line.gtin13, modalityType: line.modalityType, quantity: line.quantity, savedForLater: false });
      }
      active.lineItemCount = active.lineItems.length;
      return respond(200, { data: { carts: active } });
    }
    return respond(404, { errors: { reason: "no route", code: "NOT_FOUND" } });
  };
  const context = {
    URL, JSON,
    pageInfo: async () => ({ url }),
    gotoUrl: async next => { calls.navigations.push(next); url = next; },
    waitForLoad: async () => options.loads !== false,
    waitMs: async ms => { calls.waits.push(ms); },
    cdp: async (method, params) => {
      if (method === "Network.getCookies") return { cookies };
      if (method === "Network.enable") return {};
      throw new Error("unexpected cdp " + method);
    },
    waitForEvent: async (method, { predicate }) => {
      calls.captures++;
      if (options.captureFails || (options.captureFailsOnce && calls.captures === 1)) return null;
      const event = { method, params: { request: { url: "https://www.kroger.com/atlas/v1/carts", headers: { "x-laf-object": options.laf ?? LAF } } } };
      return predicate(event) ? event : null;
    },
    js: async (fn, args) => {
      const text = fn.toString();
      if (text.includes("sessionStorage.getItem")) { const c = storage.get(args.arg.name); return c && c.key === args.arg.key ? c.laf : null; }
      if (text.includes("sessionStorage.setItem")) { storage.set(args.arg.name, { key: args.arg.key, laf: args.arg.laf }); return undefined; }
      if (text.includes("fetch(")) {
        assert.equal(args.arg.headers["x-kroger-channel"], "WEB");
        assert.equal(typeof args.arg.headers["x-laf-object"], "string");
        const { status, body } = route(args.arg.path, args.arg.method, args.arg.body);
        if (options.nonJson) return { status: 200, body: null, text: options.nonJson };
        try { return { status, body: JSON.parse(body) }; } catch { return { status, body: null, text: body }; }
      }
      throw new Error("unexpected page function: " + text.slice(0, 60));
    }
  };
  const [definition] = runInNewContext(`(${sources[name]})`, context);
  return {
    definition, calls, storage, cart: () => cart.data.carts[0],
    run: async (...args) => {
      const result = plain(await definition.execute(...args));
      assert.ok(conforms(definition.tool.outputSchema, result), `${name} output violates its schema: ${JSON.stringify(result)}`);
      return result;
    }
  };
}

const registry = JSON.parse(readFileSync(new URL("../registry.json", import.meta.url), "utf8"));

for (const name of Object.keys(sources)) {
  test(`${name}: single-expression CDP tool with typed schemas and a registry entry`, () => {
    assert.equal(sources[name].trimEnd().endsWith(";"), false);
    assert.equal(/\b(Buffer|require|process)\b/.test(sources[name]), false, "tool source must not depend on Node globals");
    const { definition } = harness(name);
    assert.equal(definition.kind, "cdp");
    assert.equal(definition.tool.name, name);
    assert.deepEqual(plain(definition.match.url_patterns), ["https://kroger.com/*", "https://*.kroger.com/*"]);
    assert.equal(definition.tool.inputSchema.type, "object");
    assert.equal(definition.tool.outputSchema.type, "object");
    const entry = registry.tools.find(t => t.domain === "kroger.com" && t.tool === name);
    assert.ok(entry, "registry entry missing");
    assert.equal(entry.file, `domains/kroger.com/${name}.js`);
    assert.deepEqual(entry.url_patterns, plain(definition.match.url_patterns));
  });
}

test("registry lists every kroger.com tool exactly once", () => {
  const names = registry.tools.filter(t => t.domain === "kroger.com").map(t => t.tool).sort();
  assert.deepEqual(names, ["add_to_cart", "get_cart", "get_product", "login", "search_products", "update_cart_item"]);
});

// --- input validation happens before any page access -----------------------------------------------

const invalidInputs = {
  search_products: [undefined, null, [], {}, { query: "" }, { query: 7 }, { query: "milk", limit: 0 }, { query: "milk", limit: 41 }, { query: "milk", limit: 1.5 }, { query: "milk", extra: true }],
  get_product: [undefined, {}, { upc: "" }, { upc: "12ab" }, { upc: 4011 }, { upc: "1234567" }, { upc: "123456789012345" }, { upc: "0000000004011", extra: 1 }],
  get_cart: [null, [], { extra: true }],
  add_to_cart: [undefined, {}, { upc: "abc" }, { upc: "0000000004011", quantity: 0 }, { upc: "0000000004011", quantity: 21 }, { upc: "0000000004011", quantity: "2" }, { upc: "0000000004011", extra: 1 }],
  update_cart_item: [undefined, {}, { upc: "0000000004011" }, { quantity: 1 }, { upc: "0000000004011", quantity: -1 }, { upc: "0000000004011", quantity: 21 }, { upc: "0000000004011", quantity: 1.5 }, { upc: "0000000004011", quantity: 1, extra: 1 }]
};
for (const [name, inputs] of Object.entries(invalidInputs)) {
  for (const input of inputs) {
    test(`${name}: rejects ${JSON.stringify(input)} before touching the page`, async () => {
      const h = harness(name);
      if (input && typeof input === "object" && !Array.isArray(input)) assert.equal(conforms(h.definition.tool.inputSchema, input), false, "input schema should reject it too");
      const result = await h.run(input);
      assert.equal(result.status, "error");
      assert.equal(result.error_kind, "invalid_input");
      assert.deepEqual(h.calls.navigations, []);
      assert.deepEqual(h.calls.requests, []);
      assert.equal(h.calls.captures, 0);
    });
  }
}

// --- context: page routing, header capture and caching ---------------------------------------------

for (const url of ["https://example.com/", "about:blank", "https://login.kroger.com/x", "https://start.duckduckgo.com/"]) {
  test(`search_products: navigates home from ${url} before calling the site`, async () => {
    const h = harness("search_products", { url });
    const result = await h.run({ query: "bananas" });
    assert.equal(result.status, "ok");
    assert.equal(h.calls.navigations[0], HOME);
  });
}

for (const url of ["https://www.kroger.com/signin", "https://www.kroger.com/account/dashboard/"]) {
  test(`search_products: never reloads ${url}; it opens the homepage instead`, async () => {
    const h = harness("search_products", { url });
    assert.equal((await h.run({ query: "bananas" })).status, "ok");
    assert.deepEqual(h.calls.navigations, [HOME, HOME]);
  });
}

test("get_product: a delivery entry never reports an address name as the store name", async () => {
  const laf = fixture("laf");
  laf[0].modality.handoffAddress.address.name = "Recipient Name";
  const result = await harness("get_product", { laf: JSON.stringify(laf) }).run({ upc: "0000000004011" });
  assert.equal(result.fulfillment.store_name, null);
  assert.equal(result.fulfillment.postal_code, "45200");
});

test("search_products: stays on a kroger.com page and reloads it once to capture the store header", async () => {
  const h = harness("search_products", { url: "https://www.kroger.com/p/milk/0001111041700" });
  await h.run({ query: "bananas" });
  assert.deepEqual(h.calls.navigations, ["https://www.kroger.com/p/milk/0001111041700"]);
  assert.equal(h.calls.captures, 1);
  assert.equal(h.storage.get("kroger.com.laf.v1").laf, LAF);
});

test("get_product: reuses the cached store header without reloading", async () => {
  const key = ["", "", "", "", "", "00418", "540FC001"].join("|");
  const h = harness("get_product", { cookies: [{ name: "loggedIn", value: "yes" }, { name: "StoreCode", value: "00418" }, { name: "DD_modStore", value: "540FC001" }], storage: [["kroger.com.laf.v1", { key, laf: LAF }]] });
  const result = await h.run({ upc: "0000000004011" });
  assert.equal(result.status, "ok");
  assert.equal(h.calls.captures, 0);
  assert.deepEqual(h.calls.navigations, []);
  assert.equal(result.fulfillment.type, "DELIVERY", "falls back to the first header entry when no modality cookie is set");
});

test("get_product: the cache key ignores the modality cookie's changing timestamp", async () => {
  const key = ["DELIVERY", "", "45200", "", "", "00418", "540FC001"].join("|");
  const h = harness("get_product", { cookieStamp: 987654321, storage: [["kroger.com.laf.v1", { key, laf: LAF }]] });
  assert.equal((await h.run({ upc: "0000000004011" })).status, "ok");
  assert.equal(h.calls.captures, 0, "a cookie that only differs by timestamp must still hit the cache");
});

test("get_product: a promotion equal to the regular price is not reported as a promotion", async () => {
  const products = fixture("products");
  products.data.products[1].fulfillmentSummaries[0].promo.price = "USD 2.89";
  const result = await harness("get_product", { products }).run({ upc: "0001111041700" });
  assert.equal(result.product.price_cents, 289);
  assert.equal(result.product.promo_price_cents, null);
});

test("get_product: a stale cache entry for another store is ignored", async () => {
  const h = harness("get_product", { storage: [["kroger.com.laf.v1", { key: "other", laf: LAF }]] });
  await h.run({ upc: "0000000004011" });
  assert.equal(h.calls.captures, 1);
});

test("get_product: failing to capture the store header twice is an explicit site_error", async () => {
  const h = harness("get_product", { captureFails: true });
  const result = await h.run({ upc: "0000000004011" });
  assert.equal(result.error_kind, "site_error");
  assert.equal(h.calls.captures, 2);
  assert.deepEqual(h.calls.requests, []);
});

test("get_product: a capture that misses once is retried", async () => {
  const h = harness("get_product", { captureFailsOnce: true });
  assert.equal((await h.run({ upc: "0000000004011" })).status, "ok");
  assert.equal(h.calls.captures, 2);
});

test("get_product: an unparsable store header is an explicit site_error", async () => {
  const h = harness("get_product", { laf: "not json" });
  assert.equal((await h.run({ upc: "0000000004011" })).error_kind, "site_error");
});

test("get_product: selects the header entry and store for the active fulfillment method", async () => {
  const h = harness("get_product", { modality: "PICKUP" });
  const result = await h.run({ upc: "0000000004011" });
  assert.deepEqual(result.fulfillment, { type: "PICKUP", store_id: "01400355", postal_code: "45201", store_name: "Fixture Store" });
  assert.equal(result.product.available, true);
  assert.equal(result.product.max_order_quantity, null);
  assert.match(h.calls.requests[0].path, /filter\.gtin13s=0000000004011/);
});

// --- API error mapping --------------------------------------------------------------------------------

for (const [status, kind] of [[401, "not_authenticated"], [403, "not_authenticated"], [429, "challenge"], [500, "site_error"]]) {
  test(`search_products: HTTP ${status} from the site maps to ${kind}`, async () => {
    const h = harness("search_products", { responses: path => path.includes("products-search") ? { status, body: JSON.stringify({ errors: { reason: "nope", code: "X" } }) } : null });
    assert.equal((await h.run({ query: "bananas" })).error_kind, kind);
  });
}

test("search_products: a bot-protection challenge body maps to challenge after one retry", async () => {
  const h = harness("search_products", { responses: path => path.includes("products-search") ? { status: 200, body: JSON.stringify({ cpr_chlge: "true" }) } : null });
  assert.equal((await h.run({ query: "bananas" })).error_kind, "challenge");
  assert.equal(h.calls.requests.filter(r => r.path.includes("products-search")).length, 2);
  assert.ok(h.calls.waits.includes(5000));
});

test("search_products: a single 429 is retried once and then succeeds", async () => {
  let hits = 0;
  const h = harness("search_products", { responses: path => path.includes("products-search") && ++hits === 1 ? { status: 429, body: JSON.stringify({ message: "Too many requests" }) } : null });
  assert.equal((await h.run({ query: "bananas" })).status, "ok");
  assert.equal(hits, 2);
});

test("add_to_cart: a challenged write is retried once because the edge never forwarded it", async () => {
  let puts = 0;
  const h = harness("add_to_cart", { responses: (path, method) => method === "PUT" && ++puts === 1 ? { status: 429, body: JSON.stringify({ cpr_chlge: "true" }) } : null });
  const result = await h.run({ upc: "0000000004011", quantity: 1 });
  assert.equal(result.status, "ok");
  assert.equal(puts, 2);
  assert.equal(h.cart().lineItems.filter(l => l.gtin13 === "0000000004011").length, 1);
});

test("get_product: settles after a header capture before calling the site", async () => {
  const h = harness("get_product");
  await h.run({ upc: "0000000004011" });
  assert.ok(h.calls.waits.includes(3000));
});

test("search_products: a non-JSON body maps to site_error", async () => {
  const h = harness("search_products", { nonJson: "egress-proxy error" });
  const result = await h.run({ query: "bananas" });
  assert.equal(result.error_kind, "site_error");
  assert.match(result.error_message, /non-JSON/);
});

// --- search_products ---------------------------------------------------------------------------------

test("search_products: returns priced, deduplicated results in site order with sponsored flags", async () => {
  const h = harness("search_products");
  const result = await h.run({ query: "bananas", limit: 10 });
  assert.equal(result.status, "ok");
  assert.equal(result.total_count, 509);
  assert.equal(result.available_count, 250);
  assert.deepEqual(result.products.map(p => p.upc), ["0000000004011", "0001111041700", "0007000000009"], "placement without a catalog record and the duplicate hit are dropped");
  assert.deepEqual(result.products.map(p => p.rank), [1, 2, 3]);
  assert.deepEqual(result.products.map(p => p.sponsored), [false, false, false]);
  const bananas = result.products[0];
  assert.equal(bananas.price_cents, 103);
  assert.equal(bananas.promo_price_cents, null);
  assert.equal(bananas.unit_price_text, "$0.49/lb");
  assert.equal(bananas.price_note, "about $1.03 each");
  assert.equal(bananas.sold_by_weight, true);
  assert.equal(bananas.max_order_quantity, 3);
  assert.equal(bananas.url, "https://www.kroger.com/p/fresh-bunch-of-bananas/0000000004011");
  const milk = result.products[1];
  assert.equal(milk.promo_price_cents, 249);
  assert.equal(milk.unit_price_text, "$0.02/fl oz");
  assert.equal(result.products[2].available, false);
  assert.equal(result.products[2].inventory_level, "TEMPORARILY_OUT_OF_STOCK");
  const searchCall = h.calls.requests.find(r => r.path.includes("products-search"));
  assert.match(searchCall.path, /filter\.query=bananas/);
  assert.match(searchCall.path, /filter\.fulfillmentMethods=IN_STORE&filter\.fulfillmentMethods=PICKUP&filter\.fulfillmentMethods=DELIVERY/, "same methods as the site's own results page");
  assert.match(searchCall.path, /option\.personalization=PURCHASE_HISTORY/, "same personalization as the site's own results page, so the order matches");
  assert.match(searchCall.path, /option\.groupBy=PRODUCT_VARIANT&option\.quickFacets=true/);
  assert.match(searchCall.path, /filter\.locationId=540FC001/);
  assert.match(searchCall.path, /page\.size=10/);
});

test("search_products: limit caps the returned products", async () => {
  const result = await harness("search_products").run({ query: "bananas", limit: 1 });
  assert.equal(result.products.length, 1);
  assert.equal(result.total_count, 509);
});

test("search_products: a sponsored hit with a catalog record is returned and flagged", async () => {
  const search = fixture("search");
  search.data.productsSearch[0].upc = "0001111041700";
  search.data.productsSearch.splice(2, 1);
  const result = await harness("search_products", { search }).run({ query: "milk" });
  assert.equal(result.products[0].upc, "0001111041700");
  assert.equal(result.products[0].sponsored, true);
});

test("search_products: an empty result list is no_results, never an empty success", async () => {
  const result = await harness("search_products", { search: { data: { productsSearch: [] }, meta: { productsSearch: { totalCount: 0 } } } }).run({ query: "zzqx" });
  assert.deepEqual(Object.keys(result).sort(), ["fulfillment", "query", "status", "total_count"]);
  assert.equal(result.status, "no_results");
  assert.equal(result.total_count, 0);
});

test("search_products: hits without catalog records are no_results", async () => {
  const result = await harness("search_products", { products: { data: { products: [] } } }).run({ query: "bananas" });
  assert.equal(result.status, "no_results");
});

test("search_products: works signed out", async () => {
  const result = await harness("search_products", { loggedIn: false }).run({ query: "bananas" });
  assert.equal(result.status, "ok");
});

// --- get_product -------------------------------------------------------------------------------------

test("get_product: zero-pads shorter codes and returns the catalog record", async () => {
  const result = await harness("get_product").run({ upc: "00000004011" });
  assert.equal(result.status, "ok");
  assert.equal(result.product.upc, "0000000004011");
  assert.equal(result.product.description, "Fresh Bunch of Bananas");
});

test("get_product: a record without a description is not_found", async () => {
  const result = await harness("get_product").run({ upc: "0000000000001" });
  assert.equal(result.error_kind, "not_found");
});

test("get_product: an unknown code is not_found", async () => {
  assert.equal((await harness("get_product").run({ upc: "0009999999999" })).error_kind, "not_found");
});

// --- get_cart ----------------------------------------------------------------------------------------

test("get_cart: separates active lines from saved-for-later lines and prices them", async () => {
  const h = harness("get_cart");
  const result = await h.run({});
  assert.equal(result.status, "ok");
  assert.equal(result.cart_id, "cart-fixture-1");
  assert.equal(result.item_count, 1);
  assert.deepEqual(result.items.map(i => i.upc), ["0001111041700"]);
  assert.equal(result.items[0].line_total_cents, 249, "promotional price is used when present");
  assert.equal(result.subtotal_cents, 249);
  assert.equal(result.saved_for_later[0].upc, "0001299322120");
  assert.equal(result.saved_for_later[0].description, null, "unknown catalog records are reported as null, not invented");
  assert.equal(result.saved_for_later[0].available, false);
});

test("get_cart: accepts an undefined input and an empty object", async () => {
  assert.equal((await harness("get_cart").run()).status, "ok");
  assert.equal((await harness("get_cart").run({})).status, "ok");
});

test("get_cart: subtotal is null when a line has no price", async () => {
  const cart = fixture("cart");
  cart.data.carts[0].lineItems[0].gtin13 = "0009999999999";
  const result = await harness("get_cart", { cart }).run({});
  assert.equal(result.subtotal_cents, null);
  assert.equal(result.items[0].price_cents, null);
});

test("get_cart: requires a signed-in session and checks it before any navigation or capture", async () => {
  const h = harness("get_cart", { loggedIn: false, url: "https://example.com/" });
  const result = await h.run({});
  assert.equal(result.error_kind, "not_authenticated");
  assert.deepEqual(h.calls.requests, []);
  assert.deepEqual(h.calls.navigations, []);
  assert.equal(h.calls.captures, 0);
});

test("get_cart: a failed product lookup degrades the output instead of discarding the cart", async () => {
  const h = harness("get_cart", { responses: path => path.includes("/product/v2/products") ? { status: 429, body: JSON.stringify({ errors: { reason: "rate limited", code: "429" } }) } : null });
  const result = await h.run({});
  assert.equal(result.status, "ok");
  assert.equal(result.product_details, "unavailable");
  assert.match(result.product_details_error, /^challenge: /);
  assert.equal(result.item_count, 1);
  assert.equal(result.items[0].upc, "0001111041700");
  assert.equal(result.items[0].description, null);
  assert.equal(result.subtotal_cents, null);
});

test("get_cart: a complete lookup reports product_details complete", async () => {
  const result = await harness("get_cart").run({});
  assert.equal(result.product_details, "complete");
  assert.equal(result.product_details_error, null);
});

test("get_cart: no active cart is an explicit site_error", async () => {
  const result = await harness("get_cart", { cart: { data: { carts: [] } } }).run({});
  assert.equal(result.error_kind, "site_error");
});

// --- add_to_cart -------------------------------------------------------------------------------------

test("add_to_cart: adds a new line with the site's own request shape and confirms the quantity", async () => {
  const h = harness("add_to_cart");
  const result = await h.run({ upc: "0000000004011", quantity: 2 });
  assert.equal(result.status, "ok");
  assert.equal(result.previous_quantity, 0);
  assert.equal(result.quantity, 2);
  assert.equal(result.unit_price_cents, 103);
  assert.equal(result.cart_item_count, 2);
  assert.equal(result.description, "Fresh Bunch of Bananas");
  const put = h.calls.requests.find(r => r.method === "PUT");
  assert.deepEqual(JSON.parse(put.body), { lineItems: [{ gtin13: "0000000004011", modalityType: "DELIVERY", quantity: 2, channel: "WEB", substitutionPolicy: "SHOPPER_CHOICE" }] });
  assert.equal(put.path, "/atlas/v1/carts/cart-fixture-1");
});

test("add_to_cart: an existing line is incremented by id, not re-added", async () => {
  const h = harness("add_to_cart");
  const result = await h.run({ upc: "0001111041700", quantity: 3 });
  assert.equal(result.previous_quantity, 1);
  assert.equal(result.quantity, 4);
  assert.equal(result.line_item_id, "line-milk");
  assert.equal(result.unit_price_cents, 249);
  const put = h.calls.requests.find(r => r.method === "PUT");
  assert.deepEqual(JSON.parse(put.body), { lineItems: [{ id: "line-milk", gtin13: "0001111041700", modalityType: "DELIVERY", quantity: 4 }] });
});

test("add_to_cart: refuses to exceed the site's per-order limit", async () => {
  const h = harness("add_to_cart");
  await h.run({ upc: "0000000004011", quantity: 2 });
  const result = await h.run({ upc: "0000000004011", quantity: 2 });
  assert.equal(result.error_kind, "quantity_limit");
  assert.equal(h.calls.requests.filter(r => r.method === "PUT").length, 1);
});

for (const [upc, kind] of [["0009999999999", "not_found"], ["0000000000001", "not_found"], ["0007000000009", "unavailable"]]) {
  test(`add_to_cart: ${upc} is refused as ${kind} without a cart write`, async () => {
    const h = harness("add_to_cart");
    const result = await h.run({ upc });
    assert.equal(result.error_kind, kind);
    assert.equal(h.calls.requests.some(r => r.method === "PUT"), false);
  });
}

test("add_to_cart: requires a signed-in session, without navigating or capturing first", async () => {
  const h = harness("add_to_cart", { loggedIn: false, url: "https://example.com/" });
  assert.equal((await h.run({ upc: "0000000004011" })).error_kind, "not_authenticated");
  assert.deepEqual(h.calls.requests, []);
  assert.deepEqual(h.calls.navigations, []);
  assert.equal(h.calls.captures, 0);
});

test("add_to_cart: a write the site silently ignores is reported, not claimed", async () => {
  const h = harness("add_to_cart", { ignoreUpdates: true });
  const result = await h.run({ upc: "0001111041700", quantity: 1 });
  assert.equal(result.error_kind, "site_error");
  assert.match(result.error_message, /does not show 2/);
});

test("add_to_cart: a saved-for-later line does not count as an existing line", async () => {
  const products = fixture("products");
  products.data.products.push({ id: "0001299322120", item: { description: "Sparkling Water 8 pk", images: [] }, price: { storePrices: { regular: { price: "USD 5.49" } } }, fulfillmentSummaries: [{ type: "DELIVERY", regular: { price: "USD 5.49" }, availability: { sellable: true } }] });
  const h = harness("add_to_cart", { products });
  const result = await h.run({ upc: "0001299322120" });
  assert.equal(result.previous_quantity, 0);
  assert.equal(result.quantity, 1);
  assert.equal(h.cart().lineItems.find(l => l.savedForLater).quantity, 2, "the saved line is untouched");
});

// --- update_cart_item --------------------------------------------------------------------------------

test("update_cart_item: sets an absolute quantity by line id", async () => {
  const h = harness("update_cart_item");
  const result = await h.run({ upc: "0001111041700", quantity: 3 });
  assert.equal(result.status, "ok");
  assert.equal(result.previous_quantity, 1);
  assert.equal(result.quantity, 3);
  assert.equal(result.removed, false);
  assert.equal(result.line_item_id, "line-milk");
  const put = h.calls.requests.find(r => r.method === "PUT");
  assert.deepEqual(JSON.parse(put.body), { lineItems: [{ id: "line-milk", gtin13: "0001111041700", modalityType: "DELIVERY", quantity: 3 }] });
});

test("update_cart_item: quantity 0 removes the line", async () => {
  const h = harness("update_cart_item");
  const result = await h.run({ upc: "0001111041700", quantity: 0 });
  assert.equal(result.removed, true);
  assert.equal(result.line_item_id, null);
  assert.equal(result.quantity, 0);
  assert.equal(result.cart_item_count, 0);
  assert.equal(h.cart().lineItems.length, 1, "only the saved-for-later line remains");
});

test("update_cart_item: a product that is not in the cart is not_in_cart, with no write", async () => {
  const h = harness("update_cart_item");
  const result = await h.run({ upc: "0000000004011", quantity: 0 });
  assert.equal(result.error_kind, "not_in_cart");
  assert.equal(h.calls.requests.some(r => r.method === "PUT"), false);
});

test("update_cart_item: never touches saved-for-later lines", async () => {
  const h = harness("update_cart_item");
  const result = await h.run({ upc: "0001299322120", quantity: 0 });
  assert.equal(result.error_kind, "not_in_cart");
  assert.match(result.error_message, /saved for later/);
  assert.equal(h.cart().lineItems.length, 2);
});

test("update_cart_item: refuses a quantity above the site's per-order limit", async () => {
  const cart = fixture("cart");
  cart.data.carts[0].lineItems[0].gtin13 = "0000000004011";
  const h = harness("update_cart_item", { cart });
  const result = await h.run({ upc: "0000000004011", quantity: 4 });
  assert.equal(result.error_kind, "quantity_limit");
  assert.equal(h.calls.requests.some(r => r.method === "PUT"), false);
});

test("update_cart_item: a write the site silently ignores is reported", async () => {
  const result = await harness("update_cart_item", { ignoreUpdates: true }).run({ upc: "0001111041700", quantity: 2 });
  assert.equal(result.error_kind, "site_error");
});

test("update_cart_item: requires a signed-in session", async () => {
  const h = harness("update_cart_item", { loggedIn: false });
  assert.equal((await h.run({ upc: "0001111041700", quantity: 1 })).error_kind, "not_authenticated");
  assert.deepEqual(h.calls.requests, []);
});
