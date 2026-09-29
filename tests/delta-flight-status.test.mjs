import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";

// Harness for delta.com get_flight_status. `fetch`, timers and the page are stubbed; nothing here contacts
// the live site. Flight numbers, times, gates and every other value below are fabricated.
const source = readFileSync(new URL("../domains/delta.com/get_flight_status.js", import.meta.url), "utf8");
const registry = JSON.parse(readFileSync(new URL("../registry.json", import.meta.url), "utf8"));
const plain = value => JSON.parse(JSON.stringify(value));
const ENDPOINT = "https://flightinformation-api.delta.com/flight-status/details";

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
  if (typeof value === "number") {
    if (value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity)) return false;
  }
  return true;
}

// --- fabricated Delta response -------------------------------------------------------------------------

const station = (code, name, city, region) => ({ code, name, cityName: `${city},${region}`, city: { name: city, region }, regionCode: region, countryCode: "US", coordinate: { latitude: 1.5, longitude: 2.5 } });
const airportSide = (stationValue, extra = {}) => ({
  actualLocalDateTime: null, actualGMTDateTime: null,
  estimatedLocalDateTime: null, estimatedGMTDateTime: null,
  scheduledLocalDateTime: "2026-10-01T09:00:00-04:00", scheduledGMTDateTime: "2026-10-01T13:00:00Z",
  status: "On Time", ICAOcode: "KXXX", gate: { identifier: "B12" }, terminal: { code: "S", name: "South Terminal" },
  station: stationValue, ...extra
});
const ATL = station("ATL", "Example Atlanta Intl", "Atlanta", "GA");
const BOS = station("BOS", "Example Boston Logan", "Boston", "MA");
const DTW = station("DTW", "Example Detroit Metro", "Detroit", "MI");
const leg = (number, from, to, extra = {}) => ({
  legNumber: String(number), duration: "PT02H05M", flightNum: "1234", shipNumber: "000999", codeshareFlightLegIndicator: false,
  distanceInmiles: "946", status: "Scheduled", statusReason: "", delayDuration: "", flightCancellationReasonCode: "",
  timeRemaining: "", statusColor: "GREEN", notificationAvailabilityText: "secret-marker-not-for-output",
  actualOffGMTTimestamp: null, flightPositions: { actualFlightPositions: [{ lat: 1, lon: 2 }], plannedFlightPositions: [] },
  operatingCarrier: { code: "", name: "" }, aircraft: { code: "321", name: "Airbus A321", industryCode: "321" },
  departureAirport: airportSide(from), arrivalAirport: airportSide(to, { scheduledLocalDateTime: "2026-10-01T11:05:00-04:00", baggageClaim: { identifier: "7" } }),
  ...extra
});
const apiBody = (legs, overrides = {}) => ({
  flightNumber: "1234", originDepartureDate: "2026-10-01",
  datedOperatingSegment: { duration: "", flightNumber: "1234", stops: legs.length - 1, throughFlightindicator: legs.length > 1, changeofGaugeIndicator: false, carrier: { code: "DL", name: "Delta Air Lines" }, datedOperatingLegs: legs },
  ...overrides
});
const ONE_LEG = apiBody([leg(1, ATL, BOS)]);
const TWO_LEGS = apiBody([leg(1, ATL, BOS), leg(2, BOS, DTW, { status: "In Flight", delayDuration: "PT00H20M" })]);

function response(status, body) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return { status, ok: status >= 200 && status < 300, text: async () => text };
}

function harness(handler) {
  const calls = [];
  const timers = [];
  const fetch = async (url, init) => { calls.push({ url, init: plain({ ...init, signal: undefined }), signal: init.signal }); return handler(url, init, calls.length); };
  const context = {
    fetch, AbortController,
    setTimeout: fn => { timers.push(fn); return timers.length; },
    clearTimeout: () => {},
    // The tool must not touch the document, navigate, or read the location.
    get document() { throw new Error("document must not be used"); },
    get location() { throw new Error("location must not be used"); }
  };
  const [tool] = runInNewContext(source, context);
  return { tool, calls, timers, run: (input, ctx = {}) => tool.execute(input, ctx) };
}

