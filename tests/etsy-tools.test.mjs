import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createContext, runInContext, runInNewContext } from "node:vm";
import { Document, DOMParser } from "./etsy-dom.mjs";

// Harness for the etsy.com tools. Browser helpers are stubbed and every page-side function runs, from its
// source, against fabricated HTML fixtures with a fake fetch; nothing here contacts the live site.
const NAMES = ["search", "get_listing", "get_cart", "add_to_cart", "update_cart_item", "get_favorite_status", "set_favorite"];
// Only tools that navigate and return rich results from the page they navigated to are cdp; the rest run in the page.
const KINDS = { search: "cdp", add_to_cart: "cdp", get_listing: "page", get_cart: "page", update_cart_item: "page", get_favorite_status: "page", set_favorite: "page" };
const sources = Object.fromEntries(NAMES.map(name => [name, readFileSync(new URL(`../domains/etsy.com/${name}.js`, import.meta.url), "utf8")]));
const fixture = name => readFileSync(new URL(`./fixtures/etsy/${name}.html`, import.meta.url), "utf8");
const plain = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const registry = JSON.parse(readFileSync(new URL("../registry.json", import.meta.url), "utf8"));
const ORIGIN = "https://www.etsy.com";

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
  if (schema.anyOf && !schema.anyOf.some(s => conforms(s, value))) return false;
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) return false;
    if (schema.maxItems !== undefined && value.length > schema.maxItems) return false;
    if (schema.uniqueItems && new Set(value.map(v => JSON.stringify(v))).size !== value.length) return false;
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

// A cart held by the fake site: lines are rendered into cart HTML on every GET /cart.
function renderCart(lines, { signedIn = false } = {}) {
  if (!lines.length) return fixture("cart-empty");
  const items = lines.map(l => `<div><input type="hidden" name="cart_ids[]" value="${l.cart}"><a data-selector="shop-name">${l.shop || "ExampleShop"}</a><ul>
    <li data-cart-listing="" data-listing-id="${l.listing}" data-listing-customization-id="${l.cust}" data-listing-inventory-id="${l.inv}" data-listing-unit-price="${l.price ?? 10}" data-listing-regular-price="${l.price ?? 10}" data-listing-quantity="${l.qty}" data-listing-title="${l.title || "Fabricated item"}" data-listing-available="true">
      <a href="/listing/${l.listing}/x">x</a>${(l.props || []).map(p => `<p>${p}</p>`).join("")}
      ${l.max === null ? "" : `<select name="listing-quantity">${Array.from({ length: l.max ?? 5 }, (_, i) => `<option value="${i + 1}">${i + 1}</option>`).join("")}</select>`}
      <a data-listing-key="${l.cart}|${l.listing}|${l.inv}|${l.cust}">Save for later</a></li></ul></div>`).join("");
  return `<html><head><meta name="csrf_nonce" content="3:1:fabricated-cart-token:123"><script>Etsy.Context = {"data":{"user_id":${signedIn ? 12345 : null}}};</script></head><body><main>${items}
    <table><tr><td>Item(s) total</td><td>$99.00</td></tr><tr><td>Subtotal</td><td>$90.00</td></tr></table></main></body></html>`;
}

