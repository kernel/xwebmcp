// Google Flights' own controls through the page tools: Best/Cheapest tabs, sort menu, Stops and Airlines filters,
// 'View more flights' and flight-details panels, checked against what the simulated page shows a person.
import assert from "node:assert/strict";
import test from "node:test";
import { El, segment, validate } from "./google-flights-dom.mjs";
import { GooglePage, invoke, tool } from "./google-flights-page.mjs";

const ONE_WAY = { trip: "one_way", legs: [["2026-11-12", "CVG", "SFO"]] };
const ROUND_TRIP = { trip: "round_trip", legs: [["2026-11-12", "CVG", "SFO"], ["2026-11-19", "SFO", "CVG"]] };
const base = { date: "2026-11-12", from: "Cincinnati/Northern Kentucky International Airport", to: "San Francisco International Airport", datedDeparture: true, arrivalDate: "2026-11-12" };
// Synthetic itineraries shaped like Google's initial Best list for this route: connections first, two nonstops, the
// second nonstop last in the initial rows, and many more connections behind 'View more flights'.
const connection = (n, price, airline = "Southwest", code = "WN", via = "BNA", dep = "6:40 PM", arr = "11:25 PM") => ({
  ...base, dep, arr, airline, duration: "7 hr 45 min", stops: 1, price: `$${price}`,
  layoverLabel: `Layover (1 of 1) is a 1 hr 30 min layover at ${via} Airport in ${via}. `, tim: `CVG-${via}-${code}-${n}-20261112,${via}-SFO-${code}-${n + 1}-20261112`,
  segments: () => [
    segment({ from: "CVG", fromName: "Cincinnati", dep, to: via, toName: `${via} Airport`, arr: "11:00 PM", travel: "2 hr", airline, number: `${code} ${n}`, aircraft: "Boeing 737", layover: `1 hr 30 min layover${via}` }),
    segment({ from: via, fromName: `${via} Airport`, dep: "11:30 PM", to: "SFO", toName: "San Francisco International Airport", arr, travel: "4 hr", airline, number: `${code} ${n + 1}`, aircraft: "Airbus A320" }),
  ],
});
const NONSTOP_A = { ...base, dep: "9:36 AM", arr: "12:01 PM", airline: "Breeze", duration: "5 hr 25 min", stops: 0, price: "$184", tim: "CVG-SFO-MX-811-20261112" };
const NONSTOP_B = {
  ...base, dep: "7:00 AM", arr: "9:15 AM", airline: "United", duration: "5 hr 15 min", stops: 0, price: "$339", bags: "0 carry-on bags included. 0 checked bags included.", tim: "CVG-SFO-UA-1482-20261112",
  segments: () => [segment({ from: "CVG", fromName: "Cincinnati/Northern Kentucky International Airport", dep: "7:00 AM", to: "SFO", toName: "San Francisco International Airport", arr: "9:15 AM", travel: "5 hr 15 min", airline: "United", number: "UA 1482", aircraft: "Boeing 737" })],
};
const TWO_STOP = { ...connection(1321, 147, "Southwest", "WN", "BNA"), stops: 2, layoverLabel: "", tim: "CVG-BNA-WN-1321-20261112,BNA-BUR-WN-499-20261112,BUR-SFO-WN-3414-20261112" };
const INITIAL = [connection(1560, 142), NONSTOP_A, connection(1134, 244, "Delta", "DL", "MSP", "4:25 PM", "8:32 PM"), connection(1322, 142, "Southwest", "WN", "BWI", "5:50 AM", "1:45 PM"),
  connection(518, 220, "Alaska", "AS", "SEA", "8:36 AM", "2:10 PM"), connection(1533, 220, "Southwest", "WN", "DEN", "3:35 PM", "8:10 PM"), connection(3495, 244, "American", "AA", "ORD", "11:45 AM", "4:19 PM"),
  connection(3149, 244, "Delta", "DL", "ATL", "1:50 PM", "6:57 PM"), connection(2149, 244, "Delta", "DL", "SLC", "7:45 PM", "11:59 PM"), NONSTOP_B];
const COLLAPSED = [TWO_STOP, ...Array.from({ length: 108 }, (_, i) => connection(2000 + i * 2, 250 + i, i % 2 ? "Delta" : "United", i % 2 ? "DL" : "UA", "ORD", "6:00 AM", "1:00 PM"))];
// Google re-ranks when it expands: the initial nonstop drops far down the longer list.
const RETURN_UA = { ...NONSTOP_B, date: "2026-11-19", tim: "SFO-CVG-UA-2391-20261119", from: base.to, to: base.from, arrivalDate: "2026-11-19",
  segments: () => [segment({ from: "SFO", fromName: "San Francisco International Airport", dep: "7:00 AM", to: "CVG", toName: "Cincinnati", arr: "9:15 AM", travel: "5 hr 15 min", airline: "United", number: "UA 2391", aircraft: "Boeing 737" })] };
// A pricier nonstop listed first, so Google's price sort re-orders the returning list, and a connection the stops filter removes.
const RETURN_AA = { ...RETURN_UA, airline: "American", dep: "6:00 AM", arr: "8:15 AM", price: "$420", tim: "SFO-CVG-AA-2600-20261119",
  segments: () => [segment({ from: "SFO", fromName: "San Francisco International Airport", dep: "6:00 AM", to: "CVG", toName: "Cincinnati", arr: "8:15 AM", travel: "5 hr 15 min", airline: "American", number: "AA 2600", aircraft: "Airbus A321" })] };
