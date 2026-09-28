import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";

// Every tool runs its page-side work through one js(fn, { arg }) call. The harness below
// re-creates that function inside a separate page context (fake fetch, document, location)
// exactly the way the runtime does, so closure capture, Node globals, and parsing bugs
// all surface here.

const tools = Object.fromEntries(["list_stores", "search", "get_item", "get_cart", "add_to_cart", "update_cart_item"].map(name => [
  name, readFileSync(new URL(`../domains/instacart.com/${name}.js`, import.meta.url), "utf8")
]));
const plain = value => JSON.parse(JSON.stringify(value));
const storeUrl = "https://www.instacart.com/store";

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

// ---------------------------------------------------------------- fixtures (fabricated data)

const location = { addressId: "900001", zoneId: "78", postalCode: "45202", coordinates: { latitude: 39.1, longitude: -84.5 } };
const apolloState = { GetLastUserLocation: { "{}": { lastUserLocation: { ...location, countryId: "840" } } } };
const retailer = { id: "58", slug: "kroger", name: "Kroger", categories: ["grocery", "gifts"] };
const shops = [
  { id: "355391", retailerId: "58", retailerLocationId: "165949", serviceType: "delivery", retailer },
  { id: "314333", retailerId: "58", retailerLocationId: "20352", serviceType: "pickup", retailer }
];
const otherShop = { id: "92766", retailerId: "12", retailerLocationId: "20727", serviceType: "delivery", retailer: { id: "12", slug: "aldi", name: "ALDI", categories: ["grocery"] } };
const each = { increment: 1, initial: 1, max: 500, min: 1, quantityType: "each", viewSection: { unitString: "ct" } };
const catalog = {
  "items_165949-1001": { id: "items_165949-1001", name: "Fresh Bananas", size: "1 each", productId: "1001", brandName: null, tags: ["storeBrand"], quantityAttributes: each, availability: { available: true, stockLevel: "highlyInStock" }, price: { viewSection: { itemCard: { priceString: "$2.37 each (est.)", fullPriceString: null, pricePerUnitString: "$0.79 / lb" } } }, viewSection: { itemImage: { url: "https://img.example/1001.jpg" } } },
  "items_165949-1002": { id: "items_165949-1002", name: "Seedless Grapes", size: "1 pkg", productId: "1002", brandName: "Fresh", tags: [], quantityAttributes: each, availability: { available: true, stockLevel: "inStock" }, price: { viewSection: { itemCard: { priceString: "$5.74 /pkg (est.)", fullPriceString: "$6.99", pricePerUnitString: null } } }, viewSection: {} },
  "items_165949-1003": { id: "items_165949-1003", name: "Whole Milk", size: "1 gal", productId: "1003", brandName: "Dairy Co", tags: [], quantityAttributes: each, availability: { available: true, stockLevel: "inStock" }, price: { viewSection: { itemCard: { priceString: "$3.49" } } }, viewSection: {} },
  "items_165949-1004": { id: "items_165949-1004", name: "Deli Turkey", size: "per lb", productId: "1004", brandName: null, tags: [], quantityAttributes: { increment: 0.5, initial: 1, max: 5, min: 0.5, quantityType: "weight", viewSection: { unitString: "lb" } }, availability: { available: true, stockLevel: "inStock" }, price: { viewSection: { itemCard: { priceString: "$9.99 / lb" } } }, viewSection: {} },
  "items_165949-1005": { id: "items_165949-1005", name: "Sold Out Cookies", size: "12 ct", productId: "1005", brandName: null, tags: [], quantityAttributes: each, availability: { available: false, stockLevel: "outOfStock" }, price: { viewSection: { itemCard: { priceString: "$4.00" } } }, viewSection: {} },
  "items_165949-1007": { id: "items_165949-1007", name: "Sparkling Soda Variety Pack", size: "12 fl oz", productId: "1007", brandName: "Fizz", tags: [], quantityAttributes: each, availability: { available: true, stockLevel: "inStock" }, price: { viewSection: { itemCard: { priceString: "$17.99", pricingUnitString: "8 x 12 fl oz", pricePerUnitString: null }, itemDetails: { pricingUnitString: "8 x 12 fl oz", pricePerUnitString: "$2.25 each" } } }, viewSection: {} },
  "items_165949-1008": { id: "items_165949-1008", name: "Sparkling Soda Can", size: "12 fl oz", productId: "1008", brandName: "Fizz", tags: [], quantityAttributes: each, availability: { available: true, stockLevel: "inStock" }, price: { viewSection: { itemCard: { priceString: "$2.99", pricingUnitString: "12 fl oz" } } }, viewSection: {} },
  "items_165949-1009": { id: "items_165949-1009", name: "Loose Apples", size: "per lb", productId: "1009", brandName: null, tags: [], quantityAttributes: each, availability: { available: true, stockLevel: "inStock" }, price: { viewSection: { itemCard: { priceString: "$1.99", pricingUnitString: "$1.99 / lb" } } }, viewSection: {} },
  "items_165949-1006": { id: "items_165949-1006", name: "Limited Sauce", size: "8 oz", productId: "1006", brandName: null, tags: [], quantityAttributes: { ...each, max: 2 }, availability: { available: true, stockLevel: "lowStock" }, price: { viewSection: { itemCard: { priceString: "$1.99" } } }, viewSection: {} }
};
const header = text => ({ content: { __typename: "SearchContentManagementSearchItemGridHeader", viewSection: { titleFormattedAttributesString: { sections: [{ text }] } } } });
const grid = (itemIds, items = []) => ({ content: { __typename: "SearchContentManagementSearchItemGrid", itemGridId: "1", itemIds, items } });
const ad = ids => ({ content: { __typename: "AdsSearchDisplayCreativePlacement", placement: { itemIds: ids, items: ids.map(id => catalog[id]) } } });
const loadMore = { content: { __typename: "SearchContentManagementSearchLoadMore" } };
const searchPlacements = {
  bananas: [header('Results for "bananas"'), grid(["items_165949-1001", "items_165949-1002"], [catalog["items_165949-1001"]]), ad(["items_165949-1006"]), header("Related items"), grid(["items_165949-1003", "items_165949-1001"]), loadMore, grid(["items_165949-1004"])],
  nothing: [header("No results for \"zzz\""), header("Related items"), grid(["items_165949-1003"])]
};

