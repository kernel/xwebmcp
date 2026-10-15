import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { El, card, itineraryData, segment, validate } from "./google-flights-dom.mjs";

const source = name => readFileSync(new URL(`../domains/google.com/${name}.js`, import.meta.url), "utf8");
const json = value => JSON.parse(JSON.stringify(value));

// Google's tfs: legs (field 3) with date, chosen segments (4), origin (13) and destination (14); travelers (8), cabin (9), trip type (19).
function tfs({ trip, legs, pax = [1], cabin = 1, selected = [] }) {
  const varint = v => { const out = []; do { let b = v & 127; v = Math.floor(v / 128); if (v) b |= 128; out.push(b); } while (v); return out; };
  const bytes = (field, payload) => [...varint(field * 8 + 2), ...varint(payload.length), ...payload];
  const str = (field, value) => bytes(field, [...Buffer.from(value)]);
  const int = (field, value) => [...varint(field * 8), ...varint(value)];
  const out = [];
  legs.forEach(([date, from, to], i) => out.push(...bytes(3, [
    ...str(2, date),
    ...(selected[i] || []).flatMap(([a, d, b, c, n]) => bytes(4, [...str(1, a), ...str(2, d), ...str(3, b), ...str(5, c), ...str(6, n)])),
    ...bytes(13, [...int(1, 1), ...str(2, from)]), ...bytes(14, [...int(1, 1), ...str(2, to)]),
  ])));
  for (const p of pax) out.push(...int(8, p));
  out.push(...int(9, cabin), ...int(19, trip === "round_trip" ? 1 : 2));
  return Buffer.from(out).toString("base64url");
}

// Discrete-event clock: tool sleeps and simulated page changes run in virtual time, instantly.
function virtualClock() {
  let now = Date.parse("2026-10-15T12:00:00Z"), id = 0, pumping = false;
  const timers = [];
  const pump = () => {
    pumping = false;
    timers.sort((a, b) => a.at - b.at || a.id - b.id);
    const next = timers.shift();
    if (!next) return;
    now = Math.max(now, next.at);
    next.fn();
    if (timers.length && !pumping) { pumping = true; setImmediate(pump); }
  };
  return {
    setTimeout: (fn, ms = 0) => { timers.push({ at: now + ms, fn, id: id++ }); if (!pumping) { pumping = true; setImmediate(pump); } },
    Date: class extends Date { static now() { return now; } },
  };
}