function harness(name, options = {}) {
  const calls = { navigations: [], requests: [], clicks: [], fills: [], waits: 0, js: 0 };
  // Resource timing: the buffer stays empty (full, as on real listing pages); only observers see new requests.
  const observers = new Set();
  const performance = { getEntriesByType: () => [] };
  class PerformanceObserver { constructor(cb) { this.cb = cb; } observe() { observers.add(this); } disconnect() { observers.delete(this); } }
  const site = {
    recordResource: name => { for (const o of observers) o.cb({ getEntries: () => [{ name }] }); },
    observers,
    pages: { "/": "<html><body><main>Home</main></body></html>", "/cart": null, ...(options.pages || {}) },
    cart: plain(options.cart || []),
    signedIn: options.signedIn ?? false,
    favorites: new Set(options.favorites || []),
    responses: options.responses || (() => null)
  };
  let url = options.url ?? `${ORIGIN}/`;
  let doc = null;
  const waiters = [];
  const emit = event => { for (const w of waiters.splice(0)) { if (w.predicate(event)) w.resolve(event); else waiters.push(w); } };
  const window = { Etsy: { Context: { data: { user_id: null, locale_settings: { currency: { code: "USD" }, language: { code: "en-US" }, region: { code: "US" } } } } } };
  const location = {};
  const setUrl = next => {
    url = next;
    const u = new URL(next);
    Object.assign(location, { href: u.href, origin: u.origin, pathname: u.pathname, host: u.host, hostname: u.hostname, search: u.search });
    const missing = "<html><head><title>Etsy</title></head><body><h1>Uh oh!</h1><p>Sorry, the page you were looking for was not found.</p></body></html>";
    const html = u.hostname !== "www.etsy.com" ? "<html><body>other site</body></html>"
      : u.pathname === "/cart" ? renderCart(site.cart, { signedIn: site.signedIn })
      : site.pages[u.pathname] ?? (u.pathname.startsWith("/listing/") ? missing : site.pages["/"]);
    doc = new Document(html);
    window.Etsy.Context.data.user_id = site.signedIn ? 12345 : null;
    if (options.onPage) options.onPage(doc, u.pathname, site);
  };
  setUrl(url);
  const response = (status, body, finalUrl) => ({ status, url: finalUrl, ok: status < 400, text: async () => body, json: async () => JSON.parse(body) });
  const fetch = async (target, init = {}) => {
    const u = new URL(target, location.origin);
    const method = (init.method || "GET").toUpperCase();
    calls.requests.push({ method, path: u.pathname + u.search, headers: init.headers || {}, body: init.body ?? null });
    const forced = site.responses(u, method, init, site);
    if (forced) return response(forced.status, forced.body, forced.url || u.href);
    if (location.hostname !== "www.etsy.com") return response(404, "not found", u.href);
    if (method === "GET" && u.pathname === "/cart") return response(200, renderCart(site.cart, { signedIn: site.signedIn }), u.href);
    if (method === "GET" && u.pathname.startsWith("/listing/")) {
      const id = u.pathname.split("/")[2];
      const html = site.pages[`/listing/${id}`];
      return html ? response(200, html, `${ORIGIN}/listing/${id}/fabricated-slug`) : response(404, "<html><body>gone</body></html>", u.href);
    }
    const m = u.pathname.match(/^\/api\/v3\/ajax\/bespoke\/member\/checkout\/cart-list\/(\d+)\/cart\/(\d+)\/listing\/(\d+)\/inventory\/(\d+)\/customization\/(\d+)\/(quantity|remove)$/);
    if (method === "POST" && m) {
      const line = site.cart.find(l => String(l.cart) === m[1] && String(l.listing) === m[3] && String(l.inv) === m[4] && String(l.cust) === m[5]);
      if (!line) return response(404, "{\"error\":\"not found\"}", u.href);
      if (m[6] === "remove") site.cart = site.cart.filter(l => l !== line);
      else line.qty = Number(new URLSearchParams(init.body).get("listing_quantity"));
      return response(200, "{\"cart_html\":\"<div></div>\"}", u.href);
    }
    if (method === "GET" && u.pathname === "/api/v3/ajax/member/users/listings-favorites-collections-map") {
      if (!site.signedIn) return response(401, "{}", u.href);
      const ids = u.searchParams.getAll("listing_ids[]");
      const map = Object.fromEntries(ids.filter(id => site.favorites.has(id)).map(id => [id, ["fav-key"]]));
      return response(200, JSON.stringify({ map, favorites_key: "fav-key" }), u.href);
    }
    return response(404, "not found", u.href);
  };
  const pageContext = createContext({
    window, location, fetch, DOMParser, URL, URLSearchParams, performance, PerformanceObserver, setTimeout: (fn) => setImmediate(fn),
    get document() { return doc; },
    Event: class { constructor(type, init = {}) { this.type = type; this.bubbles = !!init.bubbles; } },
    getComputedStyle: () => ({ visibility: "visible" })
  });
  const helpers = {
    URL, JSON,
    pageInfo: async () => ({ url, title: doc.title, ready_state: "complete" }),
    gotoUrl: async next => { calls.navigations.push(next); setUrl(next); return { frameId: "f" }; },
    waitForLoad: async () => true,
    waitMs: async () => { calls.waits++; },
    js: async (fn, opts = {}) => {
      calls.js++;
      const f = runInContext(`(${fn.toString()})`, pageContext);
      return plain(await f(opts.arg === undefined ? undefined : plain(opts.arg)));
    },
    fillInput: async (selector, text) => {
      calls.fills.push({ selector, text });
      const el = doc.querySelector(selector);
      if (!el) throw new Error("fillInput: no element " + selector);
      el.value = text;
      el.dispatchEvent({ type: "input", bubbles: true });
      el.dispatchEvent({ type: "change", bubbles: true });
    },
    waitForEvent: (method, { predicate }) => new Promise(resolve => waiters.push({ predicate: e => e.method === method && predicate(e), resolve })),
    click: async target => {
      calls.clicks.push(target);
      if (!doc.querySelector(target)) throw new Error("click: no element " + target);
      if (options.onClick) await options.onClick({ target, site, emit, doc, setUrl });
      setImmediate(() => { for (const w of waiters.splice(0)) w.resolve(null); });
    }
  };
  const [definition] = runInNewContext(`(${sources[name]})`, helpers);
  // Page tools run in the document, re-created from their source the way the runtime does it.
  const execute = definition.kind === "page" ? runInContext(`(${definition.execute.toString()})`, pageContext) : definition.execute;
  return {
    definition, calls, site, emit, performance, doc: () => doc,
    run: async input => {
      const result = plain(await execute(input, { signal: new AbortController().signal }));
      assert.ok(conforms(definition.tool.outputSchema, result), `${name} output violates its schema: ${JSON.stringify(result)}`);
      return result;
    }
  };
}

// Simulates Etsy's buy-box script: records personalization text/dropdown choices and quantity in the hidden form fields.
function etsyBuyBox(doc) {
  const form = doc.querySelector('form[action*="/cart/listing.php"] input[name="multiple_personalizations"]');
  const update = (id, patch) => {
    if (!form) return;
    const list = JSON.parse(form.value);
    Object.assign(list.find(e => String(e.id) === id) || {}, patch);
    form.value = JSON.stringify(list);
  };
  doc.addEventListener("input", e => {
    const t = e.target;
    if (t.localName === "textarea" && t.id.startsWith("perso-input-")) update(t.id.slice("perso-input-".length), { response: t.value });
    if (t.localName === "select" && t.id.startsWith("perso-dropdown-")) update(t.id.slice("perso-dropdown-".length), { option_id: Number(t.value) });
  });
  doc.addEventListener("change", e => {
    if (e.target.id === "listing-page-quantity-select") doc.querySelector('form[action*="/cart/listing.php"] input[name="quantity"]').value = e.target.value;
  });
}
const listingPages = {
  "/listing/1000000001": fixture("listing-classic"),
  "/listing/1000000002": fixture("listing-offerings"),
  "/listing/1000000003": fixture("listing-plain"),
  "/listing/1000000004": fixture("listing-offerings").replaceAll("1000000002", "1000000004").replace('data-is-required="false" data-field-type="unlabeled_upload"', 'data-is-required="true" data-field-type="unlabeled_upload"')
};
const onListing = (doc, path) => { if (path.startsWith("/listing/")) etsyBuyBox(doc); };
const COLLAR = { listing_id: "1000000001", variations: [{ name: "Size & Color", option: "M - Black" }, { name: "Text Preference", option: "Gold Text" }], personalization: [{ field: "Personalization", value: "FIDO" }] };
// Adds a line the way Etsy does after a successful submission.
const addsLine = (kind, line) => async ({ site, emit }) => {
  emit({ method: "Network.requestWillBeSent", params: { request: { method: "POST", url: kind === "form" ? `${ORIGIN}/cart/listing.php` : `${ORIGIN}/api/v3/ajax/member/carts/add` } } });
  const existing = site.cart.find(l => l.inv === line.inv && l.cust === line.cust);
  if (existing) existing.qty += line.qty; else site.cart.push({ ...line });
};

// --- file and registry contract --------------------------------------------------------------------