function fixtures(options = {}) {
  const cart = { id: "777", type: "grocery", lines: options.cartLines ? plain(options.cartLines) : [] };
  const state = { cart, requests: [], mutations: 0 };
  const respond = (op, variables) => {
    if (options.respond) { const custom = options.respond(op, variables, state); if (custom) return custom; }
    switch (op) {
      case "SharedCurrentUser": return { data: { currentUser: { id: "1", guest: options.guest === true } } };
      case "ShopCollectionScoped": return { data: { shopCollection: { shops: variables.retailerSlug === "kroger" ? shops : variables.retailerSlug === "aldi" ? [otherShop] : [] } } };
      case "ShopCollectionUnscoped": return { data: { shopCollection: { shops: [...shops, otherShop] } } };
      case "SearchResultsPlacements": return { data: { searchResultsPlacements: { placements: searchPlacements[variables.query] ?? [] } } };
      case "Items": return { data: { items: variables.ids.map(id => options.shopScopedItems && variables.shopId !== "355391" ? null : catalog[id]).filter(Boolean) } };
      case "GetProductRatings": return { data: { productRatings: { productRating: { value: 4.5, amount: 12 } } } };
      case "ActiveCartId": return { data: { shopBasket: { cartId: cart.id, cartType: cart.type } } };
      case "CartData": {
        const lines = variables.id === cart.id ? cart.lines : [{ itemId: "items_5-9", quantity: 1, quantityType: "each" }];
        return { data: { userCart: { id: variables.id, itemCount: lines.length, retailerId: "58", cartItemCollection: { cartItems: lines.map((l, i) => ({ id: `ci${i}`, quantity: l.quantity, quantityType: l.quantityType, basketProduct: { id: l.itemId, productId: l.itemId.split("-")[1] } })) } } } };
      }
      case "CartTotals": return { data: { cartTotals: { viewSection: { retailerTotalString: "$4.74", savingsTotalString: "Saving $0.00" } } } };
      case "PersonalActiveCarts": return { data: { userCarts: { carts: [
        { id: cart.id, itemCount: cart.lines.length, retailer, cartItemCollection: { cartItems: cart.lines.map(l => ({ basketProduct: { id: l.itemId, name: catalog[l.itemId]?.name ?? "Unknown" } })) } },
        { id: "555", itemCount: 1, retailer: { id: "99", slug: "faraway", name: "Faraway Market" }, cartItemCollection: { cartItems: [{ basketProduct: { id: "items_5-9", name: "Old Cart Line" } }] } },
        { id: "556", itemCount: 0, retailer: otherShop.retailer, cartItemCollection: { cartItems: [] } }
      ] } } };
      case "UpdateCartItemsMutation": {
        state.mutations++;
        const update = variables.cartItemUpdates[0];
        if (!catalog[update.itemId]) return { data: { updateCartItems: { __typename: "CartsCartUpdateError", errorType: "notFoundBasketProduct", viewSection: { cartUpdateErrorDescriptionString: "Sorry, we couldn't add this item because it is no longer available." } } } };
        const existing = cart.lines.find(l => l.itemId === update.itemId);
        const updated = [];
        if (update.quantity === 0) { if (existing) { cart.lines = cart.lines.filter(l => l !== existing); updated.push(update.itemId); } }
        else if (existing) { existing.quantity = update.quantity; updated.push(update.itemId); }
        else { cart.lines.push({ itemId: update.itemId, quantity: update.quantity, quantityType: update.quantityType }); updated.push(update.itemId); }
        return { data: { updateCartItems: { __typename: "CartsCartItemUpdateSuccessResponse", cart: { id: cart.id, itemCount: cart.lines.length, cartItemCollection: { cartItems: cart.lines.map(l => ({ quantity: l.quantity, quantityType: l.quantityType, basketProduct: { id: l.itemId } })) } }, updatedItemIds: updated.map(itemId => ({ itemId })) } } };
      }
      default: return { errors: [{ message: "unknown op", extensions: { code: "PERSISTED_QUERY_NOT_SUPPORTED" } }], data: null };
    }
  };
  return { state, respond };
}

