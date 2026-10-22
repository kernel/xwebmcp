import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";

// Harness for the opentable.com page tools. The page, its fetch and the site's HTML are stubbed; nothing here
// contacts the live site. Restaurants, diners, reviews and keys below are fabricated.
const NAMES = ["search_restaurants", "get_restaurant", "get_reviews"];
const sources = Object.fromEntries(NAMES.map(name => [name, readFileSync(new URL(`../domains/opentable.com/${name}.js`, import.meta.url), "utf8")]));
const registry = JSON.parse(readFileSync(new URL("../registry.json", import.meta.url), "utf8"));
const plain = value => JSON.parse(JSON.stringify(value));
const ORIGIN = "https://www.opentable.com";
const FAKE_KEY = "FAKE-MAPS-KEY-000";
const FAKE_EMAIL = "signed.in.person@example.test";
const FAKE_NICK = "FakeDinerNick";

function conforms(schema, value) {
  if ("const" in schema && value !== schema.const) return false;
  if (schema.enum && !schema.enum.includes(value)) return false;
  if (schema.type && ![schema.type].flat().some(type => {
    if (type === "null") return value === null;
    if (type === "integer") return Number.isInteger(value);
    if (type === "number") return typeof value === "number";
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
    if (schema.properties) {
      if (Object.entries(schema.properties).some(([key, s]) => key in value && !conforms(s, value[key]))) return false;
      if (schema.additionalProperties === false && Object.keys(value).some(key => !(key in schema.properties))) return false;
    }
  }
  if (typeof value === "string") {
    if (value.length < (schema.minLength ?? 0) || value.length > (schema.maxLength ?? Infinity)) return false;
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) return false;
    if (schema.format === "uri" && !URL.canParse(value)) return false;
  }
  if (typeof value === "number") {
    if (value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity)) return false;
  }
  return true;
}

// --- fabricated site data ---------------------------------------------------------------------------

const pageHtml = (state, title = "Example | OpenTable") =>
  `<html><head><title>${title}</title></head><body><script id="primary-window-vars" type="application/json">${JSON.stringify({ windowVariables: { __PAGE_INFO__: { rateLimit: 4 }, __INITIAL_STATE__: state } })}</script></body></html>`;

const signedInState = () => ({
  authentication: { isAuthenticated: true },
  header: { userProfile: { firstName: "Fake", email: FAKE_EMAIL, mobilePhoneNumber: { number: "5550100" }, points: 1234 } }
});

const searchRestaurant = (id, name, extra = {}) => ({
  restaurantId: id, name, type: "GuestCenter", slotDiscovery: "on", campaignId: 77, restaurantAvailabilityToken: "TOKEN-" + id,
  urls: { profileLink: { link: `https://www.opentable.com/r/test-${id}-chicago?corrid=abc`, __typename: "PageLink" } },
  priceBand: { priceBandId: 3, currencySymbol: "$", name: "$31 to $50" }, neighborhood: { name: "Fake Loop" },
  statistics: { recentReservationCount: 12, reviews: { allTimeTextReviewCount: 340, ratings: { overall: { rating: 4.6 } } } },
  primaryCuisine: { name: "Pizzeria" }, features: { reservationMaxPartySize: 8, bar: true }, privateDining: { hasPrivateDining: true },
  diningStyle: "Casual Dining", hasTakeout: true, coordinates: { latitude: 41.88, longitude: -87.63 },
  address: { line1: "1 Example St", line2: "", city: "Chicago", state: "IL", postCode: "60601" },
  description: "A <b>fake</b> pizza place &amp; bar.<br />Second line.", photos: { profileV3: { url: "//img.example.test/x" } },
  contactInformation: { phoneNumber: "5550101", formattedPhoneNumber: "(555) 010-1234" }, offers: [], groups: [{ id: 1 }],
  ...extra
});

const searchState = (restaurants, extra = {}) => ({
  ...signedInState(),
  multiSearch: {
    pageType: "metro", metroId: 3, latitude: 41.9, longitude: -87.6, metro: { metroId: 3, name: "Chicago / Illinois", timezone: "America/Chicago" },
    isNotFoundError: false, isServerError: false, restaurants, totalRestaurantCount: restaurants.length, pageNumber: 1, limit: 50, freetextTerm: "pizza chicago", ...extra
  }
});

const review = (id, extra = {}) => ({
  reviewId: id, text: "Fake review text.", rating: { food: 5, service: 4, ambience: 3, value: 2, noise: "MODERATE", overall: 4 },
  user: { nickname: FAKE_NICK, initials: "FD", metro: "Fake Metro", profilePhoto: { url: "//img.example.test/face" }, isLoggedInUser: false },
  helpfulness: { up: 3, down: 0, score: 3 }, publicRestaurantReply: null, submittedDateTime: "2026-09-27T16:36:29Z", dinedDateTime: "2026-09-26T16:30:00-04:00",
  type: "OPENTABLEVERIFIED", fromPreviousConcept: false, highlight: null, photos: [], ...extra
});

const profileState = (id, extra = {}, reviewData = {}, restaurantExtra = {}) => ({
  ...signedInState(),
  restaurantProfile: {
    restaurant: {
      restaurantId: id, name: "Fake Bistro", description: "A fake bistro &amp; wine bar.<br/>Open late.", diningStyle: "Casual Elegant", executiveChef: "Fake Chef", website: "https://bistro.example.test/",
      dressCode: "Smart Casual", crossStreet: "Main St ", parkingInfo: "Street Parking", parkingDetails: "", publicTransit: "Near the fake line.", entertainment: "Jazz on Fridays",
      cateringDetails: "Call 555-0102 or events@bistro.example.test", hoursOfOperation: "Mon-Fri 5:00 pm-9:00 pm\n<br />Sat 5:00 pm-10:00 pm", maxAdvanceDays: 90, hasTakeout: true,
      additionalDetails: ["Bar/Lounge", "Wine", "Wine", "Patio/Outdoor Dining"], paymentOptions: ["AMEX", "Visa"], urls: { privateDiningProfileLink: { link: "https://www.opentable.com/private-dining/profile/x" } },
      features: { bar: true, counter: false, highTop: false, outdoor: true, reservationMaxPartySize: 6, permanentlyClosed: false, dinerAiEnabled: true, contactLink: "" },
      privateDining: { hasPrivateDining: false, contact: "Fake Events" }, timeZone: { code: "EST", offsetInMinutes: -240 }, priceBand: { priceBandId: 3, name: "$31 to $50" },
      neighborhood: { name: "Fake Downtown", coordinates: { latitude: 1, longitude: 2 } }, metro: { metroId: 9, displayName: "Fake Metro" },
      address: { line1: "2 Example Ave", line2: "", city: "Fakeville", state: "DC", postCode: "20001", country: "United States" },
      coordinates: { latitude: 38.9, longitude: -77.03, mapUrl: `https://maps.example.test/static?key=${FAKE_KEY}` },
      contactInformation: { phoneNumber: "5550103", formattedPhoneNumber: "(555) 010-3333", email: "owner@bistro.example.test" },
      cuisines: [{ name: "American" }, { name: "Seafood" }], primaryCuisine: { name: "American" },
      statistics: {
        recentReservationCount: 24,
        reviews: {
          allTimeTextReviewCount: 2157, awards: [{ name: "Most Booked", location: "Fake Metro" }],
          ratings: { count: 48, overall: { rating: 4.3 }, food: { rating: 4.5, count: 48 }, service: { rating: 4.4, count: 48 }, ambience: { rating: 4.2, count: 48 }, value: { rating: 4, count: 48 }, noise: { rating: 2, count: 48 }, overallRatingsDistribution: { one: 1, two: 2, three: 3, four: 10, five: 32 } },
          categories: [{ category: { name: "Lively", key: "lively" } }, { category: { name: "Innovative", key: "innovative" } }]
        }
      },
      restaurantReviewSummary: { summary: "Diners praise the fake food." }, popularDishes: { dishes: [] }, experiences: [],
      ...restaurantExtra
    },
    metaLinks: { canonical: `https://www.opentable.com/r/fake-bistro-fakeville` },
    menus: { menuData: null, menuInfo: { showThirdPartyMenu: true, url: "https://bistro.example.test/menu?utm_source=opentable" } },
    reviewsData: { reviewSearchResults: { reviews: [review("REV-1"), review("REV-2", { publicRestaurantReply: { text: "Thanks from the fake owner" }, photos: [{ photoId: 1 }, { photoId: 2 }], type: "OTHER", rating: { food: 1, service: 1, ambience: 1, value: 1, noise: null, overall: 1 } })], totalPages: 216, page: 1, totalCount: 2157 }, sortBy: "newestReview", ...reviewData },
    isHuman: false, ...extra
  }
});