const ROUTE = { trip: "round_trip", legs: [["2026-12-30", "JFK", "LAX"], ["2027-01-03", "LAX", "JFK"]] };
const B6_523 = { date: "2026-12-30", dep: "7:00 AM", arr: "10:19 AM", airline: "JetBlue", duration: "6 hr 19 min", from: "John F. Kennedy International Airport", to: "Los Angeles International Airport", stops: 0, price: "$567", roundTrip: true, datedDeparture: true, arrivalDate: "2026-12-30", bags: "1 carry-on bag included. 0 checked bags included.", tim: "JFK-LAX-B6-523-20261230" };
const B6_823 = { ...B6_523, dep: "9:10 PM", arr: "12:33 AM", plus: "+1", arrivalDate: "2026-12-31", duration: "6 hr 23 min", price: "$602", tim: "JFK-LAX-B6-823-20261230" };
const AA_PHX = {
  date: "2026-12-30", dep: "7:15 PM", arr: "8:26 AM", plus: "+1", arrivalDate: "2026-12-31", airline: "American", duration: "16 hr 11 min", from: "John F. Kennedy International Airport", to: "Los Angeles International Airport",
  stops: 1, price: "$692", roundTrip: true, datedDeparture: true, layoverLabel: "Layover (1 of 1) is a 8 hr 43 min layover at Phoenix Sky Harbor International Airport in Phoenix. ",
  segments: () => [
    segment({ from: "JFK", fromName: "John F. Kennedy International Airport", dep: "7:15 PM", to: "PHX", toName: "Phoenix Sky Harbor International Airport", arr: "10:27 PM", travel: "5 hr 12 min", airline: "American", number: "AA 676", aircraft: "Airbus A321", layover: "8 hr 43 min layoverPhoenix (PHX)Long layover" }),
    segment({ from: "PHX", fromName: "Phoenix Sky Harbor International Airport", dep: "7:10 AM", depPlus: "+1", to: "LAX", toName: "Los Angeles International Airport", arr: "8:26 AM", plus: "+1", travel: "1 hr 16 min", airline: "American", number: "AA 774", aircraft: "Airbus A319", operator: "Envoy Air as American Eagle" }),
  ],
};
const AS_SEA = { ...B6_523, airline: "Alaska", dep: "7:00 AM", arr: "2:52 PM", duration: "10 hr 52 min", stops: 1, price: "$830", layoverLabel: "Layover (1 of 1) is a 1 hr 19 min layover at Seattle-Tacoma International Airport in Seattle. ", tim: "JFK-SEA-AS-21-20261230,SEA-LAX-AS-63-20261230" };
const RETURN = { date: "2027-01-03", from: "Los Angeles International Airport", to: "John F. Kennedy International Airport", stops: 0, roundTrip: true, datedDeparture: true, airline: "JetBlue", duration: "5 hr 18 min" };
const B6_1524 = { ...RETURN, dep: "9:00 PM", arr: "5:18 AM", plus: "+1", arrivalDate: "2027-01-04", price: "$567", tim: "LAX-JFK-B6-1524-20270103" };
const B6_324 = { ...RETURN, dep: "11:33 PM", arr: "7:58 AM", plus: "+1", arrivalDate: "2027-01-04", price: "$588", tim: "LAX-JFK-B6-324-20270103" };
const AA_RET = { ...RETURN, airline: "American", dep: "8:00 AM", arr: "6:40 PM", arrivalDate: "2027-01-03", stops: 1, duration: "7 hr 40 min", price: "$701", layoverLabel: "Layover (1 of 1) is a 1 hr 5 min layover at Chicago O'Hare International Airport in Chicago. ", tim: "LAX-ORD-AA-2-20270103,ORD-JFK-AA-300-20270103" };
const ONE_WAY = { trip: "one_way", legs: [["2026-11-18", "CVG", "ORD"]] };
const AA_3495 = { date: "2026-11-18", dep: "11:45 AM", arr: "12:23 PM", airline: "American", operatedBy: "Envoy Air as American Eagle", duration: "1 hr 38 min", from: "Cincinnati/Northern Kentucky International Airport", to: "Chicago O'Hare International Airport", stops: 0, price: "$155", datedDeparture: true, arrivalDate: "2026-11-18", tim: "CVG-ORD-AA-3495-20261118" };
const UA_3429 = { ...AA_3495, dep: "4:20 PM", arr: "4:59 PM", airline: "United", operatedBy: "Republic Airways DBA United Express", duration: "1 hr 39 min", tim: "CVG-ORD-UA-3429-20261118" };

const timFor = spec => spec.tim !== undefined ? spec.tim : itineraryData({ date: spec.date, from: spec.from, to: spec.to, stops: spec.stops, segments: spec.segments() });
const segs = spec => timFor(spec).split(",").map(p => { const [a, b, c, n, d] = p.split("-"); return [a, `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}`, b, c, n]; });