for (const name of NAMES) {
  test(`${name}: single-expression CDP tool with typed schemas and a registry entry`, () => {
    assert.equal(sources[name].trimEnd().endsWith(";"), false);
    assert.equal(/\b(Buffer|require|process)\b/.test(sources[name]), false, "tool source must not depend on Node globals");
    const { definition } = harness(name);
    assert.equal(definition.kind, KINDS[name]);
    assert.equal(definition.tool.name, name);
    assert.deepEqual(plain(definition.match.url_patterns), ["https://www.etsy.com/*"]);
    if (definition.kind === "page") assert.doesNotThrow(() => new Function(`return (${definition.execute.toString()})`), "a page tool's execute must re-parse from its source");
    assert.equal(definition.tool.inputSchema.type, "object");
    assert.equal(definition.tool.inputSchema.additionalProperties, false);
    assert.equal(definition.tool.outputSchema.type, "object");
    assert.ok(definition.tool.description.length > 200);
    const entry = registry.tools.find(t => t.domain === "etsy.com" && t.tool === name);
    assert.ok(entry, "registry entry missing");
    assert.equal(entry.file, `domains/etsy.com/${name}.js`);
    assert.equal(entry.kind, definition.kind);
    assert.deepEqual(entry.url_patterns, plain(definition.match.url_patterns));
    assert.ok(!/\/checkout|place.?order/i.test(sources[name].replace(/\/api\/v3\/ajax\/bespoke\/member\/checkout\/cart-list/g, "")), "tools must not reference checkout pages");
  });
}

test("registry lists every etsy.com tool exactly once", () => {
  assert.deepEqual(registry.tools.filter(t => t.domain === "etsy.com").map(t => t.tool).sort(), [...NAMES].sort());
});

// --- input validation happens before any page access -----------------------------------------------

const invalidInputs = {
  search: [undefined, null, [], {}, { query: "" }, { query: "   " }, { query: 7 }, { query: "x".repeat(201) }, { query: "vase", page: 0 }, { query: "vase", page: 1.5 }, { query: "vase", max_results: 65 }, { query: "vase", min_price: -1 }, { query: "vase", min_price: 50, max_price: 10 }, { query: "vase", sort: "cheapest" }, { query: "vase", free_shipping: "yes" }, { query: "vase", color: "blue" }],
  get_listing: [undefined, {}, { listing_id: 1000000001 }, { listing_id: "abc" }, { listing_id: "123" }, { listing_id: "1000000001", description_max_chars: -1 }, { listing_id: "1000000001", extra: true }],
  get_cart: [[], { extra: true }, "cart"],
  add_to_cart: [undefined, {}, { listing_id: "x1" }, { listing_id: "1000000001", quantity: 0 }, { listing_id: "1000000001", quantity: 11 }, { listing_id: "1000000001", quantity: "2" }, { listing_id: "1000000001", variations: {} }, { listing_id: "1000000001", variations: [{ option: "M" }] }, { listing_id: "1000000001", variations: [{ name: "Size", option: "" }] }, { listing_id: "1000000001", variations: [{ name: "Size", option: "M", extra: 1 }] }, { listing_id: "1000000001", personalization: [{ field: "Name" }] }, { listing_id: "1000000001", personalization: [{ value: "" }] }, { listing_id: "1000000001", gift_wrap: true }],
  update_cart_item: [undefined, {}, { line_id: "1|2|3|4" }, { quantity: 1 }, { line_id: "1|2|3", quantity: 1 }, { line_id: "a|b|c|d", quantity: 1 }, { line_id: "1|2|3|4", quantity: -1 }, { line_id: "1|2|3|4", quantity: 1.5 }, { line_id: "1|2|3|4", quantity: 1000 }, { line_id: "1|2|3|4", quantity: 1, extra: 1 }],
  get_favorite_status: [undefined, {}, { listing_ids: [] }, { listing_ids: ["abc"] }, { listing_ids: ["1000000001", "1000000001"] }, { listing_ids: Array.from({ length: 51 }, (_, i) => String(1000000000 + i)) }, { listing_ids: ["1000000001"], extra: 1 }],
  set_favorite: [undefined, {}, { listing_id: "1000000001" }, { favorited: true }, { listing_id: "1000000001", favorited: "yes" }, { listing_id: "x", favorited: true }, { listing_id: "1000000001", favorited: true, collection: "a" }]
};
for (const [name, inputs] of Object.entries(invalidInputs)) {
  for (const input of inputs) {
    test(`${name}: rejects ${JSON.stringify(input) ?? "undefined"} before touching the page`, async () => {
      const h = harness(name);
      // Cross-field rules (min above max, blank personalization) are enforced by the tool only.
      const schemaCanTell = !(name === "search" && input?.min_price > input?.max_price);
      if (schemaCanTell && input && typeof input === "object" && !Array.isArray(input)) assert.equal(conforms(h.definition.tool.inputSchema, input), false, "input schema should reject it too");
      const result = await h.run(input);
      assert.equal(result.status, "error");
      assert.equal(result.error_kind, "invalid_input");
      if ("mutation_attempted" in result) assert.equal(result.mutation_attempted, false);
      assert.deepEqual(h.calls.navigations, []);
      assert.deepEqual(h.calls.requests, []);
      assert.equal(h.calls.js, 0);
    });
  }
}

// --- search --------------------------------------------------------------------------------------------

test("search: builds the results URL from filters and reads organic cards in order", async () => {
  const h = harness("search", { pages: { "/search": fixture("search") } });
  const result = await h.run({ query: "  blue   vase ", min_price: 10, max_price: 50, sort: "price_low_to_high", free_shipping: true, page: 1 });
  assert.equal(result.status, "ok");
  assert.equal(h.calls.navigations[0], `${ORIGIN}/search?q=blue+vase&min=10&max=50&order=price_asc&free_shipping=true`);
  assert.equal(result.query, "blue vase");
  assert.equal(result.cards_on_page, 3, "duplicates and non-search cards are not counted");
  assert.equal(result.has_next_page, true);
  assert.deepEqual(result.listings.map(l => l.listing_id), ["1000000012", "1000000013"], "ads are excluded by default");
  const [vase, tall] = result.listings;
  assert.equal(vase.url, `${ORIGIN}/listing/1000000012/fabricated-blue-vase`);
  assert.equal(vase.title, "Fabricated Blue Vase, Handmade");
  assert.equal(vase.shop_name, "ExamplePottery");
  assert.equal(vase.price, 29.35);
  assert.equal(vase.price_text, "$29.35");
  assert.equal(vase.original_price, 58.7);
  assert.equal(vase.discount_percent, 50);
  assert.equal(vase.free_shipping, true);
  assert.equal(vase.shop_rating, 4.9);
  assert.equal(vase.shop_review_count_text, "(1.2k)");
  assert.deepEqual(vase.badges, ["Bestseller"]);
  assert.equal(tall.price, 1250);
  assert.equal(tall.original_price, null);
});

