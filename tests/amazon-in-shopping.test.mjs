import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createContext, runInContext, runInNewContext } from "node:vm";
import { Document, DOMParser } from "./etsy-dom.mjs";

// Harness for the amazon.in tools. Each tool's page-side function is re-created from its source and run against
// fabricated pages served by a fake fetch, using the small DOM in etsy-dom.mjs; nothing here contacts the live site.
const NAMES = ["search_products", "get_product", "list_bestsellers"];
const sources = Object.fromEntries(NAMES.map(name => [name, readFileSync(new URL(`../domains/amazon.in/${name}.js`, import.meta.url), "utf8")]));
const fixture = name => readFileSync(new URL(`./fixtures/amazon-in/${name}.html`, import.meta.url), "utf8");
const plain = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const registry = JSON.parse(readFileSync(new URL("../registry.json", import.meta.url), "utf8"));
const ORIGIN = "https://www.amazon.in";

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

// `respond(url, init)` returns { status, body, url, headers } or an Error to throw from fetch.
function harness(name, respond, { url = `${ORIGIN}/` } = {}) {
  const calls = { requests: [] };
  const location = {};
  const u = new URL(url);
  Object.assign(location, { href: u.href, origin: u.origin, pathname: u.pathname, host: u.host, hostname: u.hostname, search: u.search });
  const fetch = async (target, init = {}) => {
    const requested = new URL(target, location.origin);
    calls.requests.push({ method: (init.method || "GET").toUpperCase(), url: requested, init });
    const r = await respond(requested, init);
    if (r instanceof Error) throw r;
    const status = r.status ?? 200;
    const headers = r.headers || {};
    return { status, ok: status >= 200 && status < 300, url: r.url ?? requested.href, headers: { get: key => headers[key.toLowerCase()] ?? null }, text: async () => r.body ?? "" };
  };
  const pageContext = createContext({ location, fetch, DOMParser, URL, URLSearchParams });
  const [definition] = runInNewContext(`(${sources[name]})`, {});
  // Page tools run in the document, re-created from their source the way the runtime does it.
  const execute = runInContext(`(${definition.execute.toString()})`, pageContext);
  return {
    definition, calls, location,
    run: async input => {
      const result = plain(await execute(input, { signal: new AbortController().signal }));
      assert.ok(conforms(definition.tool.outputSchema, result), `${name} output violates its schema: ${JSON.stringify(result)}`);
      return result;
    }
  };
}

const page = body => () => ({ body });
const status = (code, body = "<html><body>x</body></html>", extra = {}) => () => ({ status: code, body, ...extra });
const CAPTCHA = "<html><head><title>Robot Check</title></head><body><form action=\"/errors/validateCaptcha\"><input id=\"captchacharacters\" type=\"text\"></form></body></html>";

// Text planted in the fixtures that no tool may return: session and CSRF material, tracking links, the delivery address and purchase history.
const PLANTED = ["FAKE-CSRF", "FAKE-OFFER", "000-0000000-0000000", "FAKE-TRACKING", "FAKEDIB", "token=FAKE", "sspa", "Testville", "Test Person", "400001", "You purchased", "FREE delivery", "Fri, 2 Oct"];
const assertNoLeak = result => { const text = JSON.stringify(result); for (const secret of PLANTED) assert.ok(!text.includes(secret), `output leaks ${secret}`); };

// ---- search_products -------------------------------------------------------------------------------------------------
const FACETS = { p_123: [["111", "Acme"], ["222", "Zenith"], ["333", "Orbit"]], p_72: [["1318476031", "4 Stars &amp; Up"]], p_n_free_shipping_eligible: [["205563695031", "Free Shipping"]], p_90: [["6741117031", "Get It Today"]], "p_n_size_two_browse-vebin": [["1975317031", "Black"]] };
// Filter links behave as the live site's do: an unselected option adds itself to its key's ORed values, a selected one removes itself,
// a department search carries an implicit browse-node token in every link, and an ORed value is percent-encoded twice (%257C).
function refinements(applied, implicit) {
  const link = (key, value) => {
    const next = new Map([...applied].map(([k, v]) => [k, [...v]]));
    const values = next.get(key) || [];
    next.set(key, values.includes(value) ? values.filter(x => x !== value) : [value, ...values]);
    const rh = [implicit, ...[...next].filter(([, v]) => v.length).map(([k, v]) => `${k}:${v.join("%7C")}`)].filter(Boolean).join(",");
    return `/s?k=water+bottle&amp;rh=${encodeURIComponent(rh)}&amp;dc&amp;qid=1&amp;ref=sr_nr_${key}&amp;ds=v1%3AFAKE`;
  };
  const list = (key, title, swatch = false) => `<div id="${key}-title" role="heading"><span>${title}</span></div><ul aria-labelledby="${key}-title">${FACETS[key].map(([value, label]) => swatch
    ? `<li><span class="a-list-item"><a class="s-navigation-item" href="${link(key, value)}" title="${label}" aria-label="Apply the filter ${label} to narrow results"><span class="a-declarative"><div class="colorsprite"></div></span></a></span></li>`
    : `<li><span class="a-list-item"><a class="s-navigation-item" href="${link(key, value)}"><span>${label}</span></a></span></li>`).join("")}</ul>`;
  return `<div id="deliveryRefinements" role="group">${list("p_90", "Delivery Day")}${list("p_n_free_shipping_eligible", "Eligible for Free Delivery")}</div>`
    + `<div id="brandsRefinements" role="group"><a href="${link("p_123", "111")}">Clear</a>${list("p_123", "Brands")}</div>`
    + `<div id="reviewsRefinements" role="group">${list("p_72", "Customer Reviews").replace("<span>4 Stars &amp; Up</span>", "<i class=\"a-icon\"><span class=\"a-icon-alt\">4 Stars</span></i> <span>&amp; Up</span>")}</div>`
    + `<div id="colourRefinements" role="group">${list("p_n_size_two_browse-vebin", "Colour", true)}</div>`
    + "<div id=\"priceRefinements\" role=\"group\"><div id=\"p_36-title\" role=\"heading\"></div><ul aria-labelledby=\"p_36-title\"><li><a href=\"/s?k=water+bottle&amp;rh=p_36%3A-30000\"><span>Up to 300</span></a></li></ul></div>";
}
function searchSite({ info = "1-16 of over 50,000 results for", cards = fixture("search-cards"), container = true, facetsHtml } = {}) {
  return url => {
    const rh = url.searchParams.get("rh") || "";
    const applied = new Map(rh.split(",").filter(Boolean).map(part => [part.slice(0, part.indexOf(":")), part.slice(part.indexOf(":") + 1).split("|")]));
    let body = fixture("search").replace("{{INFO}}", info).replace("{{REFINEMENTS}}", facetsHtml ?? refinements(applied, url.searchParams.get("i") ? "n:976419031" : "")).replace("{{CARDS}}", cards);
    if (!container) body = body.replace("data-component-type=\"s-search-results\"", "data-component-type=\"other\"");
    return { body };
  };
}
const search = (input, site = searchSite(), options) => { const h = harness("search_products", site, options); return h.run(input).then(result => ({ result, ...h })); };
const ASINS = ["B0TESTAAA1", "B0TESTBBB2", "B0TESTCCC3", "B0TESTDDD4", "B0TESTEEE5", "B0TESTFFF6"];