function harness(name, options = {}) {
  const fx = fixtures(options);
  let url = options.url ?? `${storeUrl}/kroger/storefront`;
  let bodyText = options.bodyText ?? "Kroger Delivery or Pickup";
  const hasState = options.hasState ?? true;
  const navigations = [];
  const pageContext = {
    URL, URLSearchParams, JSON, Math, Number, String, Array, Object, Map, Set, Promise, RegExp, Error, Boolean, Date, encodeURIComponent, decodeURIComponent, isNaN, parseInt, parseFloat, console,
    crypto: { randomUUID: () => "00000000-0000-4000-8000-000000000000" },
    get location() { const u = new URL(url); return { origin: u.origin, hostname: u.hostname, protocol: u.protocol, href: u.href, pathname: u.pathname }; },
    document: {
      getElementById: id => id === "node-apollo-state" && hasState && options.inlineState !== false ? { textContent: encodeURIComponent(JSON.stringify(apolloState)) } : null,
      body: { get innerText() { return bodyText; } }
    },
    fetch: async (input, init = {}) => {
      const target = typeof input === "string" ? new URL(input, "https://www.instacart.com") : input;
      if (target.pathname === "/store") {
        fx.state.storeFetches = (fx.state.storeFetches ?? 0) + 1;
        if (options.storePage === "login") return { status: 200, url: "https://www.instacart.com/login?next=%2Fstore", text: async () => "<html>Log in</html>" };
        if (options.storePage === "proxy") return { status: 502, url: "https://www.instacart.com/store", text: async () => "<html><body>PROXY proxy error the upstream proxy provider timed out</body></html>" };
        if (options.storePage === "flaky" && fx.state.storeFetches === 1) return { status: 502, url: "https://www.instacart.com/store", text: async () => "<html><body>PROXY proxy error the upstream proxy provider timed out</body></html>" };
        return { status: 200, url: "https://www.instacart.com/store", text: async () => hasState ? `<html><script id="node-apollo-state" type="application/json">${encodeURIComponent(JSON.stringify(apolloState))}</script></html>` : "<html></html>" };
      }
      let op, variables;
      if (init.method === "POST") { const body = JSON.parse(init.body); op = body.operationName; variables = body.variables; }
      else { op = target.searchParams.get("operationName"); variables = JSON.parse(target.searchParams.get("variables")); }
      assert.equal(init.headers["x-client-identifier"], "web");
      fx.state.requests.push({ op, variables, method: init.method ?? "GET" });
      if (options.http?.[op]) return { status: options.http[op], text: async () => "" };
      return { status: 200, text: async () => JSON.stringify(fx.respond(op, variables)) };
    }
  };
  const nodeContext = {
    URL,
    pageInfo: async () => ({ url }),
    gotoUrl: async next => { navigations.push(next); if (options.navigationError) throw new Error("Navigation failed"); url = options.landingUrl ?? next; bodyText = options.landingBody ?? "Instacart - Home"; },
    waitForLoad: async () => true,
    js: async (fn, args) => {
      assert.equal(typeof fn, "function");
      const recreated = runInNewContext(`(${fn.toString()})`, pageContext);
      return recreated(args?.arg);
    }
  };
  const definitions = runInNewContext(`(${tools[name]})`, nodeContext);
  const tool = definitions[0];
  return {
    tool, state: fx.state, navigations,
    run: async input => {
      const result = plain(await tool.execute(input));
      assert.ok(conforms(tool.tool.outputSchema, result), `${name} output violates its schema: ${JSON.stringify(result)}`);
      return result;
    }
  };
}

const ops = h => h.state.requests.map(r => r.op);

// ---------------------------------------------------------------- contract

for (const name of Object.keys(tools)) {
  test(`${name}: single-expression CDP tool with domain patterns, typed schemas and no trailing semicolon`, () => {
    const { tool } = harness(name);
    assert.equal(tool.kind, "cdp");
    assert.equal(tool.tool.name, name);
    assert.deepEqual(plain(tool.match.url_patterns), ["https://instacart.com/*", "https://*.instacart.com/*"]);
    assert.equal(tool.tool.inputSchema.type, "object");
    assert.equal(tool.tool.outputSchema.oneOf.length, 2);
    assert.equal(/;\s*$/.test(tools[name]), false);
    assert.equal(/\b(?:Buffer|require|process)\b/.test(tools[name]), false);
  });
}

test("registry lists every shopping tool with matching patterns", () => {
  const registry = JSON.parse(readFileSync(new URL("../registry.json", import.meta.url), "utf8"));
  for (const name of Object.keys(tools)) {
    const entry = registry.tools.find(t => t.domain === "instacart.com" && t.tool === name);
    assert.ok(entry, name);
    assert.equal(entry.file, `domains/instacart.com/${name}.js`);
    assert.deepEqual(entry.url_patterns, plain(harness(name).tool.match.url_patterns));
  }
});

