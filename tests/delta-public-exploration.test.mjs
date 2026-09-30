import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";

const names = ["search_flight_status", "list_flight_deals", "prepare_itinerary"];
const sources = Object.fromEntries(names.map(n => [n, readFileSync(new URL(`../domains/delta.com/${n}.js`, import.meta.url), "utf8")]));
const plain = value => JSON.parse(JSON.stringify(value));
function conforms(s, v) {
  if (s.oneOf && s.oneOf.filter(x => conforms(x, v)).length !== 1) return false;
  if ("const" in s && v !== s.const || s.enum && !s.enum.includes(v)) return false;
  if (s.type && ![s.type].flat().some(t => t === "null" ? v === null : t === "array" ? Array.isArray(v) : t === "integer" ? Number.isInteger(v) : t === "object" ? v !== null && typeof v === "object" && !Array.isArray(v) : typeof v === t)) return false;
  if (typeof v === "string" && (v.length < (s.minLength ?? 0) || v.length > (s.maxLength ?? Infinity) || s.pattern && !new RegExp(s.pattern).test(v))) return false;
  if (typeof v === "number" && (v < (s.minimum ?? -Infinity) || v > (s.maximum ?? Infinity))) return false;
  if (Array.isArray(v) && (v.length < (s.minItems ?? 0) || v.length > (s.maxItems ?? Infinity) || s.items && !v.every(x => conforms(s.items, x)))) return false;
  if (v && typeof v === "object" && !Array.isArray(v)) {
    if (s.required?.some(k => !Object.hasOwn(v,k))) return false;
    if (s.additionalProperties === false && Object.keys(v).some(k => !Object.hasOwn(s.properties || {},k))) return false;
    if (Object.entries(s.properties || {}).some(([k,x]) => k in v && !conforms(x,v[k]))) return false;
  }
  return true;
}
function harness(name, globals = {}) {
  let interactions = 0;
  const context = {
    URL, URLSearchParams, Date, AbortController,
    setTimeout: () => 1, clearTimeout: () => {},
    get location() { interactions++; return new URL("https://www.delta.com/us/en/flight-deals/current-flight-deals"); },
    get document() { interactions++; throw Error("Unexpected document access"); },
    ...globals,
  };
  const [definition] = runInNewContext(`(${sources[name]})`, context);
  const execute = runInNewContext(`(${definition.execute.toString()})`, context);
  return {
    definition, context, interactions: () => interactions,
    run: async (input, ctx) => {
      const out = plain(await execute(input, ctx));
      assert.ok(conforms(definition.tool.outputSchema, out), JSON.stringify(out));
      return out;
    },
  };
}
for (const name of names) {
  test(`${name}: one page definition, serialization and annotations`, () => {
    const h = harness(name);
    assert.equal(h.definition.kind, "page");
    assert.equal(h.definition.tool.name, name);
    assert.deepEqual(plain(h.definition.match.url_patterns), ["https://www.delta.com/*"]);
    assert.equal(h.definition.tool.annotations.readOnlyHint, true);
    assert.equal(h.interactions(), 0);
  });
}
const scheduleInput = { origin: "AAA", destination: "BBB", date: "2026-10-01" };
const event = (code, time) => ({ station: { code, secret: "never-return" }, scheduleLocalDateTime: time, estimatedLocalDateTime: null, actualLocalDateTime: null, status: "On Time" });
const segment = (origin = "AAA", destination = "BBB", dep = "2026-10-01T08:00:00-04:00", arr = "2026-10-01T10:00:00-04:00") => ({
  flightNumber: "0123", originDepartureDate: dep.slice(0,10), marketingCarrier: { code: "DL" }, operatingCarrier: { name: "Example Carrier" },
  datedOperatingLegs: [{ flightNumber: "0123", status: "On Time", transportDeparture: event(origin,dep), transportArrival: event(destination,arr), secret: "never-return" }],
});
const schedule = () => ({ departure: { station: { code: "AAA" } }, arrival: { station: { code: "BBB" } }, trip: [{ tripDuration: "PT02H", stops: 0, datedOperatingSegment: [segment()] }], secret: "never-return" });
function route(body = schedule(), http = 200, options = {}) {
  const calls = [];
  let delay;
  const h = harness("search_flight_status", {
    location: new URL("https://www.delta.com/us/en/baggage/overview"),
    setTimeout: (fn, ms) => { delay = ms; return 1; },
    fetch: async (url, init) => { calls.push({ url, init }); if (options.throw) throw Error("signed-url-secret"); return { status: http, ok: http === 200, text: async () => typeof body === "string" ? body : JSON.stringify(body) }; },
  });
  return { ...h, calls, delay: () => delay };
}
test("route: exact request, one fetch, local times, no DOM and allowlisted output", async () => {
  const h = route(); const out = await h.run(scheduleInput);
  assert.equal(out.status, "ok"); assert.equal(out.result_count, 1);
  assert.equal(out.trips[0].legs[0].flight_number, "DL 123");
  assert.equal(out.trips[0].legs[0].departure.scheduled_time, "2026-10-01T08:00:00-04:00");
  assert.doesNotMatch(JSON.stringify(out), /never-return/);
  assert.equal(h.calls.length, 1); assert.equal(h.delay(), 20000);
  const [{ url, init }] = h.calls;
  assert.equal(url, "https://flightinformation-api.delta.com/flight-status/schedules");
  assert.equal(init.method,"POST"); assert.equal(init.credentials,"include");
  assert.deepEqual(plain(init.headers), { appId: "WEB", channelId: "DCOM", purchasePath: "FLIGHTSTATUS", "Content-Type": "application/json; charset=UTF-8" });
  assert.deepEqual(JSON.parse(init.body), {
    flightSegments: [{ flightOriginDate: "2026-10-01", originAirportCode: "AAA", destinationAirportCode: "BBB", airlineCode: "DL" }],
    filterOptions: { schedule: { directOnlyIndicator: false, includeElapsedOrAccumulatedTime: true, flightStops: [], departureTimeRanges: [], excludeOtherAirlineInd: true, connections: [{ connectionPointNum: "", connectionCity: "", minConnectionTime: "" }], startRecord: 1, endRecord: 30 }, availability: { indicator: false, seatTypeCode: "A", onlyRevenueClassInd: false } },
  });
});
for (const input of [null, [], "x", {}, { ...scheduleInput, origin: "aaa" }, { ...scheduleInput, destination: "AAA" }, { ...scheduleInput, date: "2026-02-30" }, { ...scheduleInput, origin: 123 }, { ...scheduleInput, confirmed: true }]) {
  test(`route: invalid input before any site interaction ${JSON.stringify(input)}`, async () => {
    const h = harness("search_flight_status"); assert.equal((await h.run(input)).error_kind, "invalid_input"); assert.equal(h.interactions(), 0);
  });
}
for (const [code, expected] of [[403,"blocked"],[444,"blocked"],[429,"rate_limited"],[500,"site_error"]]) {
  test(`route: HTTP ${code} is explicit, no retry or response leak`, async () => {
    const h = route("sensitive raw state",code); assert.equal((await h.run(scheduleInput)).error_kind,expected); assert.equal(h.calls.length,1);
  });
}
test("route: empty echoed schedule is explicit no_results", async () => {
  const body = schedule(); body.trip = []; const out = await route(body).run(scheduleInput); assert.equal(out.status,"no_results"); assert.equal(out.result_count,0);
});
test("route: connected legs validate the route and next-day connection", async () => {
  const body = schedule(); body.trip[0] = { tripDuration: "PT18H", stops: 1, datedOperatingSegment: [segment("AAA","CCC","2026-10-01T20:00:00-04:00","2026-10-01T22:00:00-04:00"),segment("CCC","BBB","2026-10-02T07:00:00-04:00","2026-10-02T09:00:00-04:00")] };
  const out = await route(body).run(scheduleInput); assert.equal(out.status,"ok"); assert.equal(out.trips[0].legs.length,2);
});
for (const [label, mutate] of [
  ["wrong echoed route", b => b.arrival.station.code = "CCC"],
  ["wrong itinerary route", b => b.trip[0].datedOperatingSegment[0].datedOperatingLegs[0].transportArrival.station.code = "CCC"],
  ["wrong date", b => b.trip[0].datedOperatingSegment[0].originDepartureDate = "2026-10-02"],
  ["invalid time", b => b.trip[0].datedOperatingSegment[0].datedOperatingLegs[0].transportDeparture.scheduleLocalDateTime = "2026-02-30T08:00:00-04:00"],
  ["wrong leg number", b => b.trip[0].datedOperatingSegment[0].datedOperatingLegs[0].flightNumber = "9999"],
  ["partner marketed", b => b.trip[0].datedOperatingSegment[0].marketingCarrier.code = "XX"],
  ["excessive trips", b => b.trip = Array(31).fill(b.trip[0])],
  ["missing legs", b => b.trip[0].datedOperatingSegment[0].datedOperatingLegs = []],
  ["disconnected route", b => { b.trip[0].datedOperatingSegment = [segment("AAA","CCC"),segment("DDD","BBB","2026-10-01T11:00:00-04:00","2026-10-01T12:00:00-04:00")]; }],
]) test(`route: fails closed on ${label}`, async () => {
  const body = schedule(); mutate(body); assert.equal((await route(body).run(scheduleInput)).error_kind,"site_changed");
});
for (const [body, kind] of [["<html>Denied</html>","blocked"],["not JSON","site_changed"],["x".repeat(1000001),"site_changed"]]) test(`route: response gate/shape ${kind} ${body.length}`, async () => {
  assert.equal((await route(body).run(scheduleInput)).error_kind,kind);
});
test("route: abort before interaction, network error and wrong page", async () => {
  const controller = new AbortController(); controller.abort(); const h = route();
  assert.equal((await h.run(scheduleInput,{ signal: controller.signal })).error_kind,"canceled"); assert.equal(h.calls.length,0);
  assert.equal((await route(schedule(),200,{ throw:true }).run(scheduleInput)).error_kind,"network_error");
  h.context.location = new URL("https://shop.delta.com/"); assert.equal((await h.run(scheduleInput)).error_kind,"wrong_page");
});

