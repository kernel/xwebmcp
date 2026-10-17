import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";

// Shared harness for the myntra.com page tools. The page (location, document, fetch) is stubbed;
// nothing here contacts the live site, and every product, review and identifier is fabricated.
const NAMES = ["search_products", "get_product", "get_product_reviews"];
const sources = Object.fromEntries(NAMES.map(name => [name, readFileSync(new URL(`../domains/myntra.com/${name}.js`, import.meta.url), "utf8")]));
const plain = value => JSON.parse(JSON.stringify(value));
const DEVICE = "fabricated-device-0000";

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

const card = (id, extra = {}) => ({
  productId: id, productName: `Testbrand Test Shoe ${id}`, product: `Testbrand Test Shoe ${id}`, brand: "Testbrand", gender: "Men", category: "Sports Shoes", primaryColour: "Black",
  price: 899, mrp: 3999, discountDisplayLabel: "(78% OFF)", rating: 4.262160778045654, ratingCount: 4276, sizes: "3,4,5,6",
  landingPageUrl: `sports-shoes/testbrand/testbrand-test-shoe-${id}/${id}/buy`, searchImage: `http://assets.myntassets.com/assets/images/fab/${id}.jpg`, isPLA: false, ...extra
});
const searchBody = (options = {}) => ({
  responseType: "LIST", totalCount: "total" in options ? options.total : 120, hasNextPage: options.hasNext ?? true, querySubstitution: options.substitution ?? null, templateMessage: options.message ?? null,
  products: options.products ?? [card(1001), card(1002, { brand: "Otherbrand", rating: 0, ratingCount: 0, sizes: "S,M,L" }), card(1003, { isPLA: true })],
  filters: options.filters ?? {
    primaryFilters: [
      { id: "Brand", filterValues: [{ id: "Puma", value: "Puma", meta: "", count: 931 }, { id: "Bad,Brand", value: "Bad,Brand", meta: "", count: 1 }, { id: "Bad:Brand", value: "Bad:Brand", meta: "", count: 1 }] },
      { id: "Color", filterValues: [{ id: "Black", value: "Black", meta: "36454f", count: 4034 }] },
      { id: "Odd:Group", filterValues: [{ id: "x", value: "x", meta: "", count: 1 }] }
    ],
    secondaryFilters: [{ id: "Fastening", filterValues: [{ id: "Lace-Ups", value: "Lace-Ups", count: 14269 }] }],
    rangeFilters: [{ id: "Price", filterValues: [{ id: "1.0 TO 2.0", count: 3 }] }]
  }
});
const pdp = (overrides = {}) => ({
  id: 4321001, name: "Testbrand Test Shoe", brand: { name: "Testbrand" }, baseColour: "Black", mrp: 3999, price: { mrp: 3999, discounted: 899 },
  analytics: { gender: "Unisex", masterCategory: "Footwear", articleType: "Sports Shoes" }, discounts: [{ label: "(78% OFF)", discountText: "OFFER ENDS IN" }],
  ratings: { averageRating: 4.26, totalCount: 4276, ratingInfo: [{ rating: 4, count: 770 }, { rating: 5, count: 2746 }, { rating: 1, count: 362 }, { rating: 9, count: 5 }], reviewInfo: { reviewsCount: "776" } },
  flags: { outOfStock: false, isReturnable: true, isExchangeable: true, codEnabled: false }, serviceability: { returnPeriod: 7 },
  selectedSeller: { sellerPartnerId: 11, sellerName: "Fabricated Seller Pvt" }, sellers: [{ sellerPartnerId: 11, sellerName: "Fabricated Seller Pvt" }, { sellerPartnerId: 12, sellerName: "Other Seller" }],
  sizes: [
    { skuId: 90001, label: "3", available: true, allSizesList: [{ prefix: "UK", sizeValue: "3" }, { prefix: "US", sizeValue: "4" }, { scaleCode: "euro_size", sizeValue: "36" }], sizeSellerData: [{ sellerPartnerId: 11, availableCount: 33, discountedPrice: 899 }] },
    { skuId: 90002, label: "4", available: false, allSizesList: [], sizeSellerData: [{ sellerPartnerId: 12, availableCount: 5, discountedPrice: 950 }, { sellerPartnerId: 11, availableCount: 0, discountedPrice: 899 }] },
    { label: 5, available: true }, { label: "", available: true }
  ],
  colours: [{ styleId: 4321002, label: "White / Black" }, { styleId: "not-an-id", label: "Broken" }],
  articleAttributes: { Fastening: "Lace-Ups", "Arch Type": "NA", "BIS Certificate Image URL": "https://assets.myntassets.com/assets/images/fab/cert.png", Note: "<b>Bold</b> &amp; plain", Empty: "" },
  productDetails: [{ title: "Product Details", description: "A pair of shoes<br>Mesh upper<script>alert(1)</script>" }, { title: "Care", description: "x".repeat(2000) }],
  media: { albums: [{ name: "default", images: [{ imageURL: "http://assets.myntassets.com/assets/images/fab/a.jpg", src: "http://assets.myntassets.com/h_($height),w_($w)/a.jpg" }, { imageURL: "https://evil.example.invalid/x.jpg" }, { imageURL: "http://assets.myntassets.com/assets/images/fab/a.jpg" }] }] },
  ...overrides
});
const pdpHtml = (state, tail = "") => `<!doctype html><html><head><title>x</title></head><body><script>window.__myx_apps__={"a":1};</script><script>window.__myx = ${JSON.stringify(state).replace(/</g, "\\u003c")}${tail}</script></body></html>`;
const reviewItem = (n, extra = {}) => ({
  id: `00000000-0000-0000-0000-00000000000${n}`, style: { id: "4321002" }, userRating: 1 + (n % 5), review: `Fabricated review ${n}`, images: [{ url: "https://assets.myntassets.com/x.jpg" }], videos: [],
  styleAttribute: [{ name: "Size bought", value: "7" }], upvotes: "3", downvotes: "0", userName: "Fabricated Reviewer", updatedAt: "1782944700000", ...extra
});
const reviewsBody = (items, meta = null) => ({ reviews: items, reviewsMetaData: meta ?? {}, aspectSentiments: [], additionalInfo: {} });
const summaryMeta = () => ({
  reviewCount: "776", styleRating: { avgRating: 4.262160898035547, totalUserCount: 4276, overallRatings: [{ ratings: [{ rating: 1, userCount: 362 }, { rating: 5, userCount: 2746 }, { rating: 4, userCount: 770 }] }] }
});

const MAINTENANCE_PAGE = "<!doctype html>\n<html>\n<head>\n    <title>Site Maintenance</title>\n</head>\n<body><h1>Oops! Something went wrong</h1><p>Please contact your administrator</p></body>\n</html>";
const BLOCK_PAGE = "<html><head><title>Access Denied</title></head><body>You don't have permission to access this server. Reference #18.abc</body></html>";