// Simulates the parts of Google Flights' results page the tools rely on. Selection changes the URL and list in place.
class GooglePage {
  constructor({ route = ROUTE, departing = [B6_523, AA_PHX, B6_823], returning = () => [B6_1524, AA_RET, B6_324], pax = [1], timing = {}, onChoose = null, collapsed = [] } = {}) {
    Object.assign(this, { route, pax, returning, timing: { select: 150, firstRows: 400, allRows: 900, announce: 1300, booking: 500, ...timing }, onChoose, selected: [], clicks: [] });
    this.clock = virtualClock();
    this.path = "/travel/flights/search";
    this.live = new El("div", { attrs: { "aria-live": "polite" } });
    this.body = new El("body");
    this.documentElement = new El("html", { children: [this.body] });
    this.document = { documentElement: this.documentElement, body: this.body, querySelector: s => this.documentElement.querySelector(s), querySelectorAll: s => this.documentElement.querySelectorAll(s) };
    this.renderResults("departing", departing.map(s => this.make(s)), collapsed.map(s => this.make(s)));
    this.announce();
  }
  get url() { return `https://www.google.com${this.path}?tfs=${tfs({ ...this.route, pax: this.pax, selected: this.selected })}&hl=en&gl=US&curr=USD`; }
  get location() { const page = this; return { get href() { return page.url; }, get pathname() { return page.path; } }; }
  make(spec) {
    const li = card({ ...spec, segments: spec.segments ? spec.segments() : [], tim: timFor(spec) });
    li.spec = spec;
    li.link.onclick = () => { this.clicks.push(timFor(spec)); this.choose(spec); };
    return li;
  }
  renderResults(leg, cards, collapsed = []) {
    const prefix = leg === "returning" ? "returning" : this.route.trip === "one_way" ? "" : "departing";
    const heading = name => new El("h3", { text: `${name} ${prefix ? prefix + " " : ""}flights` });
    this.top = new El("ul", { children: cards.slice(0, 2) });
    this.other = new El("ul", { children: [...cards.slice(2), ...collapsed.map(c => { c.hidden = true; return c; })] });
    this.more = new El("button", { attrs: { "aria-label": "View more flights" }, hidden: !collapsed.length });
    this.more.onclick = () => { for (const c of collapsed) c.hidden = false; this.more.hidden = true; this.announce(); };
    this.body.children = [];
    for (const child of [this.live, new El("div", { children: [heading("Top"), this.top] }), new El("div", { children: [heading("Other"), this.other, this.more] }), new El("p", { text: `Prices include required taxes + fees for ${this.pax.length} adult${this.pax.length > 1 ? "s" : ""}.` })]) this.body.append(child);
  }
  rows() { return this.documentElement.querySelectorAll("li").filter(li => li.isVisible() && li.spec); }
  announce() { const n = this.rows().length; this.live.text = n ? `${n} result${n > 1 ? "s" : ""} returned.` : "No results returned."; }
  later(ms, fn) { this.clock.setTimeout(fn, ms); }
  choose(spec) {
    if (this.onChoose && this.onChoose(spec) === false) return;
    const t = this.timing;
    const chosen = segs(spec);
    const leg = this.selected.length;
    if (this.route.trip === "round_trip" && leg === 0) {
      this.later(t.select, () => {
        this.selected = [chosen];
        this.live.text = "";
        for (const h of this.documentElement.querySelectorAll("h3")) h.text = h.text.replace("departing", "returning");
        if (t.never) return;
        const rows = this.returning(spec);
        this.later(t.firstRows - t.select, () => { this.renderResults("returning", rows === "none" ? [] : rows.slice(0, 1).map(s => this.make(s))); this.live.text = ""; });
        this.later(t.allRows - t.select, () => { if (rows !== "none") this.renderResults("returning", rows.map(s => this.make(s))); this.live.text = ""; });
        this.later(t.announce - t.select, () => this.announce());
      });
    } else {
      this.later(t.select, () => {
        this.selected = [...this.selected, chosen];
        this.path = "/travel/flights/booking";
        this.body.children = [];
        if (t.never) return;
        this.later(t.booking, () => {
          this.body.append(new El("h2", { text: "Selected flights" }));
          this.body.append(new El("button", { attrs: { "aria-label": "Continue to book with JetBlue for 567 US dollars" } }));
        });
      });
    }
  }
  globals() {
    return { document: this.document, location: this.location, setTimeout: this.clock.setTimeout, Date: this.clock.Date, URL, atob, btoa, TextEncoder, TextDecoder };
  }
}

// Page tools are re-created from execute.toString() in the page, so run them that way: no closure over the tool file.
function tool(name) {
  const [definition] = vm.runInNewContext(`(${source(name)})`, {});
  return definition;
}
async function invoke(page, name, input = {}) {
  const definition = tool(name);
  const execute = vm.runInNewContext(`(${definition.execute.toString()})`, page.globals());
  const out = json(await execute(input));
  validate(definition.tool.outputSchema, out);
  return out;
}
const decode = ref => JSON.parse(Buffer.from(ref.split(".")[1], "base64url").toString("utf8"));