function element(text = "", selectors = {}, attributes = {}) {
  return { textContent: text, childNodes: [{ nodeType: 3, textContent: text }], getClientRects: () => attributes.hidden ? [] : [{}], closest: () => null,
    getAttribute: key => attributes[key] ?? null,
    querySelector: s => selectors[s] ?? null,
    querySelectorAll: s => selectors[s] ?? [],
  };
}
const dealId = "AAA-BBB-2026-11-03-2026-11-09-MAIN-money";
function dealRow(options = {}) {
  const origin = options.origin ?? "AAA", destination = options.destination ?? "BBB";
  const cells = ["money","miles"].map(pricing => {
    const target = new URL("https://www.delta.com/flightsearch/search");
    target.search = new URLSearchParams({ originCity: origin, destinationCity: destination, departureDate:"11/03/2026",returnDate:"11/09/2026",tripType:"ROUND_TRIP",paxCount:"1", cabinFareClass:"MAIN",awardTravel: pricing === "miles" ? "true":"false", sessionToken:"not-returned" }).toString();
    if (options.duplicateQuery) target.searchParams.append("originCity",origin);
    if (options.targetHost) target.hostname = options.targetHost;
    const wrapper = new URL("https://tkpi.delta.com/redirect"); wrapper.searchParams.set("redirecturl",target.href);
    const link = element("BOOK",{}, { href:options.rawRedirect ? "https://tkpi.delta.com/redirect?requesttype=xcheck.click&id=123&redirecturl=" + target.href : wrapper.href });
    const price = pricing === "miles" ? "16,200 Miles + $12" : options.price ?? "$207";
    const value = element(price);
    value.childNodes.push({ nodeType: 1, textContent: "BOOK private-noise" });
    return element("", { "a.fares-table__button":link, ".fares-table__cell--value":value, ".fares-table__cell--label":element("Delta Main Round Trip Fare From") }, { "data-key":`price_MAIN_${pricing === "miles" ? "points":"cash"}` });
  });
  return element("", { '[data-key="period"] .fares-table__cell--value':element("Oct 31 – Nov 6, 2026"), '[data-key="table_origin"] .fares-table__cell--value':element(`Example Origin (${options.rowOrigin ?? origin})`), '[data-key="table_destination"] .fares-table__cell--value':element(`Example Destination (${destination})`), '[data-key^="price_"]':cells },{ hidden: options.hidden });
}
function deals(name = "list_flight_deals", rows = [dealRow()], opts = {}) {
  let writes = 0;
  const h = harness(name, {
    location: new URL(opts.url ?? "https://www.delta.com/us/en/flight-deals/current-flight-deals"),
    getComputedStyle: () => ({ visibility:"visible" }),
    document: { querySelectorAll: s => s === ".fares-table__row:not(.fares-table__row--header)" ? rows : [element(opts.gate ?? "")] },
    fetch: () => { writes++; throw Error("No fetch allowed"); },
  });
  return { ...h, writes: () => writes };
}
test("deals: cash/award read, allowlist, dates distinct from display period", async () => {
  const h = deals(); const out = await h.run({});
  assert.equal(out.status,"ok"); assert.equal(out.result_count,2); assert.equal(out.deals[0].deal_id,dealId);
  assert.equal(out.deals[1].price_display,"16,200 Miles + $12");
  assert.equal(out.deals[0].depart_date,"2026-11-03"); assert.equal(out.deals[0].travel_period_display,"Oct 31 – Nov 6, 2026");
  assert.doesNotMatch(JSON.stringify(out),/sessionToken|not-returned|BOOK|private-noise/); assert.equal(h.writes(),0);
});
test("deals/preparation: unencoded redirect suffix preserves all public search parameters", async () => {
  const rows = [dealRow({ rawRedirect:true })];
  assert.equal((await deals("list_flight_deals",rows).run({})).status,"ok");
  assert.equal((await deals("prepare_itinerary",rows).run({deal_id:dealId,expected_price_display:"$207"})).status,"prepared");
});