function harness(name, options = {}) {
  const calls = [];
  const context = {
    URL, JSON, Object, Array, String, Number, Math, Set, Date, RegExp,
    atob: value => Buffer.from(value, "base64").toString("binary"), btoa: value => Buffer.from(value, "binary").toString("base64"),
    location: { hostname: options.hostname ?? "www.myntra.com", href: `https://${options.hostname ?? "www.myntra.com"}/` },
    document: { cookie: options.cookie ?? `_d_id=${DEVICE}; other=1`, title: "Myntra" },
    fetch: async (path, init = {}) => {
      calls.push({ path, init });
      assert.equal(typeof path, "string");
      assert.ok(path.startsWith("/"), "page tools may only call same-origin relative paths: " + path);
      assert.equal(init.credentials, "include");
      assert.equal(init.method, undefined, "page tools only read");
      assert.equal(init.body, undefined);
      if (options.throws) throw new TypeError("network down");
      const forced = options.respond?.(new URL(path, "https://www.myntra.com"), init);
      const { status = 200, body = "", headers = {} } = forced ?? {};
      return { status, text: async () => (typeof body === "string" ? body : JSON.stringify(body)), headers: { get: key => headers[key.toLowerCase()] ?? null } };
    }
  };
  const [definition] = runInNewContext(`(${sources[name]})`, context);
  // The page runtime re-creates execute from its source text inside the page, so run that copy.
  const execute = runInNewContext(`(${definition.execute.toString()})`, context);
  return {
    definition, calls,
    run: async input => {
      const result = plain(await execute(input, { signal: new AbortController().signal }));
      assert.ok(conforms(definition.tool.outputSchema, result), `${name} output violates its schema: ${JSON.stringify(result).slice(0, 600)}`);
      assert.equal(JSON.stringify(result).includes(DEVICE), false, "the device cookie must never be returned");
      return result;
    }
  };
}
const searchWith = (respond, extra = {}) => harness("search_products", { respond, ...extra });
const okSearch = (body = searchBody(), headers = { "pagination-context": "ctx-page-1" }) => (u) => (u.pathname.startsWith("/gateway/v4/search/") ? { body, headers } : undefined);

const registry = JSON.parse(readFileSync(new URL("../registry.json", import.meta.url), "utf8"));

// --- structure -------------------------------------------------------------------------------------

