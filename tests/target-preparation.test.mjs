import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../domains/target.com/prepare_cart_item.js", import.meta.url), "utf8");
const plain = value => JSON.parse(JSON.stringify(value));
const input = { tcin: "60000001", quantity: 2, fulfillment: "ship", expected_store_id: "1234", expected_postal_code: "45001" };
const cookie = "visitorId=FABRICATED; fiatsCookie=DSI_1234|DSZ_45000; GuestLocation=45001|39.1|-84.5|OH|US; idToken=SECRET-FIXTURE";
const product = () => ({ tcin: "60000001", item: { product_description: { title: "Fabricated item" }, fulfillment: { purchase_limit: 5 } }, price: { current_retail: 12.34, formatted_current_price: "$12.34" } });
const fulfillment = () => ({ tcin: "60000001", fulfillment: { sold_out: false, shipping_options: { availability_status: "IN_STOCK", services: [{ is_base_shipping_method: true, min_delivery_date: "2030-01-02", max_delivery_date: "2030-01-04" }] }, store_options: [{ location_id: "9999", order_pickup: { availability_status: "UNAVAILABLE" } }, { location_id: "1234", order_pickup: { availability_status: "LIMITED_STOCK", pickup_date: "2030-01-01" } }] } });

function conforms(schema, value) {
  if (schema.oneOf && schema.oneOf.filter(s => conforms(s, value)).length !== 1) return false;
  if ("const" in schema && value !== schema.const) return false;
  if (schema.enum && !schema.enum.includes(value)) return false;
  if (schema.type && ![schema.type].flat().some(t => t === "null" ? value === null : t === "integer" ? Number.isInteger(value) : t === "object" ? value !== null && typeof value === "object" && !Array.isArray(value) : typeof value === t)) return false;
  if (value !== null && typeof value === "object") {
    if (schema.required?.some(k => !Object.hasOwn(value, k))) return false;
    if (schema.additionalProperties === false && Object.keys(value).some(k => !(k in (schema.properties || {})))) return false;
    if (Object.entries(schema.properties || {}).some(([k, s]) => k in value && !conforms(s, value[k]))) return false;
  }
  if (typeof value === "string" && (value.length < (schema.minLength ?? 0) || value.length > (schema.maxLength ?? Infinity) || (schema.pattern && !new RegExp(schema.pattern).test(value)))) return false;
  if (typeof value === "number" && (value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity))) return false;
  return true;
}

function harness(options = {}) {
  const requests = [];
  let currentCookie = options.cookie ?? cookie;
  const page = new URL(options.url ?? "https://www.target.com/");
  const context = {
    URL, JSON, Object, Array, String, Number, Math,
    location: { origin: page.origin, pathname: page.pathname },
    document: { title: options.blocked ? "Access to this page has been denied" : "Target", querySelector: () => options.captcha ? {} : null, get cookie() { return currentCookie; } },
    window: { __CONFIG__: options.noKey ? {} : { defaultServicesApiKey: "fabricated-key" } },
    fetch: async (href, init) => {
      requests.push({ href, ...init });
      assert.equal(init.method, "GET");
      assert.equal(init.credentials, "include");
      assert.equal(new URL(href).origin, "https://redsky.target.com");
      assert.equal(href.includes("SECRET-FIXTURE"), false);
      if (options.throwFetch) throw new Error("SECRET-FIXTURE");
      if (options.onFetch) options.onFetch(requests.length);
      if (options.changeCookie) currentCookie = options.changeCookie;
      const status = options.status ?? 200;
      const p = new URL(href).pathname.endsWith("pdp_client_v1") ? options.product ?? product() : options.fulfillment ?? fulfillment();
      return { status, text: async () => options.raw ?? JSON.stringify(options.body ?? { data: { product: p } }) };
    }
  };
  if (options.pageTrap) {
    Object.defineProperty(context, "location", { get() { throw new Error("Page must not be accessed"); } });
    Object.defineProperty(context, "document", { get() { throw new Error("Page must not be accessed"); } });
    Object.defineProperty(context, "window", { get() { throw new Error("Page must not be accessed"); } });
  }
  const [definition] = runInNewContext(`(${source})`, context);
  const execute = runInNewContext(`(${definition.execute.toString()})`, context);
  return { definition, requests, run: async (data = input, signal) => {
    const result = plain(await execute(data, { signal }));
    assert.ok(conforms(definition.tool.outputSchema, result), JSON.stringify(result));
    assert.equal(JSON.stringify(result).includes("SECRET-FIXTURE"), false);
    return result;
  } };
}