test("search: include_ads keeps sponsored cards and marks them", async () => {
  const result = await harness("search", { pages: { "/search": fixture("search") } }).run({ query: "vase", include_ads: true, max_results: 2 });
  assert.deepEqual(result.listings.map(l => [l.listing_id, l.is_ad]), [["1000000011", true], ["1000000012", false]]);
  assert.equal(result.listings[0].shop_name, "ExampleAdShop");
});

test("search: page > 1 is requested and a missing next link is reported", async () => {
  const h = harness("search", { pages: { "/search": fixture("search").replace(/<nav[\s\S]*<\/nav>/, "") } });
  const result = await h.run({ query: "vase", page: 3 });
  assert.equal(h.calls.navigations[0], `${ORIGIN}/search?q=vase&page=3`);
  assert.equal(result.has_next_page, false);
});

test("search: a bot-protection page is reported as blocked", async () => {
  const h = harness("search", { pages: { "/search": "<html><body><iframe src=\"https://geo.captcha-delivery.com/captcha/?x=1\"></iframe></body></html>" } });
  assert.equal((await h.run({ query: "vase" })).error_kind, "blocked");
});

test("search: an empty results page is ok with no listings, an unrecognized page is site_changed", async () => {
  const empty = await harness("search", { pages: { "/search": "<html><body><main><p>We couldn't find any results for this search.</p></main></body></html>" } }).run({ query: "vase" });
  assert.equal(empty.status, "ok");
  assert.deepEqual(empty.listings, []);
  const odd = await harness("search", { pages: { "/search": "<html><body><main>Something else</main></body></html>" } }).run({ query: "vase" });
  assert.equal(odd.error_kind, "site_changed");
});

// --- get_listing -------------------------------------------------------------------------------------

test("get_listing: reads price, variations, sold-out options and personalization rules", async () => {
  const h = harness("get_listing", { pages: listingPages });
  const result = await h.run({ listing_id: "1000000001" });
  assert.equal(result.status, "ok");
  assert.deepEqual(h.calls.navigations, [], "already on www.etsy.com, so no navigation");
  assert.deepEqual(h.calls.requests.map(r => r.path), ["/listing/1000000001"]);
  assert.equal(result.title, "Fabricated Leather Pet Collar & Tag");
  assert.equal(result.url, `${ORIGIN}/listing/1000000001/fabricated-slug`);
  assert.equal(result.shop_name, "ExampleLeatherCo");
  assert.equal(result.price, 18);
  assert.equal(result.price_text, "$18.00+");
  assert.equal(result.original_price_text, "$30.00+");
  assert.equal(result.price_varies, true);
  assert.equal(result.currency, "USD");
  assert.equal(result.in_stock, true);
  assert.equal(result.can_add_to_cart, true);
  assert.equal(result.rating, 4.8);
  assert.equal(result.rating_count, 118);
  assert.equal(result.description, "A fabricated collar.\nMade for tests & fixtures only.");
  assert.equal(result.images.length, 2);
  assert.deepEqual(result.quantity, { selectable: true, max: 3 });
  assert.equal(result.signed_in, false);
  assert.deepEqual(result.variations.map(v => v.name), ["Size & Color", "Text Preference"]);
  assert.deepEqual(result.variations[0].options, [
    { option_id: "111", label: "S - Black", display_text: "S - Black ($18.00 - $21.00)", price_text: "$18.00 - $21.00", sold_out: false },
    { option_id: "112", label: "M - Black", display_text: "M - Black ($25.20 - $28.20)", price_text: "$25.20 - $28.20", sold_out: false },
    { option_id: "113", label: "L - Black", display_text: "L - Black [Sold out]", price_text: null, sold_out: true },
    { option_id: "114", label: "XL - Black", display_text: "XL - Black [Sold out, waitlist available]", price_text: null, sold_out: true }
  ]);
  assert.deepEqual(result.variations[1].options.map(o => [o.label, o.price_text]), [["No Text", null], ["Gold Text", "$3.00"], ["Set (2 pack)", null]], "a non-price parenthetical stays in the label");
  assert.deepEqual(result.personalization, {
    available: true, required: true, supported: true,
    fields: [{ field_id: "501", type: "text_input", label: "Personalization", required: true, max_chars: 20, instructions: "Enter the pet name. Up to 15 characters.", options: null }]
  });
});

test("get_listing: dropdown and upload fields; no quantity menu means quantity 1", async () => {
  const result = await harness("get_listing", { pages: listingPages }).run({ listing_id: "1000000002", description_max_chars: 0 });
  assert.equal(result.description, null);
  assert.deepEqual(result.quantity, { selectable: false, max: 1 });
  assert.equal(result.price_varies, false);
  assert.deepEqual(result.personalization.fields.map(f => [f.type, f.required, f.max_chars]), [["text_input", true, 10], ["dropdown", true, null], ["unlabeled_upload", false, null]]);
  assert.deepEqual(result.personalization.fields[1].options, [{ option_id: "811", label: "Bottom right" }, { option_id: "812", label: "Center" }]);
  assert.equal(result.personalization.supported, true, "the upload field is optional");
});

test("get_listing: a required upload field makes personalization unsupported", async () => {
  const pages = { "/listing/1000000002": fixture("listing-offerings").replace('data-is-required="false" data-field-type="unlabeled_upload"', 'data-is-required="true" data-field-type="unlabeled_upload"') };
  assert.equal((await harness("get_listing", { pages }).run({ listing_id: "1000000002" })).personalization.supported, false);
});

test("get_listing: missing, redirected, throttled and blocked listings are typed errors", async () => {
  assert.equal((await harness("get_listing", { pages: listingPages }).run({ listing_id: "1234567890" })).error_kind, "listing_not_found");
  const redirect = () => ({ status: 200, body: fixture("search"), url: `${ORIGIN}/search?q=gone` });
  assert.equal((await harness("get_listing", { responses: (u) => u.pathname.startsWith("/listing/") ? redirect() : null }).run({ listing_id: "1000000001" })).error_kind, "listing_not_found");
  assert.equal((await harness("get_listing", { responses: () => ({ status: 429, body: "slow down" }) }).run({ listing_id: "1000000001" })).error_kind, "throttled");
  assert.equal((await harness("get_listing", { responses: () => ({ status: 403, body: "<html><script src=\"https://ct.captcha-delivery.com/c.js\"></script></html>" }) }).run({ listing_id: "1000000001" })).error_kind, "blocked");
});