for (const name of NAMES) {
  test(`${name}: single-expression read-only page tool with typed schemas and a registry entry`, () => {
    assert.equal(sources[name].trimEnd().endsWith(";"), false);
    assert.equal(/[^\x00-\x7f]/.test(sources[name]), false, "tool source must be ASCII; use \\u escapes");
    assert.equal(/\b(Buffer|require|process)\b/.test(sources[name]), false, "tool source must not depend on Node globals");
    assert.equal(/\b(gotoUrl|pageInfo|waitForLoad|waitMs|waitForEvent|cdp|js|httpGet)\(/.test(sources[name]), false, "a page tool has no browser helpers");
    assert.equal(/method\s*:|\.click\(|\.submit\(|location\.(assign|replace|href\s*=)/.test(sources[name]), false, "the tool must only read and never navigate");
    const { definition } = harness(name);
    assert.equal(definition.kind, "page");
    assert.equal(definition.tool.name, name);
    assert.deepEqual(plain(definition.match.url_patterns), ["https://myntra.com/*", "https://*.myntra.com/*"]);
    assert.equal(definition.tool.inputSchema.type, "object");
    assert.equal(definition.tool.inputSchema.additionalProperties, false);
    assert.equal(definition.tool.outputSchema.type, "object");
    assert.equal(definition.tool.annotations.readOnlyHint, true);
    const entry = registry.tools.find(t => t.domain === "myntra.com" && t.tool === name);
    assert.ok(entry, "registry entry missing");
    assert.equal(entry.file, `domains/myntra.com/${name}.js`);
    assert.equal(entry.kind, "page");
    assert.deepEqual(entry.url_patterns, plain(definition.match.url_patterns));
  });
}

test("registry lists every myntra.com tool exactly once", () => {
  assert.deepEqual(registry.tools.filter(t => t.domain === "myntra.com").map(t => t.tool).sort(), [...NAMES, "get_cart", "add_to_cart", "update_cart_item", "remove_cart_item"].sort());
});

test("the shared text sanitiser is identical in all three tools", () => {
  const helper = source => /const clean = [\s\S]*?\n {4}\};\n/.exec(source)[0];
  assert.equal(helper(sources.get_product), helper(sources.search_products));
  assert.equal(helper(sources.get_product_reviews), helper(sources.search_products));
});

// --- input validation and page routing happen before any request ---------------------------------

const invalidInputs = {
  search_products: [
    null, [], "shoes", {}, { query: 5 }, { query: "" }, { query: "   " }, { query: "///" }, { query: "..." }, { query: "a".repeat(121) }, { query: "shoes\u0000" }, { query: "shoes\n" }, { query: "shoes", extra: 1 },
    { query: "shoes", sort_by: "cheapest" }, { query: "shoes", sort_by: "toString" }, { query: "shoes", limit: 0 }, { query: "shoes", limit: 51 }, { query: "shoes", limit: 1.5 }, { query: "shoes", limit: "5" },
    { query: "shoes", filters: "Brand:Puma" }, { query: "shoes", filters: ["Brand"] }, { query: "shoes", filters: ["Brand:"] }, { query: "shoes", filters: [":Puma"] }, { query: "shoes", filters: ["Brand:Puma:x"] },
    { query: "shoes \ud800" }, { query: "\udc00shoes" }, { query: "shoes", filters: ["Brand:\ud800x"] }, { query: "shoes", filters: ["price:1.0_2.0"] }, { query: "shoes", filters: [" PRICE :1.0_2.0"] }, { query: "shoes", filters: ["rating:4.0"] }, { query: "shoes", filters: ["discount range:10.0"] },
    { query: "shoes", filters: ["Brand:Puma,Reebok"] }, { query: "shoes", filters: ["Brand:Puma", "Brand:Puma"] }, { query: "shoes", filters: [5] }, { query: "shoes", filters: ["Price:1.0,2.0"] }, { query: "shoes", filters: ["Rating:4.0"] },
    { query: "shoes", filters: ["Discount Range:10.0"] }, { query: "shoes", filters: Array.from({ length: 13 }, (_, i) => `G${i}:v`) }, { query: "shoes", filters: ["Brand:Pu\nma"] }, { query: "shoes", filters: ["B".repeat(61) + ":x"] },
    { query: "shoes", min_price: 100 }, { query: "shoes", max_price: 100 }, { query: "shoes", min_price: 200, max_price: 100 }, { query: "shoes", min_price: -1, max_price: 5 }, { query: "shoes", min_price: 1.5, max_price: 5 }, { query: "shoes", min_price: 0, max_price: 1000001 },
    { query: "shoes", include_facets: "yes" }, { query: "shoes", cursor: "" }, { query: "shoes", cursor: "not a cursor!" }, { query: "shoes", cursor: "abc" }, { query: "shoes", cursor: 5 }
  ],
  get_product: [null, [], "4321001", {}, { style_id: 4321001 }, { style_id: "" }, { style_id: "123" }, { style_id: "1".repeat(13) }, { style_id: "12a45" }, { style_id: "4321001/../x" }, { style_id: "4321001", extra: 1 }],
  get_product_reviews: [
    null, [], {}, { style_id: 4321001 }, { style_id: "abc" }, { style_id: "4321001", sort_by: "newest" }, { style_id: "4321001", stars: 0 }, { style_id: "4321001", stars: 6 }, { style_id: "4321001", stars: 2.5 },
    { style_id: "4321001", page: 0 }, { style_id: "4321001", page: 1001 }, { style_id: "4321001", page: "2" }, { style_id: "4321001", extra: 1 }
  ]
};
for (const name of NAMES) {
  test(`${name}: malformed input is refused before any request`, async () => {
    const h = harness(name);
    for (const input of invalidInputs[name]) {
      const result = await h.run(input);
      assert.equal(result.status, "error", JSON.stringify(input));
      assert.equal(result.error_kind, "invalid_input", JSON.stringify(input));
    }
    assert.equal(h.calls.length, 0);
  });
  test(`${name}: refuses other myntra.com hosts without a request`, async () => {
    for (const hostname of ["touch.myntra.com", "corporate.myntra.com", "myntra.com"]) {
      const h = harness(name, { hostname });
      const result = await h.run(name === "search_products" ? { query: "shoes" } : { style_id: "4321001" });
      assert.deepEqual([result.status, result.error_kind], ["error", "wrong_page"], hostname);
      assert.equal(h.calls.length, 0);
    }
  });
}

// --- search_products -------------------------------------------------------------------------------

test("search_products: default request shape, organic only, and mapped results", async () => {
  const h = searchWith(okSearch());
  const result = await h.run({ query: "  Men   running shoes " });
  assert.equal(h.calls.length, 1);
  const { path, init } = h.calls[0];
  const url = new URL(path, "https://www.myntra.com");
  assert.equal(url.pathname, "/gateway/v4/search/Men%20running%20shoes");
  assert.deepEqual([...url.searchParams.keys()], ["rawQuery", "rows", "o", "plaEnabled", "xdEnabled", "isFacet", "p"]);
  assert.equal(url.searchParams.get("rawQuery"), "Men running shoes");
  assert.equal(url.searchParams.get("rows"), "10");
  assert.equal(url.searchParams.get("o"), "0");
  assert.equal(url.searchParams.get("p"), "1");
  assert.equal(url.searchParams.get("plaEnabled"), "false");
  assert.equal(init.headers["X-myntraweb"], "Yes");
  assert.equal(init.headers["x-myntra-app"], `deviceID=${DEVICE};customerID=;reqChannel=web;appFamily=MyntraRetailWeb;`);
  assert.equal(result.status, "ok");
  assert.equal(result.query, "Men running shoes");
  assert.equal(result.currency, "INR");
  assert.equal(result.total_count, 120);
  assert.equal(result.has_next_page, true);
  assert.equal(result.facets, null);
  assert.equal(result.query_substituted, null);
  assert.deepEqual(result.products.map(p => [p.rank, p.style_id]), [[1, "1001"], [2, "1002"], [3, "1003"]]);
  assert.deepEqual(result.products[0], {
    rank: 1, style_id: "1001", name: "Testbrand Test Shoe 1001", brand: "Testbrand", gender: "Men", category: "Sports Shoes", colour: "Black", price: 899, mrp: 3999, discount_text: "(78% OFF)",
    rating: 4.26, rating_count: 4276, size_labels: ["3", "4", "5", "6"], url: "https://www.myntra.com/sports-shoes/testbrand/testbrand-test-shoe-1001/1001/buy",
    image_url: "https://assets.myntassets.com/assets/images/fab/1001.jpg", sponsored: false
  });
  assert.equal(result.products[1].rating, null);
  assert.deepEqual(result.products[1].size_labels, ["S", "M", "L"]);
  assert.equal(result.products[2].sponsored, true);
});

test("search_products: works without the device cookie", async () => {
  const h = searchWith(okSearch(), { cookie: "other=1" });
  assert.equal((await h.run({ query: "shoes" })).status, "ok");
  assert.equal(h.calls[0].init.headers["x-myntra-app"], "deviceID=;customerID=;reqChannel=web;appFamily=MyntraRetailWeb;");
  const odd = searchWith(okSearch(), { cookie: "_d_id=a\r\nb; other=1" });
  await odd.run({ query: "shoes" });
  assert.equal(odd.calls[0].init.headers["x-myntra-app"], "deviceID=ab;customerID=;reqChannel=web;appFamily=MyntraRetailWeb;");
});

test("search_products: the site's sort values, filters and price range reach the request", async () => {
  const sorts = { recommended: null, newest: "new", popularity: "popularity", better_discount: "discount", price_low_to_high: "price_asc", price_high_to_low: "price_desc", customer_rating: "Customer Rating" };
  for (const [sort_by, expected] of Object.entries(sorts)) {
    const h = searchWith(okSearch());
    const result = await h.run({ query: "shoes", sort_by });
    assert.equal(result.sort_by, sort_by);
    assert.equal(new URL(h.calls[0].path, "https://www.myntra.com").searchParams.get("sort"), expected, sort_by);
  }
  const h = searchWith(okSearch());
  const result = await h.run({ query: "shoes", filters: ["Brand:Puma", "Color:Black_36454f", "Brand:Reebok"], min_price: 500, max_price: 2000, limit: 50 });
  const url = new URL(h.calls[0].path, "https://www.myntra.com");
  assert.equal(url.searchParams.get("f"), "Brand:Puma,Reebok::Color:Black_36454f");
  assert.equal(url.searchParams.get("rf"), "Price:500.0_2000.0_500.0 TO 2000.0");
  assert.equal(url.searchParams.get("rows"), "50");
  assert.deepEqual(result.filters, ["Brand:Puma", "Color:Black_36454f", "Brand:Reebok"]);
  assert.deepEqual([result.min_price, result.max_price], [500, 2000]);
  assert.ok(h.calls[0].path.indexOf("Price:") === -1, "the price range must be percent-encoded in the path");
});

test("search_products: padding around a filter's group and value is dropped before the request", async () => {
  const h = searchWith(okSearch());
  const result = await h.run({ query: "shoes", filters: [" Brand : Puma ", "Brand:Reebok"] });
  assert.equal(new URL(h.calls[0].path, "https://www.myntra.com").searchParams.get("f"), "Brand:Puma,Reebok");
  assert.deepEqual(result.filters, [" Brand : Puma ", "Brand:Reebok"]);
});

test("search_products: '#' is treated as a space because the site cannot search for it", async () => {
  for (const [query, expected] of [["tee#1", "tee 1"], ["#tee", "tee"], ["a # b", "a b"]]) {
    const h = searchWith(okSearch());
    const result = await h.run({ query });
    assert.equal(result.query, expected);
    assert.equal(h.calls[0].path.includes("%23"), false);
    assert.equal(new URL(h.calls[0].path, "https://www.myntra.com").searchParams.get("rawQuery"), expected);
  }
  assert.equal((await searchWith(okSearch()).run({ query: "###" })).error_kind, "invalid_input");
});

test("search_products: a filter value is percent-encoded so it cannot add request parameters", async () => {
  const h = searchWith(okSearch());
  await h.run({ query: "shoes", filters: ["Brand:Puma&sort=price_asc#x"] });
  const url = new URL(h.calls[0].path, "https://www.myntra.com");
  assert.equal(url.searchParams.get("f"), "Brand:Puma&sort=price_asc#x");
  assert.equal(url.searchParams.get("sort"), null);
});

test("search_products: a cursor does not depend on the order of the filters", async () => {
  const h = searchWith(okSearch());
  const first = await h.run({ query: "shoes", filters: ["Brand:Puma", "Color:Black_36454f", "Brand:Reebok"] });
  const second = await h.run({ query: "shoes", filters: ["Color:Black_36454f", "Brand:Reebok", "Brand:Puma"], cursor: first.next_cursor });
  assert.equal(second.status, "ok");
  const other = await h.run({ query: "shoes", filters: ["Color:Black_36454f", "Brand:Reebok"], cursor: first.next_cursor });
  assert.equal(other.error_kind, "invalid_input");
});

test("search_products: size labels, totals and ratings are bounded and sanitised", async () => {
  const big = card(11, { sizes: Array.from({ length: 60 }, (_, i) => `S${i}`).join(",") });
  const result = await searchWith(okSearch(searchBody({ products: [big, card(12, { rating: 4.999, price: "899", mrp: null })], total: "many" }))).run({ query: "shoes" });
  assert.equal(result.products[0].size_labels.length, 40);
  assert.equal(result.total_count, null);
  assert.equal(result.products[1].rating, 5);
  assert.equal(result.products[1].price, null);
  for (const total of [-5, 1.5, null]) assert.equal((await searchWith(okSearch(searchBody({ total }))).run({ query: "shoes" })).total_count, null, String(total));
});

test("the JSON tools send the site's own headers", async () => {
  const search = searchWith(okSearch());
  await search.run({ query: "shoes" });
  const reviews = reviewsWith(reviewsBody([reviewItem(1)]));
  await reviews.run({ style_id: "4321001" });
  for (const { init } of [search.calls[0], reviews.calls[0]]) {
    assert.deepEqual(plain(init.headers), {
      "Accept": "application/json", "Content-Type": "application/json", "X-myntraweb": "Yes", "X-Requested-With": "browser", "app": "web", "x-meta-app": "channel=web",
      "x-myntra-app": `deviceID=${DEVICE};customerID=;reqChannel=web;appFamily=MyntraRetailWeb;`
    });
  }
  const odd = harness("get_product_reviews", { cookie: "_d_id=a b\r\nc; x=1", respond: () => ({ body: reviewsBody([reviewItem(1)]) }) });
  await odd.run({ style_id: "4321001" });
  assert.equal(odd.calls[0].init.headers["x-myntra-app"], "deviceID=abc;customerID=;reqChannel=web;appFamily=MyntraRetailWeb;");
});

test("text sanitiser: block tags separate text, entities are decoded once, plain angle brackets stay, control characters go", async () => {
  const cases = [
    ["<ul><li>Fill in your upper</li><li>Line carefully</li></ul>", "Fill in your upper\nLine carefully"],
    ["<p>a</p><p>b</p><div>c</div>", "a\nb\nc"],
    ["Warranty:&nbsp;Warranty provided", "Warranty: Warranty provided"],
    ["&#x27;&#039;&apos;&ndash;&mdash;&hellip;&rsquo;", "\u0027\u0027\u0027\u2013\u2014\u2026\u2019"],
    ["&amp;lt; &amp;amp; &amp;#39;", "&lt; &amp; &#39;"],
    ["tab\there", "tab here"],
    ["a &#0; b &#xD800; c &#1114112; d", "a b c d"],
    ["&unknown; &notanentity", "&unknown; &notanentity"],
    ["line one   \n\n\n   line two", "line one\nline two"],
    ["<script>alert(1)</script><style>p{}</style>ok<SCRIPT type=x>bad</SCRIPT >", "ok"],
    ["<h2>Title</h2>body<H3>Sub</H3>rest", "Title\nbody\nSub\nrest"],
    ["one</li>two</p>three</ul>four", "one\ntwo\nthree\nfour"],
    ["a&NBSP;b &Ndash; &AMP;", "a b \u2013 &"],
    ["&#38;lt; &#38;amp; &#x26;nbsp;x &#38;#x3c;", "&lt; &amp; &nbsp;x &#x3c;"],
    ["1 < 2 and 3 > 2, I <3 it, rating < 3", "1 < 2 and 3 > 2, I <3 it, rating < 3"],
    ["before<!-- hidden > text -->after", "beforeafter"],
    ["<B>bold</B> <SPAN class=x>span</SPAN> <A HREF=y>link</A>", "bold span link"],
    ["<div>one</div><DIV>two</DIV>", "one\ntwo"],
    ["<!DOCTYPE html>text", "text"],
    ["&#12345678; &#1234567;", "&#12345678;"],
    ["  <b> </b>  ", null]
  ];
  for (const [raw, expected] of cases) {
    const result = await reviewsWith(reviewsBody([reviewItem(1, { review: raw })])).run({ style_id: "4321001" });
    assert.equal(result.reviews[0].text, expected, JSON.stringify(raw));
  }
});

test("search_products: '/' and '\\' in the query become spaces and other characters are encoded", async () => {
  const h = searchWith(okSearch());
  const result = await h.run({ query: "cotton/linen\\shirt & men's 100%" });
  assert.equal(result.query, "cotton linen shirt & men's 100%");
  const url = new URL(h.calls[0].path, "https://www.myntra.com");
  assert.equal(url.pathname, "/gateway/v4/search/cotton%20linen%20shirt%20%26%20men's%20100%25");
  assert.equal(url.searchParams.get("rawQuery"), "cotton linen shirt & men's 100%");
});

test("search_products: cursor continues with the site's pagination context and offset", async () => {
  let pages = 0;
  const h = searchWith((u, init) => {
    pages += 1;
    if (pages === 1) return { body: searchBody({ products: [card(1), card(2)] }), headers: { "pagination-context": "ctx-one" } };
    assert.equal(init.headers["pagination-context"], "ctx-one");
    return { body: searchBody({ products: [card(3), card(4)], hasNext: false }), headers: { "pagination-context": "ctx-two" } };
  });
  const first = await h.run({ query: "shoes", sort_by: "newest", limit: 2 });
  assert.equal(first.has_next_page, true);
  assert.match(first.next_cursor, /^[A-Za-z0-9_-]+$/);
  assert.equal(h.calls[0].init.headers["pagination-context"], undefined);
  const second = await h.run({ query: "shoes", sort_by: "newest", limit: 2, cursor: first.next_cursor });
  const url = new URL(h.calls[1].path, "https://www.myntra.com");
  assert.equal(url.searchParams.get("p"), "2");
  assert.equal(url.searchParams.get("o"), "2");
  assert.deepEqual(second.products.map(p => p.rank), [3, 4]);
  assert.equal(second.has_next_page, false);
  assert.equal(second.next_cursor, null);
});

test("search_products: the offset advances by what the site returned and a changed limit is allowed", async () => {
  let pages = 0;
  const h = searchWith(() => {
    pages += 1;
    return { body: searchBody({ products: pages === 1 ? [card(1), card(2), card(3)] : [card(4)] }), headers: { "pagination-context": `ctx-${pages}` } };
  });
  const first = await h.run({ query: "shoes", limit: 3 });
  const second = await h.run({ query: "shoes", limit: 1, cursor: first.next_cursor });
  assert.equal(new URL(h.calls[1].path, "https://www.myntra.com").searchParams.get("o"), "3");
  assert.equal(second.products[0].rank, 4);
  await h.run({ query: "shoes", limit: 1, cursor: second.next_cursor });
  const url = new URL(h.calls[2].path, "https://www.myntra.com");
  assert.equal(url.searchParams.get("o"), "4");
  assert.equal(url.searchParams.get("p"), "3");
  assert.equal(h.calls[2].init.headers["pagination-context"], "ctx-2");
});

test("search_products: a cursor only works for the query, sort, filters and price range it came from", async () => {
  const h = searchWith(okSearch());
  const first = await h.run({ query: "shoes", sort_by: "newest", filters: ["Brand:Puma"], min_price: 1, max_price: 9 });
  const asked = h.calls.length;
  const same = { query: "shoes", sort_by: "newest", filters: ["Brand:Puma"], min_price: 1, max_price: 9, cursor: first.next_cursor };
  for (const changed of [{ query: "boots" }, { sort_by: "popularity" }, { filters: ["Brand:Reebok"] }, { filters: undefined }, { min_price: 2 }, { min_price: undefined, max_price: undefined }]) {
    const result = await h.run({ ...same, ...changed });
    assert.deepEqual([result.status, result.error_kind], ["error", "invalid_input"], JSON.stringify(changed));
  }
  assert.equal(h.calls.length, asked);
  const ok = await h.run(same);
  assert.equal(ok.status, "ok");
  assert.equal(ok.products[0].rank, 4);
});

test("search_products: forged or malformed cursors are refused before any request", async () => {
  const encode = value => Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64url");
  const h = searchWith(okSearch());
  const first = await h.run({ query: "shoes" });
  const good = JSON.parse(Buffer.from(first.next_cursor, "base64url").toString());
  const asked = h.calls.length;
  const bad = [
    encode("not json"), encode({ ...good, v: 2 }), encode({ ...good, p: 1 }), encode({ ...good, p: 1001 }), encode({ ...good, p: "2" }), encode({ ...good, o: 0 }), encode({ ...good, o: 100001 }),
    encode({ ...good, c: "" }), encode({ ...good, c: "line\r\nbreak: injected" }), encode({ ...good, c: "\u00e9" }), encode({ ...good, c: "x".repeat(4001) }), encode({ ...good, k: 5 }), encode([good]), encode(null)
  ];
  for (const cursor of bad) {
    const result = await h.run({ query: "shoes", cursor });
    assert.deepEqual([result.status, result.error_kind], ["error", "invalid_input"], cursor.slice(0, 40));
  }
  assert.equal(h.calls.length, asked);
});

test("search_products: has_next_page without a continuation token yields no cursor", async () => {
  const h = searchWith(okSearch(searchBody(), {}));
  const result = await h.run({ query: "shoes" });
  assert.equal(result.has_next_page, true);
  assert.equal(result.next_cursor, null);
  const odd = searchWith(okSearch(searchBody(), { "pagination-context": "line\nbreak" }));
  assert.equal((await odd.run({ query: "shoes" })).next_cursor, null);
});

test("search_products: a substituted query is reported, never presented as the original", async () => {
  const h = searchWith(okSearch(searchBody({
    total: 361, substitution: { templateId: "qs", inputQuery: "zzzqqxxyy", suggestedQuery: "zzz", displayText: "", resolvedQuery: null },
    message: "<p>No results found for <b>zzzqqxxyy</b>. Showing results for <b>zzz</b> instead.</p>"
  })));
  const result = await h.run({ query: "zzzqqxxyy" });
  assert.equal(result.status, "ok");
  assert.deepEqual(result.query_substituted, { input: "zzzqqxxyy", used: "zzz" });
  assert.equal(result.site_message, "No results found for zzzqqxxyy. Showing results for zzz instead.");
  assert.equal(result.query, "zzzqqxxyy");
});

test("search_products: an empty result is no_results and keeps the site's message", async () => {
  const h = searchWith(okSearch(searchBody({ products: [], total: 0, hasNext: false, message: "Nothing here" })));
  const result = await h.run({ query: "shoes", filters: ["Brand:Nobody"] });
  assert.deepEqual(result, { status: "no_results", query: "shoes", query_substituted: null, site_message: "Nothing here", sort_by: "recommended", filters: ["Brand:Nobody"], min_price: null, max_price: null, total_count: 0 });
});

test("search_products: include_facets lists exact filter strings and skips options that cannot be expressed", async () => {
  const h = searchWith(okSearch());
  const result = await h.run({ query: "shoes", include_facets: true });
  assert.deepEqual(result.facets, [
    { group: "Brand", option_count: 3, options: [{ value: "Puma", filter: "Brand:Puma", count: 931 }] },
    { group: "Color", option_count: 1, options: [{ value: "Black", filter: "Color:Black_36454f", count: 4034 }] },
    { group: "Fastening", option_count: 1, options: [{ value: "Lace-Ups", filter: "Fastening:Lace-Ups", count: 14269 }] }
  ]);
  const many = searchWith(okSearch(searchBody({
    filters: { primaryFilters: Array.from({ length: 30 }, (_, g) => ({ id: `G${g}`, filterValues: Array.from({ length: 80 }, (_, i) => ({ id: `v${i}`, value: `v${i}`, meta: "", count: i })) })) }
  })));
  const bounded = await many.run({ query: "shoes", include_facets: true });
  assert.equal(bounded.facets.length, 20);
  assert.ok(bounded.facets.every(f => f.options.length === 30 && f.option_count === 80));
});

test("search_products: site text is sanitised and unsafe links are not returned", async () => {
  const hostile = card(77, {
    productName: "<b>Bold</b> &amp; Test\u200b Shoe\u0007 <img src=x onerror=alert(1)>", brand: "Brand\u2028Name", landingPageUrl: "//evil.example.invalid/x?y=1",
    searchImage: "https://evil.example.invalid/x.jpg", sizes: ",,S, M ,", discountDisplayLabel: "<i>(10% OFF)</i>"
  });
  const result = await searchWith(okSearch(searchBody({ products: [hostile] }))).run({ query: "shoes" });
  const [product] = result.products;
  assert.equal(product.name, "Bold & Test Shoe");
  assert.equal(product.brand, "BrandName");
  assert.equal(product.url, "https://www.myntra.com/77");
  assert.equal(product.image_url, null);
  assert.deepEqual(product.size_labels, ["S", "M"]);
  assert.equal(product.discount_text, "(10% OFF)");
});

test("search_products: products without a usable style id are skipped and a list of only those is site_changed", async () => {
  const mixed = await searchWith(okSearch(searchBody({ products: [card("x1"), null, card(5), { productName: "no id" }] }))).run({ query: "shoes" });
  assert.deepEqual(mixed.products.map(p => [p.rank, p.style_id]), [[3, "5"]]);
  const none = await searchWith(okSearch(searchBody({ products: [card("x1"), null] }))).run({ query: "shoes" });
  assert.deepEqual([none.status, none.error_kind], ["error", "site_changed"]);
});

test("search_products: never returns more products than the limit", async () => {
  const many = Array.from({ length: 30 }, (_, i) => card(2000 + i));
  const h = searchWith(okSearch(searchBody({ products: many })));
  const result = await h.run({ query: "shoes", limit: 5 });
  assert.equal(result.products.length, 5);
  await h.run({ query: "shoes", limit: 5, cursor: result.next_cursor });
  assert.equal(new URL(h.calls[1].path, "https://www.myntra.com").searchParams.get("o"), "5");
});

// --- shared failure handling ------------------------------------------------------------------------

const failureCases = [
  ["HTTP 429 is rate_limited", { status: 429, body: "slow down" }, "rate_limited"],
  ["HTTP 401 is login_required", { status: 401, body: "{}" }, "login_required"],
  ["HTTP 403 is a challenge", { status: 403, body: BLOCK_PAGE }, "challenge"],
  ["a 200 block page is a challenge", { status: 200, body: BLOCK_PAGE }, "challenge"],
  ["a 200 'Site Maintenance' page is site_error and names the page", { status: 200, body: MAINTENANCE_PAGE }, "site_error"],
  ["HTTP 404 is site_error", { status: 404, body: "404 page not found\n" }, "site_error"],
  ["HTTP 500 is site_error", { status: 500, body: "boom" }, "site_error"],
  ["a 200 page that is not a block and has no data is site_changed", { status: 200, body: "<html><body>Welcome</body></html>" }, "site_changed"],
  ["a 200 body of the wrong shape is site_changed", { status: 200, body: { unexpected: true } }, "site_changed"]
];
const failureInputs = { search_products: { query: "shoes" }, get_product: { style_id: "4321001" }, get_product_reviews: { style_id: "4321001" } };
for (const [label, forced, kind] of failureCases) {
  for (const name of NAMES) {
    test(`${name}: ${label}`, async () => {
      const result = await harness(name, { respond: () => forced }).run(failureInputs[name]);
      assert.deepEqual([result.status, result.error_kind], ["error", kind]);
      assert.match(result.error_message, /Nothing was changed|site/);
    });
  }
}

test("an unexpected page reports its title to help diagnosis", async () => {
  const page = "<html><head><title>Welcome &amp; hello</title></head><body>x</body></html>";
  for (const name of NAMES) {
    const result = await harness(name, { respond: () => ({ status: 200, body: page }) }).run(failureInputs[name]);
    assert.equal(result.error_kind, "site_changed", name);
    assert.match(result.error_message, /page title 'Welcome & hello'/, name);
    const maintenance = await harness(name, { respond: () => ({ status: 200, body: MAINTENANCE_PAGE }) }).run(failureInputs[name]);
    assert.match(maintenance.error_message, /'Site Maintenance' page/, name);
  }
});

test("a failed request is reported, not thrown", async () => {
  for (const [name, input] of [["search_products", { query: "shoes" }], ["get_product", { style_id: "4321001" }], ["get_product_reviews", { style_id: "4321001" }]]) {
    const result = await harness(name, { throws: true }).run(input);
    assert.deepEqual([result.status, result.error_kind], ["error", "site_error"], name);
  }
});

test("a real result that mentions captcha is not mistaken for a block page", async () => {
  const body = searchBody({ products: [card(9, { productName: "Captcha Access Denied Kids Tee" })] });
  const result = await searchWith(okSearch(body)).run({ query: "captcha", limit: 1 });
  assert.equal(result.status, "ok");
  assert.equal(result.products[0].name, "Captcha Access Denied Kids Tee");
});

// --- get_product -------------------------------------------------------------------------------------

const productWith = (state, options = {}) => harness("get_product", { respond: () => ({ body: pdpHtml(state, options.tail), ...options.forced }) });

test("get_product: request shape and mapped fields", async () => {
  const h = productWith({ pdpData: pdp(), pageName: "Pdp" });
  const result = await h.run({ style_id: "4321001" });
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].path, "/4321001");
  assert.deepEqual(plain(h.calls[0].init.headers), { Accept: "text/html" });
  assert.equal(result.status, "ok");
  assert.equal(result.url, "https://www.myntra.com/4321001");
  assert.deepEqual([result.name, result.brand, result.gender, result.category, result.article_type, result.colour], ["Testbrand Test Shoe", "Testbrand", "Unisex", "Footwear", "Sports Shoes", "Black"]);
  assert.deepEqual([result.currency, result.price, result.mrp, result.discount_text], ["INR", 899, 3999, "(78% OFF)"]);
  assert.deepEqual([result.rating, result.rating_count, result.review_count], [4.26, 4276, 776]);
  assert.deepEqual(result.rating_histogram, [{ stars: 5, count: 2746 }, { stars: 4, count: 770 }, { stars: 1, count: 362 }]);
  assert.deepEqual([result.out_of_stock, result.returnable, result.exchangeable, result.cash_on_delivery, result.return_period_days], [false, true, true, false, 7]);
  assert.deepEqual([result.seller_name, result.seller_count], ["Fabricated Seller Pvt", 2]);
  assert.deepEqual(result.colours, [{ style_id: "4321002", label: "White / Black" }]);
});