// ---------------------------------------------------------------- input validation

const invalidInputs = {
  list_stores: [null, [], { query: "" }, { query: 1 }, { service_type: "drone" }, { max_results: 0 }, { max_results: 1.5 }, { extra: true }],
  search: [{}, { store: "kroger" }, { query: "milk" }, { store: "Kroger!", query: "milk" }, { store: "kroger", query: " " }, { store: "kroger", query: "milk", max_results: 61 }, { store: "kroger", query: "milk", include_related: "yes" }, { store: "kroger", query: "milk", allow_reformulation: 1 }, { store: "kroger", query: "milk", service_type: "drone" }, { store: "kroger", query: "milk", extra: 1 }],
  get_item: [{}, { store: "kroger" }, { item_id: "items_165949-1001" }, { store: "kroger", item_id: "1001" }, { store: "kroger", item_id: "items_165949-1001", extra: 1 }],
  get_cart: [null, { store: "" }, { store: "kroger", service_type: "drone" }, { extra: 1 }],
  add_to_cart: [{}, { store: "kroger" }, { store: "kroger", item_id: "bad" }, { store: "kroger", item_id: "items_165949-1001", quantity: 0 }, { store: "kroger", item_id: "items_165949-1001", quantity: -1 }, { store: "kroger", item_id: "items_165949-1001", quantity: 100 }, { store: "kroger", item_id: "items_165949-1001", quantity: "2" }, { store: "kroger", item_id: "items_165949-1001", extra: 1 }],
  update_cart_item: [{}, { store: "kroger", item_id: "items_165949-1001" }, { store: "kroger", item_id: "items_165949-1001", quantity: -1 }, { store: "kroger", item_id: "items_165949-1001", quantity: 100 }, { store: "kroger", item_id: "items_165949-1001", quantity: "0" }, { store: "kroger", quantity: 1 }, { store: "kroger", item_id: "items_165949-1001", quantity: 1, extra: 1 }]
};
for (const [name, inputs] of Object.entries(invalidInputs)) {
  for (const input of inputs) {
    test(`${name}: invalid input ${JSON.stringify(input)} is rejected before any page access`, async () => {
      const h = harness(name, { url: "https://example.com/" });
      if (input && typeof input === "object" && !Array.isArray(input)) assert.equal(conforms(h.tool.tool.inputSchema, input), false);
      const result = await h.run(input);
      assert.equal(result.status, "error");
      assert.equal(result.error_kind, "invalid_input");
      assert.deepEqual(h.navigations, []);
      assert.deepEqual(h.state.requests, []);
      if ("mutation_attempted" in result) assert.equal(result.mutation_attempted, false);
    });
  }
}

// ---------------------------------------------------------------- entry and navigation

for (const url of ["https://example.com/", "about:blank", "http://www.instacart.com/store", "https://www.instacart.com.evil.example/store"]) {
  test(`list_stores: opens the store page from ${url} before reading anything`, async () => {
    const h = harness("list_stores", { url });
    const result = await h.run({});
    assert.equal(result.status, "ok");
    assert.deepEqual(h.navigations, [storeUrl]);
  });
}

test("search: an Instacart tab is reused without navigation", async () => {
  const h = harness("search", { url: "https://www.instacart.com/store/aldi/storefront" });
  assert.equal((await h.run({ store: "kroger", query: "bananas" })).status, "ok");
  assert.deepEqual(h.navigations, []);
});

test("search: a Kernel proxy error page is replaced by the store page first", async () => {
  const h = harness("search", { url: "https://www.instacart.com/login", bodyText: "PROXY proxy error the upstream proxy provider timed out" });
  assert.equal((await h.run({ store: "kroger", query: "bananas" })).status, "ok");
  assert.deepEqual(h.navigations, [storeUrl]);
});

test("get_cart: a persistent proxy error page fails with navigation_failed and no requests", async () => {
  const h = harness("get_cart", { url: "https://example.com/", landingBody: "egress-proxy-mitm encountered an unexpected error" });
  const result = await h.run({ store: "kroger" });
  assert.equal(result.error_kind, "navigation_failed");
  assert.deepEqual(h.state.requests, []);
});

test("add_to_cart: a navigation failure is reported without a mutation", async () => {
  const h = harness("add_to_cart", { url: "https://example.com/", navigationError: true });
  const result = await h.run({ store: "kroger", item_id: "items_165949-1001" });
  assert.equal(result.status, "error");
  assert.equal(result.mutation_attempted, false);
  assert.equal(h.state.mutations, 0);
});

test("list_stores: missing location state is reported as location_unavailable", async () => {
  const h = harness("list_stores", { hasState: false });
  assert.equal((await h.run({})).error_kind, "location_unavailable");
  assert.equal(h.state.storeFetches, 1);
});

