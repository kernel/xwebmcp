import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";

const names = ["get_availability", "prepare_reservation", "get_account_summary", "list_saved_restaurants"];
const definitions = Object.fromEntries(names.map(name => [name, runInNewContext(`(${readFileSync(new URL(`../domains/opentable.com/${name}.js`, import.meta.url), "utf8")})`)[0]]));
const plain = v => JSON.parse(JSON.stringify(v));
const origin = "https://www.opentable.com";
const query = { restaurant_id: 555, date: "2099-10-10", time: "19:00", party_size: 2 };
const account = { expected_account_email: "authorized@example.test" };
const hash = "a".repeat(64);
const documentQuery = name => `var q={kind:"Document",definitions:[{kind:"OperationDefinition",operation:"query",name:{kind:"Name",value:"${name}"}}]};q.documentId="${hash}";`;
const profile = { restaurantProfile: { restaurant: { restaurantId: 555, name: "Fabricated Bistro", email: "private@example.test" }, availabilityToken: "PRIVATE-TOKEN" } };
const dashboard = { authentication: { isAuthenticated: true }, header: { userProfile: { email: account.expected_account_email, points: 1200, eligibleToEarnPoints: true, firstName: "Private Name" } }, diningDashboard: { upcomingReservations: [{ private: "PRIVATE-RESERVATION" }], pastReservations: [], upcomingInvites: [], pastInvites: [], nextPastReservationsUrl: null, hasError: false, sift: "PRIVATE-SIFT" } };
const html = (state, entry = "restprofilepage-FAKE") => `<script id="primary-window-vars">${JSON.stringify({ windowVariables: { __CSRF_TOKEN__: "PRIVATE-CSRF", __INITIAL_STATE__: state } })}</script><script src="/static/cfe/15/js/${entry}.js"></script>`;
const slot = extra => ({ isAvailable: true, type: "Standard", timeOffsetMinutes: 0, attributes: ["default", "bar"], isMandatory: false, isMandatoryBySeating: [], pointsValue: 100, slotHash: "PRIVATE-HASH", slotAvailabilityToken: "PRIVATE-SLOT", ...extra });
const availability = (slots = [slot()], extra = {}) => ({ data: { availability: [{ restaurantId: 555, availabilityDays: [{ dayOffset: 0, slots, noTimesReasons: [], ...extra }] }] } });
function conforms(schema, value) {
  if (schema.const !== undefined && schema.const !== value) return false;
  if (schema.enum && !schema.enum.includes(value)) return false;
  if (schema.oneOf && schema.oneOf.filter(s => conforms(s, value)).length !== 1) return false;
  if (schema.type && ![schema.type].flat().some(t => t === "null" ? value === null : t === "array" ? Array.isArray(value) : t === "integer" ? Number.isInteger(value) : t === "object" ? value !== null && typeof value === "object" && !Array.isArray(value) : typeof value === t)) return false;
  if (Array.isArray(value) && (value.length > (schema.maxItems ?? Infinity) || value.length < (schema.minItems ?? 0) || schema.items && value.some(x => !conforms(schema.items, x)))) return false;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    if (schema.required?.some(k => !(k in value))) return false;
    if (schema.additionalProperties === false && Object.keys(value).some(k => !schema.properties?.[k])) return false;
    if (schema.properties && Object.entries(value).some(([k, v]) => schema.properties[k] && !conforms(schema.properties[k], v))) return false;
  }
  if (typeof value === "string" && (value.length > (schema.maxLength ?? Infinity) || value.length < (schema.minLength ?? 0) || schema.pattern && !new RegExp(schema.pattern).test(value))) return false;
  if (typeof value === "number" && (value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity))) return false;
  return true;
}
async function run(name, input, options = {}) {
  const requests = [];
  const signal = options.signal;
  let dashboards = 0;
  const fetch = async (path, init = {}) => {
    requests.push({ path, ...init });
    let body, status = options.status ?? 200;
    if (options.respond) return options.respond(path, init, requests.length);
    if (path === "/user/dining-dashboard") body = html(dashboards++ && options.after ? options.after : options.dashboard ?? dashboard);
    else if (path.startsWith("/restaurant/profile/")) body = options.profileHtml ?? html(options.profile ?? profile);
    else if (path === "/user/favorites") body = html({}, "user-favorites-FAKE");
    else if (path.startsWith("/static/")) body = options.module ?? documentQuery(name === "list_saved_restaurants" ? "UserWishlist" : "RestaurantsAvailability");
    else if (path.includes("RestaurantsAvailability")) body = JSON.stringify(options.availability ?? availability());
    else if (path.includes("UserWishlist")) body = JSON.stringify(options.wishlist ?? { data: { userWishlist: null } });
    else throw new Error("Unexpected request: " + path);
    if (options.onRequest) options.onRequest(path, signal);
    return { status, ok: status >= 200 && status < 300, text: async () => body };
  };
  const now = options.now === undefined ? null : Date.parse(options.now);
  const clock = now === null ? Date : class extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } };
  const execute = runInNewContext(`(${definitions[name].execute.toString()})`, { window: { location: { origin: options.origin ?? origin } }, document: { title: options.title ?? "OpenTable", querySelector: () => options.challenge ? {} : null }, URL, URLSearchParams, fetch, Date: clock, sessionStorage: options.storage });
  const result = plain(await execute(input, { signal }));
  assert.ok(conforms(definitions[name].tool.outputSchema, result), JSON.stringify(result));
  return { result, requests };
}
const failure = async (name, input, kind, options = {}, requestCount) => {
  const out = await run(name, input, options);
  assert.equal(out.result.error_kind, kind);
  if (requestCount !== undefined) assert.equal(out.requests.length, requestCount);
  return out;
};