for (const name of ["get_listing", "get_cart", "update_cart_item", "get_favorite_status", "set_favorite"]) {
  const input = { get_listing: { listing_id: "1000000001" }, get_cart: {}, update_cart_item: { line_id: "1|2|3|4", quantity: 0 }, get_favorite_status: { listing_ids: ["1000000001"] }, set_favorite: { listing_id: "1000000001", favorited: true } }[name];
  test(`${name}: outside www.etsy.com it is wrong_page without any request`, async () => {
    for (const url of ["https://example.com/", "https://help.etsy.com/hc/en-us"]) {
      const h = harness(name, { url, pages: listingPages, signedIn: true });
      const result = await h.run(input);
      assert.equal(result.error_kind, "wrong_page");
      if ("mutation_attempted" in result) assert.equal(result.mutation_attempted, false);
      assert.deepEqual(h.calls.requests, []);
      assert.deepEqual(h.calls.navigations, []);
    }
  });
}

// --- get_cart -----------------------------------------------------------------------------------------

test("get_cart: parses lines, line ids, options and totals; skips saved-for-later", async () => {
  const h = harness("get_cart", { responses: (u) => u.pathname === "/cart" ? { status: 200, body: fixture("cart") } : null });
  const result = await h.run({});
  assert.equal(result.status, "ok");
  assert.equal(result.line_count, 2);
  assert.equal(result.item_count, 3);
  assert.equal(result.items_total_text, "$132.68");
  assert.equal(result.subtotal_text, "$96.40");
  const [collar, vase] = result.lines;
  assert.deepEqual(collar, {
    line_id: "9000000001|1000000001|6000000001|7000000001", cart_id: "9000000001", listing_id: "1000000001", inventory_id: "6000000001", customization_id: "7000000001",
    title: "Fabricated Leather Pet Collar & Tag", shop_name: "ExampleLeatherCo", quantity: 2, max_quantity: 4, unit_price: 27.2, regular_price: 45.34, available: true,
    properties: [{ name: "Size & Color", value: "M - Black" }, { name: "Text Preference", value: "Gold Text" }, { name: "Personalization", value: "FIDO" }],
    url: `${ORIGIN}/listing/1000000001/fabricated-leather-pet-collar`
  });
  assert.equal(vase.line_id, "9000000002|1000000003|6000000003|0", "line without a listing key falls back to the shop's cart id");
  assert.equal(vase.available, false);
  assert.equal(vase.max_quantity, null);
  assert.deepEqual(vase.properties, []);
});

test("get_cart: cart items that cannot be read are site_changed, not an empty cart", async () => {
  const counted = "<html><head><script>Etsy.Context = {\"data\":{\"user_id\":null,\"in_cart_count\":2}};</script></head><body><main><div class=\"new-layout\">item</div><h2 hidden>Your cart is empty.</h2></main></body></html>";
  assert.equal((await harness("get_cart", { responses: u => u.pathname === "/cart" ? { status: 200, body: counted } : null }).run({})).error_kind, "site_changed");
  const unreadable = fixture("cart").replace('data-listing-inventory-id="6000000003"', 'data-listing-inventory-id=""');
  assert.equal((await harness("get_cart", { responses: u => u.pathname === "/cart" ? { status: 200, body: unreadable } : null }).run({})).error_kind, "site_changed");
});

test("get_cart: an empty cart and an accepted empty input object", async () => {
  const result = await harness("get_cart").run({});
  assert.deepEqual(result, { status: "ok", signed_in: false, line_count: 0, item_count: 0, items_total_text: null, subtotal_text: null, lines: [] });
  assert.equal((await harness("get_cart").run(undefined)).status, "ok");
});


// --- add_to_cart: requirement checks never submit -------------------------------------------------------

const refusals = [
  ["no variations", { listing_id: "1000000001" }, "variation_required"],
  ["one of two variations", { listing_id: "1000000001", variations: [COLLAR.variations[0]], personalization: COLLAR.personalization }, "variation_required"],
  ["near-miss option label", { ...COLLAR, variations: [{ name: "Size & Color", option: "M-Black" }, COLLAR.variations[1]] }, "variation_option_not_found"],
  ["sold-out option", { ...COLLAR, variations: [{ name: "Size & Color", option: "L - Black" }, COLLAR.variations[1]] }, "variation_option_unavailable"],
  ["sold-out option with a waitlist", { ...COLLAR, variations: [{ name: "Size & Color", option: "XL - Black" }, COLLAR.variations[1]] }, "variation_option_unavailable"],
  ["unknown variation", { ...COLLAR, variations: [...COLLAR.variations, { name: "Buckle", option: "Gold" }] }, "unknown_variation"],
  ["duplicate variation", { ...COLLAR, variations: [...COLLAR.variations, { name: "size & color", option: "S - Black" }] }, "invalid_input"],
  ["missing required personalization", { ...COLLAR, personalization: [] }, "personalization_required"],
  ["blank required personalization", { ...COLLAR, personalization: [{ value: "   " }] }, "personalization_required"],
  ["too-long personalization", { ...COLLAR, personalization: [{ value: "x".repeat(21) }] }, "personalization_too_long"],
  ["unknown personalization field", { ...COLLAR, personalization: [{ field: "Back side", value: "A" }] }, "unknown_personalization_field"],
  ["quantity over the menu", { ...COLLAR, quantity: 4 }, "quantity_unavailable"],
  ["personalization on a listing without it", { listing_id: "1000000003", personalization: [{ value: "A" }] }, "personalization_not_offered"],
  ["quantity 2 without a quantity menu", { listing_id: "1000000003", quantity: 2 }, "quantity_unavailable"],
  ["dropdown value not among options", { listing_id: "1000000002", variations: [{ name: "Engraving Style", option: "Initials" }], personalization: [{ field: "Names or Initials", value: "AB" }, { field: "Engraving location", value: "Top" }] }, "personalization_option_not_found"],
  ["value for an upload field", { listing_id: "1000000002", variations: [{ name: "Engraving Style", option: "Initials" }], personalization: [{ field: "Names or Initials", value: "AB" }, { field: "Engraving location", value: "Center" }, { field: "Upload a logo", value: "logo.png" }] }, "personalization_unsupported"],
  ["required upload field", { listing_id: "1000000004", variations: [{ name: "Engraving Style", option: "Initials" }], personalization: [{ field: "Names or Initials", value: "AB" }, { field: "Engraving location", value: "Center" }] }, "personalization_unsupported"],
  ["unnamed value with several fields", { listing_id: "1000000002", variations: [{ name: "Engraving Style", option: "Initials" }], personalization: [{ value: "AB" }] }, "invalid_input"],
  ["listing not found", { listing_id: "1234567890" }, "listing_not_found"]
];
for (const [label, input, kind] of refusals) {
  test(`add_to_cart: ${label} is ${kind} without submitting`, async () => {
    const h = harness("add_to_cart", { pages: { ...listingPages, "/listing/1234567890": undefined }, onPage: onListing, onClick: addsLine("form", { cart: 1, listing: "1000000001", inv: 2, cust: 3, qty: 1 }) });
    const result = await h.run(input);
    assert.equal(result.status, "error", JSON.stringify(result));
    assert.equal(result.error_kind, kind, JSON.stringify(result));
    assert.equal(result.mutation_attempted, false);
    assert.deepEqual(h.calls.clicks, []);
    assert.deepEqual(h.site.cart, []);
    assert.ok(!h.calls.requests.some(r => r.method !== "GET"));
  });
}