test("get_product: sizes use the default seller's stock and keep the site's order", async () => {
  const result = await productWith({ pdpData: pdp() }).run({ style_id: "4321001" });
  assert.deepEqual(result.sizes, [
    { label: "3", sku_id: "90001", available: true, available_count: 33, price: 899, conversions: [{ scale: "UK", value: "3" }, { scale: "US", value: "4" }, { scale: "euro_size", value: "36" }] },
    { label: "4", sku_id: "90002", available: false, available_count: 0, price: 899, conversions: [] },
    { label: "5", sku_id: null, available: true, available_count: null, price: null, conversions: [] }
  ]);
});

test("get_product: attributes, description and images are allow-listed, sanitised and bounded", async () => {
  const result = await productWith({ pdpData: pdp() }).run({ style_id: "4321001" });
  assert.deepEqual(result.attributes, [{ name: "Fastening", value: "Lace-Ups" }, { name: "Note", value: "Bold & plain" }]);
  assert.equal(result.details.length, 2);
  assert.equal(result.details[0].text, "A pair of shoes\nMesh upper");
  assert.equal(result.details[1].text.length, 1500);
  assert.deepEqual(result.image_urls, ["https://assets.myntassets.com/assets/images/fab/a.jpg"]);
  const big = pdp({
    sizes: Array.from({ length: 80 }, (_, i) => ({ skuId: 5000 + i, label: `S${i}`, available: true })),
    articleAttributes: Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`Attr${i}`, `v${i}`])),
    productDetails: Array.from({ length: 9 }, (_, i) => ({ title: `T${i}`, description: `d${i}` })),
    colours: Array.from({ length: 40 }, (_, i) => ({ styleId: 6000 + i, label: `c${i}` })),
    media: { albums: [{ images: Array.from({ length: 30 }, (_, i) => ({ imageURL: `https://assets.myntassets.com/assets/images/fab/${i}.jpg` })) }] }
  });
  const bounded = await productWith({ pdpData: big }).run({ style_id: "4321001" });
  assert.deepEqual([bounded.sizes.length, bounded.attributes.length, bounded.details.length, bounded.colours.length, bounded.image_urls.length], [60, 40, 6, 30, 10]);
});