const menuData = itemCount => [
  { title: "Dinner", description: "Evening <i>menu</i>", currency: { code: "USD" }, updated: "2026-01-01T00:00:00", provider: { name: "Fake Provider", image: "x" }, sections: [
    { title: "Starters", description: null, items: Array.from({ length: itemCount }, (_, i) => ({ title: `Dish ${i + 1}`, description: i === 0 ? "With &quot;fake&quot; sauce" : null, price: i === 0 ? "12.50" : null, variationGroups: [] })) },
    { title: "Empty", description: null, items: [{ title: "  ", description: null, price: null }] }
  ] }
];

// --- harness ---------------------------------------------------------------------------------------

async function run(name, input, o = {}) {
  const calls = { fetch: [] };
  const context = {
    window: { location: { origin: o.origin ?? ORIGIN } }, document: { title: o.title ?? "OpenTable" }, URL, URLSearchParams, TextEncoder,
    fetch: async (path, init) => {
      calls.fetch.push({ path, init });
      const r = typeof o.respond === "function" ? o.respond(path, init) : o.respond;
      if (r instanceof Error) throw r;
      return { status: r.status ?? 200, url: r.url ?? ORIGIN + path, text: async () => r.html };
    }
  };
  const [definition] = runInNewContext(`(${sources[name]})`, {});
  // The runtime serializes a page tool's execute into the page, so run the serialized text against stubbed globals only.
  const execute = runInNewContext("(" + definition.execute.toString() + ")", context);
  const output = plain(await execute(input, { signal: o.signal }));
  return { output, calls, definition };
}
const definitionOf = name => runInNewContext(`(${sources[name]})`, {})[0];
const ok = html => ({ respond: () => ({ html }) });

function assertConforms(name, output) {
  assert.ok(conforms(definitionOf(name).tool.outputSchema, output), "output must conform to outputSchema: " + JSON.stringify(output).slice(0, 400));
}

const LEAKS = [FAKE_KEY, FAKE_EMAIL, FAKE_NICK, "owner@bistro.example.test", "TOKEN-", "img.example.test", "maps.example.test", "campaignId", "photoId", "Thanks from the fake owner", "mapUrl", "utm_source"];
const assertNoLeaks = output => {
  const text = JSON.stringify(output);
  for (const leak of LEAKS) assert.ok(!text.includes(leak), `output must not contain ${leak}`);
};

// --- definitions -----------------------------------------------------------------------------------

test("definitions are page tools on www.opentable.com with registry entries", () => {
  for (const name of NAMES) {
    const d = definitionOf(name);
    assert.equal(d.kind, "page");
    assert.deepEqual(plain(d.match.url_patterns), [ORIGIN + "/*"]);
    assert.equal(d.tool.name, name);
    assert.equal(d.tool.annotations.readOnlyHint, true);
    assert.ok(d.tool.inputSchema && d.tool.outputSchema);
    const entry = registry.tools.find(t => t.domain === "opentable.com" && t.tool === name);
    assert.ok(entry, name + " must have a registry entry");
    assert.equal(entry.kind, "page");
    assert.deepEqual(entry.url_patterns, [ORIGIN + "/*"]);
  }
  assert.equal(registry.tools.filter(t => t.domain === "opentable.com").length, 7);
});

// --- search_restaurants ----------------------------------------------------------------------------

test("search_restaurants builds the site's search URL and maps an allowlist of fields", async () => {
  const state = searchState([searchRestaurant(101, "Fake Pizza"), searchRestaurant(102, "Second Fake", { urls: { profileLink: { link: "https://evil.example.test/x" } }, primaryCuisine: null, description: "x".repeat(500) })], { totalRestaurantCount: 117 });
  const { output, calls } = await run("search_restaurants", { query: "  pizza   Chicago ", date: "2026-10-16", time: "18:30", party_size: 4, page: 2 }, ok(pageHtml(state)));
  assert.equal(calls.fetch.length, 1);
  assert.equal(calls.fetch[0].path, "/s?dateTime=2026-10-16T18%3A30%3A00&covers=4&term=pizza%20Chicago&page=2");
  assert.equal(calls.fetch[0].init.credentials, "same-origin");
  assert.equal(output.status, "ok");
  assert.deepEqual(output.query, { query: "pizza Chicago", date: "2026-10-16", time: "18:30", party_size: 4, page: 2 });
  assert.equal(output.total_count, 117);
  assert.equal(output.page, 2);
  assert.equal(output.page_size, 50);
  assert.equal(output.has_more, true);
  assert.deepEqual(output.location, { metro_id: 3, metro_name: "Chicago / Illinois", latitude: 41.9, longitude: -87.6 });
  const [first, second] = output.restaurants;
  assert.equal(first.rank, 51);
  assert.equal(first.restaurant_id, 101);
  assert.equal(first.url, "https://www.opentable.com/r/test-101-chicago");
  assert.equal(first.cuisine, "Pizzeria");
  assert.equal(first.price_level, 3);
  assert.equal(first.price_label, "$31 to $50");
  assert.deepEqual(first.address, { line1: "1 Example St", line2: null, city: "Chicago", state: "IL", postal_code: "60601" });
  assert.equal(first.rating, 4.6);
  assert.equal(first.review_count, 340);
  assert.equal(first.recent_reservation_count, 12);
  assert.equal(first.max_party_size, 8);
  assert.equal(first.has_private_dining, true);
  assert.equal(first.phone, "(555) 010-1234");
  assert.equal(first.description, "A fake pizza place & bar.\nSecond line.");
  assert.equal(second.rank, 52);
  assert.equal(second.url, "https://www.opentable.com/restaurant/profile/102", "an off-site profile link falls back to the id URL");
  assert.equal(second.cuisine, null);
  assert.equal(second.description.length, 300);
  assertNoLeaks(output);
  assertConforms("search_restaurants", output);
});