test("list_flights and select_flight are standalone page tools on Google Flights results, and the three readers are identical", () => {
  for (const name of ["list_flights", "select_flight"]) {
    const definition = tool(name);
    assert.equal(definition.kind, "page");
    assert.deepEqual(Array.from(definition.match.url_patterns), ["https://www.google.com/travel/flights/search*"]);
    assert.doesNotThrow(() => new Function(`return (${definition.execute.toString()})`));
  }
  assert.deepEqual(Array.from(tool("select_flight").tool.inputSchema.required), ["selection_ref", "expected_leg"]);
  assert.equal(tool("select_flight").tool.inputSchema.properties.result_index, undefined);
  const block = name => {
    const text = source(name);
    const start = text.indexOf("// google-flights-reader:begin"), end = text.indexOf("// google-flights-reader:end");
    assert.ok(start >= 0 && end > start, `${name} has the shared reader block`);
    return text.slice(start, end).split("\n").map(line => line.trim()).join("\n");
  };
  assert.equal(block("list_flights"), block("search_flights"));
  assert.equal(block("select_flight"), block("search_flights"));
});

test("round trip: list departing, choose the exact connecting outbound, list Google's returns for it, choose a return", async () => {
  const page = new GooglePage();
  const departing = await invoke(page, "list_flights");
  assert.equal(departing.status, "ok");
  assert.equal(departing.leg, "departing");
  assert.equal(departing.trip_type, "round_trip");
  assert.deepEqual(departing.search, { origin: "JFK", destination: "LAX", depart_date: "2026-12-30", return_date: "2027-01-03", passengers: 1, cabin: "economy" });
  assert.deepEqual(departing.leg_route, { origin: "JFK", destination: "LAX", date: "2026-12-30" });
  assert.equal(departing.selected_outbound, null);
  assert.deepEqual(departing.flights.map(f => f.flight_numbers), [["B6 523"], ["AA 676", "AA 774"], ["B6 823"]]);
  const [nonstop, connecting, overnight] = departing.flights;
  assert.deepEqual([nonstop.departure_local, nonstop.arrival_local, nonstop.arrival_day_offset], ["2026-12-30T07:00", "2026-12-30T10:19", 0]);
  assert.deepEqual([overnight.departure_date, overnight.arrival_date, overnight.arrival_local, overnight.arrival_day_offset], ["2026-12-30", "2026-12-31", "2026-12-31T00:33", 1]);
  assert.equal(nonstop.departure_time, "7:00 AM");
  assert.deepEqual([nonstop.carry_on_bags, nonstop.checked_bags], [1, 0]);
  assert.deepEqual(nonstop.price, { amount: 567, currency: "USD", currency_label: "US dollars", scope: "round_trip_total", basis: "round_trip_total_from_this_departing_flight", passengers_included: 1 });
  assert.equal(connecting.details_read, true);
  assert.deepEqual(connecting.segments.map(s => [s.flight_number, s.departure_airport, s.departure_date, s.departure_time, s.arrival_airport, s.arrival_date, s.arrival_time, s.operated_by]), [
    ["AA 676", "JFK", "2026-12-30", "19:15", "PHX", "2026-12-30", "22:27", null],
    ["AA 774", "PHX", "2026-12-31", "07:10", "LAX", "2026-12-31", "08:26", "Envoy Air as American Eagle"],
  ]);
  assert.deepEqual(connecting.layovers, [{ airport: "PHX", airport_name: "Phoenix Sky Harbor International Airport", city: "Phoenix", duration_minutes: 523, change_of_airport_to: null }]);
  assert.deepEqual(decode(connecting.selection_ref), {
    v: 1, search: { trip: "round_trip", legs: [["2026-12-30", "JFK", "LAX"], ["2027-01-03", "LAX", "JFK"]], pax: [1], cabin: 1 }, leg: "departing", outbound: null,
    itinerary: [["JFK", "2026-12-30", "PHX", "AA", "676"], ["PHX", "2026-12-31", "LAX", "AA", "774"]], departure: "2026-12-30T19:15", arrival: "2026-12-31T08:26", price: [692, "US dollars"],
  });

  const chose = await invoke(page, "select_flight", { selection_ref: connecting.selection_ref, expected_leg: "departing" });
  assert.equal(chose.status, "selected");
  assert.equal(chose.next_page, "returning_flights");
  assert.deepEqual(chose.destination, { results: "available", result_count: 3, booking_options_visible: null });
  assert.deepEqual(chose.flight_numbers, ["AA 676", "AA 774"]);
  assert.deepEqual(page.clicks, ["JFK-PHX-AA-676-20261230,PHX-LAX-AA-774-20261231"]);

  const returning = await invoke(page, "list_flights");
  assert.equal(returning.leg, "returning");
  assert.deepEqual(returning.leg_route, { origin: "LAX", destination: "JFK", date: "2027-01-03" });
  assert.deepEqual(returning.selected_outbound, {
    source: "results_url", flight_numbers: ["AA 676", "AA 774"],
    segments: [
      { departure_airport: "JFK", departure_date: "2026-12-30", arrival_airport: "PHX", marketing_carrier_code: "AA", flight_number: "AA 676" },
      { departure_airport: "PHX", departure_date: "2026-12-31", arrival_airport: "LAX", marketing_carrier_code: "AA", flight_number: "AA 774" },
    ],
  });
  assert.deepEqual(returning.flights.map(f => [f.origin, f.destination, f.departure_date, f.arrival_date]), [["LAX", "JFK", "2027-01-03", "2027-01-04"], ["LAX", "JFK", "2027-01-03", "2027-01-03"], ["LAX", "JFK", "2027-01-03", "2027-01-04"]]);
  assert.equal(returning.flights[0].price.basis, "round_trip_total_with_selected_departing_flight");
  const ret = decode(returning.flights[1].selection_ref);
  assert.equal(ret.leg, "returning");
  assert.deepEqual(ret.outbound, decode(connecting.selection_ref).itinerary);
  assert.deepEqual(returning.flights[1].layovers.map(l => l.airport), ["ORD"]);

  const booked = await invoke(page, "select_flight", { selection_ref: returning.flights[1].selection_ref, expected_leg: "returning" });
  assert.equal(booked.status, "selected");
  assert.equal(booked.next_page, "booking_options");
  assert.deepEqual(booked.destination, { results: "not_applicable", result_count: null, booking_options_visible: true });
  assert.equal(page.clicks.length, 2);
  assert.equal(page.path, "/travel/flights/booking");
});

