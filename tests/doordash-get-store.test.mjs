import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";

// Fixture tests for doordash.com/get_store. The page (location, document, fetch) is stubbed;
// nothing here contacts the live site and every store, id, address and cookie is fabricated.
const source = readFileSync(new URL("../domains/doordash.com/get_store.js", import.meta.url), "utf8");
const registry = JSON.parse(readFileSync(new URL("../registry.json", import.meta.url), "utf8"));
const plain = value => JSON.parse(JSON.stringify(value));
const HOME = "https://www.doordash.com";
const HEADER_STREET = "1 Fabricated Header Street, Apt 9";

function conforms(schema, value) {
  if (schema.anyOf && !schema.anyOf.some(s => conforms(s, value))) return false;
  if (schema.oneOf && schema.oneOf.filter(s => conforms(s, value)).length !== 1) return false;
  if ("const" in schema && value !== schema.const) return false;
  if (schema.enum && !schema.enum.includes(value)) return false;
  if (schema.type && ![schema.type].flat().some(type => {
    if (type === "null") return value === null;
    if (type === "integer") return Number.isInteger(value);
    if (type === "array") return Array.isArray(value);
    if (type === "object") return value !== null && typeof value === "object" && !Array.isArray(value);
    return typeof value === type;
  })) return false;
  if (Array.isArray(value)) {
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
  if (typeof value === "number" && (value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity))) return false;
  return true;
}

// --- fabricated site data ------------------------------------------------------------------------

const week = (slot, only) => ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY"].slice(0, only ?? 7)
  .map(dayOfWeek => ({ dayOfWeek, timeSlotList: [slot] }));

const feed = (overrides = {}) => ({
  storeHeader: {
    id: "1001", name: "Fabricated Noodle House", description: "Noodles", timezone: "US/Eastern", priceRange: 2, priceRangeDisplayString: "$$",
    offersDelivery: true, offersPickup: true, offersGroupOrder: true, offersCatering: false, offersScheduling: true, isConvenience: false, isDashpassPartner: true,
    address: { lat: "40.5", lng: "-73.5", city: "Testville", state: "NY", street: "5 Test Road" },
    businessTags: [{ name: "Noodles" }, { name: "Asian" }],
    ratings: { numRatings: 1234, numRatingsDisplayString: "(1k+)", averageRating: 4.6, isNewlyAdded: false },
    deliveryFeeLayout: { title: "$0 delivery fee on $12+", subtitle: "pricing & fees", isSurging: false, displayDeliveryFee: "$0 delivery fee over $12" },
    asapStatus: { displayUnavailableReason: { title: "" } },
    status: {
      delivery: { isAvailable: true, minutes: "27 - 37", unavailableReason: "", isTooFarFromConsumer: false },
      pickup: { isAvailable: true, minutes: "19 - 29", unavailableReason: "" }
    },
    ...overrides.storeHeader
  },
  mxInfo: {
    operationInfo: {
      operationStatusInfo: { description: "Accepting DoorDash orders until 9 PM", operationStatus: "OPEN" },
      storeOperationHourInfo: { operationSchedule: week("10 AM - 10 PM") },
      doordashOperationHourInfo: { operationSchedule: week("10 AM - 9 PM") }
    }
  },
  menuBook: { id: "5001", name: "All Day", displayOpenHours: "10:00 AM - 9:00 PM", menuList: [{ id: "5001", name: "All Day", displayOpenHours: "10:00 AM - 9:00 PM" }, { id: "5002", name: "Lunch", displayOpenHours: "11:00 AM - 3:00 PM" }] },
  ...overrides.rest
});
const ok = data => ({ status: 200, json: { data: { storepageFeed: data } } });