test("search_restaurants caps every string field", async () => {
  const long = "z".repeat(5000);
  const state = searchState([searchRestaurant(101, "  " + long, { primaryCuisine: { name: long }, neighborhood: { name: long }, diningStyle: long, priceBand: { priceBandId: 2, name: long }, description: long, contactInformation: { formattedPhoneNumber: long }, address: { line1: long, line2: long, city: long, state: long, postCode: long } })]);
  const { output } = await run("search_restaurants", { query: "pizza chicago" }, ok(pageHtml(state)));
  const r = output.restaurants[0];
  assert.equal(r.name.length, 200);
  assert.ok([r.cuisine, r.neighborhood, r.dining_style, r.price_label, r.phone, ...Object.values(r.address)].every(v => v.length === 300));
  assert.equal(r.description.length, 300);
  assertConforms("search_restaurants", output);
});

test("search_restaurants defaults the time, omits absent filters, and reports has_more false on the last page", async () => {
  const state = searchState([searchRestaurant(101, "Fake Pizza")]);
  const dated = await run("search_restaurants", { query: "pizza", date: "2026-10-16" }, ok(pageHtml(state)));
  assert.equal(dated.calls.fetch[0].path, "/s?dateTime=2026-10-16T19%3A00%3A00&term=pizza");
  assert.equal(dated.output.query.time, "19:00");
  assert.equal(dated.output.has_more, false);
  const plainSearch = await run("search_restaurants", { query: "C++ pizza & pasta" }, ok(pageHtml(state)));
  assert.equal(plainSearch.calls.fetch[0].path, "/s?term=C%2B%2B%20pizza%20%26%20pasta");
  assert.deepEqual([plainSearch.output.query.date, plainSearch.output.query.time, plainSearch.output.query.party_size], [null, null, null]);
});

test("search_restaurants returns no_results for empty or out-of-range pages and never an empty success", async () => {
  const none = await run("search_restaurants", { query: "zzzz nowhere" }, ok(pageHtml(searchState([], { totalRestaurantCount: 0 }))));
  assert.equal(none.output.status, "no_results");
  assertConforms("search_restaurants", none.output);
  const beyond = await run("search_restaurants", { query: "pizza chicago", page: 100 }, ok(pageHtml(searchState([], { totalRestaurantCount: 0, pageNumber: 100 }))));
  assert.equal(beyond.output.status, "no_results");
  assert.match(beyond.output.message, /page 100/);
  const emptyFirstPage = await run("search_restaurants", { query: "pizza chicago" }, ok(pageHtml(searchState([], { totalRestaurantCount: 5 }))));
  assert.equal(emptyFirstPage.output.status, "no_results", "an empty first page is never an ok result, even when the site reports a count");
  const unusable = await run("search_restaurants", { query: "pizza" }, ok(pageHtml(searchState([{ name: "No id" }, null]))));
  assert.equal(unusable.output.status, "no_results");
});

test("search_restaurants rejects malformed input before touching the site", async () => {
  const bad = [
    undefined, null, [], "pizza", {}, { query: "a" }, { query: "x".repeat(101) }, { query: 5 }, { query: "pizza", extra: 1 },
    { query: "pizza", date: "2026-02-30" }, { query: "pizza", date: "16/10/2026" }, { query: "pizza", time: "19:00" }, { query: "pizza", date: "2026-10-16", time: "24:00" },
    { query: "pizza", date: "2026-10-16", time: "7pm" }, { query: "pizza", party_size: 0 }, { query: "pizza", party_size: 21 }, { query: "pizza", party_size: 2.5 }, { query: "pizza", party_size: "2" },
    { query: "pizza", page: 0 }, { query: "pizza", page: 101 }, { query: "pizza", page: "2" }
  ];
  for (const input of bad) {
    const { output, calls } = await run("search_restaurants", input, ok(pageHtml(searchState([]))));
    assert.equal(output.status, "error", JSON.stringify(input));
    assert.equal(output.error_kind, "invalid_input", JSON.stringify(input));
    assert.equal(calls.fetch.length, 0, "no request for " + JSON.stringify(input));
    assertConforms("search_restaurants", output);
  }
});

test("search_restaurants reports wrong pages, bot protection, rate limits and site changes explicitly", async () => {
  const input = { query: "pizza chicago" };
  const state = searchState([searchRestaurant(101, "Fake Pizza")]);
  const wrong = await run("search_restaurants", input, { origin: "https://help.opentable.com", ...ok(pageHtml(state)) });
  assert.equal(wrong.output.error_kind, "wrong_page");
  assert.equal(wrong.calls.fetch.length, 0);
  const fromDenied = await run("search_restaurants", input, { title: "Access Denied", ...ok(pageHtml(state)) });
  assert.equal(fromDenied.output.status, "ok", "the search page is requested even when the current document was refused");
  const denied = await run("search_restaurants", input, { respond: () => ({ status: 403, html: "<HTML><HEAD><TITLE>Access Denied</TITLE></HEAD><BODY>Reference #18.abc</BODY></HTML>" }) });
  assert.equal(denied.output.error_kind, "challenge");
  assert.match(denied.output.error_message, /get_restaurant with url '\/<name-as-slug>'/);
  assert.match(denied.output.error_message, /check the returned name and address/);
  const deniedWith200 = await run("search_restaurants", input, { respond: () => ({ html: "<html><head><title>Access Denied</title></head><body></body></html>" }) });
  assert.equal(deniedWith200.output.error_kind, "challenge");
  const limited = await run("search_restaurants", input, { respond: () => ({ status: 429, html: "" }) });
  assert.equal(limited.output.error_kind, "rate_limited");
  const broken = await run("search_restaurants", input, { respond: () => ({ status: 503, html: "" }) });
  assert.equal(broken.output.error_kind, "site_error");
  const noScript = await run("search_restaurants", input, { respond: () => ({ html: "<html><head><title>OpenTable</title></head><body>hello</body></html>" }) });
  assert.equal(noScript.output.error_kind, "site_changed");
  const badJson = await run("search_restaurants", input, { respond: () => ({ html: '<script id="primary-window-vars">{not json</script>' }) });
  assert.equal(badJson.output.error_kind, "site_changed");
  const noSearch = await run("search_restaurants", input, ok(pageHtml({ authentication: {} })));
  assert.equal(noSearch.output.error_kind, "site_changed");
  const serverError = await run("search_restaurants", input, ok(pageHtml(searchState([], { isServerError: true, totalRestaurantCount: 0 }))));
  assert.equal(serverError.output.error_kind, "site_error");
  const thrown = await run("search_restaurants", input, { respond: () => new Error("network down") });
  assert.equal(thrown.output.error_kind, "site_error");
  assert.match(thrown.output.error_message, /network down/);
  for (const r of [wrong, denied, deniedWith200, limited, broken, noScript, badJson, noSearch, serverError, thrown]) {
    assert.equal(r.output.status, "error");
    assertConforms("search_restaurants", r.output);
  }
});

