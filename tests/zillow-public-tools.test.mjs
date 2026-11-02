import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";

const names = ["search", "get_listing"];
const sources = Object.fromEntries(names.map(name => [name, readFileSync(new URL(`../domains/zillow.com/${name}.js`, import.meta.url), "utf8")]));
const home = "https://www.zillow.com/";
const listing = home + "homedetails/1-Example-St-Example-City-WA-99999/12345678_zpid/";
const plain = value => JSON.parse(JSON.stringify(value));
const privateValue = "FABRICATED_PRIVATE_VIEWER";

function conforms(schema, value) {
  if ("const" in schema && value !== schema.const) return false;
  if (schema.enum && !schema.enum.includes(value)) return false;
  if (schema.oneOf && schema.oneOf.filter(s => conforms(s, value)).length !== 1) return false;
  if (schema.type && ![schema.type].flat().some(type => {
    if (type === "null") return value === null;
    if (type === "array") return Array.isArray(value);
    if (type === "object") return value !== null && typeof value === "object" && !Array.isArray(value);
    if (type === "integer") return Number.isInteger(value);
    return typeof value === type;
  })) return false;
  if (typeof value === "number" && (!Number.isFinite(value) || value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity))) return false;
  if (typeof value === "string" && (value.length < (schema.minLength ?? 0) || value.length > (schema.maxLength ?? Infinity) || (schema.pattern && !new RegExp(schema.pattern).test(value)))) return false;
  if (Array.isArray(value) && (value.length < (schema.minItems ?? 0) || value.length > (schema.maxItems ?? Infinity) || (schema.items && value.some(item => !conforms(schema.items, item))))) return false;
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    if (schema.required?.some(key => !Object.hasOwn(value, key))) return false;
    if (schema.properties && Object.entries(schema.properties).some(([key, s]) => key in value && !conforms(s, value[key]))) return false;
    if (schema.additionalProperties === false && Object.keys(value).some(key => !Object.hasOwn(schema.properties || {}, key))) return false;
  }
  return true;
}

// All fixtures are fabricated; no saved Zillow HTML or account identifiers.
function row(id = "12345678", extra = {}) {
  return {
    zpid: id, detailUrl: listing.replace("12345678", id), addressStreet: "1 Example St", addressCity: "Example City", addressState: "WA", addressZipcode: "99999",
    unformattedPrice: 500000, price: "$500,000", beds: 3, baths: 1.5, area: 1234, zestimate: 490000,
    isFeaturedListing: false, isShowcaseListing: true, info2String: "Example MLS",
    hdpData: { homeInfo: { zpid: Number(id), currency: "USD", homeStatus: "FOR_SALE", homeType: "SINGLE_FAMILY", daysOnZillow: -1, rentZestimate: 2500 } },
    user: privateValue, saved: privateValue, ...extra
  };
}
function searchState(query = {}, rows = [row()], extra = {}) {
  return {
    queryState: { mapBounds: { west: -123, east: -122, south: 47, north: 48 }, regionSelection: [{ regionId: 999, regionType: 6 }], filterState: { sortSelection: { value: "globalrelevanceex" } }, ...query },
    regionState: { regionInfo: [{ regionId: 999, regionType: 6, regionName: "Example City", displayName: "Example City WA" }] },
    searchPageSeoObject: { baseUrl: "/example-city-wa/" },
    cat1: { searchResults: { listResults: rows }, searchList: { totalPages: 3, resultsPerPage: 41, listResultsTitle: "Example City WA Real Estate & Homes For Sale" } },
    categoryTotals: { cat1: { totalResultCount: 90 } },
    user: { email: privateValue, savedHomeIds: [privateValue], recentlyViewedHomes: [privateValue], buyAbilityData: privateValue }, ...extra
  };
}
function property(extra = {}) {
  return {
    zpid: 12345678, hdpUrl: new URL(listing).pathname, price: 500000, currency: "USD", homeStatus: "FOR_SALE", homeType: "SINGLE_FAMILY",
    address: { streetAddress: "1 Example St", city: "Example City", state: "WA", zipcode: "99999" },
    bedrooms: 3, bathrooms: 1.5, livingArea: 1234, livingAreaUnits: "Square Feet", lotAreaValue: 0.15, lotAreaUnits: "Acres", yearBuilt: 1920, zestimate: 490000, rentZestimate: 2500,
    attributionInfo: { mlsName: "Example MLS", mlsId: "EXAMPLE-ID", lastUpdated: "2026-01-02 10:30:00", listingAgentAttributionContact: privateValue },
    viewer: { email: privateValue }, buyAbilityData: privateValue, isListingClaimedByCurrentSignedInUser: true, description: privateValue, photos: [privateValue], ...extra
  };
}
const embedded = props => ({ props: { pageProps: props } });
const listingData = p => embedded({ componentProps: { gdpClientCache: JSON.stringify({ Query: { property: p, viewer: { email: privateValue } } }) } });
const html = (data, title = "Zillow", prefix = "") => `${prefix}<html><title>${title}</title><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(data)}</script></html>`;