test("list_stores: a page without inline state reads the location from the store page, retrying one failed fetch", async () => {
  const h = harness("list_stores", { url: "https://www.instacart.com/help", inlineState: false, storePage: "flaky" });
  const result = await h.run({});
  assert.equal(result.status, "ok");
  assert.equal(h.state.storeFetches, 2);
  const inline = harness("list_stores");
  await inline.run({});
  assert.equal(inline.state.storeFetches, undefined);
});

test("get_item: the store page redirecting to login is not_logged_in", async () => {
  const h = harness("get_item", { hasState: false, storePage: "login" });
  const result = await h.run({ store: "kroger", item_id: "items_165949-1001" });
  assert.equal(result.error_kind, "not_logged_in");
});

test("add_to_cart: a store page that fails to load is unknown with no mutation, after one retry", async () => {
  const h = harness("add_to_cart", { hasState: false, storePage: "proxy" });
  const result = await h.run({ store: "kroger", item_id: "items_165949-1001" });
  assert.equal(result.error_kind, "unknown");
  assert.match(result.error_message, /did not load/);
  assert.equal(result.mutation_attempted, false);
  assert.equal(h.state.storeFetches, 2);
  assert.equal(h.state.mutations, 0);
});

// ---------------------------------------------------------------- list_stores

test("list_stores: lists, filters and caps stores", async () => {
  const h = harness("list_stores");
  const all = await h.run({});
  assert.equal(all.total_stores, 3);
  assert.deepEqual(all.stores.map(s => [s.store_slug, s.shop_id, s.service_type]), [["kroger", "355391", "delivery"], ["kroger", "314333", "pickup"], ["aldi", "92766", "delivery"]]);
  assert.deepEqual(all.location, { postal_code: "45202", zone_id: "78", has_address: true });
  const pickup = await h.run({ service_type: "pickup" });
  assert.deepEqual(pickup.stores.map(s => s.shop_id), ["314333"]);
  const filtered = await h.run({ query: "AL", max_results: 1 });
  assert.equal(filtered.total_stores, 1);
  assert.equal(filtered.stores[0].name, "ALDI");
  assert.deepEqual(h.state.requests[0].variables, { postalCode: "45202", coordinates: location.coordinates, addressId: "900001" });
});

// ---------------------------------------------------------------- package sizes

test("get_item: a multipack reports its unit count and unit size from the site's package line", async () => {
  const pack = (await harness("get_item").run({ store: "kroger", item_id: "items_165949-1007" })).item;
  assert.deepEqual([pack.size, pack.package_string, pack.pack_count, pack.unit_size], ["12 fl oz", "8 x 12 fl oz", 8, "12 fl oz"]);
  const can = (await harness("get_item").run({ store: "kroger", item_id: "items_165949-1008" })).item;
  assert.deepEqual([can.package_string, can.pack_count, can.unit_size], ["12 fl oz", 1, "12 fl oz"]);
});

test("get_item: a price in the package line, or no package line, leaves the pack fields null", async () => {
  for (const id of ["items_165949-1009", "items_165949-1001"]) {
    const item = (await harness("get_item").run({ store: "kroger", item_id: id })).item;
    assert.deepEqual([item.package_string, item.pack_count, item.unit_size], [null, null, null], id);
  }
});

test("get_cart: cart lines carry the pack fields of their item", async () => {
  const h = harness("get_cart", { cartLines: [{ itemId: "items_165949-1007", quantity: 6, quantityType: "each" }] });
  const line = (await h.run({ store: "kroger" })).carts[0].items[0];
  assert.deepEqual([line.name, line.quantity, line.package_string, line.pack_count, line.unit_size], ["Sparkling Soda Variety Pack", 6, "8 x 12 fl oz", 8, "12 fl oz"]);
});

test("add_to_cart: the returned item carries the pack fields", async () => {
  const result = await harness("add_to_cart").run({ store: "kroger", item_id: "items_165949-1007", quantity: 2 });
  assert.equal(result.item.pack_count, 8);
});

// ---------------------------------------------------------------- search

test("search: returns exact matches in order with hydrated details and skips ads", async () => {
  const h = harness("search");
  const result = await h.run({ store: "kroger", query: "bananas" });
  assert.equal(result.status, "ok");
  assert.deepEqual(result.store, { store_slug: "kroger", name: "Kroger", shop_id: "355391", retailer_id: "58", service_type: "delivery", retailer_location_id: "165949" });
  assert.equal(result.exact_match_count, 2);
  assert.equal(result.related_count, 2);
  assert.deepEqual(result.results.map(r => [r.match, r.item.item_id]), [["exact", "items_165949-1001"], ["exact", "items_165949-1002"]]);
  const banana = result.results[0].item;
  assert.equal(banana.price_cents, 237);
  assert.equal(banana.price_per_unit_string, "$0.79 / lb");
  assert.deepEqual(banana.quantity, { type: "each", min: 1, max: 500, increment: 1, unit: "ct" });
  assert.equal(banana.url, "https://www.instacart.com/store/kroger/products/1001");
  assert.equal(result.results[1].item.full_price_string, "$6.99");
  assert.equal(result.search_url, "https://www.instacart.com/store/kroger/s?k=bananas");
  const items = h.state.requests.filter(r => r.op === "Items");
  assert.deepEqual(items.map(r => r.variables.ids), [["items_165949-1002"]]);
  assert.equal(h.state.requests.find(r => r.op === "SearchResultsPlacements").variables.shopId, "355391");
});

