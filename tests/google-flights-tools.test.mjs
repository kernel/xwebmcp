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
const reorder = rows => { const rest = rows.filter(r => r !== NONSTOP_B); return [...rest.slice(0, 102), NONSTOP_B, ...rest.slice(102)]; };
const cvgSfo = (options = {}) => new GooglePage({ route: ONE_WAY, departing: INITIAL, collapsed: COLLAPSED, reorderOnExpand: reorder, topCount: 3, ...options });

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
  const p = new GooglePage({ route: ROUND_TRIP, departing: INITIAL, returning: () => [{ ...NONSTOP_B, date: "2026-11-19", tim: "SFO-CVG-UA-2391-20261119", from: base.to, to: base.from, arrivalDate: "2026-11-19" }] });
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
    assert.ok(!["invalid_input", "unavailable", "wrong_page", "not_ready", "not_found", "not_visible", "wrong_leg", "wrong_search"].includes(out.status), `${action.tool} ${JSON.stringify(action.input)} -> ${out.status}`);
  }
  const search = reference.out.available_actions.find(a => a.tool === "search_flights");
  if (search.input) validate(tool("search_flights").tool.inputSchema, search.input);
}

for (const [name, build] of [
  ["initial departing list", async () => { const page = cvgSfo(); return { page, out: await invoke(page, "list_flights") }; }],
  ["cheapest tab sorted by price", async () => { const page = cvgSfo(); await invoke(page, "set_results_view", { view: "cheapest" }); await invoke(page, "set_flight_sort", { sort_by: "price" }); return { page, out: await invoke(page, "get_page_context") }; }],
  ["expanded list with a stops filter", async () => { const page = cvgSfo(); await invoke(page, "set_flight_filters", { stops: "one_or_fewer" }); await invoke(page, "show_more_flights"); return { page, out: await invoke(page, "list_flights", { limit: 5 }) }; }],
  ["returning list", async () => {
    const page = new GooglePage({ route: ROUND_TRIP, departing: INITIAL, returning: () => [{ ...NONSTOP_B, date: "2026-11-19", tim: "SFO-CVG-UA-2391-20261119", from: base.to, to: base.from, arrivalDate: "2026-11-19" }] });
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
