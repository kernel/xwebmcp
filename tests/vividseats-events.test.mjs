import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";

// Harness for the vividseats.com search tool. Every page and API interaction is stubbed; nothing here contacts the
// live site. Events, venues, listings, prices and tokens below are fabricated.
const NAMES = ["search_events"];
const sources = Object.fromEntries(NAMES.map(name => [name, readFileSync(new URL(`../domains/vividseats.com/${name}.js`, import.meta.url), "utf8")]));
const registry = JSON.parse(readFileSync(new URL("../registry.json", import.meta.url), "utf8"));
const plain = value => JSON.parse(JSON.stringify(value));
const HOME = "https://www.vividseats.com/";
const FAKE_TOKEN = "00000000-0000-4000-8000-00000000abcd";

function conforms(schema, value, path = "$") {
  const bad = why => { conforms.last = path + ": " + why; return false; };
  if ("const" in schema && value !== schema.const) return bad("const");
  if (schema.enum && !schema.enum.includes(value)) return bad("enum");
  if (schema.type && ![schema.type].flat().some(type => {
    if (type === "null") return value === null;
    if (type === "integer") return Number.isInteger(value);
    if (type === "number") return typeof value === "number" && Number.isFinite(value);
    if (type === "array") return Array.isArray(value);
    if (type === "object") return value !== null && typeof value === "object" && !Array.isArray(value);
    return typeof value === type;
  })) return bad("type " + JSON.stringify(schema.type) + " got " + JSON.stringify(value)?.slice(0, 60));
  if (schema.oneOf && schema.oneOf.filter(s => conforms(s, value, path)).length !== 1) return bad("oneOf");
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) return bad("minItems");
    if (schema.maxItems !== undefined && value.length > schema.maxItems) return bad("maxItems");
    if (schema.items && !value.every((item, i) => conforms(schema.items, item, path + "[" + i + "]"))) return false;
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const missing = schema.required?.find(key => !Object.hasOwn(value, key));
    if (missing) return bad("missing " + missing);
    if (schema.properties) {
      if (Object.entries(schema.properties).some(([key, s]) => key in value && !conforms(s, value[key], path + "." + key))) return false;
      const extra = schema.additionalProperties === false ? Object.keys(value).find(key => !(key in schema.properties)) : undefined;
      if (extra) return bad("unknown field " + extra);
    }
  }
  if (typeof value === "string") {
    if (value.length < (schema.minLength ?? 0) || value.length > (schema.maxLength ?? Infinity)) return bad("length");
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) return bad("pattern");
  }
  if (typeof value === "number") {
    if (value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity)) return bad("range");
    if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) return bad("exclusiveMinimum");
  }
  return true;
}

// --- fabricated site data ---------------------------------------------------------------------------

const production = (id, name, extra = {}) => ({
  id, name, localDate: "2099-10-10T19:30:00-05:00[America/Chicago]", utcDate: "2099-10-11T00:30:00Z",
  venue: { id: 501, name: "Example Hall", city: "Springfield", state: "IL", countryCode: "US", latitude: 39.8, longitude: -89.65 },
  minPrice: 40, maxPrice: 120, avgPrice: 70, medianPrice: 65, minAipPrice: 55.5, maxAipPrice: 160, showAip: true,
  lastPricingRefresh: "2026-10-01T08:00:00-05:00[America/Chicago]", listingCount: 12, ticketCount: 40, categoryId: 2, subCategoryId: 14,
  dateTbd: false, timeTbd: false, ifNecessary: false, productionDelayType: "NONE", distance: 8046.72,
  webPath: `/example-band-tickets-springfield-example-hall-10-10-2099/production/${id}`, hidden: false,
  performers: [{ id: 9001, name: "Example Band", master: true }], ...extra
});
const productions = (items, extra = {}) => ({ page: 1, total: items.length, numberOfPages: 1, items, i18n: { from: "USD", to: "USD", rate: 1, applyCurrencyConversion: false }, ...extra });

// --- harness ------------------------------------------------------------------------------------------

