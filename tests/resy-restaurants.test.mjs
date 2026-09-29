import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";

// Harness for the resy.com page tools. The page (window, fetch, timers) is stubbed; nothing here contacts the live
// site. Venues, ids, slugs, keys and booking handles below are fabricated, shaped like the responses the tools read.
const NAMES = ["search_restaurants", "get_restaurant", "get_availability", "get_availability_calendar"];
const sources = Object.fromEntries(NAMES.map(name => [name, readFileSync(new URL(`../domains/resy.com/${name}.js`, import.meta.url), "utf8")]));
const registry = JSON.parse(readFileSync(new URL("../registry.json", import.meta.url), "utf8"));
const plain = value => JSON.parse(JSON.stringify(value));
const FAKE_KEY = "fabricatedapikey0000000000000000";
const FAKE_HANDLE = "rgs://fabricated/handle/000";
const NOW = Date.parse("2026-09-29T12:00:00Z");

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
    if (schema.items && !value.every(item => conforms(schema.items, item))) return false;
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    if (schema.required?.some(key => !Object.hasOwn(value, key))) return false;
    const props = schema.properties || {};
    if (Object.entries(props).some(([key, s]) => key in value && !conforms(s, value[key]))) return false;
    if (schema.additionalProperties === false && Object.keys(value).some(key => !(key in props))) return false;
  }
  if (typeof value === "string") {
    if (value.length < (schema.minLength ?? 0) || value.length > (schema.maxLength ?? Infinity)) return false;
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) return false;
  }
  if (typeof value === "number") {
    if (value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity)) return false;
  }
  return true;
}

// --- fabricated site data -------------------------------------------------------------------------------

const LOCATIONS = [
  { code: "xa", name: "Exampleton", url_slug: "exampleton-xa", map_center: { latitude: 40, longitude: -74 }, show_on_web: 1 },
  { code: "xb", name: "Sampleville", url_slug: "sampleville-xb", map_center: { latitude: 34, longitude: -118 }, show_on_web: 1 },
  { code: "hid", name: "Hidden Test", url_slug: "hidden-test", map_center: { latitude: 1, longitude: 1 }, show_on_web: 0 },
  { code: "nomc", name: "No Center", url_slug: "no-center", show_on_web: 1 }
];
const slot = (start, end, type = "Dining Room", template = 11, extra = {}) => ({
  date: { start: `2026-10-09 ${start}:00`, end: end ? `2026-10-09 ${end}:00` : null }, template: { id: template },
  config: { id: 5, token: FAKE_HANDLE, type }, exclusive: { id: 0, is_eligible: true }, is_global_dining_access: false, reservation_config: { badge: null }, ...extra
});
const TEMPLATES = {
  11: { id: 11, is_paid: false, cancellation_fee: null, secs_cancel_cut_off: null, time_cancel_cut_off: null, deposit_fee: null, service_charge: null },
  12: { id: 12, is_paid: true, cancellation_fee: 25, secs_cancel_cut_off: 86400, time_cancel_cut_off: null, deposit_fee: null, service_charge: null },
  13: { id: 13, is_paid: true, cancellation_fee: null, secs_cancel_cut_off: 0, time_cancel_cut_off: "12:00:00", deposit_fee: 50, service_charge: "0%" }
};
const hit = (id, name, extra = {}) => ({
  id: { resy: id }, name, url_slug: name.toLowerCase().replace(/[^a-z]+/g, "-"), location: { id: 1, code: "xa", name: "Exampleton", url_slug: "exampleton-xa" },
  cuisine: ["Italian"], price_range_id: 3, neighborhood: "Old Quarter", locality: "Exampleton", region: "XA", country: "US", _geoloc: { lat: 40.01, lng: -74.01 },
  rating: { average: 4.6, count: 120 }, max_party_size: 8, is_global_dining_access: false, is_tock_inventory: false, waitlist: { available: 0 },
  availability: { gating_errors: {}, notify_options: [{ service_type_id: 2 }], slots: [slot("18:30", "20:00", "Dining Room", 11), slot("19:00", "20:30", "Bar", 12)], templates: TEMPLATES, status: null },
  ...extra
});
const searchBody = (hits, total = hits.length) => ({ search: { hits, page: 1, nbHits: total }, suggestions: [], meta: { page: 1, per_page: hits.length, total } });
const VENUE = {
  id: { resy: 1001, google: "fabricated", foursquare: null }, name: "Fabricated Trattoria", type: "Italian", price_range_id: 4, url_slug: "fabricated-trattoria",
  min_party_size: 1, max_party_size: 10, large_party_message: "Contact the venue for larger groups.", is_global_dining_access: true, is_resy_credit_eligible: false,
  rater: [{ name: "Resy", scale: 5, score: 4.75, total: 900 }], locale: { currency: "USD", time_zone: "EST5EDT" },
  contact: { phone_number: "+15555550100", url: "https://trattoria.example.invalid/", menu_url: "https://trattoria.example.invalid/menu" },
  location: { address_1: "1 Example Street", address_2: null, cross_street_1: "Sample Avenue", neighborhood: "Old Quarter", locality: "Exampleton", region: "XA", postal_code: "00001", country: "United States", latitude: 40.1, longitude: -74.1, url_slug: "exampleton-xa" },
  content: [
    { name: "about", body: "About the fabricated trattoria." }, { name: "why_we_like_it", body: "Because it is fabricated." },
    { name: "need_to_know", body: "Bring nothing." }, { name: "tagline", body: "" }
  ],
  announcement: { headline: "ignored" }, favorite: true, user_venue_lists: [{ id: "private" }]
};
const findBody = (slots = [slot("18:30", "20:00", "Dining Room", 11), slot("19:00", "20:30", "Bar", 12), slot("21:00", null, "Chef Counter", 13, { is_global_dining_access: true })], extra = {}) => ({
  query: { day: "2026-10-09", party_size: 2 },
  results: { venues: [{ venue: { id: { resy: 1001 }, name: "Fabricated Trattoria", url_slug: "fabricated-trattoria", location: { url_slug: "exampleton-xa", time_zone: "EST5EDT" }, currency: { symbol: "$", code: "USD" }, notify_options: [{ service_type_id: 2 }] }, templates: TEMPLATES, slots, gating_errors: {}, notifies: [], ...extra }] }
});
const calendarBody = (days = [["2026-10-09", "available"], ["2026-10-10", "sold-out"]]) => ({ scheduled: days.map(([date, reservation]) => ({ date, inventory: { reservation, event: "not available", "walk-in": "available" } })), last_calendar_day: "2026-10-31" });