test("one-way: list keeps one-way prices and selection opens booking options", async () => {
  const page = new GooglePage({ route: ONE_WAY, departing: [AA_3495, UA_3429] });
  const list = await invoke(page, "list_flights", { sort_by: "departure" });
  assert.equal(list.trip_type, "one_way");
  assert.equal(list.search.return_date, null);
  assert.deepEqual(list.flights[0].price, { amount: 155, currency: "USD", currency_label: "US dollars", scope: "one_way", basis: "one_way_total", passengers_included: 1 });
  assert.deepEqual(list.flights.map(f => [f.flight_numbers[0], f.operated_by]), [["AA 3495", "Envoy Air as American Eagle"], ["UA 3429", "Republic Airways DBA United Express"]]);
  const out = await invoke(page, "select_flight", { selection_ref: list.flights[1].selection_ref, expected_leg: "departing" });
  assert.equal(out.status, "selected");
  assert.equal(out.next_page, "booking_options");
  assert.deepEqual(page.clicks, ["CVG-ORD-UA-3429-20261118"]);
});

test("a returning list that is still rendering is not_ready, never a mislabeled outbound list", async () => {
  // Google has recorded the outbound and switched the heading, but the departing rows are still on screen.
  const page = new GooglePage({ timing: { never: true } });
  page.choose(AA_PHX);
  await new Promise(resolve => page.clock.setTimeout(resolve, 200));
  assert.ok(page.rows().length && page.rows().every(li => li.spec.date === "2026-12-30"));
  const out = await invoke(page, "list_flights");
  assert.equal(out.status, "not_ready");
  assert.ok(out.reasons.includes("previous_leg_rows"));
});

test("a returning list read during progressive rendering waits for Google's announcement and returns every row", async () => {
  const page = new GooglePage({ timing: { firstRows: 400, allRows: 3000, announce: 3500 } });
  page.choose(AA_PHX);
  await new Promise(resolve => page.clock.setTimeout(resolve, 500));
  assert.equal(page.rows().length, 1);
  const out = await invoke(page, "list_flights");
  assert.equal(out.status, "ok");
  assert.equal(out.total_rows, 3);
  assert.equal(out.announced_results, 3);
  assert.deepEqual(out.warnings, ["3 row(s) have no readable flight-details panel; their segment times, aircraft and operators are null."]);
  assert.deepEqual(out.flights[0].segments.map(s => [s.flight_number, s.departure_time, s.arrival_date, s.arrival_time]), [["B6 1524", "21:00", "2027-01-04", "05:18"]]);
});

