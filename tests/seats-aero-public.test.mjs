import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";

const names = ["list_award_programs", "search_award_availability", "get_award_trips"];
const tools = Object.fromEntries(names.map(name => [name, runInNewContext(readFileSync(new URL(`../domains/seats.aero/${name}.js`, import.meta.url), "utf8"))[0]]));
const plain = v => JSON.parse(JSON.stringify(v));
const day = n => new Date(Date.parse(new Date().toISOString().slice(0,10) + "T00:00:00Z") + n * 86400000).toISOString().slice(0,10);
const availabilityId = "A".repeat(27), tripId = "B".repeat(27);
const inputs = {
  list_award_programs: {},
  search_award_availability: { origins: ["LHR"], destinations: ["EWR"], depart_date: day(15) },
  get_award_trips: { availability_id: availabilityId, depart_date: day(15) }
};

// All records are fabricated. No network, account or browser state is used by this suite.
const reference = () => ({ sources: { american: { friendly_name: "American AAdvantage", short_name: "AAdvantage", code: "AA", alliance: "Oneworld", economy: true, premium: false, business: true, first: true, has_trip_data: true, transfer_partners: { Citi: true, Amex: false }, private_key: "DO_NOT_RETURN" } }, airportNames: { LHR: "Example Airport" }, authorization: "DO_NOT_RETURN" });
const row = (extra = {}) => ({ id: availabilityId, source: "american", date: day(15), oa: "LHR", da: "EWR", lsh: 5, ys: 2, ym: 30000, yd: false, yc: "AA, AS", yt: { tt: 22623, tc: "USD", tcs: "$" }, wm: 0, wd: false, jm: 127000, jd: false, jc: "AA", jt: { tt: 41433, tc: "USD", tcs: "$" }, fm: 0, fd: false, account: "DO_NOT_RETURN", ...extra });
const searchData = (rows = [row()]) => ({ metadata: rows, error: false, errorMessage: "", liveCandidates: ["DO_NOT_RETURN"], revalidationID: "DO_NOT_RETURN" });
const trip = () => ({ ID: tripId, AvailabilityID: availabilityId, Source: "american", Cabin: "business", OriginAirport: "LHR", DestinationAirport: "EWR", DepartsAt: day(15)+"T09:15:00Z", ArrivesAt: day(16)+"T11:20:00Z", TotalDuration: 1685, Stops: 0, RemainingSeats: 0, MileageCost: 127000, TotalTaxes: 41433, TaxesCurrency: "USD", Carriers: "AA", FlightNumbers: "AA731", Connections: [], Aircraft: ["Example Aircraft"], AvailabilitySegments: [{ AvailabilityID: availabilityId, AvailabilityTripID: tripId, FlightNumber: "AA731", OriginAirport: "LHR", DestinationAirport: "EWR", DepartsAt: day(15)+"T09:15:00Z", ArrivesAt: day(16)+"T11:20:00Z", Duration: 1685, AircraftName: "Example Aircraft", Cabin: "business", Order: 0, private_key: "DO_NOT_RETURN" }] });
const tripData = () => ({ source: "american", originAirport: "LHR", destinationAirport: "EWR", departureDate: day(15), lastUpdatedMinutes: 359, trips: [trip()], rows: [row()], bookingLink: "https://example.invalid/checkout?token=DO_NOT_RETURN", bookingLinks: [{ link: "https://example.invalid/booking?token=DO_NOT_RETURN" }], revalidationID: "DO_NOT_RETURN" });
const fixtures = { list_award_programs: reference, search_award_availability: searchData, get_award_trips: tripData };

