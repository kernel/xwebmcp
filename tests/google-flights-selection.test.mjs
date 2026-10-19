import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { El, segment } from "./google-flights-dom.mjs";
import { GooglePage, decode, invoke, tool } from "./google-flights-page.mjs";

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

const page = (options = {}) => new GooglePage({ route: ROUTE, departing: [B6_523, AA_PHX, B6_823], returning: () => [B6_1524, AA_RET, B6_324], ...options });

test("list_flights and select_flight are standalone page tools on Google Flights results, inlining the shared lib/ snippets", () => {
  for (const name of ["list_flights", "select_flight"]) {
    const definition = tool(name);
    assert.equal(definition.kind, "page");
    assert.deepEqual(Array.from(definition.match.url_patterns), ["https://www.google.com/travel/flights/search*"]);
    assert.doesNotThrow(() => new Function(`return (${definition.execute.toString()})`));
    assert.match(readFileSync(new URL(`../domains/google.com/${name}.js`, import.meta.url), "utf8"), /\/\/ @xwebmcp-inline lib\/google-flights-read\.js/);
  }
  assert.deepEqual(Array.from(tool("select_flight").tool.inputSchema.required), ["selection_ref", "expected_leg"]);
  assert.equal(tool("select_flight").tool.inputSchema.properties.result_index, undefined);
});

test("round trip: list departing, choose the exact connecting outbound, list Google's returns for it, choose a return", async () => {
  const p = page();
  const departing = await invoke(p, "list_flights");
  assert.equal(departing.status, "ok");
  assert.equal(departing.page.leg, "departing");
  assert.equal(departing.page.trip_type, "round_trip");
  assert.deepEqual(departing.page.search, { origin: "JFK", destination: "LAX", depart_date: "2026-12-30", return_date: "2027-01-03", passengers: 1, cabin: "economy" });
  assert.deepEqual(departing.page.leg_route, { origin: "JFK", destination: "LAX", date: "2026-12-30" });
  assert.equal(departing.page.selected_outbound, null);
  assert.deepEqual(departing.flights.map(f => [f.position, f.section, f.flight_numbers]), [[1, "Top departing flights", ["B6 523"]], [2, "Top departing flights", ["AA 676", "AA 774"]], [3, "Other departing flights", ["B6 823"]]]);
  const [nonstop, connecting, overnight] = departing.flights;
  assert.deepEqual([nonstop.departure_local, nonstop.arrival_local, nonstop.arrival_day_offset], ["2026-12-30T07:00", "2026-12-30T10:19", 0]);
  assert.deepEqual([overnight.departure_date, overnight.arrival_date, overnight.arrival_local, overnight.arrival_day_offset], ["2026-12-30", "2026-12-31", "2026-12-31T00:33", 1]);
  assert.deepEqual([nonstop.departure_time, nonstop.departure_time_text], ["07:00", "7:00 AM"]);
  assert.deepEqual([nonstop.carry_on_bags, nonstop.checked_bags], [1, 0]);
  assert.deepEqual(nonstop.price, { amount: 567, currency: "USD", currency_label: "US dollars", display_text: "$567", scope: "round_trip_total", basis: "round_trip_total_from_this_departing_flight", passengers_included: 1 });
  // Lists never open detail panels: segment times other than the itinerary's ends stay unknown.
  assert.equal(connecting.detail_level, "summary");
  assert.deepEqual(connecting.segments.map(s => [s.flight_number, s.departure_airport, s.departure_date, s.departure_time, s.arrival_airport, s.arrival_date, s.arrival_time, s.aircraft]), [
    ["AA 676", "JFK", "2026-12-30", "19:15", "PHX", null, null, null],
    ["AA 774", "PHX", "2026-12-31", null, "LAX", "2026-12-31", "08:26", null],
  ]);
  assert.deepEqual(connecting.layovers, [{ airport: "PHX", airport_name: "Phoenix Sky Harbor International Airport", city: "Phoenix", duration_minutes: 523, change_of_airport_to: null }]);
  assert.deepEqual(decode(connecting.selection_ref), {
    v: 1, search: { trip: "round_trip", legs: [["2026-12-30", "JFK", "LAX"], ["2027-01-03", "LAX", "JFK"]], pax: [1], cabin: 1 }, leg: "departing", outbound: null,
    itinerary: [["JFK", "2026-12-30", "PHX", "AA", "676"], ["PHX", "2026-12-31", "LAX", "AA", "774"]], departure: "2026-12-30T19:15", arrival: "2026-12-31T08:26", price: [692, "US dollars"],
  });

  const chose = await invoke(p, "select_flight", { selection_ref: connecting.selection_ref, expected_leg: "departing" });
  assert.equal(chose.status, "selected");
  assert.equal(chose.next_page, "returning_flights");
  assert.deepEqual(chose.destination, { results: "available", result_count: 3, booking_options_visible: null });
  assert.deepEqual(chose.flight_numbers, ["AA 676", "AA 774"]);
  assert.deepEqual(p.clicks, ["JFK-PHX-AA-676-20261230,PHX-LAX-AA-774-20261231"]);
  assert.equal(chose.available_actions.find(a => a.tool === "select_flight").input.expected_leg, "returning");

  const returning = await invoke(p, "list_flights");
  assert.equal(returning.page.leg, "returning");
  assert.deepEqual(returning.page.leg_route, { origin: "LAX", destination: "JFK", date: "2027-01-03" });
  assert.deepEqual(returning.page.selected_outbound, {
    source: "results_url", flight_numbers: ["AA 676", "AA 774"],
    segments: [
      { departure_airport: "JFK", departure_date: "2026-12-30", arrival_airport: "PHX", marketing_carrier_code: "AA", flight_number: "AA 676" },
      { departure_airport: "PHX", departure_date: "2026-12-31", arrival_airport: "LAX", marketing_carrier_code: "AA", flight_number: "AA 774" },
    ],
  });
  assert.deepEqual(returning.view, { available: false, active: null, choices: [], note: "Google shows no Best/Cheapest tabs on this returning list." });
  assert.deepEqual(returning.flights.map(f => [f.origin, f.destination, f.departure_date, f.arrival_date]), [["LAX", "JFK", "2027-01-03", "2027-01-04"], ["LAX", "JFK", "2027-01-03", "2027-01-03"], ["LAX", "JFK", "2027-01-03", "2027-01-04"]]);
  assert.equal(returning.flights[0].price.basis, "round_trip_total_with_selected_departing_flight");
  const ret = decode(returning.flights[1].selection_ref);
  assert.equal(ret.leg, "returning");
  assert.deepEqual(ret.outbound, decode(connecting.selection_ref).itinerary);
  assert.deepEqual(returning.flights[1].layovers.map(l => l.airport), ["ORD"]);

  const booked = await invoke(p, "select_flight", { selection_ref: returning.flights[1].selection_ref, expected_leg: "returning" });
  assert.equal(booked.status, "selected");
  assert.equal(booked.next_page, "booking_options");
  assert.deepEqual(booked.destination, { results: "not_applicable", result_count: null, booking_options_visible: true });
  assert.equal(p.clicks.length, 2);
  assert.equal(p.path, "/travel/flights/booking");
  assert.deepEqual(booked.available_actions.map(a => [a.tool, a.enabled, a.input]), [
    ["get_booking_options", true, {}],
    ["continue_to_airline", true, null],
    ["search_flights", true, { origin: "JFK", destination: "LAX", depart_date: "2026-12-30", trip_type: "round_trip", return_date: "2027-01-03" }],
  ]);
  assert.match(booked.available_actions[1].requires, /^seller \(required\)/);
});