test("a settled no-results return page is no_results, distinct from loading; selection reports it", async () => {
  const page = new GooglePage({ returning: () => "none" });
  const [nonstop] = (await invoke(page, "list_flights")).flights;
  const chose = await invoke(page, "select_flight", { selection_ref: nonstop.selection_ref, expected_leg: "departing" });
  assert.equal(chose.status, "selected");
  assert.deepEqual(chose.destination, { results: "none", result_count: 0, booking_options_visible: null });
  const list = await invoke(page, "list_flights");
  assert.equal(list.status, "no_results");
  assert.equal(list.leg, "returning");
  assert.deepEqual(list.flights, []);
  assert.deepEqual(list.selected_outbound.flight_numbers, ["B6 523"]);

  const loading = new GooglePage({ timing: { never: true } });
  loading.choose(B6_523);
  await new Promise(resolve => loading.clock.setTimeout(resolve, 200));
  loading.renderResults("returning", []);
  loading.live.text = "";
  const pending = await invoke(loading, "list_flights");
  assert.equal(pending.status, "not_ready");
  assert.ok(pending.reasons.includes("no_rows_yet"));
});

test("without Google's results announcement a stable list is read with a warning; an unannounced heading change alone is not enough", async () => {
  const page = new GooglePage();
  page.live.text = "";
  const out = await invoke(page, "list_flights");
  assert.equal(out.status, "ok");
  assert.equal(out.announced_results, null);
  assert.match(out.warnings[0], /Google announced no results but 3 rows are visible/);
});

test("limits, collapsed rows and unreadable cards are disclosed; filters and sorting act before limit", async () => {
  const unreadable = { ...B6_523, dep: "6:00 AM", arr: "9:15 AM", tim: null, price: "$642" };
  const page = new GooglePage({ departing: [B6_523, AA_PHX, unreadable, B6_823], collapsed: [AS_SEA] });
  const all = await invoke(page, "list_flights");
  assert.equal(page.more.clicks, 1);
  assert.equal(all.total_rows, 5);
  assert.equal(all.skipped_rows, 1);
  assert.match(all.warnings[0], /^Skipped 1 row\(s\) without a readable itinerary: row 2 \(itinerary data\)/);
  assert.deepEqual(all.flights.map(f => f.result_index), [0, 1, 3, 4]);
  const limited = await invoke(page, "list_flights", { sort_by: "price", limit: 2 });
  assert.deepEqual(limited.flights.map(f => f.price.amount), [567, 602]);
  assert.equal(limited.matching_rows, 4);
  assert.equal(limited.has_more, true);
  const nonstop = await invoke(page, "list_flights", { max_stops: 0, limit: 1 });
  assert.deepEqual(nonstop.flights.map(f => f.flight_numbers), [["B6 523"]]);
  assert.equal(nonstop.matching_rows, 2);
  const alaska = await invoke(page, "list_flights", { airline: "AS" });
  assert.deepEqual(alaska.flights.map(f => f.flight_numbers), [["AS 21", "AS 63"]]);
});

test("max_stops filters returning rows too", async () => {
  const page = new GooglePage();
  page.choose(B6_523);
  const out = await invoke(page, "list_flights", { max_stops: 0 });
  assert.equal(out.leg, "returning");
  assert.deepEqual(out.flights.map(f => f.flight_numbers[0]), ["B6 1524", "B6 324"]);
});

test("references are stable across sorting, detail expansion and re-rendered order; selection follows identity, not position", async () => {
  const page = new GooglePage();
  const first = await invoke(page, "list_flights", { sort_by: "price" });
  const again = await invoke(page, "list_flights");
  const byNumber = list => Object.fromEntries(list.flights.map(f => [f.flight_numbers.join("+"), f.selection_ref]));
  assert.deepEqual(byNumber(first), byNumber(again));
  const target = again.flights.find(f => f.flight_numbers[0] === "B6 823");
  page.renderResults("departing", [B6_823, AA_PHX, B6_523].map(s => page.make(s)));
  page.announce();
  const out = await invoke(page, "select_flight", { selection_ref: target.selection_ref, expected_leg: "departing" });
  assert.equal(out.status, "selected");
  assert.deepEqual(page.clicks, ["JFK-LAX-B6-823-20261230"]);
});