function conforms(schema, value) {
  if ("const" in schema && value !== schema.const || schema.enum && !schema.enum.includes(value)) return false;
  if (schema.type && ![schema.type].flat().some(t => t === "null" ? value === null : t === "array" ? Array.isArray(value) : t === "object" ? value !== null && typeof value === "object" && !Array.isArray(value) : t === "integer" ? Number.isInteger(value) : typeof value === t)) return false;
  if (schema.oneOf && schema.oneOf.filter(s => conforms(s,value)).length !== 1) return false;
  if (Array.isArray(value)) {
    if (value.length < (schema.minItems ?? 0) || value.length > (schema.maxItems ?? Infinity) || schema.uniqueItems && new Set(value).size !== value.length) return false;
    if (schema.items && !value.every(v => conforms(schema.items,v))) return false;
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    if (schema.required?.some(k => !Object.hasOwn(value,k))) return false;
    if (schema.additionalProperties === false && Object.keys(value).some(k => !Object.hasOwn(schema.properties,k))) return false;
    if (schema.properties && Object.entries(value).some(([k,v]) => schema.properties[k] && !conforms(schema.properties[k],v))) return false;
  }
  if (typeof value === "string") {
    if (value.length < (schema.minLength ?? 0) || value.length > (schema.maxLength ?? Infinity) || schema.pattern && !new RegExp(schema.pattern).test(value)) return false;
    if (schema.format === "date-time" && !Number.isFinite(Date.parse(value))) return false;
  }
  if (typeof value === "number" && (value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity) || !Number.isFinite(value))) return false;
  return true;
}

function harness(name, options = {}) {
  const calls = [];
  const context = {
    location: { origin: options.origin ?? "https://seats.aero" },
    document: { title: options.title ?? "seats.aero - Home", body: { innerText: options.text ?? "Search Explore Login Sign Up" }, querySelector: () => options.signedIn ? null : {} },
    performance: { getEntriesByType: () => options.resources ?? [{ name: "https://seats.aero/_api/vuerefdata?v=aabbccdd" }] },
    URL, URLSearchParams, Date, TextDecoder, AbortController, setTimeout: options.timer ?? setTimeout, clearTimeout,
    fetch: async (path, init) => {
      calls.push({ path, init });
      assert.equal(init.method,"GET"); assert.equal(init.credentials,"include"); assert.equal(init.redirect,"manual");
      assert.equal(init.headers.accept,"application/json");
      assert.ok(path.startsWith("/_api/")); assert.ok(!/live|refresh|booking|alert/.test(new URL(path,"https://seats.aero").pathname));
      if (options.fetch) return options.fetch(path,init);
      const body = options.body ?? fixtures[name]();
      return new Response(typeof body === "string" ? body : JSON.stringify(body), { status: options.status ?? 200 });
    }
  };
  // Page functions are serialized into a fresh document: no enclosing tool/schema closure may be required.
  const execute = runInNewContext("(" + tools[name].execute.toString() + ")", context);
  return { calls, async run(input = inputs[name], invocation = {}) {
    const output = plain(await execute(input,invocation));
    assert.ok(conforms(tools[name].tool.outputSchema,output), JSON.stringify(output));
    assert.ok(!JSON.stringify(output).includes("DO_NOT_RETURN"));
    assert.ok(JSON.stringify(output).length < 120000);
    assert.ok(calls.length <= 1);
    return output;
  }};
}