const RETURN_DL = { ...RETURN_UA, airline: "Delta", dep: "9:00 AM", arr: "6:00 PM", stops: 1, price: "$380", layoverLabel: "Layover (1 of 1) is a 1 hr layover at ATL Airport in Atlanta. ", tim: "SFO-ATL-DL-500-20261119,ATL-CVG-DL-501-20261119",
  segments: () => [
    segment({ from: "SFO", fromName: "San Francisco International Airport", dep: "9:00 AM", to: "ATL", toName: "Atlanta", arr: "4:00 PM", travel: "4 hr", airline: "Delta", number: "DL 500", aircraft: "Boeing 757", layover: "1 hr layoverATL" }),
    segment({ from: "ATL", fromName: "Atlanta", dep: "5:00 PM", to: "CVG", toName: "Cincinnati", arr: "6:00 PM", travel: "1 hr", airline: "Delta", number: "DL 501", aircraft: "Airbus A319" }),
  ] };
const reorder = rows => { const rest = rows.filter(r => r !== NONSTOP_B); return [...rest.slice(0, 102), NONSTOP_B, ...rest.slice(102)]; };
// Google's Cheapest tab prices some rows lower than Best.
const CHEAPEST = { initial: INITIAL.map(r => r === NONSTOP_A ? { ...NONSTOP_A, price: "$183" } : r), collapsed: COLLAPSED };
const cvgSfo = (options = {}) => new GooglePage({ route: ONE_WAY, departing: INITIAL, collapsed: COLLAPSED, cheapest: CHEAPEST, reorderOnExpand: reorder, topCount: 3, ...options });

// Everything a read must leave alone.
const pageState = p => JSON.stringify({ state: p.state, url: p.url, clicks: p.clicks, more: p.moreClicks || 0, panels: p.rows().map(li => li.querySelector('button[aria-label^="Flight details"]').getAttribute("aria-expanded")), dialogs: p.dialog() ? 1 : 0, menu: p.body.children.some(c => c.attrs.role === "menu") });
const shown = list => list.flights.map(f => ({ section: f.section, flights: f.flight_numbers, price: f.price.amount }));

test("search-time regression: the initial Best list keeps every row Google shows, including the last nonstop, without expanding", async () => {
  const p = cvgSfo();
  const before = pageState(p);
  const list = await invoke(p, "list_flights");
  assert.equal(pageState(p), before);
  assert.equal(p.moreClicks, undefined);
  assert.equal(list.status, "ok");
  assert.deepEqual(shown(list), p.visible());
  assert.equal(list.results.rendered_rows, 10);
  assert.deepEqual(list.results.sections, [{ heading: "Top flights", first_position: 1, rows: 3 }, { heading: "Other flights", first_position: 4, rows: 7 }]);
  assert.deepEqual(list.flights.at(-1).flight_numbers, ["UA 1482"]);
  assert.equal(list.flights.at(-1).position, 10);
  assert.deepEqual(list.results.show_more, { available: true, reason: null });
  assert.equal(list.results.next_offset, null);
  assert.match(list.warnings.at(-1), /behind 'View more flights'.*call show_more_flights/);
  assert.equal(list.view.active, "best");
  assert.equal(list.sort.active, "top_flights");
  assert.equal(list.filters.stops, "any");
});