test("get_product: seller addresses are not returned from any seller object", async () => {
  const address = { address: "1 Fabricated Street", pincode: "000000", city: "Nowhere" };
  const state = { pdpData: pdp({ selectedSeller: { sellerPartnerId: 11, sellerName: "Fabricated Seller Pvt", sellerAddress: address }, sellers: [{ sellerPartnerId: 11, sellerName: "Fabricated Seller Pvt", sellerAddress: address }] }) };
  const text = JSON.stringify(await productWith(state).run({ style_id: "4321001" }));
  for (const secret of ["Fabricated Street", "000000", "Nowhere"]) assert.equal(text.includes(secret), false, secret);
});

test("get_product: ratings are rounded, the MRP falls back, and conversions are capped", async () => {
  const many = Array.from({ length: 9 }, (_, i) => ({ prefix: `P${i}`, sizeValue: String(i) }));
  const result = await productWith({ pdpData: pdp({ ratings: { averageRating: 4.26499, totalCount: 5 }, price: { discounted: 5 }, mrp: 10, sizes: [{ skuId: 1, label: "M", available: true, allSizesList: many }] }) }).run({ style_id: "4321001" });
  assert.deepEqual([result.rating, result.price, result.mrp], [4.26, 5, 10]);
  assert.equal(result.sizes[0].conversions.length, 6);
  const none = await productWith({ pdpData: pdp({ ratings: { averageRating: 0, totalCount: 0 }, price: undefined, mrp: undefined }) }).run({ style_id: "4321001" });
  assert.deepEqual([none.rating, none.price, none.mrp], [null, null, null]);
});