test("all three tools are page tools narrowed to www.amazon.in and match their registry entries", () => {
  for (const name of NAMES) {
    const [definition] = runInNewContext(`(${sources[name]})`, {});
    const entry = registry.tools.find(t => t.domain === "amazon.in" && t.tool === name);
    assert.ok(entry, `${name} has a registry entry`);
    assert.equal(definition.kind, "page");
    assert.equal(entry.kind, "page");
    assert.deepEqual(plain(definition.match.url_patterns), ["https://www.amazon.in/*"]);
    assert.deepEqual(entry.url_patterns, ["https://www.amazon.in/*"]);
    assert.equal(definition.tool.name, name);
    assert.equal(definition.tool.annotations.readOnlyHint, true);
    assert.ok(definition.tool.outputSchema && definition.tool.inputSchema);
  }
});

test("search_products rejects malformed input before any request", async () => {
  const bad = [
    undefined, null, "water bottle", [], {}, { query: "" }, { query: "   " }, { query: 5 }, { query: "x".repeat(201) }, { query: "a\u0007b" }, { query: "x", extra: 1 },
    { query: "x", department: "nope" }, { query: "x", department: "aps" }, { query: "x", department: 3 },
    { query: "x", sort_by: "cheapest" }, { query: "x", sort_by: 1 },
    { query: "x", min_price_inr: -1 }, { query: "x", min_price_inr: 1.5 }, { query: "x", max_price_inr: 10000001 }, { query: "x", max_price_inr: "9" }, { query: "x", min_price_inr: 500, max_price_inr: 100 },
    { query: "x", page: 0 }, { query: "x", page: 21 }, { query: "x", page: "2" }, { query: "x", page: 1.5 },
    { query: "x", limit: 0 }, { query: "x", limit: 61 }, { query: "x", limit: "5" },
    { query: "x", exclude_sponsored: "yes" }, { query: "x", include_facets: 1 },
    { query: "x", facet_ids: "p_123:1" }, { query: "x", facet_ids: ["bad id"] }, { query: "x", facet_ids: ["P_123:1"] }, { query: "x", facet_ids: ["p_123:1", "p_123:1"] },
    { query: "x", facet_ids: Array.from({ length: 9 }, (_, i) => `p_123:${i}`) }, { query: "x", facet_ids: [5] }, { query: "x", facet_ids: ["p_90:6741117031"] },
    { query: null }, { query: "x", department: null }, { query: "x", sort_by: null }, { query: "x", min_price_inr: null }, { query: "x", max_price_inr: null }, { query: "x", page: null },
    { query: "x", limit: null }, { query: "x", exclude_sponsored: null }, { query: "x", include_facets: null }, { query: "x", facet_ids: null }
  ];
  for (const input of bad) {
    const h = harness("search_products", searchSite());
    const result = await h.run(input);
    assert.equal(result.status, "error", JSON.stringify(input));
    assert.equal(result.error_kind, "invalid_input", JSON.stringify(input));
    assert.equal(h.calls.requests.length, 0, `${JSON.stringify(input)} reached the site`);
  }
});

test("search_products and the other tools refuse to run outside www.amazon.in without a request", async () => {
  const inputs = { search_products: { query: "water bottle" }, get_product: { asin: "B0TESTAAA1" }, list_bestsellers: { category: "kitchen" } };
  for (const name of NAMES) {
    for (const url of ["https://example.com/", "https://www.amazon.com/", "https://amazon.in/", "https://sellercentral.amazon.in/", "http://www.amazon.in/"]) {
      const h = harness(name, page("<html></html>"), { url });
      const result = await h.run(inputs[name]);
      assert.deepEqual([result.status, result.error_kind], ["error", "wrong_page"], `${name} on ${url}`);
      assert.equal(h.calls.requests.length, 0);
    }
  }
});

test("search_products builds the site's own query parameters and sends one GET", async () => {
  const cases = [
    [{ query: "  water   bottle " }, { k: "water bottle" }],
    [{ query: "water bottle", sort_by: "relevance" }, { k: "water bottle" }],
    [{ query: "water bottle", department: "electronics" }, { k: "water bottle", i: "electronics" }],
    [{ query: "water bottle", sort_by: "price_low_to_high" }, { k: "water bottle", s: "price-asc-rank" }],
    [{ query: "water bottle", sort_by: "price_high_to_low" }, { k: "water bottle", s: "price-desc-rank" }],
    [{ query: "water bottle", sort_by: "highest_rated" }, { k: "water bottle", s: "review-rank" }],
    [{ query: "water bottle", sort_by: "newest" }, { k: "water bottle", s: "date-desc-rank" }],
    [{ query: "water bottle", sort_by: "bestselling" }, { k: "water bottle", s: "exact-aware-popularity-rank" }],
    [{ query: "water bottle", min_price_inr: 200, max_price_inr: 400 }, { k: "water bottle", "low-price": "200", "high-price": "400" }],
    [{ query: "water bottle", min_price_inr: 0 }, { k: "water bottle", "low-price": "0" }],
    [{ query: "water bottle", max_price_inr: 150 }, { k: "water bottle", "high-price": "150" }],
    [{ query: "water bottle", page: 1 }, { k: "water bottle" }],
    [{ query: "water bottle", page: 3 }, { k: "water bottle", page: "3" }],
    [{ query: "water bottle", facet_ids: ["p_123:111"] }, { k: "water bottle", rh: "p_123:111" }],
    [{ query: "water bottle", facet_ids: ["p_123:111", "p_72:1318476031"] }, { k: "water bottle", rh: "p_123:111,p_72:1318476031" }],
    [{ query: "water bottle", facet_ids: ["p_123:111", "p_72:1318476031", "p_123:222"] }, { k: "water bottle", rh: "p_123:111|222,p_72:1318476031" }],
    [{ query: "a&b=c#d", department: "kitchen", sort_by: "newest", min_price_inr: 5, max_price_inr: 9, facet_ids: ["p_n_g-1003512784111:49989874031"], page: 2 },
      { k: "a&b=c#d", i: "kitchen", s: "date-desc-rank", "low-price": "5", "high-price": "9", rh: "p_n_g-1003512784111:49989874031", page: "2" }]
  ];
  for (const [input, expected] of cases) {
    const { calls, location } = await search(input);
    assert.equal(calls.requests.length, 1);
    const [request] = calls.requests;
    assert.equal(request.method, "GET");
    assert.equal(request.url.origin + request.url.pathname, `${ORIGIN}/s`);
    assert.deepEqual(Object.fromEntries(request.url.searchParams), expected, JSON.stringify(input));
    assert.equal(request.init.credentials, "include");
    assert.equal(request.init.body, undefined);
    assert.equal(location.href, `${ORIGIN}/`, "the tab never navigates");
  }
});