// --- get_restaurant --------------------------------------------------------------------------------

test("get_restaurant reads the profile by id and maps an allowlist of fields", async () => {
  const { output, calls } = await run("get_restaurant", { restaurant_id: 555 }, ok(pageHtml(profileState(555))));
  assert.equal(calls.fetch.length, 1);
  assert.equal(calls.fetch[0].path, "/restaurant/profile/555");
  assert.equal(output.status, "ok");
  assert.equal(output.restaurant_id, 555);
  assert.equal(output.name, "Fake Bistro");
  assert.equal(output.url, "https://www.opentable.com/r/fake-bistro-fakeville");
  assert.equal(output.description, "A fake bistro & wine bar.\nOpen late.");
  assert.deepEqual(output.cuisines, ["American", "Seafood"]);
  assert.equal(output.price_level, 3);
  assert.equal(output.neighborhood, "Fake Downtown");
  assert.equal(output.metro_name, "Fake Metro");
  assert.deepEqual(output.address, { line1: "2 Example Ave", line2: null, city: "Fakeville", state: "DC", postal_code: "20001", country: "United States" });
  assert.equal(output.phone, "(555) 010-3333");
  assert.equal(output.website, "https://bistro.example.test/");
  assert.equal(output.hours_text, "Mon-Fri 5:00 pm-9:00 pm\nSat 5:00 pm-10:00 pm");
  assert.equal(output.cross_street, "Main St");
  assert.equal(output.parking_details, null);
  assert.deepEqual(output.amenities, ["Bar/Lounge", "Wine", "Patio/Outdoor Dining"]);
  assert.deepEqual(output.seating, { bar: true, counter: false, high_top: false, outdoor: true });
  assert.equal(output.reservation_max_party_size, 6);
  assert.equal(output.max_advance_days, 90);
  assert.equal(output.permanently_closed, false);
  assert.equal(output.has_takeout, true);
  assert.equal(output.has_private_dining, false);
  assert.deepEqual(output.time_zone, { code: "EST", offset_minutes: -240 });
  assert.deepEqual(output.ratings, { overall: 4.3, food: 4.5, service: 4.4, ambience: 4.2, value: 4, noise: 2, rating_count: 48, distribution: { one: 1, two: 2, three: 3, four: 10, five: 32 } });
  assert.equal(output.review_count, 2157);
  assert.equal(output.recent_reservation_count, 24);
  assert.deepEqual(output.awards, [{ name: "Most Booked", location: "Fake Metro" }]);
  assert.deepEqual(output.tags, ["Lively", "Innovative"]);
  assert.equal(output.review_summary_ai, "Diners praise the fake food.");
  assert.equal(output.external_menu_url, "https://bistro.example.test/menu");
  assert.equal(output.menus, null);
  assert.ok(!("catering" in output) && !JSON.stringify(output).includes("events@bistro"), "catering contact details are not returned");
  assertNoLeaks(output);
  assertConforms("get_restaurant", output);
});

test("get_restaurant accepts only /r/<slug>, /<slug> and /restaurant/profile/<id> pages and rejects every other path before fetching", async () => {
  const html = ok(pageHtml(profileState(555)));
  const accepted = [
    ["https://www.opentable.com/r/fake-bistro-fakeville?covers=2&dateTime=x#reviews", "/r/fake-bistro-fakeville"],
    ["/r/fake-bistro/", "/r/fake-bistro"],
    ["  /r/fake_bistro-2  ", "/r/fake_bistro-2"],
    ["https://www.opentable.com/restaurant/profile/555", "/restaurant/profile/555"],
    ["/restaurant/profile/2147483647/", "/restaurant/profile/2147483647"],
    ["https://www.opentable.com/the-hamilton", "/the-hamilton"],
    ["/the-hamilton/", "/the-hamilton"],
    ["/log-haven", "/log-haven"],
    ["/my-thai-place", "/my-thai-place"],
    ["/sign-of-the-whale", "/sign-of-the-whale"]
  ];
  for (const [url, path] of accepted) {
    const { output, calls } = await run("get_restaurant", { url }, html);
    assert.equal(calls.fetch.length, 1, url);
    assert.equal(calls.fetch[0].path, path, url);
    assert.equal(output.status, "ok", url);
  }
  // Account, sign-out and booking paths are never fetched, nor are single words that cannot be a restaurant's short address.
  const notProfiles = [
    "/s", "/logout", "/restref", "/nearby", "/log-out", "/sign-out", "/log-in", "/sign-up", "/login-help", "/user-profile", "/cancel-reservation", "/my-account", "/the-hamilton/reviews",
    "/user/favorites", "/restref/client/?rid=1", "/booking/details", "/authenticate/start", "/dapi/v1/session",
    "/r/", "/r/a/b", "/r/../s", "/r/..%2Fuser", "/r/caf%C3%A9", "/private-dining/profile/x", "/restaurant/profile/", "/restaurant/profile/abc",
    "/restaurant/profile/0", "/restaurant/profile/2147483648", "/restaurant/profile/99999999999", "/restaurant/profile/5/extra", "/",
    "/foo/r/x", "/private-dining/r/x", "/x/restaurant/profile/5", "/r/" + "a".repeat(121), "/r/-leading-dash", "/r/_x"
  ];
  for (const url of notProfiles) {
    const { output, calls } = await run("get_restaurant", { url }, html);
    assert.equal(output.error_kind, "invalid_input", url);
    assert.equal(calls.fetch.length, 0, "no request for " + url);
    assertConforms("get_restaurant", output);
  }
  const longestSlug = await run("get_restaurant", { url: "/r/" + "a".repeat(120) }, html);
  assert.equal(longestSlug.calls.fetch.length, 1, "a 120 character slug is accepted");
  for (const url of ["https://user:pw@www.opentable.com/r/fake", "https://www.opentable.com:8443/r/fake", "https://www.opentable.com:443@evil.example.test/r/fake"]) {
    const r = await run("get_restaurant", { url }, html);
    assert.equal(r.calls.fetch.length, 0, "no request for " + url);
    assert.ok(["invalid_input", "unsupported_host"].includes(r.output.error_kind), url);
  }
  assert.equal((await run("get_restaurant", { url: "https://www.opentable.com:443/r/fake" }, html)).calls.fetch[0].path, "/r/fake", "the default port is fine");
  const bad = [
    [{}, "invalid_input"], [{ restaurant_id: 5, url: "/r/x" }, "invalid_input"], [{ restaurant_id: 0 }, "invalid_input"], [{ restaurant_id: 1.5 }, "invalid_input"], [{ restaurant_id: "7" }, "invalid_input"],
    [{ restaurant_id: 2147483648 }, "invalid_input"], [{ url: "" }, "invalid_input"], [{ url: 5 }, "invalid_input"], [{ url: "x".repeat(301) }, "invalid_input"],
    [{ url: "https://evil.example.test/r/fake" }, "unsupported_host"], [{ url: "https://www.opentable.ca/r/fake" }, "unsupported_host"], [{ url: "https://help.opentable.com/r/fake" }, "unsupported_host"],
    [{ url: "//evil.example.test/r/fake" }, "unsupported_host"], [{ url: "https://www.opentable.com.evil.example.test/r/fake" }, "unsupported_host"],
    [{ url: "http://www.opentable.com/r/fake" }, "invalid_input"], [{ url: "javascript:alert(1)" }, "invalid_input"], [{ url: "ftp://www.opentable.com/r/fake" }, "invalid_input"],
    [{ url: "/r/fake", include_menus: "yes" }, "invalid_input"], [{ url: "/r/fake", extra: true }, "invalid_input"]
  ];
  for (const [input, kind] of bad) {
    const { output, calls } = await run("get_restaurant", input, html);
    assert.equal(output.error_kind, kind, JSON.stringify(input));
    assert.equal(calls.fetch.length, 0, "no request for " + JSON.stringify(input));
    assertConforms("get_restaurant", output);
  }
  assert.doesNotMatch((await run("get_restaurant", { url: "javascript:alert(1)" }, html)).output.error_message, /different site/, "a non-https URL is not called a different site");
  for (const input of [undefined, null, [], "/r/fake"]) {
    const { output, calls } = await run("get_restaurant", input, html);
    assert.equal(output.error_kind, "invalid_input");
    assert.equal(calls.fetch.length, 0);
  }
});