test("a serialization limit never changes the page, and a larger limit only adds rows after the smaller one's", async () => {
  const p = cvgSfo();
  const before = pageState(p);
  const small = await invoke(p, "list_flights", { limit: 3 });
  const large = await invoke(p, "list_flights", { limit: 9 });
  const rest = await invoke(p, "list_flights", { offset: small.results.next_offset, limit: 150 });
  assert.equal(pageState(p), before);
  assert.deepEqual(small.flights, large.flights.slice(0, 3));
  assert.deepEqual([small.results.returned_rows, small.results.next_offset, small.results.truncated_by], [3, 3, "limit"]);
  assert.deepEqual([...small.flights, ...rest.flights].map(f => f.position), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.deepEqual(rest.results.next_offset, null);
});

test("show_more_flights clicks once, returns the expanded list in Google's new order and is unavailable afterwards", async () => {
  const p = cvgSfo();
  const initial = await invoke(p, "list_flights");
  const ref = initial.flights.at(-1).selection_ref;
  const more = await invoke(p, "show_more_flights", { limit: 150 });
  assert.equal(more.status, "changed");
  assert.equal(p.moreClicks, 1);
  assert.equal(more.rendered_rows_before, 10);
  assert.equal(more.results.rendered_rows, 119);
  // The response may stop at the transport budget; list_flights continues from next_offset on the same page.
  const rest = more.results.next_offset === null ? [] : (await invoke(p, "list_flights", { offset: more.results.next_offset, limit: 150 })).flights;
  const all = [...more.flights, ...rest];
  assert.deepEqual(shown({ flights: all }), p.visible());
  assert.equal(all.find(f => f.selection_ref === ref).position, 103);
  assert.ok(all.some(f => f.stops === 2));
  assert.deepEqual(more.results.show_more, { available: false, reason: "absent" });
  assert.equal(more.available_actions.find(a => a.tool === "show_more_flights").enabled, false);
  const again = await invoke(p, "show_more_flights");
  assert.equal(again.status, "unavailable");
  assert.equal(again.clicked, false);
  assert.equal(p.moreClicks, 1);
});

test("a collapsed list whose announcement counts more rows than it shows is settled while 'View more flights' is offered", async () => {
  const p = cvgSfo();
  p.live.text = "119 results returned.";
  const list = await invoke(p, "list_flights");
  assert.equal(list.status, "ok");
  assert.equal(list.results.announced_rows, 119);
  assert.equal(list.results.rendered_rows, 10);
  p.more.hidden = true;
  assert.equal((await invoke(p, "list_flights")).status, "not_ready");
});

test("an oversized list is cut by the transport budget with a continuation, never by changing the page", async () => {
  const p = cvgSfo();
  await invoke(p, "show_more_flights");
  const first = await invoke(p, "list_flights", { limit: 150 });
  assert.ok(JSON.stringify(first).length < 240 * 1024);
  const pages = [first];
  while (pages.at(-1).results.next_offset !== null) pages.push(await invoke(p, "list_flights", { offset: pages.at(-1).results.next_offset, limit: 150 }));
  assert.deepEqual(pages.flatMap(x => x.flights).map(f => f.position), Array.from({ length: 119 }, (_, i) => i + 1));
});

test("set_results_view switches Google's tab, waits for the new list and reports Google's contradictory Cheapest announcement", async () => {
  const cheapest = { initial: INITIAL.map(r => r === NONSTOP_A ? { ...NONSTOP_A, price: "$183" } : r), collapsed: COLLAPSED };
  const p = cvgSfo({ cheapest, timing: { change: 1500, settleChange: 2500 } });
  const out = await invoke(p, "set_results_view", { view: "cheapest" });
  assert.equal(out.status, "changed");
  assert.equal(out.clicked, true);
  assert.equal(out.view.active, "cheapest");
  assert.deepEqual(shown(out), p.visible());
  assert.equal(out.flights[1].price.amount, 183);
  assert.equal(out.results.announcement, "No results returned.");
  assert.match(out.warnings[0], /contradicts the 10 rows/);
  const same = await invoke(p, "set_results_view", { view: "cheapest" });
  assert.deepEqual([same.status, same.clicked], ["unchanged", false]);
  const invalid = await invoke(p, "set_results_view", { view: "price" });
  assert.equal(invalid.status, "invalid_input");
  assert.equal(p.state.view, "cheapest");
});

test("set_results_view is unavailable on the returning list, where Google shows no tabs", async () => {
  const p = new GooglePage({ route: ROUND_TRIP, departing: INITIAL, returning: () => [RETURN_AA, RETURN_UA, RETURN_DL] });
  const [first] = (await invoke(p, "list_flights")).flights;
  await invoke(p, "select_flight", { selection_ref: first.selection_ref, expected_leg: "departing" });
  const out = await invoke(p, "set_results_view", { view: "cheapest" });
  assert.equal(out.status, "unavailable");
  assert.equal(out.clicked, false);
  assert.equal(out.view.available, false);
  const action = out.available_actions.find(a => a.tool === "set_results_view");
  assert.deepEqual([action.enabled, action.input], [false, null]);
  assert.match(action.note, /returning flights have none/);
});

test("set_flight_sort chooses Google's menu entry, reports what the menu offered and refuses an entry Google does not offer", async () => {
  const p = cvgSfo({ sorts: ["top_flights", "price", "departure_time"] });
  const out = await invoke(p, "set_flight_sort", { sort_by: "price" });
  assert.equal(out.status, "changed");
  assert.deepEqual(out.observed_choices, ["Top flights", "Price", "Departure time"]);
  assert.deepEqual([out.sort.active, out.sort.label], ["price", "Sorted by price"]);
  assert.deepEqual(out.results.sections.map(s => s.heading), ["All flights"]);
  assert.deepEqual(shown(out), p.visible());
  assert.equal(out.view.active, "best");
  const same = await invoke(p, "set_flight_sort", { sort_by: "price" });
  assert.deepEqual([same.status, same.clicked, same.observed_choices], ["unchanged", false, null]);
  const missing = await invoke(p, "set_flight_sort", { sort_by: "emissions" });
  assert.equal(missing.status, "unavailable");
  assert.equal(missing.sort.active, "price");
  assert.ok(!p.body.children.some(c => c.attrs.role === "menu"));
  const before = pageState(p);
  const invalid = await invoke(p, "set_flight_sort", { sort_by: "cheapest" });
  assert.equal(invalid.status, "invalid_input");
  assert.equal(pageState(p), before);
});

test("set_flight_filters sets Google's Stops and Airlines filters through their dialogs", async () => {
  const p = cvgSfo();
  const nonstop = await invoke(p, "set_flight_filters", { stops: "nonstop" });
  assert.equal(nonstop.status, "changed");
  assert.deepEqual(nonstop.applied, [{ filter: "stops", value: "nonstop" }]);
  assert.equal(nonstop.filters.stops, "nonstop");
  assert.deepEqual(nonstop.flights.map(f => f.flight_numbers[0]), ["MX 811", "UA 1482"]);
  assert.deepEqual(shown(nonstop), p.visible());
  assert.equal(p.dialog(), null);

  const airlines = await invoke(p, "set_flight_filters", { airlines: ["united", "Delta"], stops: "any" });
  assert.equal(airlines.status, "changed");
  assert.deepEqual(airlines.applied, [{ filter: "airlines", value: ["United", "Delta"] }, { filter: "stops", value: "any" }]);
  assert.deepEqual(p.state.airlines.sort(), ["Delta", "United"]);
  assert.equal(airlines.filters.airlines, "United +1");
  assert.ok(airlines.flights.every(f => ["United", "Delta"].includes(f.airlines[0])));
  assert.ok(airlines.offered_airlines.includes("Southwest"));
  const narrowed = await invoke(p, "set_flight_filters", { airlines: ["Delta"] });
  assert.deepEqual([narrowed.status, p.state.airlines], ["changed", ["Delta"]]);
  const widened = await invoke(p, "set_flight_filters", { airlines: ["Delta", "United"] });
  assert.deepEqual([widened.status, p.state.airlines.sort()], ["changed", ["Delta", "United"]]);
  const repeat = await invoke(p, "set_flight_filters", { airlines: ["Delta", "United"] });
  assert.deepEqual([repeat.status, repeat.applied, repeat.clicked], ["unchanged", [], true]);
  assert.equal(p.dialog(), null);

  const unknown = await invoke(p, "set_flight_filters", { airlines: ["Lufthansa"], stops: "nonstop" });
  assert.equal(unknown.status, "unavailable");
  assert.deepEqual(unknown.applied, []);
  assert.deepEqual(p.state.airlines.sort(), ["Delta", "United"]);
  assert.equal(p.state.stops, "any");
  assert.equal(p.dialog(), null);

  const all = await invoke(p, "set_flight_filters", { airlines: "all" });
  assert.equal(all.status, "changed");
  assert.equal(p.state.airlines, null);
  assert.equal(all.filters.airlines, "all");
  const unchanged = await invoke(p, "set_flight_filters", { stops: "any", airlines: "all" });
  assert.deepEqual([unchanged.status, unchanged.clicked], ["unchanged", false]);
});

test("set_flight_filters refuses invalid input and stop choices Google does not offer before changing anything", async () => {
  const p = cvgSfo({ stops: ["any", "nonstop"] });
  for (const input of [{}, { stops: "direct" }, { airlines: [] }, { airlines: ["UA", "ua"] }, { airline: "United" }]) {
    const before = pageState(p);
    const out = await invoke(p, "set_flight_filters", input);
    assert.equal(out.status, "invalid_input");
    assert.equal(pageState(p), before);
  }
  const out = await invoke(p, "set_flight_filters", { stops: "two_or_fewer" });
  assert.equal(out.status, "unavailable");
  assert.equal(p.state.stops, "any");
  assert.equal(p.dialog(), null);
});

test("get_flight_details opens exactly the named row's panel, verifies it and leaves it open; later reads report it", async () => {
  const p = cvgSfo();
  const list = await invoke(p, "list_flights");
  const target = list.flights.at(-1);
  assert.equal(target.detail_level, "summary");
  const out = await invoke(p, "get_flight_details", { selection_ref: target.selection_ref });
  assert.equal(out.status, "ok");
  assert.equal(out.clicked, true);
  assert.equal(out.flight.detail_level, "detail_panel");
  assert.deepEqual(out.flight.segments.map(s => [s.flight_number, s.aircraft, s.cabin, s.departure_time, s.arrival_time]), [["UA 1482", "Boeing 737", "Economy", "07:00", "09:15"]]);
  assert.deepEqual(out.results.open_detail_panels, [10]);
  const panels = p.rows().map(li => li.querySelector('button[aria-label^="Flight details"]').getAttribute("aria-expanded"));
  assert.deepEqual(panels.map((v, i) => [i + 1, v]).filter(([, v]) => v === "true"), [[10, "true"]]);
  const again = await invoke(p, "get_flight_details", { selection_ref: target.selection_ref });
  assert.deepEqual([again.status, again.clicked], ["ok", false]);
  const reread = await invoke(p, "list_flights");
  assert.equal(reread.flights.at(-1).detail_level, "detail_panel");
  assert.equal(reread.flights[0].detail_level, "summary");
  // A select example for the row the caller is inspecting.
  assert.deepEqual(out.available_actions.find(a => a.tool === "select_flight").input, { selection_ref: target.selection_ref, expected_leg: "departing" });
});

test("get_flight_details refuses hidden, foreign and malformed references without clicking, and reports a panel that contradicts the row", async () => {
  const p = cvgSfo();
  const expanded = cvgSfo();
  const hidden = (await invoke(expanded, "show_more_flights", { limit: 150 })).flights.find(f => f.stops === 2);
  const before = pageState(p);
  const notVisible = await invoke(p, "get_flight_details", { selection_ref: hidden.selection_ref });
  assert.equal(notVisible.status, "not_visible");
  assert.match(notVisible.next_steps[0], /^show_more_flights/);
  assert.equal((await invoke(p, "get_flight_details", { selection_ref: "gf1.abc.00000000" })).status, "invalid_input");
  const other = new GooglePage({ route: { trip: "one_way", legs: [["2026-11-13", "CVG", "SFO"]] }, departing: [{ ...NONSTOP_A, date: "2026-11-13", tim: "CVG-SFO-MX-811-20261113" }] });
  const foreign = (await invoke(other, "list_flights")).flights[0].selection_ref;
  assert.equal((await invoke(p, "get_flight_details", { selection_ref: foreign })).status, "wrong_search");
  assert.equal(pageState(p), before);

  const wrong = { ...NONSTOP_B, tim: "CVG-SFO-UA-1482-20261112", segments: () => [segment({ from: "CVG", fromName: "X", dep: "7:00 AM", to: "SFO", toName: "Y", arr: "9:15 AM", travel: "5 hr 15 min", airline: "United", number: "UA 9999", aircraft: "Boeing 737" })] };
  const q = cvgSfo({ departing: [...INITIAL.slice(0, 9), wrong] });
  const ref = (await invoke(q, "list_flights")).flights.at(-1).selection_ref;
  const mismatch = await invoke(q, "get_flight_details", { selection_ref: ref });
  assert.equal(mismatch.status, "detail_mismatch");
  assert.equal(mismatch.flight, null);
});

test("reads leave the view, sort, filters, expansion, panels and selection unchanged", async () => {
  const p = cvgSfo();
  await invoke(p, "set_flight_sort", { sort_by: "departure_time" });
  await invoke(p, "set_flight_filters", { stops: "one_or_fewer" });
  const [first] = (await invoke(p, "list_flights")).flights;
  await invoke(p, "get_flight_details", { selection_ref: first.selection_ref });
  const before = pageState(p);
  for (const [name, input] of [["list_flights", {}], ["list_flights", { offset: 2, limit: 1 }], ["get_page_context", {}], ["get_page_context", { wait_for_settled_seconds: 2 }]]) {
    const out = await invoke(p, name, input);
    assert.notEqual(out.status, "invalid_input");
    assert.equal(pageState(p), before, name);
  }
});

test("get_page_context reports controls and actions, and stays honest when the tool registry cannot be read", async () => {
  const p = cvgSfo();
  const out = await invoke(p, "get_page_context");
  assert.equal(out.status, "ok");
  assert.equal(out.page.page_type, "departing_results");
  assert.equal(out.results.rendered_rows, 10);
  assert.equal(out.flights, undefined);
  assert.deepEqual(out.registered_tools.known, true);
  assert.ok(out.available_actions.every(a => a.registered === p.registered.includes(a.tool)));
  p.registered = ["list_flights"];
  const unknown = await invoke(p, "get_page_context");
  assert.equal(unknown.registered_tools.known, false);
  assert.ok(unknown.available_actions.every(a => a.registered === null));
  p.document.modelContext = undefined;
  assert.ok((await invoke(p, "get_page_context")).available_actions.every(a => a.registered === null));
  const invalid = await invoke(p, "get_page_context", { wait_for_settled_seconds: 99 });
  assert.equal(invalid.status, "invalid_input");
});

test("on the flights home page the only next step is a new search, with the inputs it needs", async () => {
  const p = cvgSfo();
  p.path = "/travel/flights";
  p.body.children = [];
  const out = await invoke(p, "get_page_context");
  assert.equal(out.page.page_type, "flights_home");
  assert.equal(out.results, null);
  assert.deepEqual(out.available_actions.map(a => [a.tool, a.enabled]), [["search_flights", true]]);
  assert.match(out.next_steps[0], /^search_flights/);
});

test("a tool registered as absent is not suggested as a next step", async () => {
  const p = cvgSfo();
  p.registered = p.registered.filter(name => name !== "select_flight");
  const out = await invoke(p, "list_flights");
  const select = out.available_actions.find(a => a.tool === "select_flight");
  assert.deepEqual([select.enabled, select.registered], [true, false]);
  assert.ok(!out.next_steps.some(step => step.startsWith("select_flight")));
});

// Every enabled action with an input must be accepted by that tool's schema and run on the same state.
async function checkActions(build) {
  const reference = await build();
  for (const action of reference.out.available_actions.filter(a => a.enabled && a.input && a.tool !== "search_flights")) {
    const definition = tool(action.tool);
    validate(definition.tool.inputSchema, action.input);
    const { page } = await build();
    const out = await invoke(page, action.tool, action.input);
    assert.ok(["ok", "changed", "selected"].includes(out.status), `${action.tool} ${JSON.stringify(action.input)} -> ${out.status}`);
  }
  const search = reference.out.available_actions.find(a => a.tool === "search_flights");
  if (search.input) validate(tool("search_flights").tool.inputSchema, search.input);
}

for (const [name, build] of [
  ["initial departing list", async () => { const page = cvgSfo(); return { page, out: await invoke(page, "list_flights") }; }],
  ["cheapest tab sorted by price", async () => { const page = cvgSfo(); await invoke(page, "set_results_view", { view: "cheapest" }); await invoke(page, "set_flight_sort", { sort_by: "price" }); return { page, out: await invoke(page, "get_page_context") }; }],
  ["expanded list with a stops filter", async () => { const page = cvgSfo(); await invoke(page, "set_flight_filters", { stops: "one_or_fewer" }); await invoke(page, "show_more_flights"); return { page, out: await invoke(page, "list_flights", { limit: 5 }) }; }],
  ["returning list", async () => {
    const page = new GooglePage({ route: ROUND_TRIP, departing: INITIAL, returning: () => [RETURN_AA, RETURN_UA, RETURN_DL] });
    const [first] = (await invoke(page, "list_flights")).flights;
    return { page, out: await invoke(page, "select_flight", { selection_ref: first.selection_ref, expected_leg: "departing" }) };
  }],
]) {
  test(`advertised actions are valid and executable: ${name}`, () => checkActions(build));
}

test("an action tool refuses on a page that is still loading, without clicking", async () => {
  const p = cvgSfo();
  p.body.append(new El("div", { attrs: { role: "progressbar" } }));
  const before = pageState(p);
  for (const [name, input] of [["set_results_view", { view: "cheapest" }], ["set_flight_sort", { sort_by: "price" }], ["set_flight_filters", { stops: "nonstop" }], ["show_more_flights", {}]]) {
    const out = await invoke(p, name, input);
    assert.equal(out.status, "not_ready", name);
    assert.equal(out.clicked, false);
  }
  assert.equal(pageState(p), before);
});

test("controls Google shows disabled are never advertised, and the tools refuse them without clicking", async () => {
  const p = cvgSfo({ disabled: ["sort", "Cheapest", "Stops", "Airlines"] });
  const list = await invoke(p, "list_flights");
  const action = name => list.available_actions.find(a => a.tool === name);
  assert.deepEqual([action("set_flight_sort").enabled, action("set_flight_sort").input], [false, null]);
  assert.match(action("set_flight_sort").note, /disabled/);
  assert.deepEqual([action("set_results_view").enabled, action("set_flight_filters").enabled], [false, false]);
  assert.deepEqual([list.sort.enabled, list.view.choices.map(c => c.enabled), list.filters.chips.map(c => c.enabled)], [false, [true, false], [false, false, true]]);
  const before = pageState(p);
  for (const [name, input] of [["set_flight_sort", { sort_by: "price" }], ["set_results_view", { view: "cheapest" }], ["set_flight_filters", { stops: "nonstop" }], ["set_flight_filters", { airlines: ["United"] }]]) {
    const out = await invoke(p, name, input);
    assert.deepEqual([out.status, out.clicked], ["unavailable", false], name);
  }
  assert.equal(pageState(p), before);

  const q = cvgSfo();
  q.rows()[0].querySelector('button[aria-label^="Flight details"]').setAttribute("aria-disabled", "true");
  const rows = await invoke(q, "list_flights");
  const details = rows.available_actions.find(a => a.tool === "get_flight_details");
  assert.deepEqual([details.enabled, details.input], [false, null]);
  const refused = await invoke(q, "get_flight_details", { selection_ref: rows.flights[0].selection_ref });
  assert.deepEqual([refused.status, refused.clicked], ["unavailable", false]);
});

// Google switches the tab and URL first and shows the new rows later; same route and row count, different price.
const cheaperView = { initial: INITIAL.map(r => r === NONSTOP_A ? { ...NONSTOP_A, price: "$150" } : r), collapsed: COLLAPSED };
for (const [name, options] of [
  ["the new rows arrive 3 s after the tab", { timing: { change: 100, rows: 3000, settleChange: 3200 } }],
  ["the new rows arrive 10 s after the tab, under an early announcement", { timing: { change: 100, rows: 10000, settleChange: 1300 } }],
  ["the stale announcement stays while the rows change", { cheapestAnnouncement: "10 results returned.", timing: { change: 100, rows: 1200, settleChange: 50 } }],
  ["Google blanks the list, restores the old rows and announces them before the new rows", { timing: { change: 100, clear: 150, restore: 600, rows: 10000, settleChange: 10100 } }],
]) {
  test(`set_results_view never reports the previous view's rows as the new view: ${name}`, async () => {
    const p = cvgSfo({ cheapest: cheaperView, ...options });
    const out = await invoke(p, "set_results_view", { view: "cheapest" });
    assert.equal(out.status, "changed");
    assert.equal(out.view.active, "cheapest");
    assert.equal(out.flights.find(f => f.flight_numbers[0] === "MX 811").price.amount, 150);
    assert.deepEqual(shown(out), p.visible());
  });
}

test("a tab change whose list is identical to the previous one is unconfirmed, not changed", async () => {
  const p = cvgSfo({ cheapest: { initial: INITIAL, collapsed: COLLAPSED } });
  const out = await invoke(p, "set_results_view", { view: "cheapest" });
  assert.equal(out.status, "unconfirmed");
  assert.equal(out.clicked, true);
  assert.match(out.message, /did not settle|do not click again/);
});

test("set_flight_filters keeps the dialog open until Google's chip shows the change, so Google does not drop it", async () => {
  const p = cvgSfo({ dropIfClosedEarly: true, timing: { change: 1500, settleChange: 1800 } });
  const out = await invoke(p, "set_flight_filters", { stops: "nonstop", airlines: ["United", "Breeze"] });
  assert.equal(out.status, "changed");
  assert.equal(p.state.stops, "nonstop");
  assert.deepEqual(p.state.airlines.sort(), ["Breeze", "United"]);
  assert.deepEqual(out.flights.map(f => f.flight_numbers[0]), ["MX 811", "UA 1482"]);
});

test("the whole response stays within the API's 240 KiB in UTF-8 bytes, with a complete continuation", async () => {
  const wide = "東京国際空港".repeat(40);
  const rows = Array.from({ length: 150 }, (_, i) => ({ ...connection(4000 + i * 2, 300 + i, "Ålandsflyg", "AL", "ORD"), from: `Cincinnati ${wide}`, to: `San Francisco ${wide}` }));
  const p = cvgSfo({ departing: rows, collapsed: [], topCount: 3 });
  const pages = [await invoke(p, "list_flights", { limit: 150 })];
  while (pages.at(-1).results.next_offset !== null) pages.push(await invoke(p, "list_flights", { offset: pages.at(-1).results.next_offset, limit: 150 }));
  assert.ok(pages.length > 1);
  for (const page of pages) assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 240 * 1024, `${Buffer.byteLength(JSON.stringify(page))} bytes`);
  assert.deepEqual(pages[0].results.truncated_by, "size_budget");
  assert.deepEqual(pages.flatMap(x => x.flights).map(f => f.position), Array.from({ length: 150 }, (_, i) => i + 1));
});