test("search_products returns allowlisted fields for each card layout", async () => {
  const { result, calls } = await search({ query: "water bottle", limit: 60 });
  assert.equal(result.status, "ok");
  assert.deepEqual(result.results.map(r => r.asin), ASINS, "widgets, invalid ids and the duplicate tile are skipped");
  assert.deepEqual(result.results.map(r => r.rank), [1, 2, 3, 4, 5, 6]);
  const [grid, bulk, ad, list, unpriced, offsite] = result.results;
  assert.deepEqual(grid, {
    rank: 1, asin: "B0TESTAAA1", title: "Acme Steel Bottle 1000 ml", brand: null, url: `${ORIGIN}/dp/B0TESTAAA1`, image_url: "https://m.media-amazon.com/images/I/aaa111._AC_UL320_.jpg",
    price_inr: 159, price_text: "\u20b9159", mrp_inr: 299, rating: 4, rating_count: 2393, bought_past_month: "9K+", sponsored: false, badges: ["Amazon's Choice"]
  });
  assert.equal(bulk.price_inr, 1189.5, "paise are kept");
  assert.equal(bulk.price_text, "\u20b91,189.50");
  assert.equal(bulk.mrp_inr, 1999, "the per-unit price is not taken for the M.R.P.");
  assert.equal(bulk.rating, 4.1);
  assert.equal(bulk.rating_count, 369);
  assert.equal(bulk.bought_past_month, null);
  assert.equal(bulk.image_url, "https://images-eu.ssl-images-amazon.com/images/I/bbb222._AC_UL320_.jpg");
  assert.equal(ad.sponsored, true);
  assert.equal(ad.url, `${ORIGIN}/dp/B0TESTCCC3`, "the sponsored click-tracking link is never returned");
  assert.deepEqual(ad.badges, ["Limited time deal"]);
  assert.equal(ad.price_inr, 331);
  assert.deepEqual([list.brand, list.title, list.price_inr, list.rating], ["Zenith", "Zenith Phone 256 GB", 79900, null], "list-view cards keep the brand row apart from the title");
  assert.deepEqual([unpriced.price_inr, unpriced.price_text, unpriced.mrp_inr, unpriced.rating, unpriced.rating_count, unpriced.image_url], [null, null, null, null, null, null]);
  assert.deepEqual([offsite.price_inr, offsite.price_text, offsite.image_url], [null, "$12.00", null], "only rupee prices become numbers and only Amazon image hosts are returned");
  assert.equal(result.facets, null);
  assert.deepEqual(result.facet_ids, []);
  assert.equal(calls.requests.length, 1);
  assertNoLeak(result);
});

test("search_products applies limit and exclude_sponsored, and reports when only ads remain", async () => {
  assert.deepEqual((await search({ query: "water bottle", limit: 2 })).result.results.map(r => r.asin), ASINS.slice(0, 2));
  const { result } = await search({ query: "water bottle", exclude_sponsored: true, limit: 60 });
  assert.deepEqual(result.results.map(r => [r.rank, r.asin]), [[1, "B0TESTAAA1"], [2, "B0TESTBBB2"], [3, "B0TESTDDD4"], [4, "B0TESTEEE5"], [5, "B0TESTFFF6"]]);
  assert.ok(result.results.every(r => !r.sponsored));
  const onlyAd = fixture("search-cards").split("<div role=\"listitem\"").filter(part => part.includes("data-asin=\"B0TESTCCC3\"")).map(part => "<div role=\"listitem\"" + part).join("");
  const none = (await search({ query: "water bottle", exclude_sponsored: true }, searchSite({ cards: onlyAd }))).result;
  assert.deepEqual(none, { status: "no_results", query: "water bottle", department: null, sort_by: "relevance", page: 1, facet_ids: [], sponsored_excluded: 1 });
});

test("search_products flags a sponsored card by any one of its structural markers", async () => {
  const card = (asin, extraClass, inner, href) => `<div data-asin="${asin}" data-component-type="s-search-result" class="s-result-item s-asin${extraClass}">${inner}<a href="${href}"><h2><span>Item ${asin}</span></h2></a></div>`;
  const cards = card("B0TESTSP01", " AdHolder", "", "/Item/dp/B0TESTSP01")
    + card("B0TESTSP02", "", "<span class=\"puis-label-popover puis-sponsored-label-text\">Sponsored</span>", "/Item/dp/B0TESTSP02")
    + card("B0TESTSP03", "", "", "/sspa/click?ie=UTF8&amp;spc=FAKE-TRACKING")
    + card("B0TESTSP04", "", "", "/Item/dp/B0TESTSP04");
  const { result } = await search({ query: "water bottle" }, searchSite({ cards }));
  assert.deepEqual(result.results.map(r => [r.asin, r.sponsored]), [["B0TESTSP01", true], ["B0TESTSP02", true], ["B0TESTSP03", true], ["B0TESTSP04", false]]);
  assert.deepEqual(result.results.map(r => r.url), ["B0TESTSP01", "B0TESTSP02", "B0TESTSP03", "B0TESTSP04"].map(asin => `${ORIGIN}/dp/${asin}`));
  assertNoLeak(result);
});