test("get_restaurant caps every string field and only returns query-free http(s) links", async () => {
  const long = "x".repeat(5000);
  const state = profileState(555, {}, {}, {
    name: "  " + long, primaryCuisine: { name: long }, diningStyle: long, neighborhood: { name: long }, address: { line1: long, line2: long, city: long, state: long, postCode: long, country: long },
    contactInformation: { formattedPhoneNumber: long }, website: "https://bistro.example.test/menu/?utm_source=ot&token=SECRET-TOKEN#frag", dressCode: long, executiveChef: long, parkingInfo: long, description: long, restaurantReviewSummary: { summary: long },
    additionalDetails: [long], awards: undefined
  });
  state.restaurantProfile.menus.menuInfo = { url: "https://bistro.example.test/eat?y_source=SECRET-SOURCE" };
  const { output } = await run("get_restaurant", { restaurant_id: 555 }, ok(pageHtml(state)));
  assert.equal(output.status, "ok");
  assert.equal(output.name.length, 200);
  assert.equal(output.dining_style.length, 300);
  assert.equal(output.neighborhood.length, 300);
  assert.ok(Object.values(output.address).every(v => v.length === 300));
  assert.equal(output.phone.length, 300);
  assert.equal(output.dress_code.length, 200);
  assert.equal(output.description.length, 1500);
  assert.equal(output.review_summary_ai.length, 1500);
  assert.equal(output.amenities[0].length, 120);
  assert.equal(output.website, "https://bistro.example.test/menu/");
  assert.equal(output.external_menu_url, "https://bistro.example.test/eat");
  assert.ok(!JSON.stringify(output).includes("SECRET-"), "tracking parameters are not returned");
  assertConforms("get_restaurant", output);
  const fragmentOnly = await run("get_restaurant", { restaurant_id: 555 }, ok(pageHtml(profileState(555, {}, {}, { website: "https://bistro.example.test/menu#SECRET-FRAGMENT" }))));
  assert.equal(fragmentOnly.output.website, "https://bistro.example.test/menu", "a fragment without a query is removed too");
  for (const website of ["bistro.example.test", "javascript:alert(1)", "ftp://bistro.example.test/", "", 5, null]) {
    const r = await run("get_restaurant", { restaurant_id: 555 }, ok(pageHtml(profileState(555, {}, {}, { website }))));
    assert.equal(r.output.website, null, "only http(s) links are returned: " + website);
  }
});

test("get_restaurant returns menus only on request, bounded to 100 items", async () => {
  const small = profileState(555);
  small.restaurantProfile.menus.menuData = menuData(3);
  const off = await run("get_restaurant", { restaurant_id: 555 }, ok(pageHtml(small)));
  assert.equal(off.output.menus, null);
  const on = await run("get_restaurant", { restaurant_id: 555, include_menus: true }, ok(pageHtml(small)));
  assert.equal(on.output.menus.truncated, false);
  assert.equal(on.output.menus.menus.length, 1);
  assert.equal(on.output.menus.menus[0].title, "Dinner");
  assert.equal(on.output.menus.menus[0].description, "Evening menu");
  assert.equal(on.output.menus.menus[0].sections.length, 1, "sections whose items have no title are dropped");
  assert.deepEqual(on.output.menus.menus[0].sections[0].items[0], { title: "Dish 1", description: "With \"fake\" sauce", price: "12.50" });
  assertConforms("get_restaurant", on.output);
  const big = profileState(555);
  big.restaurantProfile.menus.menuData = menuData(350);
  const capped = await run("get_restaurant", { restaurant_id: 555, include_menus: true }, ok(pageHtml(big)));
  assert.equal(capped.output.menus.truncated, true);
  assert.equal(capped.output.menus.menus[0].sections[0].items.length, 100);
  assertConforms("get_restaurant", capped.output);
  const noMenus = await run("get_restaurant", { restaurant_id: 555, include_menus: true }, ok(pageHtml(profileState(555))));
  assert.deepEqual(noMenus.output.menus, { truncated: false, menus: [] });
});

test("get_restaurant falls back to the id URL, ignores an off-site canonical, and keeps nulls for missing fields", async () => {
  const state = profileState(555, { metaLinks: { canonical: "https://evil.example.test/r/x" } });
  const { output } = await run("get_restaurant", { restaurant_id: 555 }, ok(pageHtml(state)));
  assert.equal(output.url, "https://www.opentable.com/restaurant/profile/555");
  const sparse = profileState(556, {}, {}, { description: undefined, website: null, hoursOfOperation: "", cuisines: null, additionalDetails: null, paymentOptions: undefined, timeZone: null, features: undefined, statistics: undefined, restaurantReviewSummary: undefined, priceBand: undefined, awards: undefined });
  const sparseOut = (await run("get_restaurant", { restaurant_id: 556 }, ok(pageHtml(sparse)))).output;
  assert.equal(sparseOut.status, "ok");
  assert.deepEqual([sparseOut.description, sparseOut.website, sparseOut.hours_text, sparseOut.time_zone, sparseOut.review_count, sparseOut.review_summary_ai, sparseOut.price_level], [null, null, null, null, null, null, null]);
  assert.deepEqual([sparseOut.cuisines, sparseOut.amenities, sparseOut.payment_options, sparseOut.awards, sparseOut.tags], [[], [], [], [], []]);
  assert.deepEqual(sparseOut.ratings, { overall: null, food: null, service: null, ambience: null, value: null, noise: null, rating_count: null, distribution: null });
  assertConforms("get_restaurant", sparseOut);
});