test("one-way: list keeps one-way prices and selection opens booking options", async () => {
  const p = new GooglePage({ route: ONE_WAY, departing: [AA_3495, UA_3429] });
  const list = await invoke(p, "list_flights");
  assert.equal(list.page.trip_type, "one_way");
  assert.equal(list.page.search.return_date, null);
  assert.deepEqual(list.flights[0].price, { amount: 155, currency: "USD", currency_label: "US dollars", display_text: "$155", scope: "one_way", basis: "one_way_total", passengers_included: 1 });
  assert.deepEqual(list.flights.map(f => [f.flight_numbers[0], f.operated_by]), [["AA 3495", "Envoy Air as American Eagle"], ["UA 3429", "Republic Airways DBA United Express"]]);
  const out = await invoke(p, "select_flight", { selection_ref: list.flights[1].selection_ref, expected_leg: "departing" });
  assert.equal(out.status, "selected");
  assert.equal(out.next_page, "booking_options");
  assert.deepEqual(p.clicks, ["CVG-ORD-UA-3429-20261118"]);
});

test("a returning list that is still rendering is not_ready, never a mislabeled outbound list", async () => {
  // Google has recorded the outbound and switched the heading, but the departing rows are still on screen.
  const p = page({ timing: { never: true } });
  p.choose(AA_PHX);
  await p.wait(200);
  assert.ok(p.rows().length && p.rows().every(li => li.spec.date === "2026-12-30"));
  const out = await invoke(p, "list_flights");
  assert.equal(out.status, "not_ready");
  assert.ok(out.page.unsettled_reasons.includes("previous_leg_rows"));
  assert.deepEqual(out.flights, []);
  assert.equal(out.available_actions.find(a => a.tool === "select_flight").enabled, false);
});