test("get_product: no private or seller-address fields are returned", async () => {
  const state = { pdpData: pdp({ manufacturer: "Fabricated Manufacturer Address Line", sellers: [{ sellerPartnerId: 11, sellerName: "Fabricated Seller Pvt", sellerAddress: { address: "1 Fabricated Street", pincode: "000000" } }] }), user: { email: "person@example.invalid" }, token: "fabricated-token" };
  const text = JSON.stringify(await productWith(state).run({ style_id: "4321001" }));
  for (const secret of ["Fabricated Manufacturer", "Fabricated Street", "000000", "person@example.invalid", "fabricated-token"]) assert.equal(text.includes(secret), false, secret);
});

test("get_product: an unknown style id is not_found and is not a success", async () => {
  const result = await productWith({ pdpData: null, pageName: "Pdp" }).run({ style_id: "999999999" });
  assert.deepEqual(result, { status: "not_found", style_id: "999999999" });
});

test("get_product: state parsing tolerates a trailing semicolon and ignores similarly named globals", async () => {
  assert.equal((await productWith({ pdpData: pdp() }, { tail: ";" }).run({ style_id: "4321001" })).status, "ok");
  const missing = harness("get_product", { respond: () => ({ body: `<script>window.__myx_apps__={"a":1};</script><p>no state</p>` }) });
  assert.equal((await missing.run({ style_id: "4321001" })).error_kind, "site_changed");
});