function harness(name, options = {}) {
  const calls = [];
  const timers = new Set();
  const location = new URL(options.url || home);
  const document = { title: options.title || "Zillow", getElementById: id => id === "px-captcha" && options.challenge ? {} : null };
  const context = {
    URL, AbortController, TextDecoder, Set,
    DOMParser: class {
      parseFromString(body) {
        return {
          title: body.match(/<title>([^<]*)<\/title>/)?.[1] || "",
          getElementById: id => {
            if (id === "px-captcha" && body.includes('id="px-captcha"')) return {};
            const data = body.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/)?.[1];
            return id === "__NEXT_DATA__" && data !== undefined ? { textContent: data } : null;
          }
        };
      }
    },
    location, document,
    setTimeout: fn => { timers.add(fn); return fn; }, clearTimeout: fn => timers.delete(fn),
    fetch: async (path, init) => {
      calls.push({ path, init });
      assert.equal(init.method, "GET");
      assert.equal(init.credentials, "omit");
      assert.equal(init.redirect, "manual");
      assert.equal(init.body, undefined);
      if (options.timeout) { for (const fn of timers) fn(); throw new Error(privateValue); }
      if (options.networkError) throw new Error(privateValue);
      let result;
      if (options.respond) result = options.respond(path, calls.length, init);
      if (!result) {
        if (name === "get_listing") result = { data: listingData(property()) };
        else {
          const query = new URL(path, home).searchParams.get("searchQueryState");
          result = { data: embedded({ searchPageState: searchState(query ? JSON.parse(query) : {}) }) };
        }
      }
      const body = result.body ?? html(result.data, result.title, result.prefix);
      const response = new Response(body, { status: result.status ?? 200 });
      if (result.redirect) Object.defineProperty(response, "type", { value: "opaqueredirect" });
      return response;
    }
  };
  const [definition] = runInNewContext(`(${sources[name]})`, context);
  return {
    definition, calls, location,
    run: async (input, invocation = {}) => {
      const output = plain(await definition.execute(input, invocation));
      assert.ok(conforms(definition.tool.outputSchema, output), JSON.stringify(output));
      assert.ok(!JSON.stringify(output).includes(privateValue), "private state or thrown errors leaked");
      assert.equal(timers.size, 0, "deadline timer was not cleaned up");
      assert.equal(location.href, options.url || home, "the registering document navigated");
      return output;
    }
  };
}
const valid = name => name === "search" ? { location: "Example City, WA" } : { listing_url: listing };