test("get_restaurant reports missing pages, wrong pages, id mismatches and bot protection explicitly", async () => {
  const state = profileState(555);
  const missing = await run("get_restaurant", { url: "/r/no-such-place" }, { respond: () => ({ status: 404, html: "<html><head><title>OpenTable</title></head></html>" }) });
  assert.equal(missing.output.error_kind, "not_found");
  const notProfile = await run("get_restaurant", { restaurant_id: 5 }, ok(pageHtml(searchState([]))));
  assert.equal(notProfile.output.error_kind, "not_found");
  const mismatch = await run("get_restaurant", { restaurant_id: 999 }, ok(pageHtml(state)));
  assert.equal(mismatch.output.error_kind, "site_error");
  const noName = profileState(555);
  delete noName.restaurantProfile.restaurant.name;
  const changed = await run("get_restaurant", { restaurant_id: 555 }, ok(pageHtml(noName)));
  assert.equal(changed.output.error_kind, "site_changed");
  const wrong = await run("get_restaurant", { restaurant_id: 555 }, { origin: "https://www.opentable.ca", ...ok(pageHtml(state)) });
  assert.equal(wrong.output.error_kind, "wrong_page");
  assert.equal(wrong.calls.fetch.length, 0);
  const fromDenied = await run("get_restaurant", { restaurant_id: 555 }, { title: "Access Denied", ...ok(pageHtml(state)) });
  assert.equal(fromDenied.output.status, "ok", "restaurant pages are read even when the current document was refused");
  const notRestaurant = await run("get_restaurant", { url: "/private-dining" }, ok(pageHtml(searchState([]))));
  assert.equal(notRestaurant.output.error_kind, "not_found");
  const denied = await run("get_restaurant", { restaurant_id: 555 }, { respond: () => ({ status: 403, html: "<title>Access Denied</title>" }) });
  assert.equal(denied.output.error_kind, "challenge");
  const limited = await run("get_restaurant", { restaurant_id: 555 }, { respond: () => ({ status: 429, html: "" }) });
  assert.equal(limited.output.error_kind, "rate_limited");
  const noScript = await run("get_restaurant", { restaurant_id: 555 }, { respond: () => ({ html: "<html><title>x</title></html>" }) });
  assert.equal(noScript.output.error_kind, "site_changed");
  const thrown = await run("get_restaurant", { restaurant_id: 555 }, { respond: () => new Error("boom") });
  assert.equal(thrown.output.error_kind, "site_error");
  for (const r of [missing, notProfile, mismatch, changed, wrong, fromDenied, notRestaurant, denied, limited, noScript, thrown]) assertConforms("get_restaurant", r.output);
});

// --- get_reviews -----------------------------------------------------------------------------------

test("get_reviews reads page N of the profile and maps reviews without reviewer identity or reply text", async () => {
  const first = await run("get_reviews", { restaurant_id: 555 }, ok(pageHtml(profileState(555))));
  assert.equal(first.calls.fetch[0].path, "/restaurant/profile/555");
  const third = await run("get_reviews", { url: "https://www.opentable.com/r/fake-bistro-fakeville?x=1", page: 3 }, ok(pageHtml(profileState(555, {}, { reviewSearchResults: { reviews: [review("REV-9")], totalPages: 216, page: 3, totalCount: 2157 } }))));
  assert.equal(third.calls.fetch[0].path, "/r/fake-bistro-fakeville?page=3");
  assert.equal(third.output.page, 3);
  assert.equal(third.output.reviews.length, 1);
  const { output } = first;
  assert.equal(output.status, "ok");
  assert.equal(output.restaurant_id, 555);
  assert.equal(output.name, "Fake Bistro");
  assert.equal(output.url, "https://www.opentable.com/r/fake-bistro-fakeville");
  assert.equal(output.page, 1);
  assert.equal(output.total_count, 2157);
  assert.equal(output.total_pages, 216);
  assert.equal(output.sort, "newest");
  assert.deepEqual(output.reviews[0], {
    review_id: "REV-1", overall: 4, food: 5, service: 4, ambience: 3, value: 2, noise: "MODERATE", text: "Fake review text.", dined_at: "2026-09-26T16:30:00-04:00",
    submitted_at: "2026-09-27T16:36:29Z", verified_by_opentable: true, helpful_votes: 3, photo_count: 0, has_restaurant_reply: false
  });
  assert.equal(output.reviews[1].has_restaurant_reply, true);
  assert.equal(output.reviews[1].photo_count, 2);
  assert.equal(output.reviews[1].verified_by_opentable, false);
  assert.equal(output.reviews[1].noise, null);
  assertNoLeaks(output);
  assertConforms("get_reviews", output);
  assertConforms("get_reviews", third.output);
});

test("get_reviews treats a page the site does not honour as no_results, never as page data", async () => {
  // Past the last page the site returns page 1 with a different page size and totalPages.
  const fallback = profileState(555, {}, { reviewSearchResults: { reviews: Array.from({ length: 40 }, (_, i) => review("R" + i)), totalPages: 318, page: 1, totalCount: 12686 } });
  const beyond = await run("get_reviews", { restaurant_id: 555, page: 1270 }, ok(pageHtml(fallback)));
  assert.equal(beyond.output.status, "no_results");
  assert.equal(beyond.output.total_count, 12686);
  assert.equal(beyond.output.page, 1270);
  assertConforms("get_reviews", beyond.output);
  const overTotal = profileState(555, {}, { reviewSearchResults: { reviews: [review("R1")], totalPages: 3, page: 4, totalCount: 21 } });
  const over = await run("get_reviews", { restaurant_id: 555, page: 4 }, ok(pageHtml(overTotal)));
  assert.equal(over.output.status, "no_results");
  const none = profileState(555, {}, { reviewSearchResults: { reviews: [], totalPages: 0, page: 1, totalCount: 0 } });
  const empty = await run("get_reviews", { restaurant_id: 555 }, ok(pageHtml(none)));
  assert.equal(empty.output.status, "no_results");
  assert.equal(empty.output.total_count, 0);
  assertConforms("get_reviews", empty.output);
  const noIds = profileState(555, {}, { reviewSearchResults: { reviews: [{ text: "no id" }], totalPages: 1, page: 1, totalCount: 1 } });
  const idless = await run("get_reviews", { restaurant_id: 555 }, ok(pageHtml(noIds)));
  assert.equal(idless.output.error_kind, "site_changed");
});