function harness(name, o = {}) {
  const calls = { fetches: [] };
  const pageOrigin = o.origin ?? HOME;
  const respond = (path, n) => {
    if (o.route) { const forced = o.route(path, n); if (forced) return forced; }
    if (path.startsWith("/hermes/api/v1/productions?")) return { status: 200, body: productions([production(6001, "Example Band")]) };
    if (path === "/hermes/api/v1/location/search/token") return { status: 200, body: { uuid: FAKE_TOKEN } };
    if (path.startsWith("/hermes/api/v1/location/search/query?")) return { status: 200, body: [{ name: "Springfield, IL, USA", placeId: "ChIJfabricatedPlaceId000" }, { name: "Springfield, MO, USA", placeId: "ChIJfabricatedPlaceId111" }] };
    if (path.startsWith("/hermes/api/v1/location/ChIJ")) return { status: 200, body: { latitude: 39.8, longitude: -89.65, countryCode: "US", region: "IL", city: "Springfield" } };
    return { status: 404, body: {} };
  };
  const context = {
    JSON, URL, URLSearchParams, Promise, Date: o.Date ?? Date, AbortSignal, Math, Number, Object, Array, String, RegExp, Map, Set, Infinity, NaN, isFinite, encodeURIComponent,
    setTimeout: o.realTimers ? setTimeout : fn => { calls.waits = (calls.waits ?? 0) + 1; fn(); }, clearTimeout,
    document: { title: o.title ?? "Vivid Seats", cookie: o.cookie ?? "locale=en-US; pgid=416; other=1" },
    window: { location: new URL(pageOrigin) },
    fetch: async (path, init) => {
      calls.fetches.push({ path, init });
      assert.equal(init.method, undefined, "only GET requests are allowed");
      assert.equal(init.credentials, undefined);
      if (o.throws) throw new Error(o.throws);
      if (init.headers.accept === "text/html") {
        const page = o.pages?.(path);
        assert.ok(page, "unexpected page request " + path);
        return { status: page.status ?? 200, url: new URL(page.url ?? path, HOME).href, text: async () => page.html };
      }
      assert.equal(init.headers.accept, "application/json");
      const r = respond(path, calls.fetches.length);
      // A real fetch rejects when its signal is aborted while the request is in flight.
      if (init.signal?.aborted) throw Object.assign(new Error("The operation was aborted."), { name: "AbortError" });
      return { status: r.status, text: async () => (r.body === undefined ? "<html>blocked</html>" : JSON.stringify(r.body)) };
    }
  };
  const [definition] = runInNewContext(`(${sources[name]})`, context);
  return {
    definition, calls,
    run: async (input, options) => {
      const result = plain(await definition.execute(input, options));
      assert.ok(conforms(definition.tool.outputSchema, result), `${name} output violates its schema (${conforms.last}): ${JSON.stringify(result).slice(0, 400)}`);
      const text = JSON.stringify(result);
      assert.ok(!text.includes(FAKE_TOKEN), "the place-lookup session token must never be returned");
      return result;
    }
  };
}
const params = call => new URL(call.path, "https://www.vividseats.com").searchParams;

// --- structure ----------------------------------------------------------------------------------------