test("a row too large for any response is skipped with a continuation that moves past it, and details fail explicitly", async () => {
  // Long texts are shortened, so only an absurd details panel (thousands of amenity lines) makes one row too large.
  const amenities = block => { for (let i = 0; i < 400; i++) block.append(new El("li", { text: `Amenity ${i} ` + "x".repeat(900) })); return block; };
  const crowded = { ...NONSTOP_B, segments: () => NONSTOP_B.segments().map(amenities) };
  const p = cvgSfo({ departing: [INITIAL[0], crowded, INITIAL[2]], collapsed: [] });
  const ref = (await invoke(p, "list_flights")).flights[1].selection_ref;
  await assert.rejects(invoke(p, "get_flight_details", { selection_ref: ref }), /above the 240 KiB response limit/);
  const out = await invoke(p, "list_flights");
  assert.ok(Buffer.byteLength(JSON.stringify(out)) <= 240 * 1024);
  assert.deepEqual(out.flights.map(f => f.position), [1, 3]);
  assert.deepEqual(out.results.skipped_rows, [{ position: 2, missing: ["fits no response: larger than the response size budget"] }]);
  assert.equal(out.results.next_offset, null);
});

test("a results page searched by city or another place is reported as unsupported, with a valid context and recovery", async () => {
  for (const legs of [[["2026-11-12", "/m/01snm", "SFO"]], [["2026-11-12", "CVG", "/m/0d6lp"]], [["2026-11-1", "CVG", "SFO"]]]) {
    const p = new GooglePage({ route: { trip: "one_way", legs }, departing: INITIAL });
    const context = await invoke(p, "get_page_context");
    assert.equal(context.status, "unsupported");
    assert.equal(context.page.page_type, "unsupported_results");
    assert.equal(context.page.search, null);
    assert.deepEqual(context.available_actions.map(a => [a.tool, a.enabled, a.input]), [["search_flights", true, null]]);
    assert.match(context.available_actions[0].requires, /^origin, destination, depart_date and trip_type/);
    const list = await invoke(p, "list_flights");
    assert.equal(list.status, "unsupported");
    assert.deepEqual(list.flights, []);
    const ref = (await invoke(cvgSfo(), "list_flights")).flights[0].selection_ref;
    assert.deepEqual([(await invoke(p, "select_flight", { selection_ref: ref, expected_leg: "departing" })).status, p.clicks], ["wrong_page", []]);
  }
});