test("a returning list read during progressive rendering waits for Google's announcement and returns every row", async () => {
  const p = page({ timing: { firstRows: 400, allRows: 3000, announce: 3500 } });
  p.choose(AA_PHX);
  await p.wait(500);
  assert.equal(p.rows().length, 1);
  const out = await invoke(p, "list_flights");
  assert.equal(out.status, "ok");
  assert.equal(out.results.rendered_rows, 3);
  assert.equal(out.results.announced_rows, 3);
  assert.deepEqual(out.flights[0].segments.map(s => [s.flight_number, s.departure_time, s.arrival_date, s.arrival_time]), [["B6 1524", "21:00", "2027-01-04", "05:18"]]);
});

test("a settled no-results return page is no_results, distinct from loading; selection reports it", async () => {
  const p = page({ returning: () => "none" });
  const [nonstop] = (await invoke(p, "list_flights")).flights;
  const chose = await invoke(p, "select_flight", { selection_ref: nonstop.selection_ref, expected_leg: "departing" });
  assert.equal(chose.status, "selected");
  assert.deepEqual(chose.destination, { results: "none", result_count: 0, booking_options_visible: null });
  const list = await invoke(p, "list_flights");
  assert.equal(list.status, "no_results");
  assert.equal(list.page.leg, "returning");
  assert.deepEqual(list.flights, []);
  assert.deepEqual(list.page.selected_outbound.flight_numbers, ["B6 523"]);

  const loading = page({ timing: { never: true } });
  loading.choose(B6_523);
  await loading.wait(200);
  loading.returningRows = [];
  loading.render();
  loading.live.text = "";
  const pending = await invoke(loading, "list_flights");
  assert.equal(pending.status, "not_ready");
  assert.ok(pending.page.unsettled_reasons.includes("no_rows_yet"));
});

test("without Google's results announcement a stable list is read with a warning", async () => {
  const p = page();
  p.live.text = "";
  const out = await invoke(p, "list_flights");
  assert.equal(out.status, "ok");
  assert.equal(out.results.announced_rows, null);
  assert.match(out.warnings[0], /Google announced no result count; the 3 rows were read/);
});

test("an announced count that disagrees with the visible rows (and no collapsed rows) is never settled: list is not_ready and selection does not click", async () => {
  const p = page();
  const [nonstop] = (await invoke(p, "list_flights")).flights;
  p.live.text = "4 results returned.";
  const list = await invoke(p, "list_flights");
  assert.equal(list.status, "not_ready");
  assert.ok(list.page.unsettled_reasons.includes("announced_count_mismatch"));
  const out = await invoke(p, "select_flight", { selection_ref: nonstop.selection_ref, expected_leg: "departing" });
  assert.equal(out.status, "not_ready");
  assert.deepEqual(p.clicks, []);
});

test("unreadable rows are skipped and disclosed, never returned or used to infer absence", async () => {
  const unreadable = { ...B6_523, dep: "6:00 AM", arr: "9:15 AM", tim: null, price: "$642" };
  const p = page({ departing: [B6_523, AA_PHX, unreadable, B6_823] });
  const all = await invoke(p, "list_flights");
  assert.equal(all.results.rendered_rows, 4);
  assert.equal(all.results.readable_rows, 3);
  assert.deepEqual(all.results.skipped_rows, [{ position: 3, missing: ["itinerary data"] }]);
  assert.match(all.warnings[0], /^Skipped 1 row\(s\) without a readable itinerary: position 3 \(itinerary data\)/);
  assert.deepEqual(all.flights.map(f => f.position), [1, 2, 4]);
});

test("references are stable across re-rendered order; selection follows identity, not position", async () => {
  const p = page();
  const first = await invoke(p, "list_flights");
  const target = first.flights.find(f => f.flight_numbers[0] === "B6 823");
  p.lists.best.initial = [B6_823, AA_PHX, B6_523];
  p.render();
  p.announce();
  const again = await invoke(p, "list_flights");
  const byNumber = list => Object.fromEntries(list.flights.map(f => [f.flight_numbers.join("+"), f.selection_ref]));
  assert.deepEqual(byNumber(first), byNumber(again));
  assert.equal(again.flights.find(f => f.flight_numbers[0] === "B6 823").position, 1);
  const out = await invoke(p, "select_flight", { selection_ref: target.selection_ref, expected_leg: "departing" });
  assert.equal(out.status, "selected");
  assert.deepEqual(p.clicks, ["JFK-LAX-B6-823-20261230"]);
});