for (const name of NAMES) {
  test(`${name}: single-expression page tool with typed schemas and a registry entry`, () => {
    assert.equal(sources[name].trimEnd().endsWith(";"), false);
    assert.equal(/\b(Buffer|require|process)\b/.test(sources[name]), false, "tool source must not depend on Node globals");
    const { definition } = harness(name);
    assert.equal(definition.tool.name, name);
    assert.equal(definition.kind, "page");
    assert.deepEqual(plain(definition.match.url_patterns), ["https://www.vividseats.com/*"]);
    assert.equal(/\b(js|gotoUrl|pageInfo|waitForLoad|accessibilitySnapshot|click|pressKey|cdp)\(/.test(definition.execute.toString()), false, "page tools cannot use runtime helpers");
    assert.equal(/\b(location\.assign|location\.href\s*=|\.submit\(|requestSubmit|history\.)/.test(definition.execute.toString()), false, "page tools must not navigate their document");
    assert.equal(definition.tool.inputSchema.type, "object");
    assert.equal(definition.tool.inputSchema.additionalProperties, false);
    assert.equal(definition.tool.outputSchema.type, "object");
    assert.equal(definition.tool.annotations.readOnlyHint, true);
    assert.equal(definition.tool.annotations.destructiveHint, false);
    assert.equal(definition.tool.annotations.idempotentHint, true);
    const entry = registry.tools.find(t => t.domain === "vividseats.com" && t.tool === name);
    assert.ok(entry, "registry entry missing");
    assert.equal(entry.file, `domains/vividseats.com/${name}.js`);
    assert.equal(entry.kind, "page");
    assert.deepEqual(entry.url_patterns, plain(definition.match.url_patterns));
  });

  test(`${name}: only the observed read-only /hermes endpoints are referenced`, () => {
    const allowed = ["/hermes/api/v1/productions?", "/hermes/api/v1/location/search/token", "/hermes/api/v1/location/search/query?queryStr=", "/hermes/api/v1/location/"];
    const used = [...sources[name].matchAll(/"(\/hermes\/api\/v1\/[^"]*)"/g)].map(m => m[1]);
    assert.ok(used.length > 0);
    for (const path of used) assert.ok(allowed.includes(path), "unexpected endpoint " + path);
    assert.equal(/checkout|braintree|\/account|favorite|listing-manager|payment|reward|sell/i.test(used.join(" ")), false);
    assert.equal(/method\s*:/.test(sources[name]), false, "no request may set a method");
  });
}

test("registry lists the vividseats.com namespace sorted with status-consistent provenance", () => {
  const entries = registry.tools.filter(t => t.domain === "vividseats.com");
  assert.deepEqual(entries.map(t => t.tool), ["get_event", "get_venue", "list_listings", "prepare_ticket_selection", "search_events", "set_listing_filters", "set_listing_sort", "set_ticket_quantity", "show_more_listings"]);
  for (const entry of entries) {
    if (entry.status === "draft") assert.equal(entry.last_verified, null);
    else {
      assert.match(entry.last_verified, /^\d{4}-\d{2}-\d{2}$/);
      assert.match(entry.provenance.qa_agent, /^agt_[0-9a-f]{20}$/);
    }
    assert.equal(entry.namespace, "vividseats.com");
  }
});

test("the schema checker is not vacuous", () => {
  const { definition } = harness("search_events");
  assert.equal(conforms(definition.tool.outputSchema, { status: "ok" }), false);
  assert.equal(conforms(definition.tool.outputSchema, { status: "error", error_kind: "nope", error_message: "x" }), false);
  assert.equal(conforms(definition.tool.inputSchema, { page_size: 51 }), false);
  assert.equal(conforms(definition.tool.inputSchema, { query: "band", extra: true }), false);
});

// --- search_events: input validation happens before any page access -----------------------------------

const BAD_SEARCH = [
  [{ nope: 1 }, "unknown field"], [[], "array"], [{ query: "a" }, "short query"], [{ query: 5 }, "query type"], [{ query: "x".repeat(101) }, "long query"],
  [{ location: "x" }, "short location"], [{ location: "Chicago", latitude: 41, longitude: -87 }, "location with coordinates"],
  [{ latitude: 41 }, "latitude alone"], [{ longitude: -87 }, "longitude alone"], [{ latitude: 91, longitude: 0 }, "latitude range"], [{ latitude: 0, longitude: 181 }, "longitude range"],
  [{ latitude: "41", longitude: "-87" }, "coordinate types"], [{ radius_miles: 50 }, "radius without a place"], [{ location: "Chicago", radius_miles: 4 }, "radius low"],
  [{ location: "Chicago", radius_miles: 301 }, "radius high"], [{ location: "Chicago", radius_miles: 10.5 }, "radius fraction"],
  [{ start_date: "2026-02-30" }, "impossible date"], [{ start_date: "10/10/2026" }, "date format"], [{ end_date: "2026-13-01" }, "end month"],
  [{ start_date: "2026-10-12", end_date: "2026-10-10" }, "reversed dates"], [{ category: "movies" }, "category"], [{ sort: "price" }, "sort"],
  [{ performer_id: 0 }, "performer id"], [{ performer_id: "5" }, "performer id type"], [{ venue_id: 1.5 }, "venue id"], [{ max_lowest_all_in_price: 0 }, "ceiling zero"],
  [{ max_lowest_all_in_price: 99.5 }, "ceiling fraction"], [{ exclude_parking: "yes" }, "parking flag"], [{ page: 0 }, "page zero"], [{ page: 1001 }, "page high"],
  [{ page_size: 51 }, "page size high"], [{ page_size: 0 }, "page size zero"],
  [{ page: 21, page_size: 50 }, "page past the 1000-match window"], [{ page: 35, page_size: 30 }, "page past the window at another size"], [{ page: 144, page_size: 7 }, "page just past the window"],
  ...["query", "location", "latitude", "longitude", "radius_miles", "start_date", "end_date", "category", "performer_id", "venue_id", "max_lowest_all_in_price", "sort", "exclude_parking", "page", "page_size"].map(key => [{ [key]: null }, "null " + key])
];
for (const [input, label] of BAD_SEARCH) {
  test(`search_events rejects ${label} before touching the site`, async () => {
    const h = harness("search_events", { origin: "https://example.com/" });
    const result = await h.run(input);
    assert.equal(result.status, "error");
    assert.equal(result.error_kind, "invalid_input");
    assert.equal(h.calls.fetches.length, 0);
  });
}

test("search_events refuses other origins and bot-protection pages", async () => {
  const other = harness("search_events", { origin: "https://corporate.vividseats.com/" });
  assert.equal((await other.run({ query: "band" })).error_kind, "wrong_page");
  assert.equal(other.calls.fetches.length, 0);
  const blocked = harness("search_events", { title: "Access Denied" });
  assert.equal((await blocked.run({ query: "band" })).error_kind, "challenge");
  assert.equal(blocked.calls.fetches.length, 0);
});

// --- search_events: requests -----------------------------------------------------------------------------

test("search_events with no filters uses the site's defaults and hides parking", async () => {
  const h = harness("search_events");
  const result = await h.run({});
  assert.equal(result.status, "ok");
  assert.equal(h.calls.fetches.length, 1);
  const q = params(h.calls.fetches[0]);
  assert.equal(h.calls.fetches[0].path.startsWith("/hermes/api/v1/productions?"), true);
  assert.deepEqual(Object.fromEntries(q), { page: "1", pageSize: "20", currency: "USD", distinct: "false", sortBy: "DATE", excludeParking: "true" });
  assert.equal(result.resolved_location, null);
  assert.equal(result.currency, "USD");
});

test("search_events maps every filter to the parameters the site sends", async () => {
  const h = harness("search_events");
  await h.run({
    query: " tour ", latitude: 41.88325, longitude: -87.6323879, radius_miles: 100, start_date: "2026-10-10", end_date: "2026-10-11", category: "sports",
    performer_id: 77, venue_id: 88, max_lowest_all_in_price: 100, sort: "popular", exclude_parking: false, page: 3, page_size: 50
  });
  const q = Object.fromEntries(params(h.calls.fetches[0]));
  assert.deepEqual(q, {
    page: "3", pageSize: "50", currency: "USD", distinct: "false", sortBy: "RANK", query: "tour", latLong: "41.8832;-87.6324", radius: "160900",
    startDate: "2026-10-10", endDate: "2026-10-11", categoryId: "3", performerId: "77", venueId: "88", minListingPriceCeiling: "100"
  });
  for (const [category, id] of [["concerts", "2"], ["theater", "4"]]) {
    const each = harness("search_events");
    await each.run({ category });
    assert.equal(params(each.calls.fetches[0]).get("categoryId"), id);
  }
  const startOnly = harness("search_events");
  await startOnly.run({ start_date: "2026-10-10" });
  assert.equal(params(startOnly.calls.fetches[0]).has("endDate"), false);
});

test("search_events resolves location with the site's session-token place lookup and never returns the token", async () => {
  const h = harness("search_events");
  const result = await h.run({ location: "Springfield, IL", radius_miles: 25 });
  assert.deepEqual(h.calls.fetches.map(f => f.path.split("?")[0]), [
    "/hermes/api/v1/location/search/token", "/hermes/api/v1/location/search/query", "/hermes/api/v1/location/ChIJfabricatedPlaceId000", "/hermes/api/v1/productions"
  ]);
  assert.equal(h.calls.fetches[1].path, "/hermes/api/v1/location/search/query?queryStr=Springfield%2C%20IL&c=2");
  assert.equal(h.calls.fetches[1].init.headers["x-places-session-token"], FAKE_TOKEN);
  assert.equal(h.calls.fetches[2].init.headers["x-places-session-token"], FAKE_TOKEN);
  const q = params(h.calls.fetches[3]);
  assert.equal(q.get("latLong"), "39.8000;-89.6500");
  assert.equal(q.get("radius"), String(25 * 1609));
  assert.deepEqual(result.resolved_location, { name: "Springfield, IL, USA", latitude: 39.8, longitude: -89.65, country_code: "US" });
  assert.equal(result.query.radius_miles, 25);
});

test("search_events reports unknown places and place-lookup drift instead of searching everywhere", async () => {
  const none = harness("search_events", { route: p => (p.startsWith("/hermes/api/v1/location/search/query") ? { status: 200, body: [] } : null) });
  assert.equal((await none.run({ location: "Nowhereville" })).error_kind, "location_not_found");
  assert.equal(none.calls.fetches.some(f => f.path.startsWith("/hermes/api/v1/productions")), false);
  const noToken = harness("search_events", { route: p => (p === "/hermes/api/v1/location/search/token" ? { status: 200, body: { uuid: "short" } } : null) });
  assert.equal((await noToken.run({ location: "Springfield" })).error_kind, "site_changed");
  const noCoords = harness("search_events", { route: p => (p.startsWith("/hermes/api/v1/location/ChIJ") ? { status: 200, body: { city: "Springfield" } } : null) });
  assert.equal((await noCoords.run({ location: "Springfield" })).error_kind, "site_changed");
  const denied = harness("search_events", { route: p => (p.startsWith("/hermes/api/v1/location/search/query") ? { status: 403, body: undefined } : null) });
  assert.equal((await denied.run({ location: "Springfield" })).error_kind, "challenge");
  const unsafe = harness("search_events", { route: p => (p.startsWith("/hermes/api/v1/location/search/query") ? { status: 200, body: [{ name: "X", placeId: "../checkout/../../x" }] } : null) });
  assert.equal((await unsafe.run({ location: "Springfield" })).error_kind, "location_not_found");
});

test("search_events coordinates skip the place lookup", async () => {
  const h = harness("search_events");
  const result = await h.run({ latitude: 39.8, longitude: -89.65 });
  assert.equal(h.calls.fetches.length, 1);
  assert.equal(params(h.calls.fetches[0]).get("radius"), String(50 * 1609));
  assert.equal(result.resolved_location.latitude, 39.8);
  assert.equal(result.resolved_location.country_code, null);
});

// --- search_events: results ---------------------------------------------------------------------------------

test("search_events normalizes events, units and price basis", async () => {
  const items = [
    production(6001, "Example Band"),
    production(6002, "Sold Out Night", { listingCount: 0, ticketCount: 0, minAipPrice: 0, maxAipPrice: 0 }),
    production(6003, "Date To Be Announced", { dateTbd: true, timeTbd: true, distance: null, localDate: "2026-12-31T00:00:00-05:00[America/New_York]", utcDate: "2026-12-31T05:00:00Z" }),
    production(6004, "Time Pending", { timeTbd: true, showAip: false }),
    production(6005, "Odd Path", { webPath: "/x/../checkout/production/6005", performers: Array.from({ length: 12 }, (_, i) => ({ id: i + 1, name: "P" + i })) })
  ];
  const h = harness("search_events", { route: p => (p.startsWith("/hermes/api/v1/productions?") ? { status: 200, body: productions(items, { total: 1200, numberOfPages: 60, page: 2 }) } : null) });
  const result = await h.run({ page: 2, page_size: 20 });
  assert.equal(result.status, "ok");
  assert.equal(result.has_more, true);
  assert.equal(result.total, 1200);
  assert.ok(result.warnings.some(w => /1000/.test(w)));
  const [a, b, c, d, e] = result.events;
  assert.equal(a.rank, 21);
  assert.equal(a.production_id, 6001);
  assert.equal(a.url, "https://www.vividseats.com/example-band-tickets-springfield-example-hall-10-10-2099/production/6001");
  assert.deepEqual([a.local_date, a.local_time, a.weekday, a.time_zone, a.start_utc], ["2099-10-10", "19:30", "Saturday", "America/Chicago", "2099-10-11T00:30:00.000Z"]);
  assert.equal(a.distance_miles, 5, "distance is in meters on the wire");
  assert.deepEqual([a.lowest_all_in_price, a.highest_all_in_price, a.listing_count, a.ticket_count], [55.5, 160, 12, 40]);
  assert.equal(a.pricing_refreshed_at, "2026-10-01T13:00:00.000Z");
  assert.deepEqual(a.venue, { id: 501, name: "Example Hall", city: "Springfield", state: "IL", country_code: "US" });
  assert.deepEqual(a.performers, [{ id: 9001, name: "Example Band" }]);
  assert.deepEqual([a.category_id, a.subcategory_id, a.delay_type], [2, 14, "NONE"]);
  assert.deepEqual([b.listing_count, b.lowest_all_in_price, b.highest_all_in_price], [0, null, null], "no listings means no price");
  assert.deepEqual([c.date_tbd, c.time_tbd, c.local_date, c.local_time, c.weekday, c.start_utc, c.distance_miles], [true, true, null, null, null, null, null]);
  assert.deepEqual([d.local_date, d.local_time, d.lowest_all_in_price], ["2099-10-10", null, null], "prices are withheld when the site does not show all-in prices");
  assert.equal(e.url, null, "only canonical /<slug>/production/<id> paths become URLs");
  assert.equal(e.performers.length, 10);
  assert.match(result.price_basis, /USD/);
});

test("search_events keeps the last page from claiming more results", async () => {
  const h = harness("search_events", { route: p => (p.startsWith("/hermes/api/v1/productions?") ? { status: 200, body: productions([production(6001, "Example Band")], { total: 21, numberOfPages: 2, page: 2 }) } : null) });
  const result = await h.run({ page: 2, page_size: 20 });
  assert.equal(result.has_more, false);
  assert.equal(result.events[0].rank, 21);
  assert.equal(result.warnings.length, 0);
});

test("search_events warns that a price ceiling keeps events without listings", async () => {
  const h = harness("search_events", { route: p => (p.startsWith("/hermes/api/v1/productions?") ? { status: 200, body: productions([production(6002, "Empty", { listingCount: 0, ticketCount: 0, minAipPrice: 0, maxAipPrice: 0 })]) } : null) });
  const result = await h.run({ max_lowest_all_in_price: 50 });
  assert.ok(result.warnings.some(w => /no listings/.test(w)));
});

test("search_events returns no_results for empty pages and for dates that have passed", async () => {
  const empty = harness("search_events", { route: p => (p.startsWith("/hermes/api/v1/productions?") ? { status: 200, body: productions([], { total: 0, numberOfPages: 1 }) } : null) });
  const result = await empty.run({ query: "zzzz" });
  assert.equal(result.status, "no_results");
  assert.equal(result.query.query, "zzzz");
  const past = harness("search_events", { route: p => (p.startsWith("/hermes/api/v1/productions?") ? { status: 404, body: { message: "Event date has passed <script>" } } : null) });
  const gone = await past.run({ start_date: "2020-01-01", end_date: "2020-01-02" });
  assert.equal(gone.status, "no_results");
  assert.equal(JSON.stringify(gone).includes("script"), false, "site text is not echoed");
  const other404 = harness("search_events", { route: p => (p.startsWith("/hermes/api/v1/productions?") ? { status: 404, body: { message: "Something else" } } : null) });
  assert.equal((await other404.run({ query: "band" })).error_kind, "site_error", "only the observed past-date 404 is a normal empty result");
  const proxy404 = await harness("search_events", { route: p => (p.startsWith("/hermes/api/v1/productions?") ? { status: 404, body: { error: "Request failed with status code 404" } } : null), pages: () => ({ status: 503, html: "" }) }).run({ query: "band" });
  assert.deepEqual([proxy404.error_kind, /until the page has had user input.*Move the mouse/.test(proxy404.error_message)], ["site_error", true], "the proxy's generic 404 says what ends it");
});

test("search_events never turns blocks or drift into empty results", async () => {
  const cases = [
    [{ status: 403, body: undefined }, "challenge"], [{ status: 429, body: {} }, "rate_limited"], [{ status: 500, body: {} }, "site_error"], [{ status: 200, body: undefined }, "site_error"],
    [{ status: 200, body: { items: "nope", total: 1, numberOfPages: 1 } }, "site_changed"], [{ status: 200, body: { items: [], numberOfPages: 1 } }, "site_changed"],
    [{ status: 200, body: productions([production(1, "X")], { i18n: { from: "USD", to: "EUR", rate: 0.88, applyCurrencyConversion: true } }) }, "site_changed"],
    [{ status: 200, body: { page: 1, total: 1, numberOfPages: 1, items: [production(1, "X")] } }, "site_changed"],
    [{ status: 200, body: productions([{ name: "No id" }, { id: 5 }]) }, "site_changed"]
  ];
  for (const [response, kind] of cases) {
    const h = harness("search_events", { route: p => (p.startsWith("/hermes/api/v1/productions?") ? response : null) });
    const result = await h.run({ query: "band" });
    assert.equal(result.status, "error", JSON.stringify(response).slice(0, 80));
    assert.equal(result.error_kind, kind, JSON.stringify(response).slice(0, 80));
  }
  const thrown = harness("search_events", { throws: "network down" });
  assert.equal((await thrown.run({ query: "band" })).error_kind, "site_error");
});

test("search_events skips malformed events with a warning and bounds site text", async () => {
  const items = [production(6001, "  Band\u0000\u0007\nName " + "x".repeat(400)), { name: "No id" }];
  const h = harness("search_events", { route: p => (p.startsWith("/hermes/api/v1/productions?") ? { status: 200, body: productions(items) } : null) });
  const result = await h.run({ query: "band" });
  assert.equal(result.events.length, 1);
  assert.ok(result.warnings.some(w => /skipped/.test(w)));
  assert.ok(result.events[0].name.length <= 200);
  assert.equal(/[\u0000-\u001f]/.test(result.events[0].name), false);
});

test("search_events sends nothing but GET reads to the search and place endpoints", async () => {
  const search = harness("search_events");
  await search.run({ location: "Springfield, IL", query: "band", category: "concerts" });
  const paths = search.calls.fetches.map(f => f.path.split("?")[0].replace(/ChIJ\w+/, "ChIJ*"));
  assert.deepEqual([...new Set(paths)].sort(), ["/hermes/api/v1/location/ChIJ*", "/hermes/api/v1/location/search/query", "/hermes/api/v1/location/search/token", "/hermes/api/v1/productions"]);
});

// --- review findings: paging window, past-the-end pages, soft radius, started events, quantity null ------------

test("search_events accepts the last pages inside the site's 1000-match window", async () => {
  for (const [page, page_size] of [[20, 50], [34, 30], [143, 7], [1000, 1]]) {
    const h = harness("search_events", { route: p => (p.startsWith("/hermes/api/v1/productions?") ? { status: 200, body: productions([production(6001, "Example Band")], { total: 1000, numberOfPages: Math.ceil(1000 / page_size), page }) } : null) });
    const result = await h.run({ page, page_size });
    assert.equal(result.status, "ok", `${page}/${page_size}`);
    assert.equal(h.calls.fetches.length, 1);
  }
});

test("search_events does not repeat the last page under new ranks when the page is past the end", async () => {
  const clamped = harness("search_events", { route: p => (p.startsWith("/hermes/api/v1/productions?") ? { status: 200, body: productions([production(6001, "Example Band")], { total: 83, numberOfPages: 17, page: 17 }) } : null) });
  const result = await clamped.run({ performer_id: 130861, page: 21, page_size: 5 });
  assert.equal(result.status, "no_results");
  assert.match(result.message, /17 page\(s\) at page_size 5; page 21 is past the last one/);
  const noPageField = harness("search_events", { route: p => (p.startsWith("/hermes/api/v1/productions?") ? { status: 200, body: { total: 83, numberOfPages: 17, items: productions([production(6001, "Example Band")]).items, i18n: productions([]).i18n } } : null) });
  assert.equal((await noPageField.run({ page: 21, page_size: 5 })).status, "no_results", "numberOfPages alone is enough to detect a page past the end");
  const last = harness("search_events", { route: p => (p.startsWith("/hermes/api/v1/productions?") ? { status: 200, body: productions([production(6001, "Example Band")], { total: 83, numberOfPages: 17, page: 17 }) } : null) });
  const ok = await last.run({ performer_id: 130861, page: 17, page_size: 5 });
  assert.equal(ok.status, "ok");
  assert.equal(ok.events[0].rank, 81);
});

test("search_events warns that the site's radius is approximate and that started events may have stale index data", async () => {
  const items = [production(6001, "Near", { distance: 5 * 1609.344 }), production(6002, "Far", { distance: 33.7 * 1609.344 }), production(6003, "Underway", { utcDate: "2020-01-01T00:00:00Z", localDate: "2019-12-31T18:00:00-06:00[America/Chicago]" })];
  const h = harness("search_events", { route: p => (p.startsWith("/hermes/api/v1/productions?") ? { status: 200, body: productions(items) } : null) });
  const result = await h.run({ latitude: 39.8, longitude: -89.65, radius_miles: 25 });
  assert.ok(result.warnings.some(w => /1 event\(s\) are farther than radius_miles/.test(w)), JSON.stringify(result.warnings));
  assert.ok(result.warnings.some(w => /1 event\(s\) have already started/.test(w)), JSON.stringify(result.warnings));
  const quiet = harness("search_events", { route: p => (p.startsWith("/hermes/api/v1/productions?") ? { status: 200, body: productions([production(6001, "Near", { distance: 25 * 1609.344 })]) } : null) });
  assert.deepEqual((await quiet.run({ latitude: 39.8, longitude: -89.65, radius_miles: 25 })).warnings, [], "an event at exactly the radius, in the future, needs no warning");
  const placeholder = harness("search_events", { route: p => (p.startsWith("/hermes/api/v1/productions?") ? { status: 200, body: productions([production(6004, "Time Pending", { timeTbd: true, utcDate: "2020-01-01T23:59:00Z", localDate: "2020-01-01T23:59:00-06:00[America/Chicago]" })]) } : null) });
  assert.deepEqual((await placeholder.run({})).warnings, [], "a time-TBD event's placeholder instant is not a start time");
  const noPlace = harness("search_events", { route: p => (p.startsWith("/hermes/api/v1/productions?") ? { status: 200, body: productions([production(6001, "Anywhere", { distance: null })]) } : null) });
  assert.deepEqual((await noPlace.run({})).warnings, []);
});

test("search_events bounds a site response that exceeds page_size", async () => {
  const items = Array.from({ length: 100 }, (_, i) => production(6001 + i, "Example Event"));
  const h = harness("search_events", { route: p => p.startsWith("/hermes/api/v1/productions?") ? { status: 200, body: productions(items) } : null });
  const result = await h.run({ page_size: 3 });
  assert.equal(result.events.length, 3);
  assert.ok(result.warnings.some(w => /more than page_size/.test(w)));
});

const nextData = props => `<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: props } })}</script></html>`;
const proxy404 = p => (p.startsWith("/hermes/api/v1/productions?") ? { status: 404, body: { error: "Request failed with status code 404" } } : null);

test("search_events reads the site's search page when the JSON search answers its generic 404", async () => {
  const performer = "/example-band-tickets--concerts-rock/performer/9001";
  const all = [production(6001, "Example Band"), production(6002, "Example Band", { localDate: "2099-11-01T20:00:00-05:00[America/Chicago]" })];
  const h = harness("search_events", {
    route: proxy404,
    pages: p => {
      if (p === "/search?searchTerm=Example%20Band") return { url: performer, html: nextData({ initialProductionListParams: { performerId: 9001 }, initialProductionListData: productions(all) }) };
      if (p === performer + "?startDate=2099-10-01&endDate=2099-10-31") return { url: p, html: nextData({ initialProductionListParams: { performerId: 9001, startDate: "2099-10-01", endDate: "2099-10-31" }, initialProductionListData: productions(all.slice(0, 1)) }) };
      return null;
    }
  });
  const result = await h.run({ query: "Example Band", start_date: "2099-10-01", end_date: "2099-10-31" });
  assert.equal(result.status, "ok");
  assert.deepEqual(result.events.map(e => e.production_id), [6001]);
  assert.ok(result.warnings.some(w => w.includes(performer)), "the warning names the page the results came from");
  assert.ok(!result.warnings.some(w => /did not apply/.test(w)), "the performer page applied the dates and lists no parking passes");
  assert.deepEqual(h.calls.fetches.filter(c => c.init.headers.accept === "text/html").map(c => c.path), ["/search?searchTerm=Example%20Band", performer + "?startDate=2099-10-01&endDate=2099-10-31"]);
});

test("search_events never returns search-page results without a filter the caller asked for, and does not use it for place, later-page or popularity searches", async () => {
  const searchPage = () => ({ html: nextData({ initialAllProductionListParams: { query: "band" }, initialAllProductionListData: productions([production(6001, "Example Band")]) }) });
  for (const filter of [{ start_date: "2099-10-01" }, { category: "concerts" }, { performer_id: 77 }, { venue_id: 88 }, { max_lowest_all_in_price: 100 }]) {
    const refused = await harness("search_events", { route: proxy404, pages: searchPage }).run({ query: "band", ...filter });
    assert.equal(refused.error_kind, "site_error", JSON.stringify(filter));
    assert.match(refused.error_message, /cannot apply .*no unfiltered results/);
  }
  const result = await harness("search_events", { route: proxy404, pages: searchPage }).run({ query: "band" });
  assert.equal(result.status, "ok");
  assert.ok(result.warnings.some(w => /did not apply exclude_parking/.test(w)), "the search page lists parking passes");
  for (const input of [{ query: "band", location: "Springfield, IL" }, { query: "band", latitude: 39.8, longitude: -89.65 }, { query: "band", page: 2 }, { query: "band", sort: "popular" }, { start_date: "2099-10-01" }]) {
    const other = harness("search_events", { route: proxy404, pages: () => { throw new Error("the search page must not be read for " + JSON.stringify(input)); } });
    assert.equal((await other.run(input)).error_kind, "site_error", JSON.stringify(input));
  }
});

const eventPage = p => (p === "/event/production/6001" ? { url: "/example-band-tickets/production/6001", html: "<html></html>" } : null);
const unknownEvent = p => (p === "/event/production/6001" ? { status: 404, url: "/404?productionId=6001", html: "<html></html>" } : null);

test("search_events pages by the number of events the site's search page holds when it holds fewer than page_size", async () => {
  const performer = "/example-band-tickets--concerts-rock/performer/9001";
  const held = [6001, 6002, 6003].map(id => production(id, "Example Band"));
  const h = harness("search_events", {
    route: proxy404,
    pages: p => (p === "/search?searchTerm=Example%20Band" ? { url: performer, html: nextData({ initialProductionListParams: { performerId: 9001 }, initialProductionListData: productions(held, { total: 30 }) }) } : null)
  });
  const result = await h.run({ query: "Example Band", page_size: 20 });
  assert.equal(result.status, "ok");
  assert.equal(result.events.length, 3);
  assert.deepEqual([result.page_size, result.number_of_pages, result.has_more, result.query.page_size], [3, 10, true, 3]);
  assert.ok(result.warnings.some(w => /page 2, page_size 3, performer_id 9001 and no query/.test(w)), "page 2 continues the performer page's list where it ends");
  const searchPage = harness("search_events", {
    route: proxy404,
    pages: p => (p === "/search?searchTerm=band" ? { html: nextData({ initialAllProductionListParams: { query: "band" }, initialAllProductionListData: productions(held, { total: 30 }) }) } : null)
  });
  const text = await searchPage.run({ query: "band", page_size: 20 });
  assert.ok(text.warnings.some(w => /with page 2, page_size 3 and exclude_parking false, since that page includes parking passes, to continue without a gap/.test(w)), "a search page continues with the same text search, parking passes included as on that page");
  const withParking = await searchPage.run({ query: "band", page_size: 20, exclude_parking: false });
  assert.ok(withParking.warnings.some(w => /with page 2, page_size 3 to continue without a gap/.test(w)), "nothing to add when parking passes were asked for");
});

test("search_events passes the caller's signal to its requests and reports a canceled search as canceled", async () => {
  const controller = new AbortController();
  const h = harness("search_events");
  controller.abort();
  assert.equal((await h.run({ query: "band" }, { signal: controller.signal })).error_kind, "canceled");
  assert.equal(h.calls.fetches[0].init.signal, controller.signal);
});