test("an unsettled list reports what Google renders without claiming the rows were read", async () => {
  const p = cvgSfo();
  p.live.text = "12 results returned.";
  p.more.hidden = true;
  const out = await invoke(p, "list_flights");
  assert.equal(out.status, "not_ready");
  assert.deepEqual([out.results.rendered_rows, out.results.readable_rows, out.flights.length], [10, null, 0]);
  assert.deepEqual(out.results.sections.map(s => s.rows), [3, 7]);
});

test("after expanding Best, the Cheapest tab under Google's stale smaller count is read (with a warning), not left unsettled", async () => {
  const extra = Array.from({ length: 20 }, (_, i) => connection(7000 + i * 2, 400 + i, "Delta", "DL", "ATL"));
  const p = cvgSfo({ cheapest: { initial: CHEAPEST.initial, collapsed: [...COLLAPSED, ...extra] }, cheapestAnnouncement: "119 results returned." });
  await invoke(p, "show_more_flights");
  const out = await invoke(p, "set_results_view", { view: "cheapest", limit: 150 });
  assert.equal(out.status, "changed");
  assert.deepEqual([out.results.rendered_rows, out.results.announced_rows], [139, 119]);
  assert.match(out.warnings[0], /contradicts the 139 rows/);
  const list = await invoke(p, "list_flights");
  assert.equal(list.status, "ok");
  assert.ok(list.available_actions.find(a => a.tool === "set_results_view").enabled);
});