const refusals = [
  ["a malformed reference", async () => ({ selection_ref: "gf1.abc.0000000g", expected_leg: "departing" }), "invalid_input"],
  ["an edited reference", async p => { const ref = (await invoke(p, "list_flights")).flights[0].selection_ref; return { selection_ref: ref.slice(0, -1) + (ref.endsWith("0") ? "1" : "0"), expected_leg: "departing" }; }, "invalid_input"],
  ["a legacy result_index", async () => ({ result_index: 0, expected_leg: "departing" }), "invalid_input"],
  ["a reference whose leg contradicts expected_leg", async p => ({ selection_ref: (await invoke(p, "list_flights")).flights[0].selection_ref, expected_leg: "returning" }), "wrong_leg"],
  ["a reference from another search", async () => {
    const other = page({ route: { trip: "round_trip", legs: [["2026-12-30", "JFK", "LAX"], ["2027-01-04", "LAX", "JFK"]] } });
    return { selection_ref: (await invoke(other, "list_flights")).flights[0].selection_ref, expected_leg: "departing" };
  }, "wrong_search"],
  ["a reference for a different traveler count", async () => {
    const other = page({ pax: [1, 1] });
    return { selection_ref: (await invoke(other, "list_flights")).flights[0].selection_ref, expected_leg: "departing" };
  }, "wrong_search"],
  ["an itinerary no longer listed", async p => {
    const ref = (await invoke(p, "list_flights")).flights[2].selection_ref;
    p.lists.best.initial = [B6_523, AA_PHX];
    p.render();
    p.announce();
    return { selection_ref: ref, expected_leg: "departing" };
  }, "not_found"],
  ["a duplicated itinerary", async p => {
    const ref = (await invoke(p, "list_flights")).flights[0].selection_ref;
    p.lists.best.initial = [B6_523, AA_PHX, { ...B6_523, price: "$568" }];
    p.render();
    p.announce();
    return { selection_ref: ref, expected_leg: "departing" };
  }, "ambiguous"],
];
for (const [name, build, status] of refusals) {
  test(`select_flight refuses ${name} without clicking, with recovery actions`, async () => {
    const p = page();
    const input = await build(p);
    const out = await invoke(p, "select_flight", input);
    assert.equal(out.status, status);
    assert.equal(out.clicked, false);
    assert.deepEqual(p.clicks, []);
    assert.ok(out.available_actions.some(a => a.tool === "list_flights" && a.enabled));
  });
}

test("a reference hidden behind 'View more flights' is not_found without expanding; the recovery steps expand once and then select it", async () => {
  const p = page({ collapsed: [AS_SEA] });
  const expanded = page({ collapsed: [AS_SEA] });
  await invoke(expanded, "show_more_flights");
  const hidden = (await invoke(expanded, "list_flights")).flights.find(f => f.flight_numbers[0] === "AS 21");
  const out = await invoke(p, "select_flight", { selection_ref: hidden.selection_ref, expected_leg: "departing" });
  assert.equal(out.status, "not_found");
  assert.match(out.error_message, /call show_more_flights/);
  assert.equal(p.moreClicks, undefined);
  assert.deepEqual(p.clicks, []);
  assert.match(out.next_steps[0], /^show_more_flights/);
  const more = out.available_actions.find(a => a.tool === "show_more_flights");
  assert.deepEqual([more.enabled, more.input], [true, {}]);
  const shown = await invoke(p, "show_more_flights", more.input);
  assert.equal(shown.status, "changed");
  const selected = await invoke(p, "select_flight", { selection_ref: hidden.selection_ref, expected_leg: "departing" });
  assert.equal(selected.status, "selected");
  assert.deepEqual(p.clicks, ["JFK-SEA-AS-21-20261230,SEA-LAX-AS-63-20261230"]);
});