test("definitions are page-local read tools; namespace has no booking or fake approval execution", () => {
  for (const name of names) {
    assert.equal(definitions[name].kind, "page");
    assert.deepEqual(plain(definitions[name].match.url_patterns), [origin + "/*"]);
    assert.equal(definitions[name].tool.annotations.readOnlyHint, true);
    assert.equal(definitions[name].tool.inputSchema.additionalProperties, false);
  }
  const registry = JSON.parse(readFileSync(new URL("../registry.json", import.meta.url)));
  const siteNames = registry.tools.filter(t => t.domain === "opentable.com").map(t => t.tool);
  assert.equal(siteNames.length, 7);
  assert.ok(!siteNames.some(n => /book_reservation|cancel_reservation|notify|set_favorite/.test(n)));
});

test("all malformed inputs are rejected before any page or network interaction", async () => {
  for (const name of names) {
    const valid = name.includes("account") || name.includes("saved") ? account : query;
    for (const bad of [null, [], "bad", {}, { ...valid, confirmed: true }, { ...valid, extra: "x" }]) await failure(name, bad, "invalid_input", {}, 0);
  }
  for (const name of ["get_availability", "prepare_reservation"]) {
    for (const [key, values] of Object.entries({ restaurant_id: [0, -1, 1.5, "555", 2147483648], date: ["2026-13-45", "2099-02-30", "2020-01-01", "x", 2099], time: ["24:00", "19:60", 19], party_size: [0, 21, "2", 1.5] })) for (const value of values) await failure(name, { ...query, [key]: value }, "invalid_input", {}, 0);
  }
  for (const bad of [-1, 121, "60", 1.5]) await failure("get_availability", { ...query, window_minutes: bad }, "invalid_input", {}, 0);
  await failure("prepare_reservation", { ...query, seating_type: "private" }, "invalid_input", {}, 0);
  for (const name of ["get_account_summary", "list_saved_restaurants"]) for (const bad of ["", "x", "a b@example.test", 7, "x".repeat(255)]) await failure(name, { expected_account_email: bad }, "invalid_input", {}, 0);
  for (const page of [0, 201, "1", 1.5]) await failure("list_saved_restaurants", { ...account, page }, "invalid_input", {}, 0);
});