test("a returning list a filter leaves empty, shown by Google without a list heading, is no_results with a way back", async () => {
  const p = new GooglePage({ route: ROUND_TRIP, departing: INITIAL, returning: () => [RETURN_AA, RETURN_UA, RETURN_DL], emptyHeading: false });
  const [first] = (await invoke(p, "list_flights")).flights;
  await invoke(p, "select_flight", { selection_ref: first.selection_ref, expected_leg: "departing" });
  const out = await invoke(p, "set_flight_filters", { airlines: ["Breeze"] });
  assert.equal(out.status, "changed");
  assert.deepEqual([out.page.leg, out.page.results_state, out.results.rendered_rows], ["returning", "no_results", 0]);
  const context = await invoke(p, "get_page_context");
  assert.deepEqual([context.status, context.page.settled], ["ok", true]);
  const back = context.available_actions.find(a => a.tool === "set_flight_filters");
  assert.deepEqual([back.enabled, back.input], [true, { airlines: "all" }]);
  const restored = await invoke(p, "set_flight_filters", back.input);
  assert.equal(restored.status, "changed");
  assert.deepEqual(restored.flights.map(f => f.flight_numbers[0]), ["AA 2600", "UA 2391", "DL 500"]);
});

test("get_flight_details and get_page_context stay within the response limit when Google's texts are huge, keeping refs and inputs exact", async () => {
  const giant = "Ö".repeat(150000);
  const p = cvgSfo({ departing: [{ ...NONSTOP_B, from: `Cincinnati ${giant}` }, { ...NONSTOP_A, airline: `Breeze ${giant}` }, ...INITIAL.slice(2, 9)], collapsed: [] });
  const list = await invoke(p, "list_flights");
  const big = list.flights[0];
  assert.ok(Buffer.byteLength(JSON.stringify(list)) <= 240 * 1024);
  assert.ok(big.origin_name.length <= 1001);
  const details = await invoke(p, "get_flight_details", { selection_ref: big.selection_ref });
  assert.equal(details.status, "ok");
  assert.ok(Buffer.byteLength(JSON.stringify(details)) <= 240 * 1024);
  assert.equal(details.flight.selection_ref, big.selection_ref);
  const context = await invoke(p, "get_page_context");
  assert.ok(Buffer.byteLength(JSON.stringify(context)) <= 240 * 1024);
  const filters = context.available_actions.find(a => a.tool === "set_flight_filters");
  assert.ok(filters.choices.airlines.every(name => name.length <= 60));
  for (const action of context.available_actions.filter(a => a.input)) validate(tool(action.tool).tool.inputSchema, action.input);
});