test("search_products reads the result count and pager wording", async () => {
  const lower = (await search({ query: "water bottle" })).result;
  assert.deepEqual([lower.total_results, lower.total_results_is_lower_bound, lower.total_pages], [50000, true, 20]);
  const exact = (await search({ query: "water bottle" }, searchSite({ info: "1-48 of 186 results for" }))).result;
  assert.deepEqual([exact.total_results, exact.total_results_is_lower_bound], [186, false]);
  const unknown = (await search({ query: "water bottle" }, searchSite({ info: "Some other wording for" }))).result;
  assert.deepEqual([unknown.total_results, unknown.total_results_is_lower_bound], [null, null]);
  const noPager = (await search({ query: "water bottle" }, url => ({ body: searchSite()(url).body.replace(/<span class="s-pagination-strip">[\s\S]*?<\/span>\n/, "") }))).result;
  assert.equal(noPager.total_pages, null);
});

test("search_products returns filter options with ids and applies them the way the site does", async () => {
  const first = (await search({ query: "water bottle", include_facets: true })).result;
  assert.deepEqual(first.facets.map(g => g.name), ["Eligible for Free Delivery", "Brands", "Customer Reviews", "Colour"], "delivery-day and heading-less price groups are not offered");
  assert.deepEqual(first.facets[3].options, [{ id: "p_n_size_two_browse-vebin:1975317031", name: "Black", selected: false }], "swatch options are named from their title attribute");
  assert.equal(first.facets_truncated, false);
  assert.equal((await search({ query: "water bottle" })).result.facets_truncated, null);
  assert.deepEqual(first.facets[1].options, [
    { id: "p_123:111", name: "Acme", selected: false }, { id: "p_123:222", name: "Zenith", selected: false }, { id: "p_123:333", name: "Orbit", selected: false }
  ]);
  assert.deepEqual(first.facets[2].options, [{ id: "p_72:1318476031", name: "4 Stars & Up", selected: false }]);
  assert.deepEqual(first.facets[0].options, [{ id: "p_n_free_shipping_eligible:205563695031", name: "Free Shipping", selected: false }]);
  const ids = ["p_123:111", "p_72:1318476031"];
  const applied = await search({ query: "water bottle", include_facets: true, facet_ids: ids });
  assert.deepEqual(applied.result.facet_ids, ids);
  assert.deepEqual(applied.result.facets.flatMap(g => g.options.filter(o => o.selected).map(o => o.id)), ids, "applied options are reported as selected with their own ids");
  assert.equal(applied.result.facets[1].options.length, 3, "the option list stays complete");
  const ored = await search({ query: "water bottle", include_facets: true, facet_ids: ["p_123:111", "p_123:222"] });
  assert.equal(ored.calls.requests[0].url.searchParams.get("rh"), "p_123:111|222", "options of one key are ORed");
  assert.deepEqual(ored.result.facets[1].options.map(o => [o.id, o.selected]), [["p_123:111", true], ["p_123:222", true], ["p_123:333", false]]);
  const inDepartment = await search({ query: "water bottle", department: "electronics", include_facets: true, facet_ids: ["p_123:222"] });
  assert.deepEqual(inDepartment.result.facets[1].options.map(o => [o.id, o.selected]), [["p_123:111", false], ["p_123:222", true], ["p_123:333", false]], "the implicit browse-node token is ignored");
  const hand = await search({ query: "water bottle", department: "electronics", include_facets: true, facet_ids: ["n:976419031", "p_123:222"] });
  assert.deepEqual(hand.result.facets[1].options.map(o => [o.id, o.selected]), [["p_123:111", false], ["p_123:222", true], ["p_123:333", false]]);
});

test("search_products distinguishes an empty search from a changed page", async () => {
  const empty = (await search({ query: "zzz", department: "toys", sort_by: "newest", facet_ids: ["p_123:111"], page: 4 }, searchSite({ cards: "" }))).result;
  assert.deepEqual(empty, { status: "no_results", query: "zzz", department: "toys", sort_by: "newest", page: 4, facet_ids: ["p_123:111"], sponsored_excluded: 0 });
  const shell = "<html><head><meta http-equiv=\"refresh\" content=\"0; url=/s?k=zzz&amp;i=aps\"></head><body>Results Filters</body></html>";
  const fallback = await search({ query: "zzz", department: "hpc" }, page(shell));
  assert.deepEqual(fallback.result, { status: "no_results", query: "zzz", department: "hpc", sort_by: "relevance", page: 1, facet_ids: [], sponsored_excluded: 0 }, "a department with no match is reported, not silently widened to all categories");
  assert.equal(fallback.calls.requests.length, 1, "the redirect is not followed");
  const unexpected = (await search({ query: "zzz" }, page(shell))).result;
  assert.deepEqual([unexpected.status, unexpected.error_kind], ["error", "site_changed"], "the same shell with no department requested is not a department miss");
  const elsewhere = (await search({ query: "zzz", department: "hpc" }, page(shell.replace("i=aps", "i=toys")))).result;
  assert.deepEqual([elsewhere.status, elsewhere.error_kind], ["error", "site_changed"]);
  const unrecognised = (await search({ query: "water bottle" }, searchSite({ container: false }))).result;
  assert.deepEqual([unrecognised.status, unrecognised.error_kind], ["error", "site_changed"]);
  const untitled = "<div data-asin=\"B0TESTZZZ9\" data-component-type=\"s-search-result\"><span>no heading</span></div>";
  const noTitles = (await search({ query: "water bottle" }, searchSite({ cards: untitled }))).result;
  assert.deepEqual([noTitles.status, noTitles.error_kind], ["error", "site_changed"]);
});

const GATES = [
  ["a robot check page", page(CAPTCHA), "challenge"],
  ["an HTTP 202 challenge", status(202, ""), "challenge"],
  ["a WAF challenge header", status(200, "<html></html>", { headers: { "x-amzn-waf-action": "challenge" } }), "challenge"],
  ["HTTP 503", status(503), "rate_limited"],
  ["HTTP 429", status(429), "rate_limited"],
  ["HTTP 500", status(500), "site_error"],
  ["a redirect to sign-in", status(200, "<html><body>Sign in</body></html>", { url: `${ORIGIN}/ap/signin?openid.mode=checkid_setup` }), "login_required"],
  ["a redirect to another host", status(200, "<html></html>", { url: "https://example.com/s" }), "site_error"],
  ["a network failure", () => new TypeError("Failed to fetch"), "site_error"]
];
const INPUTS = { search_products: { query: "water bottle" }, get_product: { asin: "B0TESTAAA1" }, list_bestsellers: { category: "kitchen" } };
for (const name of NAMES) {
  test(`${name} turns blocks, throttling and site failures into explicit errors`, async () => {
    for (const [label, site, kind] of GATES) {
      const h = harness(name, site);
      const result = await h.run(INPUTS[name]);
      assert.deepEqual([result.status, result.error_kind], ["error", kind], `${name}: ${label}`);
      assert.equal(h.calls.requests.length, 1, "no retry");
    }
  });
}