test("get_product: unexpected page states are site_changed, block pages are challenges", async () => {
  for (const state of [{ pageName: "Search" }, { pdpData: "text" }, { pdpData: [] }, { pdpData: { id: "abc" } }, []]) {
    const result = await productWith(state).run({ style_id: "4321001" });
    assert.deepEqual([result.status, result.error_kind], ["error", "site_changed"], JSON.stringify(state));
  }
  assert.equal((await harness("get_product", { respond: () => ({ body: `<script>window.__myx = {broken</script>` }) }).run({ style_id: "4321001" })).error_kind, "site_changed");
  assert.equal((await harness("get_product", { respond: () => ({ body: BLOCK_PAGE }) }).run({ style_id: "4321001" })).error_kind, "challenge");
  const long = "<html>" + "captcha ".repeat(4000) + "</html>";
  assert.equal((await harness("get_product", { respond: () => ({ body: long }) }).run({ style_id: "4321001" })).error_kind, "site_changed");
});

test("get_product: a sparse product still conforms to its schema", async () => {
  const result = await productWith({ pdpData: { id: 4321009, name: "Bare" } }).run({ style_id: "4321009" });
  assert.equal(result.status, "ok");
  assert.deepEqual([result.brand, result.price, result.rating, result.review_count, result.seller_count, result.sizes.length], [null, null, null, null, 0, 0]);
});

// --- get_product_reviews -----------------------------------------------------------------------------

const reviewsWith = (body, extra = {}) => harness("get_product_reviews", { respond: u => (u.pathname.startsWith("/gateway/v1/reviews/product/") ? { body, ...extra } : undefined) });

test("get_product_reviews: request shape, page 1 summary and mapped reviews without reviewer names", async () => {
  const items = Array.from({ length: 12 }, (_, i) => reviewItem(i));
  const h = reviewsWith(reviewsBody(items, summaryMeta()));
  const result = await h.run({ style_id: "4321001" });
  const url = new URL(h.calls[0].path, "https://www.myntra.com");
  assert.equal(url.pathname, "/gateway/v1/reviews/product/4321001");
  assert.deepEqual(Object.fromEntries(url.searchParams), { size: "12", sort: "0", rating: "0", page: "1", includeMetaData: "true" });
  assert.equal(h.calls[0].init.headers["X-myntraweb"], "Yes");
  assert.equal(result.status, "ok");
  assert.deepEqual([result.sort_by, result.stars, result.page, result.next_page], ["most_helpful", null, 1, 2]);
  assert.deepEqual(result.summary, { average_rating: 4.26, rating_count: 4276, review_count: 776, star_counts: [{ stars: 5, count: 2746 }, { stars: 4, count: 770 }, { stars: 1, count: 362 }] });
  assert.deepEqual(result.reviews[1], {
    review_id: "00000000-0000-0000-0000-000000000001", style_id: "4321002", stars: 2, text: "Fabricated review 1", upvotes: 3, downvotes: 0, size_bought: "7", image_count: 1, updated_at: "2026-07-01T22:25:00.000Z"
  });
  assert.equal(JSON.stringify(result).includes("Fabricated Reviewer"), false);
});