test("add_to_cart: requirement errors return the allowed options", async () => {
  const result = await harness("add_to_cart", { pages: listingPages, onPage: onListing }).run({ ...COLLAR, variations: [{ name: "Size & Color", option: "XL" }, COLLAR.variations[1]] });
  assert.deepEqual(result.requirements.variation.options.map(o => [o.label, o.sold_out]), [["S - Black", false], ["M - Black", false], ["L - Black", true], ["XL - Black", true]]);
  const perso = await harness("add_to_cart", { pages: listingPages, onPage: onListing }).run({ ...COLLAR, personalization: [] });
  assert.equal(perso.requirements.field.instructions, "Enter the pet name. Up to 15 characters.");
});

test("add_to_cart: a listing without an add-to-cart form is listing_unavailable", async () => {
  const pages = { "/listing/1000000003": fixture("listing-plain").replace(/<form[\s\S]*<\/form>/, "<p>Sold out</p>") };
  const result = await harness("add_to_cart", { pages }).run({ listing_id: "1000000003" });
  assert.equal(result.error_kind, "listing_unavailable");
});

test("add_to_cart: a form that did not record the personalization is not submitted", async () => {
  const h = harness("add_to_cart", { pages: listingPages, onClick: addsLine("form", { cart: 1, listing: "1000000001", inv: 2, cust: 3, qty: 1 }) });
  const result = await h.run(COLLAR);
  assert.equal(result.error_kind, "site_changed");
  assert.equal(result.mutation_attempted, false);
  assert.deepEqual(h.calls.clicks, []);
});

// --- add_to_cart: submission and verification -------------------------------------------------------------

test("add_to_cart: classic form listing — sets choices through the page, submits once, confirms the new line", async () => {
  const line = { cart: 9000000001, listing: "1000000001", inv: 6000000001, cust: 7000000001, qty: 2, props: ["Size &amp; Color: M - Black", "Text Preference: Gold Text", "Personalization: FIDO"] };
  const h = harness("add_to_cart", { pages: listingPages, onPage: onListing, onClick: addsLine("form", line) });
  const result = await h.run({ ...COLLAR, quantity: 2, variations: [{ name: "size & color", option: "112" }, { index: 1, option: "gold text ($3.00)" }] });
  assert.equal(result.status, "ok", JSON.stringify(result));
  assert.equal(result.mutation_attempted, true);
  assert.equal(result.previous_quantity, 0);
  assert.equal(result.quantity_added, 2);
  assert.equal(result.line.line_id, "9000000001|1000000001|6000000001|7000000001");
  assert.deepEqual(result.selections, [{ name: "Size & Color", option_id: "112", label: "M - Black" }, { name: "Text Preference", option_id: "222", label: "Gold Text" }]);
  assert.deepEqual(result.personalization, [{ field_id: "501", label: "Personalization", value: "FIDO" }]);
  assert.equal(result.personalization_confirmed, true);
  assert.equal(result.cart_line_count, 1);
  assert.equal(h.calls.clicks.length, 1);
  assert.deepEqual(h.calls.fills, [{ selector: "#perso-input-501", text: "FIDO" }]);
  assert.deepEqual(h.calls.navigations, [`${ORIGIN}/listing/1000000001`]);
  const doc = h.doc();
  assert.equal(doc.getElementById("variation-selector-0").value, "112");
  assert.equal(doc.getElementById("variation-selector-1").value, "222");
  assert.equal(doc.querySelector('form input[name="quantity"]').value, "2");
});

test("add_to_cart: newer buy box — dropdown personalization and the carts/add request", async () => {
  const line = { cart: 9000000002, listing: "1000000002", inv: 6000000002, cust: 7000000002, qty: 1, props: ["Engraving Style: Initials", "Names or Initials: AB", "Engraving location: Center"] };
  const h = harness("add_to_cart", { pages: listingPages, onPage: onListing, onClick: addsLine("api", line) });
  const result = await h.run({ listing_id: "1000000002", variations: [{ name: "Engraving Style", option: "Initials" }], personalization: [{ field: "names or initials", value: "AB" }, { field: "802", value: "center" }] });
  assert.equal(result.status, "ok", JSON.stringify(result));
  assert.deepEqual(result.personalization, [{ field_id: "801", label: "Names or Initials", value: "AB" }, { field_id: "802", label: "Engraving location", value: "Center" }]);
  assert.equal(JSON.parse(h.doc().querySelector('input[name="multiple_personalizations"]').value)[1].option_id, 812);
});