// ---- get_product -----------------------------------------------------------------------------------------------------
const productSite = (html = fixture("product")) => url => url.pathname.startsWith("/dp/") ? { body: html } : { status: 404, body: "not found" };
const product = (input, site = productSite(), options) => { const h = harness("get_product", site, options); return h.run(input).then(result => ({ result, ...h })); };

test("get_product rejects malformed input before any request", async () => {
  for (const input of [undefined, null, "B0TESTAAA1", [], {}, { asin: "" }, { asin: "b0testaaa1" }, { asin: "SHORT" }, { asin: "B0TESTAAA1X" }, { asin: "B0TEST-AA1" }, { asin: 5 }, { asin: "B0TESTAAA1", extra: 1 }, { asin: "../cart/ab" }]) {
    const h = harness("get_product", productSite());
    const result = await h.run(input);
    assert.deepEqual([result.status, result.error_kind], ["error", "invalid_input"], JSON.stringify(input));
    assert.equal(h.calls.requests.length, 0);
  }
});

test("get_product returns the page's public details and only those", async () => {
  const { result, calls, location } = await product({ asin: "B0TESTAAA1" });
  assert.equal(calls.requests.length, 1);
  assert.equal(calls.requests[0].method, "GET");
  assert.equal(calls.requests[0].url.pathname, "/dp/B0TESTAAA1");
  assert.equal(location.href, `${ORIGIN}/`);
  assert.equal(result.status, "ok");
  assert.deepEqual(
    { ...result, bullets: result.bullets.length, details: result.details, overview: result.overview, variations: result.variations },
    {
      status: "ok", requested_asin: "B0TESTAAA1", asin: "B0TESTAAA1", url: `${ORIGIN}/dp/B0TESTAAA1`, title: "Acme Steel Bottle 1000 ml, Leak Proof Lid", brand: "Acme",
      image_url: "https://m.media-amazon.com/images/I/ppp111._SY300_SX300_.jpg", price_inr: 299, price_text: "\u20b9299.00", mrp_inr: 430, rating: 3.8, rating_count: 7034,
      bought_past_month: "4K+", availability_text: "In stock", in_stock: true, sold_by: "Fabricated Retail Pvt Ltd", ships_from: "Amazon",
      breadcrumbs: ["Home & Kitchen", "Water Bottles"], bullets: 10,
      overview: [{ name: "Brand", value: "Acme" }, { name: "Material", value: "Stainless Steel" }],
      details: [{ name: "Item Weight", value: "200 Grams" }, { name: "Manufacturer", value: "Acme Works Pvt Ltd, Plot 1, Testville" }],
      variations: [
        { dimension: "Colour", selected: "Black", options: [{ label: "Black", asin: "B0TESTAAA1", selected: true }, { label: "Mint Green", asin: "B0TESTVAR2", selected: false }] },
        { dimension: "Size", selected: "1000 ml", options: [{ label: "750 ml", asin: "B0TESTVAR3", selected: false }, { label: "1000 ml", asin: "B0TESTAAA1", selected: true }] }
      ]
    }
  );
  assert.ok(result.bullets.every(b => /^Fabricated bullet number \d+ about the steel bottle\.$/.test(b)));
  const text = JSON.stringify(result);
  for (const secret of ["FAKE-CSRF", "You purchased", "FREE delivery", "Deliver to", "400001", "B0TESTOTHR"]) assert.ok(!text.includes(secret), `output leaks ${secret}`);
  assert.ok(!result.details.some(d => d.name === "Customer Reviews"), "rows holding script or style are skipped");
});

test("get_product reads the price from the visible digits when the offscreen copy is empty", async () => {
  const html = fixture("product").replace(/<div id="corePrice_feature_div">[\s\S]*?<\/span><\/span><\/span><\/div>/, "");
  assert.ok(!html.includes("apex-pricetopay-value"));
  const { result } = await product({ asin: "B0TESTAAA1" }, productSite(html));
  assert.deepEqual([result.price_inr, result.price_text, result.mrp_inr], [299, "\u20b9299", 430]);
  const paise = html.replace("<span class=\"a-price-whole\">299</span>", "<span class=\"a-price-whole\">1,299<span class=\"a-price-decimal\">.</span></span><span class=\"a-price-fraction\">50</span>");
  const withPaise = (await product({ asin: "B0TESTAAA1" }, productSite(paise))).result;
  assert.deepEqual([withPaise.price_inr, withPaise.price_text], [1299.5, "\u20b91,299.50"]);
});

test("get_product reports availability only as far as the page settles it", async () => {
  const gone = (await product({ asin: "B0TESTUNAV" }, productSite(fixture("product-unavailable")))).result;
  assert.deepEqual([gone.in_stock, gone.availability_text, gone.price_inr, gone.price_text, gone.mrp_inr, gone.brand, gone.variations, gone.bullets], [false, "Currently unavailable.", null, null, null, "Acme", [], []]);
  const unknown = (await product({ asin: "B0TESTAAA1" }, productSite(fixture("product").replace("<input id=\"add-to-cart-button\" type=\"submit\" value=\"Add to Cart\">", "")))).result;
  assert.deepEqual([unknown.in_stock, unknown.availability_text], [null, "In stock"], "no button and no unavailable notice: unknown, not out of stock");
});

test("get_product reports the asin the page declares when it differs from the request", async () => {
  const merged = fixture("product").replace("value=\"B0TESTAAA1\"", "value=\"B0TESTOTHR\"");
  const { result } = await product({ asin: "B0TESTAAA1" }, productSite(merged));
  assert.deepEqual([result.requested_asin, result.asin, result.url], ["B0TESTAAA1", "B0TESTOTHR", `${ORIGIN}/dp/B0TESTOTHR`]);
});