for (const name of names) {
  test(`${name}: page contract, schemas and one read`, async () => {
    assert.equal(tools[name].kind,"page"); assert.deepEqual(plain(tools[name].match.url_patterns),["https://seats.aero/*"]);
    assert.equal(tools[name].tool.annotations.readOnlyHint,true);
    assert.ok(conforms(tools[name].tool.inputSchema,inputs[name]));
    const h = harness(name); const out = await h.run(); assert.equal(out.status,"ok"); assert.equal(h.calls.length,1);
    const expected = name === "list_award_programs" ? "/_api/vuerefdata?v=" : name === "get_award_trips" ? "/_api/enrichment_modern/" : "/_api/search_partial?";
    assert.ok(h.calls[0].path.startsWith(expected));
  });
  test(`${name}: bad input before site interaction`, async () => {
    for (const input of [null, [], { ...inputs[name], extra:"secret" }]) {
      const h=harness(name,{ origin:"https://example.invalid" }); assert.equal((await h.run(input)).status,"invalid_input"); assert.equal(h.calls.length,0);
    }
  });
  test(`${name}: wrong-page, challenge and signed-in guards do not fetch`, async () => {
    for (const [options,status] of [[{origin:"https://docs.seats.aero"},"wrong_page"],[{title:"Just a moment..."},"challenge"],[{text:"Performing security verification"},"challenge"],[{signedIn:true},"gated"]]) {
      const h=harness(name,options); assert.equal((await h.run()).status,status); assert.equal(h.calls.length,0);
    }
  });
  test(`${name}: access denial is not no-results; never retry`, async () => {
    for (const [status,body,want] of [[403,"<html>Just a moment... cf-chl-</html>","challenge"],[403,"Denied","gated"],[429,"Too many requests","rate_limited"],[401,"Login","login_required"],[402,"PRO","gated"],[404,"Missing","not_found"],[500,"Oops","site_error"],[200,"<html>changed</html>","site_changed"],[200,{},"site_changed"],[200,{error:true,errorMessage:"Invalid airport, DO_NOT_RETURN"},"invalid_airports"],[200,{error:true,errorMessage:"PRO quota required DO_NOT_RETURN"},"gated"]]) {
      const h=harness(name,{status,body}); assert.equal((await h.run()).status,want); assert.equal(h.calls.length,1);
    }
  });
  test(`${name}: redirects aren't followed or echoed`, async () => {
    const h=harness(name,{fetch:async()=>({status:0,type:"opaqueredirect"})}); assert.equal((await h.run()).status,"gated");
  });
  test(`${name}: response/time/cancellation limits`, async () => {
    const large=harness(name,{body:"x".repeat(2097153)}); assert.equal((await large.run()).status,"response_too_large");
    const canceled=new AbortController(); canceled.abort(); const h=harness(name); assert.equal((await h.run(inputs[name],{signal:canceled.signal})).status,"canceled"); assert.equal(h.calls.length,0);
    const timed=harness(name,{timer:(fn)=>setTimeout(fn,1),fetch:async(_,init)=>new Promise((_,reject)=>init.signal.addEventListener("abort",()=>reject(new Error("DO_NOT_RETURN"))))}); assert.equal((await timed.run()).status,"timeout");
    const rejected=harness(name,{fetch:async()=>{throw new Error("DO_NOT_RETURN")}}); assert.equal((await rejected.run()).status,"site_error");
  });
}

test("list_award_programs: filter, bounds and version allowlist", async()=>{
  const out=await harness("list_award_programs").run({query:"oneworld",limit:1}); assert.equal(out.programs.length,1); assert.deepEqual(out.programs[0].transfer_partners,["Citi"]);
  assert.equal((await harness("list_award_programs").run({query:"No Such Program"})).status,"no_results");
  for(const resources of [[],[{name:"https://evil.invalid/_api/vuerefdata?v=aabbccdd"}],[{name:"https://seats.aero/_api/vuerefdata?v=secret&token=private"}]]){
    const h=harness("list_award_programs",{resources}); assert.equal((await h.run()).status,"wrong_page"); assert.equal(h.calls.length,0);
  }
  const body=reference();body.sources.american.logo_url="https://secret.invalid/?token=DO_NOT_RETURN";
  assert.equal((await harness("list_award_programs",{body}).run()).status,"ok");
  const unassociated=reference();unassociated.sources.american.code="";
  assert.equal((await harness("list_award_programs",{body:unassociated}).run()).programs[0].airline_code,null);
  assert.equal((await harness("list_award_programs",{body:unassociated}).run({query:"AA"})).status,"ok");
  unassociated.sources.american.code=12;
  assert.equal((await harness("list_award_programs",{body:unassociated}).run()).status,"site_changed");
  const many=reference();for(let i=0;i<90;i++)many.sources["program"+i]={...many.sources.american};
  const capped=await harness("list_award_programs",{body:many}).run({limit:2});assert.equal(capped.programs.length,2);assert.equal(capped.has_more,true);
  for(const input of [{query:null},{limit:null},{query:1},{limit:81}])assert.equal((await harness("list_award_programs").run(input)).status,"invalid_input");
});

test("search_award_availability: seats, cabins, taxes and single-day semantics",async()=>{
  const h=harness("search_award_availability");const out=await h.run(); const params=new URL(h.calls[0].path,"https://seats.aero").searchParams;
  assert.equal(params.get("additional_days"),"false");assert.equal(params.get("client_date"),day(0));
  assert.deepEqual(out.rows[0].cabins[1].taxes,{amount_hundredths:41433,currency:"USD"}); assert.equal(out.rows[0].cabins[1].remaining_seats,null);
  const unknown=await harness("search_award_availability").run({...inputs.search_award_availability,min_seats:2,cabin:"business"});assert.equal(unknown.status,"no_results");
  const economy=await harness("search_award_availability").run({...inputs.search_award_availability,min_seats:2,cabin:"economy"});assert.equal(economy.rows[0].cabins.length,1);
  const none=await harness("search_award_availability",{body:searchData([])}).run();assert.equal(none.status,"no_results");assert.equal(none.has_more,false);
  const invalid=harness("search_award_availability",{body:{error:true,metadata:null,errorMessage:"The provided airport(s) do not appear to be valid or tracked by seats.aero."}});assert.equal((await invalid.run()).status,"invalid_airports");
});