function harness(options = {}) {
  const calls = [];
  const responder = options.respond ?? (() => ok(feed()));
  const stubFetch = async (url, init) => {
    calls.push({ url, init: { ...init, body: init.body ? JSON.parse(init.body) : undefined } });
    if (options.fetchError) throw options.fetchError;
    const reply = responder(url, init);
    const body = reply.body ?? JSON.stringify(reply.json);
    return { status: reply.status, ok: reply.status >= 200 && reply.status < 300, text: async () => body };
  };
  const button = options.button === undefined ? { innerText: HEADER_STREET } : options.button;
  const signalSpy = { timeouts: [], anys: 0 };
  const SpiedAbortSignal = { timeout: ms => { signalSpy.timeouts.push(ms); return AbortSignal.timeout(ms); }, any: list => { signalSpy.anys += 1; return AbortSignal.any(list); } };
  const context = {
    location: { origin: options.origin ?? HOME, pathname: "/home" },
    document: {
      cookie: options.cookie ?? "a=1; csrf_token=fabricated-csrf; dd_cx_logged_in=true",
      querySelector: selector => selector === "[data-testid='addressTextButton']" ? button : selector === "[data-testid='LandingPageAddressSearch']" && options.landing ? {} : null
    },
    fetch: stubFetch, AbortSignal: SpiedAbortSignal, JSON, Object, Array, Number, String, Boolean, Math, Promise, Error, RegExp, isFinite
  };
  const [definition] = runInNewContext(`(${source})`, context);
  return { definition, calls, signalSpy, run: (input, signal) => definition.execute(input, signal ? { signal } : undefined) };
}
const validOutput = (definition, value) => conforms(definition.tool.outputSchema, value);

// --- contract ------------------------------------------------------------------------------------

test("single page definition, narrowed to www, agrees with the registry", () => {
  const { definition } = harness();
  assert.equal(definition.kind, "page");
  assert.equal(definition.tool.name, "get_store");
  assert.deepEqual(plain(definition.match.url_patterns), ["https://www.doordash.com/*"]);
  const entry = registry.tools.find(t => t.domain === "doordash.com" && t.tool === "get_store");
  assert.ok(entry, "registry entry exists");
  assert.equal(entry.kind, "page");
  assert.deepEqual(entry.url_patterns, plain(definition.match.url_patterns));
  assert.equal(entry.file, "domains/doordash.com/get_store.js");
  assert.equal(definition.tool.annotations.readOnlyHint, true);
  assert.ok(definition.tool.outputSchema && definition.tool.inputSchema);
});