test("get_product distinguishes a missing product from a changed page", async () => {
  const missing = (await product({ asin: "B0TESTAAA1" }, status(404, "<html><title>Page Not Found</title></html>"))).result;
  assert.deepEqual([missing.error_kind, missing.error_message], ["not_found", "amazon.in has no product page for B0TESTAAA1."]);
  const changed = (await product({ asin: "B0TESTAAA1" }, productSite("<html><body><h1>Something else</h1></body></html>"))).result;
  assert.deepEqual([changed.status, changed.error_kind], ["error", "site_changed"]);
});

// ---- list_bestsellers ------------------------------------------------------------------------------------------------
const chartSite = (pages = {}) => url => {
  const body = pages[url.pathname + url.search] ?? { "/gp/bestsellers": fixture("bestsellers-root"), "/gp/bestsellers/kitchen": fixture("bestsellers-kitchen"), "/gp/bestsellers/kitchen?pg=2": fixture("bestsellers-kitchen-page2") }[url.pathname + url.search];
  return body === undefined ? { body: fixture("bestsellers-root") } : { body };
};
const chart = (input, site = chartSite(), options) => { const h = harness("list_bestsellers", site, options); return h.run(input).then(result => ({ result, ...h })); };

test("list_bestsellers rejects malformed input before any request", async () => {
  for (const input of [undefined, null, "kitchen", [], { category: "Kitchen" }, { category: "k" }, { category: "kitchen/" }, { category: "kitchen/abc" }, { category: "kitchen/123" }, { category: "kitchen/1379960031/extra" }, { category: "../x" }, { category: "kitchen?pg=2" }, { category: 5 }, { category: "" },
    { category: "kitchen", page: 0 }, { category: "kitchen", page: 3 }, { category: "kitchen", page: "2" }, { category: "kitchen", limit: 0 }, { category: "kitchen", limit: 31 }, { page: 2 }, { category: "kitchen", extra: 1 }, { category: null }, { category: "kitchen", page: null }, { category: "kitchen", limit: null }]) {
    const h = harness("list_bestsellers", chartSite());
    const result = await h.run(input);
    assert.deepEqual([result.status, result.error_kind], ["error", "invalid_input"], JSON.stringify(input));
    assert.equal(h.calls.requests.length, 0);
  }
});

test("list_bestsellers returns ranked products, the category name and drill-down categories", async () => {
  const { result, calls, location } = await chart({ category: "kitchen" });
  assert.equal(calls.requests.length, 1);
  assert.deepEqual([calls.requests[0].method, calls.requests[0].url.pathname, calls.requests[0].url.search], ["GET", "/gp/bestsellers/kitchen", ""]);
  assert.equal(location.href, `${ORIGIN}/`);
  assert.deepEqual(result, {
    status: "ok", category: "kitchen", category_name: "Home & Kitchen", page: 1,
    items: [
      { rank: 1, asin: "B0TESTAAA1", title: "Acme Steel Bottle 1000 ml", url: `${ORIGIN}/dp/B0TESTAAA1`, image_url: "https://images-eu.ssl-images-amazon.com/images/I/b0testaaa1._AC_UL300_SR300,200_.jpg", price_inr: 1, price_text: "\u20b91.00", rating: 4.5, rating_count: 911228 },
      { rank: 2, asin: "B0TESTBBB2", title: "Bulk Set of 6 Bottles", url: `${ORIGIN}/dp/B0TESTBBB2`, image_url: "https://images-eu.ssl-images-amazon.com/images/I/b0testbbb2._AC_UL300_SR300,200_.jpg", price_inr: 319, price_text: "\u20b9319.00", rating: 4.4, rating_count: 54479 },
      { rank: 3, asin: "B0TESTEEE5", title: "Unpriced Item", url: `${ORIGIN}/dp/B0TESTEEE5`, image_url: "https://images-eu.ssl-images-amazon.com/images/I/b0testeee5._AC_UL300_SR300,200_.jpg", price_inr: null, price_text: null, rating: null, rating_count: null }
    ],
    subcategories: [{ name: "Coffee, Tea & Espresso", category: "kitchen/1379960031" }, { name: "Cookware", category: "kitchen/1380015031" }]
  });
  assert.ok(!JSON.stringify(result).includes("000-0000000-0000000"), "session ids in the site's links are never returned");
  assert.ok(!JSON.stringify(result).includes("ref="));
  assert.equal((await chart({ category: "kitchen", limit: 2 })).result.items.length, 2);
});

test("list_bestsellers names a node chart and offers only its children, not its parents", async () => {
  const { result } = await chart({ category: "kitchen/1379960031" }, chartSite({ "/gp/bestsellers/kitchen/1379960031": fixture("bestsellers-node") }));
  assert.deepEqual([result.status, result.category, result.category_name], ["ok", "kitchen/1379960031", "Coffee, Tea & Espresso"]);
  assert.deepEqual(result.subcategories, [{ name: "Coffee Makers", category: "kitchen/51396613031" }]);
  assert.ok(!result.items.some(i => i.asin === "B0TESTSPN9"), "a tile whose badge is not a rank is skipped");
});

test("list_bestsellers reads the second page and node categories", async () => {
  const two = await chart({ category: "kitchen", page: 2 });
  assert.deepEqual([two.calls.requests[0].url.pathname, two.calls.requests[0].url.search], ["/gp/bestsellers/kitchen", "?pg=2"]);
  assert.deepEqual(two.result.items.map(i => [i.rank, i.asin, i.price_inr]), [[51, "B0TESTPG51", 10817.5]]);
  const node = await chart({ category: "kitchen/1379960031" }, chartSite({ "/gp/bestsellers/kitchen/1379960031": fixture("bestsellers-kitchen") }));
  assert.equal(node.calls.requests[0].url.pathname, "/gp/bestsellers/kitchen/1379960031");
  assert.equal(node.result.status, "ok");
});

test("list_bestsellers without a category lists the departments and no products", async () => {
  const { result, calls } = await chart({});
  assert.equal(calls.requests[0].url.pathname, "/gp/bestsellers");
  assert.deepEqual(result, { status: "ok", category: null, category_name: "Any Department", page: 1, items: [], subcategories: [{ name: "Amazon Launchpad", category: "boost" }, { name: "Books", category: "books" }, { name: "Home & Kitchen", category: "kitchen" }] });
});