test("select_flight refuses departing references on the returning page and returns for another outbound, without clicking", async () => {
  const p = page();
  const departing = (await invoke(p, "list_flights")).flights;
  await invoke(p, "select_flight", { selection_ref: departing[0].selection_ref, expected_leg: "departing" });
  const returnsForB6 = (await invoke(p, "list_flights")).flights;
  assert.equal(p.clicks.length, 1);

  const repeat = await invoke(p, "select_flight", { selection_ref: departing[0].selection_ref, expected_leg: "departing" });
  assert.equal(repeat.status, "wrong_leg");
  assert.equal(repeat.current.leg, "returning");
  assert.deepEqual(repeat.current.selected_flight_numbers, [["B6 523"], []]);

  const other = page();
  const otherDeparting = (await invoke(other, "list_flights")).flights;
  await invoke(other, "select_flight", { selection_ref: otherDeparting[1].selection_ref, expected_leg: "departing" });
  const returnsForAA = (await invoke(other, "list_flights")).flights;
  const mismatch = await invoke(p, "select_flight", { selection_ref: returnsForAA[0].selection_ref, expected_leg: "returning" });
  assert.equal(mismatch.status, "outbound_mismatch");
  assert.equal(p.clicks.length, 1);
  assert.notEqual(returnsForAA[0].selection_ref, returnsForB6[0].selection_ref);
});

test("a changed price is refused with the current price and a fresh reference that the advertised action then selects", async () => {
  const p = page();
  const [nonstop] = (await invoke(p, "list_flights")).flights;
  p.lists.best.initial = [{ ...B6_523, price: "$611" }, AA_PHX, B6_823];
  p.render();
  p.announce();
  const out = await invoke(p, "select_flight", { selection_ref: nonstop.selection_ref, expected_leg: "departing" });
  assert.equal(out.status, "price_changed");
  assert.equal(out.clicked, false);
  assert.deepEqual(out.current_price, { amount: 611, currency_label: "US dollars" });
  assert.deepEqual(p.clicks, []);
  assert.deepEqual(decode(out.selection_ref).price, [611, "US dollars"]);
  const action = out.available_actions.find(a => a.tool === "select_flight");
  assert.deepEqual(action.input, { selection_ref: out.selection_ref, expected_leg: "departing" });
  const retry = await invoke(p, "select_flight", action.input);
  assert.equal(retry.status, "selected");
  assert.equal(p.clicks.length, 1);
});

test("unknown click outcomes are unconfirmed, never selected, and the tool clicks once", async () => {
  const noop = page({ onChoose: () => false });
  const [first] = (await invoke(noop, "list_flights")).flights;
  const ignored = await invoke(noop, "select_flight", { selection_ref: first.selection_ref, expected_leg: "departing" });
  assert.equal(ignored.status, "unconfirmed");
  assert.equal(ignored.selection_observed, false);
  assert.equal(ignored.clicked, true);
  assert.equal(noop.clicks.length, 1);

  const slow = page({ timing: { never: true } });
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
  const p = page();
  const [nonstop] = (await invoke(p, "list_flights")).flights;
  await invoke(p, "select_flight", { selection_ref: nonstop.selection_ref, expected_leg: "departing" });
  const returning = (await invoke(p, "list_flights")).flights;
  p.timing.select = 2000;
  const out = await invoke(p, "select_flight", { selection_ref: returning[0].selection_ref, expected_leg: "returning" });
  assert.equal(out.status, "selected");
  assert.equal(out.next_page, "booking_options");
  assert.equal(p.clicks.length, 2);
});

test("a different flight recorded by Google is selection_mismatch", async () => {
  const p = page();
  p.onChoose = () => { p.onChoose = null; p.choose(B6_823); return false; };
  const [nonstop] = (await invoke(p, "list_flights")).flights;
  const out = await invoke(p, "select_flight", { selection_ref: nonstop.selection_ref, expected_leg: "departing" });
  assert.equal(out.status, "selection_mismatch");
  assert.match(out.error_message, /Google recorded B6 823 instead of B6 523/);
});

test("select_flight waits for a loading page and refuses when it never settles", async () => {
  const p = page();
  const [nonstop] = (await invoke(p, "list_flights")).flights;
  p.body.append(new El("div", { attrs: { role: "progressbar" } }));
  const out = await invoke(p, "select_flight", { selection_ref: nonstop.selection_ref, expected_leg: "departing" });
  assert.equal(out.status, "not_ready");
  assert.deepEqual(p.clicks, []);
});

test("list_flights rejects the old sort and filter inputs and pages that are not one-way or round-trip results", async () => {
  const p = page();
  for (const input of [{ result_index: 1 }, { sort_by: "price" }, { airline: "UA" }, { max_stops: 0 }, { limit: 0 }, { offset: -1 }]) {
    const out = await invoke(p, "list_flights", input);
    assert.equal(out.status, "invalid_input");
    assert.deepEqual(out.flights, []);
  }
  p.path = "/travel/flights/booking";
  assert.equal((await invoke(p, "list_flights")).status, "wrong_page");
});