const okHarness = body => harness(() => response(200, body));
const outputSchema = tool => tool.tool.outputSchema;

// --- definition -----------------------------------------------------------------------------------------

test("definition: page tool for www.delta.com with read-only annotations and typed schemas", () => {
  const { tool } = okHarness(ONE_LEG);
  const entry = registry.tools.find(t => t.domain === "delta.com" && t.tool === "get_flight_status");
  assert.equal(tool.kind, "page");
  assert.equal(tool.tool.name, "get_flight_status");
  assert.deepEqual(plain(tool.match.url_patterns), ["https://www.delta.com/*"]);
  assert.equal(tool.tool.annotations.readOnlyHint, true);
  assert.equal(entry.kind, "page");
  assert.equal(entry.status, "draft");
  assert.deepEqual(entry.url_patterns, plain(tool.match.url_patterns));
  assert.ok(!JSON.stringify(tool.tool.outputSchema).includes("$ref"));
  assert.deepEqual(plain(tool.tool.inputSchema.required), ["flight_number", "date"]);
  assert.equal(new Function(`return (${tool.execute.toString()})`)() instanceof Function, true, "execute must be re-creatable from its source");
});

test("definition: description states the limits a caller must not over-read", () => {
  const { tool } = okHarness(ONE_LEG);
  const d = tool.tool.description;
  assert.match(d, /never navigates/);
  assert.match(d, /never retries/);
  assert.match(d, /does not mean the flight does not exist/);
  assert.match(d, /blocked/);
  assert.match(d, /route_not_found/);
});

// --- success ----------------------------------------------------------------------------------------------

test("single leg: sends exactly one observed request and returns an allowlisted, schema-valid result", async () => {
  const h = okHarness(ONE_LEG);
  const out = plain(await h.run({ flight_number: "1234", date: "2026-10-01" }));
  assert.equal(h.calls.length, 1);
  const [call] = h.calls;
  assert.equal(call.url, ENDPOINT);
  assert.equal(call.init.method, "POST");
  assert.equal(call.init.credentials, "include");
  assert.deepEqual(call.init.headers, {
    "Content-Type": "application/json; charset=UTF-8", Accept: "application/json, text/plain, */*",
    appId: "WEB", channelId: "DCOM", purchasePath: "FLIGHTSTATUS"
  });
  assert.deepEqual(JSON.parse(call.init.body), { flightNumber: "1234", airlineCode: "DL", departureDate: "2026-10-01", legDepartureDate: "", originAirportCode: "" });
  assert.equal(out.status, "ok");
  assert.equal(out.flight_number, "1234");
  assert.equal(out.airline_code, "DL");
  assert.equal(out.leg_count, 1);
  assert.equal(out.leg_selection, "all_legs");
  const [l] = out.legs;
  assert.equal(l.leg_number, 1);
  assert.equal(l.status, "Scheduled");
  assert.equal(l.duration_minutes, 125);
  assert.equal(l.distance_miles, 946);
  assert.deepEqual(l.aircraft, { code: "321", name: "Airbus A321" });
  assert.equal(l.operating_carrier, null);
  assert.equal(l.codeshare, false);
  assert.equal(l.delay, null);
  assert.equal(l.departure.airport_code, "ATL");
  assert.equal(l.departure.gate, "B12");
  assert.equal(l.departure.terminal, "S");
  assert.equal(l.departure.scheduled_time_local, "2026-10-01T09:00:00-04:00");
  assert.equal(l.departure.estimated_time_local, null);
  assert.equal(l.arrival.airport_code, "BOS");
  assert.equal(l.arrival.baggage_claim, "7");
  assert.equal(l.departure.baggage_claim, null);
  assert.ok(conforms(outputSchema(h.tool), out), "output must satisfy outputSchema");
  const serialized = JSON.stringify(out);
  for (const leaked of ["000999", "secret-marker-not-for-output", "KXXX", "GMT", "latitude", "flightPositions", "Z\""]) assert.ok(!serialized.includes(leaked), `output must not include ${leaked}`);
});