test("search_award_availability: windows and malformed parameters rejected before fetch",async()=>{
  for(const extra of [{origins:["JFK","JFK"]},{destinations:[]},{origins:["abc"]},{origins:["JFK","EWR","LGA"]},{depart_date:"2030-02-30"},{depart_date:day(-1)},{additional_days:8},{min_seats:0},{limit:41},{limit:null},{cabin:null}]){
    const h=harness("search_award_availability");assert.equal((await h.run({...inputs.search_award_availability,...extra})).status,"invalid_input");assert.equal(h.calls.length,0);
  }
  for(const extra of [{depart_date:day(58)},{depart_date:day(56),additional_days:2}]){const h=harness("search_award_availability");assert.equal((await h.run({...inputs.search_award_availability,...extra})).status,"login_required");assert.equal(h.calls.length,0);}
});

test("search_award_availability: output cap and changed response don't fabricate absence",async()=>{
  const many=Array.from({length:100},(_,i)=>row({id:String(i).padStart(27,"A")}));const out=await harness("search_award_availability",{body:searchData(many)}).run({...inputs.search_award_availability,limit:3});assert.equal(out.rows.length,3);assert.equal(out.total_matches,100);assert.equal(out.has_more,true);
  for(const extra of [{id:"bad"},{ym:"30000"},{yt:{tt:"22623",tc:"USD"}},{date:day(16)},{yc:"malicious script"}])assert.equal((await harness("search_award_availability",{body:searchData([row(extra)])}).run()).status,"site_changed");
  const noShape=harness("search_award_availability",{body:{error:false,metadata:null}});assert.equal((await noShape.run()).status,"site_changed");
});

test("get_award_trips: local times and safe allowlist",async()=>{
  const out=await harness("get_award_trips").run();assert.equal(out.time_basis,"airport_local");assert.equal(out.trips[0].departure_local,day(15)+"T09:15:00");assert.equal(out.trips[0].arrival_local,day(16)+"T11:20:00");assert.equal(out.trips[0].remaining_seats,0);assert.deepEqual(out.trips[0].taxes,{amount_hundredths:41433,currency:"USD"});
  assert.equal((await harness("get_award_trips").run({...inputs.get_award_trips,cabin:"economy"})).status,"no_results");
  const many=tripData();many.trips=Array.from({length:40},()=>trip());const capped=await harness("get_award_trips",{body:many}).run({...inputs.get_award_trips,limit:2});assert.equal(capped.trips.length,2);assert.equal(capped.has_more,true);
});

test("get_award_trips: public date, record identity and schema changes",async()=>{
  for(const extra of [{availability_id:"../../private"},{availability_id:"https://seats.aero/s/id"},{depart_date:day(-1)},{depart_date:"2030-02-30"},{limit:21},{limit:null}]){const h=harness("get_award_trips");assert.equal((await h.run({...inputs.get_award_trips,...extra})).status,"invalid_input");assert.equal(h.calls.length,0);}
  const far=harness("get_award_trips");assert.equal((await far.run({...inputs.get_award_trips,depart_date:day(58)})).status,"login_required");assert.equal(far.calls.length,0);
  const mismatch=tripData();mismatch.departureDate=day(70);assert.equal((await harness("get_award_trips",{body:mismatch}).run()).status,"gated");
  for(const [field,status] of [["hasOutageWarning","site_error"],["hasInaccessibleWarning","gated"]]){const body=tripData();body[field]=true;assert.equal((await harness("get_award_trips",{body}).run()).status,status);}
  for(const change of [t=>t.AvailabilityID="C".repeat(27),t=>t.AvailabilitySegments=[null],t=>t.TotalTaxes=-1,t=>t.AvailabilitySegments[0].Order=1,t=>t.AvailabilitySegments[0].OriginAirport="JFK",t=>t.DepartsAt=day(15)+"T26:00:00Z"]){const body=tripData();change(body.trips[0]);assert.equal((await harness("get_award_trips",{body}).run()).status,"site_changed");}
});