test("prepare_cart_item is a single-expression read-only page tool with strict schemas", () => {
  const { definition } = harness();
  assert.equal(definition.kind, "page");
  assert.equal(definition.tool.name, "prepare_cart_item");
  assert.equal(definition.tool.annotations.readOnlyHint, true);
  assert.equal(definition.tool.annotations.idempotentHint, true);
  assert.equal(definition.tool.inputSchema.additionalProperties, false);
  assert.equal(source.trimEnd().endsWith(";"), false);
  assert.equal(/\b(gotoUrl|cdp|js|require|process|Buffer)\(/.test(source), false);
  assert.equal(/carts\.target\.com|idToken|accessToken|refreshToken|__NEXT_DATA__|confirmed/.test(source), false);
});

const invalid = [null, [], {}, { ...input, tcin: 60000001 }, { ...input, tcin: "1234" }, { ...input, tcin: " 60000001 " }, { ...input, quantity: 0 }, { ...input, quantity: 11 }, { ...input, quantity: 1.1 }, { ...input, quantity: "2" }, { ...input, fulfillment: "curbside" }, { ...input, expected_store_id: 1234 }, { ...input, expected_store_id: "" }, { ...input, expected_store_id: "12345678901" }, { ...input, expected_postal_code: "0000" }, { ...input, expected_postal_code: 45001 }, { ...input, extra: true }, { ...input, confirmed: true }];
for (const key of Object.keys(input)) { const data = { ...input }; delete data[key]; invalid.push(data); }
for (const data of invalid) test(`prepare_cart_item refuses malformed input before page access: ${JSON.stringify(data)}`, async () => {
  const h = harness({ pageTrap: true });
  assert.equal((await h.run(data)).error_kind, "invalid_input");
  assert.equal(h.requests.length, 0);
});

test("ship preview returns an item-only estimate, observed dates and no cart change", async () => {
  const h = harness();
  const result = await h.run();
  assert.deepEqual(result, { status: "prepared", tcin: input.tcin, quantity: 2, fulfillment: "ship",
    store_id: "1234", postal_code: "45001", title: "Fabricated item", unit_price_cents: 1234, item_subtotal_cents: 2468, purchase_limit: 5, availability_status: "IN_STOCK", min_delivery_date: "2030-01-02", max_delivery_date: "2030-01-04", pickup_date: null, product_url: "https://www.target.com/p/-/A-60000001", cart_changed: false });
});

test("pickup preview uses the selected store, never the first store", async () => {
  const h = harness();
  const result = await h.run({ ...input, fulfillment: "pickup" });
  assert.equal(result.status, "prepared");
  assert.equal(result.availability_status, "LIMITED_STOCK");
  assert.equal(result.pickup_date, "2030-01-01");
  assert.equal(result.min_delivery_date, null);
  assert.equal(result.max_delivery_date, null);
});

for (const [label, opts, data, kind] of [
  ["store mismatch", {}, { ...input, expected_store_id: "5678" }, "context_mismatch"],
  ["ZIP mismatch", {}, { ...input, expected_postal_code: "45002" }, "context_mismatch"],
  ["no store", { cookie: "visitorId=V; GuestLocation=45001" }, input, "no_store"],
  ["no ZIP", { cookie: "visitorId=V; fiatsCookie=DSI_1234" }, input, "no_location"],
  ["no config", { noKey: true }, input, "site_error"],
  ["no visitor", { cookie: "fiatsCookie=DSI_1234|DSZ_45001" }, input, "site_error"],
  ["captcha", { captcha: true }, input, "challenge"],
  ["block page", { blocked: true }, input, "challenge"]
]) test(`prepare_cart_item: ${label} refuses before requests`, async () => {
  const h = harness(opts);
  assert.equal((await h.run(data)).error_kind, kind);
  assert.equal(h.requests.length, 0);
});

for (const url of ["https://example.com/", "https://corporate.target.com/", "https://target.com/", "https://www.target.com/checkout", "https://www.target.com/co-review"]) test(`prepare_cart_item refuses unrelated or checkout page ${url}`, async () => {
  const h = harness({ url });
  assert.equal((await h.run()).error_kind, "wrong_page");
  assert.equal(h.requests.length, 0);
});
for (const url of ["https://www.target.com/", "https://www.target.com/cart", "https://www.target.com/p/-/A-60000001", "https://www.target.com/s?searchTerm=mug"]) test(`prepare_cart_item works without entry-page assumptions on ${url}`, async () => {
  assert.equal((await harness({ url }).run()).status, "prepared");
});

for (const [status, kind] of [[401, "login_required"], [403, "login_required"], [404, "not_found"], [429, "challenge"], [435, "challenge"], [500, "site_error"], [204, "site_error"]]) test(`prepare_cart_item: HTTP ${status} is ${kind}, no retries`, async () => {
  const h = harness({ status, body: { message: "SECRET-FIXTURE" } });
  assert.equal((await h.run()).error_kind, kind);
  assert.equal(h.requests.length, 1);
});
for (const body of [null, {}, { data: {} }, { data: { product: [] } }]) test(`prepare_cart_item refuses malformed response ${JSON.stringify(body)}`, async () => {
  assert.equal((await harness({ raw: JSON.stringify(body) }).run()).error_kind, "site_error");
});
test("prepare_cart_item detects an HTML block instead of claiming no results", async () => {
  assert.equal((await harness({ raw: "<html>px-captcha</html>" }).run()).error_kind, "challenge");
});

test("families and excessive per-order quantities stop before fulfillment reads", async () => {
  for (const [p, data, kind] of [[{ ...product(), children: [{ tcin: "60000002" }] }, input, "variant_required"], [product(), { ...input, quantity: 6 }, "quantity_limit"]]) {
    const h = harness({ product: p });
    assert.equal((await h.run(data)).error_kind, kind);
    assert.equal(h.requests.length, 1);
  }
});
test("a variation takes its price and the family's purchase limit", async () => {
  const p = { ...product(), tcin: "60000090", children: [{ tcin: input.tcin, price: { current_retail: 2 }, item: { product_description: { title: "Fabricated variation" } } }] };
  const result = await harness({ product: p }).run();
  assert.equal(result.status, "prepared");
  assert.equal(result.unit_price_cents, 200);
  assert.equal(result.purchase_limit, 5);
});
test("different item/availability ids cannot produce a preview", async () => {
  assert.equal((await harness({ product: { ...product(), tcin: "60000002" } }).run()).error_kind, "not_found");
  assert.equal((await harness({ fulfillment: { ...fulfillment(), tcin: "60000002" } }).run()).error_kind, "site_error");
});
for (const status of ["UNAVAILABLE", "OUT_OF_STOCK", "NOT_SOLD_IN_STORE", "NEW_STATUS"]) test(`unavailable fulfillment ${status} is not prepared`, async () => {
  const f = fulfillment(); f.fulfillment.shipping_options.availability_status = status;
  assert.equal((await harness({ fulfillment: f }).run()).error_kind, "unavailable");
});
test("missing selected-store fulfillment is an explicit error", async () => {
  const f = fulfillment(); f.fulfillment.store_options = f.fulfillment.store_options.slice(0, 1);
  assert.equal((await harness({ fulfillment: f }).run({ ...input, fulfillment: "pickup" })).error_kind, "site_error");
});
test("sold-out fulfillment cannot produce a preview", async () => {
  const f = fulfillment(); f.fulfillment.sold_out = true;
  assert.equal((await harness({ fulfillment: f }).run()).error_kind, "unavailable");
});
for (const price of [{}, { current_retail: -1 }, { current_retail: "12.34" }, { current_retail: 12, formatted_current_price: "$12-$20" }]) test(`price ${JSON.stringify(price)} is not fabricated from text`, async () => {
  const result = await harness({ product: { ...product(), price } }).run();
  assert.equal(result.unit_price_cents, null);
  assert.equal(result.item_subtotal_cents, null);
});
test("bounds and canonical URL prevent response URL or extra-state leakage", async () => {
  const p = product(); p.item.product_description.title = "x".repeat(500); p.item.enrichment = { buy_url: "https://evil.example/?token=SECRET-FIXTURE" };
  const f = fulfillment(); f.fulfillment.shipping_options.services[0].min_delivery_date = "x".repeat(500);
  const result = await harness({ product: p, fulfillment: f }).run();
  assert.equal(result.title.length, 300);
  assert.equal(result.min_delivery_date.length, 40);
  assert.equal(result.product_url, "https://www.target.com/p/-/A-60000001");
  assert.ok(JSON.stringify(result).length < 1500);
});
test("context changes during requests invalidate a preview", async () => {
  assert.equal((await harness({ changeCookie: cookie.replace("DSI_1234", "DSI_5678") }).run()).error_kind, "context_mismatch");
});
test("cancellation stops before interaction and between the two reads", async () => {
  const canceled = new AbortController(); canceled.abort();
  const h = harness({ pageTrap: true });
  assert.equal((await h.run(input, canceled.signal)).error_kind, "canceled");
  assert.equal(h.requests.length, 0);
  const midway = new AbortController();
  const m = harness({ onFetch: () => midway.abort() });
  assert.equal((await m.run(input, midway.signal)).error_kind, "canceled");
  assert.equal(m.requests.length, 1);
});
test("fetch exceptions are sanitized, and no retries are attempted", async () => {
  const h = harness({ throwFetch: true });
  assert.equal((await h.run()).error_kind, "site_error");
  assert.equal(h.requests.length, 1);
});
test("request parameters use only the exact current store/ZIP and public visitor context", async () => {
  const h = harness(); await h.run();
  assert.equal(h.requests.length, 2);
  for (const request of h.requests) {
    const params = new URL(request.href).searchParams;
    assert.equal(params.get("tcin"), input.tcin);
    assert.equal(params.get("store_id"), input.expected_store_id);
    assert.equal(params.get("zip"), input.expected_postal_code);
    assert.equal(params.get("key"), "fabricated-key");
  }
});