test("source has no import, require, Node globals or trailing semicolon, and execute is self-contained", () => {
  assert.doesNotMatch(source, /\brequire\s*\(|\bimport\s|\bBuffer\b|\bprocess\./);
  assert.doesNotMatch(source.trimEnd(), /;$/);
  // The runtime re-creates a page tool's execute in the page from its source text alone.
  const { definition } = harness();
  const stubs = { location: { origin: HOME }, document: { cookie: "", querySelector: () => null }, fetch: async () => ({ status: 500, ok: false, text: async () => "" }), AbortSignal };
  const recreated = runInNewContext(`(${definition.execute.toString()})`, stubs);
  assert.equal(typeof recreated, "function");
});

// --- success paths -------------------------------------------------------------------------------

test("restaurant: maps the allowlisted fields and issues exactly one read", async () => {
  const { definition, calls, run } = harness();
  const out = plain(await run({ store_id: "1001" }));
  assert.ok(validOutput(definition, out), JSON.stringify(out));
  assert.equal(out.status, "ok");
  assert.equal(out.store_id, "1001");
  assert.equal(out.url, "https://www.doordash.com/store/1001/");
  assert.equal(out.store_type, "restaurant");
  assert.deepEqual(out.cuisines, ["Noodles", "Asian"]);
  assert.deepEqual(out.price_range, { level: 2, text: "$$" });
  assert.deepEqual(out.rating, { average: 4.6, count: 1234, count_text: "(1k+)", is_new: false });
  assert.deepEqual(out.address, { street: "5 Test Road", city: "Testville", state: "NY", latitude: 40.5, longitude: -73.5 });
  assert.equal(out.offers.dashpass_partner, true);
  assert.equal(out.operation_status, "OPEN");
  assert.equal(out.hours.store.length, 7);
  assert.deepEqual(out.hours.doordash_orders[0], { day: "MONDAY", slots: ["10 AM - 9 PM"] });
  assert.equal(out.delivery_context.basis, "selected_address");
  assert.equal(out.delivery_context.signed_in, true);
  assert.equal(out.delivery.available, true);
  assert.equal(out.delivery.estimate_minutes, "27 - 37");
  assert.equal("distance" in out.delivery_context, false);
  assert.deepEqual(out.delivery.fee_display, { title: "$0 delivery fee on $12+", subtitle: "pricing & fees", text: "$0 delivery fee over $12", is_surging: false });
  assert.equal(out.pickup.estimate_minutes, "19 - 29");
  assert.deepEqual(out.menu.menus.map(m => m.menu_id), ["5001", "5002"]);
  assert.equal(out.menu.menu_id, "5001");
  assert.equal(out.menu.menus_truncated, false);

  assert.equal(calls.length, 1);
  const [call] = calls;
  assert.equal(call.url, "/graphql/storepageFeed?operation=storepageFeed");
  assert.equal(call.init.method, "POST");
  assert.equal(call.init.credentials, "include");
  assert.equal(call.init.headers["x-csrftoken"], "fabricated-csrf");
  assert.equal(call.init.headers["x-channel-id"], "marketplace");
  assert.deepEqual(call.init.body.variables, { storeId: "1001", fulfillmentType: "Delivery", isMerchantPreview: false, entryPoint: "External" });
  assert.match(call.init.body.query, /^query storepageFeed\(/);
  assert.doesNotMatch(call.init.body.query, /mutation/i);
  assert.doesNotMatch(call.init.body.query, /distanceFromConsumer/, "the customer's distance is never requested");
});

test("signed out: empty csrf header, signed_in false", async () => {
  const { calls, run } = harness({ cookie: "a=1" });
  const out = plain(await run({ store_id: "1001" }));
  assert.equal(calls[0].init.headers["x-csrftoken"], "");
  assert.equal(out.delivery_context.signed_in, false);
});

const farStore = () => ok(feed({ storeHeader: {
  asapStatus: { displayUnavailableReason: { title: "Your address is not in this store's delivery area" } },
  status: {
    delivery: { isAvailable: false, minutes: "51 - 61", unavailableReason: "Too far away", isTooFarFromConsumer: true },
    pickup: { isAvailable: false, minutes: "6 - 16", unavailableReason: "" }
  }
} }));

test("selected address, store out of range: the reason is reported and no estimate is invented", async () => {
  const { definition, run } = harness({ respond: farStore });
  const out = plain(await run({ store_id: "1001" }));
  assert.ok(validOutput(definition, out), JSON.stringify(out));
  assert.equal(out.delivery_context.basis, "selected_address");
  assert.equal(out.delivery.available, false);
  assert.equal(out.delivery.estimate_minutes, null);
  assert.equal(out.delivery.unavailable_reason, "Too far away");
  assert.equal(out.delivery.unavailable_message, "Your address is not in this store's delivery area");
  assert.equal(out.pickup.available, false);
  assert.equal(out.pickup.estimate_minutes, null);
  assert.equal(out.delivery_context.too_far_from_consumer, true);
  assert.match(out.delivery_context.note, /never changes the address/);
});

test("no address selected: the placeholder-location delivery figures are withheld, pickup and store data are not", async () => {
  const { definition, run } = harness({ button: { innerText: "Your Address" }, respond: farStore });
  const out = plain(await run({ store_id: "1001" }));
  assert.ok(validOutput(definition, out), JSON.stringify(out));
  assert.equal(out.delivery_context.basis, "no_address_selected");
  assert.equal(out.delivery_context.address_selected, false);
  assert.deepEqual(out.delivery, { available: null, unavailable_reason: null, unavailable_message: null, estimate_minutes: null, fee_display: out.delivery.fee_display });
  assert.equal(out.delivery_context.too_far_from_consumer, null);
  assert.equal(out.name, "Fabricated Noodle House");
  assert.equal(out.operation_status, "OPEN");
  assert.equal(out.hours.store.length, 7);
  assert.equal(out.delivery.fee_display.text, "$0 delivery fee over $12");
  assert.doesNotMatch(JSON.stringify(out), /Too far away/);
  assert.match(out.delivery_context.note, /withheld/);

  const available = harness({ button: { innerText: "Your Address" } });
  const open = plain(await available.run({ store_id: "1001" }));
  assert.equal(open.delivery.available, null, "an 'available' answer for a placeholder location is withheld too");
  assert.equal(open.delivery.estimate_minutes, null);
  assert.equal(open.pickup.estimate_minutes, "19 - 29");
});

test("unknown basis: delivery figures are withheld like the no-address case, not passed through", async () => {
  const { definition, run } = harness({ button: null, respond: farStore });
  const out = plain(await run({ store_id: "1001" }));
  assert.ok(validOutput(definition, out), JSON.stringify(out));
  assert.equal(out.delivery_context.basis, "unknown");
  assert.equal(out.delivery_context.address_selected, null);
  assert.equal(out.delivery.available, null);
  assert.equal(out.delivery.unavailable_reason, null);
  assert.equal(out.delivery_context.too_far_from_consumer, null);
  assert.equal(out.pickup.available, false);
  assert.doesNotMatch(JSON.stringify(out), /Too far away/);
});

test("basis is recognised positively, in any locale, and the header text is never returned", async () => {
  const basisOf = async options => plain(await harness(options).run({ store_id: "1001" })).delivery_context;
  const selected = await basisOf({});
  assert.equal(selected.basis, "selected_address");
  assert.equal(selected.address_selected, true);
  assert.ok(!JSON.stringify(plain(await harness().run({ store_id: "1001" }))).includes("Fabricated Header Street"));

  assert.equal((await basisOf({ button: { innerText: "Your Address" } })).basis, "no_address_selected");
  assert.equal((await basisOf({ button: { innerText: " your address " } })).basis, "no_address_selected");
  assert.equal((await basisOf({ button: { innerText: "Tu dirección" } })).basis, "no_address_selected");
  const unrecognised = await basisOf({ button: { innerText: "Votre adresse" } });
  assert.equal(unrecognised.basis, "unknown", "an unrecognised placeholder must not read as a selected address");
  assert.equal(unrecognised.address_selected, null);
  assert.equal((await basisOf({ button: { innerText: "Main Street" } })).basis, "unknown");
  for (const mixed of ["set your address", "your address please", "Your Address, Suite", "Tu dirección aquí"]) {
    assert.equal((await basisOf({ button: { innerText: mixed } })).basis, "unknown", "a placeholder is matched as the whole text: " + mixed);
  }
  assert.equal((await basisOf({ button: { innerText: "Your Address 2" } })).basis, "selected_address", "any digit counts as an address");
  assert.equal((await basisOf({ button: { innerText: "12 Rue Fabriquée" } })).basis, "selected_address");
  assert.equal((await basisOf({ button: { innerText: "  " } })).basis, "unknown");
  assert.equal((await basisOf({ button: null })).basis, "unknown");
  assert.equal((await basisOf({ button: null, landing: true })).basis, "no_address_selected");
  assert.equal((await basisOf({ button: null, landing: true })).address_selected, false);
});

test("convenience store: header details, canonical convenience URL, no menu", async () => {
  const { definition, run } = harness({ respond: () => ok(feed({ storeHeader: { id: "2002", name: "Fabricated Market", isConvenience: true } })) });
  const out = plain(await run({ store_id: "2002" }));
  assert.ok(validOutput(definition, out), JSON.stringify(out));
  assert.equal(out.store_type, "convenience");
  assert.equal(out.url, "https://www.doordash.com/convenience/store/2002/");
  assert.equal(out.menu, null, "a convenience store never reports a menu, even if the site sends one");
});

test("a store with no ratings reports no average instead of 0", async () => {
  const { definition, run } = harness({ respond: () => ok(feed({ storeHeader: { ratings: { numRatings: 0, numRatingsDisplayString: "", averageRating: 0, isNewlyAdded: true } } })) });
  const out = plain(await run({ store_id: "1001" }));
  assert.ok(validOutput(definition, out));
  assert.deepEqual(out.rating, { average: null, count: 0, count_text: null, is_new: true });
});

test("optional and missing fields become nulls, not errors", async () => {
  const { definition, run } = harness({
    respond: () => ok({
      storeHeader: { id: "1001", name: "Sparse Store", status: {} },
      mxInfo: null, menuBook: { id: null, menuList: [] }
    })
  });
  const out = plain(await run({ store_id: "1001" }));
  assert.ok(validOutput(definition, out), JSON.stringify(out));
  assert.equal(out.rating.average, null);
  assert.equal(out.operation_status, null);
  assert.deepEqual(out.hours, { store: [], doordash_orders: [] });
  assert.equal(out.delivery.available, null);
  assert.equal(out.delivery_context.too_far_from_consumer, null);
  assert.deepEqual(out.menu.menus, []);
  assert.equal(out.menu.menu_id, null);
});

test("output is bounded: menus, cuisines, hours slots and long strings are capped", async () => {
  const many = Array.from({ length: 30 }, (_, i) => ({ id: String(9000 + i), name: "Menu " + i, displayOpenHours: "All day" }));
  const { definition, run } = harness({
    respond: () => ok(feed({
      storeHeader: { description: "x".repeat(5000), businessTags: Array.from({ length: 25 }, (_, i) => ({ name: "Tag " + i })) },
      rest: {
        menuBook: { id: "9000", name: "Big", displayOpenHours: "All day", menuList: many },
        mxInfo: { operationInfo: { storeOperationHourInfo: { operationSchedule: [...week("a"), ...week("b")] }, doordashOperationHourInfo: { operationSchedule: [{ dayOfWeek: "MONDAY", timeSlotList: Array.from({ length: 12 }, (_, i) => "slot " + i) }] } } }
      }
    }))
  });
  const out = plain(await run({ store_id: "1001" }));
  assert.ok(validOutput(definition, out), JSON.stringify(out).slice(0, 300));
  assert.equal(out.menu.menus.length, 20);
  assert.equal(out.menu.menus_truncated, true);
  assert.equal(out.cuisines.length, 10);
  assert.equal(out.description.length, 300);
  assert.equal(out.hours.store.length, 7);
  assert.equal(out.hours.doordash_orders[0].slots.length, 6);
  assert.ok(JSON.stringify(out).length < 20000);
});

// --- failures ------------------------------------------------------------------------------------

test("malformed input is rejected before any request", async () => {
  const { definition, calls, run } = harness();
  for (const input of [undefined, null, [], "1001", {}, { store_id: 1001 }, { store_id: "" }, { store_id: "abc" }, { store_id: "12 34" }, { store_id: "-1" }, { store_id: "1234567890123" }, { store_id: "029417" }, { store_id: "0" }, { store_id: " 1001" }, { store_id: "1001 " }, { store_id: "1001\n" }, { store_id: "١٢٣" }, { store_id: "1001", extra: true }]) {
    const out = plain(await run(input));
    assert.equal(out.status, "error", JSON.stringify(input));
    assert.equal(out.error_kind, "invalid_input");
    assert.ok(validOutput(definition, out));
  }
  assert.equal(calls.length, 0);
});

test("execute accepts exactly the ids the input schema pattern accepts", async () => {
  const { definition, calls, run } = harness();
  const pattern = new RegExp(definition.tool.inputSchema.properties.store_id.pattern);
  for (const id of ["1", "1001", "123456789012", "0", "01", "029417", "1234567890123", "", " 1001", "1001 ", "1001\n", "10.1", "1e3", "\u0661\u0662"]) {
    const before = calls.length;
    const out = plain(await run({ store_id: id }));
    const accepted = out.error_kind !== "invalid_input";
    assert.equal(accepted, pattern.test(id), JSON.stringify(id));
    assert.equal(calls.length - before, accepted ? 1 : 0, JSON.stringify(id));
  }
});

test("signed_in reads exactly dd_cx_logged_in=true", async () => {
  const signedIn = async cookie => plain(await harness({ cookie }).run({ store_id: "1001" })).delivery_context.signed_in;
  assert.equal(await signedIn("dd_cx_logged_in=true"), true);
  assert.equal(await signedIn("a=1; dd_cx_logged_in=true; b=2"), true);
  assert.equal(await signedIn("a=1; dd_cx_logged_in=true"), true);
  assert.equal(await signedIn("dd_cx_logged_in=false"), false);
  assert.equal(await signedIn("dd_cx_logged_in=truex"), false);
  assert.equal(await signedIn("xdd_cx_logged_in=true"), false);
  assert.equal(await signedIn(""), false);
});

test("a page outside www.doordash.com is refused without a request", async () => {
  const { definition, calls, run } = harness({ origin: "https://help.doordash.com" });
  const out = plain(await run({ store_id: "1001" }));
  assert.equal(out.error_kind, "wrong_page");
  assert.ok(validOutput(definition, out));
  assert.equal(calls.length, 0);
});

test("unknown store ids are not_found, whether DoorDash errors or returns an empty header", async () => {
  const errored = harness({ respond: () => ({ status: 200, json: { data: { storepageFeed: null }, errors: [{ message: "5 NOT_FOUND: no stores returned", extensions: { code: "INTERNAL_SERVER_ERROR" } }] } }) });
  const a = plain(await errored.run({ store_id: "99999999" }));
  assert.equal(a.error_kind, "not_found");
  assert.ok(validOutput(errored.definition, a));
  const empty = harness({ respond: () => ok(feed({ storeHeader: { id: "1", name: "" } })) });
  assert.equal(plain(await empty.run({ store_id: "1" })).error_kind, "not_found");
});

test("permission, rate-limit, challenge, site-change and generic failures are distinct errors", async () => {
  const cases = [
    ["HTTP 401", { status: 401, body: "{}" }, "login_required"],
    ["unauthenticated GraphQL error", { status: 200, json: { data: null, errors: [{ message: "unauthenticated request", extensions: { code: "UNAUTHENTICATED" } }] } }, "login_required"],
    ["HTTP 429", { status: 429, body: "slow down" }, "rate_limited"],
    ["challenge page", { status: 403, body: "<html><title>Just a moment...</title><div id='challenge-platform'></div></html>" }, "challenge"],
    ["challenge page with HTTP 200", { status: 200, body: "<html>Please verify you are human. captcha</html>" }, "challenge"],
    ["non-JSON without a challenge", { status: 502, body: "<html>Bad gateway</html>" }, "site_error"],
    ["schema change", { status: 200, json: { errors: [{ message: "Cannot query field \"storeHeader\" on type \"Feed\"", extensions: { code: "GRAPHQL_VALIDATION_FAILED" } }] } }, "site_changed"],
    ["missing store header", { status: 200, json: { data: { storepageFeed: { mxInfo: {} } } } }, "site_changed"],
    ["null feed without errors", { status: 200, json: { data: { storepageFeed: null } } }, "site_changed"],
    ["another store's data", ok(feed({ storeHeader: { id: "7777" } })), "site_changed"],
    ["server error JSON", { status: 500, json: {} }, "site_error"],
    ["other GraphQL error", { status: 200, json: { errors: [{ message: "internal failure" }] } }, "site_error"]
  ];
  for (const [label, reply, kind] of cases) {
    const { definition, calls, run } = harness({ respond: () => reply });
    const out = plain(await run({ store_id: "1001" }));
    assert.equal(out.status, "error", label);
    assert.equal(out.error_kind, kind, label + ": " + JSON.stringify(out));
    assert.ok(out.error_message.length > 0);
    assert.ok(validOutput(definition, out), label);
    assert.equal(calls.length, 1, label + " must not retry");
  }
});

test("the request is bounded by a 25 second timeout and error text from the site is bounded", async () => {
  const { signalSpy, run } = harness();
  await run({ store_id: "1001" });
  assert.deepEqual(signalSpy.timeouts, [25000]);
  assert.equal(signalSpy.anys, 1);
  const noisy = harness({ respond: () => ({ status: 200, json: { errors: [{ message: "internal failure " + "x".repeat(50000) }] } }) });
  const out = plain(await noisy.run({ store_id: "1001" }));
  assert.equal(out.error_kind, "site_error");
  assert.ok(out.error_message.length < 300, String(out.error_message.length));
  const invalid = harness({ respond: () => ({ status: 200, json: { errors: [{ message: "Cannot query field " + "y".repeat(50000), extensions: { code: "GRAPHQL_VALIDATION_FAILED" } }] } }) });
  assert.ok(plain(await invalid.run({ store_id: "1001" })).error_message.length < 400);
});

test("network failure and timeout are site_error and are not retried", async () => {
  const failed = harness({ fetchError: new TypeError("Failed to fetch") });
  const a = plain(await failed.run({ store_id: "1001" }));
  assert.equal(a.error_kind, "site_error");
  assert.equal(failed.calls.length, 1);
  const timedOut = harness({ fetchError: Object.assign(new Error("timed out"), { name: "TimeoutError" }) });
  assert.match(plain(await timedOut.run({ store_id: "1001" })).error_message, /25 seconds/);
});

test("the caller's abort signal is passed to the request", async () => {
  const controller = new AbortController();
  const { calls, run } = harness();
  await run({ store_id: "1001" }, controller.signal);
  assert.ok(calls[0].init.signal instanceof AbortSignal);
  controller.abort();
  assert.equal(calls[0].init.signal.aborted, true);
});

test("the tool never navigates, writes, or reads anything but the header control and two cookies", async () => {
  const { calls, run } = harness();
  await run({ store_id: "1001" });
  assert.equal(calls.length, 1);
  assert.match(calls[0].init.body.query, /^query /);
  assert.doesNotMatch(source, /location\.(assign|replace|href\s*=)|history\.|localStorage|sessionStorage|\.click\(|dispatchEvent|\.submit\(/);
});