test("wrong host, challenge and cancellation guards issue zero requests", async () => {
  for (const name of names) {
    const valid = name.includes("account") || name.includes("saved") ? account : query;
    await failure(name, valid, "wrong_page", { origin: "https://example.test" }, 0);
    if (name !== "get_availability" && name !== "prepare_reservation") {
      await failure(name, valid, "challenge", { title: "Access Denied" }, 0);
      await failure(name, valid, "challenge", { challenge: true }, 0);
    }
    await failure(name, valid, "canceled", { signal: { aborted: true } }, 0);
  }
});

test("availability and preparation still read from a document OpenTable answered with 'Access Denied'", async () => {
  const out = await run("get_availability", query, { title: "Access Denied", challenge: true });
  assert.equal(out.result.status, "ok");
  const prepared = await run("prepare_reservation", { ...query, seating_type: "bar" }, { title: "Access Denied", challenge: true });
  assert.equal(prepared.result.status, "prepared");
  await failure("prepare_reservation", { ...query, seating_type: "bar" }, "challenge", { title: "Access Denied", profileHtml: "<title>Access Denied</title>" });
});

test("availability only sends the observed read query and never returns credentials or raw state", async () => {
  const out = await run("get_availability", query);
  assert.equal(out.result.status, "ok");
  assert.deepEqual(out.result.slots[0], { date: query.date, time: "19:00", seating_types: ["default", "bar"], points: 100, requires_experience: false });
  const req = out.requests.at(-1);
  const body = JSON.parse(req.body);
  assert.equal(body.operationName, "RestaurantsAvailability");
  assert.equal(req.method, "POST");
  assert.equal(body.variables.forwardDays, 0);
  assert.deepEqual(body.variables.requireTypes, ["Standard"]);
  assert.deepEqual(body.variables.privilegedAccess, []);
  assert.equal(req.headers["x-csrf-token"], "PRIVATE-CSRF");
  assert.ok(out.requests.every(r => r.credentials === "same-origin" && r.redirect === "error"));
  assert.ok(!JSON.stringify(out.result).includes("PRIVATE"));
  assert.ok(!JSON.stringify(out.result).includes("private@example"));
});

test("availability time offsets, unsupported inventory, no results and response bounds", async () => {
  const out = await run("get_availability", { ...query, window_minutes: 60 }, { availability: availability([slot({ timeOffsetMinutes: -30 }), slot({ timeOffsetMinutes: 45 }), slot({ isAvailable: false }), slot({ type: "Experience" })]) });
  assert.deepEqual(out.result.slots.map(s => s.time), ["18:30", "19:45"]);
  const none = await run("get_availability", query, { availability: availability([], { noTimesReasons: ["TooFarInAdvance"] }) });
  assert.equal(none.result.status, "no_results");
  assert.deepEqual(none.result.no_times_reasons, ["TooFarInAdvance"]);
  const bounded = await run("get_availability", query, { availability: availability(Array.from({ length: 250 }, () => slot({ attributes: Array(30).fill("default") })), { noTimesReasons: Array(30).fill("x".repeat(500)) }) });
  assert.equal(bounded.result.slots.length, 50);
  assert.equal(bounded.result.slots[0].seating_types.length, 10);
  assert.equal(bounded.result.no_times_reasons.length, 10);
  assert.equal(bounded.result.no_times_reasons[0].length, 100);
  assert.equal(bounded.result.truncated, true);
  for (const bad of [{ timeOffsetMinutes: 1.5 }, { attributes: null }, { isMandatory: undefined }]) await failure("get_availability", query, "site_changed", { availability: availability([slot(bad)]) });
  const narrow = await run("get_availability", { ...query, window_minutes: 30 }, { availability: availability([slot(), slot({ timeOffsetMinutes: 60 }), slot({ timeOffsetMinutes: -121 })]) });
  assert.equal(narrow.result.status, "ok");
  assert.deepEqual(narrow.result.slots.map(s => s.time), ["19:00"]);
  assert.equal(JSON.parse(narrow.requests.at(-1).body).variables.forwardMinutes, 30);
  const wide = await run("prepare_reservation", query, { availability: availability([slot(), slot({ timeOffsetMinutes: 150 })]) });
  assert.equal(wide.result.status, "prepared");
  const wrong = availability(); wrong.data.availability[0].restaurantId = 666;
  await failure("get_availability", query, "site_changed", { availability: wrong });
  await failure("get_availability", query, "site_error", { availability: { errors: [{ message: "PRIVATE" }], data: availability().data } });
});