test("multi-leg: all legs returned with a warning when no route is given", async () => {
  const h = okHarness(TWO_LEGS);
  const out = plain(await h.run({ flight_number: "1234", date: "2026-10-01" }));
  assert.equal(out.status, "ok");
  assert.equal(out.leg_count, 2);
  assert.equal(out.leg_selection, "all_legs");
  assert.deepEqual(out.legs.map(l => `${l.departure.airport_code}-${l.arrival.airport_code}`), ["ATL-BOS", "BOS-DTW"]);
  assert.equal(out.legs[1].delay, "PT00H20M");
  assert.equal(out.legs[1].status, "In Flight");
  assert.match(out.note, /operates 2 legs/);
  assert.ok(conforms(outputSchema(h.tool), out));
});

test("multi-leg: origin and destination keep only the matching leg", async () => {
  const h = okHarness(TWO_LEGS);
  const both = plain(await h.run({ flight_number: "1234", date: "2026-10-01", origin: "BOS", destination: "DTW" }));
  assert.equal(both.status, "ok");
  assert.equal(both.leg_selection, "filtered");
  assert.equal(both.leg_count, 2, "leg_count is Delta's count before filtering");
  assert.deepEqual(both.legs.map(l => l.leg_number), [2]);
  assert.ok(conforms(outputSchema(h.tool), both));
  const originOnly = plain(await h.run({ flight_number: "1234", date: "2026-10-01", origin: "ATL" }));
  assert.deepEqual(originOnly.legs.map(l => l.arrival.airport_code), ["BOS"]);
  const destinationOnly = plain(await h.run({ flight_number: "1234", date: "2026-10-01", destination: "DTW" }));
  assert.deepEqual(destinationOnly.legs.map(l => l.departure.airport_code), ["BOS"]);
});

test("multi-leg: a route Delta did not return is route_not_found, never another leg", async () => {
  const h = okHarness(TWO_LEGS);
  const out = plain(await h.run({ flight_number: "1234", date: "2026-10-01", origin: "ATL", destination: "DTW" }));
  assert.equal(out.status, "error");
  assert.equal(out.error_kind, "route_not_found");
  assert.deepEqual(out.available_routes, ["ATL-BOS", "BOS-DTW"]);
  assert.ok(!("legs" in out));
  assert.ok(conforms(outputSchema(h.tool), out));
});

test("flight number normalization: DL prefix and leading zeros", async () => {
  for (const [given, sent] of [["DL1234", "1234"], ["dl1234", "1234"], ["0123", "123"], ["0404", "404"], ["7", "7"]]) {
    const h = okHarness(apiBody([leg(1, ATL, BOS)], { flightNumber: sent }));
    const out = plain(await h.run({ flight_number: given, date: "2026-10-01" }));
    assert.equal(JSON.parse(h.calls[0].init.body).flightNumber, sent);
    assert.equal(out.status, "ok");
    assert.equal(out.flight_number, sent);
  }
  const zero = okHarness(ONE_LEG);
  assert.equal(plain(await zero.run({ flight_number: "0000", date: "2026-10-01" })).error_kind, "invalid_input");
  assert.equal(zero.calls.length, 0);
});

test("operating carrier and codeshare are reported when Delta provides them", async () => {
  const body = apiBody([leg(1, ATL, BOS, { operatingCarrier: { code: "XX", name: "Example Connection" }, codeshareFlightLegIndicator: true })]);
  const out = plain(await okHarness(body).run({ flight_number: "1234", date: "2026-10-01" }));
  assert.deepEqual(out.legs[0].operating_carrier, { code: "XX", name: "Example Connection" });
  assert.equal(out.legs[0].codeshare, true);
});

