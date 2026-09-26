import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";

// Shared harness for the target.com page tools. The page (window, document, location, fetch) is
// stubbed; nothing here contacts the live site, and the store, products and cart are fabricated.
const NAMES = ["get_store_context", "search_products", "get_product", "get_cart", "add_to_cart", "update_cart_item", "remove_cart_item"];
const sources = Object.fromEntries(NAMES.map(name => [name, readFileSync(new URL(`../domains/target.com/${name}.js`, import.meta.url), "utf8")]));
const plain = value => JSON.parse(JSON.stringify(value));
const HOME = "https://www.target.com/";
const TOKEN = "hdr." + Buffer.from(JSON.stringify({ sut: "G", sub: "fabricated" })).toString("base64url") + ".sig";

function conforms(schema, value) {
  if (schema.anyOf && !schema.anyOf.some(s => conforms(s, value))) return false;
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
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) return false;
    if (schema.maxItems !== undefined && value.length > schema.maxItems) return false;
    if (schema.uniqueItems && new Set(value.map(v => JSON.stringify(v))).size !== value.length) return false;
    if (schema.items && !value.every(item => conforms(schema.items, item))) return false;
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    if (schema.required?.some(key => !Object.hasOwn(value, key))) return false;
    if (schema.maxProperties !== undefined && Object.keys(value).length > schema.maxProperties) return false;
    const props = schema.properties || {};
    if (Object.entries(props).some(([key, s]) => key in value && !conforms(s, value[key]))) return false;
    const extra = Object.keys(value).filter(key => !(key in props));
    if (schema.additionalProperties === false && extra.length) return false;
    if (typeof schema.additionalProperties === "object" && extra.some(key => !conforms(schema.additionalProperties, value[key]))) return false;
  }
  if (typeof value === "string") {
    if (value.length < (schema.minLength ?? 0) || value.length > (schema.maxLength ?? Infinity)) return false;
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) return false;
  }
  if (typeof value === "number" && (value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity))) return false;
  return true;
}

// --- fabricated site data ------------------------------------------------------------------------

const hit = (tcin, title, price, extra = {}) => ({
  tcin, item: {
    product_description: { title }, primary_brand: { name: "Testbrand" }, fulfillment: { is_marketplace: false },
    enrichment: { buy_url: `https://www.target.com/p/test/-/A-${tcin}`, image_info: { primary_image: { url: `https://images.example.invalid/${tcin}` } } }
  },
  price: { formatted_current_price: `$${price}`, formatted_current_price_type: "reg", current_retail: Number(price), reg_retail: Number(price) },
  ratings_and_reviews: { statistics: { rating: { average: 4.5, count: 120 } } }, ...extra
});
const searchBody = () => ({
  data: {
    search: {
      search_response: {
        metadata: { total_results: 57, total_pages: 3 },
        facet_list: [
          { display_name: "Bed Size", options: [{ id: "abc12", display_name: "Standard/Queen" }, { id: "abc13", display_name: "Twin" }] },
          { display_name: "Price", options: [{ id: "pr001", display_name: "$5 &nbsp;&ndash;&nbsp; $10" }] }
        ]
      },
      products: [
        hit("10000001", "Sponsored Test Bottle", "19.99", { is_sponsored_sku: true }),
        hit("10000002", "Kids&#39; Test Bottle &amp; Lid", "9.99", { parent: { tcin: "10000090" }, variation_summary: { themes: [{ name: "color" }] } }),
        { tcin: "10000003", item: { product_description: { title: "Range Priced Test Bottle" } }, price: { formatted_current_price: "$12.00 - $20.00", formatted_current_price_type: "sale" } },
        { tcin: "not-a-number", item: {} }
      ]
    }
  }
});
const familyBody = () => ({
  data: {
    product: {
      tcin: "20000000", ratings_and_reviews: { statistics: { rating: { average: 4.2, count: 33 } } },
      item: {
        product_description: { title: "Test Sheet Set", soft_bullets: { bullets: ["<b>Soft</b> fabricated fabric", "Machine washable"] } },
        primary_brand: { name: "Testbrand" }, fulfillment: { purchase_limit: 5 }, enrichment: { buy_url: "https://www.target.com/p/test/-/A-20000000" }
      },
      price: { formatted_current_price: "$9.00 - $18.00", current_retail_min: 9, reg_retail_max: 20 },
      variation_hierarchy: [
        { name: "Size", value: "Queen", variation_hierarchy: [
          { name: "Color", value: "Gray", tcin: "20000001", buy_url: "https://www.target.com/p/test/-/A-20000001", availability: { is_shipping_available: true } },
          { name: "Color", value: "White", tcin: "20000002", availability: { is_sold_out: true, is_shipping_available: true } }
        ] },
        { name: "Size", value: "Twin", variation_hierarchy: [{ name: "Color", value: "Light Gray", tcin: "20000003", availability: { is_primary_store_available: true } }] }
      ],
      children: [
        { tcin: "20000001", item: { product_description: { title: "Queen Test Sheet Set Gray" }, fulfillment: { purchase_limit: 3 } }, price: { current_retail: 18, reg_retail: 20, formatted_current_price: "$18.00", formatted_current_price_type: "sale" } },
        { tcin: "20000002", item: { product_description: { title: "Queen Test Sheet Set White" } }, price: { current_retail: 18, formatted_current_price: "$18.00" } },
        { tcin: "20000003", item: { product_description: { title: "Twin Test Sheet Set Light Gray" } }, price: { current_retail: 9, formatted_current_price: "$9.00" } }
      ]
    }
  }
});
const singleBody = tcin => ({ data: { product: { tcin, item: { product_description: { title: "Plain Test Mug" }, fulfillment: { purchase_limit: 10 } }, price: { current_retail: 4.99, formatted_current_price: "$4.99" } } } });
const fulfillmentBody = (options = {}) => ({
  data: {
    product: {
      tcin: "x", store_positions: [{ aisle: 12, block: "B" }],
      fulfillment: {
        sold_out: false,
        shipping_options: { availability_status: options.ship ?? "IN_STOCK", services: [{ is_base_shipping_method: true, min_delivery_date: "2030-01-02", max_delivery_date: "2030-01-03" }] },
        store_options: [{ location_id: "1234", order_pickup: { availability_status: options.pickup ?? "OUT_OF_STOCK" }, in_store_only: { availability_status: "LIMITED_STOCK" } }],
        scheduled_delivery: { availability_status: "UNAVAILABLE" }
      }
    }
  }
});
const cartLine = (id, tcin, quantity, type = "SHIP", location = null) => ({
  cart_item_id: id, tcin, quantity, current_price: 18, list_price: 20,
  fulfillment: type === "SHIP" ? { type, ship_method: "STANDARD" } : { type, ship_method: "STORE_PICKUP", location_id: location, location_name: "Test Store" },
  inventory_info: { availability_status: "IN_STOCK" }, item_attributes: { description: `Fabricated item ${tcin}`, max_purchase_quantity: 5 }
});