test("query discovery is bounded, uses only first-party static imports and never executes module text", async () => {
  const source = 'import"/static/cfe/15/js/chunk-NEXT.js";import"https://evil.example/SECRET.js";globalThis.mutated=true;';
  let staticReads = 0;
  const out = await run("get_availability", query, { respond: async path => ({ status: 200, ok: true, text: async () => path.startsWith("/restaurant/") ? html(profile) : path.startsWith("/static/") ? ++staticReads === 1 ? source : documentQuery("RestaurantsAvailability") : JSON.stringify(availability()) }) });
  assert.equal(out.result.status, "ok");
  assert.equal(staticReads, 2);
  assert.ok(out.requests.every(r => !r.path.includes("evil")));
  await failure("get_availability", query, "site_changed", { module: documentQuery("UserWishlist") });
  await failure("get_availability", query, "site_changed", { module: `kind:"OperationDefinition",operation:"query",name:{kind:"Name",value:"RestaurantsAvailability"};kind:"OperationDefinition",operation:"mutation",name:{kind:"Name",value:"CreateHold"};q.documentId="${hash}"` });
});

test("preparation requires the exact time and seating, does not substitute, and stays non-executing", async () => {
  const out = await run("prepare_reservation", { ...query, seating_type: "bar" });
  assert.equal(out.result.status, "prepared");
  assert.deepEqual(out.result.selected_slot.seating_types, ["bar"]);
  assert.equal(out.result.account_verified, false);
  assert.equal(out.result.terms_status, "not_checked");
  assert.equal(out.result.hold_created, false);
  assert.equal(out.result.reservation_created, false);
  assert.equal(out.result.execution_blocker, "trusted_human_approval_unavailable");
  assert.match(out.result.handoff_url, /^https:\/\/www\.opentable\.com\/restaurant\/profile\/555\?/);
  for (const options of [{ availability: availability([slot({ timeOffsetMinutes: 15 })]) }, { availability: availability([slot({ attributes: ["bar"] })]) }]) {
    const unavailable = await run("prepare_reservation", query, options);
    assert.equal(unavailable.result.status, "unavailable");
    assert.equal(unavailable.result.selected_slot, null);
  }
  await failure("prepare_reservation", query, "gated", { availability: availability([slot({ isMandatory: true })]) });
  await failure("prepare_reservation", query, "gated", { availability: availability([slot({ isMandatoryBySeating: [{ tableCategory: "bar", isMandatory: true }] })]) });
  assert.ok(out.requests.every(r => !/booking|hold|reservation\/create|notify/i.test(r.path)));
});

test("unknown seating-specific experience data fails closed", async () => {
  for (const name of ["get_availability", "prepare_reservation"]) {
    for (const value of [undefined, null, "unknown", [{}], [{ isMandatory: "unknown" }]]) {
      await failure(name, query, "site_changed", { availability: availability([slot({ isMandatoryBySeating: value })]) });
    }
  }
});

test("challenge words inside valid profile and account state are not challenge pages", async () => {
  for (const marker of ["sec-if-cpt-container", "sec-bc-tile-parent"]) {
    const p = { restaurantProfile: { ...profile.restaurantProfile, restaurant: { ...profile.restaurantProfile.restaurant, name: marker } } };
    for (const name of ["get_availability", "prepare_reservation"]) {
      const out = await run(name, query, { profile: p });
      assert.equal(out.result.status, name === "get_availability" ? "ok" : "prepared");
    }
    const d = { ...dashboard, header: { userProfile: { ...dashboard.header.userProfile, firstName: marker } } };
    assert.equal((await run("get_account_summary", account, { dashboard: d })).result.status, "ok");
    assert.equal((await run("list_saved_restaurants", account, { dashboard: d })).result.status, "no_results");
  }
});