test("get_product_reviews: sort, star filter and later pages map to the site's parameters", async () => {
  const h = reviewsWith(reviewsBody([reviewItem(3), reviewItem(4)]));
  const result = await h.run({ style_id: "4321001", sort_by: "most_recent", stars: 3, page: 4 });
  const url = new URL(h.calls[0].path, "https://www.myntra.com");
  assert.deepEqual(Object.fromEntries(url.searchParams), { size: "12", sort: "1", rating: "3", page: "4", includeMetaData: "false" });
  assert.deepEqual([result.sort_by, result.stars, result.page, result.summary, result.next_page], ["most_recent", 3, 4, null, null]);
});

test("get_product_reviews: an empty list is no_results, whether the style has none or the page is past the end", async () => {
  const result = await reviewsWith(reviewsBody([], { reviewCount: "0", styleRating: { avgRating: 0, totalUserCount: 0, overallRatings: [] } })).run({ style_id: "999999999" });
  assert.deepEqual(result, { status: "no_results", style_id: "999999999", sort_by: "most_helpful", stars: null, page: 1, summary: { average_rating: null, rating_count: 0, review_count: 0, star_counts: [] } });
  const past = await reviewsWith(reviewsBody([])).run({ style_id: "4321001", page: 1000 });
  assert.deepEqual([past.status, past.page, past.summary], ["no_results", 1000, null]);
});

test("get_product_reviews: review text is sanitised and bounded, malformed entries are skipped", async () => {
  const items = [
    reviewItem(1, { review: "<b>Great</b>\u200b fit &amp; finish " + "x".repeat(2000), userRating: 5, images: undefined, styleAttribute: undefined, updatedAt: "garbage", upvotes: "many", id: undefined, style: undefined }),
    reviewItem(2, { userRating: 0 }), reviewItem(3, { userRating: 6 }), null, reviewItem(4, { review: "" })
  ];
  const result = await reviewsWith(reviewsBody(items)).run({ style_id: "4321001" });
  assert.equal(result.reviews.length, 2);
  const [first, second] = result.reviews;
  assert.equal(first.text.startsWith("Great fit & finish x"), true);
  assert.equal(first.text.length, 1500);
  assert.deepEqual([first.review_id, first.style_id, first.image_count, first.size_bought, first.updated_at, first.upvotes], [null, null, 0, null, null, null]);
  assert.equal(second.text, null);
  const onlyBad = await reviewsWith(reviewsBody([reviewItem(2, { userRating: 0 })])).run({ style_id: "4321001" });
  assert.deepEqual([onlyBad.status, onlyBad.error_kind], ["error", "site_changed"]);
});

test("get_product_reviews: truncation never leaves half of an emoji", async () => {
  const text = "a".repeat(1498) + "\ud83d\ude00 tail";
  const result = await reviewsWith(reviewsBody([reviewItem(1, { review: text })])).run({ style_id: "4321001" });
  assert.equal(result.reviews[0].text, "a".repeat(1498) + "\u2026");
  assert.equal(/[\ud800-\udfff]/.test(result.reviews[0].text), false);
});

test("text sanitiser: hostile long text is bounded in time and size", async () => {
  const hostile = ["<".repeat(400000), "<a".repeat(60000), "<script ".repeat(50000), "<!--".repeat(100000), "<p ".repeat(130000), "&#38;".repeat(200000), "&".repeat(400000)];
  const started = Date.now();
  for (const review of hostile) {
    const result = await reviewsWith(reviewsBody([reviewItem(1, { review })])).run({ style_id: "4321001" });
    assert.ok(result.reviews[0].text === null || result.reviews[0].text.length <= 1500);
  }
  assert.ok(Date.now() - started < 5000, `sanitising took ${Date.now() - started} ms`);
  const cut = await reviewsWith(reviewsBody([reviewItem(1, { review: "<b>".repeat(6666) + "x\ud83d\ude00tail" })])).run({ style_id: "4321001" });
  assert.equal(cut.reviews[0].text, "x");
  const plain = await reviewsWith(reviewsBody([reviewItem(1, { review: "x".repeat(19999) + "\ud83d\ude00tail" })])).run({ style_id: "4321001" });
  assert.equal(/[\ud800-\udfff]/.test(plain.reviews[0].text), false);
});

test("get_product_reviews: a missing or zero timestamp is null, not 1970", async () => {
  for (const updatedAt of [null, "", false, 0, "0", "abc", undefined, {}, "1782944700", 1782944700, "178294470000", "17829447000000", -1782944700000]) {
    const result = await reviewsWith(reviewsBody([reviewItem(1, { updatedAt })])).run({ style_id: "4321001" });
    assert.equal(result.reviews[0].updated_at, null, JSON.stringify(updatedAt));
  }
});

test("get_product_reviews: the summary is only returned on page 1 and the review style id is checked", async () => {
  const later = await reviewsWith(reviewsBody([reviewItem(1)], summaryMeta())).run({ style_id: "4321001", page: 2 });
  assert.equal(later.summary, null);
  const first = await reviewsWith(reviewsBody([reviewItem(1, { style: { id: "abc" } }), reviewItem(2, { style: { id: 4321005 } })], summaryMeta())).run({ style_id: "4321001" });
  assert.notEqual(first.summary, null);
  assert.deepEqual(first.reviews.map(r => r.style_id), [null, "4321005"]);
});

test("get_product_reviews: never returns more than a page of reviews", async () => {
  const result = await reviewsWith(reviewsBody(Array.from({ length: 30 }, (_, i) => reviewItem(i)))).run({ style_id: "4321001", page: 1000 });
  assert.equal(result.reviews.length, 12);
  assert.equal(result.next_page, null);
});

// --- nothing is ever written -----------------------------------------------------------------------

test("every tool only issues GET requests to www.myntra.com paths and never returns the session", async () => {
  const runs = [
    harness("search_products", { respond: okSearch() }).run({ query: "shoes", include_facets: true, filters: ["Brand:Puma"], min_price: 1, max_price: 2 }),
    productWith({ pdpData: pdp() }).run({ style_id: "4321001" }),
    reviewsWith(reviewsBody([reviewItem(1)], summaryMeta())).run({ style_id: "4321001" })
  ];
  for (const result of await Promise.all(runs)) assert.equal(result.status, "ok");
});