test("search: sends the literal query unless allow_reformulation is set, and says which it did", async () => {
  const literal = harness("search");
  const strict = await literal.run({ store: "kroger", query: "bananas" });
  assert.equal(strict.reformulation_allowed, false);
  assert.equal(literal.state.requests.find(r => r.op === "SearchResultsPlacements").variables.disableReformulation, true);
  const loose = harness("search");
  const rewritten = await loose.run({ store: "kroger", query: "bananas", allow_reformulation: true });
  assert.equal(rewritten.reformulation_allowed, true);
  assert.equal(loose.state.requests.find(r => r.op === "SearchResultsPlacements").variables.disableReformulation, false);
});

test("search: include_related appends related items after exact ones up to max_results", async () => {
  const h = harness("search");
  const result = await h.run({ store: "kroger", query: "bananas", include_related: true, max_results: 3 });
  assert.deepEqual(result.results.map(r => [r.match, r.item.item_id]), [["exact", "items_165949-1001"], ["exact", "items_165949-1002"], ["related", "items_165949-1003"]]);
});

test("search: no exact matches falls back to related items and reports zero exact matches", async () => {
  const h = harness("search");
  const result = await h.run({ store: "kroger", query: "nothing" });
  assert.equal(result.exact_match_count, 0);
  assert.deepEqual(result.results.map(r => [r.match, r.item.name]), [["related", "Whole Milk"]]);
});

test("search: an empty placements list is a valid empty result", async () => {
  const h = harness("search");
  const result = await h.run({ store: "kroger", query: "unknown" });
  assert.equal(result.status, "ok");
  assert.deepEqual(result.results, []);
});

test("search: pickup stores use their own shop id", async () => {
  const h = harness("search");
  const result = await h.run({ store: "kroger", query: "bananas", service_type: "pickup" });
  assert.equal(result.store.shop_id, "314333");
});

for (const [store, expected] of [["walmart", /No Instacart store/], ["aldi", /does not offer pickup/]]) {
  test(`search: store_not_found for ${store}`, async () => {
    const h = harness("search");
    const result = await h.run({ store, query: "milk", ...(store === "aldi" ? { service_type: "pickup" } : {}) });
    assert.equal(result.error_kind, "store_not_found");
    assert.match(result.error_message, expected);
  });
}

test("search: a retired persisted query is reported as site_changed", async () => {
  const h = harness("search", { respond: op => op === "SearchResultsPlacements" ? { errors: [{ message: "PersistedQueryNotSupported", extensions: { code: "PERSISTED_QUERY_NOT_SUPPORTED" } }], data: null } : null });
  assert.equal((await h.run({ store: "kroger", query: "bananas" })).error_kind, "site_changed");
});

test("search: HTTP 429 is reported as throttled", async () => {
  const h = harness("search", { http: { SearchResultsPlacements: 429 } });
  assert.equal((await h.run({ store: "kroger", query: "bananas" })).error_kind, "throttled");
});

// ---------------------------------------------------------------- get_item

test("get_item: returns details and rating", async () => {
  const h = harness("get_item");
  const result = await h.run({ store: "kroger", item_id: "items_165949-1004" });
  assert.equal(result.status, "ok");
  assert.equal(result.item.name, "Deli Turkey");
  assert.deepEqual(result.item.quantity, { type: "weight", min: 0.5, max: 5, increment: 0.5, unit: "lb" });
  assert.deepEqual(result.rating, { average: 4.5, count: 12 });
});

test("get_item: unknown ids and ids from another store location are item_not_found", async () => {
  const h = harness("get_item");
  const unknown = await h.run({ store: "kroger", item_id: "items_165949-9999" });
  assert.equal(unknown.error_kind, "item_not_found");
  const foreign = await h.run({ store: "kroger", item_id: "items_165949-1001", service_type: "pickup" });
  assert.equal(foreign.error_kind, "item_not_found");
  assert.match(foreign.error_message, /different store location/);
  assert.equal(h.state.requests.filter(r => r.op === "Items").length, 1);
});

// ---------------------------------------------------------------- get_cart

test("get_cart: reads one store's cart with hydrated lines and totals", async () => {
  const h = harness("get_cart", { cartLines: [{ itemId: "items_165949-1001", quantity: 2, quantityType: "each" }, { itemId: "items_165949-1004", quantity: 1.5, quantityType: "weight" }] });
  const result = await h.run({ store: "kroger" });
  assert.equal(result.scope, "store");
  const cart = result.carts[0];
  assert.equal(cart.cart_id, "777");
  assert.equal(cart.item_count, 2);
  assert.equal(cart.subtotal_string, "$4.74");
  assert.deepEqual(cart.items.map(i => [i.item_id, i.quantity, i.name, i.line_total_cents]), [["items_165949-1001", 2, "Fresh Bananas", 474], ["items_165949-1004", 1.5, "Deli Turkey", null]]);
  assert.deepEqual(ops(h), ["SharedCurrentUser", "ShopCollectionScoped", "ActiveCartId", "CartData", "Items", "CartTotals"]);
});