test("get_reviews rejects malformed input and reports site problems explicitly", async () => {
  const html = ok(pageHtml(profileState(555)));
  const bad = [
    [{}, "invalid_input"], [{ restaurant_id: 5, url: "/r/x" }, "invalid_input"], [{ restaurant_id: 0 }, "invalid_input"], [{ restaurant_id: 555, page: 0 }, "invalid_input"], [{ restaurant_id: 555, page: 5001 }, "invalid_input"],
    [{ restaurant_id: 555, page: "2" }, "invalid_input"], [{ restaurant_id: 555, page: 1.5 }, "invalid_input"], [{ restaurant_id: 555, sort: "oldest" }, "invalid_input"],
    [{ url: "https://evil.example.test/r/x" }, "unsupported_host"], [{ url: "/private-dining/profile/x" }, "invalid_input"], [{ url: "http://www.opentable.com/r/x" }, "invalid_input"],
    [{ url: "/my-account" }, "invalid_input"], [{ url: "/s" }, "invalid_input"], [{ url: "/logout" }, "invalid_input"], [{ url: "/restref" }, "invalid_input"], [{ url: "/sign-out" }, "invalid_input"],
    [{ url: "https://www.opentable.com/user/favorites", page: 2 }, "invalid_input"], [{ url: "/r/../s" }, "invalid_input"], [{ url: "javascript:alert(1)" }, "invalid_input"], [{ url: "/restaurant/profile/2147483648" }, "invalid_input"],
    [{ url: "/restaurant/profile/0" }, "invalid_input"], [{ url: "/foo/r/x" }, "invalid_input"], [{ url: "/r/" + "a".repeat(121) }, "invalid_input"], [{ url: "https://user:pw@www.opentable.com/r/x" }, "invalid_input"],
    [{ url: "https://www.opentable.com:8443/r/x" }, "invalid_input"]
  ];
  for (const [input, kind] of bad) {
    const { output, calls } = await run("get_reviews", input, html);
    assert.equal(output.error_kind, kind, JSON.stringify(input));
    assert.equal(calls.fetch.length, 0, "no request for " + JSON.stringify(input));
    assertConforms("get_reviews", output);
  }
  const cases = [
    [{ origin: "https://help.opentable.com", ...html }, "wrong_page"],
    [{ respond: () => ({ status: 403, html: "<title>Access Denied</title>" }) }, "challenge"],
    [{ respond: () => ({ status: 429, html: "" }) }, "rate_limited"],
    [{ respond: () => ({ status: 404, html: "" }) }, "not_found"],
    [{ respond: () => ({ status: 500, html: "" }) }, "site_error"],
    [{ respond: () => ({ html: "<html></html>" }) }, "site_changed"],
    [ok(pageHtml(searchState([]))), "not_found"],
    [ok(pageHtml(profileState(555, {}, { reviewSearchResults: null }))), "site_changed"],
    [{ respond: () => new Error("boom") }, "site_error"]
  ];
  for (const [env, kind] of cases) {
    const { output } = await run("get_reviews", { restaurant_id: 555 }, env);
    assert.equal(output.error_kind, kind);
    assertConforms("get_reviews", output);
  }
  const reported = await run("get_reviews", { restaurant_id: 555 }, ok(pageHtml(profileState(555, {}, { error: true, reviewSearchResults: null }))));
  assert.equal(reported.output.error_kind, "site_error");
  assertConforms("get_reviews", reported.output);
  const mismatch = await run("get_reviews", { restaurant_id: 999 }, html);
  assert.equal(mismatch.output.error_kind, "site_error");
});

test("get_reviews accepts /r/<slug> and id URLs, caps and trims review text, and bounds other strings", async () => {
  const long = "y".repeat(5000);
  const state = profileState(555, {}, { reviewSearchResults: { reviews: [review("R-LONG", { text: "  " + long + "  " }), review("R-BLANK", { text: "   " }), review("R-NOISE", { rating: { overall: 3, noise: long } })], totalPages: 1, page: 1, totalCount: 3 } }, { name: "  " + long });
  const { output } = await run("get_reviews", { url: "https://www.opentable.com/restaurant/profile/555/?x=1" }, ok(pageHtml(state)));
  assert.equal(output.status, "ok");
  assert.equal(output.name.length, 200);
  assert.equal(output.reviews[0].text.length, 3000);
  assert.ok(output.reviews[0].text.startsWith("y") && output.reviews[0].text.endsWith("y"), "review text is trimmed before it is cut");
  assert.equal(output.reviews[1].text, null);
  assert.equal(output.reviews[2].noise.length, 300);
  assertConforms("get_reviews", output);
  const slug = await run("get_reviews", { url: "/r/fake-bistro-fakeville", page: 2 }, ok(pageHtml(profileState(555, {}, { reviewSearchResults: { reviews: [review("R-2")], totalPages: 3, page: 2, totalCount: 25 } }))));
  assert.equal(slug.calls.fetch[0].path, "/r/fake-bistro-fakeville?page=2");
  assert.equal(slug.output.status, "ok");
});

const CHALLENGE_PAGE = '<html><head></head><body><div id="sec-if-cpt-container" role="main"><div class="sec-bc-tile-parent"></div></div></body></html>';

test("a bot-protection challenge served with HTTP 200 and no state is reported as challenge, other stateless pages as site_changed", async () => {
  for (const [name, input] of [["search_restaurants", { query: "pizza chicago" }], ["get_restaurant", { restaurant_id: 555 }], ["get_reviews", { restaurant_id: 555 }]]) {
    const blocked = await run(name, input, { respond: () => ({ status: 200, html: CHALLENGE_PAGE }) });
    assert.equal(blocked.output.error_kind, "challenge", name);
    assert.match(blocked.output.error_message, /challenge page/);
    assertConforms(name, blocked.output);
    const plainPage = await run(name, input, { respond: () => ({ status: 200, html: "<html><head></head><body><p>hello</p></body></html>" }) });
    assert.equal(plainPage.output.error_kind, "site_changed", name);
    // A real page that merely mentions the marker inside its state is not a challenge.
    const withState = name === "search_restaurants" ? searchState([searchRestaurant(1, "sec-if-cpt-container")]) : profileState(555, {}, {}, { name: "sec-bc-tile-parent" });
    const fine = await run(name, input, ok(pageHtml(withState)));
    assert.equal(fine.output.status, "ok", name);
  }
});