const refusals = [
  ["a malformed reference", async () => ({ selection_ref: "gf1.abc.0000000g", expected_leg: "departing" }), "invalid_input"],
  ["an edited reference", async page => { const ref = (await invoke(page, "list_flights")).flights[0].selection_ref; return { selection_ref: ref.slice(0, -1) + (ref.endsWith("0") ? "1" : "0"), expected_leg: "departing" }; }, "invalid_input"],
  ["a legacy result_index", async () => ({ result_index: 0, expected_leg: "departing" }), "invalid_input"],
  ["a reference whose leg contradicts expected_leg", async page => ({ selection_ref: (await invoke(page, "list_flights")).flights[0].selection_ref, expected_leg: "returning" }), "wrong_leg"],
  ["a reference from another search", async () => {
    const other = new GooglePage({ route: { trip: "round_trip", legs: [["2026-12-30", "JFK", "LAX"], ["2027-01-04", "LAX", "JFK"]] } });
    return { selection_ref: (await invoke(other, "list_flights")).flights[0].selection_ref, expected_leg: "departing" };
  }, "wrong_search"],
  ["a reference for a different traveler count", async () => {
    const other = new GooglePage({ pax: [1, 1] });
    return { selection_ref: (await invoke(other, "list_flights")).flights[0].selection_ref, expected_leg: "departing" };
  }, "wrong_search"],
  ["an itinerary no longer listed", async page => {
    const ref = (await invoke(page, "list_flights")).flights[2].selection_ref;
    page.renderResults("departing", [B6_523, AA_PHX].map(s => page.make(s)));
    page.announce();
    return { selection_ref: ref, expected_leg: "departing" };
  }, "not_found"],
  ["a duplicated itinerary", async page => {
    const ref = (await invoke(page, "list_flights")).flights[0].selection_ref;
    page.renderResults("departing", [B6_523, AA_PHX, B6_523].map(s => page.make(s)));
    page.announce();
    return { selection_ref: ref, expected_leg: "departing" };
  }, "ambiguous"],
];
for (const [name, build, status] of refusals) {
  test(`select_flight refuses ${name} without clicking`, async () => {
    const page = new GooglePage();
    const input = await build(page);
    const out = await invoke(page, "select_flight", input);
    assert.equal(out.status, status);
    assert.equal(out.clicked, false);
    assert.deepEqual(page.clicks, []);
  });
}

test("select_flight refuses departing references on the returning page and returns for another outbound, without clicking", async () => {
  const page = new GooglePage();
  const departing = (await invoke(page, "list_flights")).flights;
  await invoke(page, "select_flight", { selection_ref: departing[0].selection_ref, expected_leg: "departing" });
  const returnsForB6 = (await invoke(page, "list_flights")).flights;
  assert.equal(page.clicks.length, 1);

  const repeat = await invoke(page, "select_flight", { selection_ref: departing[0].selection_ref, expected_leg: "departing" });
  assert.equal(repeat.status, "wrong_leg");
  assert.equal(repeat.current.leg, "returning");
  assert.deepEqual(repeat.current.selected_flight_numbers, [["B6 523"], []]);

  const other = new GooglePage();
  const otherDeparting = (await invoke(other, "list_flights")).flights;
  await invoke(other, "select_flight", { selection_ref: otherDeparting[1].selection_ref, expected_leg: "departing" });
  const returnsForAA = (await invoke(other, "list_flights")).flights;
  const mismatch = await invoke(page, "select_flight", { selection_ref: returnsForAA[0].selection_ref, expected_leg: "returning" });
  assert.equal(mismatch.status, "outbound_mismatch");
  assert.equal(page.clicks.length, 1);
  assert.notEqual(returnsForAA[0].selection_ref, returnsForB6[0].selection_ref);
});