test("refusals of invalid input on a settled list still advertise the actions that list allows", async () => {
  const p = cvgSfo();
  for (const [name, input] of [["list_flights", { limit: 0 }], ["set_flight_sort", { sort_by: "cheapest" }], ["get_flight_details", { selection_ref: "gf1.abc.00000000" }], ["select_flight", { selection_ref: "gf1.abc.00000000", expected_leg: "departing" }]]) {
    const out = await invoke(p, name, input);
    assert.equal(out.status, "invalid_input", name);
    const select = out.available_actions.find(a => a.tool === "select_flight");
    assert.equal(select.enabled, true, name);
    assert.ok(!out.next_steps.some(step => /still changing/.test(step)), name);
  }
});

test("results Google renders for a typed /travel/flights?q= query are reported as unsupported, not as the home page", async () => {
  const p = cvgSfo();
  p.path = "/travel/flights";
  const out = await invoke(p, "get_page_context");
  assert.deepEqual([out.status, out.page.page_type], ["unsupported", "unsupported_results"]);
  assert.deepEqual(out.available_actions.map(a => a.tool), ["search_flights"]);
});

test("set_flight_filters waits for Google to finish each airline change before the next, so none is dropped", async () => {
  const p = cvgSfo({ busyMs: 2000, timing: { change: 500, settleChange: 700 } });
  assert.equal((await invoke(p, "set_flight_filters", { airlines: ["Southwest"] })).status, "changed");
  const out = await invoke(p, "set_flight_filters", { airlines: ["Delta", "United"] });
  assert.equal(out.status, "changed");
  assert.deepEqual(p.state.airlines.sort(), ["Delta", "United"]);
  assert.deepEqual(out.applied, [{ filter: "airlines", value: ["Delta", "United"] }]);
});