const BLOCK_PAGE = "<html><head><title>Access to this page has been denied</title></head><body>px-captcha</body></html>";

function harness(name, options = {}) {
  let cart = options.cart === undefined ? { cart_id: "cart-0001", cart_items: [cartLine("line-existing", "30000001", 1)], summary: { total_product_amount: 18, grand_total: 21.5 } } : options.cart;
  const cookie = options.cookie ?? [
    "visitorId=FABRICATEDVISITOR", "fiatsCookie=DSI_1234|DSN_Test%20Store|DSZ_45000", "GuestLocation=45000|39.100|-84.500|OH|US", `idToken=${TOKEN}`
  ].join("; ");
  const calls = { requests: [], writes: [] };
  let next = 1;
  const respond = (status, json) => ({ status, text: json === undefined ? "" : JSON.stringify(json) });
  const route = (href, method, body) => {
    const u = new URL(href);
    calls.requests.push({ href, method, body: body === undefined ? undefined : JSON.parse(body) });
    if (method !== "GET") calls.writes.push({ path: u.pathname, method, body: body === undefined ? undefined : JSON.parse(body) });
    if (options.responses) {
      const forced = options.responses(u, method, body);
      if (forced) return { status: forced.status, text: forced.challenge ? BLOCK_PAGE : forced.json == null ? "" : JSON.stringify(forced.json) };
    }
    assert.equal(u.searchParams.get("key"), "fabricated-key");
    if (u.pathname.endsWith("/plp_search_v2")) return respond(200, options.search ?? searchBody());
    if (u.pathname.endsWith("/pdp_client_v1")) {
      const t = u.searchParams.get("tcin");
      if (t.startsWith("2")) return respond(200, familyBody());
      if (t.startsWith("3") || t.startsWith("4")) return respond(200, singleBody(t));
      return respond(404, { errors: [{ message: "No product found with tcin " + t }] });
    }
    if (u.pathname.endsWith("/product_fulfillment_v1")) return respond(200, fulfillmentBody(options.fulfillment?.(u.searchParams.get("tcin"))));
    if (u.pathname === "/web_checkouts/v1/cart" && method === "GET") return cart === null ? respond(204) : respond(200, cart);
    if (u.pathname === "/web_checkouts/v1/cart_items" && method === "POST") {
      const payload = JSON.parse(body);
      if (cart === null) cart = { cart_id: "cart-new", cart_items: [], summary: {} };
      const type = payload.fulfillment ? payload.fulfillment.type : "SHIP";
      const location = payload.fulfillment ? String(payload.fulfillment.location_id) : null;
      const existing = cart.cart_items.find(l => l.tcin === payload.cart_item.tcin && l.fulfillment.type === type);
      if (existing && !options.ignoreWrites) existing.quantity += payload.cart_item.quantity;
      else if (!options.ignoreWrites) cart.cart_items.push(cartLine(`line-new-${next++}`, payload.cart_item.tcin, payload.cart_item.quantity, type, location));
      return respond(201, cart);
    }
    const item = /^\/web_checkouts\/v1\/cart_items\/([^/]+)$/.exec(u.pathname);
    if (item && method === "PUT") {
      const line = cart.cart_items.find(l => l.cart_item_id === decodeURIComponent(item[1]));
      if (line && !options.ignoreWrites) line.quantity = JSON.parse(body).quantity;
      return respond(200, cart);
    }
    if (item && method === "DELETE") {
      if (!options.ignoreWrites) cart.cart_items = cart.cart_items.filter(l => l.cart_item_id !== decodeURIComponent(item[1]));
      return respond(200, { cart_id: cart.cart_id, summary: {}, ...(cart.cart_items.length ? { cart_items: cart.cart_items } : {}) });
    }
    return respond(404, { message: "no route" });
  };
  const page = new URL(options.url ?? HOME);
  const context = {
    URL, JSON, Object, Array, String, Number, Math, Set,
    atob: value => Buffer.from(value, "base64").toString("binary"),
    location: { origin: page.origin, pathname: page.pathname, href: page.href },
    document: { title: options.blockedPage ? "Access to this page has been denied" : "Target", cookie, querySelector: selector => (options.captcha && selector.includes("px-captcha") ? {} : null) },
    window: { __CONFIG__: options.noKey ? {} : { defaultServicesApiKey: "fabricated-key" }, __TGT_DATA__: { serverLocationVariables: { store_ids: options.storeIds === undefined ? "1234,5678,abc" : options.storeIds } } },
    fetch: async (url, init = {}) => {
      assert.equal(init.credentials, "include");
      assert.ok(/^https:\/\/(redsky|carts)\.target\.com\//.test(url), "page tools may only call the site's own APIs: " + url);
      const { status, text } = route(url, init.method || "GET", init.body);
      return { status, text: async () => text };
    }
  };
  const [definition] = runInNewContext(`(${sources[name]})`, context);
  // The page runtime re-creates execute from its source text inside the page, so run that copy.
  const execute = runInNewContext(`(${definition.execute.toString()})`, context);
  return {
    definition, calls, cart: () => cart,
    run: async input => {
      const result = plain(await execute(input, { signal: new AbortController().signal }));
      assert.ok(conforms(definition.tool.outputSchema, result), `${name} output violates its schema: ${JSON.stringify(result)}`);
      assert.equal(JSON.stringify(result).includes(TOKEN), false, "the session token must never be returned");
      return result;
    }
  };
}

const registry = JSON.parse(readFileSync(new URL("../registry.json", import.meta.url), "utf8"));

for (const name of NAMES) {
  test(`${name}: single-expression page tool with typed schemas and a registry entry`, () => {
    assert.equal(sources[name].trimEnd().endsWith(";"), false);
    assert.equal(/\b(Buffer|require|process)\b/.test(sources[name]), false, "tool source must not depend on Node globals");
    assert.equal(/\/checkout["'`]|place order/i.test(sources[name]), false, "tool source must never reference checkout pages");
    assert.equal(/\b(gotoUrl|pageInfo|waitForLoad|waitMs|waitForEvent|cdp|js)\(/.test(sources[name]), false, "a page tool has no browser helpers");
    const { definition } = harness(name);
    assert.equal(definition.kind, "page");
    assert.equal(definition.tool.name, name);
    assert.deepEqual(plain(definition.match.url_patterns), ["https://target.com/*", "https://*.target.com/*"]);
    assert.equal(definition.tool.inputSchema.type, "object");
    assert.equal(definition.tool.inputSchema.additionalProperties, false);
    assert.equal(definition.tool.outputSchema.type, "object");
    assert.equal(definition.tool.annotations.readOnlyHint, ["get_store_context", "search_products", "get_product", "get_cart"].includes(name));
    const entry = registry.tools.find(t => t.domain === "target.com" && t.tool === name);
    assert.ok(entry, "registry entry missing");
    assert.equal(entry.file, `domains/target.com/${name}.js`);
    assert.deepEqual(entry.url_patterns, plain(definition.match.url_patterns));
  });
}

test("registry lists every target.com tool exactly once", () => {
  assert.deepEqual(registry.tools.filter(t => t.domain === "target.com").map(t => t.tool).sort(), [...NAMES].sort());
});

// --- input validation happens before any page access -----------------------------------------------

const invalidInputs = {
  get_store_context: [null, [], { extra: true }],
  search_products: [undefined, null, {}, { query: "" }, { query: "   " }, { query: 7 }, { query: "x".repeat(201) }, { query: "mug", sort_by: "rating" }, { query: "mug", sort_by: "RatingHigh" },
    { query: "mug", page: 0 }, { query: "mug", page: 21 }, { query: "mug", limit: 25 }, { query: "mug", limit: 1.5 }, { query: "mug", exclude_sponsored: "yes" },
    { query: "mug", facet_ids: "abc12" }, { query: "mug", facet_ids: ["AB"] }, { query: "mug", facet_ids: ["abc12", "abc12"] }, { query: "mug", facet_ids: Array.from({ length: 9 }, (_, i) => "abc1" + i) },
    { query: "mug", include_facets: 1 }, { query: "mug", extra: 1 }],
  get_product: [undefined, {}, { tcin: "" }, { tcin: 12345678 }, { tcin: "1234" }, { tcin: "1234567890123" }, { tcin: "12a45678" }, { tcin: "12345678", extra: 1 },
    { tcin: "12345678", variant_filter: [] }, { tcin: "12345678", variant_filter: { Size: "" } }, { tcin: "12345678", variant_filter: { Size: 3 } }, { tcin: "12345678", variant_filter: { a: "1", b: "2", c: "3", d: "4", e: "5" } }],
  get_cart: [null, [], { extra: true }],
  add_to_cart: [undefined, {}, { tcin: "abc" }, { tcin: "12345678", quantity: 0 }, { tcin: "12345678", quantity: 11 }, { tcin: "12345678", quantity: "2" },
    { tcin: "12345678", fulfillment: "delivery" }, { tcin: "12345678", extra: 1 }],
  update_cart_item: [undefined, {}, { cart_item_id: "line-existing" }, { quantity: 1 }, { cart_item_id: "line-existing", quantity: 0 }, { cart_item_id: "line-existing", quantity: 11 },
    { cart_item_id: "line-existing", quantity: 1.5 }, { cart_item_id: "bad id!", quantity: 1 }, { cart_item_id: "line-existing", quantity: 1, extra: 1 }],
  remove_cart_item: [undefined, {}, { cart_item_id: "" }, { cart_item_id: "short" }, { cart_item_id: "../../cart" }, { cart_item_id: "line-existing", extra: 1 }]
};
for (const [name, inputs] of Object.entries(invalidInputs)) {
  for (const input of inputs) {
    test(`${name}: rejects ${JSON.stringify(input)?.slice(0, 80)} before touching the page`, async () => {
      const h = harness(name);
      const result = await h.run(input);
      assert.equal(result.status, "error");
      assert.equal(result.error_kind, "invalid_input");
      assert.deepEqual(h.calls.requests, []);
    });
  }
}

// --- session: the page the tool runs in, challenge and store context ---------------------------------

for (const url of ["https://example.com/", "https://target.com/", "https://gsp.target.com/x", "https://www.target.com/checkout", "https://www.target.com/checkout/review", "https://www.target.com/co-review", "https://www.target.com/co-login"]) {
  for (const name of NAMES) {
    test(`${name}: refuses to run on ${url} without calling the site`, async () => {
      const h = harness(name, { url });
      const input = { search_products: { query: "mug" }, get_product: { tcin: "30000001" }, add_to_cart: { tcin: "30000001" }, update_cart_item: { cart_item_id: "line-existing", quantity: 2 }, remove_cart_item: { cart_item_id: "line-existing" } }[name] ?? {};
      const result = await h.run(input);
      assert.equal(result.error_kind, "wrong_page");
      assert.deepEqual(h.calls.requests, []);
    });
  }
}

for (const url of ["https://www.target.com/s?searchTerm=mug", "https://www.target.com/p/test/-/A-30000001", "https://www.target.com/cart", "https://www.target.com/account", "https://www.target.com/checkouts-guide"]) {
  test(`get_cart runs on ${url}`, async () => {
    assert.equal((await harness("get_cart", { url }).run({})).status, "ok");
  });
}

for (const name of NAMES) {
  for (const flag of ["blockedPage", "captcha"]) {
    test(`${name}: a bot-protection page (${flag}) is a challenge error with no request`, async () => {
      const h = harness(name, { [flag]: true });
      const input = { search_products: { query: "mug" }, get_product: { tcin: "30000001" }, add_to_cart: { tcin: "30000001" }, update_cart_item: { cart_item_id: "line-existing", quantity: 2 }, remove_cart_item: { cart_item_id: "line-existing" } }[name] ?? {};
      const result = await h.run(input);
      assert.equal(result.error_kind, "challenge");
      assert.deepEqual(h.calls.requests, []);
    });
  }
}

test("a page without the site's API configuration is a site_error", async () => {
  const h = harness("search_products", { noKey: true });
  assert.equal((await h.run({ query: "mug" })).error_kind, "site_error");
  assert.deepEqual(h.calls.requests, []);
});

test("get_store_context reports the store, location and session type without calling the site", async () => {
  const h = harness("get_store_context");
  assert.deepEqual(await h.run({}), {
    status: "ok", session_type: "guest", store: { store_id: "1234", name: "Test Store", postal_code: "45000" },
    location: { postal_code: "45000", latitude: "39.100", longitude: "-84.500", state: "OH" }, nearby_store_ids: ["1234", "5678"]
  });
  assert.deepEqual(h.calls.requests, []);
  assert.deepEqual(await harness("get_store_context").run(undefined), await harness("get_store_context").run({}));
});

test("get_store_context: no store selected and no token", async () => {
  const result = await harness("get_store_context", { cookie: "visitorId=V" }).run({});
  assert.equal(result.store, null);
  assert.equal(result.session_type, "unknown");
  assert.deepEqual(result.nearby_store_ids, []);
});

test("nearby store ids fall back to the selected store when the page lists another store first", async () => {
  assert.deepEqual((await harness("get_store_context", { storeIds: "9999,1234" }).run({})).nearby_store_ids, ["1234"]);
});

test("store-dependent tools refuse without a selected store; cart tools do not need one", async () => {
  const cookie = "visitorId=V; other=1";
  assert.equal((await harness("search_products", { cookie }).run({ query: "mug" })).error_kind, "no_store");
  assert.equal((await harness("get_product", { cookie }).run({ tcin: "30000001" })).error_kind, "no_store");
  const add = harness("add_to_cart", { cookie });
  assert.equal((await add.run({ tcin: "30000001" })).error_kind, "no_store");
  assert.deepEqual(add.calls.writes, []);
  assert.equal((await harness("get_cart", { cookie }).run({})).status, "ok");
});

test("a session without a visitor id is a site_error", async () => {
  assert.equal((await harness("get_cart", { cookie: "" }).run({})).error_kind, "site_error");
});

// --- search_products --------------------------------------------------------------------------------

test("search_products maps sort names to the site's values and sends the store context", async () => {
  const sorts = { relevance: "relevance", featured: "Featured", price_low_to_high: "PriceLow", price_high_to_low: "PriceHigh", highest_rated: "RatingHigh", bestselling: "bestselling", newest: "newest" };
  for (const [name, value] of Object.entries(sorts)) {
    const h = harness("search_products");
    assert.equal((await h.run({ query: "  water   bottle ", sort_by: name })).sort_by, name);
    const q = new URL(h.calls.requests[0].href).searchParams;
    assert.equal(q.get("sort_by"), value);
    assert.equal(q.get("keyword"), "water bottle");
    assert.equal(q.get("pricing_store_id"), "1234");
    assert.equal(q.get("store_ids"), "1234,5678");
    assert.equal(q.get("zip"), "45000");
    assert.equal(q.get("visitor_id"), "FABRICATEDVISITOR");
    assert.equal(q.get("offset"), "0");
    assert.equal(q.has("faceted_value"), false);
  }
});

test("search_products returns ranked products with sponsored flags, decoded titles and cents", async () => {
  const result = await harness("search_products").run({ query: "bottle" });
  assert.equal(result.total_results, 57);
  assert.equal(result.facets, null);
  assert.deepEqual(result.products.map(p => [p.rank, p.site_position, p.tcin, p.sponsored]), [[1, 1, "10000001", true], [2, 2, "10000002", false], [3, 3, "10000003", false]]);
  const kids = result.products[1];
  assert.equal(kids.title, "Kids' Test Bottle & Lid");
  assert.equal(kids.parent_tcin, "10000090");
  assert.deepEqual(kids.variation_themes, ["color"]);
  assert.equal(kids.price_cents, 999);
  assert.equal(kids.rating_count, 120);
  const range = result.products[2];
  assert.deepEqual([range.price_cents, range.price_text, range.price_type, range.rating_average, range.brand], [1200, "$12.00 - $20.00", "sale", null, null]);
});

test("search_products can drop sponsored placements and honours limit and page", async () => {
  const h = harness("search_products");
  const result = await h.run({ query: "bottle", exclude_sponsored: true, limit: 1, page: 3 });
  assert.deepEqual(result.products.map(p => [p.rank, p.site_position, p.tcin]), [[1, 50, "10000002"]]);
  assert.equal(new URL(h.calls.requests[0].href).searchParams.get("offset"), "48");
});

test("search_products applies facet ids the way the site does and can list facets", async () => {
  const h = harness("search_products");
  const result = await h.run({ query: "sheets", facet_ids: ["abc12", "5y759"], include_facets: true });
  assert.equal(new URL(h.calls.requests[0].href).searchParams.get("faceted_value"), "abc12Z5y759");
  assert.deepEqual(result.facet_ids, ["abc12", "5y759"]);
  assert.deepEqual(result.facets, [
    { name: "Bed Size", options: [{ id: "abc12", name: "Standard/Queen" }, { id: "abc13", name: "Twin" }] },
    { name: "Price", options: [{ id: "pr001", name: "$5 – $10" }] }
  ]);
});

test("search_products: no matches, 404 and a rejected facet", async () => {
  const empty = await harness("search_products", { search: { data: { search: { search_response: { metadata: { total_results: 0 } }, products: [] } } } }).run({ query: "zzzz" });
  assert.deepEqual([empty.status, empty.total_results], ["no_results", 0]);
  const missing = await harness("search_products", { responses: () => ({ status: 404, json: { errors: [{ message: "none" }] } }) }).run({ query: "zzzz" });
  assert.equal(missing.status, "no_results");
  const facet = await harness("search_products", { responses: () => ({ status: 400, json: { errors: [{ message: "bad request" }] } }) }).run({ query: "mug", facet_ids: ["zzz99"] });
  assert.equal(facet.error_kind, "invalid_input");
  const broken = await harness("search_products", { responses: () => ({ status: 500, json: { errors: [{ message: "upstream failed" }] } }) }).run({ query: "mug" });
  assert.equal(broken.error_kind, "site_error");
  assert.match(broken.error_message, /upstream failed/);
});

for (const status of [435, 429, 403]) {
  test(`search_products: HTTP ${status} from bot protection is a challenge`, async () => {
    const h = harness("search_products", { responses: () => ({ status, json: null, challenge: status === 403 }) });
    assert.equal((await h.run({ query: "mug" })).error_kind, "challenge");
    assert.equal(h.calls.requests.length, 1);
  });
}

// --- get_product ------------------------------------------------------------------------------------

test("get_product: an orderable variation with fulfillment at the selected store", async () => {
  const h = harness("get_product", { fulfillment: () => ({ pickup: "IN_STOCK" }) });
  const result = await h.run({ tcin: "20000001" });
  assert.equal(result.is_variation_parent, false);
  assert.equal(result.parent_tcin, "20000000");
  assert.equal(result.title, "Queen Test Sheet Set Gray");
  assert.deepEqual(result.price, { current_cents: 1800, regular_cents: 2000, text: "$18.00", type: "sale", is_range: false });
  assert.equal(result.purchase_limit, 3);
  assert.deepEqual(result.selected_variation, { Size: "Queen", Color: "Gray" });
  assert.deepEqual(result.variation_themes, [{ name: "Size", values: ["Queen", "Twin"] }, { name: "Color", values: ["Gray", "White", "Light Gray"] }]);
  assert.deepEqual(result.variants.map(v => [v.tcin, v.orderable, v.price_cents]), [["20000001", true, 1800], ["20000002", false, 1800], ["20000003", true, 900]]);
  assert.deepEqual(result.highlights, ["Soft fabricated fabric", "Machine washable"]);
  assert.deepEqual(result.fulfillment.shipping, { status: "IN_STOCK", available: true, min_delivery_date: "2030-01-02", max_delivery_date: "2030-01-03" });
  assert.deepEqual(result.fulfillment.in_store, { status: "LIMITED_STOCK", available: true, aisle: "12B" });
  assert.deepEqual(result.add_to_cart_fulfillments, ["ship", "pickup"]);
  const q = new URL(h.calls.requests[1].href).searchParams;
  assert.deepEqual([q.get("tcin"), q.get("store_id"), q.get("zip")], ["20000001", "1234", "45000"]);
});

test("get_product: an item family has no fulfillment and makes no availability request", async () => {
  const h = harness("get_product");
  const result = await h.run({ tcin: "20000000" });
  assert.equal(result.is_variation_parent, true);
  assert.equal(result.fulfillment, null);
  assert.deepEqual(result.add_to_cart_fulfillments, []);
  // A range maximum is not a regular price for the minimum, so it is not reported as one.
  assert.deepEqual([result.price.is_range, result.price.current_cents, result.price.regular_cents], [true, 900, null]);
  assert.equal(h.calls.requests.length, 1);
});

test("get_product: variant_filter matches theme names and values case-insensitively", async () => {
  const result = await harness("get_product").run({ tcin: "20000000", variant_filter: { color: "GRAY" } });
  assert.deepEqual(result.variants.map(v => v.tcin), ["20000001", "20000003"]);
  assert.equal(result.variants_total, 3);
  assert.equal(result.variants_truncated, false);
  assert.deepEqual((await harness("get_product").run({ tcin: "20000000", variant_filter: { size: "queen", color: "white" } })).variants.map(v => v.tcin), ["20000002"]);
});

test("get_product: a standalone item and an unknown tcin", async () => {
  const single = await harness("get_product").run({ tcin: "30000001" });
  assert.deepEqual([single.parent_tcin, single.is_variation_parent, single.variants.length, single.add_to_cart_fulfillments], [null, false, 0, ["ship"]]);
  const missing = await harness("get_product").run({ tcin: "99999999" });
  assert.equal(missing.error_kind, "not_found");
});

// --- get_cart ---------------------------------------------------------------------------------------

test("get_cart: lines, totals and a session that never had a cart", async () => {
  const result = await harness("get_cart").run({});
  assert.equal(result.cart_id, "cart-0001");
  assert.equal(result.items_quantity, 1);
  assert.deepEqual(result.lines[0], {
    cart_item_id: "line-existing", tcin: "30000001", title: "Fabricated item 30000001", quantity: 1, unit_price_cents: 1800, list_price_cents: 2000,
    fulfillment: { type: "SHIP", ship_method: "STANDARD", location_id: null, location_name: null }, availability_status: "IN_STOCK", max_purchase_quantity: 5
  });
  assert.deepEqual([result.product_total_cents, result.estimated_total_cents], [1800, 2150]);
  assert.deepEqual(await harness("get_cart", { cart: null }).run({}), { status: "ok", session_type: "guest", cart_id: null, items_quantity: 0, lines: [], product_total_cents: 0, estimated_total_cents: 0 });
});

test("get_cart: a cart service error and a challenge", async () => {
  assert.equal((await harness("get_cart", { responses: () => ({ status: 500, json: { message: "down" } }) }).run({})).error_kind, "site_error");
  assert.equal((await harness("get_cart", { responses: () => ({ status: 435, json: null }) }).run({})).error_kind, "challenge");
});

// --- add_to_cart ------------------------------------------------------------------------------------

test("add_to_cart: adds a new shipping line with the site's own request body", async () => {
  const h = harness("add_to_cart", { cart: null });
  const result = await h.run({ tcin: "30000002", quantity: 2 });
  assert.deepEqual(result, {
    status: "ok", cart_id: "cart-new", cart_item_id: "line-new-1", tcin: "30000002", title: "Fabricated item 30000002", fulfillment: "ship", store_id: null,
    previous_quantity: 0, quantity: 2, unit_price_cents: 1800, items_quantity: 2
  });
  assert.deepEqual(h.calls.writes, [{ path: "/web_checkouts/v1/cart_items", method: "POST", body: { cart_item: { item_channel_id: "10", tcin: "30000002", quantity: 2 }, cart_type: "REGULAR", channel_id: "10", shopping_context: "DIGITAL" } }]);
});

test("add_to_cart: increments an existing line and leaves other lines alone", async () => {
  const h = harness("add_to_cart");
  const result = await h.run({ tcin: "30000001" });
  assert.deepEqual([result.cart_item_id, result.previous_quantity, result.quantity, result.items_quantity], ["line-existing", 1, 2, 2]);
});

test("add_to_cart: pickup at the selected store only", async () => {
  const h = harness("add_to_cart", { fulfillment: () => ({ pickup: "IN_STOCK" }) });
  const result = await h.run({ tcin: "30000003", fulfillment: "pickup" });
  assert.deepEqual([result.fulfillment, result.store_id, result.quantity], ["pickup", "1234", 1]);
  assert.deepEqual(h.calls.writes[0].body.fulfillment, { type: "PICKUP", location_id: 1234, ship_method: "STORE_PICKUP" });
});

test("add_to_cart refuses without writing: family, unavailable, sold out, limit, unknown item", async () => {
  const family = harness("add_to_cart");
  const f = await family.run({ tcin: "20000000" });
  assert.equal(f.error_kind, "variant_required");
  assert.match(f.error_message, /20000001 \(Queen, Gray\)/);
  const pickup = harness("add_to_cart");
  assert.equal((await pickup.run({ tcin: "30000001", fulfillment: "pickup" })).error_kind, "unavailable");
  const ship = harness("add_to_cart", { fulfillment: () => ({ ship: "OUT_OF_STOCK" }) });
  assert.equal((await ship.run({ tcin: "30000001" })).error_kind, "unavailable");
  const limit = harness("add_to_cart");
  assert.equal((await limit.run({ tcin: "20000001", quantity: 4 })).error_kind, "quantity_limit");
  const existing = harness("add_to_cart");
  assert.equal((await existing.run({ tcin: "30000001", quantity: 10 })).error_kind, "quantity_limit");
  const missing = harness("add_to_cart");
  assert.equal((await missing.run({ tcin: "99999999" })).error_kind, "not_found");
  for (const h of [family, pickup, ship, limit, existing, missing]) assert.deepEqual(h.calls.writes, []);
});

test("add_to_cart: a challenged or refused write is reported once and never retried", async () => {
  const blocked = harness("add_to_cart", { responses: (u, method) => method === "POST" ? { status: 435, json: null, challenge: true } : null });
  const b = await blocked.run({ tcin: "30000002" });
  assert.equal(b.error_kind, "challenge");
  assert.match(b.error_message, /get_cart/);
  assert.equal(blocked.calls.writes.length, 1);
  const refused = harness("add_to_cart", { responses: (u, method) => method === "POST" ? { status: 400, json: { alerts: [{ message: "Item cannot be added" }] } } : null });
  const r = await refused.run({ tcin: "30000002" });
  assert.equal(r.error_kind, "unavailable");
  assert.match(r.error_message, /Item cannot be added/);
  assert.equal(refused.calls.writes.length, 1);
});

test("add_to_cart: an accepted write the cart does not show is a site_error", async () => {
  const h = harness("add_to_cart", { ignoreWrites: true });
  const result = await h.run({ tcin: "30000002" });
  assert.equal(result.error_kind, "site_error");
  assert.equal(h.calls.writes.length, 1);
});

// --- update_cart_item and remove_cart_item ------------------------------------------------------------

test("update_cart_item sets an absolute quantity with the site's request", async () => {
  const h = harness("update_cart_item");
  const result = await h.run({ cart_item_id: "line-existing", quantity: 3 });
  assert.deepEqual([result.previous_quantity, result.quantity, result.changed, result.items_quantity], [1, 3, true, 3]);
  assert.deepEqual(h.calls.writes, [{ path: "/web_checkouts/v1/cart_items/line-existing", method: "PUT", body: { cart_type: "REGULAR", quantity: 3 } }]);
});

test("update_cart_item: same quantity writes nothing; unknown line and limit refuse", async () => {
  const same = harness("update_cart_item");
  assert.equal((await same.run({ cart_item_id: "line-existing", quantity: 1 })).changed, false);
  const missing = harness("update_cart_item");
  assert.equal((await missing.run({ cart_item_id: "line-unknown", quantity: 2 })).error_kind, "not_found");
  const limit = harness("update_cart_item");
  assert.equal((await limit.run({ cart_item_id: "line-existing", quantity: 6 })).error_kind, "quantity_limit");
  for (const h of [same, missing, limit]) assert.deepEqual(h.calls.writes, []);
});

test("update_cart_item: a write the cart does not reflect is a site_error", async () => {
  const result = await harness("update_cart_item", { ignoreWrites: true }).run({ cart_item_id: "line-existing", quantity: 2 });
  assert.equal(result.error_kind, "site_error");
});

test("remove_cart_item removes only the named line and reports it", async () => {
  const cart = { cart_id: "cart-0001", cart_items: [cartLine("line-mine", "30000002", 2, "PICKUP", "1234"), cartLine("line-other", "30000001", 1)], summary: {} };
  const h = harness("remove_cart_item", { cart });
  const result = await h.run({ cart_item_id: "line-mine" });
  assert.equal(result.removed.cart_item_id, "line-mine");
  assert.deepEqual(result.removed.fulfillment, { type: "PICKUP", ship_method: "STORE_PICKUP", location_id: "1234", location_name: "Test Store" });
  assert.equal(result.items_quantity, 1);
  assert.deepEqual(h.cart().cart_items.map(l => l.cart_item_id), ["line-other"]);
  assert.deepEqual(h.calls.writes.map(w => [w.method, w.path]), [["DELETE", "/web_checkouts/v1/cart_items/line-mine"]]);
});

test("remove_cart_item: the last line, an unknown line, and a removal the cart ignores", async () => {
  const last = await harness("remove_cart_item").run({ cart_item_id: "line-existing" });
  assert.deepEqual([last.status, last.items_quantity], ["ok", 0]);
  const missing = harness("remove_cart_item");
  assert.equal((await missing.run({ cart_item_id: "line-unknown" })).error_kind, "not_found");
  assert.deepEqual(missing.calls.writes, []);
  assert.equal((await harness("remove_cart_item", { ignoreWrites: true }).run({ cart_item_id: "line-existing" })).error_kind, "site_error");
});