test("add_to_cart: an existing identical line grows and previous_quantity is reported", async () => {
  const existing = { cart: 9000000003, listing: "1000000003", inv: 6000000003, cust: 0, qty: 1 };
  const other = { cart: 9000000009, listing: "1000000009", inv: 6000000009, cust: 0, qty: 3 };
  const h = harness("add_to_cart", { pages: listingPages, onPage: onListing, cart: [existing, other], onClick: addsLine("form", { ...existing, qty: 1 }) });
  const result = await h.run({ listing_id: "1000000003" });
  assert.equal(result.status, "ok");
  assert.equal(result.previous_quantity, 1);
  assert.equal(result.line.quantity, 2);
  assert.equal(result.cart_line_count, 2);
  assert.equal(h.site.cart.find(l => l.listing === "1000000009").qty, 3, "other lines are untouched");
});

test("add_to_cart: a line that appears without an observed request still counts as added", async () => {
  const onClick = async ({ site }) => { site.cart.push({ cart: 1, listing: "1000000003", inv: 2, cust: 0, qty: 1 }); };
  const result = await harness("add_to_cart", { pages: listingPages, onPage: onListing, onClick }).run({ listing_id: "1000000003" });
  assert.equal(result.status, "ok");
  assert.equal(result.mutation_attempted, true);
});

test("add_to_cart: a visible Etsy validation message with no request and no change is site_validation_failed", async () => {
  const onClick = async ({ doc }) => { doc.getElementById("personalization-error-802").textContent = "This field is required"; };
  const h = harness("add_to_cart", { pages: listingPages, onPage: onListing, onClick });
  const result = await h.run({ listing_id: "1000000002", variations: [{ name: "Engraving Style", option: "Initials" }], personalization: [{ field: "Names or Initials", value: "AB" }, { field: "Engraving location", value: "Center" }] });
  assert.equal(result.error_kind, "site_validation_failed");
  assert.equal(result.mutation_attempted, false);
  assert.match(result.error_message, /This field is required/);
  assert.ok(!/Please select an option/.test(result.error_message), "hidden validation templates are ignored");
});

test("add_to_cart: a press with no request, no message and no change is unknown with mutation_attempted", async () => {
  const result = await harness("add_to_cart", { pages: listingPages, onPage: onListing }).run({ listing_id: "1000000003" });
  assert.equal(result.error_kind, "unknown");
  assert.equal(result.mutation_attempted, true);
});

test("add_to_cart: a submitted request without a grown line is unknown and never retried", async () => {
  const onClick = async ({ emit }) => emit({ method: "Network.requestWillBeSent", params: { request: { method: "POST", url: `${ORIGIN}/cart/listing.php` } } });
  const h = harness("add_to_cart", { pages: listingPages, onPage: onListing, onClick });
  const result = await h.run({ listing_id: "1000000003" });
  assert.equal(result.error_kind, "unknown");
  assert.equal(result.mutation_attempted, true);
  assert.equal(h.calls.clicks.length, 1);
});

test("add_to_cart: personalization_confirmed is false when the cart shows different text", async () => {
  const line = { cart: 1, listing: "1000000001", inv: 2, cust: 3, qty: 1, props: ["Personalization: FID0"] };
  const result = await harness("add_to_cart", { pages: listingPages, onPage: onListing, onClick: addsLine("form", line) }).run(COLLAR);
  assert.equal(result.status, "ok");
  assert.equal(result.personalization_confirmed, false);
});

// --- update_cart_item -------------------------------------------------------------------------------------

const cartLine = { cart: 9000000001, listing: "1000000001", inv: 6000000001, cust: 7000000001, qty: 1, max: 4 };
const LINE_ID = "9000000001|1000000001|6000000001|7000000001";

test("update_cart_item: sets a quantity through Etsy's cart API with the page's CSRF token", async () => {
  const h = harness("update_cart_item", { cart: [cartLine, { ...cartLine, cust: 7000000002, qty: 5 }] });
  const result = await h.run({ line_id: LINE_ID, quantity: 3 });
  assert.deepEqual(result, { status: "ok", mutation_attempted: true, changed: true, line_id: LINE_ID, listing_id: "1000000001", title: "Fabricated item", previous_quantity: 1, quantity: 3, removed: false, cart_line_count: 2 });
  const post = h.calls.requests.filter(r => r.method === "POST");
  assert.equal(post.length, 1);
  assert.equal(post[0].path, "/api/v3/ajax/bespoke/member/checkout/cart-list/9000000001/cart/9000000001/listing/1000000001/inventory/6000000001/customization/7000000001/quantity");
  assert.equal(post[0].headers["x-csrf-token"], "3:1:fabricated-cart-token:123");
  assert.equal(post[0].headers["x-detected-locale"], "USD|en-US|US");
  assert.equal(new URLSearchParams(post[0].body).get("listing_quantity"), "3");
  assert.equal(h.site.cart[1].qty, 5, "the other personalization of the same listing is untouched");
});

test("update_cart_item: quantity 0 removes only that line", async () => {
  const h = harness("update_cart_item", { cart: [cartLine, { ...cartLine, listing: "1000000003", inv: 6000000003, cust: 0 }] });
  const result = await h.run({ line_id: LINE_ID, quantity: 0 });
  assert.equal(result.removed, true);
  assert.equal(result.quantity, 0);
  assert.equal(result.cart_line_count, 1);
  assert.ok(h.calls.requests.find(r => r.method === "POST").path.endsWith("/remove"));
  assert.deepEqual(h.site.cart.map(l => l.listing), ["1000000003"]);
});

test("update_cart_item: no-op, absent line and over-limit quantity send nothing", async () => {
  for (const [input, expect] of [[{ line_id: LINE_ID, quantity: 1 }, { status: "ok", changed: false }], [{ line_id: "1|2|3|4", quantity: 0 }, { error_kind: "not_in_cart" }], [{ line_id: LINE_ID, quantity: 5 }, { error_kind: "quantity_unavailable", max_quantity: 4 }]]) {
    const h = harness("update_cart_item", { cart: [cartLine] });
    const result = await h.run(input);
    for (const [k, v] of Object.entries(expect)) assert.equal(result[k], v, JSON.stringify(result));
    assert.equal(result.mutation_attempted, false);
    assert.ok(!h.calls.requests.some(r => r.method === "POST"));
  }
  const noMenu = harness("update_cart_item", { cart: [{ ...cartLine, max: null }] });
  assert.equal((await noMenu.run({ line_id: LINE_ID, quantity: 2 })).error_kind, "quantity_unavailable");
});