test("an unconfirmed change still describes the settled page and its actions", async () => {
  const p = cvgSfo({ cheapest: { initial: INITIAL, collapsed: COLLAPSED } });
  const out = await invoke(p, "set_results_view", { view: "cheapest" });
  assert.equal(out.status, "unconfirmed");
  assert.match(out.message, /identical to the list before the click/);
  assert.equal(out.page.settled, true);
  assert.equal(out.available_actions.find(a => a.tool === "select_flight").enabled, true);
  assert.ok(!out.next_steps.some(step => /still changing/.test(step)));
});

test("get_page_context waits long enough to describe a stable list under Google's missing or contradicting count", async () => {
  const p = cvgSfo();
  await invoke(p, "set_results_view", { view: "cheapest" });
  const out = await invoke(p, "get_page_context");
  assert.deepEqual([out.status, out.page.settled, out.results.announcement], ["ok", true, "No results returned."]);
  assert.equal(out.available_actions.find(a => a.tool === "select_flight").enabled, true);
});

test("on an unfiltered no-results page, filters are not advertised; on a filtered one, clearing is", async () => {
  const p = cvgSfo({ departing: [], collapsed: [] });
  const empty = await invoke(p, "get_page_context");
  assert.equal(empty.page.results_state, "no_results");
  const filters = empty.available_actions.find(a => a.tool === "set_flight_filters");
  assert.deepEqual([filters.enabled, filters.input], [false, null]);
  assert.match(filters.note, /nothing to filter/);
});

test("controls are read only on Google Flights pages, and a truncated list suggests its continuation", async () => {
  const p = cvgSfo();
  p.path = "/travel/hotels";
  const hotels = await invoke(p, "get_page_context");
  assert.deepEqual([hotels.page.page_type, hotels.filters.chips, hotels.view.available, hotels.sort.available], ["other", [], false, false]);
  p.path = "/travel/flights/search";
  const list = await invoke(p, "list_flights", { limit: 3 });
  assert.ok(list.next_steps.some(step => step.startsWith('list_flights {"offset":3}')));
});

test("set_flight_filters refuses an unfiltered no-results page without clicking, as its action says", async () => {
  const p = cvgSfo({ departing: [], collapsed: [] });
  const before = pageState(p);
  const out = await invoke(p, "set_flight_filters", { stops: "nonstop" });
  assert.deepEqual([out.status, out.clicked], ["unavailable", false]);
  assert.match(out.message, /nothing to filter/);
  assert.equal(pageState(p), before);
});

test("an airline change that runs out of time stops before clicking and reports what Google shows", async () => {
  const p = cvgSfo({ busyMs: 6000, timing: { change: 300, settleChange: 400 } });
  p.state.airlines = p.offeredAirlines().filter(name => name !== "Alaska");
  p.render();
  p.announce();
  const out = await invoke(p, "set_flight_filters", { airlines: ["Alaska"] });
  assert.equal(out.status, "partial");
  assert.match(out.message, /^Ran out of time before removing \w+ from the Airlines filter\. Google's Airlines filter now shows /);
  assert.deepEqual(out.applied, [{ filter: "airlines", value: p.offeredAirlines().filter(name => p.state.airlines.includes(name)) }]);
  const shown = [...p.state.airlines];
  await p.wait(15000);
  assert.deepEqual(p.state.airlines, shown);
  assert.equal(p.dialog(), null);
});