test("a changed price is refused with the current price and a fresh reference that then selects", async () => {
  const page = new GooglePage();
  const [nonstop] = (await invoke(page, "list_flights")).flights;
  page.renderResults("departing", [{ ...B6_523, price: "$611" }, AA_PHX, B6_823].map(s => page.make(s)));
  page.announce();
  const out = await invoke(page, "select_flight", { selection_ref: nonstop.selection_ref, expected_leg: "departing" });
  assert.equal(out.status, "price_changed");
  assert.equal(out.clicked, false);
  assert.deepEqual(out.current_price, { amount: 611, currency_label: "US dollars" });
  assert.deepEqual(page.clicks, []);
  assert.deepEqual(decode(out.selection_ref).price, [611, "US dollars"]);
  const retry = await invoke(page, "select_flight", { selection_ref: out.selection_ref, expected_leg: "departing" });
  assert.equal(retry.status, "selected");
  assert.equal(page.clicks.length, 1);
});

test("unknown click outcomes are unconfirmed, never selected, and the tool clicks once", async () => {
  const noop = new GooglePage({ onChoose: () => false });
  const [first] = (await invoke(noop, "list_flights")).flights;
  const ignored = await invoke(noop, "select_flight", { selection_ref: first.selection_ref, expected_leg: "departing" });
  assert.equal(ignored.status, "unconfirmed");
  assert.equal(ignored.selection_observed, false);
  assert.equal(ignored.clicked, true);
  assert.equal(noop.clicks.length, 1);

  const slow = new GooglePage({ timing: { never: true } });
  const [f] = (await invoke(slow, "list_flights")).flights;
  const pending = await invoke(slow, "select_flight", { selection_ref: f.selection_ref, expected_leg: "departing" });
  assert.equal(pending.status, "unconfirmed");
  assert.equal(pending.selection_observed, true);
  assert.deepEqual(pending.current.selected_flight_numbers, [["B6 523"], []]);
  assert.equal(slow.clicks.length, 1);

  const stuck = new GooglePage({ route: ONE_WAY, departing: [AA_3495], timing: { never: true } });
  const [g] = (await invoke(stuck, "list_flights")).flights;
  const booking = await invoke(stuck, "select_flight", { selection_ref: g.selection_ref, expected_leg: "departing" });
  assert.equal(booking.status, "unconfirmed");
  assert.equal(booking.selection_observed, true);
  assert.equal(booking.current.page, "booking");
});

test("a slow return selection is confirmed, not mistaken for a mismatch with the already-recorded departing flight", async () => {
  const page = new GooglePage();
  const [nonstop] = (await invoke(page, "list_flights")).flights;
  await invoke(page, "select_flight", { selection_ref: nonstop.selection_ref, expected_leg: "departing" });
  const returning = (await invoke(page, "list_flights")).flights;
  page.timing.select = 2000;
  const out = await invoke(page, "select_flight", { selection_ref: returning[0].selection_ref, expected_leg: "returning" });
  assert.equal(out.status, "selected");
  assert.equal(out.next_page, "booking_options");
  assert.equal(page.clicks.length, 2);
});

test("a different flight recorded by Google is selection_mismatch", async () => {
  const page = new GooglePage();
  page.onChoose = () => { page.onChoose = null; page.choose(B6_823); return false; };
  const [nonstop] = (await invoke(page, "list_flights")).flights;
  const out = await invoke(page, "select_flight", { selection_ref: nonstop.selection_ref, expected_leg: "departing" });
  assert.equal(out.status, "selection_mismatch");
  assert.match(out.error_message, /Google recorded B6 823 instead of B6 523/);
});

test("select_flight waits for a loading page and refuses when it never settles", async () => {
  const page = new GooglePage();
  const [nonstop] = (await invoke(page, "list_flights")).flights;
  page.body.append(new El("div", { attrs: { role: "progressbar" } }));
  const out = await invoke(page, "select_flight", { selection_ref: nonstop.selection_ref, expected_leg: "departing" });
  assert.equal(out.status, "not_ready");
  assert.deepEqual(page.clicks, []);
});

test("list_flights rejects select-style input and pages that are not one-way or round-trip results", async () => {
  const page = new GooglePage();
  assert.equal((await invoke(page, "list_flights", { result_index: 1 })).status, "error");
  page.path = "/travel/flights/booking";
  assert.equal((await invoke(page, "list_flights")).status, "error");
});