// --- harness ------------------------------------------------------------------------------------------

function harness(name, o = {}) {
  const calls = { requests: [], timers: [] };
  const route = (method, path, body) => {
    if (o.route) { const forced = o.route(method, path, body); if (forced) return forced; }
    if (method === "GET" && path === "/3/location/config") return { status: 200, body: LOCATIONS };
    if (method === "POST" && path === "/3/venuesearch/search") return { status: 200, body: searchBody([hit(2001, "Fabricated Osteria"), hit(2002, "Sample Sushi", { cuisine: ["Sushi"], is_tock_inventory: true })], 2) };
    if (method === "GET" && path.startsWith("/3/venue?")) return { status: 200, body: VENUE };
    if (method === "POST" && path === "/4/find") return { status: 200, body: findBody() };
    if (method === "GET" && path.startsWith("/4/venue/calendar?")) return { status: 200, body: calendarBody() };
    return { status: 404, body: { status: 404 } };
  };
  const fakeFetch = async (url, init) => {
    assert.ok(url.startsWith("https://api.resy.com/"), "only api.resy.com may be called: " + url);
    const path = url.slice("https://api.resy.com".length);
    const body = init.body === undefined ? undefined : JSON.parse(init.body);
    calls.requests.push({ method: init.method, path, body, init });
    if (o.hang) {
      return new Promise((_, reject) => {
        init.signal.addEventListener("abort", () => reject(new Error("aborted")));
        queueMicrotask(() => calls.timers.find(t => t.ms === 25000)?.fn());
      });
    }
    if (o.networkError) throw new TypeError("Failed to fetch");
    const r = route(init.method, path, body);
    return { status: r.status, text: async () => (r.raw !== undefined ? r.raw : JSON.stringify(r.body)) };
  };
  class FixedDate extends Date {
    constructor(...args) { if (args.length) super(...args); else super(NOW); }
    static now() { return NOW; }
  }
  const context = {
    JSON, URL, URLSearchParams, Promise, Math, Number, Object, Array, String, RegExp, Map, Set, Infinity, NaN, isFinite, Error, TypeError, AbortController, queueMicrotask,
    Date: FixedDate,
    setTimeout: (fn, ms) => { calls.timers.push({ fn, ms }); if (ms < 1000) fn(); return calls.timers.length; },
    clearTimeout: () => {},
    fetch: fakeFetch,
    window: { location: { origin: o.origin ?? "https://resy.com" }, apiConfig: "apiConfig" in o ? o.apiConfig : { Config: { apiKey: FAKE_KEY } } }
  };
  const [definition] = runInNewContext(`(${sources[name]})`, context);
  return {
    definition, calls,
    run: async input => {
      const result = plain(await definition.execute(input));
      assert.ok(conforms(definition.tool.outputSchema, result), `${name} output violates its schema: ${JSON.stringify(result)}`);
      const text = JSON.stringify(result);
      assert.ok(!text.includes(FAKE_KEY), "the page's API key must not leave the page");
      assert.ok(!text.includes("rgs://") && !text.includes(FAKE_HANDLE), "booking handles must not be returned");
      for (const r of calls.requests) {
        assert.equal(r.init.credentials, "omit");
        assert.equal(r.init.headers.Authorization, `ResyAPI api_key="${FAKE_KEY}"`);
        assert.equal(r.init.headers["x-origin"], "https://resy.com");
        assert.equal(r.init.headers["Cache-Control"], "no-cache");
        assert.equal(Object.keys(r.init.headers).some(k => /^x-resy/i.test(k)), false, "public tools must not send account tokens");
        assert.ok(["/3/location/config", "/3/venuesearch/search", "/4/find"].includes(r.path) || /^\/(3\/venue\?|4\/venue\/calendar\?)/.test(r.path), "unexpected endpoint: " + r.path);
      }
      return result;
    }
  };
}

// --- structure ----------------------------------------------------------------------------------------