test("update_cart_item: a rejected request and an unconfirmed result are reported, not retried", async () => {
  const rejected = harness("update_cart_item", { cart: [cartLine], responses: (u, m) => m === "POST" ? { status: 400, body: "{\"error\":\"Quantity not available\"}" } : null });
  const r1 = await rejected.run({ line_id: LINE_ID, quantity: 2 });
  assert.equal(r1.error_kind, "cart_update_rejected");
  assert.equal(r1.mutation_attempted, true);
  assert.match(r1.error_message, /Quantity not available/);
  assert.equal(rejected.calls.requests.filter(r => r.method === "POST").length, 1);
  const ignored = harness("update_cart_item", { cart: [cartLine], responses: (u, m) => m === "POST" ? { status: 200, body: "{}" } : null });
  const r2 = await ignored.run({ line_id: LINE_ID, quantity: 2 });
  assert.equal(r2.error_kind, "unknown");
  assert.equal(r2.mutation_attempted, true);
  assert.equal(ignored.calls.requests.filter(r => r.method === "POST").length, 1);
});

// --- favorites --------------------------------------------------------------------------------------------

test("get_favorite_status: signed out is not_logged_in without any request", async () => {
  const h = harness("get_favorite_status");
  const result = await h.run({ listing_ids: ["1000000001"] });
  assert.equal(result.error_kind, "not_logged_in");
  assert.deepEqual(h.calls.requests, []);
});

test("get_favorite_status: reads Etsy's favorites map for each listing", async () => {
  const h = harness("get_favorite_status", { signedIn: true, favorites: ["1000000003"] });
  const result = await h.run({ listing_ids: ["1000000001", "1000000003"] });
  assert.deepEqual(result.favorites, [{ listing_id: "1000000001", favorited: false, in_other_lists: false }, { listing_id: "1000000003", favorited: true, in_other_lists: false }]);
  assert.equal(h.calls.requests[0].path, "/api/v3/ajax/member/users/listings-favorites-collections-map?listing_ids%5B%5D=1000000001&listing_ids%5B%5D=1000000003");
});

// Simulates Etsy's favorite buttons on a page: a press sends the favorites request and toggles the state.
const favoriteButtons = (behaviour = "toggle") => (doc, path, site) => {
  for (const button of doc.querySelectorAll('[data-ui="favorite-listing-button"]')) {
    button.addEventListener("click", function () {
      site.presses = (site.presses || 0) + 1;
      site.pressed = this;
      if (behaviour === "silent") return;
      site.recordResource(`${ORIGIN}/api/v3/ajax/bespoke/member/neu/specs/favoriteConfirmationToast`);
      if (behaviour !== "toggle") return;
      const id = this.getAttribute("data-listing-id");
      if (site.favorites.has(id)) site.favorites.delete(id); else site.favorites.add(id);
    });
  }
};
const favoriteHarness = options => harness("set_favorite", { pages: listingPages, url: `${ORIGIN}/listing/1000000003`, onPage: favoriteButtons(), ...options });

test("set_favorite: signed out is not_logged_in and nothing is pressed", async () => {
  const h = favoriteHarness({});
  const result = await h.run({ listing_id: "1000000003", favorited: true });
  assert.equal(result.error_kind, "not_logged_in");
  assert.equal(result.mutation_attempted, false);
  assert.equal(h.site.presses, undefined);
  assert.deepEqual(h.calls.requests, []);
});

test("set_favorite: already in the requested state is a no-op that reports the initial state", async () => {
  const h = favoriteHarness({ signedIn: true, favorites: ["1000000003"] });
  const result = await h.run({ listing_id: "1000000003", favorited: true });
  assert.deepEqual(result, { status: "ok", listing_id: "1000000003", previous_favorited: true, favorited: true, changed: false, mutation_attempted: false });
  assert.equal(h.site.presses, undefined);
});

for (const [from, to] of [[false, true], [true, false]]) {
  test(`set_favorite: ${from} -> ${to} presses the listing's own button once and confirms`, async () => {
    const h = favoriteHarness({ signedIn: true, favorites: from ? ["1000000003"] : [] });
    const result = await h.run({ listing_id: "1000000003", favorited: to });
    assert.deepEqual(result, { status: "ok", listing_id: "1000000003", previous_favorited: from, favorited: to, changed: true, mutation_attempted: true });
    assert.equal(h.site.presses, 1);
    assert.deepEqual(h.calls.navigations, [], "page tools never navigate");
  });
}

test("set_favorite: a listing whose button is not on this page is listing_not_on_page", async () => {
  const h = favoriteHarness({ signedIn: true, url: `${ORIGIN}/cart` });
  const result = await h.run({ listing_id: "1000000003", favorited: true });
  assert.equal(result.error_kind, "listing_not_on_page");
  assert.equal(result.mutation_attempted, false);
  assert.equal(result.previous_favorited, false);
});

test("set_favorite: a press that sends nothing or does not stick is reported without retrying", async () => {
  for (const behaviour of ["silent", "no-change"]) {
    const h = favoriteHarness({ signedIn: true, onPage: favoriteButtons(behaviour) });
    const result = await h.run({ listing_id: "1000000003", favorited: true });
    assert.equal(result.error_kind, "unknown");
    assert.equal(result.mutation_attempted, true);
    assert.equal(result.previous_favorited, false);
    assert.equal(h.site.presses, 1);
    assert.equal(/no favorites request was seen/.test(result.error_message), behaviour === "silent");
    assert.equal(h.site.observers.size, 0, "the request observer is disconnected");
  }
});

test("set_favorite: presses the listing page's own button rather than a recommendation card's", async () => {
  const h = favoriteHarness({ signedIn: true, url: `${ORIGIN}/listing/1000000001` });
  const result = await h.run({ listing_id: "1000000001", favorited: true });
  assert.equal(result.changed, true);
  assert.equal(h.site.pressed.hasAttribute("data-always-show"), true);
});

test("set_favorite: a search result card's button is used when the listing page is not open", async () => {
  const h = favoriteHarness({ signedIn: true, url: `${ORIGIN}/search`, pages: { ...listingPages, "/search": fixture("search").replace('<h3 id="listing-title-1000000012"', '<button data-ui="favorite-listing-button" data-listing-id="1000000012">Fave</button><h3 id="listing-title-1000000012"') } });
  const result = await h.run({ listing_id: "1000000012", favorited: true });
  assert.equal(result.changed, true);
  assert.equal(h.site.presses, 1);
});