test("sanitization: control characters stripped, long text truncated, malformed times dropped", async () => {
  const body = apiBody([leg(1, ATL, BOS, {
    status: "In\u0000 Flight\n\u0007", statusReason: "x".repeat(400),
    departureAirport: airportSide(ATL, { estimatedLocalDateTime: "tomorrow at noon", actualLocalDateTime: "2026-10-01T09:04:00-04:00", gate: { identifier: "  A\t1 " } })
  })]);
  const out = plain(await okHarness(body).run({ flight_number: "1234", date: "2026-10-01" }));
  const l = out.legs[0];
  assert.equal(l.status, "In Flight");
  assert.equal(l.status_reason.length, 120);
  assert.equal(l.departure.estimated_time_local, null);
  assert.equal(l.departure.actual_time_local, "2026-10-01T09:04:00-04:00");
  assert.equal(l.departure.gate, "A 1");
});

// --- input validation (no request is made) -----------------------------------------------------------------

const BAD_INPUTS = [
  [undefined], [null], ["1234"], [[]],
  [{ date: "2026-10-01" }],
  [{ flight_number: "1234" }],
  [{ flight_number: "ABC", date: "2026-10-01" }],
  [{ flight_number: "12345", date: "2026-10-01" }],
  [{ flight_number: "AA1234", date: "2026-10-01" }],
  [{ flight_number: " 1234", date: "2026-10-01" }],
  [{ flight_number: 1234, date: "2026-10-01" }],
  [{ flight_number: "1234", date: "10/01/2026" }],
  [{ flight_number: "1234", date: "2026-02-30" }],
  [{ flight_number: "1234", date: "2026-13-01" }],
  [{ flight_number: "1234", date: "2026-10-1" }],
  [{ flight_number: "1234", date: "2026-10-01", origin: "atl" }],
  [{ flight_number: "1234", date: "2026-10-01", destination: "BOSTON" }],
  [{ flight_number: "1234", date: "2026-10-01", origin: 5 }],
  [{ flight_number: "1234", date: "2026-10-01", extra: true }]
];
for (const [input] of BAD_INPUTS) {
  test(`invalid input ${JSON.stringify(input)} is rejected before any request`, async () => {
    const h = okHarness(ONE_LEG);
    const out = plain(await h.run(input));
    assert.equal(out.status, "error");
    assert.equal(out.error_kind, "invalid_input");
    assert.equal(h.calls.length, 0);
    assert.ok(conforms(outputSchema(h.tool), out));
  });
}

test("leap day is accepted, non-leap Feb 29 is not", async () => {
  const good = plain(await okHarness(apiBody([leg(1, ATL, BOS)], { originDepartureDate: "2028-02-29" })).run({ flight_number: "1234", date: "2028-02-29" }));
  assert.equal(good.status, "ok");
  const bad = plain(await okHarness(ONE_LEG).run({ flight_number: "1234", date: "2026-02-29" }));
  assert.equal(bad.error_kind, "invalid_input");
});

// --- site outcomes are never empty successes ----------------------------------------------------------------