test("list_bestsellers reports a chart the site does not have, an empty second page, and a changed page", async () => {
  const missing = (await chart({ category: "nosuchdept" })).result;
  assert.deepEqual([missing.status, missing.error_kind], ["error", "not_found"]);
  const empty = (await chart({ category: "kitchen", page: 2 }, chartSite({ "/gp/bestsellers/kitchen?pg=2": fixture("bestsellers-root") }))).result;
  assert.deepEqual(empty, { status: "no_results", category: "kitchen", page: 2 });
  const unreadable = fixture("bestsellers-kitchen").replace(/<span class="zg-bdg-text">#\d+<\/span>/g, "");
  const changed = (await chart({ category: "kitchen" }, chartSite({ "/gp/bestsellers/kitchen": unreadable }))).result;
  assert.deepEqual([changed.status, changed.error_kind], ["error", "site_changed"]);
});

test("every tool sends only read requests to its own paths", async () => {
  const runs = [
    await search({ query: "water bottle", include_facets: true, facet_ids: ["p_123:111"], department: "kitchen" }),
    await product({ asin: "B0TESTAAA1" }),
    await chart({ category: "kitchen", page: 2 })
  ];
  for (const { calls } of runs) for (const r of calls.requests) {
    assert.equal(r.method, "GET");
    assert.equal(r.url.origin, ORIGIN);
    assert.match(r.url.pathname, /^\/(s|dp\/[A-Z0-9]{10}|gp\/bestsellers(\/[a-z0-9-]+(\/\d+)?)?)$/);
    assert.equal(r.init.body, undefined);
  }
});

// ---- findings from independent review: department widening, encoded ORs, truncation flag, spoofing, caps and guards ----------

test("search_products does not return a search that Amazon widened to all categories", async () => {
  const widened = (finalUrl) => url => ({ body: searchSite()(url).body, url: finalUrl });
  const ask = (input, site) => search(input, site).then(r => r.result);
  assert.deepEqual(await ask({ query: "bottle", department: "sporting" }, widened(`${ORIGIN}/s?k=bottle&i=aps`)),
    { status: "no_results", query: "bottle", department: "sporting", sort_by: "relevance", page: 1, facet_ids: [], sponsored_excluded: 0 }, "a redirect to i=aps is a department miss, not results labelled with the department");
  assert.equal((await ask({ query: "bottle", department: "sporting" }, widened(`${ORIGIN}/s?k=bottle`))).status, "no_results", "a final url without a department is also a miss");
  const other = await ask({ query: "bottle", department: "sporting" }, widened(`${ORIGIN}/s?k=bottle&i=pets`));
  assert.deepEqual([other.status, other.error_kind], ["error", "site_changed"]);
  assert.equal((await ask({ query: "bottle", department: "sporting" }, widened(`${ORIGIN}/s?k=bottle&i=sporting`))).status, "ok");
  assert.equal((await ask({ query: "bottle" }, widened(`${ORIGIN}/s?k=bottle&i=aps`))).status, "ok", "no department requested, nothing to honour");
});

test("search_products decodes the doubly encoded OR the site puts in filter links", async () => {
  const { result } = await search({ query: "water bottle", include_facets: true, facet_ids: ["p_123:111", "p_123:222"] });
  assert.deepEqual(result.facets.map(g => g.name), ["Eligible for Free Delivery", "Brands", "Customer Reviews", "Colour"], "no group is lost once two ids share a key");
  assert.deepEqual(result.facets[1].options.map(o => [o.id, o.selected]), [["p_123:111", true], ["p_123:222", true], ["p_123:333", false]]);
  assert.deepEqual(result.facets[2].options.map(o => [o.id, o.selected]), [["p_72:1318476031", false]]);
  const three = await search({ query: "water bottle", include_facets: true, facet_ids: ["p_123:111", "p_123:222", "p_72:1318476031"] });
  assert.deepEqual(three.result.facets.flatMap(g => g.options.filter(o => o.selected).map(o => o.id)).sort(), ["p_123:111", "p_123:222", "p_72:1318476031"]);
  assert.ok(!JSON.stringify(three.result.facets).includes("%7C"), "no encoded separator leaks into an option id");
});

test("search_products bounds the filter list and says when it cut something", async () => {
  const options = n => Array.from({ length: n }, (_, i) => `<li><a href="/s?k=x&amp;rh=p_123%3A${1000 + i}"><span>Brand ${i}</span></a></li>`).join("");
  const group = (i, n) => `<div id="g${i}-title" role="heading"><span>Group ${i}</span></div><ul aria-labelledby="g${i}-title">${options(n)}</ul>`;
  const wide = (await search({ query: "x", include_facets: true }, searchSite({ facetsHtml: group(0, 45) }))).result;
  assert.equal(wide.facets[0].options.length, 40);
  assert.equal(wide.facets_truncated, true, "options beyond 40 in a group");
  const many = (await search({ query: "x", include_facets: true }, searchSite({ facetsHtml: Array.from({ length: 45 }, (_, i) => group(i, 1)).join("") }))).result;
  assert.equal(many.facets.length, 40);
  assert.equal(many.facets_truncated, true, "groups beyond 40");
  const unnamed = (await search({ query: "x", include_facets: true }, searchSite({ facetsHtml: "<div id=\"g-title\" role=\"heading\"><span>Group</span></div><ul aria-labelledby=\"g-title\"><li><a href=\"/s?k=x&amp;rh=p_123%3A1\"><span>Named</span></a></li><li><a href=\"/s?k=x&amp;rh=p_123%3A2\"></a></li></ul>" }))).result;
  assert.deepEqual([unnamed.facets[0].options.length, unnamed.facets_truncated], [1, true], "an option with no readable name is reported as missing, not dropped silently");
  const exact = (await search({ query: "x", include_facets: true }, searchSite({ facetsHtml: group(0, 40) }))).result;
  assert.deepEqual([exact.facets[0].options.length, exact.facets_truncated], [40, false]);
});

test("search_products reads bought_past_month only from the ratings block and applies its field caps", async () => {
  const spoof = "<div data-asin=\"B0TESTSPF1\" data-component-type=\"s-search-result\"><a href=\"/x/dp/B0TESTSPF1\"><h2><span>Bottle 10M+ bought in past month best seller</span></h2></a><span>5K+ bought in past month</span></div>";
  assert.equal((await search({ query: "x" }, searchSite({ cards: spoof }))).result.results[0].bought_past_month, null, "seller-written text and text outside the ratings block are not a sales figure");
  const long = "T".repeat(600);
  const badges = ["B".repeat(61), "One", "Two", "Three", "Four", "Five"].map(b => `<span class="a-badge-label-inner"><span class="a-badge-text">${b}</span></span>`).join("");
  const card = `<div data-asin="B0TESTCAP1" data-component-type="s-search-result"><a href="/x/dp/B0TESTCAP1"><h2><span>${long}</span></h2></a>${badges}<i class="a-icon"><span class="a-icon-alt">7 out of 5 stars</span></i><div data-cy="reviews-block"><span>4K+ bought in past month</span></div></div>`;
  const [item] = (await search({ query: "x" }, searchSite({ cards: card }))).result.results;
  assert.equal(item.title.length, 500);
  assert.deepEqual(item.badges, ["One", "Two", "Three"], "a badge over 60 characters is skipped and at most three are kept");
  assert.equal(item.rating, null, "a rating above 5 is not a rating");
  assert.equal(item.bought_past_month, "4K+");
});

test("get_product bounds every list and text field", async () => {
  const many = (n, make) => Array.from({ length: n }, (_, i) => make(i)).join("");
  const asin = i => `B0TEST${String(i).padStart(4, "0")}`;
  const html = `<html><body><input id="ASIN" value="B0TESTCAP1"><span id="productTitle">${"T".repeat(600)}</span>
    <div id="wayfinding-breadcrumbs_feature_div"><ul>${many(12, i => `<li><a>Crumb ${i}</a></li>`)}</ul></div>
    <div id="feature-bullets"><ul>${many(12, i => `<li><span class="a-list-item">${"b".repeat(600)}</span></li>`)}</ul></div>
    <div id="productOverview_feature_div"><table>${many(20, i => `<tr><td>Field ${i}</td><td>Value ${i}</td></tr>`)}</table></div>
    <div id="prodDetails"><table>${many(50, i => `<tr><th>${"N".repeat(100)}${i}</th><td>${"v".repeat(500)}</td></tr>`)}</table></div>
    <div id="twister_feature_div">${many(8, r => `<div id="inline-twister-row-dim${r}"><div id="inline-twister-dim-title-dim${r}">Dim ${r}: x</div><ul>${many(45, o => `<li data-asin="${asin(r * 100 + o)}">Option ${o}</li>`)}</ul></div>`)}</div>
    </body></html>`;
  const { result } = await product({ asin: "B0TESTCAP1" }, productSite(html));
  assert.equal(result.status, "ok");
  assert.equal(result.title.length, 500);
  assert.equal(result.breadcrumbs.length, 10);
  assert.equal(result.bullets.length, 10);
  assert.ok(result.bullets.every(b => b.length === 400));
  assert.equal(result.overview.length, 15);
  assert.equal(result.details.length, 40);
  assert.ok(result.details.every(d => d.name.length === 60 && d.value.length === 300));
  assert.equal(result.variations.length, 6);
  assert.ok(result.variations.every(v => v.options.length === 40));
});

test("get_product only trusts rupee prices, real M.R.P. elements and ratings up to 5", async () => {
  const page = inner => `<html><body><input id="ASIN" value="B0TESTAAA1"><span id="productTitle">Guarded</span>${inner}</body></html>`;
  const price = (symbol, whole) => `<div id="corePriceDisplay_desktop_feature_div"><span class="a-price priceToPay"><span class="a-offscreen"> </span><span><span class="a-price-symbol">${symbol}</span><span class="a-price-whole">${whole}</span></span></span></div>`;
  const dollars = (await product({ asin: "B0TESTAAA1" }, productSite(page(price("$", "12"))))).result;
  assert.deepEqual([dollars.price_inr, dollars.price_text], [null, null], "digits beside a non-rupee symbol are not rupees");
  const rupees = (await product({ asin: "B0TESTAAA1" }, productSite(page(price("&#8377;", "12"))))).result;
  assert.equal(rupees.price_inr, 12);
  const struck = `<div id="corePrice_feature_div"><span class="a-price a-text-price" data-a-strike="true"><span class="a-offscreen">&#8377;99</span></span></div>`;
  const unit = `<div id="corePrice_feature_div"><span class="a-price a-text-price"><span class="a-offscreen">&#8377;9.50</span></span></div>`;
  assert.equal((await product({ asin: "B0TESTAAA1" }, productSite(page(struck)))).result.mrp_inr, 99, "a struck-through price outside .basisPrice is still the M.R.P.");
  assert.equal((await product({ asin: "B0TESTAAA1" }, productSite(page(unit)))).result.mrp_inr, null, "a per-unit price is not an M.R.P.");
  const stars = value => `<span id="acrPopover" title="${value}"></span>`;
  assert.equal((await product({ asin: "B0TESTAAA1" }, productSite(page(stars("7 out of 5 stars"))))).result.rating, null);
  assert.equal((await product({ asin: "B0TESTAAA1" }, productSite(page(stars("4.5 out of 5 stars"))))).result.rating, 4.5);
});

test("list_bestsellers bounds subcategories, ignores badges that are not ranks up to 999, and needs a department list at the top level", async () => {
  const many = Array.from({ length: 70 }, (_, i) => `<li><a href="/gp/bestsellers/kitchen/${1000000 + i}/ref=x">Child ${i}</a></li>`).join("");
  const tree = `<div role="group" aria-label="Navigation Tree"><ul><li><span aria-current="page">Home</span></li>${many}</ul></div>`;
  const tile = (rank, asin) => `<div id="gridItemRoot"><div data-asin="${asin}"><span class="zg-bdg-text">${rank}</span><div class="p13n-sc-css-line-clamp-3">Item ${asin}</div></div></div>`;
  const body = `<html><body>${tree}${tile("#1000", "B0TEST1000")}${tile("#999", "B0TEST0999")}${tile("#7", "B0TEST0007")}</body></html>`;
  const { result } = await chart({ category: "kitchen" }, chartSite({ "/gp/bestsellers/kitchen": body }));
  assert.equal(result.subcategories.length, 60);
  assert.deepEqual(result.items.map(i => i.rank), [999, 7], "a four-digit badge is not a rank");
  const bare = (await chart({}, chartSite({ "/gp/bestsellers": "<html><body>nothing here</body></html>" }))).result;
  assert.deepEqual([bare.status, bare.error_kind], ["error", "site_changed"], "a page without a department list is not an empty success");
});