for (const name of NAMES) {
  test(`${name}: single-expression page tool with typed schemas and a registry entry`, () => {
    assert.equal(sources[name].trimEnd().endsWith(";"), false);
    assert.equal(/\b(Buffer|require|process)\b/.test(sources[name]), false, "tool source must not depend on Node globals");
    assert.equal(/\/3\/(details|book|user|notify|cancel)|\/4\/(book|cancel)|apiAuthToken|x-resy-|localStorage|sessionStorage|document\.cookie/i.test(sources[name]), false, "tool source must not reach booking, account, notify or token surfaces");
    const { definition } = harness(name);
    assert.equal(definition.kind, "page");
    assert.equal(definition.tool.name, name);
    assert.deepEqual(plain(definition.match.url_patterns), ["https://resy.com/*"]);
    assert.equal(/\b(js|gotoUrl|pageInfo|waitForLoad|accessibilitySnapshot|click|pressKey|cdp)\(/.test(definition.execute.toString()), false, "page tools cannot use runtime helpers");
    assert.equal(definition.tool.inputSchema.type, "object");
    assert.equal(definition.tool.inputSchema.additionalProperties, false);
    assert.equal(definition.tool.outputSchema.type, "object");
    assert.equal(definition.tool.annotations.readOnlyHint, true);
    assert.equal(definition.tool.annotations.destructiveHint, false);
    const entry = registry.tools.find(t => t.domain === "resy.com" && t.tool === name);
    assert.ok(entry, "registry entry missing");
    assert.equal(entry.file, `domains/resy.com/${name}.js`);
    assert.equal(entry.kind, "page");
    assert.deepEqual(entry.url_patterns, plain(definition.match.url_patterns));
  });
}

test("registry lists every resy.com tool exactly once", () => {
  assert.deepEqual(registry.tools.filter(t => t.domain === "resy.com").map(t => t.tool).sort(), [...NAMES].sort());
});

// --- input validation happens before any request ----------------------------------------------------------

const ok = { venue_id: 1001, date: "2026-10-09" };
const invalid = {
  search_restaurants: [undefined, null, [], {}, { extra: 1, query: "x" }, { query: "" }, { query: 5 }, { query: "x".repeat(101) }, { location: "not a slug!" }, { location: "a" }, { location: 5 },
    { latitude: 40 }, { longitude: -74 }, { latitude: 91, longitude: 0 }, { latitude: 0, longitude: 181 }, { latitude: "40", longitude: -74 }, { latitude: 40, longitude: -74, location: "ny" },
    { query: "x", radius_meters: 99 }, { query: "x", radius_meters: 100001 }, { query: "x", radius_meters: 5000.5 },
    { location: "ny", date: "2026-02-30" }, { location: "ny", date: "10/09/2026" }, { location: "ny", date: "2026-09-27" }, { location: "ny", date: "2027-12-31" }, { location: "ny", party_size: 2 }, { location: "ny", time: "19:00" },
    { location: "ny", date: "2026-10-09", party_size: 0 }, { location: "ny", date: "2026-10-09", party_size: 21 }, { location: "ny", date: "2026-10-09", party_size: "2" }, { location: "ny", date: "2026-10-09", time: "7pm" }, { location: "ny", date: "2026-10-09", time: "24:00" },
    { location: "ny", cuisine: "" }, { location: "ny", page: 0 }, { location: "ny", page: 101 }, { location: "ny", per_page: 0 }, { location: "ny", per_page: 21 }, { location: "ny", per_page: 2.5 }],
  get_restaurant: [undefined, null, [], {}, { url: "" }, { url: 5 }, { url: "https://resy.com/" }, { url: "https://resy.com/cities/ny" }, { url: "http://resy.com/cities/ny/venues/x" }, { url: "https://resy.com.evil.example/cities/ny/venues/x" },
    { url: "https://evil.example/cities/ny/venues/x" }, { url: "https://blog.resy.com/cities/ny/venues/x" }, { url: "https://resy.com/cities/NY/venues/x" }, { url: "https://resy.com/cities/ny/venues/x", city_slug: "ny" },
    { city_slug: "ny" }, { url_slug: "x" }, { city_slug: "N Y", url_slug: "x" }, { city_slug: "ny", url_slug: "../x" }, { city_slug: "ny", url_slug: 5 }, { city_slug: "ny", url_slug: "x", extra: 1 }],
  get_availability: [undefined, null, {}, { date: "2026-10-09" }, { venue_id: 1001 }, { ...ok, venue_id: 0 }, { ...ok, venue_id: "1001" }, { ...ok, venue_id: 1.5 }, { ...ok, venue_id: 2147483648 }, { ...ok, date: "2026-13-01" }, { ...ok, date: "2026-09-27" },
    { ...ok, date: "2027-10-01" }, { ...ok, party_size: 0 }, { ...ok, party_size: 21 }, { ...ok, party_size: "2" }, { ...ok, extra: 1 }],
  get_availability_calendar: [undefined, null, {}, { venue_id: 1001 }, { start_date: "2026-10-09" }, { venue_id: 0, start_date: "2026-10-09" }, { venue_id: 1001, start_date: "2026-09-27" }, { venue_id: 1001, start_date: "2026-10-09", end_date: "2026-10-08" },
    { venue_id: 1001, start_date: "2026-10-09", end_date: "2027-11-01" }, { venue_id: 1001, start_date: "2026-10-09", end_date: "soon" }, { venue_id: 1001, start_date: "2026-10-09", party_size: 0 }, { venue_id: 1001, start_date: "2026-10-09", party_size: 21 },
    { venue_id: 1001, start_date: "2026-10-09", extra: 1 }]
};
for (const [name, inputs] of Object.entries(invalid)) {
  for (const input of inputs) {
    test(`${name}: rejects ${JSON.stringify(input)} before any request`, async () => {
      const h = harness(name);
      const result = await h.run(input);
      assert.equal(result.status, "error");
      assert.equal(result.error_kind, "invalid_input");
      assert.deepEqual(h.calls.requests, []);
    });
  }
}

test("search_restaurants: radius_meters needs a place", async () => {
  const h = harness("search_restaurants");
  const result = await h.run({ query: "x", radius_meters: 5000 });
  assert.equal(result.error_kind, "invalid_input");
  assert.deepEqual(h.calls.requests, []);
});

// --- page and configuration preconditions -----------------------------------------------------------------

for (const name of NAMES) {
  const good = { search_restaurants: { query: "trattoria" }, get_restaurant: { city_slug: "exampleton-xa", url_slug: "x" }, get_availability: ok, get_availability_calendar: { venue_id: 1001, start_date: "2026-10-09" } }[name];
  test(`${name}: wrong_page on another origin makes no request`, async () => {
    const h = harness(name, { origin: "https://blog.resy.com" });
    const result = await h.run(good);
    assert.equal(result.error_kind, "wrong_page");
    assert.deepEqual(h.calls.requests, []);
  });
  test(`${name}: reports site_changed when the page has no API configuration`, async () => {
    const h = harness(name, { apiConfig: undefined });
    const result = await h.run(good);
    assert.equal(result.error_kind, "site_changed");
    assert.deepEqual(h.calls.requests, []);
  });
  test(`${name}: refuses a malformed API key rather than putting it in a header`, async () => {
    const h = harness(name, { apiConfig: { Config: { apiKey: 'bad"key with spaces' } } });
    const result = await plain(await h.definition.execute(good));
    assert.equal(result.error_kind, "site_changed");
    assert.deepEqual(h.calls.requests, []);
  });
  for (const [label, response, kind] of [["403", { status: 403, raw: "<html>Access denied</html>" }, "challenge"], ["429", { status: 429, body: {} }, "rate_limited"], ["419", { status: 419, body: { status: 419 } }, "login_required"], ["401", { status: 401, body: {} }, "login_required"],
    ["502", { status: 502, raw: "<html>502 Bad Gateway</html>" }, "site_error"], ["html challenge", { status: 200, raw: "<html><script src=/_Incapsula_Resource></script></html>" }, "challenge"], ["non-JSON", { status: 200, raw: "ok" }, "site_error"]]) {
    test(`${name}: maps ${label} from the API to ${kind}`, async () => {
      const h = harness(name, { route: (method, path) => (path === "/3/location/config" ? null : response) });
      const input = name === "search_restaurants" ? { latitude: 40, longitude: -74 } : good;
      const result = await h.run(input);
      assert.equal(result.status, "error");
      assert.equal(result.error_kind, kind);
    });
  }
  test(`${name}: a network failure is site_error and a hung request is aborted after 25 seconds`, async () => {
    const failing = harness(name, { networkError: true });
    assert.equal((await failing.run(name === "search_restaurants" ? { latitude: 40, longitude: -74 } : good)).error_kind, "site_error");
    const hung = harness(name, { hang: true });
    const result = await hung.run(name === "search_restaurants" ? { latitude: 40, longitude: -74 } : good);
    assert.equal(result.error_kind, "site_error");
    assert.match(result.error_message, /25 seconds/);
  });
}

// --- search_restaurants -----------------------------------------------------------------------------------

test("search_restaurants: location search with date, party size and time sends the site's own request and maps venues", async () => {
  const h = harness("search_restaurants");
  const result = await h.run({ query: "trattoria", location: "Exampleton-XA", cuisine: "Italian", date: "2026-10-09", party_size: 4, time: "19:00", radius_meters: 5000, page: 2, per_page: 2 });
  assert.deepEqual(h.calls.requests.map(r => `${r.method} ${r.path}`), ["GET /3/location/config", "POST /3/venuesearch/search"]);
  assert.deepEqual(h.calls.requests[1].body, {
    types: ["venue"], include_tock_inventory: true, page: 2, per_page: 2, query: "trattoria", geo: { latitude: 40, longitude: -74, radius: 5000 },
    venue_filter: { cuisine: "Italian" }, availability: true, order_by: "availability", slot_filter: { day: "2026-10-09", party_size: 4, time_filter: "19:00" }
  });
  assert.equal(result.status, "ok");
  assert.deepEqual(result.resolved_location, { slug: "exampleton-xa", name: "Exampleton", latitude: 40, longitude: -74 });
  assert.equal(result.observed_at, "2026-09-29T12:00:00.000Z");
  assert.equal(result.total, 2);
  assert.equal(result.has_more, false);
  const [first, second] = result.venues;
  assert.equal(first.venue_id, 2001);
  assert.equal(first.url, "https://resy.com/cities/exampleton-xa/venues/fabricated-osteria");
  assert.deepEqual(first.cuisine, ["Italian"]);
  assert.equal(first.price_range, 3);
  assert.deepEqual(first.rating, { average: 4.6, count: 120 });
  assert.equal(first.notify_offered, true);
  assert.equal(first.is_tock_inventory, false);
  assert.ok(first.distance_miles > 0.8 && first.distance_miles < 0.95, "distance from the map center in miles: " + first.distance_miles);
  assert.deepEqual(first.availability, { date: "2026-10-09", party_size: 4, slot_count: 2, slots: [{ local_time: "18:30", end_local_time: "20:00", seating_type: "Dining Room" }, { local_time: "19:00", end_local_time: "20:30", seating_type: "Bar" }], slots_truncated: false });
  assert.equal(second.is_tock_inventory, true);
});

test("search_restaurants: coordinates skip the location list; a query alone sends no geo and no availability", async () => {
  const withCoords = harness("search_restaurants");
  const a = await withCoords.run({ latitude: 34.05, longitude: -118.24 });
  assert.deepEqual(withCoords.calls.requests.map(r => r.path), ["/3/venuesearch/search"]);
  assert.deepEqual(withCoords.calls.requests[0].body, { types: ["venue"], include_tock_inventory: true, page: 1, per_page: 10, geo: { latitude: 34.05, longitude: -118.24, radius: 16100 } });
  assert.equal(a.resolved_location, null);
  assert.equal(a.venues[0].availability, null);
  assert.equal(a.venues[0].notify_offered, null);
  assert.ok(a.venues[0].distance_miles > 2000, "computed from the given coordinates");
  const queryOnly = harness("search_restaurants");
  const b = await queryOnly.run({ query: "osteria" });
  assert.deepEqual(queryOnly.calls.requests[0].body, { types: ["venue"], include_tock_inventory: true, page: 1, per_page: 10, query: "osteria" });
  assert.equal(b.venues[0].distance_miles, null);
  assert.equal(b.query.radius_meters, null);
});

test("search_restaurants: a location code resolves and the default radius and party size apply", async () => {
  const h = harness("search_restaurants");
  const result = await h.run({ location: "xb", date: "2026-10-09" });
  assert.equal(result.resolved_location.slug, "sampleville-xb");
  assert.deepEqual(h.calls.requests[1].body.geo, { latitude: 34, longitude: -118, radius: 16100 });
  assert.deepEqual(h.calls.requests[1].body.slot_filter, { day: "2026-10-09", party_size: 2 });
});

for (const location of ["atlantis", "hidden-test", "hid", "no-center"]) {
  test(`search_restaurants: location ${location} is not_found and no search runs`, async () => {
    const h = harness("search_restaurants");
    const result = await h.run({ location });
    assert.equal(result.error_kind, "not_found");
    assert.deepEqual(h.calls.requests.map(r => r.path), ["/3/location/config"]);
  });
}

test("search_restaurants: a location list without the expected shape is site_changed", async () => {
  const h = harness("search_restaurants", { route: (m, path) => (path === "/3/location/config" ? { status: 200, body: { locations: [] } } : null) });
  assert.equal((await h.run({ location: "xa" })).error_kind, "site_changed");
});

test("search_restaurants: slots are capped at 12 per venue with the full count", async () => {
  const many = Array.from({ length: 15 }, (_, i) => slot(`${String(10 + Math.floor(i / 4)).padStart(2, "0")}:${String((i % 4) * 15).padStart(2, "0")}`, null));
  const h = harness("search_restaurants", { route: (m, path) => (path === "/3/venuesearch/search" ? { status: 200, body: searchBody([hit(2001, "Fabricated Osteria", { availability: { ...hit(1, "x").availability, slots: many } })]) } : null) });
  const result = await h.run({ latitude: 40, longitude: -74, date: "2026-10-09" });
  assert.equal(result.venues[0].availability.slot_count, 15);
  assert.equal(result.venues[0].availability.slots.length, 12);
  assert.equal(result.venues[0].availability.slots_truncated, true);
  assert.equal(result.venues[0].availability.slots[0].end_local_time, null);
});

test("search_restaurants: slot_count 0 is reported as a venue with no open slots, not dropped", async () => {
  const h = harness("search_restaurants", { route: (m, path) => (path === "/3/venuesearch/search" ? { status: 200, body: searchBody([hit(2001, "Fabricated Osteria", { availability: { ...hit(1, "x").availability, slots: [], notify_options: [] } })]) } : null) });
  const result = await h.run({ latitude: 40, longitude: -74, date: "2026-10-09" });
  assert.equal(result.venues[0].availability.slot_count, 0);
  assert.equal(result.venues[0].notify_offered, false);
});

test("search_restaurants: empty pages are no_results, with a different message past the first page", async () => {
  const empty = { route: (m, path) => (path === "/3/venuesearch/search" ? { status: 200, body: searchBody([], 0) } : null) };
  const first = await harness("search_restaurants", empty).run({ latitude: 40, longitude: -74, cuisine: "Zzz" });
  assert.equal(first.status, "no_results");
  assert.match(first.message, /case-sensitive|spelling/i);
  const later = await harness("search_restaurants", empty).run({ latitude: 40, longitude: -74, page: 9 });
  assert.equal(later.status, "no_results");
  assert.match(later.message, /fewer pages/);
});

test("search_restaurants: has_more follows the site total", async () => {
  const h = harness("search_restaurants", { route: (m, path) => (path === "/3/venuesearch/search" ? { status: 200, body: searchBody([hit(2001, "Fabricated Osteria"), hit(2002, "Fabricated Bistro")], 50) } : null) });
  const result = await h.run({ latitude: 40, longitude: -74, per_page: 2 });
  assert.equal(result.total, 50);
  assert.equal(result.has_more, true);
});

test("search_restaurants: results without an id or name are skipped with a warning; none usable is site_changed", async () => {
  const mixed = harness("search_restaurants", { route: (m, path) => (path === "/3/venuesearch/search" ? { status: 200, body: searchBody([{ name: "No id" }, hit(2001, "Fabricated Osteria"), null]) } : null) });
  const result = await mixed.run({ latitude: 40, longitude: -74 });
  assert.equal(result.venues.length, 1);
  assert.equal(result.warnings.length, 2);
  const none = harness("search_restaurants", { route: (m, path) => (path === "/3/venuesearch/search" ? { status: 200, body: searchBody([{ name: "No id" }]) } : null) });
  assert.equal((await none.run({ latitude: 40, longitude: -74 })).error_kind, "site_changed");
});

test("search_restaurants: coerces odd field types instead of failing the output schema", async () => {
  const odd = hit(2001, "Fabricated Osteria", { rating: { average: "4.5", count: "12" }, price_range_id: 9, cuisine: "Italian", _geoloc: { lat: "x" }, url_slug: "bad slug/../", max_party_size: null, neighborhood: 5 });
  const h = harness("search_restaurants", { route: (m, path) => (path === "/3/venuesearch/search" ? { status: 200, body: searchBody([odd]) } : null) });
  const v = (await h.run({ latitude: 40, longitude: -74 })).venues[0];
  assert.deepEqual(v.rating, { average: null, count: null });
  assert.equal(v.price_range, null);
  assert.deepEqual(v.cuisine, []);
  assert.equal(v.latitude, null);
  assert.equal(v.url, null);
  assert.equal(v.url_slug, null);
  assert.equal(v.neighborhood, null);
});

test("search_restaurants: a 400 from the site is invalid_input and an unexpected body is site_changed", async () => {
  const rejected = harness("search_restaurants", { route: (m, path) => (path === "/3/venuesearch/search" ? { status: 400, body: { status: 400, message: "Invalid data received." } } : null) });
  assert.equal((await rejected.run({ latitude: 40, longitude: -74 })).error_kind, "invalid_input");
  const changed = harness("search_restaurants", { route: (m, path) => (path === "/3/venuesearch/search" ? { status: 200, body: { results: [] } } : null) });
  assert.equal((await changed.run({ latitude: 40, longitude: -74 })).error_kind, "site_changed");
});

// --- get_restaurant ---------------------------------------------------------------------------------------

test("get_restaurant: maps the venue record and never returns account fields", async () => {
  const h = harness("get_restaurant");
  const result = await h.run({ url: "https://www.resy.com/cities/exampleton-xa/venues/fabricated-trattoria/events/x?date=2026-10-09&seats=2" });
  assert.deepEqual(h.calls.requests.map(r => `${r.method} ${r.path}`), ["GET /3/venue?url_slug=fabricated-trattoria&location=exampleton-xa"]);
  assert.equal(result.status, "ok");
  assert.equal(result.venue_id, 1001);
  assert.equal(result.url, "https://resy.com/cities/exampleton-xa/venues/fabricated-trattoria");
  assert.equal(result.cuisine, "Italian");
  assert.equal(result.price_range, 4);
  assert.deepEqual(result.rating, { source: "Resy", average: 4.75, scale: 5, count: 900 });
  assert.equal(result.address.address_1, "1 Example Street");
  assert.equal(result.address.cross_street, "Sample Avenue");
  assert.equal(result.time_zone, "EST5EDT");
  assert.equal(result.phone, "+15555550100");
  assert.equal(result.website, "https://trattoria.example.invalid/");
  assert.equal(result.menu_url, "https://trattoria.example.invalid/menu");
  assert.deepEqual(result.description, { about: "About the fabricated trattoria.", why_we_like_it: "Because it is fabricated.", need_to_know: "Bring nothing.", tagline: null });
  assert.deepEqual(result.party_size, { min: 1, max: 10 });
  assert.equal(result.is_global_dining_access, true);
  assert.equal(result.is_resy_credit_eligible, false);
  assert.equal(JSON.stringify(result).includes("private"), false, "favorites and list membership are not returned");
  assert.equal("favorite" in result, false);
});

test("get_restaurant: city_slug and url_slug are encoded into the request", async () => {
  const h = harness("get_restaurant");
  await h.run({ city_slug: "exampleton-xa", url_slug: "fabricated-trattoria" });
  assert.equal(h.calls.requests[0].path, "/3/venue?url_slug=fabricated-trattoria&location=exampleton-xa");
});

test("get_restaurant: 404 and 400 are not_found with the Tock caveat", async () => {
  for (const status of [404, 400]) {
    const h = harness("get_restaurant", { route: () => ({ status, body: { status, code: 1041, message: "Venue is inactive or not found." } }) });
    const result = await h.run({ city_slug: "exampleton-xa", url_slug: "gone" });
    assert.equal(result.error_kind, "not_found");
    assert.match(result.error_message, /Tock/);
  }
});

test("get_restaurant: hostile or odd fields are neutralized", async () => {
  const hostile = { ...VENUE, contact: { phone_number: 5, url: "javascript:alert(1)", menu_url: "ftp://x.example/menu" }, price_range_id: 7, rater: [], url_slug: "bad slug", location: { ...VENUE.location, url_slug: "../x", latitude: "1" },
    content: [{ name: "about", body: "x".repeat(6000) }, { name: "need_to_know" }, null] };
  const h = harness("get_restaurant", { route: () => ({ status: 200, body: hostile }) });
  const result = await h.run({ city_slug: "exampleton-xa", url_slug: "fabricated-trattoria" });
  assert.equal(result.website, null);
  assert.equal(result.menu_url, null);
  assert.equal(result.phone, null);
  assert.equal(result.price_range, null);
  assert.equal(result.rating, null);
  assert.equal(result.description.about.length, 4000);
  assert.equal(result.description.need_to_know, null);
  assert.equal(result.address.latitude, null);
  assert.equal(result.url, "https://resy.com/cities/exampleton-xa/venues/fabricated-trattoria", "unsafe slugs fall back to the requested ones");
});

test("get_restaurant: a body without an id is site_changed", async () => {
  const h = harness("get_restaurant", { route: () => ({ status: 200, body: { name: "No id" } }) });
  assert.equal((await h.run({ city_slug: "exampleton-xa", url_slug: "x" })).error_kind, "site_changed");
});

// --- get_availability -------------------------------------------------------------------------------------

test("get_availability: posts the site's find request and maps slots with their policy", async () => {
  const h = harness("get_availability");
  const result = await h.run({ venue_id: 1001, date: "2026-10-09", party_size: 3 });
  assert.deepEqual(h.calls.requests.map(r => `${r.method} ${r.path}`), ["POST /4/find"]);
  assert.deepEqual(h.calls.requests[0].body, { lat: 0, long: 0, day: "2026-10-09", party_size: 3, venue_id: 1001 });
  assert.equal(result.status, "ok");
  assert.equal(result.name, "Fabricated Trattoria");
  assert.equal(result.url, "https://resy.com/cities/exampleton-xa/venues/fabricated-trattoria");
  assert.equal(result.time_zone, "EST5EDT");
  assert.equal(result.currency, "USD");
  assert.equal(result.notify_offered, true);
  assert.equal(result.slot_count, 3);
  assert.deepEqual(result.slots.map(s => [s.local_time, s.end_local_time, s.seating_type, s.global_dining_access]), [["18:30", "20:00", "Dining Room", false], ["19:00", "20:30", "Bar", false], ["21:00", null, "Chef Counter", true]]);
  assert.deepEqual(result.slots[0].policy, { requires_payment: false, cancellation_fee: null, cancel_cutoff_secs: null, cancel_cutoff_time: null, deposit_fee: null, service_charge: null });
  assert.deepEqual(result.slots[1].policy, { requires_payment: true, cancellation_fee: 25, cancel_cutoff_secs: 86400, cancel_cutoff_time: null, deposit_fee: null, service_charge: null });
  assert.deepEqual(result.slots[2].policy, { requires_payment: true, cancellation_fee: null, cancel_cutoff_secs: 0, cancel_cutoff_time: "12:00:00", deposit_fee: 50, service_charge: "0%" });
});

test("get_availability: a slot whose template is missing has a null policy", async () => {
  const h = harness("get_availability", { route: (m, path) => (path === "/4/find" ? { status: 200, body: findBody([slot("18:30", "20:00", "Dining Room", 999)]) } : null) });
  const result = await h.run(ok);
  assert.equal(result.slots[0].policy, null);
});

test("get_availability: no slots is no_availability and says it does not explain why", async () => {
  const h = harness("get_availability", { route: (m, path) => (path === "/4/find" ? { status: 200, body: findBody([]) } : null) });
  const result = await h.run(ok);
  assert.equal(result.status, "no_availability");
  assert.equal(result.notify_offered, true);
  assert.match(result.message, /does not say why/);
});

test("get_availability: gating errors are reported as gated, not as an empty success", async () => {
  const h = harness("get_availability", { route: (m, path) => (path === "/4/find" ? { status: 200, body: findBody(undefined, { gating_errors: { card_required: "hidden detail" } }) } : null) });
  const result = await h.run(ok);
  assert.equal(result.status, "gated");
  assert.deepEqual(result.gating_keys, ["card_required"]);
  assert.equal(JSON.stringify(result).includes("hidden detail"), false);
  assert.equal("slots" in result, false);
});

test("get_availability: an id the site rejects (Tock-backed or unknown) is not_found; other 400s are invalid_input", async () => {
  const tock = harness("get_availability", { route: (m, path) => (path === "/4/find" ? { status: 400, body: { status: 400, message: "Invalid data received.", data: { venue_id: "invalid: 1001" } } } : null) });
  const notFound = await tock.run(ok);
  assert.equal(notFound.error_kind, "not_found");
  assert.match(notFound.error_message, /Tock/);
  const other = harness("get_availability", { route: (m, path) => (path === "/4/find" ? { status: 400, body: { status: 400, data: { day: "bad" } } } : null) });
  assert.equal((await other.run(ok)).error_kind, "invalid_input");
  const gone = harness("get_availability", { route: (m, path) => (path === "/4/find" ? { status: 200, body: { results: { venues: [] } } } : null) });
  assert.equal((await gone.run(ok)).error_kind, "not_found");
  const missing = harness("get_availability", { route: (m, path) => (path === "/4/find" ? { status: 404, body: {} } : null) });
  assert.equal((await missing.run(ok)).error_kind, "not_found");
});

test("get_availability: unexpected bodies are site_changed and unreadable slots are skipped", async () => {
  const changed = harness("get_availability", { route: (m, path) => (path === "/4/find" ? { status: 200, body: { results: { venues: [{ slots: [] }] } } } : null) });
  assert.equal((await changed.run(ok)).error_kind, "site_changed");
  const partial = harness("get_availability", { route: (m, path) => (path === "/4/find" ? { status: 200, body: findBody([{ date: {} }, slot("18:30", "20:00")]) } : null) });
  const result = await partial.run(ok);
  assert.equal(result.slot_count, 1);
  assert.equal(result.warnings.length, 1);
  const allBad = harness("get_availability", { route: (m, path) => (path === "/4/find" ? { status: 200, body: findBody([{ date: {} }]) } : null) });
  const none = await allBad.run(ok);
  assert.equal(none.status, "no_availability");
  assert.match(none.message, /none had a readable time/);
});

test("get_availability: at most 100 slots are returned and the flag says so", async () => {
  const many = Array.from({ length: 130 }, (_, i) => slot(`${String(8 + Math.floor(i / 12)).padStart(2, "0")}:${String((i % 12) * 5).padStart(2, "0")}`, null));
  const h = harness("get_availability", { route: (m, path) => (path === "/4/find" ? { status: 200, body: findBody(many) } : null) });
  const result = await h.run(ok);
  assert.equal(result.slot_count, 130);
  assert.equal(result.slots.length, 100);
  assert.equal(result.slots_truncated, true);
});

test("get_availability: yesterday (UTC) and dates up to a year ahead are accepted", async () => {
  for (const date of ["2026-09-28", "2026-09-29", "2027-09-29"]) {
    const h = harness("get_availability");
    assert.equal((await h.run({ venue_id: 1001, date })).status, "ok", date);
  }
});

// --- get_availability_calendar ----------------------------------------------------------------------------

test("get_availability_calendar: default end date is 30 days after the start and days are mapped", async () => {
  const h = harness("get_availability_calendar");
  const result = await h.run({ venue_id: 1001, start_date: "2026-10-09", party_size: 4 });
  assert.equal(h.calls.requests[0].method, "GET");
  assert.equal(h.calls.requests[0].path, "/4/venue/calendar?venue_id=1001&num_seats=4&start_date=2026-10-09&end_date=2026-11-08");
  assert.equal(result.status, "ok");
  assert.equal(result.end_date, "2026-11-08");
  assert.equal(result.last_bookable_date, "2026-10-31");
  assert.equal(result.days_returned, 2);
  assert.deepEqual(result.days, [{ date: "2026-10-09", reservation: "available", event: "not available", walk_in: "available" }, { date: "2026-10-10", reservation: "sold-out", event: "not available", walk_in: "available" }]);
});

test("get_availability_calendar: an explicit range up to 366 days is passed through", async () => {
  const h = harness("get_availability_calendar");
  await h.run({ venue_id: 1001, start_date: "2026-10-01", end_date: "2027-10-02" });
  assert.match(h.calls.requests[0].path, /start_date=2026-10-01&end_date=2027-10-02$/);
});

test("get_availability_calendar: nothing inside the booking window is no_results and names the last day", async () => {
  const h = harness("get_availability_calendar", { route: (m, path) => (path.startsWith("/4/venue/calendar?") ? { status: 200, body: { scheduled: [], last_calendar_day: "2026-10-31" } } : null) });
  const past = await h.run({ venue_id: 1001, start_date: "2027-06-01" });
  assert.equal(past.status, "no_results");
  assert.match(past.message, /2026-10-31/);
  const other = harness("get_availability_calendar", { route: (m, path) => (path.startsWith("/4/venue/calendar?") ? { status: 200, body: { scheduled: [] } } : null) });
  const result = await other.run({ venue_id: 1001, start_date: "2026-10-09" });
  assert.equal(result.status, "no_results");
  assert.equal(result.last_bookable_date, null);
});

test("get_availability_calendar: 404 is not_found, malformed bodies are site_changed, bad entries are skipped and states may be null", async () => {
  const missing = harness("get_availability_calendar", { route: (m, path) => (path.startsWith("/4/venue/calendar?") ? { status: 404, body: {} } : null) });
  const notFound = await missing.run({ venue_id: 1001, start_date: "2026-10-09" });
  assert.equal(notFound.error_kind, "not_found");
  assert.match(notFound.error_message, /Tock/);
  const changed = harness("get_availability_calendar", { route: (m, path) => (path.startsWith("/4/venue/calendar?") ? { status: 200, body: { days: [] } } : null) });
  assert.equal((await changed.run({ venue_id: 1001, start_date: "2026-10-09" })).error_kind, "site_changed");
  const rejected = harness("get_availability_calendar", { route: (m, path) => (path.startsWith("/4/venue/calendar?") ? { status: 400, body: { message: { end_date: "bad" } } } : null) });
  assert.equal((await rejected.run({ venue_id: 1001, start_date: "2026-10-09" })).error_kind, "invalid_input");
  const odd = harness("get_availability_calendar", { route: (m, path) => (path.startsWith("/4/venue/calendar?") ? { status: 200, body: { scheduled: [{ date: "nope" }, null, { date: "2026-10-09" }, { date: "2026-10-10", inventory: { reservation: 5 } }], last_calendar_day: "bad" } } : null) });
  const result = await odd.run({ venue_id: 1001, start_date: "2026-10-09" });
  assert.equal(result.days_returned, 2);
  assert.equal(result.warnings.length, 2);
  assert.equal(result.last_bookable_date, null);
  assert.deepEqual(result.days[0], { date: "2026-10-09", reservation: null, event: null, walk_in: null });
});

test("get_availability_calendar: output is capped at 400 days with a warning", async () => {
  const days = Array.from({ length: 450 }, (_, i) => [new Date(Date.parse("2026-10-09T00:00:00Z") + i * 86400000).toISOString().slice(0, 10), "available"]);
  const h = harness("get_availability_calendar", { route: (m, path) => (path.startsWith("/4/venue/calendar?") ? { status: 200, body: calendarBody(days) } : null) });
  const result = await h.run({ venue_id: 1001, start_date: "2026-10-09", end_date: "2027-10-09" });
  assert.equal(result.days.length, 400);
  assert.equal(result.days_returned, 400);
  assert.ok(result.warnings.some(w => /400/.test(w)));
});