test("exact preparation searches beyond the display cap and refuses incomplete oversized inventory", async () => {
  const slots = Array.from({ length: 50 }, () => slot({ timeOffsetMinutes: -15 }));
  slots.push(slot());
  const out = await run("prepare_reservation", query, { availability: availability(slots) });
  assert.equal(out.result.status, "prepared");
  assert.equal(out.result.selected_slot.time, query.time);
  await failure("prepare_reservation", query, "site_changed", { availability: availability(Array.from({ length: 201 }, () => slot())) });
});

test("account summary is grounded in containers, does not return private items, and rejects wrong accounts", async () => {
  const out = await run("get_account_summary", account);
  assert.equal(out.result.points, 1200);
  assert.equal(out.result.upcoming_reservation_count, 1);
  assert.equal(out.result.past_reservation_count_on_page, 0);
  assert.equal(out.result.has_more_past, false);
  assert.ok(!JSON.stringify(out.result).includes("PRIVATE"));
  assert.ok(!JSON.stringify(out.result).includes("example.test"));
  for (const name of ["get_account_summary", "list_saved_restaurants"]) {
    await failure(name, { expected_account_email: "different@example.test" }, "wrong_account", {}, 1);
    await failure(name, account, "login_required", { dashboard: { ...dashboard, authentication: { isAuthenticated: false } } }, 1);
    await failure(name, account, "site_error", { dashboard: { ...dashboard, diningDashboard: { ...dashboard.diningDashboard, hasError: true } } }, 1);
  }
  await failure("get_account_summary", account, "site_changed", { dashboard: { ...dashboard, diningDashboard: { ...dashboard.diningDashboard, upcomingReservations: null } } });
});

test("Favorites uses observed rid schema with paging and validates account again before release", async () => {
  const restaurants = Array.from({ length: 101 }, (_, i) => ({ rid: i + 1, private: "PRIVATE" }));
  const out = await run("list_saved_restaurants", { ...account, page: 2 }, { wishlist: { data: { userWishlist: { restaurants } } } });
  assert.equal(out.result.status, "ok");
  assert.equal(out.result.total_count, 101);
  assert.deepEqual(out.result.restaurant_ids, Array.from({ length: 50 }, (_, i) => i + 51));
  assert.equal(out.result.has_more, true);
  const body = JSON.parse(out.requests.find(r => r.method === "POST").body);
  assert.equal(body.operationName, "UserWishlist");
  assert.deepEqual(body.variables, { wishlistName: "Favorites", gpid: 0 });
  assert.equal(out.requests.filter(r => r.path === "/user/dining-dashboard").length, 2);
  assert.ok(!JSON.stringify(out.result).includes("PRIVATE"));
  const empty = await run("list_saved_restaurants", account);
  assert.equal(empty.result.status, "no_results");
  assert.equal(empty.result.total_count, 0);
  const changed = { ...dashboard, header: { userProfile: { ...dashboard.header.userProfile, email: "changed@example.test" } } };
  await failure("list_saved_restaurants", account, "wrong_account", { after: changed });
  await failure("list_saved_restaurants", account, "site_changed", { wishlist: { data: {} } });
  await failure("list_saved_restaurants", account, "site_changed", { wishlist: { data: { userWishlist: { restaurants: [{ rid: "555" }] } } } });
  await failure("list_saved_restaurants", account, "site_error", { wishlist: { errors: [{ message: "PRIVATE" }], data: { userWishlist: null } } });
});

test("network failures, challenges and aborts are explicit, with no automatic retry", async () => {
  for (const name of names) {
    const valid = name.includes("account") || name.includes("saved") ? account : query;
    await failure(name, valid, "rate_limited", { status: 429 }, 1);
    await failure(name, valid, "challenge", { status: 403 }, 1);
    if (name === "get_availability" || name === "prepare_reservation") {
      const refused = await run(name, valid, { status: 403 });
      assert.match(refused.result.error_message, /open https:\/\/www\.opentable\.com\/restaurant\/profile\/\d+\?dateTime=.*&covers=\d+ and read its booking widget/, name + " points at the restaurant's page");
    }
    await failure(name, valid, "site_error", { respond: () => { throw new Error("https://secret.example/PRIVATE"); } }, 1);
    const signal = { aborted: false };
    await failure(name, valid, "canceled", { signal, respond: () => { signal.aborted = true; throw new Error("Abort"); } }, 1);
  }
});