test("deals: pricing/route filters, stable pagination, hidden rows", async () => {
  const h = deals("list_flight_deals", [dealRow(),dealRow({ origin:"CCC" }),dealRow({ origin:"DDD",hidden:true })]);
  const a = await h.run({ limit:1 }); assert.equal(a.next_offset,1);
  const b = await h.run({ limit:1,offset:1 }); assert.equal(b.deals[0].pricing,"miles"); assert.equal(b.next_offset,2);
  assert.equal((await h.run({ origin:"CCC", pricing:"money" })).result_count,1);
  assert.equal((await h.run({ destination:"ZZZ" })).status,"no_results");
  assert.equal((await h.run({ offset:10 })).status,"no_results");
});
for (const input of [null, [], { offset:null },{ limit:null },{limit:21},{ offset:-1 },{pricing:"cash"},{origin:"aaa"},{destination:123},{confirmed:true}]) test(`deals: invalid before DOM ${JSON.stringify(input)}`, async () => {
  const h = harness("list_flight_deals"); assert.equal((await h.run(input)).error_kind,"invalid_input"); assert.equal(h.interactions(),0);
});
for (const options of [{targetHost:"evil.example"},{duplicateQuery:true},{rowOrigin:"CCC"},{price:"$0<script>"}]) test(`deals/preparation: malformed target fails closed ${JSON.stringify(options)}`, async () => {
  assert.equal((await deals("list_flight_deals",[dealRow(options)]).run({})).error_kind,"site_changed");
  assert.equal((await deals("prepare_itinerary",[dealRow(options)]).run({deal_id:dealId,expected_price_display:"$207"})).error_kind,"site_changed");
});
for (const name of ["list_flight_deals","prepare_itinerary"]) {
  const input = name === "list_flight_deals" ? {} : {deal_id:dealId,expected_price_display:"$207"};
  test(`${name}: no row is site_changed, duplicates ambiguous, unrelated page and access gates explicit`, async () => {
    assert.equal((await deals(name,[]).run(input)).error_kind,"site_changed");
    assert.equal((await deals(name,[dealRow(),dealRow()]).run(input)).error_kind,"site_changed");
    assert.equal((await deals(name,[dealRow()],{url:"https://www.delta.com/us/en/baggage/overview"}).run(input)).error_kind,"wrong_page");
    assert.equal((await deals(name,[dealRow()],{gate:"Access Denied"}).run(input)).error_kind,"blocked");
    assert.equal((await deals(name,[dealRow()],{gate:"Too many requests"}).run(input)).error_kind,"rate_limited");
    const controller = new AbortController(); controller.abort();
    assert.equal((await deals(name).run(input,{signal:controller.signal})).error_kind,"canceled");
  });
}
test("preparation: exact live target and price, canonical allowlisted handoff, no requests or writes", async () => {
  const h = deals("prepare_itinerary"); const out = await h.run({deal_id:dealId,expected_price_display:"$207"});
  assert.equal(out.status,"prepared"); assert.equal(out.execution_supported,false); assert.equal(out.passengers,1);
  const url = new URL(out.handoff_url); assert.equal(url.origin,"https://www.delta.com"); assert.equal(url.pathname,"/flightsearch/search");
  assert.equal(url.searchParams.get("originCity"),"AAA"); assert.equal(url.searchParams.get("departureDate"),"11/03/2026");
  assert.equal(url.searchParams.get("awardTravel"),"false"); assert.equal(url.searchParams.get("paxCount"),"1");
  assert.doesNotMatch(out.handoff_url,/sessionToken|not-returned|tkpi/); assert.equal(h.writes(),0);
  assert.equal((await h.run({deal_id:dealId.replace("money","miles"),expected_price_display:"16,200 Miles + $12"})).status,"prepared");
});
test("preparation: stale price and missing exact target do not prepare", async () => {
  const h = deals("prepare_itinerary");
  assert.equal((await h.run({deal_id:dealId,expected_price_display:"$100"})).error_kind,"price_changed");
  assert.equal((await h.run({deal_id:dealId.replace("AAA","CCC"),expected_price_display:"$207"})).error_kind,"target_not_found");
});
for (const input of [null, [], {}, {deal_id:dealId,expected_price_display:"$207",confirmed:true}, {deal_id:dealId,expected_price_display:""}, {deal_id:dealId.replace("2026-11-03","2026-02-30"),expected_price_display:"$207"}, {deal_id:dealId.replace("AAA","BBB"),expected_price_display:"$207"}]) test(`preparation: rejects malformed/confirmation flag before DOM ${JSON.stringify(input)}`, async () => {
  const h = harness("prepare_itinerary"); assert.equal((await h.run(input)).error_kind,"invalid_input"); assert.equal(h.interactions(),0);
});