for (const name of names) {
  test(`zillow ${name}: page-kind contract and sorted registry entry`, () => {
    const h = harness(name);
    assert.equal(h.definition.kind, "page");
    assert.equal(h.definition.tool.name, name);
    assert.equal(h.definition.tool.annotations.readOnlyHint, true);
    assert.deepEqual(plain(h.definition.match.url_patterns), ["https://www.zillow.com/*"]);
    assert.doesNotMatch(sources[name], /\b(?:gotoUrl|click|httpGet|js|require|Buffer)\s*\(/);
    assert.ok(!sources[name].trim().endsWith(";"));
    const registry = JSON.parse(readFileSync(new URL("../registry.json", import.meta.url), "utf8"));
    const entries = registry.tools.filter(t => t.domain === "zillow.com");
    assert.deepEqual(entries.map(t => t.tool), ["get_listing", "prepare_contact", "search"]);
    assert.equal(entries.find(t => t.tool === name).kind, "page");
  });

  for (const input of [undefined, null, [], {}, { ...valid(name), extra: privateValue }]) {
    test(`zillow ${name}: malformed input ${JSON.stringify(input)} has no requests`, async () => {
      const h = harness(name);
      assert.equal((await h.run(input)).error_kind, "invalid_input");
      assert.equal(h.calls.length, 0);
    });
  }
  for (const url of ["https://zillow.com/", "https://www.zillow.com.evil.test/", "https://www.example.test/", "https://rentals.zillow.com/"]) {
    test(`zillow ${name}: wrong origin ${url} is refused`, async () => {
      const h = harness(name, { url });
      assert.equal((await h.run(valid(name))).error_kind, "wrong_page");
      assert.equal(h.calls.length, 0);
    });
  }
  for (const options of [{ title: "Access to this page has been denied" }, { challenge: true }]) {
    test(`zillow ${name}: starting challenge prevents any request`, async () => {
      const h = harness(name, options);
      assert.equal((await h.run(valid(name))).error_kind, "challenge");
      assert.equal(h.calls.length, 0);
    });
  }
  for (const [status, kind] of [[401, "login_required"], [403, "forbidden"], [429, "rate_limited"], [435, "challenge"], [404, "not_found"], [410, "not_found"], [500, "site_error"]]) {
    test(`zillow ${name}: HTTP ${status} is ${kind} without retries`, async () => {
      const h = harness(name, { respond: () => ({ status, body: "denied" }) });
      assert.equal((await h.run(valid(name))).error_kind, kind);
      assert.equal(h.calls.length, 1);
    });
  }
  for (const [result, kind] of [
    [{ title: "Access to this page has been denied" }, "challenge"],
    [{ prefix: '<div id="px-captcha"></div>' }, "challenge"],
    [{ body: "<title>Sign in to Zillow</title>" }, "login_required"],
    [{ title: "Forbidden" }, "forbidden"],
    [{ data: { page: "/404" } }, "not_found"],
    [{ body: "<title>Zillow</title>no embedded data" }, "site_changed"],
    [{ body: '<script id="__NEXT_DATA__">{malformed}</script>' }, "site_changed"],
    [{ redirect: true }, "forbidden"]
  ]) {
    test(`zillow ${name}: ${kind} page shape is not an empty success`, async () => {
      const h = harness(name, { respond: () => result });
      assert.equal((await h.run(valid(name))).error_kind, kind);
      assert.equal(h.calls.length, 1);
    });
  }
  test(`zillow ${name}: cancellation, timeout and network errors are bounded and sanitized`, async () => {
    const controller = new AbortController(); controller.abort();
    const h = harness(name);
    assert.equal((await h.run(valid(name), { signal: controller.signal })).error_kind, "canceled");
    assert.equal(h.calls.length, 0);
    assert.equal((await harness(name, { timeout: true }).run(valid(name))).error_kind, "timeout");
    assert.equal((await harness(name, { networkError: true }).run(valid(name))).error_kind, "site_error");
  });
  test(`zillow ${name}: 8 MiB response cap cancels without parsing`, async () => {
    const h = harness(name, { respond: () => ({ body: "x".repeat(8 * 1024 * 1024 + 1) }) });
    assert.equal((await h.run(valid(name))).error_kind, "response_too_large");
    assert.equal(h.calls.length, 1);
  });
}

for (const fields of [
  { location: "Seattle" }, { location: "99999" }, { location: "Example City, ZZ" }, { location: "Example City, WA", page: null }, { page: 0 }, { page: 21 }, { limit: 42 }, { limit: 0 },
  { price_min: -1 }, { price_min: 0.5 }, { price_max: Infinity }, { price_max: "500000" }, { price_min: 100, price_max: 99 }, { beds_min: 0 }, { beds_min: null }, { beds_min: 11 }, { sort: "newest" }, { sort: null }
]) {
  test(`zillow search: rejects unsupported fields ${JSON.stringify(fields)} before interaction`, async () => {
    const h = harness("search");
    assert.equal((await h.run({ ...valid("search"), ...fields })).error_kind, "invalid_input");
    assert.equal(h.calls.length, 0);
  });
}

test("zillow search: confirms exact location and filters with only two anonymous GETs", async () => {
  const h = harness("search", { url: home + "homeloans/mortgage-rates/" });
  const output = await h.run({ location: "Example City, wa", price_min: 100000, price_max: 600000, beds_min: 3, sort: "price_ascending", page: 2, limit: 1 });
  assert.equal(output.status, "ok");
  assert.equal(output.resolved_region.region_id, 999);
  assert.equal(output.page, 2);
  assert.equal(output.results[0].days_on_zillow, null);
  assert.equal(output.results[0].bathrooms, 1.5);
  assert.equal(output.results[0].rent_zestimate_monthly, 2500);
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[0].path, "/homes/Example%20City%2C%20WA_rb/");
  const url = new URL(h.calls[1].path, home);
  assert.equal(url.pathname, "/example-city-wa/2_p/");
  const q = JSON.parse(url.searchParams.get("searchQueryState"));
  assert.deepEqual(q.filterState, { sortSelection: { value: "pricea" }, price: { min: 100000, max: 600000 }, beds: { min: 3 } });
  assert.deepEqual(q.regionSelection, [{ regionId: 999, regionType: 6 }]);
});
for (const extra of [
  { regionState: { regionInfo: [{ regionId: 998, regionType: 6, displayName: "Different City WA" }] } },
  { regionState: { regionInfo: [{ regionId: 999, regionType: 7, displayName: "Example City WA" }] } },
  { regionState: { regionInfo: [] } }
]) {
  test("zillow search: rejects silent location fallback/ambiguous region", async () => {
    const h = harness("search", { respond: () => ({ data: embedded({ searchPageState: searchState({}, [row()], extra) }) }) });
    assert.equal((await h.run(valid("search"))).error_kind, "location_not_resolved");
    assert.equal(h.calls.length, 1);
  });
}
for (const extra of [{ searchPageSeoObject: { baseUrl: "//evil.test/" } }, { queryState: { regionSelection: [{ regionId: 999, regionType: 6 }], mapBounds: { west: 10, east: 1, south: 2, north: 3 } } }]) {
  test("zillow search: malicious canonical path or invalid bounds cannot be fetched", async () => {
    const h = harness("search", { respond: () => ({ data: embedded({ searchPageState: searchState({}, [row()], extra) }) }) });
    assert.equal((await h.run(valid("search"))).error_kind, "site_changed");
    assert.equal(h.calls.length, 1);
  });
}
for (const change of [q => ({ ...q, filterState: { sortSelection: { value: "ignored" } } }), q => ({ ...q, pagination: {} })]) {
  test("zillow search: ignored requested filters or page are explicit errors", async () => {
    const h = harness("search", { respond: (path, n) => n === 2 ? { data: embedded({ searchPageState: searchState(change(JSON.parse(new URL(path, home).searchParams.get("searchQueryState")))) }) } : null });
    assert.equal((await h.run({ ...valid("search"), page: 2 })).error_kind, "site_changed");
  });
}
test("zillow search: confirmed zero count is no_results, not a missing payload", async () => {
  const h = harness("search", { respond: (path, n) => n === 2 ? { data: embedded({ searchPageState: searchState(JSON.parse(new URL(path, home).searchParams.get("searchQueryState")), [], { categoryTotals: { cat1: { totalResultCount: 0 } }, cat1: { searchResults: { listResults: [] }, searchList: { totalPages: 0, resultsPerPage: 41, listResultsTitle: "Example City WA Homes For Sale" } } }) }) } : null });
  const output = await h.run(valid("search"));
  assert.equal(output.status, "no_results");
  assert.deepEqual(output.results, []);
  assert.equal(output.has_next_page, false);
});
test("zillow search: bounds rows, removes within-page duplicates and preserves nullable facts", async () => {
  const rows = [row(), row(), ...Array.from({ length: 39 }, (_, i) => row(String(20000000 + i), { unformattedPrice: -1, beds: null, area: NaN }))];
  const h = harness("search", { respond: (path, n) => n === 2 ? { data: embedded({ searchPageState: searchState(JSON.parse(new URL(path, home).searchParams.get("searchQueryState")), rows) }) } : null });
  const output = await h.run({ ...valid("search"), limit: 3 });
  assert.equal(output.results.length, 3);
  assert.equal(output.truncated, true);
  assert.equal(output.results[1].price, null);
  assert.ok(JSON.stringify(output).length < 5000);
});
for (const rows of [[row("12345678", { hdpData: { homeInfo: { zpid: 12345678, homeStatus: "FOR_RENT" } }, unformattedPrice: 2500 })], [row("12345678", { detailUrl: "https://evil.test/private?token=secret" })], [row("12345678", { isBuilding: true })], [row("12345678", { detailUrl: listing.replace("12345678", "99999999") })], Array.from({ length: 42 }, () => row())]) {
  test("zillow search: unsupported/unsafe result rows are site_changed, not silently skipped", async () => {
    const h = harness("search", { respond: (path, n) => n === 2 ? { data: embedded({ searchPageState: searchState(JSON.parse(new URL(path, home).searchParams.get("searchQueryState")), rows) }) } : null });
    assert.equal((await h.run(valid("search"))).error_kind, "site_changed");
  });
}