const FLD2300 = { code: "FLD2300", description: "NO FLIGHT FOUND", inputParam: "flightNumber of date", message: "Delta does not have any flights scheduled that match your request." };
const DENIED = "<HTML><HEAD>\n<TITLE>Access Denied</TITLE>\n</HEAD><BODY>\n<H1>Access Denied</H1>\n</BODY></HTML>";
const OUTCOMES = [
  ["FLD2300 becomes flight_not_found", () => response(400, FLD2300), "flight_not_found", 400, "FLD2300"],
  ["HTTP 444 access denied becomes blocked", () => response(444, DENIED), "blocked", 444, null],
  ["HTTP 403 becomes blocked", () => response(403, DENIED), "blocked", 403, null],
  ["access-denied HTML on another status becomes blocked", () => response(200, DENIED), "blocked", 200, null],
  ["HTTP 429 becomes rate_limited", () => response(429, ""), "rate_limited", 429, null],
  ["other JSON error code becomes site_error", () => response(400, { code: "XYZ9999", message: "boom" }), "site_error", 400, "XYZ9999"],
  ["HTTP 500 becomes site_error", () => response(500, "oops"), "site_error", 500, null],
  ["non-JSON 200 becomes unexpected_response", () => response(200, "<html>hi</html>"), "unexpected_response", 200, null],
  ["JSON without legs becomes unexpected_response", () => response(200, { flightNumber: "1234", originDepartureDate: "2026-10-01" }), "unexpected_response", 200, null],
  ["empty legs becomes unexpected_response", () => response(200, apiBody([])), "unexpected_response", 200, null],
  ["nine legs becomes unexpected_response", () => response(200, apiBody(Array.from({ length: 9 }, (_, i) => leg(i + 1, ATL, BOS)))), "unexpected_response", 200, null],
  ["a leg without airports becomes unexpected_response", () => response(200, apiBody([leg(1, ATL, BOS, { arrivalAirport: {} })])), "unexpected_response", 200, null],
  ["a different flight number in the response is discarded", () => response(200, apiBody([leg(1, ATL, BOS)], { flightNumber: "4321" })), "unexpected_response", 200, null],
  ["a different date in the response is discarded", () => response(200, apiBody([leg(1, ATL, BOS)], { originDepartureDate: "2026-10-02" })), "unexpected_response", 200, null]
];
for (const [name, respond, kind, httpStatus, code] of OUTCOMES) {
  test(`outcome: ${name}, with one request and no retry`, async () => {
    const h = harness(respond);
    const out = plain(await h.run({ flight_number: "1234", date: "2026-10-01" }));
    assert.equal(out.status, "error");
    assert.equal(out.error_kind, kind);
    assert.equal(out.http_status, httpStatus);
    assert.equal(out.delta_error_code ?? null, code);
    assert.equal(h.calls.length, 1);
    assert.ok(!("legs" in out));
    assert.ok(conforms(outputSchema(h.tool), out));
  });
}

test("blocked message says it is a session block, not a missing flight", async () => {
  const out = plain(await harness(() => response(444, DENIED)).run({ flight_number: "1234", date: "2026-10-01" }));
  assert.match(out.error_message, /not proof that the flight does not exist/);
  assert.match(out.error_message, /Do not retry in a loop/);
});

test("a rejected request becomes network_error", async () => {
  const h = harness(() => { throw new TypeError("Failed to fetch"); });
  const out = plain(await h.run({ flight_number: "1234", date: "2026-10-01" }));
  assert.equal(out.error_kind, "network_error");
  assert.equal(h.calls.length, 1);
  assert.ok(conforms(outputSchema(h.tool), out));
});

test("the 20 second timer aborts a hung request", async () => {
  const h = harness((url, init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted")))));
  const pending = h.run({ flight_number: "1234", date: "2026-10-01" });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.timers.length, 1);
  h.timers[0]();
  const out = plain(await pending);
  assert.equal(out.error_kind, "network_error");
  assert.equal(h.calls[0].signal.aborted, true);
});

test("the caller's abort signal aborts the request", async () => {
  const outer = new AbortController();
  const h = harness((url, init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted")))));
  const pending = h.run({ flight_number: "1234", date: "2026-10-01" }, { signal: outer.signal });
  await new Promise(resolve => setImmediate(resolve));
  outer.abort();
  const out = plain(await pending);
  assert.equal(out.error_kind, "network_error");
  assert.equal(h.calls[0].signal.aborted, true);
});

test("an already-aborted caller signal never gets an answer from the network", async () => {
  const outer = new AbortController();
  outer.abort();
  const h = harness((url, init) => new Promise((resolve, reject) => {
    if (init.signal.aborted) reject(new Error("aborted"));
    else resolve(response(200, ONE_LEG));
  }));
  const out = plain(await h.run({ flight_number: "1234", date: "2026-10-01" }, { signal: outer.signal }));
  assert.equal(out.error_kind, "network_error");
});

test("the tool never touches the document or location", async () => {
  // The harness context throws if either is read; every path above already ran without tripping it.
  const out = plain(await okHarness(ONE_LEG).run({ flight_number: "1234", date: "2026-10-01" }));
  assert.equal(out.status, "ok");
});