test("blank names are treated as missing, and ids, urls and timestamps are bounded", async () => {
  const blank = await run("search_restaurants", { query: "pizza" }, ok(pageHtml(searchState([searchRestaurant(1, "   "), searchRestaurant(2, "Real Name")]))));
  assert.deepEqual(blank.output.restaurants.map(r => r.name), ["Real Name"]);
  assert.equal((await run("get_restaurant", { restaurant_id: 555 }, ok(pageHtml(profileState(555, {}, {}, { name: "   " }))))).output.error_kind, "site_changed");
  assert.equal((await run("get_reviews", { restaurant_id: 555 }, ok(pageHtml(profileState(555, {}, {}, { name: "   " }))))).output.error_kind, "site_changed");
  const longPath = "https://www.opentable.com/r/" + "p".repeat(400);
  const search = await run("search_restaurants", { query: "pizza" }, ok(pageHtml(searchState([searchRestaurant(3, "Long Url", { urls: { profileLink: { link: longPath } } })]))));
  assert.equal(search.output.restaurants[0].url, "https://www.opentable.com/restaurant/profile/3", "an over-long profile link falls back to the id URL");
  const state = profileState(555, { metaLinks: { canonical: longPath } }, { reviewSearchResults: { reviews: [review("I".repeat(5000)), review("R-DATES", { dinedDateTime: "2026-09-26T16:30:00." + "0".repeat(3000) + "-04:00", submittedDateTime: "2026-09-27T16:36:29.123456789Z" }), review("R-BAD", { dinedDateTime: "2026-09-26 16:30", submittedDateTime: "yesterday" })], totalPages: 1, page: 1, totalCount: 3 } });
  const prof = await run("get_restaurant", { restaurant_id: 555 }, ok(pageHtml(state)));
  assert.equal(prof.output.url, "https://www.opentable.com/restaurant/profile/555", "an over-long canonical falls back to the id URL");
  const revs = await run("get_reviews", { restaurant_id: 555 }, ok(pageHtml(state)));
  assert.equal(revs.output.url, "https://www.opentable.com/restaurant/profile/555");
  assert.equal(revs.output.reviews[0].review_id.length, 100);
  assert.equal(revs.output.reviews[0].dined_at, "2026-09-26T16:30:00-04:00");
  assert.equal(revs.output.reviews[1].dined_at, null, "an over-long fractional part is dropped");
  assert.equal(revs.output.reviews[1].submitted_at, "2026-09-27T16:36:29.123456789Z");
  assert.deepEqual([revs.output.reviews[2].dined_at, revs.output.reviews[2].submitted_at], [null, null]);
  for (const [name, output] of [["get_restaurant", prof.output], ["get_reviews", revs.output], ["search_restaurants", search.output]]) assertConforms(name, output);
});

test("get_reviews requires the returned page to equal the requested page and holds at most 10 reviews", async () => {
  const mismatch = profileState(555, {}, { reviewSearchResults: { reviews: [review("R1")], totalPages: 5, page: 1, totalCount: 50 } });
  const wrongPage = await run("get_reviews", { restaurant_id: 555, page: 3 }, ok(pageHtml(mismatch)));
  assert.equal(wrongPage.output.status, "no_results", "a returned page that differs from the requested one is not page data");
  const tooMany = profileState(555, {}, { reviewSearchResults: { reviews: Array.from({ length: 11 }, (_, i) => review("R" + i)), totalPages: 5, page: 2, totalCount: 50 } });
  const oversized = await run("get_reviews", { restaurant_id: 555, page: 2 }, ok(pageHtml(tooMany)));
  assert.equal(oversized.output.status, "no_results", "a page holding more than the page size is not trusted");
  const exactlyTen = profileState(555, {}, { reviewSearchResults: { reviews: Array.from({ length: 10 }, (_, i) => review("R" + i)), totalPages: 5, page: 2, totalCount: 50 } });
  const ten = await run("get_reviews", { restaurant_id: 555, page: 2 }, ok(pageHtml(exactlyTen)));
  assert.equal(ten.output.status, "ok");
  assert.equal(ten.output.reviews.length, 10);
});

test("profile arrays and total UTF-8 output are bounded", async () => {
  const values = Array.from({ length: 70 }, (_, i) => "Value " + i);
  const state = profileState(555, {}, {}, { cuisines: values.map(name => ({ name })), paymentOptions: values, additionalDetails: values });
  state.restaurantProfile.restaurant.statistics.reviews.awards = values.map(name => ({ name, location: "Fake" }));
  state.restaurantProfile.restaurant.statistics.reviews.categories = values.map(name => ({ category: { name } }));
  const out = await run("get_restaurant", { restaurant_id: 555 }, ok(pageHtml(state)));
  for (const field of ["cuisines", "payment_options", "amenities", "tags", "awards"]) assert.equal(out.output[field].length, 50);
  state.restaurantProfile.menus.menuData = [{ title: "Menu", sections: [{ title: "Section", items: Array.from({ length: 100 }, () => ({ title: "🍕".repeat(100), description: "🍕".repeat(250), price: "🍕".repeat(150) })) }] }];
  const oversized = await run("get_restaurant", { restaurant_id: 555, include_menus: true }, ok(pageHtml(state)));
  assert.equal(oversized.output.error_kind, "site_changed");
});

test("invalid search dates fail before fetch and impossible review timestamps become null", async () => {
  for (const date of ["2099-13-45", "2099-02-30", "2099-00-01"]) {
    const out = await run("search_restaurants", { query: "pizza Chicago", date }, ok(pageHtml(searchState([]))));
    assert.equal(out.output.error_kind, "invalid_input");
    assert.equal(out.calls.fetch.length, 0);
  }
  const reviews = [review("D1", { dinedDateTime: "2099-02-30T19:00:00Z", submittedDateTime: "2099-10-10T24:00:00Z" })];
  const state = profileState(555, {}, { reviewSearchResults: { reviews, totalPages: 1, page: 1, totalCount: 1 } });
  const out = await run("get_reviews", { restaurant_id: 555 }, ok(pageHtml(state)));
  assert.equal(out.output.reviews[0].dined_at, null);
  assert.equal(out.output.reviews[0].submitted_at, null);
});

test("retained reads honor cancellation before requests and during a failed fetch", async () => {
  for (const [name, input] of [["search_restaurants", { query: "pizza Chicago" }], ["get_restaurant", { restaurant_id: 555 }], ["get_reviews", { restaurant_id: 555 }]]) {
    const before = await run(name, input, { signal: { aborted: true }, ...ok(pageHtml(profileState(555))) });
    assert.equal(before.output.error_kind, "canceled");
    assert.equal(before.calls.fetch.length, 0);
    assertConforms(name, before.output);
    const signal = { aborted: false };
    const during = await run(name, input, { signal, respond: () => { signal.aborted = true; return new Error("Abort"); } });
    assert.equal(during.output.error_kind, "canceled");
    assert.equal(during.calls.fetch.length, 1);
    assert.equal(during.calls.fetch[0].init.signal, signal);
    assertConforms(name, during.output);
  }
});

test("the tools never navigate, click, submit, or send anything but page GETs", async () => {
  for (const [name, input, state] of [["search_restaurants", { query: "pizza chicago" }, searchState([searchRestaurant(1, "A")])], ["get_restaurant", { restaurant_id: 555 }, profileState(555)], ["get_reviews", { restaurant_id: 555 }, profileState(555)]]) {
    const { calls } = await run(name, input, ok(pageHtml(state)));
    assert.equal(calls.fetch.length, 1);
    assert.equal(calls.fetch[0].init.method, undefined, "requests are plain GETs");
    assert.equal(calls.fetch[0].init.body, undefined);
    assert.ok(calls.fetch[0].path.startsWith("/"), "requests stay same-origin");
    assert.ok(!/restref|booking|authenticate|dapi|user/.test(calls.fetch[0].path), "no booking, auth, GraphQL or account paths");
  }
});