test("get_cart: without a store summarizes every non-empty cart", async () => {
  const h = harness("get_cart", { cartLines: [{ itemId: "items_165949-1001", quantity: 1, quantityType: "each" }] });
  const result = await h.run({});
  assert.equal(result.scope, "all_stores");
  assert.deepEqual(result.carts.map(c => [c.cart_id, c.store.store_slug, c.item_count, c.items[0].name, c.items[0].price_cents]), [["777", "kroger", 1, "Fresh Bananas", 237], ["555", "faraway", 1, "Old Cart Line", null]]);
});

test("get_cart: a logged-out session is not_logged_in", async () => {
  const h = harness("get_cart", { guest: true });
  assert.equal((await h.run({ store: "kroger" })).error_kind, "not_logged_in");
  assert.deepEqual(ops(h), ["SharedCurrentUser"]);
});

// ---------------------------------------------------------------- add_to_cart

test("add_to_cart: adds a new line with one mutation and reports the confirmed quantity", async () => {
  const h = harness("add_to_cart");
  const result = await h.run({ store: "kroger", item_id: "items_165949-1001" });
  assert.equal(result.status, "ok");
  assert.equal(result.previous_quantity, 0);
  assert.equal(result.quantity, 1);
  assert.equal(result.quantity_type, "each");
  assert.equal(result.cart_item_count, 1);
  assert.equal(result.item.name, "Fresh Bananas");
  assert.equal(h.state.mutations, 1);
  const mutation = h.state.requests.find(r => r.op === "UpdateCartItemsMutation");
  assert.equal(mutation.method, "POST");
  assert.deepEqual(mutation.variables.cartItemUpdates, [{ itemId: "items_165949-1001", quantity: 1, quantityType: "each" }]);
  assert.equal(mutation.variables.cartId, "777");
  assert.equal(mutation.variables.cartType, "grocery");
});

test("add_to_cart: increases an existing line by the requested amount", async () => {
  const h = harness("add_to_cart", { cartLines: [{ itemId: "items_165949-1001", quantity: 1, quantityType: "each" }] });
  const result = await h.run({ store: "kroger", item_id: "items_165949-1001", quantity: 2 });
  assert.equal(result.previous_quantity, 1);
  assert.equal(result.quantity, 3);
  assert.deepEqual(h.state.cart.lines, [{ itemId: "items_165949-1001", quantity: 3, quantityType: "each" }]);
});

test("add_to_cart: weighed items use the weight quantity type and its increment", async () => {
  const h = harness("add_to_cart");
  const result = await h.run({ store: "kroger", item_id: "items_165949-1004", quantity: 1.5 });
  assert.equal(result.quantity_type, "weight");
  assert.equal(result.quantity, 1.5);
});

for (const scenario of [
  { name: "unknown item", input: { store: "kroger", item_id: "items_165949-9999" }, kind: "item_not_found" },
  { name: "item from another store location", input: { store: "kroger", item_id: "items_165949-1001", service_type: "pickup" }, kind: "item_not_found" },
  { name: "unavailable item", input: { store: "kroger", item_id: "items_165949-1005" }, kind: "item_unavailable" },
  { name: "fractional quantity of a per-each item", input: { store: "kroger", item_id: "items_165949-1001", quantity: 1.5 }, kind: "invalid_input" },
  { name: "quantity below the minimum", input: { store: "kroger", item_id: "items_165949-1004", quantity: 0.25 }, kind: "invalid_input" },
  { name: "quantity above the maximum", input: { store: "kroger", item_id: "items_165949-1006", quantity: 3 }, kind: "invalid_input" },
  { name: "unknown store", input: { store: "walmart", item_id: "items_165949-1001" }, kind: "store_not_found" },
  { name: "logged out", input: { store: "kroger", item_id: "items_165949-1001" }, kind: "not_logged_in", options: { guest: true } }
]) {
  test(`add_to_cart: ${scenario.name} fails before any mutation`, async () => {
    const h = harness("add_to_cart", scenario.options);
    const result = await h.run(scenario.input);
    assert.equal(result.error_kind, scenario.kind, result.error_message);
    assert.equal(result.mutation_attempted, false);
    assert.equal(h.state.mutations, 0);
  });
}

test("add_to_cart: exceeding the maximum together with the existing line is rejected", async () => {
  const h = harness("add_to_cart", { cartLines: [{ itemId: "items_165949-1006", quantity: 2, quantityType: "each" }] });
  const result = await h.run({ store: "kroger", item_id: "items_165949-1006", quantity: 1 });
  assert.equal(result.error_kind, "invalid_input");
  assert.equal(h.state.mutations, 0);
});