test("a restaurant-local date is not judged past by the UTC calendar", async () => {
  // 02:00 UTC on Oct 23 is still the evening of Oct 22 across the Americas.
  const evening = { now: "2026-10-23T02:00:00Z" };
  for (const name of ["get_availability", "prepare_reservation"]) {
    const tonight = await run(name, { ...query, date: "2026-10-22", time: "20:00" }, evening);
    assert.notEqual(tonight.result.error_kind, "invalid_input", name);
    assert.ok(tonight.requests.length > 0, name + " asks OpenTable about tonight");
    await failure(name, { ...query, date: "2026-10-21", time: "20:00" }, "invalid_input", evening, 0);
    const pacific = { ...evening, profile: { restaurantProfile: { ...profile.restaurantProfile, restaurant: { ...profile.restaurantProfile.restaurant, timeZone: { code: "PST", offsetInMinutes: -420 } } } } };
    assert.notEqual((await run(name, { ...query, date: "2026-10-22", time: "20:00" }, pacific)).result.error_kind, "invalid_input", name);
    // The restaurant's own offset decides when the day before UTC's is already past there.
    const tokyo = { ...evening, profile: { restaurantProfile: { ...profile.restaurantProfile, restaurant: { ...profile.restaurantProfile.restaurant, timeZone: { code: "JST", offsetInMinutes: 540 } } } } };
    await failure(name, { ...query, date: "2026-10-22", time: "20:00" }, "invalid_input", tokyo, 1);
    // Without an offset, the day before UTC's is past once it has ended at UTC-12.
    await failure(name, { ...query, date: "2026-10-22", time: "20:00" }, "invalid_input", { now: "2026-10-23T13:00:00Z" }, 1);
  }
});

const memoryStorage = () => { const m = new Map(); return { map: m, getItem: k => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) }; };

test("availability keeps the query id for the entry module, so a later read skips the modules, and drops it when the query fails", async () => {
  const storage = memoryStorage();
  const modules = r => r.requests.filter(q => q.path.startsWith("/static/")).length;
  const first = await run("get_availability", query, { storage });
  assert.equal(first.result.status, "ok"); assert.equal(modules(first), 1);
  assert.deepEqual([...storage.map.values()], [hash]);
  const second = await run("prepare_reservation", query, { storage });
  assert.equal(second.result.status, "prepared"); assert.equal(modules(second), 0);
  assert.equal(JSON.parse(second.requests.at(-1).body).extensions.persistedQuery.sha256Hash, hash);
  await failure("get_availability", query, "site_error", { storage, availability: { errors: [{ message: "PersistedQueryNotFound" }] } });
  assert.equal(storage.map.size, 0, "a failed query does not keep the id");
  storage.setItem("opentable.com.restaurants-availability-document.v1:/static/cfe/15/js/restprofilepage-FAKE.js", "not-a-hash");
  assert.equal(modules(await run("get_availability", query, { storage })), 1, "a malformed kept id is ignored");
  const newBuild = await run("get_availability", query, { storage, profileHtml: html(profile, "restprofilepage-NEWER") });
  assert.equal(modules(newBuild), 1, "another build's entry module is read again");
});

test("availability leaves out slots beyond the window before checking their shape, and is not truncated at exactly 50 slots", async () => {
  const out = await run("get_availability", { ...query, window_minutes: 30 }, { availability: availability([slot(), slot({ timeOffsetMinutes: 90, attributes: null })]) });
  assert.equal(out.result.status, "ok"); assert.deepEqual(out.result.slots.map(s => s.time), ["19:00"]);
  const fifty = await run("get_availability", query, { availability: availability(Array.from({ length: 50 }, () => slot())) });
  assert.equal(fifty.result.slots.length, 50); assert.equal(fifty.result.truncated, false);
});