for (const listing_url of ["12345678", "http://www.zillow.com/homedetails/example/12345678_zpid/", listing + "?view=owner", listing + "#token", listing.replace("www.zillow.com", "evil.test"), listing.replace("www.zillow.com", "user:pass@www.zillow.com"), listing.replace("/1-Example", "/../1-Example"), home + "apartments/example/building/ABC/", listing.replace("12345678", "0")]) {
  test(`zillow get_listing: invalid or consequential URL is refused ${listing_url}`, async () => {
    const h = harness("get_listing");
    assert.equal((await h.run({ listing_url })).error_kind, "invalid_input");
    assert.equal(h.calls.length, 0);
  });
}
test("zillow get_listing: core facts from unrelated page omit private state and preserve site units", async () => {
  const h = harness("get_listing", { url: home + "seattle-wa/" });
  const output = await h.run(valid("get_listing"));
  assert.equal(h.calls.length, 1);
  assert.equal(output.status, "ok");
  assert.equal(output.url, listing);
  assert.equal(output.lot_area_units, "Acres");
  assert.equal(output.living_area_sqft, 1234);
  assert.equal(output.last_updated_local, "2026-01-02 10:30:00");
});
for (const [change, kind] of [
  [{ zpid: 99999999 }, "not_found"], [{ hdpUrl: "https://evil.test/view?token=secret" }, "site_changed"], [{ hdpUrl: listing.replace("12345678", "99999999") }, "site_changed"], [{ address: null }, "site_changed"]
]) {
  test(`zillow get_listing: property identity failure ${kind} is explicit`, async () => {
    const h = harness("get_listing", { respond: () => ({ data: listingData(property(change)) }) });
    assert.equal((await h.run(valid("get_listing"))).error_kind, kind);
  });
}
test("zillow get_listing: unknown numbers, currency and living-area units become null", async () => {
  const h = harness("get_listing", { respond: () => ({ data: listingData(property({ price: "500000", currency: "usd", bedrooms: -1, bathrooms: null, livingAreaUnits: "Square Meters", yearBuilt: 0, zestimate: -1, isUndisclosedAddress: true })) }) });
  const output = await h.run(valid("get_listing"));
  for (const field of ["price", "currency", "bedrooms", "bathrooms", "living_area_sqft", "year_built", "zestimate"]) assert.equal(output[field], null);
  assert.equal(output.address.street, null);
});