test("add_to_cart: a site rejection is cart_update_rejected with the site's text", async () => {
  const h = harness("add_to_cart", { respond: (op) => op === "UpdateCartItemsMutation" ? { data: { updateCartItems: { __typename: "CartsCartUpdateError", errorType: "itemQuantityLimit", viewSection: { cartUpdateErrorDescriptionString: "You can only add 2 of this item." } } } } : null });
  const result = await h.run({ store: "kroger", item_id: "items_165949-1001" });
  assert.equal(result.error_kind, "cart_update_rejected");
  assert.equal(result.error_message, "You can only add 2 of this item.");
  assert.equal(result.site_error_type, "itemQuantityLimit");
  assert.equal(result.mutation_attempted, true);
});

test("add_to_cart: a mutation whose response lacks the item is unknown, not success", async () => {
  const h = harness("add_to_cart", { respond: (op) => op === "UpdateCartItemsMutation" ? { data: { updateCartItems: { __typename: "CartsCartItemUpdateSuccessResponse", cart: { itemCount: 0, cartItemCollection: { cartItems: [] } }, updatedItemIds: [] } } } : null });
  const result = await h.run({ store: "kroger", item_id: "items_165949-1001" });
  assert.equal(result.error_kind, "unknown");
  assert.equal(result.mutation_attempted, true);
  assert.equal(h.state.requests.filter(r => r.op === "UpdateCartItemsMutation").length, 1);
});

// ---------------------------------------------------------------- update_cart_item

test("update_cart_item: sets an exact quantity", async () => {
  const h = harness("update_cart_item", { cartLines: [{ itemId: "items_165949-1001", quantity: 3, quantityType: "each" }] });
  const result = await h.run({ store: "kroger", item_id: "items_165949-1001", quantity: 2 });
  assert.equal(result.status, "ok");
  assert.equal(result.previous_quantity, 3);
  assert.equal(result.quantity, 2);
  assert.equal(result.removed, false);
  assert.equal(result.name, "Fresh Bananas");
  assert.equal(h.state.mutations, 1);
});

test("update_cart_item: quantity 0 removes the line", async () => {
  const h = harness("update_cart_item", { cartLines: [{ itemId: "items_165949-1001", quantity: 2, quantityType: "each" }] });
  const result = await h.run({ store: "kroger", item_id: "items_165949-1001", quantity: 0 });
  assert.equal(result.removed, true);
  assert.equal(result.quantity, 0);
  assert.equal(result.cart_item_count, 0);
  assert.deepEqual(h.state.cart.lines, []);
});

test("update_cart_item: an unavailable line can still be removed but not increased", async () => {
  const h = harness("update_cart_item", { cartLines: [{ itemId: "items_165949-1005", quantity: 1, quantityType: "each" }] });
  const increase = await h.run({ store: "kroger", item_id: "items_165949-1005", quantity: 2 });
  assert.equal(increase.error_kind, "item_unavailable");
  assert.equal(h.state.mutations, 0);
  const removal = await h.run({ store: "kroger", item_id: "items_165949-1005", quantity: 0 });
  assert.equal(removal.removed, true);
});

for (const scenario of [
  { name: "item not in cart", input: { store: "kroger", item_id: "items_165949-1001", quantity: 0 }, kind: "not_in_cart" },
  { name: "fractional quantity", input: { store: "kroger", item_id: "items_165949-1001", quantity: 2.5 }, kind: "invalid_input", lines: [{ itemId: "items_165949-1001", quantity: 1, quantityType: "each" }] },
  { name: "quantity above maximum", input: { store: "kroger", item_id: "items_165949-1006", quantity: 3 }, kind: "invalid_input", lines: [{ itemId: "items_165949-1006", quantity: 1, quantityType: "each" }] },
  { name: "logged out", input: { store: "kroger", item_id: "items_165949-1001", quantity: 0 }, kind: "not_logged_in", options: { guest: true } }
]) {
  test(`update_cart_item: ${scenario.name} fails before any mutation`, async () => {
    const h = harness("update_cart_item", { ...scenario.options, cartLines: scenario.lines });
    const result = await h.run(scenario.input);
    assert.equal(result.error_kind, scenario.kind, result.error_message);
    assert.equal(result.mutation_attempted, false);
    assert.equal(h.state.mutations, 0);
  });
}

test("update_cart_item: a removal the site did not apply is reported as unknown", async () => {
  const h = harness("update_cart_item", { cartLines: [{ itemId: "items_165949-1001", quantity: 1, quantityType: "each" }], respond: (op, variables, state) => op === "UpdateCartItemsMutation" ? { data: { updateCartItems: { __typename: "CartsCartItemUpdateSuccessResponse", cart: { itemCount: 1, cartItemCollection: { cartItems: [{ quantity: 1, basketProduct: { id: "items_165949-1001" } }] } }, updatedItemIds: [] } } } : null });
  const result = await h.run({ store: "kroger", item_id: "items_165949-1001", quantity: 0 });
  assert.equal(result.error_kind, "unknown");
  assert.equal(result.mutation_attempted, true);
});
